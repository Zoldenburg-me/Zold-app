/**
 * Refund guard test: on a non-local RPC, failure compensation must not pretend a
 * Safe refund happened when the chain call cannot be verified.
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TRANSF_RPC_URL = "https://polygon-amoy.example.invalid";
process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");
const { compensateTransfer } = await import("../services/api/src/orchestrator.js");

initStore();

const now = new Date().toISOString();
store.addUser({
  id: "u-refund-guard",
  name: "Refund Guard",
  country: "DE",
  kycStatus: "approved",
  iban: "",
  address: "0x0000000000000000000000000000000000001001",
  createdAt: now,
});
store.addTransfer({
  id: "t-refund-guard",
  userId: "u-refund-guard",
  quoteId: "q-refund-guard",
  rail: "sepa",
  recipientName: "Recipient",
  recipientIban: "DE89370400440532013000",
  state: "FAILED",
  sendEur: 100,
  // A €1 fee moved; the payout never left the Safe.
  receiveEur: 99,
  fundingSource: "safe",
  txs: [{ step: "safe.transfer(fee)", hash: "0xdebited" }],
  createdAt: now,
  updatedAt: now,
});

await assert.rejects(
  () => compensateTransfer("t-refund-guard"),
  /fetch failed|getaddrinfo|ENOTFOUND|network/i,
);
const t = store.findTransfer("t-refund-guard")!;

assert.equal(t.state, "FAILED");
assert.equal(t.refund, undefined, "no refund record should be written without moving value");
assert.equal(
  t.txs.some((x: any) => x.step === "safe.refundTransfer"),
  false,
  "Safe refund must not be recorded unless the transaction was submitted",
);

console.log("REFUND GUARD TEST PASSED — failed chain refund does not record a fake credit");
