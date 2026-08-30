/**
 * Which invoicing rules apply, and — just as important — how far we actually
 * check them.
 *
 * THE MISTAKE THIS FIXES: the first cut applied German law to everyone. A
 * Polish or Swedish entity was offered "§ 19 UStG Kleinunternehmerregelung" and
 * a 19% rate, and an Indian one was offered German exemptions with no mention
 * of GST. That is worse than offering nothing, because it looks authoritative.
 *
 * THREE RULE SETS, and the difference between them is the difference between
 * what we encode and what we merely carry:
 *
 *   DE       statutory  — actual German paragraphs are encoded and enforced.
 *   EU       directive  — the VAT Directive baseline every member state shares
 *                         (Art. 226 particulars, Art. 196 reverse charge,
 *                         Art. 138 intra-community, Art. 146 export). National
 *                         additions are NOT encoded, because there are 26 other
 *                         sets of them and we have verified none.
 *   GENERIC  structural — the document is checked for internal coherence only:
 *                         both parties, a number, dates, and arithmetic that
 *                         adds up. NO tax law is checked. India's GST, US sales
 *                         tax, UK VAT and everything else land here.
 *
 * Every report says which of these ran, so "valid" never means more than it
 * should. A rule set is a claim about our own coverage, not about the law.
 *
 * DELIBERATELY NOT SHIPPED: a table of VAT rates per country. Rates change by
 * statute and we would be asserting 27 numbers we have not checked; an org sets
 * its own rates instead, and outside Germany we validate that a rate is a
 * plausible percentage rather than pretending to know the right one.
 */

/** ISO 3166-1 alpha-2 for the 27 EU member states. Membership is stable enough
 *  to encode; rates and national rules are not. */
export const EU_MEMBER_STATES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus",
  CZ: "Czechia", DK: "Denmark", EE: "Estonia", FI: "Finland", FR: "France",
  DE: "Germany", GR: "Greece", HU: "Hungary", IE: "Ireland", IT: "Italy",
  LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MT: "Malta",
  NL: "Netherlands", PL: "Poland", PT: "Portugal", RO: "Romania",
  SK: "Slovakia", SI: "Slovenia", ES: "Spain", SE: "Sweden",
};

export type RuleSetId = "DE" | "EU" | "GENERIC";

/** How far our checking goes. Reported on every compliance result. */
export type VerificationLevel = "statutory" | "directive" | "structural";

export interface JurisdictionProfile {
  country: string;
  countryName: string;
  ruleSet: RuleSetId;
  verification: VerificationLevel;
  inEu: boolean;
  /** Exemption reasons offered here, by id (see invoicing.ts). */
  reasons: string[];
  /**
   * Simplified-invoice threshold in cents, where we have actually checked it.
   * Only Germany's §33 UStDV is encoded; the EU permits member states to set
   * their own up to €400 and we have not checked the other 26.
   */
  simplifiedLimitCents?: number;
  /** One line naming the body of rules being applied. */
  basis: string;
  /** Shown prominently wherever invoices are issued. */
  disclaimer: string;
  /** Named gaps. Rendered verbatim — vagueness here is the failure mode. */
  notVerified: string[];
}

/** Reasons grounded in the EU VAT Directive, so shared by every member state. */
const EU_REASONS = [
  "reverse_charge_eu",
  "intra_community_supply",
  "export_third_country",
  "not_taxable_place_of_supply",
  "small_business_national",
  "other",
];

/** Germany adds its own two, with paragraph-level citations we have checked. */
const DE_REASONS = [
  "kleinunternehmer",
  "reverse_charge_eu",
  "reverse_charge_domestic",
  "intra_community_supply",
  "export_third_country",
  "not_taxable_place_of_supply",
  "other",
];

const GENERIC_DISCLAIMER =
  "Zold does not encode the tax rules of this country. The invoice is checked only for internal " +
  "coherence — both parties present, a number, dates, and arithmetic that adds up. Whether it " +
  "satisfies local invoicing law is entirely yours to determine, with your accountant.";

export function jurisdictionFor(country?: string): JurisdictionProfile {
  const code = (country ?? "").toUpperCase();

  if (code === "DE") {
    return {
      country: "DE",
      countryName: "Germany",
      ruleSet: "DE",
      verification: "statutory",
      inEu: true,
      reasons: DE_REASONS,
      simplifiedLimitCents: 250_00, // § 33 UStDV
      basis: "§§ 14, 14a UStG, § 33 UStDV, § 34a UStDV",
      disclaimer:
        "Zold is not a tax adviser. These fields follow §§ 14, 14a UStG and the related rules, but " +
        "whether a supply is exempt — and which exemption applies — is your decision with your Steuerberater.",
      notVerified: [
        "Whether the exemption you choose actually applies to the supply.",
        "Whether your customer's VAT ID is valid and registered (no VIES check is performed).",
        "XRechnung / ZUGFeRD (EN 16931). German B2B must already be able to receive e-invoices; " +
          "the obligation to issue them phases in from 2027.",
      ],
    };
  }

  if (EU_MEMBER_STATES[code]) {
    const name = EU_MEMBER_STATES[code];
    return {
      country: code,
      countryName: name,
      ruleSet: "EU",
      verification: "directive",
      inEu: true,
      reasons: EU_REASONS,
      // Member states may set their own simplified-invoice threshold; we have
      // not checked 26 of them, so no shortcut is offered.
      basis: "EU VAT Directive 2006/112/EC, Art. 226 and 226b",
      disclaimer:
        `Zold checks this invoice against the EU VAT Directive baseline that every member state ` +
        `shares. It does NOT encode ${name}'s national rules, which exist and differ — including ` +
        `its VAT rates, its small-business scheme and any national e-invoicing mandate. Add what ` +
        `${name} requires as your own fields and notes, and check the result with your accountant.`,
      notVerified: [
        `${name}'s national invoicing rules, thresholds and required wording.`,
        `${name}'s VAT rates — you set the rates you charge; we do not maintain a rate table.`,
        `${name}'s small-business scheme: the threshold and the required note differ per state, ` +
          "so you supply the wording.",
        "National e-invoicing mandates (for example Poland's KSeF or Italy's SdI), which we do not produce.",
        "Whether your customer's VAT ID is valid and registered (no VIES check is performed).",
      ],
    };
  }

  return {
    country: code || "??",
    countryName: code ? countryName(code) : "an unsupported country",
    ruleSet: "GENERIC",
    verification: "structural",
    inEu: false,
    // Only the reasons that mean something outside an EU VAT context: an export
    // and a free-text basis. Offering "reverse charge" here would be importing
    // an EU concept into a country that may not have it.
    reasons: ["export_third_country", "other"],
    basis: "No tax rules encoded — structural checks only",
    disclaimer: GENERIC_DISCLAIMER,
    notVerified: [
      "All local tax law. Nothing about this document is checked against it.",
      code === "IN"
        ? "India's GST in particular: GSTIN of both parties, HSN/SAC codes, place of supply and the " +
          "CGST/SGST/IGST split are required there and are not modelled here. Add them as custom fields."
        : "Locally mandated fields, wording, numbering rules and tax splits.",
      "Local e-invoicing or clearance mandates.",
    ],
  };
}

/** Best-effort display name; falls back to the code itself. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A rule the org added because its jurisdiction needs something we do not
 * encode. Deliberately carries `source: "user"` everywhere it surfaces: the
 * document should not present a note the user wrote as though we validated it.
 */
export interface CustomExemptionReason {
  id: string;
  label: string;
  legalBasis?: string;
  /** Printed on the invoice verbatim. */
  invoiceNote: string;
  requiresRecipientVatId?: boolean;
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function validateCustomReason(input: Partial<CustomExemptionReason>): CustomExemptionReason {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!CUSTOM_ID.test(id)) {
    throw new Error(
      "A custom rule needs an id of 2 to 40 lowercase letters, digits, dash or underscore.",
    );
  }
  const label = String(input.label ?? "").trim();
  if (label.length < 2) throw new Error("A custom rule needs a label.");
  const invoiceNote = String(input.invoiceNote ?? "").trim();
  if (invoiceNote.length < 3) {
    throw new Error(
      "A custom rule needs the exact note to print on the invoice — that note is the whole point of it.",
    );
  }
  return {
    id,
    label,
    legalBasis: String(input.legalBasis ?? "").trim() || undefined,
    invoiceNote,
    requiresRecipientVatId: input.requiresRecipientVatId === true,
  };
}
