/**
 * The person's name: editable until Monerium has verified them, then locked;
 * never editable on a company login, whose account is named after the
 * company. Pure rules in services/api/src/users/display-name.ts.
 */
import assert from "node:assert/strict";
import { nameChange } from "../services/api/src/users/display-name.js";

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

console.log(failed ? `\ndisplay-name: ${failed} failed` : "\ndisplay-name: all checks passed");
if (failed) process.exit(1);
