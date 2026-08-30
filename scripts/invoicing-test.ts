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

check("a rate other than 19 or 7 is refused", () => {
  assert.throws(
    () =>
      computeTotals(
        [{ description: "x", quantity: "1", unitPriceNet: "10.00", vatRate: 20 as never }],
        { kind: "standard", rate: 19 },
      ),
    InvoiceComplianceError,
  );
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
  for (const reason of Object.keys(EXEMPTION_REASONS)) {
    if (reason === "other") continue;
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

check("every exemption reason carries a statute and a printable note", () => {
  for (const r of Object.values(EXEMPTION_REASONS)) {
    if (r.id === "other") continue;
    assert.ok(r.legalBasis && r.legalBasis !== "—", `${r.id} needs a legal basis`);
    assert.ok(r.invoiceNote.length > 5, `${r.id} needs a German note`);
    assert.ok(r.invoiceNoteEn.length > 5, `${r.id} needs an English note`);
  }
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

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
console.log("NOT COVERED: XRechnung / ZUGFeRD (EN 16931) e-invoicing. German B2B must already");
console.log("be able to RECEIVE e-invoices; the obligation to ISSUE them phases in from 2027.\n");
