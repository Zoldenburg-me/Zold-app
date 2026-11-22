/**
 * Anchor payout sweep test: a transfer already funded on-ledger should be
 * closed by the background driver once the anchor state is reflected as paid,
 * even when no browser calls /refresh-payout.
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { User } from "../services/api/src/store.js";

process.env.MG_ANCHOR_DOMAIN = "";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");
const { anchorPaymentMayHaveLeft, sweepAnchorPayouts } = await import("../services/api/src/orchestrator.js");
const { anchorMemoForPickup, senderMemo } = await import("../services/api/src/adapters/moneygram.js");

initStore();

const now = new Date(Date.now() - 60_000).toISOString();
const user: User = {
  id: "u-anchor-sweep",
  name: "Anchor Sweep",
  country: "DE",
  kycStatus: "approved",
  iban: "",
  address: "0x0000000000000000000000000000000000001002",
  createdAt: now,
};
store.addUser(user);
store.addTransfer({
  id: "t-anchor-sweep",
  userId: "u-anchor-sweep",
  quoteId: "q-anchor-sweep",
  rail: "cash",
  recipientName: "Recipient",
  recipientPhone: "+254700000000",
  state: "PAYOUT_FUNDED",
  sendEur: 10,
  receiveKes: 1295,
  fundingSource: "safe",
  txs: [{ step: "safe.transfer(orchestrator)", hash: "0xdebited" }],
  pickup: {
    referenceCode: "MG123456",
    provider: "anchor:test",
    status: "PAID",
    anchorTransactionId: "anchor-tx",
    anchorAmount: 10,
    anchorAsset: "USDC",
    anchorPaymentHash: "stellar-payment",
    anchorStatus: "completed",
  },
  createdAt: now,
  updatedAt: now,
});

const refreshed = await sweepAnchorPayouts();
const t = store.findTransfer("t-anchor-sweep")!;

assert.equal(refreshed, 1);
assert.equal(t.state, "PAID");
assert.equal(t.pickup?.status, "PAID");
assert.equal(
  anchorMemoForPickup(t.id, t.pickup),
  senderMemo(user.id),
  "anchor pickups stored without a memo must recover the same per-user SEP-10 memo on refresh",
);

// A payment broadcast before a restart whose hash never reached the disk. The
// signed payment stays valid on Stellar for 5 minutes, so an operator who
// checks the treasury at once can see nothing and pay again.
const strandedTxs = [{ step: "bridge.xyz.deposit.transfer", hash: "0x33" }, { step: "anchor.payment.pending", hash: "0x" }];
for (const state of ["PAYOUT_FUNDING_PENDING", "PAYOUT_READY"] as const) {
  store.addTransfer({
    id: `t-stranded-${state}`,
    userId: "u-anchor-sweep",
    quoteId: "q-anchor-sweep",
    rail: "cash",
    recipientName: "Recipient",
    recipientPhone: "+254700000000",
    state,
    sendEur: 10,
    receiveKes: 1295,
    fundingSource: "safe",
    txs: strandedTxs.map((x) => ({ ...x })),
    pickup: {
      referenceCode: "R1",
      provider: "anchor:test",
      status: "PENDING",
      anchorTransactionId: "anchor-tx",
      anchorAmount: 10,
      anchorAsset: "USDC",
      anchorStatus: "pending_user_transfer_start",
    },
    createdAt: now,
    updatedAt: now,
  });
}
assert.equal(await sweepAnchorPayouts(), 2);
for (const state of ["PAYOUT_FUNDING_PENDING", "PAYOUT_READY"]) {
  const stranded = store.findTransfer(`t-stranded-${state}`)!;
  assert.equal(stranded.state, "MANUAL_REVIEW", state);
  assert.match(stranded.error ?? "", /wait 5 minutes/i, state);
}

// A failed refresh may have paid whenever a payment intent has no settling
// step, whatever the error: an ordinary throw after the broadcast must not
// read as "nothing went out" and refund the sender.
const row = (txs: { step: string; hash: string }[], anchorPaymentHash?: string) =>
  ({ txs, pickup: { referenceCode: "R1", provider: "anchor:test", status: "PENDING", anchorPaymentHash } }) as any;
const ordinary = new Error("hash write failed");
assert.equal(anchorPaymentMayHaveLeft(ordinary, row(strandedTxs)), true, "unsettled intent");
assert.equal(anchorPaymentMayHaveLeft(ordinary, row([...strandedTxs, { step: "anchor.payment.sent", hash: "ab" }], "ab")), true, "hash on record");
assert.equal(anchorPaymentMayHaveLeft(ordinary, row([{ step: "bridge.xyz.deposit.transfer", hash: "0x33" }])), false, "nothing sent");
assert.equal(anchorPaymentMayHaveLeft(ordinary, undefined), false, "no row");

console.log("ANCHOR SWEEP TEST PASSED — funded payout reaches PAID without client polling and keeps the user memo; a lost payment goes to review with a 5-minute wait");
