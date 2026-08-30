/**
 * German invoice compliance — §14 UStG and friends.
 *
 * NOT TAX ADVICE, and the app says so wherever this surfaces. What this module
 * does is narrower and worth stating precisely: it encodes the *content* rules
 * for a German invoice so the software cannot quietly produce a document that
 * is missing a mandatory field or that shows tax it does not owe. Whether a
 * given transaction is actually exempt is the user's call with their
 * Steuerberater; we make the consequence of that call correct on paper.
 *
 * THE RULE THAT DRIVES THE DESIGN — §14c UStG: if you show a VAT amount you did
 * not owe, you owe it anyway (unrichtiger Steuerausweis), and the recipient
 * cannot deduct it. So "exempt" and "a VAT amount" are made IMPOSSIBLE TO
 * COMBINE by the type, not merely discouraged in the UI: VatTreatment is a
 * discriminated union, and the exempt arm has no rate and no tax field to fill.
 *
 * The other rule worth knowing: a missing mandatory field costs the RECIPIENT
 * their input-tax deduction until the issuer sends a corrected invoice. The
 * damage lands on the customer, not on the person who made the mistake, which
 * is exactly why this is validated before the document is issued rather than
 * left to be discovered.
 *
 * Sources checked Aug 2026: §14 Abs. 4 UStG (ten mandatory details), §33 UStDV
 * (Kleinbetragsrechnung, €250 gross), §34a UStDV (Kleinunternehmer invoice
 * contents, new 2025), §19 UStG (thresholds raised 2025 to €25,000 prior year /
 * €100,000 current), §13b UStG and Art. 196 MwStSystRL (reverse charge),
 * §4 Nr. 1a/1b i.V.m. §§ 6, 6a UStG (export and intra-community supply).
 */

// ── VAT treatment ───────────────────────────────────────────────────────────

/** German rates. 19% standard, 7% reduced. */
export type VatRate = 19 | 7 | 0;

export type ExemptionReasonId =
  | "kleinunternehmer"
  | "reverse_charge_eu"
  | "reverse_charge_domestic"
  | "intra_community_supply"
  | "export_third_country"
  | "not_taxable_place_of_supply"
  | "other";

export interface ExemptionReason {
  id: ExemptionReasonId;
  /** What the user picks in the UI. */
  label: string;
  labelEn: string;
  /** The statute, shown next to the choice so the user can check it. */
  legalBasis: string;
  /**
   * The note that MUST appear on the invoice. For reverse charge the wording is
   * not decorative: since 30.6.2013 the invoice must carry
   * "Steuerschuldnerschaft des Leistungsempfängers" (or the equivalent term in
   * another official EU language, per Art. 226 Nr. 11a MwStSystRL).
   */
  invoiceNote: string;
  invoiceNoteEn: string;
  /** Reverse charge and intra-community supply need both parties identified. */
  requiresIssuerVatId: boolean;
  requiresRecipientVatId: boolean;
  /** `other` makes the user write the basis themselves. */
  requiresFreeText?: boolean;
  /** One line explaining when this applies, for the picker. */
  hint: string;
}

export const EXEMPTION_REASONS: Record<ExemptionReasonId, ExemptionReason> = {
  kleinunternehmer: {
    id: "kleinunternehmer",
    label: "Kleinunternehmerregelung",
    labelEn: "Small business scheme",
    legalBasis: "§ 19 UStG",
    invoiceNote: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
    invoiceNoteEn:
      "No VAT charged under the small business scheme (§ 19 German VAT Act).",
    requiresIssuerVatId: false,
    requiresRecipientVatId: false,
    hint: "Your turnover stayed under €25,000 last year and is expected under €100,000 this year.",
  },
  reverse_charge_eu: {
    id: "reverse_charge_eu",
    label: "Reverse Charge (EU-Ausland)",
    labelEn: "Reverse charge (EU)",
    legalBasis: "§ 3a Abs. 2 UStG, Art. 196 MwStSystRL",
    invoiceNote: "Steuerschuldnerschaft des Leistungsempfängers",
    invoiceNoteEn: "Reverse charge — VAT to be accounted for by the recipient",
    requiresIssuerVatId: true,
    requiresRecipientVatId: true,
    hint: "Service to a business in another EU country. Both VAT IDs must appear on the invoice.",
  },
  reverse_charge_domestic: {
    id: "reverse_charge_domestic",
    label: "Reverse Charge (Inland)",
    labelEn: "Reverse charge (domestic)",
    legalBasis: "§ 13b UStG",
    invoiceNote: "Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)",
    invoiceNoteEn:
      "Reverse charge — VAT to be accounted for by the recipient (§ 13b German VAT Act)",
    requiresIssuerVatId: false,
    requiresRecipientVatId: false,
    hint: "Domestic cases under § 13b, such as construction services between businesses.",
  },
  intra_community_supply: {
    id: "intra_community_supply",
    label: "Innergemeinschaftliche Lieferung",
    labelEn: "Intra-community supply",
    legalBasis: "§ 4 Nr. 1b i. V. m. § 6a UStG",
    invoiceNote: "Steuerfreie innergemeinschaftliche Lieferung",
    invoiceNoteEn: "VAT-exempt intra-community supply",
    requiresIssuerVatId: true,
    requiresRecipientVatId: true,
    hint: "Goods shipped to a business in another EU country. Both VAT IDs must appear.",
  },
  export_third_country: {
    id: "export_third_country",
    label: "Ausfuhrlieferung (Drittland)",
    labelEn: "Export (non-EU)",
    legalBasis: "§ 4 Nr. 1a i. V. m. § 6 UStG",
    invoiceNote: "Steuerfreie Ausfuhrlieferung",
    invoiceNoteEn: "VAT-exempt export supply",
    requiresIssuerVatId: false,
    requiresRecipientVatId: false,
    hint: "Goods shipped outside the EU.",
  },
  not_taxable_place_of_supply: {
    id: "not_taxable_place_of_supply",
    label: "Nicht steuerbar (Leistungsort im Ausland)",
    labelEn: "Not taxable in Germany (place of supply abroad)",
    legalBasis: "§ 3a Abs. 2 UStG",
    invoiceNote: "Nicht steuerbare sonstige Leistung, Leistungsort im Ausland",
    invoiceNoteEn: "Not subject to German VAT — place of supply is abroad",
    requiresIssuerVatId: false,
    requiresRecipientVatId: false,
    hint: "Service to a business outside the EU, where the place of supply is not Germany.",
  },
  other: {
    id: "other",
    label: "Anderer Grund",
    labelEn: "Other reason",
    legalBasis: "—",
    invoiceNote: "",
    invoiceNoteEn: "",
    requiresIssuerVatId: false,
    requiresRecipientVatId: false,
    requiresFreeText: true,
    hint: "Write the exemption and its legal basis yourself. It must appear on the invoice.",
  },
};

/**
 * Charge VAT, or do not and say why.
 *
 * A discriminated union rather than `{ rate, exempt, reason }`, precisely so
 * that "exempt with a tax amount" cannot be represented at all. §14c makes that
 * combination expensive, and the cheapest place to make it impossible is here.
 */
export type VatTreatment =
  | { kind: "standard"; rate: Exclude<VatRate, 0> }
  | {
      kind: "exempt";
      reason: ExemptionReasonId;
      /** Required when the reason is `other`; otherwise the canonical note. */
      note?: string;
    };

export function vatNoteFor(t: VatTreatment, lang: "de" | "en" = "de"): string {
  if (t.kind === "standard") return "";
  const r = EXEMPTION_REASONS[t.reason];
  if (t.reason === "other") return t.note?.trim() ?? "";
  return lang === "de" ? r.invoiceNote : r.invoiceNoteEn;
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * Cents in, cents out. Invoice arithmetic is done in integer minor units
 * because a VAT total that has been through a float is a total that will not
 * reconcile against the tax return.
 */
export function toCents(amount: string | number): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new InvoiceComplianceError(`"${amount}" is not an amount.`);
  return Math.round(n * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatEur(cents: number): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" })
    .format(cents / 100);
}

export class InvoiceComplianceError extends Error {}

export interface InvoiceLineInput {
  description: string;
  quantity: string;
  unit?: string;
  unitPriceNet: string;
  /** Per-line rate, so one invoice can mix 19% and 7%. Ignored when exempt. */
  vatRate?: VatRate;
}

export interface ComputedLine extends InvoiceLineInput {
  netCents: number;
  vatCents: number;
  appliedRate: VatRate;
}

export interface VatBucket {
  rate: VatRate;
  netCents: number;
  vatCents: number;
}

export interface InvoiceTotals {
  lines: ComputedLine[];
  /** §14 Abs. 4 Nr. 8: the consideration must be broken down BY TAX RATE. */
  buckets: VatBucket[];
  netCents: number;
  vatCents: number;
  grossCents: number;
}

/**
 * Compute a line-by-line total with the per-rate breakdown §14 Abs. 4 Nr. 8
 * requires. VAT is rounded once per rate bucket, not per line — rounding each
 * line and summing drifts against what the tax office recomputes.
 */
export function computeTotals(
  lines: InvoiceLineInput[],
  treatment: VatTreatment,
): InvoiceTotals {
  if (!lines.length) throw new InvoiceComplianceError("An invoice needs at least one line.");

  const computed: ComputedLine[] = [];
  const byRate = new Map<VatRate, number>();

  for (const [i, line] of lines.entries()) {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new InvoiceComplianceError(`Line ${i + 1} has an unusable quantity.`);
    }
    const unitCents = toCents(line.unitPriceNet);
    if (unitCents < 0) {
      throw new InvoiceComplianceError(`Line ${i + 1} has a negative unit price.`);
    }
    const netCents = Math.round(unitCents * qty);
    // When exempt, EVERY line is 0% whatever the line says — the treatment is a
    // property of the invoice, and letting a stray line rate through is the
    // §14c mistake in miniature.
    const appliedRate: VatRate = treatment.kind === "exempt" ? 0 : (line.vatRate ?? treatment.rate);
    if (treatment.kind === "standard" && appliedRate !== 19 && appliedRate !== 7) {
      throw new InvoiceComplianceError(
        `Line ${i + 1} uses a ${appliedRate}% rate. German VAT is 19% or 7%.`,
      );
    }
    byRate.set(appliedRate, (byRate.get(appliedRate) ?? 0) + netCents);
    computed.push({ ...line, netCents, vatCents: 0, appliedRate });
  }

  const buckets: VatBucket[] = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, netCents]) => ({
      rate,
      netCents,
      vatCents: Math.round((netCents * rate) / 100),
    }));

  // Attribute each bucket's rounded VAT back onto its lines, largest remainder
  // first, so the line column adds up to the bucket exactly.
  for (const bucket of buckets) {
    const lines = computed.filter((l) => l.appliedRate === bucket.rate);
    let assigned = 0;
    lines.forEach((l, idx) => {
      if (idx === lines.length - 1) l.vatCents = bucket.vatCents - assigned;
      else {
        const share = bucket.netCents
          ? Math.round((bucket.vatCents * l.netCents) / bucket.netCents)
          : 0;
        l.vatCents = share;
        assigned += share;
      }
    });
  }

  const netCents = buckets.reduce((s, b) => s + b.netCents, 0);
  const vatCents = buckets.reduce((s, b) => s + b.vatCents, 0);
  return { lines: computed, buckets, netCents, vatCents, grossCents: netCents + vatCents };
}

// ── Identifiers ─────────────────────────────────────────────────────────────

/** DE + 9 digits. Other member states have their own lengths and check digits;
 *  those are shape-checked only, and the shape must still start with a real VAT
 *  country prefix and contain a digit — otherwise any capitalised word passes.
 *  (It did: "nonsense" uppercases to NONSENSE, which matched a bare
 *  two-letters-then-alphanumerics pattern.) */
const DE_VAT_ID = /^DE\d{9}$/;
const VAT_PREFIXES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // Greece files VAT under EL, not GR. XI is Northern Ireland post-Brexit.
  "EL", "XI",
]);

export function normaliseVatId(v: string): string {
  return v.toUpperCase().replace(/[\s.\-/]/g, "");
}

export function vatIdLooksValid(v: string): boolean {
  const s = normaliseVatId(v);
  if (s.startsWith("DE")) return DE_VAT_ID.test(s);
  const prefix = s.slice(0, 2);
  const body = s.slice(2);
  if (!VAT_PREFIXES.has(prefix)) return false;
  if (!/^[0-9A-Z]{2,12}$/.test(body)) return false;
  return /\d/.test(body);
}

/** German Steuernummer: 10–13 digits, commonly written with / and spaces. */
export function taxNumberLooksValid(v: string): boolean {
  return /^\d{10,13}$/.test(v.replace(/[\s./-]/g, ""));
}

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

export const isEuCountry = (code?: string) => Boolean(code && EU_COUNTRIES.has(code.toUpperCase()));

// ── Compliance check ────────────────────────────────────────────────────────

export interface Party {
  name?: string;
  addressLine?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  vatId?: string;
  taxNumber?: string;
}

export interface InvoiceDraft {
  number?: string;
  issueDate?: string;
  /** §14 Abs. 4 Nr. 6: the time of supply, or the period. */
  supplyDate?: string;
  supplyPeriod?: { from: string; to: string };
  issuer: Party;
  recipient: Party;
  lines: InvoiceLineInput[];
  treatment: VatTreatment;
  /** Agreed reductions (Skonto etc.) — §14 Abs. 4 Nr. 7 wants these stated. */
  discountNote?: string;
  /** Set for a self-billed invoice; the word "Gutschrift" then becomes mandatory. */
  selfBilled?: boolean;
}

export type IssueSeverity = "error" | "warning";

export interface ComplianceIssue {
  severity: IssueSeverity;
  /** Which input to point at. */
  field: string;
  message: string;
  /** The statute, so the user can look it up rather than trust us. */
  legalBasis?: string;
}

export interface ComplianceReport {
  /** Which content regime applies to this invoice. */
  regime: "standard" | "kleinbetrag" | "kleinunternehmer";
  issues: ComplianceIssue[];
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  ok: boolean;
  totals: InvoiceTotals;
}

/** §33 UStDV: simplified content up to €250 GROSS. */
export const KLEINBETRAG_LIMIT_CENTS = 250_00;

const has = (v?: string) => Boolean(v && v.trim());

/**
 * Check a draft against the content rules and report every problem at once.
 *
 * Errors block issuing; warnings are things that are legal but likely wrong.
 * Both carry the statute — a validator that says "invalid" without saying which
 * rule it is applying cannot be checked by the person it is judging.
 */
export function checkCompliance(draft: InvoiceDraft): ComplianceReport {
  const totals = computeTotals(draft.lines, draft.treatment);
  const issues: ComplianceIssue[] = [];
  const add = (
    severity: IssueSeverity,
    field: string,
    message: string,
    legalBasis?: string,
  ) => issues.push({ severity, field, message, legalBasis });

  const smallBusiness =
    draft.treatment.kind === "exempt" && draft.treatment.reason === "kleinunternehmer";
  const kleinbetrag =
    totals.grossCents <= KLEINBETRAG_LIMIT_CENTS && !smallBusiness && !draft.selfBilled;
  const regime: ComplianceReport["regime"] = smallBusiness
    ? "kleinunternehmer"
    : kleinbetrag
      ? "kleinbetrag"
      : "standard";

  // ── Always required, in every regime ─────────────────────────────────────
  if (!has(draft.issuer.name)) {
    add("error", "issuer.name", "Your full business name is required.", "§ 14 Abs. 4 Nr. 1 UStG");
  }
  if (!has(draft.issuer.addressLine) || !has(draft.issuer.city)) {
    add("error", "issuer.address", "Your full address is required.", "§ 14 Abs. 4 Nr. 1 UStG");
  }
  if (!has(draft.issueDate)) {
    add("error", "issueDate", "The issue date is required.", "§ 14 Abs. 4 Nr. 3 UStG");
  }
  if (!draft.lines.length || draft.lines.some((l) => !has(l.description))) {
    add(
      "error",
      "lines",
      "Every line needs the quantity and the customary description of what was supplied.",
      "§ 14 Abs. 4 Nr. 5 UStG",
    );
  }

  // ── Full §14 content, unless §33 UStDV applies ───────────────────────────
  if (regime !== "kleinbetrag") {
    if (!has(draft.recipient.name)) {
      add("error", "recipient.name", "The customer's full name is required.", "§ 14 Abs. 4 Nr. 1 UStG");
    }
    if (!has(draft.recipient.addressLine) || !has(draft.recipient.city)) {
      add("error", "recipient.address", "The customer's full address is required.", "§ 14 Abs. 4 Nr. 1 UStG");
    }
    if (!has(draft.number)) {
      add(
        "error",
        "number",
        "A sequential invoice number is required, and it must be unique.",
        "§ 14 Abs. 4 Nr. 4 UStG",
      );
    }
    if (!has(draft.supplyDate) && !draft.supplyPeriod) {
      add(
        "error",
        "supplyDate",
        "The date or period of supply is required — even when it is the same day as the invoice date.",
        "§ 14 Abs. 4 Nr. 6 UStG",
      );
    }
    // §34a UStDV gives Kleinunternehmer their own reduced content rules, but a
    // supplier identifier is still how the customer's accountant books it.
    if (!has(draft.issuer.vatId) && !has(draft.issuer.taxNumber)) {
      add(
        smallBusiness ? "warning" : "error",
        "issuer.taxId",
        smallBusiness
          ? "No Steuernummer or USt-IdNr. shown. § 34a UStDV relaxes this for Kleinunternehmer, but most customers expect one."
          : "Your Steuernummer or USt-IdNr. is required.",
        smallBusiness ? "§ 34a UStDV" : "§ 14 Abs. 4 Nr. 2 UStG",
      );
    }
  }

  // ── Tax presentation ─────────────────────────────────────────────────────
  if (draft.treatment.kind === "standard") {
    if (totals.vatCents <= 0) {
      add(
        "error",
        "treatment",
        "This invoice charges VAT but the tax amount is zero. Pick an exemption reason instead of showing 0%.",
        "§ 14c UStG",
      );
    }
  } else {
    const reason = EXEMPTION_REASONS[draft.treatment.reason];
    const note = vatNoteFor(draft.treatment);
    if (!has(note)) {
      add(
        "error",
        "treatment.note",
        "An exempt invoice must state the reason on the document. Write it out.",
        "§ 14 Abs. 4 Nr. 8 UStG",
      );
    }
    if (reason.requiresIssuerVatId && !vatIdLooksValid(draft.issuer.vatId ?? "")) {
      add(
        "error",
        "issuer.vatId",
        `${reason.label} requires your USt-IdNr. on the invoice.`,
        reason.legalBasis,
      );
    }
    if (reason.requiresRecipientVatId && !vatIdLooksValid(draft.recipient.vatId ?? "")) {
      add(
        "error",
        "recipient.vatId",
        `${reason.label} requires the customer's VAT ID on the invoice.`,
        reason.legalBasis,
      );
    }
    // Belt and braces: the type already prevents this, but a hand-built draft
    // could still arrive with lines carrying a rate.
    if (totals.vatCents !== 0) {
      add(
        "error",
        "treatment",
        "An exempt invoice must not show a VAT amount. Showing tax you do not owe makes you liable for it.",
        "§ 14c UStG",
      );
    }
  }

  // ── Plausibility warnings ────────────────────────────────────────────────
  if (draft.treatment.kind === "exempt") {
    const t = draft.treatment;
    const recipientCountry = draft.recipient.country?.toUpperCase();
    if (
      (t.reason === "reverse_charge_eu" || t.reason === "intra_community_supply") &&
      recipientCountry &&
      (!isEuCountry(recipientCountry) || recipientCountry === "DE")
    ) {
      add(
        "warning",
        "recipient.country",
        `${reasonLabel(t.reason)} applies to another EU country, but the customer is in ${recipientCountry}.`,
        EXEMPTION_REASONS[t.reason].legalBasis,
      );
    }
    if (t.reason === "export_third_country" && isEuCountry(recipientCountry)) {
      add(
        "warning",
        "recipient.country",
        `Export applies outside the EU, but the customer is in ${recipientCountry}.`,
        EXEMPTION_REASONS[t.reason].legalBasis,
      );
    }
  }
  if (has(draft.issuer.vatId) && !vatIdLooksValid(draft.issuer.vatId!)) {
    add("warning", "issuer.vatId", `${draft.issuer.vatId} does not look like a VAT ID.`);
  }
  if (has(draft.recipient.vatId) && !vatIdLooksValid(draft.recipient.vatId!)) {
    add("warning", "recipient.vatId", `${draft.recipient.vatId} does not look like a VAT ID.`);
  }
  if (draft.selfBilled) {
    add(
      "warning",
      "selfBilled",
      'A self-billed invoice must carry the word "Gutschrift".',
      "§ 14 Abs. 4 Nr. 10 UStG",
    );
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { regime, issues, errors, warnings, ok: errors.length === 0, totals };
}

function reasonLabel(id: ExemptionReasonId): string {
  return EXEMPTION_REASONS[id].label;
}

// ── Invoice numbering ───────────────────────────────────────────────────────

export interface NumberSeries {
  /** e.g. "RE-{YYYY}-" */
  prefix: string;
  next: number;
  padding: number;
}

export const DEFAULT_SERIES: NumberSeries = { prefix: "RE-{YYYY}-", next: 1, padding: 4 };

/**
 * Render the next number. §14 Abs. 4 Nr. 4 asks for a number that is unique and
 * assigned once; it does NOT require a gapless run, and per-year series are
 * explicitly allowed, which is why {YYYY} is a template rather than a hack.
 */
export function formatInvoiceNumber(series: NumberSeries, when: Date): string {
  const prefix = series.prefix
    .replace(/\{YYYY\}/g, String(when.getFullYear()))
    .replace(/\{YY\}/g, String(when.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(when.getMonth() + 1).padStart(2, "0"));
  return `${prefix}${String(series.next).padStart(series.padding, "0")}`;
}

// ── Which optional blocks the issuer wants on the document ──────────────────

/**
 * Fields the user may switch on and off.
 *
 * Deliberately only the OPTIONAL ones. Everything §14 requires is rendered
 * unconditionally — an invoice generator whose settings can produce an invalid
 * document is a trap, and the person who springs it is the customer who loses
 * their input-tax deduction.
 */
export interface InvoiceDisplayOptions {
  logo: boolean;
  issuerTaxNumber: boolean;
  issuerVatId: boolean;
  recipientVatId: boolean;
  supplyPeriod: boolean;
  paymentTerms: boolean;
  bankDetails: boolean;
  purchaseOrder: boolean;
  notes: boolean;
  footer: boolean;
  /** Renders each label in German and English. */
  bilingual: boolean;
}

export const DEFAULT_DISPLAY: InvoiceDisplayOptions = {
  logo: true,
  issuerTaxNumber: true,
  issuerVatId: true,
  recipientVatId: true,
  supplyPeriod: true,
  paymentTerms: true,
  bankDetails: true,
  purchaseOrder: false,
  notes: true,
  footer: true,
  bilingual: false,
};

/** Labels the document renders, so DE/EN stays in one place. */
export const LABELS = {
  invoice: { de: "Rechnung", en: "Invoice" },
  creditNote: { de: "Gutschrift", en: "Credit note" },
  number: { de: "Rechnungsnummer", en: "Invoice number" },
  issueDate: { de: "Rechnungsdatum", en: "Invoice date" },
  supplyDate: { de: "Leistungsdatum", en: "Date of supply" },
  supplyPeriod: { de: "Leistungszeitraum", en: "Period of supply" },
  from: { de: "Rechnungssteller", en: "From" },
  to: { de: "Rechnungsempfänger", en: "To" },
  vatId: { de: "USt-IdNr.", en: "VAT ID" },
  taxNumber: { de: "Steuernummer", en: "Tax number" },
  description: { de: "Bezeichnung", en: "Description" },
  quantity: { de: "Menge", en: "Qty" },
  unitPrice: { de: "Einzelpreis", en: "Unit price" },
  rate: { de: "USt.", en: "VAT" },
  lineTotal: { de: "Betrag", en: "Amount" },
  net: { de: "Nettobetrag", en: "Net" },
  vat: { de: "Umsatzsteuer", en: "VAT" },
  gross: { de: "Gesamtbetrag", en: "Total" },
  paymentTerms: { de: "Zahlungsbedingungen", en: "Payment terms" },
  bank: { de: "Bankverbindung", en: "Bank details" },
  purchaseOrder: { de: "Bestellnummer", en: "Purchase order" },
} as const;
