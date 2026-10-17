/**
 * The small shared pieces of the business surface: reading a field off a body,
 * the issuer identity an invoice freezes, the jurisdiction rule set, and the
 * one place a domain error becomes a 400.
 *
 * Kept apart from the routes so the four route modules can each be read on
 * their own, and so a rule that applies to all of them has a single home.
 */
import type express from "express";
import { store } from "../../store.js";
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
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  computeTotals,
  convertTotals,
  defaultInvoiceLanguage,
  defaultSeriesFor,
  issuerTaxIdProblem,
  issuerTaxIds,
  normaliseInvoiceCurrency,
  normaliseVatId,
  nextFreeNumber,
  reasonForRuleSet,
  type ExemptionReasonId,
  type InvoiceDraft,
  type InvoiceLanguage,
  type VatTreatment,
} from "../../domain/invoicing.js";
import { dayOf } from "../../domain/income-invoices.js";
import { createQuote } from "../../fx.js";
import { midRates, referenceRate } from "../../rates.js";
import { redactedMessage } from "../../http/log-cause.js";

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
  const ids = issuerTaxIds(org);
  return {
    name: org.legalName || org.name,
    addressLine: [org.address?.line1, org.address?.line2].filter(Boolean).join(", ") || undefined,
    postalCode: org.address?.postalCode,
    city: org.address?.city,
    country: org.address?.country,
    vatId: ids.vatId,
    taxNumber: ids.taxNumber,
    email: org.email,
  };
}

/**
 * What Zold already knows about the issuer and can offer to fill in, for the
 * invoicing profile form. Suggestions only: nothing is saved until the user
 * saves the form.
 *
 * Monerium's API returns a profile's id, kind, state and name, and nothing
 * else of what was entered at Monerium (no address, no register number, no
 * tax id). So the company name is the one thing taken from there, and only
 * from a profile of the kind this org needs: the name recorded on one of the
 * org's accounts when its profile was checked, else the caller's own
 * connected profile.
 */
type InvoiceBank = NonNullable<NonNullable<Organisation["invoicing"]>["bank"]>;

/** The IBAN of the org's own EUR account, when one is connected: the only
 *  one whose incoming payments Zold sees and matches to invoices. */
export function accountBankOf(org: Organisation): InvoiceBank | undefined {
  const acc = store.accountsOf(org.id).find((a) => a.currency === "EUR" && a.status === "active" && a.identifier?.iban);
  if (!acc?.identifier?.iban) return undefined;
  return { holder: org.legalName?.trim() || org.name, iban: normaliseIban(acc.identifier.iban) };
}

/** The bank details an invoice prints: the profile's when it names an IBAN,
 *  else the org account's own. */
export function invoiceBankOf(org: Organisation): InvoiceBank | undefined {
  const set = org.invoicing?.bank;
  if (set?.iban) return { ...set, holder: set.holder || org.legalName?.trim() || org.name };
  return accountBankOf(org);
}

export function issuerSuggestions(org: Organisation, callerId: string): { name?: string; source?: "monerium" } {
  if (org.legalName?.trim()) return {};
  const kind = org.type === "business" ? "corporate" : "personal";
  const fromAccount = store
    .accountsOf(org.id)
    .map((a) => a.moneriumProfile)
    .find((p) => p?.kind === kind && p.name?.trim());
  if (fromAccount?.name) return { name: fromAccount.name.trim(), source: "monerium" };
  const caller = store.findUser(callerId);
  const profileId = caller?.monerium?.profileId ?? caller?.funding?.moneriumProfileId;
  const own = (caller?.monerium?.profiles ?? []).find((p: any) => p?.id === profileId);
  if (own && own.kind === kind && typeof own.name === "string" && own.name.trim()) {
    return { name: own.name.trim(), source: "monerium" };
  }
  return {};
}

/**
 * Which rules apply to this organisation, from the country in its address.
 *
 * Resolved from the ENTITY's address rather than the customer's: an invoice is
 * governed by where the issuer is established, and a German company invoicing a
 * Swede still writes a German invoice.
 */
export const jurisdictionOf = (org: Organisation) => jurisdictionFor(org.address?.country);

/** The number series this org issues from: its own once saved or used,
 *  else the default for its country. */
export const seriesOf = (org: Organisation) => org.invoicing?.numberSeries ?? defaultSeriesFor(org.address?.country);

/** Every number this org has issued, for §14 Abs. 4 Nr. 4's "once". */
export const issuedNumbersOf = (orgId: string): Set<string> =>
  new Set(store.invoicesOf(orgId).flatMap((i) => (i.issued?.number ? [i.issued.number] : [])));

/** The number the next auto-numbered invoice dated `issueDate` gets. */
export const nextNumberOf = (org: Organisation, issueDate: string) =>
  nextFreeNumber(seriesOf(org), new Date(issueDate), issuedNumbersOf(org.id));

/** The language this org's invoices are written in unless one is chosen. */
export const languageOf = (org: Organisation): InvoiceLanguage =>
  org.invoicing?.language ?? defaultInvoiceLanguage(org.address?.country);

/** The business profile's fields that every invoice prints. */
export type IssuerIdentity = Pick<
  NonNullable<Organisation["invoicing"]>,
  "vatId" | "taxNumber" | "registerCourt" | "registerNumber" | "managingDirector"
>;

const REGISTRATION_TEXT_MAX = 120;

/** A save that names either tax identifier replaces the signup tax id that
 *  stood in for them (the profile form shows it in their place). */
export const clearsSignupTaxId = (patch: Partial<IssuerIdentity>): boolean =>
  "vatId" in patch || "taxNumber" in patch;

/**
 * The identity fields a request body sets, checked by the issuer's country.
 *
 * The business profile (PATCH /orgs/:id) and the invoicing API both write them
 * through here, into one place (`org.invoicing`), so the two screens cannot
 * hold different numbers. Only the keys present in the body are returned; an
 * empty string clears one.
 */
export function issuerIdentityFrom(
  body: Record<string, unknown>,
  country: string | undefined,
): { ok: true; patch: Partial<IssuerIdentity> } | { ok: false; error: string; field: string } {
  const { ruleSet } = jurisdictionFor(country);
  const patch: Partial<IssuerIdentity> = {};
  for (const field of ["vatId", "taxNumber"] as const) {
    const raw = body[field];
    if (typeof raw !== "string") continue;
    const problem = issuerTaxIdProblem(field, raw, ruleSet, country);
    if (problem) return { ok: false, error: problem, field };
    // An EU number is stored normalised; one Zold has no format for, as written.
    patch[field] = (field === "vatId" && ruleSet !== "GENERIC" ? normaliseVatId(raw) : raw.trim()) || undefined;
  }
  for (const field of ["registerCourt", "registerNumber", "managingDirector"] as const) {
    const raw = body[field];
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v.length > REGISTRATION_TEXT_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
      return { ok: false, error: `This is at most ${REGISTRATION_TEXT_MAX} characters on one line.`, field };
    }
    patch[field] = v || undefined;
  }
  return { ok: true, patch };
}

export const customReasonsOf = (org: Organisation): CustomExemptionReason[] =>
  (org.invoicing?.customReasons ?? []) as CustomExemptionReason[];

/** Due date from the org's payment terms, so the field is not retyped either. */
export function draftDueDate(org: Organisation, issueDate: string): string | undefined {
  const days = org.invoicing?.paymentTermsDays;
  if (!days && days !== 0) return undefined;
  const d = new Date(issueDate);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a draft from the request, filling the issuer from the organisation and
 * the VAT treatment from what the user chose.
 *
 * A Kleinunternehmer must not get a VAT rate by default: showing tax you do
 * not owe makes you liable for it under §14c.
 */
const VAT_NOTE_MAX = 300;

export function draftFrom(org: Organisation, body: Record<string, any>, now = new Date()): InvoiceDraft {
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
        `"${reasonForRuleSet(builtIn, jur.ruleSet).label}" has no wording Zold can supply. ` +
          "Write the note to print on the invoice, with its legal basis where there is one.",
      );
    }
    const note = str(body.vat?.note);
    // Printed on the invoice as written: one line, short enough for the page.
    if (note && (note.length > VAT_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(note))) {
      throw new InvoiceComplianceError(`The note is at most ${VAT_NOTE_MAX} characters on one line.`);
    }
    treatment = { kind: "exempt", reason, note };
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

  // Today where the org keeps its books: 23:30 UTC on 31 December is already
  // 1 January in Berlin, and the date and the number's year must say so.
  const issueDate = str(body.issueDate) ?? dayOf(now.toISOString(), org.reporting.timeZone);
  // A calendar day only: the number's year is read off it, and "NaN" or an
  // offset that moves the day must never reach an issued number.
  // Round-tripped: Date reads 2026-02-30 as 2 March rather than refusing it.
  const day = new Date(`${issueDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== issueDate) {
    throw new InvoiceComplianceError(`${issueDate} is not a date (YYYY-MM-DD).`);
  }

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
    // A preview: issuing picks the number again at write time (issue-outgoing.ts).
    number: str(body.number) ?? nextNumberOf(org, issueDate).number,
    issueDate,
    supplyDate: str(body.supplyDate),
    supplyPeriod:
      body.supplyPeriod?.from && body.supplyPeriod?.to
        ? { from: String(body.supplyPeriod.from), to: String(body.supplyPeriod.to) }
        : undefined,
    issuer: issuerParty(org),
    recipient,
    ...(typeof body.recipient?.isBusiness === "boolean" ? { recipientIsBusiness: body.recipient.isBusiness } : {}),
    ...(body.supplyKind === "goods" || body.supplyKind === "services" ? { supplyKind: body.supplyKind } : {}),
    lines: lineInputs(body.lines),
    treatment,
    selfBilled: body.selfBilled === true,
    currency,
  };
}

/**
 * The request's lines as line inputs, or a refusal naming the line: every
 * field read later is a string (a number is taken as its digits), so a
 * `null` line or a numeric description is a 400 here, not a crash in the
 * totals.
 */
function lineInputs(raw: unknown): InvoiceDraft["lines"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvoiceComplianceError("lines must be a list of invoice lines.");
  if (raw.length > 200) throw new InvoiceComplianceError("An invoice is limited to 200 lines.");
  const text = (v: unknown) =>
    typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return raw.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) {
      throw new InvoiceComplianceError(`Line ${i + 1} is not an invoice line.`);
    }
    const line = l as Record<string, unknown>;
    const description = text(line.description).trim();
    if (description.length > 500) throw new InvoiceComplianceError(`Line ${i + 1}'s description is limited to 500 characters.`);
    return {
      description,
      quantity: text(line.quantity ?? "1"),
      unitPriceNet: text(line.unitPriceNet),
      ...(line.vatRate !== undefined && line.vatRate !== null ? { vatRate: Number(line.vatRate) } : {}),
    };
  });
}

/**
 * Attach the settlement-currency restatement to a foreign-currency draft.
 *
 * The rate is fetched once, here, and frozen onto the document, so the euro
 * figure stays the one the customer was given. The source is the ECB
 * reference rate — the same dated fixing the books use — with the live mid
 * feed as backup for a currency the ECB does not publish. If neither has a
 * rate the conversion is left absent and `checkCompliance` refuses the
 * invoice, since § 16 Abs. 6 requires the euro tax amount.
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
    const ref = await referenceRate(currency);
    return { ...draft, conversion: convertTotals(totals, currency, ref.rate, ref.provider, ref.asOf) };
  } catch {
    // ECB publishes ~30 currencies; the mid feed carries the rest.
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
    res.status(400).json({ error: redactedMessage(err) });
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
    recipientPhone?: string;
    recipientIban?: string;
    reference?: string;
  },
) => Promise<
  | { ok: true; transfer: { id: string }; authorization: unknown }
  | { ok: false; status: number; body: any }
>;

/** A supplier's account holder name: the SEPA creditor name field's length. */
const PAY_TO_HOLDER_MAX = 70;

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
    const holder = b.holderName ?? b.holder;
    if (typeof holder === "string" && holder.trim().length > PAY_TO_HOLDER_MAX) {
      throw new InvoiceError(`The account holder's name is limited to ${PAY_TO_HOLDER_MAX} characters.`);
    }
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
