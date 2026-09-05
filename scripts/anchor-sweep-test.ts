/**
 * Anchor payout sweep test: a transfer already funded on-ledger should be
 * closed by the background driver once the anchor state is reflected as paid,
 * even when no browser calls /refresh-payout.
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { User } from "../services/api/src/store.js";

process.env.MG_ANCHOR_DOMAIN = "";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");
const { sweepAnchorPayouts } = await import("../services/api/src/orchestrator.js");
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
  senderMemo(user),
  "anchor pickups stored without a memo must recover the same per-user SEP-10 memo on refresh",
);

console.log("ANCHOR SWEEP TEST PASSED — funded payout reaches PAID without client polling and keeps the user memo");
