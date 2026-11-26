/**
 * The identity and recovery races of docs/postgres-store-design.md §2 (S4b),
 * on the API's own store: db.json under `npm run check`, Postgres 17 under
 * `npm run check:pg` (STORE_BACKEND=postgres, a throwaway database).
 *
 * - Session epoch: a login whose passkey check ran before a recovery or a
 *   passkey replacement never gets a live session; the session the change
 *   keeps stays signed in.
 * - Monerium refresh: one spent refresh token stores its successor once.
 * - Turnkey recovery: the signature relay and the finalisation each hold a
 *   RELAYING reserve; a second caller is refused.
 *
 * Offline.  npm run identity-race:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { initStore, store } = await import("../services/api/src/store.js");
const { issueSession, requireSession, revokeOtherSessions, SessionEpochMoved, tokenHash } = await import("../services/api/src/http/sessions.js");

await initStore();
const now = new Date().toISOString();

async function addUser(id: string) {
  await store.addUser({
    id, name: id, country: "DE", kycStatus: "approved", iban: "", createdAt: now,
    address: `0x${randomUUID().replace(/-/g, "").slice(0, 40).padEnd(40, "0")}`,
    passkey: { credentialId: `cred-${id}`, publicKey: { kty: "EC" } as any, signCount: 0, createdAt: now },
  } as any);
  return (await store.findUser(id))!;
}

/** requireSession on a bearer token: the HTTP status it answers, 200 if it passes. */
async function authStatus(token: string): Promise<number> {
  let code = 200;
  const req: any = { header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) };
  const res: any = { status: (c: number) => ((code = c), res), json: () => res };
  const s = await requireSession(req, res);
  return s ? 200 : code;
}

// ── Session epoch ────────────────────────────────────────────────────────────
{
  // A login read the user (its passkey check) before a recovery landed: the
  // recovery bumps the epoch, and the login's session is not stored.
  const checked = await addUser("u_epoch");
  const before = await issueSession(checked);
  await revokeOtherSessions(checked.id);
  assert.equal(await authStatus(before), 401, "a session from before the change is revoked");
  await assert.rejects(issueSession(checked), SessionEpochMoved, "a login checked before the change gets no session");
  assert.equal((await store.list("sessions")).filter((s) => s.userId === checked.id).length, 1, "nothing was stored for it");
  const fresh = await issueSession((await store.findUser(checked.id))!);
  assert.equal(await authStatus(fresh), 200, "a login checked after it signs in");

  // Twenty logins checked before the change, racing it: whichever lands
  // first, none ends with a live session.
  const racer = await addUser("u_epoch_race");
  const issued = Promise.allSettled(Array.from({ length: 20 }, () => issueSession(racer)));
  const bump = revokeOtherSessions(racer.id);
  const results = await issued;
  await bump;
  const tokens = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof SessionEpochMoved, String(r.reason));
  for (const t of tokens) assert.equal(await authStatus(t), 401, "a stale login's session never authenticates");
  const epoch = (await store.findUser(racer.id))!.sessionEpoch ?? 0;
  assert.equal(epoch, 1);
  for (const s of (await store.list("sessions")).filter((x) => x.userId === racer.id)) {
    assert.ok(s.revokedAt || (s.epoch ?? 0) === epoch, "no live session under the old epoch");
  }

  // A passkey replacement approved from a session: that one session stays
  // signed in, every other one is refused.
  const owner = await addUser("u_epoch_keep");
  const approving = await issueSession(owner);
  const other = await issueSession(owner);
  const keep = (await store.findSessionByTokenHash(tokenHash(approving)))!;
  await revokeOtherSessions(owner.id, keep.id);
  assert.equal(await authStatus(approving), 200, "the session that approved the change stays signed in");
  assert.equal(await authStatus(other), 401, "every other one is refused");

  // A session below the user's epoch is refused even if nothing revoked it.
  const lagging = await addUser("u_epoch_lag");
  const token = await issueSession(lagging);
  await store.updateUser(lagging.id, { sessionEpoch: 3 });
  assert.equal(await authStatus(token), 401, "an older epoch does not authenticate");
  console.log("ok - session epoch: a login checked before a recovery or passkey replacement gets no live session (20 racing one change); the kept session stays signed in; an older epoch is refused");
}

// ── Monerium token refresh ───────────────────────────────────────────────────
{
  // Two refreshes spent one refresh token in parallel (the in-memory
  // single-flight bypassed, as a second process would): one stores, the
  // other refuses, and the stored refresh token is the one that stored.
  const u = await addUser("u_mon");
  await store.updateUser(u.id, { monerium: { connectedAt: now, method: "oauth", accessTokenEnc: "a0", refreshTokenEnc: "r0", expiresAt: now } });
  const racers = Array.from({ length: 10 }, (_, i) => store.storeMoneriumTokens(u.id, "r0", { accessTokenEnc: `a${i + 1}`, refreshTokenEnc: `r${i + 1}` }));
  const stored = (await Promise.all(racers)).flatMap((r, i) => (r ? [i + 1] : []));
  assert.equal(stored.length, 1, "one refresh stores");
  const m = (await store.findUser(u.id))!.monerium!;
  assert.deepEqual([m.accessTokenEnc, m.refreshTokenEnc], [`a${stored[0]}`, `r${stored[0]}`], "the stored tokens are the winner's");
  console.log("ok - Monerium refresh: ten refreshes of one token in parallel, one stores, the others refuse");
}

// ── Turnkey reserves ─────────────────────────────────────────────────────────
{
  const { acceptTurnkeySignature, finalizeTurnkeyRecovery } = await import("../services/api/src/recovery/turnkey-recovery.js");
  const safe = `0x${"7a".repeat(20)}` as const;
  const newOwner = `0x${"7b".repeat(20)}` as const;
  const u = await addUser("u_tk");
  await store.updateUser(u.id, { passkeySafe: { address: safe, status: "active" } as any });
  const request = (id: string, status: string, turnkey: object) => ({
    id, userId: u.id, safeAddress: safe, mode: "turnkey", status, requestedAt: now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), recoveryDelayHours: 1, guardianAddress: `0x${"7c".repeat(20)}`,
    recoveryModuleAddress: `0x${"7d".repeat(20)}`, factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" }, turnkey,
  });
  let reads = 0;
  let finalizes = 0;
  const chain: any = {
    // Each call waits a tick, so the racers overlap.
    readState: async () => { reads++; await new Promise((r) => setTimeout(r, 20)); throw new Error("module read failed"); },
    relayFinalize: async () => { finalizes++; await new Promise((r) => setTimeout(r, 20)); return { txHash: `0x${"7e".repeat(32)}` }; },
    safeOwners: async () => [newOwner],
  };
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const np = { credentialId: "tk-new", publicKey: { alg: "ES256", jwk: await crypto.subtle.exportKey("jwk", key.publicKey) }, signCount: 0, createdAt: now };

  // Five guardian signatures relayed at once: one claims the reserve and
  // reads the module, the others are refused; a relay that ends with nothing
  // gives the request back.
  await store.addRecoveryRequest(request("tk-sign", "REVIEW_PENDING", { newOwners: [newOwner], newPasskey: np }) as any);
  const signed = await Promise.allSettled(Array.from({ length: 5 }, () =>
    acceptTurnkeySignature(request("tk-sign", "REVIEW_PENDING", {}) as any, { r: "0x0", s: "0x0", v: "0x1b" }, chain, { ownerAlerted: () => true })));
  assert.equal(reads, 1, `the module is read by one signer: ${signed.map((o) => (o.status === "rejected" ? String(o.reason) : o.value.status)).join(" | ")}`);
  assert.equal(signed.filter((o) => o.status === "rejected" && /already being approved/.test(String(o.reason))).length, 4, "the others are refused");
  assert.deepEqual([(await store.findRecoveryRequest("tk-sign"))!.status, (await store.findRecoveryRequest("tk-sign"))!.relaying], ["REVIEW_PENDING", undefined], "given back");

  // Five finalisers at once: finalizeRecovery is relayed once, the passkey bound once.
  await store.addRecoveryRequest(request("tk-fin", "GRACE_PERIOD", { newOwners: [newOwner], newPasskey: np, finalizeAfter: new Date(Date.now() - 1000).toISOString() }) as any);
  const fin = await Promise.allSettled(Array.from({ length: 5 }, async () => finalizeTurnkeyRecovery((await store.findRecoveryRequest("tk-fin"))!, chain)));
  assert.equal(finalizes, 1, "finalizeRecovery relayed once");
  assert.equal(fin.filter((o) => o.status === "fulfilled" && o.value.status === "FINALIZED").length, 1, fin.map((o) => (o.status === "rejected" ? String(o.reason) : o.value.status)).join(" | "));
  assert.equal(fin.filter((o) => o.status === "rejected" && /being finished/.test(String(o.reason))).length, 4);
  const done = (await store.findRecoveryRequest("tk-fin"))!;
  assert.deepEqual([done.status, done.relaying], ["FINALIZED", undefined]);
  assert.equal((await store.findUser(u.id))!.passkey?.credentialId, "tk-new", "the new passkey is bound");
  console.log("ok - Turnkey: five signatures at once, one reads the module; five finalisers, one relay and one bind");
}

await store.close();
