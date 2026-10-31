/**
 * The agent's pre-check for paying a Shopify order's pay link from EURe
 * (scripts/agent-pay-shopify.ts). No network.
 *
 * Run: npm run agent-pay:test
 */
import assert from "node:assert/strict";
import { parsePayView, planAgentPayment, type PayView } from "./agent-pay-shopify.js";

const now = new Date("2026-11-03T10:00:00.500Z");
const view: PayView = {
  state: "OPEN", outstandingEur: 42.5, expiresAt: "2026-11-04T10:00:00Z",
  methods: { bank: { iban: "DE89 3704 0044 0532 0130 00", holder: "Keycard GmbH", reference: "ZK7Q2-MXP4A-9TRWB" } },
};
const mandate = { maxEur: 50, ibans: ["de89370400440532013000"] };

assert.deepEqual(planAgentPayment(view, mandate, now), {
  ok: true,
  payout: {
    amount: "42.5", currency: "eur",
    counterpart: { iban: "DE89370400440532013000", name: "Keycard GmbH" },
    memo: "ZK7Q2-MXP4A-9TRWB",
    message: "Send EUR 42.5 to DE89370400440532013000 at 2026-11-03T10:00:00Z",
    issuedAt: "2026-11-03T10:00:00Z",
  },
});

const refused = (v: PayView, m = mandate) => {
  const p = planAgentPayment(v, m, now);
  assert.equal(p.ok, false);
  return (p as { reason: string }).reason;
};
assert.match(refused({ ...view, state: "PAID" }), /paid/);
assert.match(refused({ ...view, expiresAt: "2026-11-03T09:59:59Z" }), /expired/);
assert.match(refused({ ...view, methods: {} }), /MERCHANT_LINK_BANK/);
assert.match(refused({ ...view, outstandingEur: undefined }), /no amount/);
assert.match(refused({ ...view, outstandingEur: 50.01 }), /over the mandate/);
// A poisoned pay page that swaps the IBAN is refused.
assert.match(refused({ ...view, methods: { bank: { ...view.methods.bank!, iban: "DE00000000000000000000" } } }), /allowlist/);

// Untrusted JSON: well-formed passes through, anything odd throws.
assert.deepEqual(parsePayView({ ...view, extra: "ignored" }), view);
for (const bad of [null, {}, { ...view, outstandingEur: "42.5" }, { ...view, outstandingEur: Infinity }, { ...view, methods: { bank: { ...view.methods.bank, reference: "Order #1" } } }]) {
  assert.throws(() => parsePayView(bad));
}

console.log("AGENT PAY TEST PASSED — 9 checks");
