/**
 * The org Safe signature queue (domain/safe-op-queue.ts,
 * wallet/org-safe-queue.ts, routes/business/safe-ops.ts).
 *
 * Covers:
 *   - the flag: off, nothing is queued and every route refuses;
 *   - the threshold is the chain's: a 2-of-3 Safe relays on the second
 *     owner's signature, not the first, and a 1-of-1 on the first;
 *   - only an owner whose passkey is an owner on chain signs: a payer, an
 *     admin, and an owner member whose passkey is not on the Safe are refused;
 *   - a duplicate signature is refused, also when sent twice at once;
 *   - Q6: an owner removed on chain has their signature dropped, and the op
 *     waits for a current owner;
 *   - an expired op and an op whose nonce the Safe moved past end, and take
 *     no more signatures; an op ahead of the Safe's nonce waits;
 *   - relay outcomes: a bundler refusal or a revert is FAILED, an unanswered
 *     relay is MANUAL_REVIEW; a finished op never moves back;
 *   - two owners meeting the threshold at once relay once;
 *   - cancel by the creator or an owner only; the public projection carries
 *     no assertion and no UserOperation; the stored op round-trips bigints;
 *   - the relay refuses an op whose stored UserOperation no longer hashes to
 *     the digest the owners signed;
 *   - the personal path is untouched: candide.ts still refuses threshold > 1
 *     on every passkey-alone op.
 *
 * Offline: the chain (owners, threshold, nonce, relay) is a fake, passkeys
 * are software keys.
 * Run: npm run safe-op-queue:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-safe-op-queue-")), "db.json");
// The app on the local chain, Safes on Base Sepolia, and the hardhat harness
// off: the org path must never take the harness's fake receipts.
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";
process.env.ORG_SAFE_QUEUE_ENABLED = "1";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createSafeOpRoutes } = await import("../services/api/src/routes/business/safe-ops.js");
const { queueSafeOp, relayIfReady, SafeOpRefusal } = await import("../services/api/src/wallet/org-safe-queue.js");
const { checkAgainstChain, decodeUserOperation, encodeUserOperation, SAFE_OP_TTL_MS } = await import("../services/api/src/domain/safe-op-queue.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { BundlerRefusedError, SafeOperationUncertainError, submitMultiOwnerSafeOperation } = await import("../services/api/src/wallet/candide.js");
initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

// ── an org with three owners, an admin and a payer ──────────────────────────
const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const people = ["anna", "bert", "cara", "dora", "admin", "payer"] as const;
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
store.addOrganisation({ id: "org_1", type: "business", name: "Acme GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
for (const p of people) {
  keys[p] = await makeSoftwarePasskey(p, ORIGIN);
  addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  store.addUser({
    id: `u_${p}`, name: p[0].toUpperCase() + p.slice(1), country: "DE", kycStatus: "approved", address: `0x${randomBytes(20).toString("hex")}`,
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
  const role = p === "admin" ? "admin" : p === "payer" ? "payer" : "owner";
  store.addMember({ id: `m_${p}`, orgId: "org_1", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
// A second org, to check one org never reaches another's op.
store.addOrganisation({ id: "org_2", type: "business", name: "Other AG", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
store.addMember({ id: "m_anna2", orgId: "org_2", userId: "u_anna", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);

// ── the fake chain ──────────────────────────────────────────────────────────
const chain = {
  owners: [addr.anna, addr.bert, addr.cara] as `0x${string}`[],
  threshold: 2,
  nonce: 0n,
  relays: [] as { opId: string; signers: string[] }[],
  relayResult: (): any => ({ userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, success: true, gasPaidBy: "sponsored" }),
  relayDelay: 0,
};
const fakeChain = {
  read: async () => ({ owners: [...chain.owners], threshold: chain.threshold, nonce: chain.nonce }),
  relay: async (op: any, sigs: any[]) => {
    chain.relays.push({ opId: op.id, signers: sigs.map((s) => s.memberId) });
    if (chain.relayDelay) await new Promise((r) => setTimeout(r, chain.relayDelay));
    return chain.relayResult();
  },
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createSafeOpRoutes({ ctxOf: (req, res) => resolveOrg(req, res, requireSession as any) }, fakeChain));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

const org = () => store.findOrganisation("org_1")!;
const member = (p: string) => store.findMember(`m_${p}`)!;
const queue = (by = "payer", nonce = chain.nonce, extra: Partial<{ now: number }> = {}) =>
  queueSafeOp({
    org: org(), member: member(by), safeAddress: SAFE, kind: "payment", summary: "Pay 120 EURe to Lieferant GmbH",
    prepared: { challenge: `0x${randomBytes(32).toString("hex")}`, userOperation: { sender: SAFE, nonce, callGasLimit: 123456789012345678901234567890n, signature: "0x" }, nonce },
    ...extra,
  });
const challengeOf = (op: { digest: string }) => Buffer.from(op.digest.slice(2), "hex").toString("base64url");
const sign = async (p: string, opId: string, challenge?: string) => {
  const op = store.findSafeOp(opId)!;
  const a = await keys[p].assert(challenge ?? challengeOf(op));
  return call("POST", `/orgs/org_1/safe-ops/${opId}/signatures`, `u_${p}`, a);
};
const reset = () => { chain.owners = [addr.anna, addr.bert, addr.cara]; chain.threshold = 2; chain.nonce = 0n; chain.relays = []; chain.relayDelay = 0; chain.relayResult = () => ({ userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, success: true, gasPaidBy: "sponsored" }); };

// ── the flag ────────────────────────────────────────────────────────────────
await check("flag off: nothing is queued and every route refuses", async () => {
  process.env.ORG_SAFE_QUEUE_ENABLED = "";
  try {
    assert.throws(() => queue(), (e: any) => e instanceof SafeOpRefusal && e.code === "ORG_SAFE_QUEUE_OFF");
    const list = await call("GET", "/orgs/org_1/safe-ops", "u_anna");
    assert.equal(list.status, 409);
    assert.equal(list.data.code, "ORG_SAFE_QUEUE_OFF");
    assert.equal(store.safeOpsOf("org_1").length, 0);
  } finally {
    process.env.ORG_SAFE_QUEUE_ENABLED = "1";
  }
});

// ── queueing ────────────────────────────────────────────────────────────────
await check("payers and admins queue; a viewer cannot; a personal org cannot", async () => {
  reset();
  assert.equal(queue("payer").state, "PENDING");
  assert.equal(queue("admin").state, "PENDING");
  store.addMember({ id: "m_viewer", orgId: "org_1", userId: "u_dora", email: "", role: "viewer", status: "active", invitedAt: now, acceptedAt: now } as any);
  assert.throws(() => queueSafeOp({ org: org(), member: store.findMember("m_viewer")!, safeAddress: SAFE, kind: "payment", summary: "x", prepared: { challenge: `0x${"11".repeat(32)}`, userOperation: {}, nonce: 0n } }),
    (e: any) => e.code === "CANNOT_QUEUE");
  store.addOrganisation({ id: "org_p", type: "personal", name: "Me", plan: "free", reporting: {}, verifications: {}, createdAt: now, updatedAt: now } as any);
  assert.throws(() => queueSafeOp({ org: store.findOrganisation("org_p")!, member: member("anna"), safeAddress: SAFE, kind: "payment", summary: "x", prepared: { challenge: `0x${"11".repeat(32)}`, userOperation: {}, nonce: 0n } }),
    (e: any) => e.code === "NOT_A_BUSINESS");
});

// ── the threshold ───────────────────────────────────────────────────────────
await check("2-of-3: the first signature waits, the second relays once", async () => {
  reset();
  const op = queue();
  const first = await sign("anna", op.id);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.op.state, "PENDING");
  assert.equal(first.data.threshold, 2);
  assert.deepEqual(first.data.owners.map((o: any) => o.signed), [true, false, false]);
  assert.equal(chain.relays.length, 0, "no relay below the threshold");

  const view = await call("GET", `/orgs/org_1/safe-ops/${op.id}`, "u_payer");
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.op.signatures.map((s: any) => s.name), ["Anna"]);
  assert.deepEqual(view.data.owners.filter((o: any) => !o.signed).map((o: any) => o.name), ["Bert", "Cara"]);

  const second = await sign("bert", op.id);
  assert.equal(second.status, 201);
  assert.equal(second.data.op.state, "EXECUTED");
  assert.equal(second.data.op.txHash, `0x${"cd".repeat(32)}`);
  assert.deepEqual(chain.relays, [{ opId: op.id, signers: ["m_anna", "m_bert"] }]);

  const late = await sign("cara", op.id);
  assert.equal(late.status, 409);
  assert.equal(late.data.code, "NOT_PENDING");
  assert.equal(chain.relays.length, 1);
});

await check("1-of-1 relays on the first signature; the threshold is never Zold's", async () => {
  reset();
  chain.owners = [addr.anna];
  chain.threshold = 1;
  const op = queue();
  const r = await sign("anna", op.id);
  assert.equal(r.data.op.state, "EXECUTED");
  assert.equal(chain.relays.length, 1);
});

await check("a threshold raised on chain after signing makes the op wait for one more", async () => {
  reset();
  const op = queue();
  await sign("anna", op.id);
  chain.threshold = 3;
  const r = await sign("bert", op.id);
  assert.equal(r.data.op.state, "PENDING");
  assert.equal(chain.relays.length, 0);
  assert.equal((await sign("cara", op.id)).data.op.state, "EXECUTED");
});

// ── who signs ───────────────────────────────────────────────────────────────
await check("a payer, an admin and an owner not on chain cannot sign", async () => {
  reset();
  const op = queue();
  for (const [p, code] of [["payer", "NOT_A_SIGNER"], ["admin", "NOT_A_SIGNER"], ["dora", "NOT_ON_CHAIN_OWNER"]] as const) {
    const r = await sign(p, op.id);
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, code);
  }
  assert.equal(store.findSafeOp(op.id)!.signatures.length, 0);
});

await check("a deactivated owner cannot sign; another org's member gets a 404", async () => {
  reset();
  const op = queue();
  store.updateMember("m_cara", { status: "deactivated" } as any);
  try {
    assert.equal((await sign("cara", op.id)).status, 404, "resolveOrg hides the org from a deactivated member");
  } finally {
    store.updateMember("m_cara", { status: "active" } as any);
  }
  const other = await call("GET", `/orgs/org_2/safe-ops/${op.id}`, "u_anna");
  assert.equal(other.status, 404);
});

await check("an assertion over another challenge is refused and stores nothing", async () => {
  reset();
  const op = queue();
  const r = await sign("anna", op.id, Buffer.from(randomBytes(32)).toString("base64url"));
  assert.equal(r.status, 401);
  assert.equal(r.data.code, "BAD_ASSERTION");
  assert.equal(store.findSafeOp(op.id)!.signatures.length, 0);
});

await check("a duplicate signature is refused, also when sent twice at once", async () => {
  reset();
  chain.threshold = 3;
  const op = queue();
  assert.equal((await sign("anna", op.id)).status, 201);
  const again = await sign("anna", op.id);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "ALREADY_SIGNED");
  const [a, b] = await Promise.all([sign("bert", op.id), sign("bert", op.id)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(store.findSafeOp(op.id)!.signatures.length, 2);
});

// ── Q6: the owner set changes ───────────────────────────────────────────────
await check("Q6: a removed owner's signature is dropped and the op waits for a current owner", async () => {
  reset();
  const op = queue();
  await sign("anna", op.id);
  chain.owners = [addr.bert, addr.cara];
  const view = await call("GET", `/orgs/org_1/safe-ops/${op.id}`, "u_payer");
  assert.equal(view.data.op.state, "PENDING");
  assert.equal(view.data.op.signatures.length, 0);
  assert.deepEqual(view.data.op.dropped.map((d: any) => [d.memberId, d.reason]), [["m_anna", "no longer an owner of the Safe"]]);
  // Anna can no longer sign; Bert alone is below 2; Cara makes it.
  assert.equal((await sign("anna", op.id)).data.code, "NOT_ON_CHAIN_OWNER");
  assert.equal((await sign("bert", op.id)).data.op.state, "PENDING");
  assert.equal(chain.relays.length, 0);
  const done = await sign("cara", op.id);
  assert.equal(done.data.op.state, "EXECUTED");
  assert.deepEqual(chain.relays[0].signers, ["m_bert", "m_cara"]);
});

await check("Q6 at relay: an owner removed between signatures does not count", async () => {
  reset();
  const op = queue();
  await sign("anna", op.id);
  chain.owners = [addr.bert, addr.cara, addr.dora];
  const r = await sign("bert", op.id);
  assert.equal(r.data.op.state, "PENDING", "Anna's signature was dropped, so Bert's alone is one of two");
  assert.equal(chain.relays.length, 0);
});

// ── expiry and nonce ────────────────────────────────────────────────────────
await check("an expired op ends and takes no signature", async () => {
  reset();
  const op = queue("payer", 0n, { now: Date.now() - SAFE_OP_TTL_MS - 1000 });
  const r = await sign("anna", op.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "NOT_PENDING");
  assert.equal(store.findSafeOp(op.id)!.state, "EXPIRED");
});

await check("a stale nonce invalidates the op; a nonce ahead waits", async () => {
  reset();
  const stale = queue("payer", 0n);
  await sign("anna", stale.id);
  chain.nonce = 1n;
  const r = await sign("bert", stale.id);
  assert.equal(r.data.code, "NOT_PENDING");
  assert.equal(store.findSafeOp(stale.id)!.state, "INVALIDATED");
  assert.equal(chain.relays.length, 0);

  const ahead = queue("payer", 2n);
  await sign("anna", ahead.id);
  const b = await sign("bert", ahead.id);
  assert.equal(b.data.op.state, "PENDING", "threshold met but an earlier op must land first");
  assert.equal(chain.relays.length, 0);
  chain.nonce = 2n;
  assert.equal((await relayIfReady(store.findSafeOp(ahead.id)!, fakeChain)).state, "EXECUTED");
});

await check("an unreadable Safe state fails closed", () => {
  const op = queue();
  assert.throws(() => checkAgainstChain(op, { owners: [], threshold: 1, nonce: 0n }));
  assert.throws(() => checkAgainstChain(op, { owners: [addr.anna], threshold: 2, nonce: 0n }));
  assert.throws(() => checkAgainstChain(op, { owners: [addr.anna], threshold: 0, nonce: 0n }));
});

// ── relay outcomes ──────────────────────────────────────────────────────────
await check("relay outcomes: refusal and revert FAILED, no answer MANUAL_REVIEW", async () => {
  for (const [result, state] of [
    [() => { throw new BundlerRefusedError({ errno: -32500, message: "AA24 signature error" }); }, "FAILED"],
    [() => ({ userOpHash: "0x01", txHash: "0x02", success: false, gasPaidBy: "sponsored" }), "FAILED"],
    [() => { throw new SafeOperationUncertainError("0x" + "ee".repeat(32), "timeout"); }, "MANUAL_REVIEW"],
    [() => { throw new Error("socket hang up"); }, "MANUAL_REVIEW"],
  ] as const) {
    reset();
    chain.relayResult = result as any;
    const op = queue();
    await sign("anna", op.id);
    const r = await sign("bert", op.id);
    assert.equal(r.status, 502);
    assert.equal(r.data.op.state, state);
    assert.equal(store.findSafeOp(op.id)!.state, state);
    // A finished op never moves back.
    assert.equal(store.endPendingSafeOp(op.id, { state: "CANCELLED", reason: "x" }), null);
    assert.equal(store.claimSafeOpRelay(op.id), null);
    assert.throws(() => store.finishSafeOp(op.id, { state: "EXECUTED" }));
  }
});

await check("two owners meeting the threshold at once relay once", async () => {
  reset();
  chain.owners = [addr.anna, addr.bert];
  chain.threshold = 1;
  chain.relayDelay = 50;
  const op = queue();
  const [a, b] = await Promise.all([sign("anna", op.id), sign("bert", op.id)]);
  assert.equal(chain.relays.length, 1);
  assert.ok([a.status, b.status].includes(201));
  assert.equal(store.findSafeOp(op.id)!.state, "EXECUTED");
});

// ── cancel, projection, storage ─────────────────────────────────────────────
await check("cancel: the creator or an owner, never another payer or admin", async () => {
  reset();
  const op = queue("payer");
  assert.equal((await call("POST", `/orgs/org_1/safe-ops/${op.id}/cancel`, "u_admin")).status, 403);
  const ok = await call("POST", `/orgs/org_1/safe-ops/${op.id}/cancel`, "u_payer");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.op.state, "CANCELLED");
  assert.equal((await sign("anna", op.id)).data.code, "NOT_PENDING");
  const op2 = queue("admin");
  assert.equal((await call("POST", `/orgs/org_1/safe-ops/${op2.id}/cancel`, "u_cara")).data.op.state, "CANCELLED");
  assert.equal((await call("POST", `/orgs/org_1/safe-ops/${op2.id}/cancel`, "u_cara")).status, 409);
});

await check("the public op carries no assertion and no UserOperation", async () => {
  reset();
  chain.threshold = 3;
  const op = queue();
  await sign("anna", op.id);
  const list = await call("GET", "/orgs/org_1/safe-ops", "u_payer");
  const view = await call("GET", `/orgs/org_1/safe-ops/${op.id}`, "u_payer");
  for (const body of [JSON.stringify(list.data), JSON.stringify(view.data)]) {
    for (const leak of ["authenticatorData", "clientDataJSON", "userOperation", "passkeyPublicKey", '"signature"', "digest"]) {
      assert.ok(!body.includes(leak), `${leak} leaked`);
    }
  }
  assert.equal(view.data.challenge, challengeOf(op));
  assert.equal(view.data.signWith.credentialId, keys.payer.credentialId);
});

await check("the stored UserOperation round-trips its bigints", () => {
  const u = { nonce: 5n, callGasLimit: 2n ** 200n, sender: SAFE, nested: { x: [1n, "a"] } };
  assert.deepEqual(decodeUserOperation(encodeUserOperation(u)), u);
  const op = queue();
  assert.equal((decodeUserOperation(store.findSafeOp(op.id)!.userOperation) as any).callGasLimit, 123456789012345678901234567890n);
});

await check("the relay refuses an op that no longer hashes to the signed digest", async () => {
  const userOperation = {
    sender: SAFE, nonce: 0n, factory: null, factoryData: null, callData: "0x", callGasLimit: 1n, verificationGasLimit: 1n,
    preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymaster: null, paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null, paymasterData: null, signature: "0x",
  };
  await assert.rejects(
    submitMultiOwnerSafeOperation(SAFE, userOperation as any, `0x${"00".repeat(32)}`, []),
    /does not match the digest its owners signed/,
  );
});

await check("the personal path still refuses threshold > 1 on every passkey-alone op", () => {
  const src = readFileSync(new URL("../services/api/src/wallet/candide.ts", import.meta.url), "utf8");
  const core = src.slice(src.indexOf("async function prepareSafeExecutionCore"), src.indexOf("async function paidUserOperation"));
  const setup = src.slice(src.indexOf("export async function prepareSafeSetupOperation"), src.indexOf("export async function prepareTransferExecution"));
  assert.match(core, /await assertPasskeyAloneCanSign\(account\.accountAddress\)/);
  assert.match(setup, /await assertPasskeyAloneCanSign\(account\.accountAddress\)/);
  const multi = src.slice(src.indexOf("export async function prepareMultiOwnerSafeOperation"), src.indexOf("/** The bundler's answer"));
  assert.ok(!multi.includes("assertPasskeyAloneCanSign("), "only the org path skips it");
});

server.close();
console.log(`\nsafe-op-queue: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
