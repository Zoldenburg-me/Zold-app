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
const { anchorPaymentMayHaveLeft, refreshPayout, sweepAnchorPayouts } = await import("../services/api/src/orchestrator.js");
const { userTransfer } = await import("../services/api/src/transfers/user-transfer.js");
const { STELLAR } = await import("../services/api/src/config/cash-rail.js");
const { AnchorPaymentUncertainError } = await import("../services/api/src/stellar/anchor.js");
const { Keypair } = await import("@stellar/stellar-sdk");
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

// A refresh that fails after the payment may have gone out (an uncertain
// submit) goes to review with the same operator step, never a refund.
store.addTransfer({
  id: "t-uncertain",
  userId: "u-anchor-sweep",
  quoteId: "q-anchor-sweep",
  rail: "cash",
  recipientName: "Recipient",
  recipientPhone: "+254700000000",
  state: "PAYOUT_FUNDING_PENDING",
  sendEur: 10,
  receiveKes: 1295,
  fundingSource: "safe",
  txs: [{ step: "bridge.xyz.deposit.transfer", hash: "0x33" }],
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
const realFetch = globalThis.fetch;
const anchorConfig = { anchorDomain: STELLAR.anchorDomain, treasurySecret: STELLAR.treasurySecret };
Object.assign(STELLAR, { anchorDomain: "anchor.invalid", treasurySecret: Keypair.random().secret() });
globalThis.fetch = (async () => {
  throw new AnchorPaymentUncertainError("submit timed out");
}) as typeof fetch;
try {
  const uncertain = await refreshPayout(store.findTransfer("t-uncertain")!);
  assert.equal(uncertain.state, "MANUAL_REVIEW");
  assert.match(uncertain.error ?? "", /no automatic refund; wait 5 minutes, then check the treasury account/);
  assert.equal(uncertain.refund, undefined);
} finally {
  globalThis.fetch = realFetch;
  Object.assign(STELLAR, anchorConfig);
}

// The operator step is for the operator. The sender's copy of these rows
// (desktop Under review card, phone detail) must not read as "pay again in 5
// minutes"; the admin view reads the stored error and keeps the full text.
for (const id of ["t-stranded-PAYOUT_FUNDING_PENDING", "t-stranded-PAYOUT_READY", "t-uncertain"]) {
  const stored = store.findTransfer(id)!;
  assert.match(stored.error ?? "", /treasury account before paying again/, id);
  const seen = userTransfer(stored).error ?? "";
  assert.doesNotMatch(seen, /5 minutes|treasury|again or|paying again|refunding|hash|Stellar/i, id);
  assert.match(seen, /under review/i, id);
  assert.match(seen, /don.t send it again/i, id);
  assert.doesNotMatch(seen, /:/, `${id}: the desktop card cuts the reason at the first colon`);
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

console.log("ANCHOR SWEEP TEST PASSED — funded payout reaches PAID without client polling and keeps the user memo; a lost or uncertain payment goes to review with a 5-minute wait the sender never sees");
