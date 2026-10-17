/**
 * Which invoicing rules apply, and how far we check them.
 *
 * Don't apply German law to everyone. Offering a Polish or Swedish entity
 * "§ 19 UStG Kleinunternehmerregelung" and a 19% rate, or an Indian one German
 * exemptions with no mention of GST, looks authoritative and is wrong.
 *
 * Three rule sets:
 *
 *   DE       statutory  - German paragraphs are encoded and enforced.
 *   EU       unsupported- the member state's national rules are not encoded.
 *                         Only the issuing profile, the unique number and what
 *                         is printed on the document are checked; the invoice
 *                         goes out on the issuer's own verification.
 *   GENERIC  unsupported- same as EU. India's GST, US sales tax, UK VAT and
 *                         everything else land here.
 *
 * Every report says which one ran, and the non-DE reports say "not
 * supported", so "valid" never claims more coverage than we have.
 *
 * There is no per-country VAT rate table: rates change by statute and we have
 * not checked them. An org sets its own rates; only a German invoice gets a
 * plausibility warning on a rate that matches nothing encoded.
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
  /** The currency a new invoice starts in. The issuer may pick another. */
  currency: string;
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

/**
 * Home currency of the non-EU countries Zold has issuers in, for the invoice
 * default. Each one still needs a rate to be issued in (withConversion).
 * Any other country starts in EUR, the currency every invoice settles in.
 */
const HOME_CURRENCY: Record<string, string> = {
  IN: "INR", NG: "NGN", KE: "KES", GB: "GBP", CH: "CHF", US: "USD",
};

const GENERIC_DISCLAIMER =
  "Zold does not support this country's invoicing rules. The invoice is checked only for the " +
  "issuing profile and a unique number — nothing in it is verified against local invoicing or " +
  "tax law. Whether it satisfies your country's requirements is entirely yours to determine, " +
  "with your accountant.";

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
      currency: "EUR",
      simplifiedLimitCents: 250_00, // § 33 UStDV
      basis: "§§ 14, 14a UStG, § 33 UStDV, § 34a UStDV",
      disclaimer:
        "Zold is not a tax adviser. These fields follow §§ 14, 14a UStG and the related rules, but " +
        "whether a supply is exempt — and which exemption applies — is your decision with your Steuerberater.",
      notVerified: [
        "Whether the exemption you choose actually applies to the supply.",
        "A Swiss or UK customer's VAT ID beyond its format: EU numbers are checked in VIES, theirs are not, and a VIES that does not answer leaves an EU number unconfirmed.",
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
      // Not every member state uses the euro, but every invoice settles in it.
      currency: "EUR",
      // Member states may set their own simplified-invoice threshold; we have
      // not checked 26 of them, so no shortcut is offered.
      basis: "Not supported — no national rules encoded",
      disclaimer:
        `Zold does not support ${name}'s invoicing rules. The invoice is checked only for the ` +
        `issuing profile and a unique number — nothing else is verified against ${name}'s or the ` +
        `EU's tax law. Add what ${name} requires as your own fields and notes, and verify the ` +
        "invoice with your accountant.",
      notVerified: [
        `${name}'s national invoicing rules, thresholds and required wording.`,
        `${name}'s VAT rates — you set the rates you charge; we do not maintain a rate table.`,
        `${name}'s small-business scheme: the threshold and the required note differ per state, ` +
          "so you supply the wording.",
        "National e-invoicing mandates (for example Poland's KSeF or Italy's SdI), which we do not produce.",
        "A Swiss or UK customer's VAT ID beyond its format: EU numbers are checked in VIES, theirs are not, and a VIES that does not answer leaves an EU number unconfirmed.",
      ],
    };
  }

  return {
    country: code || "??",
    countryName: code ? countryName(code) : "an unsupported country",
    ruleSet: "GENERIC",
    verification: "structural",
    inEu: false,
    // No EU reason, not even "export": its hint and note are the EU's, and
    // printing them on, say, an Indian invoice is an EU legal note where none
    // applies. Both reasons left take the issuer's own wording.
    reasons: ["not_registered", "other"],
    currency: HOME_CURRENCY[code] ?? "EUR",
    basis: "Not supported — no tax rules encoded",
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
