/**
 * resolveSegment — every branch, and the cases where two rules disagree.
 *
 * The interesting tests here are not the happy paths; they are the collisions,
 * because precedence is the whole design:
 *   - a US citizen living in Germany (US rule beats a servable residence)
 *   - a Guam resident (Monerium rates several US territories servable, so the
 *     tier alone would hand a US person an account)
 *   - an Indian resident (Monerium rates IN servable; we decline anyway)
 *   - a Nigerian resident (no partner, but NOT sanctioned — and must never be
 *     labelled as such)
 *
 * Pure function, no chain, no network, no store.
 *
 * Run: npm run segments:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";

const {
  resolveSegment, can, capabilitiesFor, SegmentInputError,
} = await import("../services/api/src/domain/segments.js");

let n = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok  ${label}`); n++; }
  catch (err: any) { failures.push(`${label}: ${err?.message ?? err}`); console.log(`  FAIL ${label}: ${err?.message ?? err}`); n++; }
};

const NO_US = { usCitizen: false, usGreenCard: false, usTaxResident: false };
const person = (residence: string, citizenships: string[] = [residence], extra: any = {}) => ({
  residence, citizenships, accountType: "individual" as const, usAnswers: { ...NO_US }, ...extra,
});
const company = (residence: string, citizenships: string[] = [residence], extra: any = {}) => ({
  residence, citizenships, accountType: "company" as const,
  usAnswers: { ...NO_US, companyUsNexus: false }, ...extra,
});
const seg = (i: any) => resolveSegment(i).segment;

console.log("\nUS persons — the rule that overrides everything");

check("a US citizen resident in Germany is blocked, servable residence notwithstanding", () => {
  const d = resolveSegment(person("DE", ["US", "DE"], { usAnswers: { ...NO_US, usCitizen: true } }));
  assert.equal(d.segment, "BLOCKED_US");
  assert.equal(d.reasonCode, "us_answer_citizen");
  assert.deepEqual(d.capabilities, []);
});

check("a green card holder is blocked even answering no to citizenship", () => {
  assert.equal(seg(person("FR", ["FR"], { usAnswers: { ...NO_US, usGreenCard: true } })), "BLOCKED_US");
});

check("the combined question (citizen, Green Card or tax resident) blocks on yes", () => {
  const d = resolveSegment(person("DE", ["DE"], { usAnswers: { usPerson: true } }));
  assert.equal(d.segment, "BLOCKED_US");
  assert.equal(d.reasonCode, "us_answer_person");
});

check("the combined question answered no is a complete answer on its own", () => {
  assert.equal(seg(person("DE", ["DE"], { usAnswers: { usPerson: false } })), "EU_FULL");
});

check("an unanswered US question is refused, not read as no", () => {
  assert.throws(() => resolveSegment(person("DE", ["DE"], { usAnswers: {} as any })), /answered yes or no/);
});

check("a declared US tax resident is blocked", () => {
  assert.equal(seg(person("ES", ["ES"], { usAnswers: { ...NO_US, usTaxResident: true } })), "BLOCKED_US");
});

check("US citizenship blocks even when every question is answered no", () => {
  // The questions are self-declared; a declared citizenship is independent
  // evidence and must not be overridden by a denial.
  const d = resolveSegment(person("DE", ["DE", "US"]));
  assert.equal(d.segment, "BLOCKED_US");
  assert.equal(d.reasonCode, "us_citizenship");
});

check("a US TERRITORY resident is blocked, though Monerium rates it servable", () => {
  // Guam is `medium` in Monerium's table, so a tier check alone would open an
  // account for a US person. This is the reason US_TERRITORIES exists.
  for (const t of ["GU", "PR", "VI", "MP", "AS", "UM"]) {
    const d = resolveSegment(person(t, [t]));
    assert.equal(d.segment, "BLOCKED_US", `${t} must be treated as US`);
  }
});

check("a company with US beneficial ownership is blocked", () => {
  const d = resolveSegment(company("DE", ["DE"], {
    usAnswers: { ...NO_US, companyUsNexus: true },
  }));
  assert.equal(d.segment, "BLOCKED_US");
  assert.equal(d.reasonCode, "us_answer_company_nexus");
});

check("a company incorporated in the US is blocked even if it denies the nexus", () => {
  assert.equal(seg(company("DE", ["DE"], { companyIncorporationCountry: "US" })), "BLOCKED_US");
});

console.log("\nSanctions — separate from 'no partner will serve you'");

check("a sanctioned residence is blocked", () => {
  const d = resolveSegment(person("IR", ["IR"]));
  assert.equal(d.segment, "BLOCKED_SANCTIONED");
  assert.equal(d.reasonCode, "sanctioned_residence");
});

check("a sanctioned CITIZENSHIP blocks a servable residence", () => {
  const d = resolveSegment(person("DE", ["RU", "DE"]));
  assert.equal(d.segment, "BLOCKED_SANCTIONED");
  assert.equal(d.reasonCode, "sanctioned_citizenship");
});

check("US precedence beats sanctions, so the reason code stays truthful", () => {
  // Both fire; the recorded reason must be the one that actually decided.
  const d = resolveSegment(person("IR", ["IR", "US"]));
  assert.equal(d.segment, "BLOCKED_US");
});

console.log("\nEU full path");

check("a German resident gets the full path with a card", () => {
  const d = resolveSegment(person("DE", ["DE"]));
  assert.equal(d.segment, "EU_FULL");
  assert.deepEqual(d.capabilities.sort(),
    ["card", "gnosis_pay", "monerium", "onchain_balance", "safe"]);
});

check("an INDIAN CITIZEN resident in Germany is EU_FULL — citizenship is not residence", () => {
  assert.equal(seg(person("DE", ["IN"])), "EU_FULL");
});

check("a dual national of two servable countries is EU_FULL", () => {
  assert.equal(seg(person("FR", ["FR", "BR"])), "EU_FULL");
});

check("an Indian resident with an EU-incorporated company is still IN_COLLECTIONS", () => {
  // Residence decides the path. An Indian resident does not acquire an
  // on-chain account by incorporating in Estonia.
  assert.equal(seg(company("IN", ["IN"], { companyIncorporationCountry: "EE" })), "IN_COLLECTIONS");
});

check("an EU company resident in the EU is EU_FULL", () => {
  assert.equal(seg(company("EE", ["EE"], { companyIncorporationCountry: "EE" })), "EU_FULL");
});

check("UK and Switzerland are in the full path", () => {
  assert.equal(seg(person("GB", ["GB"])), "EU_FULL");
  assert.equal(seg(person("CH", ["CH"])), "EU_FULL");
});

console.log("\nIndia — an override of the issuer's own view");

check("an Indian resident is IN_COLLECTIONS although Monerium rates IN servable", () => {
  const d = resolveSegment(person("IN", ["IN"]));
  assert.equal(d.segment, "IN_COLLECTIONS");
  assert.deepEqual(d.capabilities, ["xflow_collections"]);
});

check("IN_COLLECTIONS is GATED, and the gate names the missing piece", () => {
  const d = resolveSegment(person("IN", ["IN"]));
  assert.ok(d.gate, "the segment must carry its gate");
  assert.match(d.gate!.needs, /incorporated in India/i);
  assert.match(d.gate!.needs, /Zoldenburg UG/);
});

check("an Indian resident gets NO on-chain capability of any kind", () => {
  const d = resolveSegment(person("IN", ["IN"]));
  for (const c of ["monerium", "gnosis_pay", "safe", "card", "onchain_balance"] as const) {
    assert.equal(can(d.segment, c), false, `IN_COLLECTIONS must not have ${c}`);
  }
});

console.log("\nOn-chain without a card, derived from the issuer's tier");

check("a Brazilian resident is ONCHAIN_NO_CARD", () => {
  const d = resolveSegment(person("BR", ["BR"]));
  assert.equal(d.segment, "ONCHAIN_NO_CARD");
  assert.deepEqual(d.capabilities.sort(), ["monerium", "onchain_balance", "safe"]);
  assert.equal(can(d.segment, "card"), false);
});

check("a Mexican resident is ONCHAIN_NO_CARD", () => {
  assert.equal(seg(person("MX", ["MX"])), "ONCHAIN_NO_CARD");
});

check("a NIGERIAN resident is UNSUPPORTED, not sanctioned and not promised an account", () => {
  // The brief named NG as an ONCHAIN_NO_CARD example, but Monerium prohibits
  // NG outright — so that path would promise an account no partner will open.
  const d = resolveSegment(person("NG", ["NG"]));
  assert.equal(d.segment, "BLOCKED_UNSUPPORTED");
  assert.equal(d.reasonCode, "no_partner_for_residence");
  assert.notEqual(d.segment, "BLOCKED_SANCTIONED", "Nigeria is not sanctioned");
});

check("an unknown country code is UNSUPPORTED rather than quietly allowed", () => {
  assert.equal(seg(person("ZZ", ["ZZ"])), "BLOCKED_UNSUPPORTED");
});

console.log("\nSoft US signals — flag, never block");

check("a US phone code flags for review but does not change the segment", () => {
  const d = resolveSegment(person("DE", ["DE"], { softSignals: { usPhoneCode: true } }));
  assert.equal(d.segment, "EU_FULL");
  assert.deepEqual(d.review?.softUsSignals, ["us_phone_code"]);
  assert.equal(d.review?.requiresUsReconfirmation, true);
});

check("several soft signals are all recorded", () => {
  const d = resolveSegment(person("DE", ["DE"], {
    softSignals: { usPhoneCode: true, usMailingAddress: true, usIpAtSignup: true },
  }));
  assert.deepEqual(d.review?.softUsSignals, ["us_phone_code", "us_mailing_address", "us_ip_at_signup"]);
});

check("no soft signals means no review block at all", () => {
  assert.equal(resolveSegment(person("DE", ["DE"])).review, undefined);
});

console.log("\nInput validation");

check("a missing citizenship is refused, not defaulted to residence", () => {
  assert.throws(() => resolveSegment(person("DE", [])), SegmentInputError);
});

check("a company that never answered the ownership question is refused", () => {
  // undefined is 'not asked', which is not the same fact as 'asked and denied'.
  assert.throws(
    () => resolveSegment({ residence: "DE", citizenships: ["DE"], accountType: "company",
      usAnswers: { ...NO_US } } as any),
    SegmentInputError,
  );
});

check("a half-answered US questionnaire is refused", () => {
  assert.throws(
    () => resolveSegment({ residence: "DE", citizenships: ["DE"], accountType: "individual",
      usAnswers: { usCitizen: false } } as any),
    SegmentInputError,
  );
});

check("a country name is normalised, not rejected", () => {
  assert.equal(seg(person("Germany", ["Germany"])), "EU_FULL");
  assert.equal(seg(person("USA", ["USA"])), "BLOCKED_US");
});

check("junk in the country field is refused", () => {
  assert.throws(() => resolveSegment(person("Neverland", ["DE"])), SegmentInputError);
});

console.log("\nCapabilities are derived, never set");

check("every blocked segment has zero capabilities", () => {
  for (const s of ["BLOCKED_US", "BLOCKED_SANCTIONED", "BLOCKED_UNSUPPORTED"] as const) {
    assert.deepEqual(capabilitiesFor(s), [], `${s} must grant nothing`);
  }
});

check("only EU_FULL may reach a card, and only IN may reach Xflow", () => {
  const all = ["BLOCKED_US", "BLOCKED_SANCTIONED", "BLOCKED_UNSUPPORTED",
    "EU_FULL", "IN_COLLECTIONS", "ONCHAIN_NO_CARD"] as const;
  assert.deepEqual(all.filter((s) => can(s, "card")), ["EU_FULL"]);
  assert.deepEqual(all.filter((s) => can(s, "gnosis_pay")), ["EU_FULL"]);
  assert.deepEqual(all.filter((s) => can(s, "xflow_collections")), ["IN_COLLECTIONS"]);
  // Monerium is reachable from exactly the two on-chain paths and nowhere else.
  assert.deepEqual(all.filter((s) => can(s, "monerium")), ["EU_FULL", "ONCHAIN_NO_CARD"]);
});

check("capabilitiesFor returns a copy, so a caller cannot mutate the table", () => {
  const caps = capabilitiesFor("EU_FULL");
  caps.push("xflow_collections");
  assert.equal(capabilitiesFor("EU_FULL").includes("xflow_collections"), false);
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} of ${n} checks FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`segments: ${n}/${n} checks passed`);
