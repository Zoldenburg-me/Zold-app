/**
 * Session issue and check: the only place that decides who is calling.
 *
 * Route modules are factories that take `requireSession`/`requireUserSession`
 * from here; they must not add a second way to authenticate.
 *
 * Tokens are never stored. Only a SHA-256 hash reaches the store, so a leaked
 * database does not yield a live session.
 */
import type express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SECURITY } from "../config.js";
import { store, type User } from "../store.js";
import { deferToCommit, openTxToken } from "../store/backend.js";
import { describeCause } from "./log-cause.js";

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Refused when the user's session epoch moved after `user` was read. */
export class SessionEpochMoved extends Error {
  constructor() {
    super("this passkey is no longer the account's passkey");
  }
}

/**
 * Issue a session under the epoch `user` was read with, in the credential
 * check: if a recovery or passkey replacement has bumped it since, no session
 * is stored and this throws SessionEpochMoved.
 */
export async function issueSession(user: Pick<User, "id" | "sessionEpoch">) {
  const token = randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SECURITY.sessionTtlMs).toISOString();
  const added = await store.addSession({
    id: randomUUID(), userId: user.id, tokenHash: tokenHash(token), createdAt: now, lastUsedAt: now, expiresAt, epoch: user.sessionEpoch ?? 0,
  });
  if (!added) throw new SessionEpochMoved();
  return token;
}

/**
 * End every live session of this user except `keepId`, and move the user to
 * a new session epoch (store.revokeOtherSessions). After a credential
 * changes, a token copied before the change, or issued by a login whose
 * credential check ran before it, must not outlive it.
 */
export async function revokeOtherSessions(userId: string, keepId?: string) {
  await store.revokeOtherSessions(userId, keepId);
}

export function bearerToken(req: express.Request): string | undefined {
  const h = req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}

export async function requireSession(req: express.Request, res: express.Response) {
  // Called inside a caller's transaction, the touch waits for its commit: it
  // is telemetry, and a session row locked until then would be taken before
  // the user row, the opposite order of a recovery revoking that session.
  const inCallerTx = !!openTxToken();
  return store.tx(async () => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "authorization required" });
      return undefined;
    }
    const session = await store.findSessionByTokenHash(tokenHash(token));
    if (!session) {
      res.status(401).json({ error: "invalid session" });
      return undefined;
    }
    if (session.revokedAt || Date.now() >= Date.parse(session.expiresAt)) {
      res.status(401).json({ error: "session expired" });
      return undefined;
    }
    // A session issued under an older epoch: a credential changed after the
    // login's passkey check (revokeOtherSessions).
    const user = await store.findUser(session.userId);
    if (!user || (session.epoch ?? 0) < (user.sessionEpoch ?? 0)) {
      res.status(401).json({ error: "session expired" });
      return undefined;
    }
    const touch = () => store.touchSession(session.id);
    if (!inCallerTx || !deferToCommit(() => void touch().catch((e) => console.error(`session touch failed: ${describeCause(e)}`)))) await touch();
    return session;
  });
}

export async function requireUserSession(req: express.Request, res: express.Response, userId: string) {
  const session = await requireSession(req, res);
  if (!session) return undefined;
  if (session.userId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return undefined;
  }
  return session;
}

/** One cookie value, from the raw header — no cookie middleware is loaded. */
export function cookieValue(req: express.Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
