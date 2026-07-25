/**
 * Refund guard test: on a non-local RPC, FP3 compensation must not mint mock
 * EURe as a "refund". It must park the transfer for manual review until a
 * treasury-funded refund path exists.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TRANSF_RPC_URL = "https://polygon-amoy.example.invalid";
process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
rmSync(path.join(ROOT, "data/db.json"), { force: true });

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
  rail: "cash",
  recipientName: "Recipient",
  recipientPhone: "+254700000000",
  state: "FAILED",
  sendEur: 100,
  receiveKes: 12950,
  txs: [{ step: "vault.debit", hash: "0xdebited" }],
  createdAt: now,
  updatedAt: now,
});

const t = await compensateTransfer("t-refund-guard");

assert.equal(t.state, "MANUAL_REVIEW");
assert.match(t.error ?? "", /refusing on non-local RPC/);
assert.equal(t.refund, undefined, "no refund record should be written without moving value");
assert.equal(
  t.txs.some((x: any) => x.step === "vault.refundCredit"),
  false,
  "mock refund credit must not be submitted on a non-local RPC",
);

console.log("REFUND GUARD TEST PASSED — non-local compensation parks in MANUAL_REVIEW instead of minting");
