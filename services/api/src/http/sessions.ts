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
import { store } from "../store.js";

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function issueSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SECURITY.sessionTtlMs).toISOString();
  store.addSession({ id: randomUUID(), userId, tokenHash: tokenHash(token), createdAt: now, lastUsedAt: now, expiresAt });
  return token;
}

export function bearerToken(req: express.Request): string | undefined {
  const h = req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}

export function requireSession(req: express.Request, res: express.Response) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "authorization required" });
    return undefined;
  }
  const session = store.findSessionByTokenHash(tokenHash(token));
  if (!session) {
    res.status(401).json({ error: "invalid session" });
    return undefined;
  }
  if (session.revokedAt || Date.now() >= Date.parse(session.expiresAt)) {
    res.status(401).json({ error: "session expired" });
    return undefined;
  }
  store.touchSession(session.id);
  return session;
}

export function requireUserSession(req: express.Request, res: express.Response, userId: string) {
  const session = requireSession(req, res);
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
