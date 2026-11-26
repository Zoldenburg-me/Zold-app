/**
 * A company's crypto send through its org Safe queue (routes/business/drafts.ts
 * walletRun, routes/crypto-sends.ts createCompanyCryptoSendPreparer and
 * companySendSignRefusal, wallet/org-debit.ts).
 *
 * Covers:
 *   - a company's one-line wallet run is queued as an org Safe op, not refused
 *     for a missing backer, IBAN or Monerium profile; the payer queues it and
 *     cannot sign it, the owners sign it and it relays;
 *   - the signers the op is prepared for come from the chain's owners joined to
 *     the owner members: never the payer, never plan.owners alone; too few,
 *     and two members on one passkey, are refused with nothing created;
 *   - the send reads its state from its op: CREATED while queued, SENT once
 *     executed, FAILED on every other end (failed, cancelled, expired,
 *     invalidated), and the daily cap (keyed per org Safe) is given back on
 *     each of those ends and kept when executed;
 *   - a payee edit after queueing invalidates the op at the first signature;
 *   - an org Safe not deployed refuses before anything is created;
 *   - the personal route refuses a company Safe, and the company send is not
 *     signed at /crypto-sends/:id/authorize;
 *   - an executed send is booked on the company account's statement, never on
 *     the queuing member's own books;
 *   - a bank run from a company account with its IBAN issued is never built
 *     here as transfers: execute answers COMPANY_BANK_RUN_SIGN and names
 *     where an owner signs it (org-monerium-bank-runs:test covers the run).
 *
 * The sole-trader and personal paths are covered unchanged by
 * business-crypto-send:test and crypto-send:test.
 *
 * Offline: the chain (owners, threshold, nonce, relay) and the prepared
 * operation are fakes, the balance, rate, screen and token list are stubs
 * (no deployments.json needed), passkeys are software keys.
 * Run: npm run org-crypto-send:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-crypto-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";
process.env.ORG_SAFE_QUEUE_ENABLED = "1";
process.env.CRYPTO_SEND_ENABLED = "1";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { createSafeOpRoutes } = await import("../services/api/src/routes/business/safe-ops.js");
const { createCryptoSendsRouter, createCompanyCryptoSendPreparer, createCryptoSendPreparer, companySendSignRefusal } = await import("../services/api/src/routes/crypto-sends.js");
const { liveCryptoSend, orgSafeSpentEurToday } = await import("../services/api/src/wallet/org-debit.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
const { safeOperationDigest } = await import("../services/api/src/wallet/candide.js");
const { FX } = await import("../services/api/src/config.js");
const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
await initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

// ── a company with two owners, an admin and a payer ─────────────────────────
const ORIGIN = "http://localhost:3000";
const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const ALICE = "0x2222222222222222222222222222222222222222";
const MALLORY = "0x3333333333333333333333333333333333333333";
const people = ["anna", "bert", "cara", "admin", "payer"] as const;
const keys: Record<string, Awaited<ReturnType<typeof makeSoftwarePasskey>>> = {};
const addr: Record<string, `0x${string}`> = {};
const hex = (b64: string) => ("0x" + Buffer.from(b64, "base64url").toString("hex")) as `0x${string}`;
await store.addOrganisation({ id: "org_1", type: "business", entity: "company", name: "Acme GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
for (const p of people) {
  keys[p] = await makeSoftwarePasskey(p, ORIGIN);
  addr[p] = passkeyOwnerAddressOfJwk(keys[p].jwk)!;
  await store.addUser({
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved", address: `0x${randomBytes(20).toString("hex")}`,
    passkey: { credentialId: keys[p].credentialId, publicKey: { alg: "ES256", jwk: keys[p].jwk }, signCount: 0, rpId: "localhost", createdAt: now },
    createdAt: now,
  } as any);
  const role = p === "admin" ? "admin" : p === "payer" ? "payer" : "owner";
  // anna deployed the Safe: her signerAddress is her passkey's address.
  await store.addMember({ id: `m_${p}`, orgId: "org_1", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now, ...(p === "anna" ? { signerAddress: addr.anna } : {}) } as any);
}
const planOwners = [keys.anna, keys.bert].map((k) => ({ x: hex(k.jwk.x!), y: hex(k.jwk.y!) }));
await store.setOrgSafePlan("org_1", { kind: "org", status: "active", address: SAFE, owners: planOwners, createdAt: now } as any);
// No IBAN, no backer, no Monerium profile: only the org Safe.
await store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE, createdAt: now, updatedAt: now } as any);
await store.addContact({ id: "c_w", orgId: "org_1", name: "Alice Studio", wallets: [{ id: "cw_1", chainId: 31337, address: ALICE }], bankAccounts: [], createdAt: now, updatedAt: now } as any);
// A company whose Safe is planned, not deployed.
await store.addOrganisation({ id: "org_2", type: "business", entity: "company", name: "Later GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
const SAFE2 = "0x5afe00000000000000000000000000000000beef" as const;
await store.setOrgSafePlan("org_2", { kind: "org", status: "planned", address: SAFE2, owners: planOwners.slice(0, 1), createdAt: now } as any);
for (const p of ["anna", "admin", "payer"] as const) {
  await store.addMember({ id: `m2_${p}`, orgId: "org_2", userId: `u_${p}`, email: "", role: p === "anna" ? "owner" : p, status: "active", invitedAt: now, acceptedAt: now } as any);
}
await store.addAccount({ id: "acc_2", orgId: "org_2", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE2, createdAt: now, updatedAt: now } as any);
await store.addContact({ id: "c_w2", orgId: "org_2", name: "Alice Studio", wallets: [{ id: "cw_2", chainId: 31337, address: ALICE }], bankAccounts: [], createdAt: now, updatedAt: now } as any);

// ── the fake chain and prepare ──────────────────────────────────────────────
const chain = {
  owners: [addr.anna, addr.bert] as `0x${string}`[],
  threshold: 1,
  nonce: 0n,
  relays: [] as string[][],
  relayResult: (): any => ({ userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, success: true, gasPaidBy: "sponsored" }),
};
const fakeChain = {
  read: async () => ({ owners: [...chain.owners], threshold: chain.threshold, nonce: chain.nonce }),
  relay: async (_op: any, sigs: any[]) => { chain.relays.push(sigs.map((s) => s.memberId)); return chain.relayResult(); },
};
const prepares: { signers: string[] }[] = [];
const prepareOrg = async (plan: any, _txs: any, signers: any[]) => {
  prepares.push({ signers: signers.map((s) => `${s.x}:${s.y}`) });
  const userOperation: any = {
    sender: plan.address, nonce: chain.nonce, factory: null, factoryData: null, callData: `0x${randomBytes(8).toString("hex")}`, callGasLimit: 1n,
    verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymaster: null,
    paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null, signature: "0x",
  };
  return { challenge: safeOperationDigest(plan.address, userOperation), userOperation, nonce: chain.nonce } as any;
};
const keyOf = (p: string) => `${BigInt(hex(keys[p].jwk.x!))}:${BigInt(hex(keys[p].jwk.y!))}`;
const sanctioned = new Set<string>();
const stubs = {
  resolveName: async () => ({ ok: false as const, status: 400 as const, code: "BAD_NAME" as const, error: "no names here" }),
  balanceOf: async () => 1_000_000n * 10n ** 18n,
  usdPerEur: async () => 1.25,
  screen: async (a: string) => sanctioned.has(a.toLowerCase()),
  testUsdcAddress: () => undefined,
  sendTokens: () => ({ EURE: { address: "0xe0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0" as const, decimals: 18, label: "EURe" } }),
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
const deps = { ctxOf: async (req: any, res: any) => await resolveOrg(req, res, requireSession as any) };
const noSepa = async () => { throw new Error("a wallet run builds no SEPA transfer"); };
const failPersonal = createCryptoSendPreparer({ ...stubs, prepare: async () => { throw new Error("a company run never prepares a personal op"); } });
app.use("/api/orgs", createDraftRoutes(deps, noSepa as any, async () => ({ safeBalanceEur: 1000 }) as any, failPersonal,
  createCompanyCryptoSendPreparer({ ...stubs, orgSafeReader: fakeChain, prepareOrg })));
app.use("/api/orgs", createSafeOpRoutes(deps, fakeChain as any, (op) => companySendSignRefusal(op, stubs.screen as any)));
app.use("/api", createCryptoSendsRouter({
  requireUserSession: async (req, res, userId) => (who(req) === userId ? { id: "s" } : (res.status(403).json({ error: "not yours" }), undefined)),
  ...stubs,
}));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const walletLine = (amount = "10", contactId = "c_w") => ({ contactId, destination: { kind: "wallet", chainId: 31337, address: ALICE, displayName: "Alice Studio" }, asset: "EURE", amount });
/** Drafted by the payer, approved by the admin. */
const approvedRun = async (amount = "10", org = "org_1") => {
  const d = await call("POST", `/orgs/${org}/drafts`, "u_payer", { source: { kind: "account", accountId: org === "org_1" ? "acc_1" : "acc_2" }, lines: [walletLine(amount, org === "org_1" ? "c_w" : "c_w2")] });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const id = d.data.draft.id as string;
  assert.equal((await call("POST", `/orgs/${org}/drafts/${id}/submit`, "u_payer")).status, 200);
  const r = await call("POST", `/orgs/${org}/drafts/${id}/review`, "u_admin", { approve: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id;
};
const queued = async (amount = "10") => {
  const id = await approvedRun(amount);
  const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_payer");
  assert.equal(x.status, 201, JSON.stringify(x.data));
  return { draftId: id, send: x.data.cryptoSends[0], op: x.data.safeOp, body: x.data };
};
const challengeOf = (op: { digest: string }) => Buffer.from(op.digest.slice(2), "hex").toString("base64url");
const sign = async (p: string, opId: string) => {
  const a = await keys[p].assert(challengeOf((await store.findSafeOp(opId))!));
  return call("POST", `/orgs/org_1/safe-ops/${opId}/signatures`, `u_${p}`, a);
};
const live = async (id: string) => await liveCryptoSend((await store.findCryptoSend(id))!);
const draftState = async (id: string) => (await call("GET", `/orgs/org_1/drafts/${id}`, "u_payer")).data.draft.state;
let sentId = "";
const reset = async () => {
  chain.owners = [addr.anna, addr.bert]; chain.threshold = 1; chain.nonce = 0n; chain.relays = [];
  chain.relayResult = () => ({ userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, success: true, gasPaidBy: "sponsored" });
  // Each op ends before the next is queued; the nonce moves on with it.
  for (const op of (await store.safeOpsOf("org_1"))) if (op.state === "PENDING") await store.endPendingSafeOp(op.id, { state: "CANCELLED", reason: "test reset" });
};

try {
  await check("a company wallet run is queued as an org Safe op, not refused for a missing IBAN or backer", async () => {
    await reset();
    prepares.length = 0;
    const { send, op, body, draftId } = await queued();
    assert.equal(send.state, "CREATED");
    assert.equal(send.safeOpId, op.id);
    assert.equal(op.kind, "crypto-send");
    assert.equal(op.state, "PENDING");
    assert.equal(body.cryptoSends[0].submitTo, undefined, "nobody signs it at /authorize");
    assert.match(body.note, /waiting for the owners/);
    const stored = (await store.findCryptoSend(send.cryptoSendId))!;
    assert.equal(stored.orgId, "org_1");
    assert.equal(stored.userId, "u_payer", "attribution only");
    assert.deepEqual(prepares[0].signers, [keyOf("anna")], "1-of-1: the deploying owner, never the payer");
    assert.equal(await draftState(draftId), "EXECUTING");
  });

  await check("the payer queues but cannot sign; an owner signs and the send reads SENT", async () => {
    await reset();
    const { send, op, draftId } = await queued();
    const p = await sign("payer", op.id);
    assert.equal(p.status, 403, JSON.stringify(p.data));
    assert.equal(chain.relays.length, 0);
    const a = await call("POST", `/crypto-sends/${send.cryptoSendId}/authorize`, "u_payer", {});
    assert.equal(a.status, 409);
    assert.equal(a.data.code, "COMPANY_SEND");
    const s = await sign("anna", op.id);
    assert.equal(s.status, 201, JSON.stringify(s.data));
    assert.equal(s.data.op.state, "EXECUTED");
    assert.equal((await live(send.cryptoSendId)).state, "SENT");
    assert.equal((await live(send.cryptoSendId)).txHash, `0x${"cd".repeat(32)}`);
    assert.equal(await draftState(draftId), "EXECUTED");
    sentId = send.cryptoSendId;
    chain.nonce = 1n;
  });

  await check("an executed send is booked on the company's statement, not the queuer's", async () => {
    // The payer also has books of their own: a personal account backed by their Safe.
    await store.addOrganisation({ id: "org_p", type: "personal", name: "payer", plan: "personal", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
    await store.addAccount({ id: "acc_p", orgId: "org_p", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, backingUserId: "u_payer", createdAt: now, updatedAt: now } as any);
    await writeStatementLines();
    const key = `cryptosend:${sentId}`;
    const line = (await store.ledgerOf("org_1")).find((e) => e.statement?.key === key);
    assert.ok(line, "the company's books carry the send");
    assert.equal(line!.direction, "out");
    assert.equal(Number(line!.amount), 10);
    assert.deepEqual(line!.source, { kind: "account", accountId: "acc_1" });
    assert.ok(!(await store.ledgerOf("org_p")).some((e) => e.statement?.key === key), "the queuer's books do not");
    // A queued send that has not executed is not booked yet.
    await reset();
    chain.nonce = 1n;
    const { send } = await queued();
    await writeStatementLines();
    assert.ok(!(await store.ledgerOf("org_1")).some((e) => e.statement?.key === `cryptosend:${send.cryptoSendId}`));
    await reset();
  });

  await check("signers come from the chain's owners, not plan.owners or the caller", async () => {
    await reset();
    prepares.length = 0;
    chain.nonce = 1n;
    // At 2-of-3 with cara added on chain only, the two owners named are anna
    // (the deployer) and the next chain owner with a passkey member.
    chain.owners = [addr.bert, addr.cara, addr.anna];
    chain.threshold = 2;
    const { op } = await queued();
    assert.deepEqual(prepares[0].signers, [keyOf("anna"), keyOf("bert")]);
    await store.endPendingSafeOp(op.id, { state: "CANCELLED", reason: "test" });
    // bert is on the plan but no longer on chain: at 2-of-2 there is one
    // member left to sign, so nothing is created.
    chain.owners = [addr.anna, `0x${"77".repeat(20)}`];
    const before = (await store.list("cryptoSends")).length;
    const id = await approvedRun();
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_payer");
    assert.equal(x.status, 409, JSON.stringify(x.data));
    assert.equal(x.data.code, "NOT_ENOUGH_SIGNERS");
    assert.equal((await store.list("cryptoSends")).length, before, "nothing created");
  });

  await check("two owner members on one passkey are refused as ambiguous", async () => {
    await reset();
    chain.nonce = 1n;
    await store.addMember({ id: "m_anna_twin", orgId: "org_1", userId: "u_anna", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
    try {
      const id = await approvedRun();
      const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_payer");
      assert.equal(x.status, 409, JSON.stringify(x.data));
      assert.equal(x.data.code, "AMBIGUOUS_SIGNER");
    } finally {
      await store.updateMember("m_anna_twin", { status: "deactivated" } as any);
    }
  });

  await check("every end but executed fails the send and gives the cap back; executed keeps it", async () => {
    await reset();
    chain.nonce = 1n;
    const spent = async () => await orgSafeSpentEurToday(SAFE);
    const base = await spent();
    const ends: [string, (opId: string) => Promise<void> | void][] = [
      ["CANCELLED", async (id) => { await store.endPendingSafeOp(id, { state: "CANCELLED", reason: "withdrawn" }); }],
      ["INVALIDATED", async (id) => { await store.endPendingSafeOp(id, { state: "INVALIDATED", reason: "nonce moved" }); }],
      ["EXPIRED", async (id) => { await store.endPendingSafeOp(id, { state: "EXPIRED", reason: "not enough owners signed in time" }); }],
      ["FAILED", async (id) => {
        chain.relayResult = () => ({ userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"ef".repeat(32)}`, success: false, gasPaidBy: "sponsored" });
        await sign("anna", id);
      }],
    ];
    for (const [state, end] of ends) {
      const { send, op, draftId } = await queued("7");
      assert.equal(await spent(), base + 7, `${state}: held while queued`);
      await end(op.id);
      assert.equal((await store.findSafeOp(op.id))!.state, state);
      assert.equal((await live(send.cryptoSendId)).state, "FAILED", state);
      assert.equal(await spent(), base, `${state}: the hold is given back`);
      assert.equal(await draftState(draftId), "FAILED", state);
      await reset();
      chain.nonce = 1n;
    }
    // A pending op past its expiry reads FAILED before anything ends it.
    const { send, op } = await queued("7");
    const expired = { ...(await store.findSafeOp(op.id))!, expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.equal((await liveCryptoSend((await store.findCryptoSend(send.cryptoSendId))!, Date.now())).state, "CREATED");
    const { orgOpOutcome } = await import("../services/api/src/wallet/org-debit.js");
    assert.equal(orgOpOutcome(expired).state, "FAILED");
    await reset();
    chain.nonce = 1n;
    const ok = await queued("7");
    await sign("anna", ok.op.id);
    assert.equal((await live(ok.send.cryptoSendId)).state, "SENT");
    assert.equal(await spent(), base + 7, "an executed send keeps counting");
    chain.nonce = 2n;
  });

  await check("the daily cap is the org Safe's, whoever queues", async () => {
    await reset();
    chain.nonce = 2n;
    const room = FX.DAILY_CAP_EUR - (await orgSafeSpentEurToday(SAFE));
    const id = await approvedRun(String(Math.floor(room) + 1));
    const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_payer");
    assert.equal(x.status, 409, JSON.stringify(x.data));
    assert.equal(x.data.code, "DAILY_CAP");
  });

  await check("a payee edit after queueing invalidates the op at the first signature", async () => {
    await reset();
    chain.nonce = 2n;
    const { send, op } = await queued();
    await store.updateContact("c_w", { wallets: [{ id: "cw_1", chainId: 31337, address: MALLORY as `0x${string}` }] });
    try {
      const s = await sign("anna", op.id);
      assert.equal(s.status, 409, JSON.stringify(s.data));
      assert.equal(s.data.code, "INVALID_DATA");
      assert.equal((await store.findSafeOp(op.id))!.state, "INVALIDATED");
      assert.equal((await live(send.cryptoSendId)).state, "FAILED");
      assert.equal(chain.relays.length, 0, "nothing relayed");
    } finally {
      await store.updateContact("c_w", { wallets: [{ id: "cw_1", chainId: 31337, address: ALICE as `0x${string}` }] });
    }
  });

  await check("a sanctioned address is refused at the signature and the op ends", async () => {
    await reset();
    chain.nonce = 2n;
    const { op } = await queued();
    sanctioned.add(ALICE.toLowerCase());
    try {
      const s = await sign("anna", op.id);
      assert.equal(s.status, 403, JSON.stringify(s.data));
      assert.equal(s.data.code, "SANCTIONED");
      assert.equal((await store.findSafeOp(op.id))!.state, "INVALIDATED");
    } finally {
      sanctioned.clear();
    }
  });

  await check("an org Safe that is not deployed refuses before anything is created", async () => {
    const before = (await store.list("cryptoSends")).length;
    const ops = (await store.safeOpsOf("org_2")).length;
    const id = await approvedRun("10", "org_2");
    const x = await call("POST", `/orgs/org_2/drafts/${id}/execute`, "u_payer");
    assert.equal(x.status, 409, JSON.stringify(x.data));
    assert.equal(x.data.code, "ORG_SAFE_NOT_DEPLOYED");
    assert.equal((await store.list("cryptoSends")).length, before);
    assert.equal((await store.safeOpsOf("org_2")).length, ops);
  });

  await check("a company bank run is never built as transfers: execute points to the owner's bank-run signature", async () => {
    await store.addContact({ id: "c_b", orgId: "org_1", name: "Bob GmbH", wallets: [], bankAccounts: [{ id: "cb_1", currency: "EUR", country: "DE", holderName: "Bob GmbH", iban: "DE89370400440532013000" }], createdAt: now, updatedAt: now } as any);
    await store.updateAccount("acc_1", { identifier: { iban: "DE02100100109307118603" } });
    try {
      const d = await call("POST", "/orgs/org_1/drafts", "u_payer", { source: { kind: "account", accountId: "acc_1" }, lines: [{ contactId: "c_b", destination: { kind: "bank", bankAccountId: "cb_1", displayName: "Bob GmbH" }, asset: "EUR", amount: "5" }] });
      assert.equal(d.status, 201, JSON.stringify(d.data));
      const id = d.data.draft.id as string;
      assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/submit`, "u_payer")).status, 200);
      assert.equal((await call("POST", `/orgs/org_1/drafts/${id}/review`, "u_admin", { approve: true })).status, 200);
      const ops = (await store.safeOpsOf("org_1")).length;
      const transfers = (await store.list("transfers")).length;
      // noSepa throws if a transfer were built: the refusal comes first.
      const x = await call("POST", `/orgs/org_1/drafts/${id}/execute`, "u_payer");
      assert.equal(x.status, 409, JSON.stringify(x.data));
      assert.equal(x.data.code, "COMPANY_BANK_RUN_SIGN");
      assert.equal(x.data.startTo, `/api/orgs/org_1/drafts/${id}/bank-run/start`);
      assert.equal((await store.safeOpsOf("org_1")).length, ops, "nothing queued");
      assert.equal((await store.list("transfers")).length, transfers, "no transfer");
    } finally {
      await store.updateAccount("acc_1", { identifier: {} });
    }
  });

  await check("the personal route refuses a company Safe", async () => {
    await store.addUser({
      id: "u_rogue", name: "Rogue", country: "DE", kycStatus: "approved", address: SAFE,
      wallet: { type: "candide-safe", deployed: true },
      passkey: { credentialId: keys.anna.credentialId, publicKey: { alg: "ES256", jwk: keys.anna.jwk }, signCount: 0, rpId: "localhost" },
      passkeySafe: { status: "active", address: SAFE, threshold: 1, importedAt: now, passkeyPublicKey: planOwners[0] },
      createdAt: now,
    } as any);
    const before = (await store.list("cryptoSends")).length;
    const r = await call("POST", "/users/u_rogue/crypto-sends", "u_rogue", { token: "EURE", amount: "1", to: ALICE, confirmedAddress: ALICE });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.code, "COMPANY_SAFE");
    assert.equal((await store.list("cryptoSends")).length, before);
  });
} finally {
  server.close();
}
console.log(`\norg-crypto-send: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
