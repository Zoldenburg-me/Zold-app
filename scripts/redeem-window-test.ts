/**
 * A SEPA approval must reach Monerium inside the 5 minutes its docs allow the
 * signed message, and one that comes too late must stop before the fee debit
 * and leave the person able to start again.
 *
 * The real transfer router and the real read-time derivations on a temp store.
 * NOT PROVEN HERE: that Monerium refuses an older message (its docs say so; no
 * call is made), and the real builder, which needs a bundler.
 *
 *   npm run redeem-window:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import express from "express";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { authWindowSec } = await import("../services/api/src/transfers/build.js");
const { safeFundedEurToday } = await import("../services/api/src/orchestrator.js");
const { syncInvoicePayment, withExecutionState } = await import("../services/api/src/routes/business/state.js");

initStore();

const nowSec = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString();
const transfer = (id: string, deadline: number, extra: object = {}) => {
  store.addTransfer({
    id,
    userId: "u-window",
    quoteId: `q-${id}`,
    rail: "sepa",
    recipientName: "Recipient",
    recipientIban: "DE89370400440532013000",
    state: "CREATED",
    sendEur: 40,
    receiveKes: 0,
    fundingSource: "safe",
    txs: [],
    moneriumRedeem: { amount: "40.00", iban: "DE89370400440532013000", issuedAt: stamp, message: "m", memo: "m" },
    auth: {
      to: "0x0000000000000000000000000000000000000002",
      amountWei: "40000000000000000000",
      destination: `0x${"11".repeat(32)}`,
      deadline,
      ...extra,
    },
    createdAt: stamp,
    updatedAt: stamp,
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

assert.ok(authWindowSec("sepa") < 5 * 60, "the SEPA window ends before Monerium's 5 minutes");
assert.equal(authWindowSec("cash"), 15 * 60);
console.log("  ok  a SEPA approval window ends inside Monerium's 5 minutes; the cash rail keeps 15");

const app = express();
app.use(express.json());
app.use("/api", createTransferRouter({ requireUserSession: () => ({ userId: "u-window" }) } as any));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const late = transfer("t-late", nowSec() - 1);
const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/transfers/${late.id}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ signature: "0x1234", moneriumRedeemSignature: "0x1234" }),
});
server.close();
assert.equal(res.status, 410);
assert.match((await res.json()).error, /nothing was sent\. Start the payment again/);
const after = store.findTransfer(late.id)!;
assert.equal(after.state, "CREATED");
assert.equal(after.auth!.authorizedAt, undefined, "refused before the claim");
assert.deepEqual(after.txs, [], "refused before the fee debit");
assert.equal(safeFundedEurToday("u-window"), 0, "an expired approval stops counting against the daily cap");
console.log("  ok  a late approval answers 410 before the claim and the debit, and frees the daily cap");

// A payment run: the late line must not leave the run "Sending" and its invoice PAYING for good.
const live = transfer("t-live", nowSec() + 60);
const claimed = transfer("t-claimed", nowSec() - 1, { authorizedAt: stamp });
const run = (...ids: string[]) => withExecutionState({ id: "d_run", state: "EXECUTING", transferIds: ids } as any) as any;

assert.equal(run(live.id).state, "EXECUTING", "a line still inside its window keeps the run sending");
assert.equal(run(claimed.id).state, "EXECUTING", "a claimed line may have debited, so it is not expired");
const failed = run(live.id, late.id);
assert.equal(failed.state, "FAILED");
assert.match(failed.failureReason, /t-late approval expired/);
console.log("  ok  an expired line fails its run; a line in its window or already claimed does not");

assert.equal(syncInvoicePayment(invoice("inv-live", live.id)).state, "PAYING");
assert.equal(syncInvoicePayment(invoice("inv-claimed", claimed.id)).state, "PAYING");
const released = syncInvoicePayment(invoice("inv-late", late.id));
assert.equal(released.state, "SUBMITTED", "the invoice can go on a new run");
assert.equal(released.payment?.transferId, undefined);
console.log("  ok  an expired line releases its invoice; a line in its window or already claimed holds it");

console.log("\nREDEEM WINDOW TEST PASSED — 4 checks");
process.exit(0);
