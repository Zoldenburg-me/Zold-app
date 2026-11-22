/**
 * Anchor payment safety tests (headless, no network).
 *
 * Three ways the on-ledger SEP-24 payment could lose money, each checked here
 * because none of them is reachable from the live anchor test: the interactive
 * flow never reaches `pending_user_transfer_start` without a human, so the
 * payment path itself cannot be exercised end to end. These cover the
 * decisions that path makes.
 *
 * Run: npm run anchor:safety
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import {
  AnchorPaymentUncertainError,
  isTransientAnchorError,
  resolvePaymentAmount,
} from "../services/api/src/stellar/anchor.js";

let pass = 0;
const t = (label: string, fn: () => void) => {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
};

console.log("payment amount — the anchor does not get to decide:");

t("with no amount_in, we send what we opened the withdrawal for", () => {
  assert.equal(resolvePaymentAmount(5), 5);
  assert.equal(resolvePaymentAmount(5, ""), 5);
  assert.equal(resolvePaymentAmount(5, undefined), 5);
});

t("an amount_in matching the request is honoured", () => {
  assert.equal(resolvePaymentAmount(5, "5"), 5);
  assert.equal(resolvePaymentAmount(5, "5.0000000"), 5);
});

t("an amount_in ABOVE the request is refused", () => {
  // If the anchor's number drove the payment, an anchor reporting 10000
  // would be paid 10000.
  assert.throws(
    () => resolvePaymentAmount(5, "10000"),
    /refusing to send more than we authorised/,
  );
  assert.throws(() => resolvePaymentAmount(5, "5.001"), /refusing to send more/);
});

t("an amount_in below the request is allowed (anchor-side fees)", () => {
  assert.equal(resolvePaymentAmount(5, "4.5"), 4.5);
});

t("a stroop of rounding is tolerated, not treated as an overcharge", () => {
  assert.equal(resolvePaymentAmount(5, "5.0000001"), 5.0000001);
});

t("junk from the anchor is refused rather than coerced", () => {
  assert.throws(() => resolvePaymentAmount(5, "not-a-number"), /unusable amount_in/);
  assert.throws(() => resolvePaymentAmount(5, "0"), /unusable amount_in/);
  assert.throws(() => resolvePaymentAmount(5, "-3"), /unusable amount_in/);
});

t("a non-positive request is refused outright", () => {
  assert.throws(() => resolvePaymentAmount(0), /must be positive/);
  assert.throws(() => resolvePaymentAmount(-1, "1"), /must be positive/);
});

console.log("uncertain submissions — never auto-refund on a maybe:");

t("AnchorPaymentUncertainError is distinguishable and keeps its cause", () => {
  const cause = new Error("Horizon 504");
  const err = new AnchorPaymentUncertainError("submit timed out", cause);
  assert.ok(err instanceof AnchorPaymentUncertainError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AnchorPaymentUncertainError");
  assert.equal(err.cause, cause);
  // The orchestrator branches on exactly this check.
  assert.equal(new Error("ordinary failure") instanceof AnchorPaymentUncertainError, false);
});

console.log("transient anchor errors — only a transport failure or a 5xx status waits:");

t("transport failures and a 5xx status are transient", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  for (const err of [
    new TypeError("fetch failed"),
    new Error("connect ECONNREFUSED 127.0.0.1:443"),
    new Error("request timed out"),
    new Error("socket hang up"),
    timeout,
    new Error("SEP-24 status failed (500): oops"),
    new Error("SEP-24 status failed (503): upstream"),
    new Error("SEP-10 token failed (504): gateway"),
    new Error("stellar.toml fetch failed for anchor.test (502)"),
    Object.assign(new Error("Request failed"), { response: { status: 503 } }),
  ]) assert.equal(isTransientAnchorError(err), true, String(err));
});

t("a three-digit number in the anchor's text is not a 5xx", () => {
  for (const err of [
    new Error("anchor rejected amount 500"),
    new Error("SEP-24 status failed (400): reference 501 is unknown"),
    new Error("SEP-24 status failed (404): not found"),
    new Error("SEP-10 token failed (401): amount 503 over limit"),
    new Error("anchor withdrawal anchor-tx is refunded"),
    Object.assign(new Error("Request failed"), { response: { status: 400 } }),
  ]) assert.equal(isTransientAnchorError(err), false, String(err));
});

console.log(`\nANCHOR SAFETY TEST PASSED — ${pass}/${pass}`);
console.log(
  "note: the payment hash is persisted via the onPaymentSubmitted callback\n" +
    "      before polling begins — see refreshPayout in orchestrator.ts.",
);
