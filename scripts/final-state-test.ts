/**
 * Final transfer states stay put when a later patch tries to move them.
 *
 * REFUNDED and PAID are terminal, and MANUAL_REVIEW is left to an operator:
 * no automatic path may move it on. updateTransfer refuses a different state
 * but still applies the rest of the patch. The refusal used to set
 * `state: undefined`, and Object.assign copied that key, wiping the field.
 *
 * Store-only. Run: npm run final-state:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");

initStore();

const now = new Date().toISOString();
function row(id: string, state: "PAID" | "REFUNDED" | "MANUAL_REVIEW" | "CREATED") {
  return {
    id,
    userId: "u-final",
    quoteId: `q-${id}`,
    rail: "cash" as const,
    recipientName: "Recipient",
    recipientPhone: "+254700000000",
    state,
    sendEur: 100,
    receiveKes: 12950,
    txs: [] as { step: string; hash: string }[],
    createdAt: now,
    updatedAt: now,
  };
}

store.addTransfer(row("t-paid", "PAID"));
store.addTransfer(row("t-refunded", "REFUNDED"));
store.addTransfer(row("t-review", "MANUAL_REVIEW"));
store.addTransfer(row("t-open", "CREATED"));

const errors: string[] = [];
const original = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
};
try {
  const paid = store.updateTransfer("t-paid", { state: "FAILED", error: "late leg" });
  assert.equal(paid.state, "PAID", "a refused move must leave PAID in place");
  assert.equal(paid.error, "late leg", "other fields on the refused patch still apply");
  assert.equal(Object.hasOwn(paid, "state"), true);

  const refunded = store.updateTransfer("t-refunded", { state: "PAID", error: "late payout" });
  assert.equal(refunded.state, "REFUNDED");
  assert.equal(refunded.error, "late payout");

  const same = store.updateTransfer("t-paid", { state: "PAID", error: "note" });
  assert.equal(same.state, "PAID", "writing the same terminal state is not a move");
  assert.equal(same.error, "note");

  // A failure path or the sweep reaching a reviewed transfer must not fail it
  // again: FAILED is what the sweep refunds.
  const review = store.updateTransfer("t-review", { state: "FAILED", error: "late failure" });
  assert.equal(review.state, "MANUAL_REVIEW", "a reviewed transfer stays in review");
  assert.equal(store.updateTransfer("t-review", { state: "REFUNDED" }).state, "MANUAL_REVIEW");

  const open = store.updateTransfer("t-open", { state: "FAILED", error: "real failure" });
  assert.equal(open.state, "FAILED", "a non-terminal transfer can still change state");
  assert.equal(open.error, "real failure");
} finally {
  console.error = original;
}

assert.deepEqual(errors, [
  "store: refusing to move transfer t-paid from PAID to FAILED",
  "store: refusing to move transfer t-refunded from REFUNDED to PAID",
  "store: refusing to move transfer t-review from MANUAL_REVIEW to FAILED",
  "store: refusing to move transfer t-review from MANUAL_REVIEW to REFUNDED",
]);

initStore();
const reloaded = store.findTransfer("t-paid")!;
assert.equal(reloaded.state, "PAID", "the terminal state survives a reload");
assert.equal(reloaded.error, "note");
assert.equal(store.findTransfer("t-refunded")!.state, "REFUNDED");
assert.equal(store.findTransfer("t-review")!.state, "MANUAL_REVIEW");
assert.equal(store.findTransfer("t-open")!.state, "FAILED");

console.log("FINAL STATE TEST PASSED — terminal and review states are not erased");
