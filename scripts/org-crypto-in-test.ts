/**
 * Crypto in on a company's own Safe (routes/business/org-crypto-deposits.ts,
 * adapters/crypto-deposits.ts followCompanyConversions, settleCompanyArrival,
 * linkDepositInvoice; bookkeeping/writer.ts writeAccountStatementLines).
 *
 * Covers:
 *   - a company deposit tied to an invoice settles it on arrival, and a link
 *     made later settles it then; only this company's invoice, only with
 *     invoices.manage, and a settled payment does not move;
 *   - the list shows the company's deposits only, never a person's;
 *   - a conversion is queued on the org Safe queue (the payer queues and
 *     signs nothing), blocks a second one, and refuses with the queue off or
 *     without transfers.queue;
 *   - before a signature: an expired price or a deposit no longer waiting
 *     invalidates the op; a fresh one passes;
 *   - the op's outcome moves the deposit: executed → unconfirmed on the
 *     op's userOpHash, its transaction's EURe is conversion output, not
 *     money in; cancelled → held and convertible; failed after inclusion →
 *     refused and convertible;
 *   - the company's statement starts at the account's books date.
 *
 * Offline: the chain (owners, relay), the venue plan and the balance read are
 * fakes; measuring what a swap delivered is convert:test's and needs a chain.
 * Run: npm run org-crypto-in:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-crypto-in-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";
process.env.CANDIDE_RPC_URL = "http://127.0.0.1:9";
process.env.ORG_SAFE_QUEUE_ENABLED = "1";
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, KES: 147.53, INR: 109.87 });
process.env.ALLOW_FIXED_RATES = "1";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createOrgCryptoDepositRoutes, companyConversionSignRefusal, CONVERT_KIND } = await import("../services/api/src/routes/business/org-crypto-deposits.js");
const { followCompanyConversions, settleOnArrival, settleUnconfirmedConversions, companyDepositBlocker, companyConversionInFlight, valueUnratedReceipts } = await import("../services/api/src/adapters/crypto-deposits.js");
const { writeAccountStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { safeOperationDigest } = await import("../services/api/src/wallet/candide.js");
const { settlementRef } = await import("../services/api/src/domain/invoices.js");
const { passkeyOwnerAddressOfJwk } = await import("../services/api/src/wallet/safe-signers.js");
await initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

const now = new Date().toISOString();
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe" as const;
const OTHER_SAFE = "0x5afe00000000000000000000000000000000beef" as const;
const owner = { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32) };
const org = (id: string) => store.addOrganisation({ id, type: "business", entity: "company", name: id, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
await org("org_1");
await org("org_2");
const PLANNED = "2026-01-01T00:00:00.000Z";
await store.setOrgSafePlan("org_1", { kind: "org", status: "active", address: SAFE, owners: [owner], createdAt: PLANNED } as any);
await store.setOrgSafePlan("org_2", { kind: "org", status: "active", address: OTHER_SAFE, owners: [owner], createdAt: PLANNED } as any);
// The owner signs with a passkey that is the Safe's owner on chain.
const ownerKey = await makeSoftwarePasskey("owner", "http://localhost:3000");
const OWNER_ADDRESS = passkeyOwnerAddressOfJwk(ownerKey.jwk)!;
for (const [p, role] of [["owner", "owner"], ["payer", "payer"], ["acct", "accountant"], ["viewer", "viewer"]] as const) {
  await store.addUser({
    id: `u_${p}`, name: p, country: "DE", kycStatus: "approved", address: `0x${randomBytes(20).toString("hex")}`, createdAt: now,
    ...(p === "owner" ? { passkey: { credentialId: ownerKey.credentialId, publicKey: { alg: "ES256", jwk: ownerKey.jwk }, signCount: 0, rpId: "localhost", createdAt: now } } : {}),
  } as any);
  await store.addMember({ id: `m_${p}`, orgId: "org_1", userId: `u_${p}`, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
}
await store.addMember({ id: "m2_owner", orgId: "org_2", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
await store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: SAFE, createdAt: now, updatedAt: now } as any);
await store.addAccount({ id: "acc_2", orgId: "org_2", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address: OTHER_SAFE, createdAt: now, updatedAt: now } as any);

const invoice = async (id: string, orgId = "org_1", over: any = {}) => store.addInvoice({
  id, orgId, direction: "outgoing", state: "SUBMITTED", linkTokenHash: randomBytes(16).toString("hex"),
  lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", amount: "100.00" }],
  currency: "EUR", total: "100.00", createdByMemberId: "m_owner", createdAt: now, updatedAt: now,
  issued: { number: `RE-${id}`, issueDate: now.slice(0, 10), netCents: 10000, vatCents: 0, grossCents: 10000, currency: "EUR" },
  ...over,
} as any);
let seq = 0;
const deposit = async (over: any = {}) => {
  const d: any = {
    id: `d-${++seq}`, accountId: "acc_1", chainId: 31337, token: "USDC",
    txHash: "0x" + String(seq).padStart(64, "b"), logIndex: 0, from: "0x" + "77".repeat(20),
    amountUnits: "100000000", amountUsdc: 100, txs: [],
    receipt: { amountEur: 87.88, rate: 1.1379, rateAsOf: now.slice(0, 10), blockTimestamp: now },
    amountEur: 87.88, arrivedAt: now,
    detectedAt: now, updatedAt: now, ...over,
  };
  await store.addCryptoDeposit(d);
  return (await settleOnArrival(d));
};
const row = async (id: string) => (await store.list("cryptoDeposits")).find((d) => d.id === id)!;
const paidBy = async (invoiceId: string, depositId: string) =>
  ((await store.findInvoice(invoiceId))!.settlements ?? []).some((s: any) => settlementRef(s) === `deposit:${depositId}`);

// ── the routes, with the chain and venue played ─────────────────────────────
const fakeReader = { read: async () => ({ owners: [OWNER_ADDRESS], threshold: 1, nonce: 0n }) } as any;
const signers: any[] = [];
let nonce = 0n;
const prepareOrg = async (plan: any, _txs: any, s: any[]) => {
  signers.push(s);
  const userOperation: any = {
    sender: plan.address, nonce, factory: null, factoryData: null, callData: `0x${randomBytes(8).toString("hex")}`, callGasLimit: 1n,
    verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymaster: null,
    paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null, signature: "0x",
  };
  return { challenge: safeOperationDigest(plan.address, userOperation), userOperation, nonce: nonce++ } as any;
};
const swaps: { safe: string; units: bigint }[] = [];
let makerExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
const swapPlan = async (safe: `0x${string}`, units: bigint) => {
  swaps.push({ safe, units });
  return {
    plan: {
      approval: { spender: "0x" + "5e".repeat(20), amount: units },
      call: { to: "0x" + "5e".repeat(20), data: "0x1234", value: 0n },
      quote: { provider: "dex", rate: 1137900n, expectedOut: 87_80n * 10n ** 16n, minOut: 87_00n * 10n ** 16n, expiresAt: makerExpiry },
    },
    serialized: {},
  } as any;
};
const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgCryptoDepositRoutes(
  { ctxOf: async (req: any, res: any) => await resolveOrg(req, res, requireSession as any) },
  { reader: fakeReader, prepareOrg, swapPlan, heldBlocker: async () => null, usdc: () => "0x" + "0c".repeat(20) as `0x${string}` },
));
app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String((err as Error)?.stack ?? err) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

try {
  console.log("\nSettled against the company's invoice");

  await check("a company deposit tied to its invoice settles it on arrival", async () => {
    await invoice("inv_a");
    const d = await deposit({ invoiceId: "inv_a" });
    assert.equal(d.holding, "held", "USDC is held until the owners convert it");
    assert.ok(await paidBy("inv_a", d.id), "the invoice carries the payment");
  });

  await check("a link made later settles then; only this company's invoice, only with invoices.manage, and once", async () => {
    await invoice("inv_b");
    await invoice("inv_c");
    await invoice("inv_other", "org_2");
    const d = await deposit();
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/invoice`, "u_acct", { invoiceId: "inv_b" })).status, 403, "an accountant does not manage invoices");
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/invoice`, "u_payer", { invoiceId: "inv_other" })).status, 404, "another company's invoice is not found");
    const ok = await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/invoice`, "u_payer", { invoiceId: "inv_b" });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(await paidBy("inv_b", d.id));
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/invoice`, "u_payer", { invoiceId: "inv_c" })).status, 409, "a recorded payment does not move");
    assert.equal((await call("POST", `/orgs/org_2/crypto-deposits/${d.id}/invoice`, "u_owner", { invoiceId: "inv_other" })).status, 404, "another company cannot reach this deposit");
  });

  await check("the list shows this company's deposits, never a person's or another company's", async () => {
    await store.addCryptoDeposit({ id: "d-person", userId: "u_owner", chainId: 31337, token: "USDC", txHash: "0x" + "f".repeat(64), logIndex: 0, amountUnits: "1", amountUsdc: 1, txs: [], detectedAt: now, updatedAt: now } as any);
    await deposit({ accountId: "acc_2" });
    const r = await call("GET", "/orgs/org_1/crypto-deposits", "u_viewer");
    assert.equal(r.status, 200);
    assert.equal(r.data.deposits.length, 2);
    assert.ok(r.data.deposits.every((d: any) => d.accountId === "acc_1" && !d.userId));
    assert.ok(r.data.deposits.every((d: any) => "convertBlocker" in d));
    assert.ok(r.data.deposits.every((d: any) => !("conversionIntent" in d)), "the signed quote stays on the server");
  });

  console.log("\nConverted by an op the owners sign");

  let queued = { depositId: "", opId: "" };
  await check("the payer queues the conversion on the org Safe queue and signs nothing", async () => {
    const d = await deposit();
    const r = await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/convert`, "u_payer");
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const op = (await store.findSafeOp(r.data.opId))!;
    assert.equal(op.kind, CONVERT_KIND);
    assert.equal(op.safeAddress, SAFE);
    assert.deepEqual(op.signatures, [], "nobody's signature comes with it");
    assert.deepEqual(swaps.at(-1), { safe: SAFE, units: 100_000_000n }, "the swap runs from and back into the company's Safe");
    const after = await row(d.id);
    assert.equal(after.conversionIntent?.safeOpId, op.id);
    assert.equal(after.conversionIntent?.quote.minOut, (87_00n * 10n ** 16n).toString());
    assert.match(companyDepositBlocker(after)!, /waiting for the company's owners/);
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/convert`, "u_payer")).status, 409, "no second conversion while one waits");
    queued = { depositId: d.id, opId: op.id };
  });

  await check("no conversion without transfers.queue, or with the queue off, or below the floor", async () => {
    const d = await deposit();
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/convert`, "u_acct")).status, 403);
    process.env.ORG_SAFE_QUEUE_ENABLED = "";
    const off = await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/convert`, "u_payer");
    process.env.ORG_SAFE_QUEUE_ENABLED = "1";
    assert.equal(off.data.code, "ORG_SAFE_QUEUE_OFF");
    const tiny = await deposit({ amountUnits: "1", amountUsdc: 0.000001 });
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${tiny.id}/convert`, "u_payer")).status, 409);
    const eure = await deposit({ token: "EURE", amountUnits: (10n ** 18n).toString(), amountEur: 1 });
    assert.equal((await call("POST", `/orgs/org_1/crypto-deposits/${eure.id}/convert`, "u_payer")).status, 409, "EURe has nothing to convert");
  });

  await check("before a signature: a fresh price passes; an expired one, or a deposit no longer waiting, invalidates", async () => {
    const op = (await store.findSafeOp(queued.opId))!;
    assert.equal(await companyConversionSignRefusal(op), undefined);
    const late = await companyConversionSignRefusal(op, Date.now() + 11 * 60_000);
    assert.equal(late?.code, "QUOTE_EXPIRED");
    assert.ok(late?.invalidate);
    const maker = await companyConversionSignRefusal(op, Date.now() + 6 * 60_000);
    assert.equal(maker?.code, "QUOTE_EXPIRED", "the maker's own expiry wins when it is sooner");
    const stray = await companyConversionSignRefusal({ ...op, id: "sop_unknown" });
    assert.equal(stray?.code, "DEPOSIT_MISSING");
    assert.ok(stray?.invalidate);
    assert.equal(await companyConversionSignRefusal({ ...op, kind: "crypto-send" }), undefined, "other kinds are not this check's");
  });

  await check("executed: parked on the op's userOpHash, and its transaction's EURe is conversion output, not money in", async () => {
    const userOpHash = `0x${"ab".repeat(32)}`;
    const txHash = `0x${"cd".repeat(32)}`;
    assert.equal(await companyConversionInFlight("acc_1", txHash), false, "queued, nothing sent: no EURe waits");
    assert.ok(await store.claimSafeOpRelay(queued.opId));
    assert.equal(await companyConversionInFlight("acc_1", `0x${"99".repeat(32)}`), true, "relaying, its transaction unknown: any EURe to the Safe waits");
    assert.equal(await companyConversionInFlight("acc_2", txHash), false, "another company's Safe does not wait");
    await store.finishSafeOp(queued.opId, { state: "EXECUTED", userOpHash, txHash });
    assert.equal(await followCompanyConversions(), 1);
    const d = await row(queued.depositId);
    assert.equal(d.holding, "unconfirmed");
    assert.ok(d.txs.some((t) => t.step === "safe.swap(usdc->eure).unconfirmed" && t.hash === userOpHash));
    assert.equal(d.conversionIntent?.txHash, txHash, "the intent stays for the settle, with its transaction");
    assert.equal(await companyConversionInFlight("acc_1", txHash), true, "followed, not settled: its transaction's EURe waits for the settle to name the output");
    assert.equal(await companyConversionInFlight("acc_1", `0x${"99".repeat(32)}`), false, "EURe in any other transaction is money in");
    assert.equal(await followCompanyConversions(), 0, "followed once");
    // The settle is the person's code: no receipt yet leaves the row as it is.
    await settleUnconfirmedConversions(async () => null as any);
    assert.equal((await row(queued.depositId)).holding, "unconfirmed");
    // A restart after settling wrote the swap step (output named) but before
    // it finished: the row stays for review, and the scan goes on.
    const parked = await row(queued.depositId);
    await store.updateCryptoDeposit(queued.depositId, {
      txs: [...parked.txs.filter((t) => t.step !== "safe.swap(usdc->eure).unconfirmed"), { step: "safe.swap(usdc->eure)", hash: txHash, outputLogIndexes: [2] }],
    });
    assert.equal(await companyConversionInFlight("acc_1", txHash), false, "an interrupted settle does not hold the scan for good");
    await store.updateCryptoDeposit(queued.depositId, { txs: parked.txs });
    assert.equal(await companyConversionInFlight("acc_1", txHash, Date.now(), await store.list("cryptoDeposits")), true, "a preloaded list answers the same");
    // Included but reverted: held for review, and it delivered nothing to wait for.
    await settleUnconfirmedConversions(async () => ({ success: false, txHash }) as any);
    assert.equal(await companyConversionInFlight("acc_1", txHash), false);
  });

  await check("a relay cut off by a restart stops holding the scan after a bound", async () => {
    const d = await deposit();
    const q = await call("POST", `/orgs/org_1/crypto-deposits/${d.id}/convert`, "u_payer");
    assert.ok(await store.claimSafeOpRelay(q.data.opId));
    assert.equal(await companyConversionInFlight("acc_1", `0x${"98".repeat(32)}`), true);
    assert.equal(await companyConversionInFlight("acc_1", `0x${"98".repeat(32)}`, Date.now() + 16 * 60_000), false);
    await store.finishSafeOp(q.data.opId, { state: "FAILED", reason: "test" });
    await followCompanyConversions();
  });

  await check("withdrawn: held and convertible again; failed after inclusion: refused and convertible again", async () => {
    const a = await deposit();
    const qa = await call("POST", `/orgs/org_1/crypto-deposits/${a.id}/convert`, "u_payer");
    await store.endPendingSafeOp(qa.data.opId, { state: "CANCELLED", reason: "withdrawn" });
    const b = await deposit();
    const qb = await call("POST", `/orgs/org_1/crypto-deposits/${b.id}/convert`, "u_payer");
    assert.ok(await store.claimSafeOpRelay(qb.data.opId));
    await store.finishSafeOp(qb.data.opId, { state: "FAILED", reason: "the Safe call reverted", txHash: `0x${"ee".repeat(32)}` });
    assert.equal(await followCompanyConversions(), 2);
    const ra = await row(a.id);
    assert.equal(ra.holding, "held");
    assert.equal(ra.conversionIntent, undefined);
    assert.equal(companyDepositBlocker(ra), null);
    const rb = await row(b.id);
    assert.equal(rb.holding, "refused");
    assert.ok(rb.txs.some((t) => t.step === "safe.swap(usdc->eure).reverted"));
    assert.equal(companyDepositBlocker(rb), null, "nothing was swapped, so it may be converted again");
  });

  console.log("\nThe company's books");

  await check("EURe tied to an invoice is booked as that invoice's payment", async () => {
    await invoice("inv_e", "org_2");
    const e = await deposit({ accountId: "acc_2", token: "EURE", amountUnits: (50n * 10n ** 18n).toString(), amountUsdc: undefined, amountEur: 50, receipt: undefined, invoiceId: "inv_e" });
    await writeAccountStatementLines((await store.findAccount("acc_2"))!);
    const line = (await store.ledgerOf("org_2")).find((x) => x.statement?.links.depositId === e.id);
    assert.equal(line?.statement?.links.invoiceId, "inv_e");
    assert.equal((line as any)?.txType, "invoice_payment");
  });

  await check("a deposit valued late rewrites the invoice payment it settled at no value", async () => {
    await invoice("inv_v");
    const d = await deposit({ receipt: undefined, amountEur: undefined, invoiceId: "inv_v" });
    const before = ((await store.findInvoice("inv_v"))!.settlements ?? []).find((x: any) => settlementRef(x) === `deposit:${d.id}`) as any;
    assert.ok(before, "settled on arrival");
    assert.ok((await valueUnratedReceipts()) >= 1, "valued at the day's fixing");
    const after = ((await store.findInvoice("inv_v"))!.settlements ?? []).filter((x: any) => settlementRef(x) === `deposit:${d.id}`) as any[];
    assert.equal(after.length, 1, "rewritten under the same ref, never a second payment");
    assert.notDeepEqual(after[0], before, "the payment now carries the receipt value");
  });

  await check("the statement takes the company's deposits from the books date on", async () => {
    await store.updateAccount("acc_2", { backedSince: "2026-06-01T00:00:00.000Z" });
    const early = "2026-05-01T10:00:00.000Z";
    const before = await deposit({ accountId: "acc_2", arrivedAt: early, detectedAt: early, receipt: { amountEur: 87.88, rate: 1.1379, rateAsOf: "2026-05-01", blockTimestamp: early } });
    const after = await deposit({ accountId: "acc_2" });
    await writeAccountStatementLines((await store.findAccount("acc_2"))!);
    const lines = (await store.ledgerOf("org_2")).filter((e) => e.statement?.links.depositId);
    assert.ok(lines.some((e) => e.statement!.links.depositId === after.id), "the deposit after the start is booked");
    assert.ok(!lines.some((e) => e.statement!.links.depositId === before.id), "money before the start is not this account's");
  });
} finally {
  server.close();
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
