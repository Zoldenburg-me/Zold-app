/**
 * A SEPA approval must reach Monerium inside the 5 minutes its docs allow the
 * signed message, and one that comes too late must stop before the fee debit
 * and leave the person able to start again.
 *
 * The real builder (at no fee, so no bundler; the balance read is stubbed), the
 * real transfer router, executor and read-time derivations on a temp store.
 * NOT PROVEN HERE: that Monerium refuses an older message (its docs say so; no
 * call is made).
 *
 *   npm run redeem-window:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import express from "express";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
process.env.SEPA_FEE_EUR = "0";
// A live deployment: without it the executor refuses for that reason first.
process.env.MONERIUM_CLIENT_ID = "redeem-window-client";
process.env.MONERIUM_CLIENT_SECRET = "redeem-window-secret";

const { initStore, store } = await import("../services/api/src/store.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { buildTransferFromQuote } = await import("../services/api/src/transfers/build.js");
const { executeSepaTransfer, safeFundedEurToday } = await import("../services/api/src/orchestrator.js");
const { MoneriumClient } = await import("../services/api/src/adapters/monerium-client.js");
const chain = await import("../services/api/src/chain.js");
const { syncInvoicePayment, withExecutionState } = await import("../services/api/src/routes/business/state.js");

initStore();

const nowSec = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString();
const IBAN = "DE89370400440532013000";
const SAFE = "0x00000000000000000000000000000000000000a1";
store.addUser({
  id: "u-window",
  name: "Window Test",
  country: "DE",
  kycStatus: "approved",
  iban: "",
  address: SAFE,
  authorizerAddress: "0x00000000000000000000000000000000000000a2",
  passkeySafe: { status: "active", address: SAFE },
  createdAt: stamp,
} as any);
let orders = 0;
(MoneriumClient.prototype as any).placeOrder = async () => {
  orders++;
  return { id: "order-1", state: "placed" };
};
const transfer = (id: string, deadline: number, extra: object = {}, row: object = {}) => {
  store.addTransfer({
    id,
    userId: "u-window",
    quoteId: `q-${id}`,
    rail: "sepa",
    recipientName: "Recipient",
    recipientIban: IBAN,
    state: "CREATED",
    sendEur: 40,
    receiveKes: 0,
    fundingSource: "safe",
    txs: [],
    moneriumRedeem: { amount: "40.00", iban: IBAN, issuedAt: stamp, message: "m", memo: "m" },
    auth: {
      to: "0x0000000000000000000000000000000000000002",
      amountWei: "40000000000000000000",
      destination: chain.destinationCommitment("sepa", { iban: IBAN, name: "Recipient" }),
      deadline,
      ...extra,
    },
    createdAt: stamp,
    updatedAt: stamp,
    ...row,
  } as any);
  return store.findTransfer(id)!;
};
const invoice = (id: string, transferId: string) =>
  store.addInvoice({
    id,
    direction: "incoming",
    orgId: "org_1",
    state: "PAYING",
    supplier: { orgName: "Supplier", email: "billing@supplier.example", invoiceNumber: id },
    lines: [],
    currency: "EUR",
    total: "40.00",
    payment: { draftId: "d_run", transferId },
    createdAt: stamp,
    updatedAt: stamp,
  } as any);

(chain.publicClient as any).readContract = async () => 10n ** 21n;
store.addQuote({
  id: "q-built", userId: "u-window", rail: "sepa", status: "OPEN", sendEur: 40, fixedFeeEur: 0, fxRate: 1,
  receiveKes: 0, receiveEur: 40, midRate: 1, marginBps: 0, effectiveRate: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: stamp,
} as any);
const built = await buildTransferFromQuote(store.findQuote("q-built")!, { recipientName: "Recipient", recipientIban: IBAN });
assert.ok(built.ok, JSON.stringify(built));
const window = built.transfer.auth!.deadline - Date.parse(built.transfer.moneriumRedeem!.issuedAt) / 1000;
assert.ok(window > 0 && window < 5 * 60, `the built deadline is ${window} s after the signed stamp`);
store.updateTransfer(built.transfer.id, { state: "FAILED" });
console.log("  ok  a built SEPA transfer must be approved inside Monerium's 5 minutes");

const app = express();
app.use(express.json());
app.use("/api", createTransferRouter({ requireUserSession: () => ({ userId: "u-window" }) } as any));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const late = transfer("t-late", nowSec() - 1);
const authorize = (id: string) =>
  fetch(`http://127.0.0.1:${(server.address() as any).port}/api/transfers/${id}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature: "0x1234", moneriumRedeemSignature: "0x1234" }),
  });
const res = await authorize(late.id);
assert.equal(res.status, 410);
assert.equal((await res.json()).error, "This approval expired, so this payment was not sent.");
const after = store.findTransfer(late.id)!;
assert.equal(after.state, "CREATED");
assert.equal(after.auth!.authorizedAt, undefined, "refused before the claim");
assert.deepEqual(after.txs, [], "refused before the fee debit");
assert.equal(safeFundedEurToday("u-window"), 0, "an expired approval stops counting against the daily cap");
console.log("  ok  a late approval answers 410 before the claim and the debit, and frees the daily cap");

// A claim past the deadline may have debited, so it must not read as "not sent".
const claimedLate = transfer("t-claimed-late", nowSec() - 1, { authorizedAt: stamp });
assert.equal((await authorize(claimedLate.id)).status, 409);
server.close();
console.log("  ok  a claimed transfer past its deadline is not told it was not sent");

// The race the invoice release relies on: past the route's check, then over the deadline, then claimed.
const raced = transfer("t-raced", nowSec() - 1);
assert.ok(store.claimAuthorization(raced.id));
const racedAfter = await executeSepaTransfer(store.findTransfer(raced.id)!, store.findUser("u-window")!, {
  deadline: raced.auth!.deadline,
  signature: "0x1234",
});
assert.equal(racedAfter.state, "FAILED", racedAfter.error);
assert.match(racedAfter.error ?? "", /authorization expired/);
assert.equal(orders, 0, "no order goes to Monerium");
console.log("  ok  an expired line claimed late is refused by the executor: no order");

// A payment run: the late line must not leave the run "Sending" and its invoice PAYING for good.
const live = transfer("t-live", nowSec() + 60);
const claimed = transfer("t-claimed", nowSec() - 1, { authorizedAt: stamp });
const run = (...ids: string[]) => withExecutionState({ id: "d_run", state: "EXECUTING", transferIds: ids } as any) as any;

assert.equal(run(live.id).state, "EXECUTING", "a line still inside its window keeps the run sending");
assert.equal(run(claimed.id).state, "EXECUTING", "a claimed line may have debited, so it is not expired");
assert.equal(run(live.id, late.id).state, "FAILED");
console.log("  ok  an expired line fails its run; a line in its window or already claimed does not");

const named = (id: string, recipientName: string, state: string, sendEur = 40) =>
  transfer(id, nowSec() - 1, { authorizedAt: stamp }, { recipientName, state, sendEur }).id;
const report = run(
  named("t-paid", "Paid GmbH", "PAID"),
  named("t-placed", "Placed GmbH", "PAYOUT_SUBMITTED", 12.5),
  transfer("t-expired", nowSec() - 1, {}, { recipientName: "Expired GmbH" }).id,
  named("t-refused", "Refused GmbH", "REFUNDED"),
  named("t-review", "Review GmbH", "MANUAL_REVIEW"),
  named("t-unknown", "Claimed GmbH", "CREATED"),
  transfer("t-signing", nowSec() + 60, {}, { recipientName: "Signing GmbH" }).id,
).failureReason;
assert.equal(
  report,
  "Sent: Paid GmbH €40.00, Placed GmbH €12.50. " +
    "Not sent: Expired GmbH €40.00 (approval expired), Refused GmbH €40.00 (refunded). " +
    "Still waiting: Review GmbH €40.00 (in review), Claimed GmbH €40.00, Signing GmbH €40.00. " +
    "Make a new run for the not sent lines only.",
);
const onlyReview = run(named("t-review-2", "Review GmbH", "MANUAL_REVIEW")).failureReason;
assert.equal(onlyReview, "Still waiting: Review GmbH €40.00 (in review).");
console.log("  ok  a failed run says by payee what was sent, not sent and still waiting; a claimed line is never not sent");

assert.equal(syncInvoicePayment(invoice("inv-live", live.id)).state, "PAYING");
assert.equal(syncInvoicePayment(invoice("inv-claimed", claimed.id)).state, "PAYING");
const released = syncInvoicePayment(invoice("inv-late", late.id));
assert.equal(released.state, "SUBMITTED", "the invoice can go on a new run");
assert.equal(released.payment?.transferId, undefined);
console.log("  ok  an expired line releases its invoice; a line in its window or already claimed holds it");

console.log("\nREDEEM WINDOW TEST PASSED — 7 checks");
process.exit(0);
