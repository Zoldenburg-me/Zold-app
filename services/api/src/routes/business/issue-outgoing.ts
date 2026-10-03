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
 */
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SERIES,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  checkCompliance,
  fromCents,
  invoiceDueDate,
  invoiceLanguage,
  vatNoteFor,
} from "../../domain/invoicing.js";
import { vatIdShape } from "../../domain/vat-ids.js";
import { checkVatId } from "../../adapters/vies.js";
import { assertTransition, newLinkToken, ownerInvoiceView, settlementUpdate } from "../../domain/invoices.js";
import type { Invoice } from "../../domain/types.js";
import type { OrgContext } from "../org-context.js";
import { customReasonsOf, draftDueDate, draftFrom, jurisdictionOf, str, withConversion } from "./shared.js";

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
): Promise<IssueAnswer> {
  const body = fromDraft ? { ...requestBody, issueDate: undefined, dueDate: undefined } : requestBody;
  // Taken now: the store hands out the row itself, so after the lookups below
  // `fromDraft.updatedAt` is whatever the row says by then.
  const draftReadAt = fromDraft?.updatedAt;
  let draft;
  let language: "de" | "en";
  let dueDate: string | undefined;
  let report;
  try {
    draft = await withConversion(draftFrom(ctx.org, body));
    // Chosen per invoice; the profile's language and payment terms are the
    // defaults.
    language = invoiceLanguage(body.language, ctx.org.invoicing?.language);
    // An invoice for money already received has nothing falling due.
    dueDate = fromDraft
      ? undefined
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
  if (report.warnings.length && body.acceptWarnings !== true) {
    return refusal(
      409,
      "There are warnings on this invoice. Re-send with acceptWarnings: true to issue it anyway.",
      { ...report },
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

  const series = ctx.org.invoicing?.numberSeries ?? DEFAULT_SERIES;
  // §14 Abs. 4 Nr. 4: one number, once. A caller may supply its own number,
  // so uniqueness is checked against what this org has issued rather than
  // assumed from the series.
  if (store.invoicesOf(ctx.org.id).some((i) => i.issued?.number === draft.number)) {
    return refusal(409, `Invoice number ${draft.number} has already been issued.`);
  }
  if (fromDraft) {
    // The lookups above awaited: the draft must still be the one that was read.
    const current = store.findInvoice(fromDraft.id);
    if (!current || current.state !== "DRAFT" || current.updatedAt !== draftReadAt) {
      return refusal(409, "This draft changed while it was being issued. Nothing was issued; look at it again.");
    }
  }
  const numberSupplied = typeof body.number === "string" && body.number.trim() !== "";
  const now = new Date();
  const { token, hash } = newLinkToken();
  const display: Record<string, boolean> = {
    ...DEFAULT_DISPLAY,
    ...(ctx.org.invoicing?.display as Record<string, boolean> | undefined),
  };

  const document: Pick<Invoice, "lines" | "currency" | "total" | "dueDate" | "supplier" | "issued" | "submittedAt"> = {
    lines: report.totals.lines.map((l, i) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPriceNet,
      amount: fromCents(l.netCents),
      ...(fromDraft?.lines[i]?.receipt ? { receipt: fromDraft.lines[i].receipt } : {}),
    })),
    currency: draft.currency ?? SETTLEMENT_CURRENCY,
    total: fromCents(report.totals.grossCents),
    dueDate,
    supplier: {
      orgName: draft.issuer.name ?? ctx.org.name,
      email: ctx.org.email ?? "",
      invoiceNumber: draft.number!,
    },
    issued: {
      number: draft.number!,
      issueDate: draft.issueDate!,
      supplyDate: draft.supplyDate,
      supplyPeriod: draft.supplyPeriod,
      issuer: draft.issuer,
      recipient: draft.recipient,
      vatTreatment: draft.treatment,
      vatNote: vatNoteFor(draft.treatment, language),
      netCents: report.totals.netCents,
      vatCents: report.totals.vatCents,
      grossCents: report.totals.grossCents,
      buckets: report.totals.buckets,
      // The document's own currency, and its settlement-currency restatement
      // at the rate that was live when it was issued. Frozen, never re-derived.
      currency: draft.currency ?? SETTLEMENT_CURRENCY,
      ...(draft.conversion ? { conversion: draft.conversion } : {}),
      purchaseOrder: str(body.purchaseOrder),
      paymentTerms: str(body.paymentTerms) ?? (fromDraft ? undefined : ctx.org.invoicing?.paymentTermsNote),
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
    },
    submittedAt: now.toISOString(),
  };

  const invoice = fromDraft
    ? issueDraft(fromDraft, document, hash)
    : store.addInvoice({
        id: `inv_${randomUUID()}`,
        direction: "outgoing",
        orgId: ctx.org.id,
        linkTokenHash: hash,
        state: "SUBMITTED", // issued and locked; nothing for a supplier to fill in
        ...document,
        createdByMemberId: ctx.member.id,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

  // Burn the number only once the invoice exists: §14 Abs. 4 Nr. 4 wants each
  // number assigned once, and advancing before the write would leave a gap
  // pointing at an invoice that was never issued.
  if (!numberSupplied) {
    store.updateOrganisation(ctx.org.id, {
      invoicing: { ...(ctx.org.invoicing ?? {}), numberSeries: { ...series, next: series.next + 1 } },
    });
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
}

/** Turn the draft into the issued document, then close it with the receipts
 *  it already carries. */
function issueDraft(draft: Invoice, document: Partial<Invoice>, linkTokenHash: string): Invoice {
  assertTransition(draft.state, "SUBMITTED");
  const submitted = store.updateInvoice(draft.id, { ...document, state: "SUBMITTED", linkTokenHash });
  const settlements = submitted.settlements ?? [];
  const last = settlements[settlements.length - 1];
  return last ? store.updateInvoice(draft.id, settlementUpdate(submitted, last)) : submitted;
}
