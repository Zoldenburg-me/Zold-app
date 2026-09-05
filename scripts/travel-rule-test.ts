/**
 * Travel Rule / SEP-12 sender-data test — live against the configured anchor.
 *
 * A cash pickup is a money transmission: the anchor hands cash to a person at
 * a counter, and its licence obliges it to know who sent it. MoneyGram's
 * anchor requires the FATF originator set as SEP-9 fields. Without them the
 * anchor's SEP-12 customer sits at NEEDS_INFO and the withdrawal can never
 * complete — while the user is still shown a pickup reference.
 *
 * These run against the real anchor (testanchor by default, no signup), so the
 * required-field list is the anchor's own, not our guess.
 *
 * Run: npm run travelrule:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { STELLAR } from "../services/api/src/config.js";
import {
  getTreasury,
  missingRequiredFields,
  sep10Auth,
  sep12CustomerFields,
  sep12PutCustomer,
} from "../services/api/src/stellar/anchor.js";
import { senderMemo, senderProfileToSep9, submitSenderProfile } from "../services/api/src/adapters/moneygram.js";
import { MONEYGRAM_SEP9_FIELDS, moneygramSep9, toAlpha3 } from "../services/api/src/stellar/sep9.js";
import type { User } from "../services/api/src/store.js";

const domain = STELLAR.anchorDomain || "testanchor.stellar.org";

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

// A distinct id per run: the anchor's required-field list is per CUSTOMER,
// and a customer that already submitted KYC reports nothing as required. A
// fixed id would make this test pass for the wrong reason on the second run.
const RUN_ID = `u-travel-rule-${Date.now()}`;

const baseUser = (overrides: Partial<User> = {}): User =>
  ({
    id: RUN_ID,
    name: "Miriam Zoldenburg",
    email: "miriam@example.com",
    country: "DE",
    kycStatus: "approved",
    iban: "",
    address: "0x0000000000000000000000000000000000001001",
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as User;

const fullProfile = {
  firstName: "Miriam",
  lastName: "Zoldenburg",
  birthDate: "1990-04-12",
  address: "12 Beispielstrasse",
  city: "Berlin",
  postalCode: "10115",
  addressCountryCode: "DE",
  idType: "passport" as const,
  idNumber: "X1234567",
  idCountryCode: "DE",
  mobileNumber: "+4915112345678",
  emailAddress: "miriam@example.com",
};

console.log(`anchor: ${domain}\n`);

const treasury = await getTreasury();
const memo = senderMemo(baseUser());
const jwt = await sep10Auth(domain, treasury, { memo });
const declared = await sep12CustomerFields(domain, jwt, treasury.publicKey(), "sep24-customer", memo);
const required = Object.entries(declared.fields)
  .filter(([, f]) => f.optional !== true)
  .map(([n]) => n);

console.log("SEP-12 — what the anchor actually asks for:");
await t("the anchor declares SEP-9 fields, including required ones", async () => {
  assert.ok(Object.keys(declared.fields).length > 0, "anchor declared no fields at all");
  assert.ok(required.length > 0, `expected at least one REQUIRED field, got: ${JSON.stringify(declared.fields).slice(0,200)}`);
  console.log(`      ${Object.keys(declared.fields).length} declared · required: ${required.join(", ")}`);
});

console.log("the gap this closes:");
await t("a user with no sender profile is missing required fields", async () => {
  const missing = missingRequiredFields(declared.fields, senderProfileToSep9(baseUser()));
  assert.ok(missing.length > 0, "a profileless user should not satisfy the anchor");
  console.log(`      missing without a profile: ${missing.join(", ")}`);
});

await t("a complete profile satisfies every required field", async () => {
  const user = baseUser({ senderProfile: fullProfile } as any);
  const missing = missingRequiredFields(declared.fields, senderProfileToSep9(user));
  assert.deepEqual(missing, [], `still missing: ${missing.join(", ")}`);
});

await t("a partial profile is still refused, naming what is absent", async () => {
  // Names only — no contact details.
  const user = baseUser({
    email: undefined,
    senderProfile: { firstName: "Miriam", lastName: "Zoldenburg" },
  } as any);
  const missing = missingRequiredFields(declared.fields, senderProfileToSep9(user));
  assert.ok(missing.length > 0, "a name-only profile should not satisfy the anchor");
  assert.ok(!missing.includes("first_name"), "first_name was supplied and should not be reported missing");
});

console.log("SEP-9 mapping:");
await t("our stored profile maps onto SEP-9 field names the anchor knows", async () => {
  const mapped = senderProfileToSep9(baseUser({ senderProfile: fullProfile } as any));
  for (const [k, v] of Object.entries(mapped)) {
    if (v === undefined) continue;
    assert.ok(k in declared.fields, `we would send "${k}", which ${domain} does not declare`);
  }
  assert.equal(mapped.first_name, "Miriam");
  assert.equal(mapped.birth_date, "1990-04-12");
  assert.equal(mapped.id_number, "X1234567");
});

await t("country falls back to the account country, converted to alpha-3", async () => {
  const mapped = senderProfileToSep9(
    baseUser({ country: "FR", senderProfile: { firstName: "A", lastName: "B" } } as any),
  );
  // The account stores alpha-2; SEP-9 transmits alpha-3.
  assert.equal(mapped.address_country_code, "FRA");
});

await t("no document images are ever mapped for transmission", async () => {
  const mapped = senderProfileToSep9(baseUser({ senderProfile: fullProfile } as any));
  for (const k of ["photo_id_front", "photo_id_back", "photo_proof_residence", "proof_of_liveness"]) {
    assert.equal(mapped[k], undefined, `${k} must never be sent from this store`);
  }
});

console.log("live transmission:");
await t("submitSenderProfile refuses rather than transmitting a partial profile", async () => {
  const user = baseUser({ email: undefined, senderProfile: { firstName: "Miriam", lastName: "Zoldenburg" } } as any);
  const result = await submitSenderProfile(domain, jwt, treasury.publicKey(), user);
  assert.ok(result.missing.length > 0, "expected a refusal listing missing fields");
});

await t("a complete profile is accepted by the anchor", async () => {
  const user = baseUser({ senderProfile: fullProfile } as any);
  const result = await submitSenderProfile(domain, jwt, treasury.publicKey(), user);
  assert.deepEqual(result.missing, []);
  const after = await sep12CustomerFields(domain, jwt, treasury.publicKey(), "sep24-customer", memo);
  assert.equal(after.status, "ACCEPTED", `anchor customer status is ${after.status}, expected ACCEPTED`);
  console.log(`      anchor now holds ${Object.keys(after.providedFields).length} fields · status ${after.status}`);
});

await t("each user is a SEPARATE customer at the anchor (memo isolation)", async () => {
  const other = baseUser({ id: `${RUN_ID}-other` } as any);
  const otherMemo = senderMemo(other);
  assert.notEqual(otherMemo, memo, "two users must not share a SEP-12 memo");
  const otherJwt = await sep10Auth(domain, treasury, { memo: otherMemo });
  const otherView = await sep12CustomerFields(domain, otherJwt, treasury.publicKey(), "sep24-customer", otherMemo);
  // The first user was just ACCEPTED. A second user on the same treasury
  // account must NOT inherit that — otherwise we would transmit one person's
  // identity for another person's payout.
  assert.notEqual(
    otherView.status,
    "ACCEPTED",
    "a second user inherited the first user's KYC — memo isolation is not working",
  );
  console.log(`      user A: ACCEPTED · user B: ${otherView.status} (correctly separate)`);
});

await t("the derived memo is a valid SEP-10 positive integer and is stable", async () => {
  assert.match(memo, /^[1-9]\d*$/);
  assert.equal(senderMemo(baseUser()), memo, "memo must be stable for the same user");
});


console.log("MoneyGram's documented shape (docs differ from this test anchor):");
await t("country codes are ISO alpha-3, as SEP-9 and MoneyGram specify", async () => {
  // The app stores alpha-2 for a user's country; SEP-9 wants alpha-3.
  assert.equal(toAlpha3("DE"), "DEU");
  assert.equal(toAlpha3("US"), "USA");
  assert.equal(toAlpha3("KEN"), "KEN", "an alpha-3 code should pass through");
  const mapped = senderProfileToSep9(baseUser({ senderProfile: fullProfile } as any));
  assert.equal(mapped.address_country_code, "DEU", "must not send the alpha-2 form");
});

await t("an unmappable country is omitted, never guessed", async () => {
  assert.equal(toAlpha3("XX"), undefined);
  const mapped = senderProfileToSep9(
    baseUser({ country: "XX", senderProfile: { firstName: "A", lastName: "B" } } as any),
  );
  assert.equal(mapped.address_country_code, undefined,
    "a country we cannot map must be omitted — a wrong one is worse than none");
});

await t("the MoneyGram body carries only its nine documented fields", async () => {
  const body = moneygramSep9(senderProfileToSep9(baseUser({ senderProfile: fullProfile } as any)));
  for (const k of Object.keys(body)) {
    assert.ok(
      (MONEYGRAM_SEP9_FIELDS as readonly string[]).includes(k),
      `"${k}" is not a field MoneyGram documents`,
    );
  }
  // These are real SEP-9 names that MoneyGram does not list — including the
  // identity-document fields, which it never asks us to transmit.
  for (const k of ["email_address", "id_type", "id_number", "id_country_code", "occupation"]) {
    assert.equal(body[k], undefined, `${k} must not go in the MoneyGram body`);
  }
  assert.equal(body.first_name, "Miriam");
});

await t("state_or_province is dropped outside USA/CAN/MEX", async () => {
  const german = moneygramSep9({ address_country_code: "DEU", state_or_province: "DE-BE" });
  assert.equal(german.state_or_province, undefined, "Germany has no ISO-3166-2 field at MoneyGram");
  const american = moneygramSep9({ address_country_code: "USA", state_or_province: "US-MN" });
  assert.equal(american.state_or_province, "US-MN");
});

await t("custodial auth omits home_domain, as MoneyGram requires", async () => {
  // Both shapes must still authenticate against a real anchor.
  const custodial = await sep10Auth(domain, treasury, { memo });
  assert.equal(custodial.split(".").length, 3, "custodial auth (no home_domain) should work");
  const nonCustodial = await sep10Auth(domain, treasury, { sendHomeDomain: true });
  assert.equal(nonCustodial.split(".").length, 3, "non-custodial auth (home_domain) should work");
});

console.log(`\nTRAVEL RULE TEST PASSED — ${pass}/${pass}: sender data is required, mapped and transmitted`);
console.log(`note: ${domain} requires ${required.length} field(s). MoneyGram production requires more —`);
console.log("      the missing-field check is driven by the anchor's own list, so it adapts.");
