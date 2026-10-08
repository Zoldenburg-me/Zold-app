/**
 * Who may change an account's identity, and what the account says about it.
 *
 * Offline: an in-process express app on an ephemeral port, a throwaway db, no
 * chain and no Monerium (its base URL points at a closed local port, so a
 * route that reached it would fail here rather than call out).
 *
 *   - a Monerium relink on an account that was ever approved, or carries a
 *     Monerium profile, needs the passkey even with no connection and no IBAN;
 *     a brand-new pending account still connects without one;
 *   - a step-up challenge is bound to the action it approves;
 *   - the account and document projections are allowlists;
 *   - declining Zoldenburg on an account with no Safe writes nothing;
 *   - every Monerium profile an account held is kept, for the operator;
 *   - balance and ownership letters are issued only to an approved account.
 *
 *   npm run identity:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

const OPERATOR = "operator-token-for-identity-tests-0123456";
process.env.KYC_OPERATOR_TOKEN = OPERATOR;
process.env.MONERIUM_OAUTH_CLIENT_ID = "identity-test-client";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "identity-test-token-encryption-key-32b";
process.env.MONERIUM_BASE_URL = "http://127.0.0.1:9";
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { issueSession, requireUserSession } = await import("../services/api/src/http/sessions.js");
const { createAuthRouter } = await import("../services/api/src/routes/auth.js");
const { createMoneriumRouter } = await import("../services/api/src/routes/monerium.js");
const { createDocumentsRouter } = await import("../services/api/src/routes/documents.js");
const { createZoldenburgRecoveryRouter } = await import("../services/api/src/routes/recovery-zoldenburg.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { publicDocument } = await import("../services/api/src/documents.js");

initStore();
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

// ── a passkey whose public key is stored directly on the account ────────────
const ORIGIN = "http://localhost:3000";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
function derOf(raw: Buffer): Buffer {
  const int = (b: Buffer) => { let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1); if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]); return Buffer.concat([Buffer.from([0x02, v.length]), v]); };
  const r = int(raw.subarray(0, 32)); const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}
async function makePasskey(label: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const credentialId = b64url(Buffer.from(`identity-${label}`));
  let count = 0;
  return {
    stored: { credentialId, publicKey: { jwk, alg: "ES256" as const }, signCount: 0, rpId: "localhost", createdAt: new Date().toISOString() },
    assert: async (challenge: string) => {
      count += 1;
      const cd = b64url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN })));
      const ad = Buffer.alloc(37); sha256("localhost").copy(ad, 0); ad[32] = 0x05; ad.writeUInt32BE(count, 33);
      const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([ad, sha256(Buffer.from(cd, "base64url"))])));
      return { credentialId, authenticatorData: b64url(ad), clientDataJSON: cd, signature: b64url(derOf(raw)) };
    },
  };
}

// ── the app ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api", createAuthRouter({ requireUserSession }));
app.use("/api", createMoneriumRouter({ requireUserSession }));
app.use("/api", createDocumentsRouter({ requireUserSession }));
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

const now = new Date().toISOString();
let n = 0;
async function account(extra: Record<string, unknown> = {}) {
  n += 1;
  const id = `u_identity_${n}`;
  const key = await makePasskey(id);
  store.addUser({
    id, name: `Person ${n}`, email: `p${n}@example.com`, country: "DE", kycStatus: "pending", createdAt: now,
    address: `0x${String(n).padStart(40, "a")}` as `0x${string}`, iban: "",
    passkey: key.stored,
    ...extra,
  } as any);
  const token = issueSession(id);
  /** A step-up assertion over a challenge the server issued for `action`. */
  const stepUp = async (action?: string) => {
    const c = await call("POST", "/api/webauthn/challenge", token, { purpose: "step_up", ...(action ? { action } : {}) });
    assert.equal(c.status, 200, `step-up challenge refused: ${c.text}`);
    return key.assert(c.data.challenge);
  };
  return { id, token, key, stepUp };
}

// ── 1. relinking Monerium ───────────────────────────────────────────────────
console.log("Monerium relink");
await check("a brand-new pending account connects Monerium for the first time without a step-up", async () => {
  const a = await account();
  const r = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, {});
  assert.equal(r.status, 201, r.text);
  assert.equal(publicUser(store.findUser(a.id)!).moneriumChangeNeedsPasskey, false);
});
await check("an approved account with no connection and an empty IBAN needs the passkey to relink", async () => {
  const a = await account({
    kycStatus: "approved",
    kyc: { provider: "monerium", applicantId: "profile-old", checkedAt: now },
    funding: { mode: "sandbox", status: "kyc_pending", moneriumProfileId: "profile-old" },
  });
  const start = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, {});
  assert.equal(start.status, 401, `OAuth relink on a session alone: ${start.text}`);
  assert.match(start.data.error, /fresh passkey approval/);
  const keys = await call("POST", `/api/users/${a.id}/monerium/api-keys`, a.token, { clientId: "other_login_app", clientSecret: "other-login-secret" });
  assert.equal(keys.status, 401, `API-key relink on a session alone: ${keys.text}`);
  assert.equal(store.findUser(a.id)!.funding?.moneriumProfileId, "profile-old", "the recorded profile is untouched");
  assert.equal(publicUser(store.findUser(a.id)!).moneriumChangeNeedsPasskey, true, "the app is told to ask for the passkey");
});
await check("a pending account that once carried a Monerium profile needs the passkey too", async () => {
  const a = await account({ funding: { mode: "sandbox", status: "kyc_pending", moneriumProfileId: "profile-seen" } });
  const r = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, {});
  assert.equal(r.status, 401, r.text);
});
await check("with the passkey, the approved account may relink", async () => {
  const a = await account({ kycStatus: "approved", kyc: { provider: "monerium", checkedAt: now } });
  const r = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, { stepUp: await a.stepUp("monerium.connect") });
  assert.equal(r.status, 201, r.text);
});

// ── 2. step-ups are bound to their action ───────────────────────────────────
console.log("step-up binding");
await check("a step-up challenge names the action it approves", async () => {
  const a = await account();
  assert.equal((await call("POST", "/api/webauthn/challenge", a.token, { purpose: "step_up" })).status, 400, "no action");
  assert.equal((await call("POST", "/api/webauthn/challenge", a.token, { purpose: "step_up", action: "anything" })).status, 400, "unknown action");
  assert.equal((await call("POST", "/api/webauthn/challenge", a.token, { purpose: "step_up", action: "safe.import" })).status, 400, "safe.import is approved per Safe: its challenge comes from /safe/import/prepare");
});
await check("an approval collected for one action is refused by another", async () => {
  const a = await account({ kycStatus: "approved", kyc: { provider: "monerium", checkedAt: now } });
  const wrong = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, { stepUp: await a.stepUp("passkey.replace") });
  assert.equal(wrong.status, 401, wrong.text);
  assert.match(wrong.data.error, /unknown or expired challenge/);
  const disconnect = await call("POST", `/api/users/${a.id}/monerium/connect/start`, a.token, { stepUp: await a.stepUp("monerium.disconnect") });
  assert.equal(disconnect.status, 401, "a disconnect approval does not connect");
});

// ── 4. projections are allowlists ───────────────────────────────────────────
console.log("projections");
await check("the account projection sends only named fields", async () => {
  const a = await account({
    futureSecret: "must-not-leak",
    moneriumConnect: { state: "s", codeVerifier: "cv-secret", redirectUri: "r", createdAt: now },
    emailCode: { hash: "code-hash-secret", email: "x", expiresAt: now, attempts: 0, sentAt: [] },
    monerium: { connectedAt: now, profileId: "p", accessTokenEnc: "token-ciphertext", futureMoneriumSecret: "nested-leak" },
    passkeySafe: { address: `0x${"b".repeat(40)}`, status: "active", threshold: 1, passkeyPublicKey: { x: "1", y: "2" }, createdAt: now, futurePlanSecret: "plan-leak" },
  });
  const json = JSON.stringify(publicUser(store.findUser(a.id)!));
  for (const leak of ["must-not-leak", "futureSecret", "cv-secret", "code-hash-secret", "token-ciphertext", "nested-leak", "plan-leak"]) {
    assert.ok(!json.includes(leak), `published ${leak}`);
  }
  const pub = publicUser(store.findUser(a.id)!);
  assert.equal(pub.id, a.id);
  assert.equal(pub.passkeySafe?.address, `0x${"b".repeat(40)}`);
  assert.equal(pub.monerium?.profileId, "p");
});
await check("the document projection sends only named fields", () => {
  const doc: any = {
    id: "doc-id", code: "ABCDE12345FGHJK", kind: "balance", userId: "u-secret", orgId: "org-secret", createdAt: now,
    snapshot: { kind: "balance" }, attestations: { zold: {} }, futureField: "doc-leak",
  };
  const json = JSON.stringify(publicDocument(doc));
  for (const leak of ["doc-id", "u-secret", "org-secret", "doc-leak"]) assert.ok(!json.includes(leak), `published ${leak}`);
  assert.equal(publicDocument(doc).code, "ABCDE12345FGHJK");
});

// ── 6. declining Zoldenburg with no Safe ────────────────────────────────────
console.log("recovery");
await check("declining Zoldenburg on an account with no Safe is refused and writes nothing", async () => {
  const a = await account();
  const r = await call("POST", `/api/users/${a.id}/recovery/zoldenburg/decline`, a.token, { acknowledged: true });
  assert.equal(r.status, 409, r.text);
  assert.equal(store.findUser(a.id)!.passkeySafe, undefined);
});

// ── 7. Monerium profile history ─────────────────────────────────────────────
await check("every Monerium profile the account held is kept, in order, and shown to the operator", async () => {
  const a = await account({ passkeySafe: { address: `0x${"c".repeat(40)}`, status: "active", threshold: 1, passkeyPublicKey: { x: "1", y: "2" }, createdAt: now } });
  store.updateUser(a.id, { funding: { mode: "sandbox", status: "provisioning", moneriumProfileId: "profile-1" } });
  store.updateUser(a.id, { monerium: { connectedAt: now, profileId: "profile-1" } });
  store.updateUser(a.id, { monerium: { connectedAt: now, profileId: "profile-2" }, funding: { mode: "sandbox", status: "provisioning", moneriumProfileId: "profile-2" } });
  store.updateUser(a.id, { monerium: undefined });
  store.updateUser(a.id, { moneriumProfileHistory: [] } as any);
  const history = store.findUser(a.id)!.moneriumProfileHistory ?? [];
  assert.deepEqual(history.map((h) => h.profileId), ["profile-1", "profile-2"]);
  assert.ok(history.every((h) => h.at), "each entry is dated");
  store.addRecoveryRequest({
    id: "rec-identity", userId: a.id, safeAddress: `0x${"c".repeat(40)}`, mode: "zoldenburg", status: "REVIEW_PENDING",
    requestedAt: now, expiresAt: now, recoveryDelayHours: 0, guardianAddress: `0x${"d".repeat(40)}`, recoveryModuleAddress: `0x${"e".repeat(40)}`,
    factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
  } as any);
  const r = await call("GET", "/api/admin/recoveries", OPERATOR);
  assert.equal(r.status, 200, r.text);
  const row = r.data.requests.find((x: any) => x.id === "rec-identity");
  assert.deepEqual(row.account.moneriumProfileHistory.map((h: any) => h.profileId), ["profile-1", "profile-2"]);
});

// ── 3. letters only for an approved account ─────────────────────────────────
console.log("documents");
await check("a pending account cannot have Zold sign a balance or ownership letter", async () => {
  const a = await account();
  for (const kind of ["balance", "ownership"]) {
    const r = await call("POST", `/api/users/${a.id}/documents/${kind}`, a.token, {});
    assert.equal(r.status, 409, `${kind}: ${r.text}`);
    assert.equal(r.data.code, "ACCOUNT_NOT_VERIFIED");
  }
  assert.equal(store.documentsForUser(a.id).length, 0);
});

server.close();
if (failed) {
  console.error(`\nIDENTITY TEST FAILED — ${failed} case(s)`);
  process.exit(1);
}
console.log("\nIDENTITY TEST PASSED");
process.exit(0);
