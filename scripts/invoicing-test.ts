/**
 * German invoice compliance, proved offline.
 *
 * These checks encode rules with money attached: a missing mandatory field
 * costs the CUSTOMER their input-tax deduction (§ 14 Abs. 4 UStG), and a VAT
 * amount shown on an exempt invoice makes the ISSUER liable for tax they never
 * collected (§ 14c UStG). Both are silent failures — nothing bounces, the
 * damage shows up months later — so they are pinned here.
 *
 *   npm run invoicing:test
 */

import assert from "node:assert/strict";
import {
  EU_MEMBER_STATES,
  jurisdictionFor,
  validateCustomReason,
} from "../services/api/src/domain/jurisdictions.js";
import {
  DEFAULT_SERIES,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  KLEINBETRAG_LIMIT_CENTS,
  checkCompliance,
  computeTotals,
  formatInvoiceNumber,
  fromCents,
  isEuCountry,
  normaliseVatId,
  taxNumberLooksValid,
  toCents,
  vatIdLooksValid,
  vatNoteFor,
  type InvoiceDraft,
  type VatTreatment,
} from "../services/api/src/domain/invoicing.js";

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

const issuer = {
  name: "Acme GmbH",
  addressLine: "Hauptstraße 1",
  postalCode: "93047",
  city: "Regensburg",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: "1234567890",
};
const recipient = {
  name: "Kunde AG",
  addressLine: "Musterweg 9",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

const draft = (over: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  number: "RE-2026-0001",
  issueDate: "2026-08-30",
  supplyDate: "2026-08-28",
  issuer,
  recipient,
  lines: [{ description: "Beratung", quantity: "10", unitPriceNet: "100.00" }],
  treatment: { kind: "standard", rate: 19 },
  ...over,
});

console.log("\nArithmetic");

check("VAT is computed in integer cents", () => {
  assert.equal(toCents("100.00"), 10000);
  assert.equal(toCents("0.01"), 1);
  assert.equal(fromCents(11900), "119.00");
});

check("19% on 1000.00 is exactly 190.00", () => {
  const t = computeTotals(
    [{ description: "x", quantity: "10", unitPriceNet: "100.00" }],
    { kind: "standard", rate: 19 },
  );
  assert.equal(t.netCents, 100000);
  assert.equal(t.vatCents, 19000);
  assert.equal(t.grossCents, 119000);
});

check("mixed 19% and 7% produce a per-rate breakdown (§ 14 Abs. 4 Nr. 8)", () => {
  const t = computeTotals(
    [
      { description: "Beratung", quantity: "1", unitPriceNet: "100.00", vatRate: 19 },
      { description: "Buch", quantity: "2", unitPriceNet: "10.00", vatRate: 7 },
    ],
    { kind: "standard", rate: 19 },
  );
  assert.equal(t.buckets.length, 2, "one bucket per rate");
  const b19 = t.buckets.find((b) => b.rate === 19)!;
  const b7 = t.buckets.find((b) => b.rate === 7)!;
  assert.equal(b19.netCents, 10000);
  assert.equal(b19.vatCents, 1900);
  assert.equal(b7.netCents, 2000);
  assert.equal(b7.vatCents, 140);
  assert.equal(t.vatCents, 2040);
});

check("line VAT sums exactly to the bucket — no rounding drift", () => {
  const t = computeTotals(
    [
      { description: "a", quantity: "1", unitPriceNet: "0.03" },
      { description: "b", quantity: "1", unitPriceNet: "0.03" },
      { description: "c", quantity: "1", unitPriceNet: "0.03" },
    ],
    { kind: "standard", rate: 19 },
  );
  const summed = t.lines.reduce((s, l) => s + l.vatCents, 0);
  assert.equal(summed, t.vatCents, "per-line VAT must add up to the total");
  assert.equal(t.vatCents, t.buckets[0].vatCents);
});

check("an exempt invoice forces every line to 0%, even one carrying a rate", () => {
  const t = computeTotals(
    [{ description: "x", quantity: "1", unitPriceNet: "100.00", vatRate: 19 }],
    { kind: "exempt", reason: "kleinunternehmer" },
  );
  assert.equal(t.vatCents, 0, "a stray line rate must not create tax");
  assert.equal(t.grossCents, t.netCents);
});

check("arithmetic accepts any plausible rate — WHICH rates are legal is a jurisdiction question", () => {
  // 23% is wrong in Germany and right in Poland, so computeTotals must not
  // decide it; checkCompliance does, per rule set (see the jurisdiction tests).
  const pl = computeTotals(
    [{ description: "x", quantity: "1", unitPriceNet: "100.00", vatRate: 23 }],
    { kind: "standard", rate: 23 },
  );
  assert.equal(pl.vatCents, 2300);
  // A non-percentage is still nonsense everywhere.
  for (const bad of [-5, 101]) {
    assert.throws(
      () =>
        computeTotals(
          [{ description: "x", quantity: "1", unitPriceNet: "10.00", vatRate: bad }],
          { kind: "standard", rate: bad },
        ),
      InvoiceComplianceError,
      `${bad}% should be refused`,
    );
  }
});

console.log("\n§ 14 Abs. 4 UStG — mandatory content");

check("a complete invoice passes", () => {
  const r = checkCompliance(draft());
  assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
  assert.equal(r.regime, "standard");
});

check("each missing mandatory field is reported with its statute", () => {
  const cases: [Partial<InvoiceDraft>, string, RegExp][] = [
    [{ number: undefined }, "number", /Nr\. 4/],
    [{ issueDate: undefined }, "issueDate", /Nr\. 3/],
    [{ supplyDate: undefined, supplyPeriod: undefined }, "supplyDate", /Nr\. 6/],
    [{ recipient: { ...recipient, name: undefined } }, "recipient.name", /Nr\. 1/],
    [{ issuer: { ...issuer, city: undefined } }, "issuer.address", /Nr\. 1/],
    [{ issuer: { ...issuer, vatId: undefined, taxNumber: undefined } }, "issuer.taxId", /Nr\. 2/],
  ];
  for (const [over, field, basis] of cases) {
    const r = checkCompliance(draft(over));
    const hit = r.errors.find((e) => e.field === field);
    assert.ok(hit, `${field} should be reported missing`);
    assert.match(hit!.legalBasis ?? "", basis, `${field} should cite the statute`);
  }
});

check("the supply date is required even when it equals the invoice date", () => {
  const r = checkCompliance(draft({ supplyDate: undefined }));
  assert.ok(r.errors.some((e) => e.field === "supplyDate"));
  assert.equal(checkCompliance(draft({ supplyDate: "2026-08-30" })).ok, true);
});

check("a supply PERIOD satisfies the same requirement", () => {
  const r = checkCompliance(
    draft({ supplyDate: undefined, supplyPeriod: { from: "2026-08-01", to: "2026-08-31" } }),
  );
  assert.equal(r.ok, true);
});

console.log("\n§ 33 UStDV — Kleinbetragsrechnung");

check("at or under €250 gross, recipient / number / supply date are not required", () => {
  const r = checkCompliance(
    draft({
      lines: [{ description: "Kleinteil", quantity: "1", unitPriceNet: "100.00" }],
      number: undefined,
      supplyDate: undefined,
      recipient: {},
    }),
  );
  assert.equal(r.regime, "kleinbetrag");
  assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
  assert.ok(r.totals.grossCents <= KLEINBETRAG_LIMIT_CENTS);
});

check("one cent over the limit and the full §14 content applies again", () => {
  // 210.09 net at 19% = 250.01 gross.
  const r = checkCompliance(
    draft({
      lines: [{ description: "x", quantity: "1", unitPriceNet: "210.10" }],
      number: undefined,
      recipient: {},
    }),
  );
  assert.equal(r.regime, "standard");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "number"));
});

console.log("\n§ 14c UStG — never show tax that is not owed");

check("an exempt invoice can never carry a VAT amount", () => {
  for (const [reason, def] of Object.entries(EXEMPTION_REASONS)) {
    if (def.requiresFreeText) continue;
    const t: VatTreatment = { kind: "exempt", reason: reason as never };
    const totals = computeTotals(
      [{ description: "x", quantity: "1", unitPriceNet: "500.00", vatRate: 19 }],
      t,
    );
    assert.equal(totals.vatCents, 0, `${reason} must produce no tax`);
  }
});

check("charging VAT with a zero total is refused rather than printed as 0%", () => {
  const r = checkCompliance(
    draft({ lines: [{ description: "gratis", quantity: "1", unitPriceNet: "0.00" }] }),
  );
  assert.ok(r.errors.some((e) => e.legalBasis === "§ 14c UStG"));
});

console.log("\nExemptions");

check("Kleinunternehmer prints the § 19 note and needs no VAT ID", () => {
  const t: VatTreatment = { kind: "exempt", reason: "kleinunternehmer" };
  const r = checkCompliance(
    draft({ treatment: t, issuer: { ...issuer, vatId: undefined } }),
  );
  assert.equal(r.regime, "kleinunternehmer");
  assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
  assert.match(vatNoteFor(t), /§ 19 UStG/);
  assert.equal(r.totals.vatCents, 0);
});

check("Kleinunternehmer with no tax id is a warning, not an error (§ 34a UStDV)", () => {
  const r = checkCompliance(
    draft({
      treatment: { kind: "exempt", reason: "kleinunternehmer" },
      issuer: { ...issuer, vatId: undefined, taxNumber: undefined },
    }),
  );
  assert.equal(r.ok, true);
  const w = r.warnings.find((x) => x.field === "issuer.taxId");
  assert.ok(w);
  assert.equal(w!.legalBasis, "§ 34a UStDV");
});

check("EU reverse charge prints the exact statutory phrase", () => {
  assert.equal(
    vatNoteFor({ kind: "exempt", reason: "reverse_charge_eu" }),
    "Steuerschuldnerschaft des Leistungsempfängers",
    "the wording is prescribed, not decorative",
  );
  assert.match(
    vatNoteFor({ kind: "exempt", reason: "reverse_charge_eu" }, "en"),
    /Reverse charge/,
  );
});

check("EU reverse charge demands BOTH VAT IDs", () => {
  const t: VatTreatment = { kind: "exempt", reason: "reverse_charge_eu" };
  const missing = checkCompliance(
    draft({ treatment: t, recipient: { ...recipient, country: "FR" } }),
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.field === "recipient.vatId"));

  const complete = checkCompliance(
    draft({ treatment: t, recipient: { ...recipient, country: "FR", vatId: "FR12345678901" } }),
  );
  assert.equal(complete.ok, true, complete.errors.map((e) => e.message).join("; "));

  const noIssuerId = checkCompliance(
    draft({
      treatment: t,
      issuer: { ...issuer, vatId: undefined },
      recipient: { ...recipient, country: "FR", vatId: "FR12345678901" },
    }),
  );
  assert.ok(noIssuerId.errors.some((e) => e.field === "issuer.vatId"));
});

check("reverse charge to a German customer is flagged as probably wrong", () => {
  const r = checkCompliance(
    draft({
      treatment: { kind: "exempt", reason: "reverse_charge_eu" },
      recipient: { ...recipient, country: "DE", vatId: "DE987654321" },
    }),
  );
  assert.ok(r.warnings.some((w) => w.field === "recipient.country"));
});

check("export is flagged when the customer is inside the EU", () => {
  const r = checkCompliance(
    draft({
      treatment: { kind: "exempt", reason: "export_third_country" },
      recipient: { ...recipient, country: "IT" },
    }),
  );
  assert.ok(r.warnings.some((w) => w.field === "recipient.country"));
  assert.equal(
    checkCompliance(
      draft({
        treatment: { kind: "exempt", reason: "export_third_country" },
        recipient: { ...recipient, country: "US" },
      }),
    ).warnings.filter((w) => w.field === "recipient.country").length,
    0,
  );
});

check('"other" forces the issuer to write the basis themselves', () => {
  const blank = checkCompliance(draft({ treatment: { kind: "exempt", reason: "other" } }));
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.some((e) => e.field === "treatment.note"));

  const written = checkCompliance(
    draft({ treatment: { kind: "exempt", reason: "other", note: "Steuerfrei nach § 4 Nr. 21 UStG" } }),
  );
  assert.equal(written.ok, true);
});

check("a reason either ships its wording, or demands the issuer supply it", () => {
  for (const r of Object.values(EXEMPTION_REASONS)) {
    if (r.requiresFreeText) {
      // Free-text reasons are deliberately blank: the note that satisfies the
      // law differs per country, and inventing one would be confidently wrong.
      assert.equal(r.invoiceNote, "", `${r.id} must not ship invented wording`);
      continue;
    }
    assert.ok(r.legalBasis && r.legalBasis !== "—", `${r.id} needs a legal basis`);
    assert.ok(r.invoiceNote.length > 5, `${r.id} needs a German note`);
    assert.ok(r.invoiceNoteEn.length > 5, `${r.id} needs an English note`);
  }
  // And the free-text ones are refused until the issuer writes something.
  const blank = checkCompliance(
    draft({
      issuer: { ...issuer, country: "SE" },
      treatment: { kind: "exempt", reason: "small_business_national" },
    }),
    jurisdictionFor("SE"),
  );
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.some((e) => e.field === "treatment.note"));
});

console.log("\nIdentifiers and numbering");

check("German VAT IDs are DE + 9 digits; others are shape-checked", () => {
  assert.equal(vatIdLooksValid("DE123456789"), true);
  assert.equal(vatIdLooksValid("DE12345678"), false, "eight digits is not enough");
  assert.equal(vatIdLooksValid("DE1234567890"), false, "ten is too many");
  assert.equal(vatIdLooksValid("FR12345678901"), true);
  assert.equal(vatIdLooksValid("nonsense"), false);
  assert.equal(normaliseVatId(" de 123.456-789 "), "DE123456789");
});

check("a Steuernummer is 10 to 13 digits, punctuation ignored", () => {
  assert.equal(taxNumberLooksValid("123/456/78901"), true);
  assert.equal(taxNumberLooksValid("12345"), false);
});

check("EU membership drives the reverse-charge warnings", () => {
  assert.equal(isEuCountry("FR"), true);
  assert.equal(isEuCountry("DE"), true);
  assert.equal(isEuCountry("GB"), false, "post-Brexit");
  assert.equal(isEuCountry("CH"), false);
  assert.equal(isEuCountry(undefined), false);
});

check("invoice numbers template the year, and pad", () => {
  const n = formatInvoiceNumber(DEFAULT_SERIES, new Date("2026-08-30T00:00:00Z"));
  assert.equal(n, "RE-2026-0001");
  assert.equal(
    formatInvoiceNumber({ prefix: "{YY}{MM}-", next: 42, padding: 3 }, new Date("2026-03-05T00:00:00Z")),
    "2603-042",
  );
});


console.log("\nJurisdiction — which rules even apply");

check("Germany gets statutory rules, and its own paragraphs", () => {
  const j = jurisdictionFor("DE");
  assert.equal(j.ruleSet, "DE");
  assert.equal(j.verification, "statutory");
  assert.ok(j.reasons.includes("kleinunternehmer"));
  assert.ok(j.reasons.includes("reverse_charge_domestic"));
  assert.equal(j.simplifiedLimitCents, 25000, "§ 33 UStDV, checked");
});

check("another EU state gets the Directive baseline, NOT German paragraphs", () => {
  for (const code of ["PL", "SE", "FR"]) {
    const j = jurisdictionFor(code);
    assert.equal(j.ruleSet, "EU", `${code} should be EU`);
    assert.equal(j.verification, "directive");
    assert.equal(j.inEu, true);
    assert.ok(!j.reasons.includes("kleinunternehmer"), `${code} must not be offered § 19 UStG`);
    assert.ok(!j.reasons.includes("reverse_charge_domestic"), `${code} must not be offered § 13b`);
    assert.ok(j.reasons.includes("reverse_charge_eu"));
    assert.ok(j.reasons.includes("small_business_national"), "its own scheme, its own wording");
    assert.equal(j.simplifiedLimitCents, undefined, "we have not checked its threshold");
    assert.match(j.disclaimer, new RegExp(EU_MEMBER_STATES[code]));
  }
});

check("outside the EU nothing is claimed — structural checks only", () => {
  const j = jurisdictionFor("IN");
  assert.equal(j.ruleSet, "GENERIC");
  assert.equal(j.verification, "structural");
  assert.equal(j.inEu, false);
  assert.deepEqual(j.reasons.sort(), ["export_third_country", "other"]);
  assert.match(j.notVerified.join(" "), /GSTIN/, "India's actual requirements are named");
  assert.match(j.disclaimer, /does not encode the tax rules/);
});

check("an unknown country still resolves, and promises nothing", () => {
  const j = jurisdictionFor(undefined);
  assert.equal(j.ruleSet, "GENERIC");
  assert.ok(j.notVerified.length);
});

check("every jurisdiction names what it does NOT check", () => {
  for (const code of ["DE", "PL", "IN", "US"]) {
    const j = jurisdictionFor(code);
    assert.ok(j.notVerified.length >= 2, `${code} should name its gaps`);
    assert.ok(j.basis.length > 5);
  }
});

console.log("\nRules follow the issuer's country");

const plIssuer = { ...issuer, country: "PL", vatId: "PL1234567890" };

check("a German exemption is REFUSED for a Polish entity", () => {
  const r = checkCompliance(
    draft({
      issuer: plIssuer,
      treatment: { kind: "exempt", reason: "kleinunternehmer" },
    }),
    jurisdictionFor("PL"),
  );
  assert.equal(r.ok, false);
  const hit = r.errors.find((e) => e.field === "treatment");
  assert.ok(hit, "picking § 19 UStG in Poland must be refused");
  assert.match(hit!.message, /not part of the Poland rule set/);
});

check("the EU-wide reasons still work for a Polish entity", () => {
  const r = checkCompliance(
    draft({
      issuer: plIssuer,
      recipient: { ...recipient, country: "FR", vatId: "FR12345678901" },
      treatment: { kind: "exempt", reason: "reverse_charge_eu" },
    }),
    jurisdictionFor("PL"),
  );
  assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
  assert.equal(r.jurisdiction.ruleSet, "EU");
});

check("citations follow the rule set — no German paragraphs outside Germany", () => {
  const de = checkCompliance(draft({ number: undefined }), jurisdictionFor("DE"));
  assert.match(de.errors.find((e) => e.field === "number")!.legalBasis!, /UStG/);

  const pl = checkCompliance(
    draft({ issuer: plIssuer, number: undefined }),
    jurisdictionFor("PL"),
  );
  const plHit = pl.errors.find((e) => e.field === "number")!;
  assert.match(plHit.legalBasis!, /VAT Directive/, "cite the Directive, not the UStG");
  assert.doesNotMatch(plHit.legalBasis!, /UStG/);

  const inn = checkCompliance(
    draft({ issuer: { ...issuer, country: "IN" }, number: undefined }),
    jurisdictionFor("IN"),
  );
  assert.equal(
    inn.errors.find((e) => e.field === "number")!.legalBasis,
    undefined,
    "no law is being applied, so none is cited",
  );
});

check("the €250 simplified shortcut is German-only", () => {
  const small = { lines: [{ description: "Kleinteil", quantity: "1", unitPriceNet: "100.00" }], number: undefined, supplyDate: undefined, recipient: {} };
  assert.equal(checkCompliance(draft(small), jurisdictionFor("DE")).regime, "kleinbetrag");
  const pl = checkCompliance(draft({ ...small, issuer: plIssuer }), jurisdictionFor("PL"));
  assert.equal(pl.regime, "standard", "we have not checked Poland's threshold");
  assert.equal(pl.ok, false);
});

check("German rates are enforced in Germany and not asserted elsewhere", () => {
  const deBad = checkCompliance(
    draft({ treatment: { kind: "standard", rate: 23 } }),
    jurisdictionFor("DE"),
  );
  assert.equal(deBad.ok, false);
  assert.match(deBad.errors.find((e) => e.field === "treatment")!.message, /not a German rate/);

  const plOk = checkCompliance(
    draft({ issuer: plIssuer, treatment: { kind: "standard", rate: 23 } }),
    jurisdictionFor("PL"),
  );
  assert.equal(plOk.ok, true, plOk.errors.map((e) => e.message).join("; "));
  assert.equal(plOk.totals.vatCents, 23000, "23% of 1000.00");
});

check("every result reports how far it checked", () => {
  assert.equal(checkCompliance(draft(), jurisdictionFor("DE")).jurisdiction.verification, "statutory");
  assert.equal(
    checkCompliance(draft({ issuer: plIssuer }), jurisdictionFor("PL")).jurisdiction.verification,
    "directive",
  );
  const generic = checkCompliance(
    draft({ issuer: { ...issuer, country: "IN" }, treatment: { kind: "exempt", reason: "other", note: "GST reverse charge" } }),
    jurisdictionFor("IN"),
  );
  assert.equal(generic.jurisdiction.verification, "structural");
  assert.equal(generic.ok, true, "coherent — which is all we claim");
  assert.ok(generic.jurisdiction.notVerified.length, "and it says what it did not check");
});

console.log("\nCustom rules for countries we do not encode");

check("a custom rule needs an id, a label and the note it prints", () => {
  assert.throws(() => validateCustomReason({ id: "X", label: "a", invoiceNote: "n" }), /id of 2 to 40/);
  assert.throws(() => validateCustomReason({ id: "gst_rcm", label: "Reverse charge", invoiceNote: "" }), /note to print/);
  const ok = validateCustomReason({
    id: "gst_rcm",
    label: "GST reverse charge",
    legalBasis: "Section 9(3) CGST Act",
    invoiceNote: "Tax payable under reverse charge mechanism",
  });
  assert.equal(ok.id, "gst_rcm");
});

check("a custom rule is accepted where a built-in one would not be", () => {
  const custom = [
    validateCustomReason({
      id: "gst_rcm",
      label: "GST reverse charge",
      legalBasis: "Section 9(3) CGST Act",
      invoiceNote: "Tax payable under reverse charge mechanism",
      requiresRecipientVatId: true,
    }),
  ];
  const inIssuer = { ...issuer, country: "IN" };

  const missingId = checkCompliance(
    draft({ issuer: inIssuer, treatment: { kind: "exempt", reason: "gst_rcm" } }),
    jurisdictionFor("IN"),
    custom,
  );
  assert.equal(missingId.ok, false, "the custom rule's own requirement is enforced");
  assert.ok(missingId.errors.some((e) => e.field === "recipient.vatId"));

  const good = checkCompliance(
    draft({
      issuer: inIssuer,
      recipient: { ...recipient, country: "IN", vatId: "IN1234567890" },
      treatment: { kind: "exempt", reason: "gst_rcm" },
    }),
    jurisdictionFor("IN"),
    custom,
  );
  assert.equal(good.ok, true, good.errors.map((e) => e.message).join("; "));
  assert.equal(
    vatNoteFor({ kind: "exempt", reason: "gst_rcm" }, "en", custom),
    "Tax payable under reverse charge mechanism",
    "the user's wording is what prints",
  );
});

check("an unknown reason is refused rather than printed blank", () => {
  const r = checkCompliance(
    draft({ treatment: { kind: "exempt", reason: "made_up" } }),
    jurisdictionFor("DE"),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not a known exemption reason/.test(e.message)));
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
console.log("NOT COVERED: XRechnung / ZUGFeRD (EN 16931) e-invoicing. German B2B must already");
console.log("be able to RECEIVE e-invoices; the obligation to ISSUE them phases in from 2027.\n");
