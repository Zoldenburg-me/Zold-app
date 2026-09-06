/**
 * Invoices — the "Invoice-Me" one-time link.
 *
 * The payor generates a link and sends it to a supplier. The supplier fills the
 * invoice in through that link with NO ACCOUNT AND NO WALLET CONNECTION, which
 * is the whole reason the feature works: the friction of onboarding a vendor is
 * what stops invoices being paid, and this removes it.
 *
 * That also makes the link a bearer credential, so:
 *  - we store only its hash, never the token, so a leaked database does not
 *    hand over open invoices;
 *  - the supplier-facing view is filtered to what a supplier may see;
 *  - an optional password adds a second factor for a link sent over email.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Invoice, InvoiceLine, InvoiceState } from "./types.js";

export class InvoiceError extends Error {}

/** Locked on submit, per Gnosis: "once submitted, invoices are timestamped and
 *  locked". Deletion is only legal while nobody has been paid. */
const TRANSITIONS: Record<InvoiceState, InvoiceState[]> = {
  LINK_CREATED: ["SUBMITTED", "DELETED"],
  SUBMITTED: ["PAYING", "RECONCILED", "DELETED"],
  PAYING: ["PAID", "SUBMITTED"],
  PAID: ["RECONCILED"],
  RECONCILED: [],
  DELETED: [],
};

export function assertTransition(from: InvoiceState, to: InvoiceState) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new InvoiceError(
      `An invoice cannot go from ${from} to ${to}. Allowed: ${
        TRANSITIONS[from]?.join(", ") || "nothing — this is a final state"
      }.`,
    );
  }
}

/**
 * The remittance text for paying an incoming invoice: the supplier's own
 * invoice number first, because that is what their bookkeeping matches on,
 * then who paid. Falls back to the payer's name alone when the invoice has
 * no number. SEPA folding and the 140-char limit are applied downstream.
 */
export function paymentReference(invoice: Pick<Invoice, "supplier">, payerName: string): string {
  const number = invoice.supplier?.invoiceNumber?.trim();
  return (number ? `Invoice ${number} ${payerName}` : payerName).trim().slice(0, 140);
}

/** The draft that pays an invoice may be created only from SUBMITTED, and
 *  only when the supplier gave a bank account the SEPA rail can reach. */
export function assertPayable(invoice: Invoice): { iban: string; holderName: string; bic?: string } {
  if (invoice.direction === "outgoing") throw new InvoiceError("This invoice was issued by you; there is nothing to pay.");
  if (invoice.state === "PAYING") throw new InvoiceError("A payment for this invoice is already under way.");
  if (invoice.state === "PAID" || invoice.state === "RECONCILED") throw new InvoiceError("This invoice is already paid.");
  if (invoice.state !== "SUBMITTED") throw new InvoiceError(`An invoice in ${invoice.state} cannot be paid — the supplier has not submitted it.`);
  if (invoice.currency !== "EUR") throw new InvoiceError(`Only EUR invoices can be paid today; this one is in ${invoice.currency}.`);
  const bank = invoice.payTo?.kind === "bank" ? invoice.payTo.bank : undefined;
  if (!bank?.iban) {
    throw new InvoiceError(
      invoice.payTo?.kind === "wallet"
        ? "The supplier gave only a wallet address. Paying a wallet from an issued account is not wired; ask them for an IBAN."
        : "The supplier gave no bank account. Ask them for an IBAN.",
    );
  }
  return { iban: bank.iban, holderName: bank.holderName, bic: bank.bic };
}

export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare, so a token cannot be recovered a byte at a time. */
export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

export function validateLines(input: unknown): { lines: InvoiceLine[]; total: string } {
  if (!Array.isArray(input) || !input.length) {
    throw new InvoiceError("An invoice needs at least one line.");
  }
  if (input.length > 200) {
    throw new InvoiceError("An invoice is limited to 200 lines.");
  }
  let total = 0;
  const lines: InvoiceLine[] = input.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const description = String(r.description ?? "").trim();
    if (!description) throw new InvoiceError(`Line ${i + 1} needs a description.`);
    const quantity = String(r.quantity ?? "1").trim();
    const unitPrice = String(r.unitPrice ?? "").trim();
    if (!AMOUNT_RE.test(quantity) || Number(quantity) <= 0) {
      throw new InvoiceError(`Line ${i + 1} has an unusable quantity.`);
    }
    if (!AMOUNT_RE.test(unitPrice)) {
      throw new InvoiceError(`Line ${i + 1} has an unusable unit price.`);
    }
    const amount = (Number(quantity) * Number(unitPrice)).toFixed(2);
    total += Number(amount);
    return { description, quantity, unitPrice, amount };
  });
  return { lines, total: total.toFixed(2) };
}

/**
 * What the supplier sees through the link.
 *
 * An allowlist, not a delete-list: a field added to Invoice later must be
 * chosen into this view rather than leaking by default. The payor's org id,
 * member ids, internal notes and the link hashes never cross it.
 */
export function supplierView(
  invoice: Invoice,
  payorName: string,
  /** Issuer extras that belong on a printed invoice: where to pay, and the
   *  registration footer German invoices commonly carry. Passed in rather than
   *  read here so this module stays free of the store. */
  issuerExtras?: {
    bank?: { holder?: string; iban?: string; bic?: string; bankName?: string };
    footerNote?: string;
  },
) {
  return {
    id: invoice.id,
    direction: invoice.direction ?? "incoming",
    state: invoice.state,
    payor: { name: payorName },
    /**
     * The issued document, for an outgoing invoice. Safe to expose in full:
     * every field here is printed on the invoice the customer already holds,
     * and an invoice they cannot read is not an invoice. Internal ids, member
     * ids and the link hashes stay out, as with the rest of this view.
     */
    issued: invoice.issued,
    ...(invoice.issued && issuerExtras
      ? { bank: issuerExtras.bank, footerNote: issuerExtras.footerNote }
      : {}),
    supplier: invoice.supplier,
    lines: invoice.lines,
    currency: invoice.currency,
    total: invoice.total,
    dueDate: invoice.dueDate,
    payTo: invoice.payTo,
    submittedAt: invoice.submittedAt,
    paidAt: invoice.payment?.paidAt,
    txHash: invoice.payment?.txHash,
    createdAt: invoice.createdAt,
    /** Editable only before submission — the supplier's own copy of the lock. */
    editable: invoice.state === "LINK_CREATED",
  };
}

export function isOverdue(invoice: Invoice, now = new Date()): boolean {
  if (!invoice.dueDate) return false;
  if (invoice.state === "PAID" || invoice.state === "RECONCILED") return false;
  return new Date(invoice.dueDate).getTime() < now.getTime();
}

/** Deletion is legal only while nobody has been paid, and never after submit
 *  once a payment is in flight. */
export function assertDeletable(invoice: Invoice) {
  if (invoice.payment?.transferId || invoice.payment?.paidAt) {
    throw new InvoiceError(
      "This invoice has a payment against it and cannot be deleted. Reconcile it instead.",
    );
  }
  assertTransition(invoice.state, "DELETED");
}
