/**
 * Statement lines — the ledger writer, offline.
 *
 * The projection is pure, so it is checked against fixtures: one euro line
 * per economic event (SEPA in, SEPA out plus fee, a failed payout and its
 * reversal, a USDC deposit converted, one held, the monthly sweep), stable
 * keys, and no line for a receipt nobody could value. Then the writer
 * against a real store: a re-run adds nothing, a fact that changed is
 * refreshed, and an account code a human set survives both.
 *
 * Run: npm run statement:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-statement-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { lineId, linesInMonth, mergeStatementLines, projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
type Inputs = import("../services/api/src/bookkeeping/statement.js").StatementInputs;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; });
};

const SAFE = `0x${"aa".repeat(20)}` as `0x${string}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const base = (): Inputs => ({
  orgId: "org_1",
  accountId: "acc_1",
  userId: "u_1",
  safeAddress: SAFE,
  transfers: [],
  deposits: [],
  issueOrders: [],
  sweeps: [],
  invoices: [],
  paymentRequests: [],
  swapsHaveExecuted: false,
});

const req = (over: any = {}) => ({
  id: "pr_1", code: "ABCDEFGHJKMNPQR", userId: "u_1", handle: "zold", amountEur: 119, currency: "EUR" as const,
  methods: ["crypto", "bank"] as ("crypto" | "bank")[], state: "PAID" as const, cryptoQuotes: [], payments: [],
  source: { kind: "app" as const }, expiresAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  externalInvoiceNumber: "RE-2026-0042",
  ...over,
});

console.log("\nProjection");

await check("a processed issue order is one SEPA-in line with the bank facts and the invoice number from the memo's pay-link", () => {
  const inp = base();
  inp.paymentRequests = [req()];
  inp.issueOrders = [{ orderId: "ord-1", userId: "u_1", amountEur: 119, counterpartyName: "Kunde AG", counterpartyIban: "DE89370400440532013000", memo: "ABCDE-FGHJK-MNPQR Rechnung", processedAt: "2026-09-03T09:00:00.000Z", recordedAt: "2026-09-03T09:05:00.000Z" }];
  inp.deposits = [{ id: "d-mint", userId: "u_1", chainId: 31337, token: "EURE", txHash: H(1), logIndex: 0, amountUnits: "119000000000000000000", from: `0x${"00".repeat(20)}` as any, amountEur: 119, creditedEur: 119, state: "CONVERTED", settlementAsset: "EURE", txs: [], detectedAt: "2026-09-03T09:01:00.000Z", updatedAt: "2026-09-03T09:01:00.000Z" }];
  const lines = projectStatementLines(inp, "2026-09-26T00:00:00.000Z");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  const s = lines[0].statement!;
  assert.equal(s.event, "sepa_in");
  assert.equal(s.key, "monerium:issue:ord-1");
  assert.equal(s.amountCents, 11900);
  assert.equal(lines[0].direction, "in");
  assert.equal(lines[0].amount, "119.00");
  assert.equal(s.counterparty.iban, "DE89370400440532013000");
  assert.equal(s.reference, "RE-2026-0042", "the external invoice number is the reference");
  assert.equal(s.links.invoiceNumber, "RE-2026-0042");
  assert.equal(s.links.paymentRequestId, "pr_1");
  assert.deepEqual(s.links.txHashes, [H(1)], "the mint transaction is linked, not a second line");
  assert.equal(s.bookingDate, "2026-09-03");
  assert.equal(lines[0].id, lineId("org_1", "monerium:issue:ord-1"));
});

await check("a PAID SEPA payout is a debit line plus a fee line when a fee was taken", () => {
  const inp = base();
  inp.transfers = [{ id: "t-1", userId: "u_1", quoteId: "q", rail: "sepa", state: "PAID", sendEur: 50.99, receiveEur: 50, recipientName: "Vermieter GmbH", recipientIban: "DE02120300000000202051", reference: "Miete September", txs: [{ step: "safe.redeem", hash: H(2) }], sepa: { mode: "sandbox", orderId: "ord-r", state: "processed" }, createdAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" } as any];
  const lines = projectStatementLines(inp);
  assert.equal(lines.length, 2);
  const [payout, fee] = lines.map((l) => l.statement!).sort((a, b) => a.amountCents - b.amountCents);
  assert.equal(payout.amountCents, -5000);
  assert.equal(payout.key, "transfer:t-1:payout");
  assert.equal(payout.reference, "Miete September");
  assert.equal(payout.links.orderId, "ord-r");
  assert.equal(fee.amountCents, -99);
  assert.equal(fee.key, "transfer:t-1:fee");
  assert.equal(fee.counterparty.name, "Zold");
});

await check("a CREATED or DEBITED transfer produces no line — money that has not left is not a movement", () => {
  const inp = base();
  inp.transfers = [
    { id: "t-c", userId: "u_1", quoteId: "q", rail: "sepa", state: "CREATED", sendEur: 10, recipientName: "X", txs: [], createdAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T08:00:00.000Z" } as any,
    { id: "t-d", userId: "u_1", quoteId: "q", rail: "sepa", state: "DEBITED", sendEur: 10, recipientName: "X", txs: [], createdAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T08:00:00.000Z" } as any,
  ];
  assert.equal(projectStatementLines(inp).length, 0);
});

await check("a REFUNDED transfer is a debit and a reversal, with the deduction visible between them", () => {
  const inp = base();
  inp.transfers = [{ id: "t-r", userId: "u_1", quoteId: "q", rail: "sepa", state: "REFUNDED", sendEur: 40, recipientName: "Someone", recipientIban: "DE02120300000000202051", txs: [{ step: "safe.debit", hash: H(3) }, { step: "safe.refundTransfer", hash: H(4) }], error: "venue refused", refund: { amountEur: 39.5, recoveredFrom: "Safe-funded EURe", deductions: "€0.50 gas", at: "2026-09-07T12:00:00.000Z" }, auth: { authorizedAt: "2026-09-07T11:00:00.000Z" }, createdAt: "2026-09-07T10:00:00.000Z", updatedAt: "2026-09-07T12:00:00.000Z" } as any];
  const lines = projectStatementLines(inp);
  assert.equal(lines.length, 2);
  const debit = lines.find((l) => l.statement!.key === "transfer:t-r:debit")!.statement!;
  const refund = lines.find((l) => l.statement!.key === "transfer:t-r:refund")!.statement!;
  assert.equal(debit.amountCents, -4000);
  assert.equal(debit.valueDate, "2026-09-07");
  assert.deepEqual(debit.links.txHashes, [H(3)]);
  assert.equal(refund.event, "sepa_out_reversal");
  assert.equal(refund.amountCents, 3950);
  assert.deepEqual(refund.links.txHashes, [H(4)]);
  assert.equal(debit.amountCents + refund.amountCents, -50, "the deduction is the net of the two lines");
});

const usdcDeposit = (over: any = {}) => ({
  id: "d-1", userId: "u_1", chainId: 31337, token: "USDC", txHash: H(5), logIndex: 3, amountUnits: "137000000", amountUsdc: 137, from: `0x${"bb".repeat(20)}`,
  receipt: { amountEur: 120.14, rate: 1.1403, rateProvider: "ecb via api.frankfurter.dev", rateAsOf: "2026-09-10", ratedAt: "2026-09-10T10:00:00.000Z", blockTimestamp: "2026-09-10T09:58:00.000Z" },
  state: "CONVERTED", settlementAsset: "EURE", creditedEur: 119.62, provider: "dex", rate: 1.1452, midRate: 1.1403, realisedGainEur: -0.52,
  conversion: { userOpHash: H(6), txHash: H(7), blockNumber: 12, at: "2026-09-10T10:02:00.000Z", amountInUnits: "137000000", gasCostWei: "1200", gasPaidBy: "sponsored" },
  paymentRequestId: "pr_1",
  txs: [{ step: "safe.swap(usdc->eure)", hash: H(7) }, { step: "userOperation", hash: H(6) }],
  detectedAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:02:30.000Z",
  ...over,
});

await check("a converted USDC deposit is one line at the credited euro amount, dated by the chain, labelled unexecuted while no swap has moved real money", () => {
  const inp = base();
  inp.paymentRequests = [req()];
  inp.deposits = [usdcDeposit() as any];
  const lines = projectStatementLines(inp);
  assert.equal(lines.length, 1);
  const s = lines[0].statement!;
  assert.equal(s.event, "crypto_converted");
  assert.equal(s.amountCents, 11962, "credited, not the receipt value and not the quote");
  assert.equal(s.bookingDate, "2026-09-10");
  assert.equal(s.valueDate, "2026-09-10");
  assert.equal(lines[0].at, "2026-09-10T10:02:00.000Z", "value date is the conversion's block time");
  assert.equal(s.reference, "RE-2026-0042");
  assert.deepEqual(s.links.txHashes, [H(5), H(7)], "receipt tx first, then the conversion's chain tx — never only the userOp hash");
  assert.equal(s.links.userOpHash, H(6));
  assert.equal(s.counterparty.address, `0x${"bb".repeat(20)}`);
  assert.equal(s.unexecuted, true);
  inp.swapsHaveExecuted = true;
  assert.equal(projectStatementLines(inp)[0].statement!.unexecuted, undefined);
});

await check("a USDC deposit held unconverted is a line at its ECB value on receipt; with no rate there is NO line", () => {
  const inp = base();
  inp.deposits = [usdcDeposit({ id: "d-h", settlementAsset: "USDC", creditedEur: undefined, creditedUsdc: 137, conversion: undefined, provider: undefined, rate: undefined, txs: [] }) as any];
  const lines = projectStatementLines(inp);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].statement!.event, "crypto_held");
  assert.equal(lines[0].statement!.amountCents, 12014);
  assert.match(lines[0].note!, /ECB reference rate of 2026-09-10/);
  inp.deposits = [usdcDeposit({ id: "d-nr", settlementAsset: "USDC", creditedEur: undefined, receipt: undefined, conversion: undefined, txs: [] }) as any];
  assert.equal(projectStatementLines(inp).length, 0, "no rate, no value, no line");
});

await check("a sweep is one Kursdifferenz / Restbeträge line for the month", () => {
  const inp = base();
  inp.sweeps = [{ id: "sw-1", userId: "u_1", month: "2026-09", depositIds: ["d-1", "d-2"], amountInUnits: "2310000", creditedEur: 2.01, provider: "dex", rate: 1.149, conversion: { txHash: H(9), at: "2026-10-01T06:00:00.000Z" }, txs: [], at: "2026-10-01T06:01:00.000Z" }];
  const lines = projectStatementLines(inp);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].statement!.event, "sweep");
  assert.equal(lines[0].statement!.reference, "Kursdifferenz / Restbeträge 2026-09");
  assert.equal(lines[0].statement!.amountCents, 201);
  assert.equal(lines[0].txType, "realised_gain");
});

await check("another user's records never leak into this account's lines", () => {
  const inp = base();
  inp.deposits = [usdcDeposit({ userId: "u_2" }) as any];
  inp.issueOrders = [{ orderId: "o-x", userId: "u_2", amountEur: 5, processedAt: "2026-09-03T09:00:00.000Z", recordedAt: "2026-09-03T09:00:00.000Z" }];
  assert.equal(projectStatementLines(inp).length, 0);
});

await check("the projection is deterministic and month filtering goes by value date", () => {
  const inp = base();
  inp.deposits = [usdcDeposit() as any];
  inp.issueOrders = [{ orderId: "o-1", userId: "u_1", amountEur: 5, processedAt: "2026-08-31T23:00:00.000Z", recordedAt: "2026-09-01T00:00:00.000Z" }];
  const a = projectStatementLines(inp, "x");
  const b = projectStatementLines(inp, "x");
  assert.deepEqual(a, b);
  assert.deepEqual(linesInMonth(a, "2026-09").map((l) => l.statement!.key), ["deposit:d-1:converted"]);
  assert.deepEqual(linesInMonth(a, "2026-08").map((l) => l.statement!.key), ["monerium:issue:o-1"]);
});

console.log("\nMerge (idempotency)");

await check("merging a projection into itself changes nothing; a changed fact is refreshed; a human's account code is kept", () => {
  const inp = base();
  inp.deposits = [usdcDeposit({ conversion: undefined, txs: [{ step: "safe.swap(usdc->eure)", hash: "0xmock-user-op-hash" }] }) as any];
  const first = projectStatementLines(inp);
  const same = mergeStatementLines(first, projectStatementLines(inp));
  assert.equal(same.toAdd.length, 0);
  assert.equal(same.toUpdate.length, 0);
  const existing = first.map((e) => ({ ...e, accountCode: "4000", accountCodeAuto: false, statement: { ...e.statement!, documentCode: "ABCDEFGHJKMNPQR" } }));
  inp.deposits = [usdcDeposit() as any]; // the bundler receipt arrived: a real tx hash
  const { toAdd, toUpdate } = mergeStatementLines(existing, projectStatementLines(inp));
  assert.equal(toAdd.length, 0);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].patch.accountCode, undefined, "the patch never touches the account code");
  assert.deepEqual(toUpdate[0].patch.statement!.links.txHashes, [H(5), H(7)]);
  assert.equal(toUpdate[0].patch.statement!.documentCode, "ABCDEFGHJKMNPQR", "the Beleg code survives a refresh");
});

console.log("\nWriter against the store");

const { initStore, store } = await import("../services/api/src/store.js");
const { writeStatementLines, writeStatementLinesFor, booksFor, noteMoneriumIssue } = await import("../services/api/src/bookkeeping/writer.js");
initStore();
const now = new Date().toISOString();
const user: any = { id: "u_1", name: "Zoldenburg UG", country: "DE", kycStatus: "approved", address: SAFE, createdAt: now, passkey: { credentialId: "c" }, passkeySafe: { status: "active", address: SAFE } };
store.addUser(user);
store.addUser({ ...user, id: "u_orphan", address: `0x${"cc".repeat(20)}` });
store.addOrganisation({ id: "org_1", type: "business", name: "Zoldenburg UG", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now });
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: { iban: "EE382200221020145685" }, address: SAFE, backingUserId: "u_1", createdAt: now, updatedAt: now });
store.addCryptoDeposit(usdcDeposit({ paymentRequestId: undefined }) as any);

await check("the writer maps a user to the org whose EUR account their Safe backs; a user with none writes nothing", () => {
  assert.deepEqual(booksFor("u_1"), { orgId: "org_1", accountId: "acc_1" });
  assert.equal(booksFor("u_orphan"), undefined);
  assert.deepEqual(writeStatementLinesFor(store.findUser("u_orphan")!), { added: 0, updated: 0 });
});

await check("first run writes the line with a rule-mapped code; a second run adds nothing", () => {
  const r1 = writeStatementLines();
  assert.equal(r1.added, 1);
  const row = store.ledgerOf("org_1")[0];
  assert.equal(row.statement!.key, "deposit:d-1:converted");
  assert.equal(row.accountCodeAuto, true, "a default rule mapped it");
  assert.ok(row.accountCode, "invoice_payment maps to a default account");
  const r2 = writeStatementLines();
  assert.deepEqual(r2, { added: 0, updated: 0 });
  assert.equal(store.ledgerOf("org_1").length, 1);
});

await check("a human's account code survives a later fact change; the Monerium issue snapshot is recorded once", () => {
  const row = store.ledgerOf("org_1")[0];
  store.updateLedgerEntry(row.id, { accountCode: "4100", accountCodeAuto: false });
  const rec = noteMoneriumIssue({ id: "ord-9", kind: "issue", amount: "20.00", address: SAFE, memo: "hello", meta: { state: "processed", processedAt: "2026-09-12T08:00:00.000Z" }, counterpart: { identifier: { iban: "DE02120300000000202051" }, details: { name: "Kunde AG" } } }, user);
  assert.ok(rec);
  assert.equal(noteMoneriumIssue({ id: "ord-9", kind: "issue", amount: "999", address: SAFE, meta: { state: "processed" } }, user)!.amountEur, 20, "the first snapshot wins");
  const r = writeStatementLines();
  assert.equal(r.added, 1);
  const rows = store.ledgerOf("org_1");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((e) => e.statement!.key === "deposit:d-1:converted")!.accountCode, "4100");
  const sepa = rows.find((e) => e.statement!.key === "monerium:issue:ord-9")!;
  assert.equal(sepa.statement!.counterparty.iban, "DE02120300000000202051");
  assert.equal(sepa.amount, "20.00");
});

console.log(`\nstatement-lines: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
