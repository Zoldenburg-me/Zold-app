/**
 * Issuing an outgoing invoice: the one path, for an invoice typed into the
 * editor and for a draft made from wallet receipts.
 *
 * Refuses on any compliance error. Warnings can be accepted, and the
 * acceptance is recorded on the document.
 *
 * A draft made from receipts is issued in place: it keeps its id, lines and
 * settlements, gains its number and today's date, and is paid by the rows it
 * was written for. Its issue date is always the day it is issued, whatever
 * the request says: the receipts are in the past, the invoice is not.
 *
 * A correction (§ 31 Abs. 5 UStDV) is issued here too: the next number of
 * today's series, the original's treatment, total and euro figures, the
 * customer and lines as edited (correctionBody), today's issuer details, and a printed reference to the original's number
 * and date. The original moves to REPLACED in the same transaction, with its
 * payments carried over and its open payment link handed to the correction.
 */
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import {
  DEFAULT_DISPLAY,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  checkCompliance,
  fromCents,
  invoiceDueDate,
  invoiceLanguage,
  vatNoteFor,
  type ExemptionReasonId,
  type InvoiceLanguage,
} from "../../domain/invoicing.js";
import { vatIdShape } from "../../domain/vat-ids.js";
import { checkVatId } from "../../adapters/vies.js";
import { assertTransition, newLinkToken, ownerInvoiceView, payableEur, settlementRef, settlementUpdate } from "../../domain/invoices.js";
import { openLinkFor } from "./invoice-pay-link.js";
import type { Invoice } from "../../domain/types.js";
import { sealInvoiceLink } from "../../stored-secrets.js";
import type { OrgContext } from "../org-context.js";
import {
  customReasonsOf, draftDueDate, draftFrom, issuedNumbersOf, jurisdictionOf, languageOf, nextNumberOf, seriesOf, str,
  withConversion,
} from "./shared.js";

export interface IssueAnswer {
  status: number;
  body: Record<string, unknown>;
}

const refusal = (status: number, error: string, extra: Record<string, unknown> = {}): IssueAnswer => ({
  status,
  body: { error, ...extra },
});

export async function issueOutgoing(
  ctx: OrgContext,
  requestBody: Record<string, any>,
  fromDraft?: Invoice,
  /** Run with nothing awaited before the write: a reason the draft may no
   *  longer be issued (what it bills changed during the lookups), or none. */
  stillIssuable?: () => Promise<string | undefined>,
  /** The issued invoice this one corrects and replaces (correctionBody). */
  correcting?: Invoice,
): Promise<IssueAnswer> {
  // A correction takes the next number; a draft may be given one of its own.
  const body = correcting
    ? { ...requestBody, issueDate: undefined, dueDate: undefined, number: undefined }
    : fromDraft ? { ...requestBody, issueDate: undefined, dueDate: undefined } : requestBody;
  // Taken now: the store hands out the row itself, so after the lookups below
  // `fromDraft.updatedAt` is whatever the row says by then.
  const draftReadAt = fromDraft?.updatedAt;
  const correctingReadAt = correcting?.updatedAt;
  let draft;
  let language: InvoiceLanguage;
  let dueDate: string | undefined;
  let report;
  try {
    draft = await withConversion(await draftFrom(ctx.org, body));
    // The euro figures the customer was given, not today's rate: a correction
    // changes who issued it, never what is owed.
    if (correcting?.issued?.conversion) draft.conversion = correcting.issued.conversion;
    // Chosen per invoice; the profile's language and payment terms are the
    // defaults.
    language = invoiceLanguage(body.language, languageOf(ctx.org));
    // An invoice for money already received has nothing falling due.
    dueDate = fromDraft
      ? undefined
      : correcting
        ? (correcting.dueDate && correcting.dueDate >= draft.issueDate! ? correcting.dueDate : undefined)
        : invoiceDueDate(body.dueDate, draft.issueDate!, draftDueDate(ctx.org, draft.issueDate!));
    // The customer's VAT ID is looked up here, by the server, and the answer
    // goes on the document: an answer the browser sent would prove nothing.
    if (draft.recipient.vatId && vatIdShape(draft.recipient.vatId).ok) {
      draft.recipientVatCheck = await checkVatId(draft.recipient.vatId, ctx.org.invoicing?.vatId);
    }
    // Inside the try: computing the totals refuses a line it cannot price.
    report = checkCompliance(draft, jurisdictionOf(ctx.org), customReasonsOf(ctx.org));
  } catch (err) {
    if (err instanceof InvoiceComplianceError) return refusal(400, err.message);
    throw err;
  }
  if (!report.ok) {
    const first = report.errors[0]?.message;
    return refusal(
      422,
      `This invoice is missing ${report.errors.length === 1 ? "one required detail" : `${report.errors.length} required details`}${first ? `, starting with: ${first}` : ""} It has not been issued.`,
      { ...report },
    );
  }
  if (correcting) {
    // Before the warnings, so a total that cannot be issued is said before
    // the issuer accepts them. Same amount, so the payments carry over as
    // they are; a different amount is a cancellation and a new invoice, which
    // this does not do. Both the printed total and the euro one: the
    // conversion is the original's, so edited lines in another currency
    // would otherwise pass on its euros.
    const euroCents = draft.conversion?.grossCents ?? report.totals.grossCents;
    if (report.totals.grossCents !== correcting.issued!.grossCents) {
      return refusal(422, `The corrected invoice would total ${fromCents(report.totals.grossCents)} ${draft.currency ?? SETTLEMENT_CURRENCY}, not the original's ${fromCents(correcting.issued!.grossCents)}. Change what is billed with a new invoice; a correction keeps the amount. Nothing was issued.`);
    }
    if (euroCents !== Math.round((payableEur(correcting) ?? NaN) * 100)) {
      return refusal(422, `The corrected invoice would total ${fromCents(euroCents)} EUR, not the original's ${fromCents(Math.round((payableEur(correcting) ?? 0) * 100))} EUR. Nothing was issued.`);
    }
    // The same gross can hide a different VAT (net moved between a 19% and a
    // 7% line): the tax shown per rate must stay the original's (§ 14c UStG).
    const perRate = (b: { rate: number; netCents: number; vatCents: number }[] | undefined, vatCents: number | undefined) =>
      JSON.stringify(b ? [...b].sort((x, y) => x.rate - y.rate).map(({ rate, netCents, vatCents }) => [rate, netCents, vatCents]) : vatCents);
    const was = correcting.issued!;
    if (perRate(report.totals.buckets, report.totals.vatCents) !== perRate(was.buckets, was.vatCents)) {
      return refusal(422, `The corrected invoice would show different VAT than the original (${fromCents(report.totals.vatCents)} instead of ${fromCents(was.vatCents)}, or split differently across rates). A correction keeps the tax; change it with a cancellation and a new invoice. Nothing was issued.`);
    }
    // A line made from a wallet receipt carries that receipt by position, so
    // such lines may be reworded but not merged, split, reordered or repriced.
    const fromReceipts = correcting.lines.some((l) => l.receipt);
    const moved = fromReceipts && (report.totals.lines.length !== correcting.lines.length ||
      report.totals.lines.some((l, i) => fromCents(l.netCents) !== correcting.lines[i].amount || (correcting.lines[i].vatRate !== undefined && l.appliedRate !== correcting.lines[i].vatRate)));
    if (moved) {
      return refusal(422, "This invoice was made from wallet receipts: each line stays with its receipt, so a correction may change a line's wording but not merge, split, reorder or reprice lines. Nothing was issued.");
    }
  }
  // A receipt month the wallets may not have delivered in full is confirmed in
  // the same answer as the compliance warnings, so one acceptance covers only
  // what the issuer was shown.
  const receiptWarnings = (fromDraft?.fromReceipts?.syncWarnings ?? [])
    .map((message) => ({ severity: "warning" as const, field: "receipts", message }));
  if ((report.warnings.length || receiptWarnings.length) && body.acceptWarnings !== true) {
    return refusal(
      409,
      receiptWarnings.length
        ? "This month may be incomplete. Re-send with acceptWarnings: true to issue it anyway."
        : "There are warnings on this invoice. Re-send with acceptWarnings: true to issue it anyway.",
      { ...report, warnings: [...receiptWarnings, ...report.warnings] },
    );
  }
  if (fromDraft) {
    // The invoice must bill exactly what arrived, or it would be issued as
    // paid while differing from the money.
    const receivedCents = fromDraft.lines.reduce((sum, l) => sum + (l.receipt?.eurCents ?? 0), 0);
    if (report.totals.grossCents !== receivedCents) {
      return refusal(
        422,
        `This invoice would total ${fromCents(report.totals.grossCents)} EUR, but its receipts are ${fromCents(receivedCents)} EUR. It has not been issued.`,
      );
    }
  }

  // §14 Abs. 4 Nr. 4: one number, once. Everything from here to the series
  // bump is one transaction that holds the organisation row, so the number is
  // picked against what is issued right now: another issue of this org waits
  // for it (§2 rule 4), and UNIQUE(org_id, number) refuses a duplicate on
  // Postgres whatever the code does. A number the caller supplied is refused
  // if issued; an automatic one steps over any number already issued, say one
  // typed by hand. No partner call runs in here.
  return store.tx(async () => {
    const org = (await store.lockOrganisation(ctx.org.id)) ?? ctx.org;
    const numberSupplied = typeof body.number === "string" && body.number.trim() !== "";
    const picked = numberSupplied ? undefined : (await nextNumberOf(org, draft.issueDate!));
    const number = picked?.number ?? draft.number!;
    if (numberSupplied && (await issuedNumbersOf(ctx.org.id)).has(number)) {
      return refusal(409, `Invoice number ${number} has already been issued.`);
    }
    if (fromDraft) {
      // The lookups above awaited: the draft must still be the one that was read.
      const current = await store.findInvoice(fromDraft.id);
      if (!current || current.state !== "DRAFT" || current.updatedAt !== draftReadAt) {
        return refusal(409, "This draft changed while it was being issued. Nothing was issued; look at it again.");
      }
      const changed = await stillIssuable?.();
      if (changed) return refusal(409, changed);
    }
    const original = correcting ? await store.findInvoice(correcting.id) : undefined;
    const originalLink = original ? await openLinkFor(original) : undefined;
    if (correcting) {
      if (!original || original.updatedAt !== correctingReadAt || !correctable(original)) {
        return refusal(409, "This invoice changed while the correction was being issued. Nothing was issued; look at it again.");
      }
      // Money taken by any of its links (open, paid or lapsed) that has not
      // settled the invoice yet would settle an invoice being replaced, and a
      // fresh link for the correction would ask for it again.
      const linkPaid = original.state !== "PAID" && (await store.list("paymentRequests")).some(
        (p) => p.invoiceId === original.id && p.orgId === original.orgId && !p.test && p.payments.length > 0,
      );
      if (linkPaid) {
        return refusal(409, "A payment is arriving through this invoice's payment link. Correct it once that payment has settled. Nothing was issued.");
      }
    }
    const now = new Date();
    const { token, hash } = newLinkToken();
    const id = fromDraft?.id ?? `inv_${randomUUID()}`;
    const linkTokenEnc = sealInvoiceLink(id, token);
    const display: Record<string, boolean> = {
      ...DEFAULT_DISPLAY,
      ...(ctx.org.invoicing?.display as Record<string, boolean> | undefined),
    };
    // A reason that requires the issuer's VAT ID prints it (or the note in its
    // place) whatever the display setting: §14a UStG, Art. 226 Nr. 3.
    const t = draft.treatment;
    const reason = t.kind === "exempt" ? EXEMPTION_REASONS[t.reason as ExemptionReasonId] : undefined;
    // Outside Germany a taxed invoice needs the VAT ID itself (Art. 226(3)); a
    // Steuernummer does not stand in for it.
    const euTaxed = t.kind === "standard" && jurisdictionOf(ctx.org).ruleSet === "EU";
    if (reason?.requiresIssuerVatId || euTaxed) display.issuerVatId = true;
    if (reason?.requiresRecipientVatId) display.recipientVatId = true;
    // The issuer always shows one tax identifier: a hidden one prints when it
    // is the only one there. Frozen with the document, so a reprint matches.
    const { vatId, taxNumber } = draft.issuer;
    if (!(display.issuerVatId && vatId) && !(display.issuerTaxNumber && taxNumber)) {
      if (vatId) display.issuerVatId = true;
      else if (taxNumber) display.issuerTaxNumber = true;
    }

    const document: Pick<Invoice, "lines" | "currency" | "total" | "dueDate" | "supplier" | "issued" | "submittedAt"> = {
      lines: report.totals.lines.map((l, i) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPriceNet,
        amount: fromCents(l.netCents),
        ...(draft.treatment.kind === "standard" ? { vatRate: l.appliedRate } : {}),
        ...((fromDraft ?? original)?.lines[i]?.receipt ? { receipt: (fromDraft ?? original)!.lines[i].receipt } : {}),
      })),
      currency: draft.currency ?? SETTLEMENT_CURRENCY,
      total: fromCents(report.totals.grossCents),
      dueDate,
      supplier: {
        orgName: draft.issuer.name ?? ctx.org.name,
        email: ctx.org.email ?? "",
        invoiceNumber: number,
      },
      issued: {
        number,
        issueDate: draft.issueDate!,
        supplyDate: draft.supplyDate,
        supplyPeriod: draft.supplyPeriod,
        issuer: draft.issuer,
        recipient: draft.recipient,
        vatTreatment: draft.treatment,
        // The org's own rules carry their note; without them it would print blank.
        vatNote: vatNoteFor(draft.treatment, language, customReasonsOf(ctx.org)),
        netCents: report.totals.netCents,
        vatCents: report.totals.vatCents,
        grossCents: report.totals.grossCents,
        buckets: report.totals.buckets,
        // The document's own currency, and its settlement-currency restatement
        // at the rate that was live when it was issued. Frozen, never re-derived.
        currency: draft.currency ?? SETTLEMENT_CURRENCY,
        ...(draft.conversion ? { conversion: draft.conversion } : {}),
        purchaseOrder: str(body.purchaseOrder),
        paymentTerms: str(body.paymentTerms) ?? (fromDraft || correcting ? undefined : ctx.org.invoicing?.paymentTermsNote),
        notes: str(body.notes),
        display,
        customFields: ctx.org.invoicing?.customFields,
        language,
        acceptedWarnings: [
          ...report.warnings.map((w) => `${w.field}: ${w.message}`),
          // A draft known to be possibly incomplete is issued only on acceptance.
          ...(fromDraft?.fromReceipts?.syncWarnings ?? []).map((message) => `receipts: ${message}`),
        ],
        ...(draft.recipientIsBusiness !== undefined ? { recipientIsBusiness: draft.recipientIsBusiness } : {}),
        ...(draft.supplyKind ? { supplyKind: draft.supplyKind } : {}),
        ...(draft.recipientVatCheck ? { recipientVatCheck: draft.recipientVatCheck } : {}),
        // Frozen with the document: which rules ran, and how far they went.
        jurisdiction: report.jurisdiction,
        ...(original ? { corrects: { invoiceId: original.id, number: original.issued!.number, issueDate: original.issued!.issueDate } } : {}),
      },
      submittedAt: now.toISOString(),
    };

    let replaced: Invoice | null | undefined;
    if (original) {
      // First, and from the state checked: a payment landing meanwhile wins,
      // and nothing has been written yet.
      replaced = await store.updateInvoiceFrom(original.id, [original.state], {
        state: "REPLACED",
        replacedBy: { invoiceId: id, number, issueDate: draft.issueDate!, at: now.toISOString(), byMemberId: ctx.member.id },
      });
      if (!replaced) return refusal(409, "This invoice changed while the correction was being issued. Nothing was issued; look at it again.");
      // The customer may already have the old link's bank reference or crypto
      // quote: the link itself moves to the correction, so its money settles
      // the correction, and the correction needs no new link.
      if (originalLink) await store.updatePaymentRequestFrom(originalLink.id, ["OPEN"], { invoiceId: id });
    }
    const invoice = fromDraft
      ? (await issueDraft(fromDraft, { ...document, linkTokenEnc }, hash))
      : (await store.addInvoice({
          id,
          direction: "outgoing",
          orgId: ctx.org.id,
          linkTokenHash: hash,
          linkTokenEnc,
          state: "SUBMITTED", // issued and locked; nothing for a supplier to fill in
          ...document,
          // Same amount, so the original's payments settle the correction as
          // they settled it: paid stays paid, part-paid stays part-paid.
          // From the row as it was replaced, under its lock: a settlement that
          // landed after the read above is carried too.
          ...(replaced
            ? { state: original!.state, settlements: replaced.settlements, ...(replaced.payment ? { payment: replaced.payment } : {}) }
            : {}),
          createdByMemberId: ctx.member.id,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }));

    // Burn the number only once the invoice exists: §14 Abs. 4 Nr. 4 wants each
    // number assigned once, and advancing before the write would leave a gap
    // pointing at an invoice that was never issued. The language is resolved the
    // same way: once an invoice has been issued under the country's default, it
    // is saved on the org, so a later move of country doesn't silently flip the
    // language new invoices are written in. The default frozen is the country's,
    // not this invoice's: a one-off override — say a customer's payer rule —
    // stays on its own invoice.
    if (!numberSupplied || !org.invoicing?.language) {
      await store.patchOrgSub(org.id, "invoicing", (cur) => ({
        ...(cur ?? {}),
        ...(picked ? { numberSeries: { ...seriesOf(org), next: picked.at + 1 } } : {}),
        ...(cur?.language ? {} : { language: languageOf(org) }),
      }));
    }

    return {
      status: 201,
      body: {
        invoice: ownerInvoiceView(invoice),
        linkToken: token,
        linkPath: `/invoice/${token}`,
        warnings: report.warnings,
      },
    };
  });
}

/** Turn the draft into the issued document, then close it with the receipts
 *  it already carries. */
async function issueDraft(draft: Invoice, document: Partial<Invoice>, linkTokenHash: string): Promise<Invoice> {
  return store.tx(async () => {
    assertTransition(draft.state, "SUBMITTED");
    const submitted = await store.updateInvoice(draft.id, { ...document, state: "SUBMITTED", linkTokenHash });
    const settlements = submitted.settlements ?? [];
    const last = settlements[settlements.length - 1];
    if (!last) return submitted;
    return (await store.settleInvoice(draft.id, settlementRef(last), (row) => settlementUpdate(row, last), true))!;
  });
}

/** An issued outgoing invoice a correction may replace: open or paid by the
 *  platform. A manually reconciled one, or one already replaced, is not. */
export const correctable = (i: Invoice) =>
  i.direction === "outgoing" && !!i.issued && !i.replacedBy && (i.state === "SUBMITTED" || i.state === "PAID");

/** What a correction may change, taken from the request; anything left out
 *  stays as the original printed it. The VAT treatment and currency are
 *  never taken: changing what tax is shown is a cancellation (§ 14c UStG),
 *  and the amount is checked to be the original's. The issuer's details come
 *  from today's profile. The recipient is replaced whole, VAT ID and country
 *  included, on a paid invoice too: an owner decision, so the issuer can fix
 *  who was billed without a cancellation. Its warnings (an issuer VAT ID still
 *  a note, say) are accepted like a new invoice's, also by owner decision. */
const CORRECTABLE = ["recipient", "lines", "supplyKind", "supplyDate", "supplyPeriod", "language", "purchaseOrder", "paymentTerms", "notes"] as const;

/** The request a correction is issued from: the original's own document,
 *  with the edits the request carries (CORRECTABLE). */
export function correctionBody(original: Invoice, edits: Record<string, unknown> = {}): Record<string, unknown> {
  const d = original.issued!;
  const base: Record<string, unknown> = {
    recipient: { ...d.recipient, ...(d.recipientIsBusiness !== undefined ? { isBusiness: d.recipientIsBusiness } : {}) },
    ...(d.supplyKind ? { supplyKind: d.supplyKind } : {}),
    supplyDate: d.supplyDate,
    supplyPeriod: d.supplyPeriod,
    lines: original.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceNet: l.unitPrice,
      ...(l.vatRate !== undefined ? { vatRate: l.vatRate } : {}),
    })),
    vat: d.vatTreatment.kind === "standard"
      ? { kind: "standard", rate: d.vatTreatment.rate }
      : { kind: "exempt", reason: d.vatTreatment.reason, note: d.vatTreatment.note },
    currency: d.currency ?? original.currency,
    language: d.language,
    purchaseOrder: d.purchaseOrder,
    // The original's terms as printed; none stays none, not the profile's.
    paymentTerms: d.paymentTerms,
    notes: d.notes,
  };
  for (const k of CORRECTABLE) if (edits[k] !== undefined) base[k] = edits[k];
  // A date and a period are one choice: an edit that names one drops the other.
  if (edits.supplyDate !== undefined && edits.supplyPeriod === undefined) delete base.supplyPeriod;
  if (edits.supplyPeriod !== undefined && edits.supplyDate === undefined) delete base.supplyDate;
  return { ...base, acceptWarnings: edits.acceptWarnings === true };
}
