import assert from "node:assert/strict";
import { countryBlock, moneriumResidencyTier, normaliseCountryCode } from "../services/api/src/country-policy.js";

const blocked = [
  "US",
  "United States",
  "DPRK",
  "North Korea",
  "IR",
  "Afghanistan",
  "Palastine",
  "Algeria",
  "Iraq",
  "Nepal",
] as const;

for (const country of blocked) {
  const block = countryBlock(country);
  assert.ok(block, `${country} should be blocked`);
  assert.equal(block.reason, "monerium_prohibited_residency");
}

assert.equal(countryBlock("Bangladesh"), null);
assert.equal(countryBlock("China"), null);
assert.equal(countryBlock("DE"), null);
assert.equal(countryBlock("Germany"), null);
assert.equal(countryBlock("ZZ")?.reason, "monerium_unsupported_residency");
assert.equal(moneriumResidencyTier("Bulgaria"), "restricted");
assert.equal(moneriumResidencyTier("China"), "high");
assert.equal(normaliseCountryCode("usa"), "US");
assert.equal(normaliseCountryCode(" de "), "DE");

console.log("COUNTRY POLICY TEST PASSED");
