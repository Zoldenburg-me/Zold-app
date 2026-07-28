/**
 * SEPA remittance reference — the line the payee reads on their statement.
 *
 * Pure functions, no chain and no API. Run: npm run sepa:test
 */
import assert from "node:assert/strict";
import {
  moneriumRedeemMessage,
  paymentMemo,
  toSepaCharset,
  SEPA_REMITTANCE_MAX,
} from "../services/api/src/sepa.js";

const ID = "7494cd64-4e25-417d-8a43-b2d2f7d1bfed";
let n = 0;
const check = (label: string, fn: () => void) => {
  fn();
  console.log(`  ${++n}. ${label}`);
};

console.log("SEPA remittance reference");

check("no reference keeps the previous string, so non-checkout payouts read the same", () => {
  assert.equal(paymentMemo(ID), `Zold ${ID}`);
});

check("blank and whitespace-only references are treated as absent", () => {
  assert.equal(paymentMemo(ID, ""), `Zold ${ID}`);
  assert.equal(paymentMemo(ID, "   "), `Zold ${ID}`);
});

check("the payer's reference leads; our short id trails", () => {
  assert.equal(paymentMemo(ID, "mony-user-8412/topup-77af"), "mony-user-8412/topup-77af Zold 7494cd64");
});

check("accents are folded, not blanked — Muller, never M ller", () => {
  assert.equal(toSepaCharset("Müller"), "Muller");
  assert.equal(toSepaCharset("Ærø"), "aero");
  assert.equal(toSepaCharset("Straße"), "Strasse");
  assert.equal(toSepaCharset("José Ñuñez"), "Jose Nunez");
});

check("characters outside the SEPA subset become spaces and collapse", () => {
  assert.equal(toSepaCharset("order #42 <\"quoted\">  &  more"), "order 42 quoted more");
  assert.equal(toSepaCharset("tab\tand\nnewline"), "tab and newline");
});

check("the allowed punctuation survives", () => {
  assert.equal(toSepaCharset("A/B-C?D:E(F)G.H,I'J+K"), "A/B-C?D:E(F)G.H,I'J+K");
});

check("reserved slash forms are stripped — a bank may read /X/ as a field marker", () => {
  assert.equal(paymentMemo(ID, "/leading"), "leading Zold 7494cd64");
  assert.equal(paymentMemo(ID, "trailing/"), "trailing Zold 7494cd64");
  assert.equal(paymentMemo(ID, "a//b"), "a/b Zold 7494cd64");
});

check("output never exceeds the 140-character scheme limit", () => {
  const long = "x".repeat(400);
  const memo = paymentMemo(ID, long);
  assert.ok(memo.length <= SEPA_REMITTANCE_MAX, `got ${memo.length}`);
});

check("when it must truncate, the id stays whole — half an id identifies nothing", () => {
  const memo = paymentMemo(ID, "y".repeat(400));
  assert.ok(memo.endsWith(" Zold 7494cd64"), memo);
});

check("a reference at exactly the limit still leaves the id intact", () => {
  const memo = paymentMemo(ID, "z".repeat(SEPA_REMITTANCE_MAX));
  assert.ok(memo.length <= SEPA_REMITTANCE_MAX);
  assert.ok(memo.endsWith(" Zold 7494cd64"), memo);
});

check("a reference that is only unsupported characters falls back to the plain tag", () => {
  // Not silently sending an empty remittance line: the payout is still ours.
  assert.equal(paymentMemo(ID, "€€€"), `Zold ${ID}`);
});

check("truncation does not leave a dangling slash at the cut", () => {
  const memo = paymentMemo(ID, "w".repeat(120) + "/" + "w".repeat(60));
  assert.ok(!/\/ Zold/.test(memo), memo);
  assert.ok(memo.length <= SEPA_REMITTANCE_MAX);
});

check("Monerium redeem text is fixed from transfer-time terms", () => {
  assert.deepEqual(
    moneriumRedeemMessage(39.01, "de89 3704 0044 0532 0130 00", "2026-07-28T09:00:00.000Z"),
    {
      amount: "39.01",
      iban: "DE89370400440532013000",
      issuedAt: "2026-07-28T09:00:00.000Z",
      message: "Send EUR 39.01 to DE89370400440532013000 at 2026-07-28T09:00:00.000Z",
    },
  );
});

console.log(`\nSEPA REFERENCE TEST PASSED — ${n} checks`);
