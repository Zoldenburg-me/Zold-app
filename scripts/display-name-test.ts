/**
 * The person's name: editable until Monerium has verified them, then locked;
 * never editable on a company login, whose account is named after the
 * company. Pure rules in services/api/src/users/display-name.ts.
 */
import assert from "node:assert/strict";
import { cleanName, nameChange, sameName } from "../services/api/src/users/display-name.js";

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const person = { accountType: "individual" as const, kycStatus: "pending" as const };

check("a person not yet verified may change their name, trimmed and with spaces collapsed", () => {
  assert.deepEqual(nameChange(person, "  Miri   tester 123 "), { name: "Miri tester 123" });
});

check("a verified person's name is locked", () => {
  const r = nameChange({ ...person, kycStatus: "approved" }, "Someone Else");
  assert.equal("code" in r && r.code, "NAME_VERIFIED");
  assert.equal("status" in r && r.status, 409);
});

check("a company login has no personal name to change", () => {
  const r = nameChange({ accountType: "company", kycStatus: "pending" }, "Acme");
  assert.equal("code" in r && r.code, "NAME_COMPANY");
});

check("a name must be 2 to 80 characters", () => {
  for (const bad of ["", " ", "A", "x".repeat(81), 42, null, undefined]) {
    const r = nameChange(person, bad);
    assert.equal("code" in r && r.code, "NAME_INVALID", JSON.stringify(bad));
  }
});

check("control characters and markup are refused, not stored", () => {
  for (const bad of ["Miri\nTh", "Miri\u0000", "<b>Miri</b>", "Miri\u202eTh", "Mi\u200bri"]) {
    const r = nameChange(person, bad);
    assert.equal("code" in r && r.code, "NAME_INVALID", JSON.stringify(bad));
  }
});

check("letters from any language, apostrophes and hyphens are fine", () => {
  for (const ok of ["Zoë O'Brien-Müller", "Łukasz Żółć", "山田 太郎", "می\u200cخواهم"]) {
    assert.deepEqual(nameChange(person, ok), { name: ok });
  }
});

check("every invisible format or control character is refused, not only a hand-picked few", () => {
  const sneaky = ["\u061c", "\u2060", "\u00ad", "\u180e", "\ufff9", "\u{e0041}", "\u0085", "\u2028", "\u2029", "\ufeff", "\u200b", "\u202e", "\u2066"];
  for (const ch of sneaky) {
    const r = nameChange(person, `Mi${ch}ri Th`);
    assert.equal("code" in r && r.code, "NAME_INVALID", JSON.stringify(ch));
  }
});

check("the name is stored in NFC, and its length counts characters, not UTF-16 units", () => {
  assert.deepEqual(nameChange(person, "Zoe\u0308"), { name: "Zo\u00eb" });
  assert.deepEqual(nameChange(person, "𝓜".repeat(80)), { name: "𝓜".repeat(80) });
  assert.equal(cleanName("𝓜".repeat(81)), null);
});

check("cleanName takes the bounds of each place a name is written", () => {
  assert.equal(cleanName("A", { min: 1, max: 120 }), "A");
  assert.equal(cleanName("Acme\u202e GmbH", { min: 2, max: 120 }), null);
  assert.equal(cleanName(42), null);
});

check("a joiner stands only between two visible characters, so no name is drawn out of nothing", () => {
  for (const bad of ["‍‍", "‌‌", "‍An", "An‌", "An ‍na", "An‍ na", "A‌‍n"]) {
    assert.equal(cleanName(bad, { min: 1, max: 120 }), null, JSON.stringify(bad));
  }
  // ZWJ inside a word, as Devanagari conjuncts write it, stays.
  assert.equal(cleanName("क्‍ष"), "क्‍ष");
});

check("a lone surrogate is not text and is refused", () => {
  for (const bad of ["A\ud800b", "Ab\udc00", "\ud83d"]) assert.equal(cleanName(bad, { min: 1 }), null, JSON.stringify(bad));
});

check("sameName: the stored name, as typed or as it would be stored, is unchanged", () => {
  assert.equal(sameName("Anna  Maria", "Anna  Maria"), true);
  assert.equal(sameName("Anna Maria ", "Anna  Maria"), true);
  assert.equal(sameName("Zoë", "Zoë"), true);
  assert.equal(sameName("Anna", "Anne"), false);
  assert.equal(sameName(undefined, "Anna"), false);
  assert.equal(sameName("", undefined), false);
});

console.log(failed ? `\ndisplay-name: ${failed} failed` : "\ndisplay-name: all checks passed");
if (failed) process.exit(1);
