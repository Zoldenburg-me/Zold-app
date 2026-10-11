/**
 * Removing Zoldenburg as guardian while a recovery is pending.
 *
 * Revoking a guardian does not end a recovery the module already holds
 * (scripts/recovery-module-fork-test.ts shows it on the deployed module), so
 * the removal route refuses while one is pending — when the op is prepared
 * AND again right before the passkey-approved op is submitted, because a
 * recovery can start in between. The chain is staged through the router's
 * `readState` seam; the passkey approvals are real P-256 assertions.
 *
 * Run: npm run recovery:remove:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

const GUARDIAN = "0x00000000000000000000000000000000C0FFEE02";
const MODULE = "0x949d01d424bE050D09C16025dd007CB59b3A8c66"; // Candide's 3-minute test module
process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = GUARDIAN;
process.env.CANDIDE_RECOVERY_MODULE_ADDRESS = MODULE;
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { issueSession, requireUserSession } = await import("../services/api/src/http/sessions.js");
const { createZoldenburgRecoveryRouter } = await import("../services/api/src/routes/recovery-zoldenburg.js");
const { smartAccountForPasskey, webauthnOwnerFromStore } = await import("../services/api/src/wallet/candide.js");
type RecoveryModuleState = import("../services/api/src/wallet/candide.js").RecoveryModuleState;

initStore();
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

// ── a passkey whose public key is stored on the account ────────────────────
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
  const credentialId = b64url(Buffer.from(`remove-${label}`));
  const hex = (v: string) => `0x${Buffer.from(v, "base64url").toString("hex")}`;
  let count = 0;
  return {
    stored: { credentialId, publicKey: { jwk, alg: "ES256" as const }, signCount: 0, rpId: "localhost", createdAt: new Date().toISOString() },
    point: { x: hex(jwk.x!), y: hex(jwk.y!) },
    assert: async (challenge: string) => {
      count += 1;
      const cd = b64url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN })));
      const ad = Buffer.alloc(37); sha256("localhost").copy(ad, 0); ad[32] = 0x05; ad.writeUInt32BE(count, 33);
      const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([ad, sha256(Buffer.from(cd, "base64url"))])));
      return { authenticatorData: b64url(ad), clientDataJSON: cd, signature: b64url(derOf(raw)) };
    },
  };
}

// ── the chain, as the router reads it ──────────────────────────────────────
const chain = { pending: false, reads: 0 };
const readState = async (): Promise<RecoveryModuleState> => {
  chain.reads += 1;
  return {
    moduleAddress: MODULE,
    moduleEnabled: true,
    guardians: [GUARDIAN],
    threshold: 1,
    pending: chain.pending ? { newOwners: [`0x${"e".repeat(40)}`], newThreshold: 1, executeAfter: Math.floor(Date.now() / 1000) + 180 } : null,
  };
};

const app = express();
app.use(express.json());
app.use("/api", createZoldenburgRecoveryRouter({ requireUserSession, readState }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function call(path: string, token: string, body: unknown = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

const now = new Date().toISOString();
let n = 0;
/** An account whose Safe has Zoldenburg as its active guardian. */
async function guardedAccount() {
  n += 1;
  const id = `u_remove_${n}`;
  const key = await makePasskey(id);
  // The Safe address the passkey deterministically deploys to, as the route checks.
  const address = smartAccountForPasskey(webauthnOwnerFromStore(key.point)).accountAddress as `0x${string}`;
  store.addUser({
    id, name: `Person ${n}`, email: `r${n}@example.com`, country: "DE", kycStatus: "approved", createdAt: now,
    address, iban: "",
    passkey: key.stored,
    passkeySafe: {
      address, status: "active", threshold: 1, passkeyPublicKey: key.point, createdAt: now,
      recovery: { moduleAddress: MODULE, guardianAddress: GUARDIAN, threshold: 1, status: "active", enabledAt: now },
    },
  } as any);
  return { id, token: issueSession(id), key };
}
const removeUrl = (id: string) => `/api/users/${id}/recovery/zoldenburg/remove`;

console.log("removing Zoldenburg while a recovery is pending");

await check("preparing the removal is refused while a recovery is pending", async () => {
  const a = await guardedAccount();
  chain.pending = true;
  const r = await call(removeUrl(a.id), a.token);
  chain.pending = false;
  assert.equal(r.status, 409, r.text);
  assert.equal(r.data.code, "RECOVERY_PENDING");
});

await check("a recovery that starts after preparing refuses the submit, and the op is dropped", async () => {
  const a = await guardedAccount();
  const prep = await call(removeUrl(a.id), a.token);
  assert.equal(prep.status, 201, prep.text);
  chain.pending = true;
  const readsBefore = chain.reads;
  const approval = await a.key.assert(prep.data.challenge);
  const r = await call(prep.data.submitTo, a.token, approval);
  chain.pending = false;
  assert.equal(r.status, 409, r.text);
  assert.equal(r.data.code, "RECOVERY_PENDING");
  assert.equal(chain.reads, readsBefore + 1, "the chain is read again at submit");
  assert.equal(store.findUser(a.id)!.passkeySafe!.recovery?.status, "active", "Zoldenburg is still recorded as guardian");
  const again = await call(prep.data.submitTo, a.token, await a.key.assert(prep.data.challenge));
  assert.equal(again.status, 404, "the refused op cannot be submitted later");
});

await check("with no recovery pending, the passkey-approved removal goes through", async () => {
  const a = await guardedAccount();
  const prep = await call(removeUrl(a.id), a.token);
  assert.equal(prep.status, 201, prep.text);
  const readsBefore = chain.reads;
  const r = await call(prep.data.submitTo, a.token, await a.key.assert(prep.data.challenge));
  assert.equal(r.status, 200, r.text);
  assert.ok(chain.reads > readsBefore, "the chain is read again at submit");
  const user = store.findUser(a.id)!;
  assert.equal(user.passkeySafe!.recovery, undefined);
  assert.equal(user.passkeySafe!.recoveryChoice?.choice, "declined");
});

server.close();
if (failed) {
  console.error(`\nZOLDENBURG REMOVE TEST FAILED — ${failed} case(s)`);
  process.exit(1);
}
console.log("\nZOLDENBURG REMOVE TEST PASSED");
process.exit(0);
