/**
 * The small shared pieces of the business surface: reading a field off a body,
 * the issuer identity an invoice freezes, the jurisdiction rule set, and the
 * one place a domain error becomes a 400.
 *
 * Kept apart from the routes so the four route modules can each be read on
 * their own, and so a rule that applies to all of them has a single home.
 */
import type express from "express";
import { CoaError } from "../../domain/coa.js";
import { DraftError } from "../../domain/drafts.js";
import { InvoiceError } from "../../domain/invoices.js";
import { normaliseIban, validateBankAccount, validateWallet } from "../../domain/contacts.js";
import {
  jurisdictionFor,
  type CustomExemptionReason,
} from "../../domain/jurisdictions.js";
import type { Invoice, InvoiceParty, Organisation } from "../../domain/types.js";
import {
  DEFAULT_SERIES,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  computeTotals,
  convertTotals,
  formatInvoiceNumber,
  normaliseInvoiceCurrency,
  normaliseVatId,
  type ExemptionReasonId,
  type InvoiceDraft,
  type VatTreatment,
} from "../../domain/invoicing.js";
import { createQuote } from "../../fx.js";
import { midRates } from "../../rates.js";

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * The organisation as it must appear on an invoice it issues.
 *
 * This IS the prefill: §14 Abs. 4 Nr. 1 and 2 want the issuer's full name,
 * address and Steuernummer or USt-IdNr. on every invoice, so they are read off
 * the org rather than retyped per document. `legalName` wins over the trading
 * name, because the legal entity is what the tax office matches.
 */
export function issuerParty(org: Organisation): InvoiceParty {
  return {
    name: org.legalName || org.name,
    addressLine: [org.address?.line1, org.address?.line2].filter(Boolean).join(", ") || undefined,
    postalCode: org.address?.postalCode,
    city: org.address?.city,
    country: org.address?.country,
    vatId: org.invoicing?.vatId,
    taxNumber: org.invoicing?.taxNumber,
    email: org.email,
  };
}

/**
 * Which rules apply to this organisation, from the country in its address.
 *
 * Resolved from the ENTITY's address rather than the customer's: an invoice is
 * governed by where the issuer is established, and a German company invoicing a
 * Swede still writes a German invoice.
 */
export const jurisdictionOf = (org: Organisation) => jurisdictionFor(org.address?.country);

export const customReasonsOf = (org: Organisation): CustomExemptionReason[] =>
  (org.invoicing?.customReasons ?? []) as CustomExemptionReason[];

/** Due date from the org's payment terms, so the field is not retyped either. */
export function draftDueDate(org: Organisation, issueDate: string): string | undefined {
  const days = org.invoicing?.paymentTermsDays;
  if (!days && days !== 0) return undefined;
  const d = new Date(issueDate);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a draft from the request, filling the issuer from the organisation and
 * the VAT treatment from what the user chose.
 *
 * A Kleinunternehmer must not get a VAT rate by default: showing tax you do
 * not owe makes you liable for it under §14c.
 */
export function draftFrom(org: Organisation, body: Record<string, any>): InvoiceDraft {
  const inv = org.invoicing ?? {};
  // Refuses an unrepresentable code before anything else is computed.
  const currency = normaliseInvoiceCurrency(body.currency);
  const jur = jurisdictionFor(org.address?.country);
  const custom = customReasonsOf(org);
  const known = (id: string) =>
    jur.reasons.includes(id) || custom.some((c) => c.id === id);
  const wantsExempt =
    body.vat?.kind === "exempt" || (body.vat === undefined && inv.smallBusiness === true);

  let treatment: VatTreatment;
  if (wantsExempt) {
    // The small-business default is Germany's § 19 only where German rules
    // apply. Elsewhere the scheme exists but its citation and wording differ,
    // so the issuer picks it and supplies the note.
    const fallback = inv.smallBusiness
      ? jur.ruleSet === "DE"
        ? "kleinunternehmer"
        : jur.reasons.includes("small_business_national")
          ? "small_business_national"
          : undefined
      : undefined;
    const reason = (str(body.vat?.reason) ?? fallback) as string | undefined;
    if (!reason) {
      throw new InvoiceComplianceError(
        `Choosing not to charge VAT needs a reason. Available in ${jur.countryName}: ${jur.reasons.join(", ")}` +
          (custom.length ? `, plus your own: ${custom.map((c) => c.id).join(", ")}.` : "."),
      );
    }
    if (!known(reason)) {
      throw new InvoiceComplianceError(
        `"${reason}" is not available in ${jur.countryName}. Available: ${jur.reasons.join(", ")}` +
          (custom.length ? `, plus your own: ${custom.map((c) => c.id).join(", ")}.` : "."),
      );
    }
    const builtIn = EXEMPTION_REASONS[reason as ExemptionReasonId];
    if (builtIn?.requiresFreeText && !str(body.vat?.note)) {
      throw new InvoiceComplianceError(
        `"${builtIn.label}" has no wording we can supply — the note differs by country. ` +
          "Write the exemption and its legal basis; it has to appear on the invoice.",
      );
    }
    treatment = { kind: "exempt", reason, note: str(body.vat?.note) };
  } else {
    if (inv.smallBusiness) {
      throw new InvoiceComplianceError(
        jur.ruleSet === "DE"
          ? "This organisation is registered as a Kleinunternehmer (§ 19 UStG) and must not charge VAT. Turn that off in the invoicing profile first, or issue the invoice exempt."
          : "This organisation is registered under a small-business scheme and must not charge VAT. Turn that off in the invoicing profile first, or issue the invoice exempt.",
      );
    }
    // No default rate outside Germany: 19 is the German rate and would be
    // wrong for, say, a Polish or Swedish entity.
    const raw = body.vat?.rate ?? inv.defaultVatRate ?? (jur.ruleSet === "DE" ? 19 : undefined);
    if (raw === undefined) {
      throw new InvoiceComplianceError(
        `Set the VAT rate you charge. Zold does not maintain a rate table for ${jur.countryName}, ` +
          "so it will not guess one.",
      );
    }
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      throw new InvoiceComplianceError(`${raw} is not a VAT percentage.`);
    }
    treatment = { kind: "standard", rate };
  }

  const issueDate = str(body.issueDate) ?? new Date().toISOString().slice(0, 10);
  const series = inv.numberSeries ?? DEFAULT_SERIES;

  const recipient: InvoiceParty = {
    name: str(body.recipient?.name),
    addressLine: str(body.recipient?.addressLine),
    postalCode: str(body.recipient?.postalCode),
    city: str(body.recipient?.city),
    country: str(body.recipient?.country)?.toUpperCase(),
    vatId: body.recipient?.vatId ? normaliseVatId(String(body.recipient.vatId)) : undefined,
    email: str(body.recipient?.email),
  };

  return {
    number: str(body.number) ?? formatInvoiceNumber(series, new Date(issueDate)),
    issueDate,
    supplyDate: str(body.supplyDate),
    supplyPeriod:
      body.supplyPeriod?.from && body.supplyPeriod?.to
        ? { from: String(body.supplyPeriod.from), to: String(body.supplyPeriod.to) }
        : undefined,
    issuer: issuerParty(org),
    recipient,
    lines: Array.isArray(body.lines) ? body.lines : [],
    treatment,
    selfBilled: body.selfBilled === true,
    currency,
  };
}

/**
 * Attach the settlement-currency restatement to a foreign-currency draft.
 *
 * The rate is fetched once, here, and frozen onto the document, so the euro
 * figure stays the one the customer was given. If the feed is unavailable the
 * conversion is left absent and `checkCompliance` refuses the invoice, since
 * § 16 Abs. 6 requires the euro tax amount.
 */
export async function withConversion(draft: InvoiceDraft): Promise<InvoiceDraft> {
  const currency = draft.currency ?? SETTLEMENT_CURRENCY;
  if (currency === SETTLEMENT_CURRENCY) return draft;
  let totals;
  try {
    totals = computeTotals(draft.lines, draft.treatment);
  } catch {
    // checkCompliance reports lines that do not compute.
    return draft;
  }
  try {
    const rates = await midRates();
    const rate = rates.eur[currency];
    if (!rate) return draft;
    return { ...draft, conversion: convertTotals(totals, currency, rate, rates.provider, rates.asOf) };
  } catch {
    return draft;
  }
}

export const badRequest = (res: express.Response, err: unknown) => {
  if (err instanceof DraftError || err instanceof InvoiceError || err instanceof CoaError) {
    res.status(400).json({ error: (err as Error).message });
    return true;
  }
  return false;
};

/**
 * Creating a transfer from a quote, injected from server.ts.
 *
 * Injected rather than imported so this router cannot acquire its own way of
 * building a transfer. One code path builds them, so one code path enforces the
 * balance check, the daily cap and the destination commitment.
 */
export type TransferFactory = (
  quote: Awaited<ReturnType<typeof createQuote>>,
  recipient: {
    recipientName: string;
    recipientIban: string;
    reference?: string;
  },
) => Promise<
  | { ok: true; transfer: { id: string }; authorization: unknown }
  | { ok: false; status: number; body: any }
>;

/**
 * Where the supplier wants the money. A bank account is validated like an
 * address-book entry (IBAN checksum included) so that "Pay" later never
 * fails on a typo the supplier made; a wallet is shape-checked. Absent is
 * allowed — the payor can still ask — but a half-filled block is refused.
 */
export function parsePayTo(raw: unknown, currency: string): Invoice["payTo"] {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, any>;
  if (p.kind === "bank") {
    const b = p.bank ?? p;
    const iban = typeof b.iban === "string" ? normaliseIban(b.iban) : "";
    if (!iban) throw new InvoiceError("Bank details need an IBAN.");
    return {
      kind: "bank",
      bank: validateBankAccount({
        currency: currency as never,
        country: typeof b.country === "string" && b.country.length === 2 ? b.country.toUpperCase() : iban.slice(0, 2),
        holderName: b.holderName ?? b.holder,
        iban,
        bic: typeof b.bic === "string" && b.bic.trim() ? b.bic.toUpperCase().replace(/\s+/g, "") : undefined,
      }),
    };
  }
  if (p.kind === "wallet") {
    const w = validateWallet({ chainId: p.chainId, address: p.address, label: "invoice" } as never);
    return { kind: "wallet", chainId: w.chainId, address: w.address };
  }
  throw new InvoiceError('payTo.kind must be "bank" or "wallet".');
}
