/**
 * Turnkey social guardians (wallet/turnkey.ts holds the rules). Backend only:
 * no screen offers this yet, and the switch (TURNKEY_GUARDIANS) stays off
 * until the Phase 0 recovery alerts are live.
 *
 * - GET  /recovery/turnkey/users/:id/guardians: the owner's Turnkey guardians.
 * - POST /recovery/turnkey/users/:id/guardians {oidcToken, publicKey}: the
 *   owner logged in with Google or Apple in this browser; find or create the
 *   sub-org for that login and record its address. `created` is not a
 *   guardian: only the passkey-signed addGuardianWithThreshold makes it one,
 *   and only the chain says it happened.
 * - POST /recovery/turnkey/login {oidcToken, publicKey}: no Zold session (the
 *   device may be the lost one's replacement); a Turnkey session for the
 *   login's own sub-org, bound to the browser key, so it can sign a recovery.
 *
 * Under /recovery, so every call sits on the tight auth bucket
 * (http/policy.ts). The ID token is never stored or logged.
 */
import express from "express";
import { store } from "../store.js";
import type { User } from "../store/types.js";
import {
  TurnkeyGuardianError,
  buildGuardianSubOrg,
  fetchJwks,
  turnkeyClient,
  turnkeyGuardiansEnabled,
  verifyGuardianOidcToken,
  type JwksSource,
  type TurnkeyGuardianClient,
} from "../wallet/turnkey.js";
import { wrap } from "./util.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface TurnkeyGuardianDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  /** Turnkey, or a stand-in under test. */
  client?: () => TurnkeyGuardianClient;
  enabled?: () => boolean;
  /** Google's and Apple's signing keys, or a stand-in under test. */
  jwks?: JwksSource;
}

type SocialGuardian = NonNullable<NonNullable<User["passkeySafe"]>["socialGuardians"]>[number];

const view = (g: SocialGuardian) => ({
  kind: g.kind,
  address: g.address,
  turnkeySubOrgId: g.turnkeySubOrgId,
  status: g.status,
  createdAt: g.createdAt,
});

export function createTurnkeyGuardianRouter({
  requireUserSession,
  client = turnkeyClient,
  enabled = turnkeyGuardiansEnabled,
  jwks = fetchJwks,
}: TurnkeyGuardianDeps) {
  const router = express.Router();
  /**
   * Adds in flight, by user and by login identity: two parallel adds of the
   * same Google account (two tabs, or two Zold users) would both find no
   * sub-org and make two, and a login with two sub-orgs can no longer sign
   * a recovery (AMBIGUOUS). Per process: the API runs as one.
   */
  const adding = new Set<string>();

  router.use("/recovery/turnkey", (_req, res, next) => {
    if (enabled()) return next();
    res.status(404).json({ error: "Turnkey guardians are not available on this deployment", code: "TURNKEY_OFF" });
  });

  router.get("/recovery/turnkey/users/:id/guardians", (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    res.json({ guardians: (user.passkeySafe?.socialGuardians ?? []).map(view) });
  });

  router.post(
    "/recovery/turnkey/users/:id/guardians",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const safe = user.passkeySafe;
      if (!safe || safe.status !== "active") {
        return res.status(409).json({ error: "a guardian needs your own deployed Safe", code: "NO_SAFE" });
      }
      if (safe.importedAt) {
        return res.status(409).json({ error: "an imported Safe is not offered a recovery guardian", code: "IMPORTED_SAFE" });
      }
      const locks: string[] = [];
      const lock = (key: string) => {
        if (adding.has(key)) throw new TurnkeyGuardianError("a guardian is already being added", 409, "BUSY");
        adding.add(key);
        locks.push(key);
      };
      try {
        lock(`user:${user.id}`);
        const { oidcToken, publicKey } = req.body ?? {};
        const login = await verifyGuardianOidcToken(oidcToken, publicKey, jwks);
        lock(`login:${login.issuer}|${login.subject}`);
        const turnkey = client();
        const ids = await turnkey.subOrgIdsForOidcToken(oidcToken);
        if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
        const found = ids.length === 1 ? { subOrgId: ids[0], address: await turnkey.walletAddress(ids[0]) } : undefined;
        const { subOrgId, address } = found ?? (await turnkey.createSubOrg(buildGuardianSubOrg({ oidcToken, providerName: login.providerName })));

        const fresh = store.findUser(user.id)!;
        const current = fresh.passkeySafe!;
        const existing = (current.socialGuardians ?? []).find((g) => g.turnkeySubOrgId === subOrgId);
        if (existing) return res.json({ guardian: view(existing) });
        const guardian: SocialGuardian = { kind: "self-social", address, turnkeySubOrgId: subOrgId, status: "created", createdAt: new Date().toISOString() };
        store.updateUser(user.id, { passkeySafe: { ...current, socialGuardians: [...(current.socialGuardians ?? []), guardian] } });
        res.status(201).json({ guardian: view(guardian) });
      } catch (e) {
        sendError(res, e);
      } finally {
        for (const key of locks) adding.delete(key);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/login",
    wrap(async (req, res) => {
      try {
        const { oidcToken, publicKey } = req.body ?? {};
        await verifyGuardianOidcToken(oidcToken, publicKey, jwks);
        const turnkey = client();
        const ids = await turnkey.subOrgIdsForOidcToken(oidcToken);
        if (ids.length === 0) throw new TurnkeyGuardianError("this login is not a guardian", 404, "NO_GUARDIAN");
        if (ids.length > 1) throw new TurnkeyGuardianError("this login has more than one guardian sub-org", 409, "AMBIGUOUS");
        const session = await turnkey.oauthLogin(ids[0], oidcToken, publicKey);
        res.json({ session, subOrgId: ids[0] });
      } catch (e) {
        sendError(res, e);
      }
    }),
  );

  return router;
}

/** Our refusals keep their status; anything from Turnkey is a 502. The log
 *  names the error's type and code only: a Turnkey error may echo the
 *  request, and the request carries the ID token and the browser key. */
function sendError(res: express.Response, e: unknown) {
  if (e instanceof TurnkeyGuardianError) return res.status(e.status).json({ error: e.message, code: e.code });
  const err = e as { name?: string; code?: unknown };
  console.error("[turnkey] request failed:", err?.name ?? typeof e, err?.code ?? "");
  res.status(502).json({ error: "Turnkey did not answer as expected; try again", code: "TURNKEY_FAILED" });
}
