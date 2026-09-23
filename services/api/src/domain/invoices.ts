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
import type {
  BankInvoiceSettlement,
  CryptoInvoiceSettlement,
  Invoice,
  InvoiceLine,
  InvoiceSettlement,
  InvoiceState,
} from "./types.js";
import type { CryptoDeposit } from "../store.js";

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
/**
 * What this invoice is payable as, in the settlement currency.
 *
 * An invoice written in dollars is still collected in euro or in USDC quoted
 * from euro, because that is the only rail there is. The euro figure is the one
 * FROZEN at issue, never recomputed from today's rate: the customer agreed to
 * pay what the document told them, and re-deriving it later would quietly move
 * the amount due between the invoice being read and being paid.
 *
 * Returns undefined for an invoice that was never issued through the outgoing
 * path, which therefore has no frozen figures to collect against.
 */
export function payableEur(invoice: Invoice): number | undefined {
  const issued = invoice.issued;
  if (!issued) return undefined;
  const cents = issued.conversion ? issued.conversion.grossCents : issued.grossCents;
  if (!Number.isFinite(cents)) return undefined;
  return Math.round(cents) / 100;
}

/**
 * Build the settlement record for a crypto payment.
 *
 * Everything here is a FACT already stored on the deposit — nothing is
 * recomputed from a rate feed at read time, because a value re-derived later
 * from whatever a provider reports then is not the value that applied.
 *
 * The conversion block appears only once the asset has actually been converted.
 * While it is absent the invoice reads correctly as "paid, asset still held",
 * which is a real position on the balance sheet rather than an incomplete row.
 */
export function buildCryptoSettlement(deposit: CryptoDeposit): CryptoInvoiceSettlement {
  const received = deposit.token === "USDC" ? deposit.amountUsdc ?? 0 : deposit.amountEur ?? 0;
  const converted = deposit.state === "CONVERTED" && deposit.settlementAsset === "EURE";
  /**
   * The venue's spread against the independent mid, in euro — the only fee
   * figure we can state honestly. Requires both rates; absent otherwise rather
   * than guessed, and never inferred from the receipt-to-credit difference,
   * which also contains market movement.
   */
  const spreadEur =
    converted && deposit.rate && deposit.midRate && deposit.amountUsdc
      ? Math.round((deposit.amountUsdc / deposit.midRate - deposit.amountUsdc / deposit.rate) * 100) / 100
      : undefined;
  return {
    method: "crypto",
    ref: `deposit:${deposit.id}`,
    depositId: deposit.id,
    amountEur: deposit.creditedEur ?? deposit.receipt?.amountEur ?? 0,
    receivedAsset: deposit.token,
    receivedAmount: received,
    receiptTxHash: deposit.txHash,
    ...(deposit.receipt?.blockTimestamp ? { receiptAt: deposit.receipt.blockTimestamp } : {}),
    ...(deposit.receipt
      ? {
          receiptAmountEur: deposit.receipt.amountEur,
          receiptRate: deposit.receipt.rate,
          receiptRateProvider: deposit.receipt.rateProvider,
          receiptRateAsOf: deposit.receipt.rateAsOf,
        }
      : {}),
    ...(converted
      ? {
          conversion: {
            ...(deposit.txs.find((t) => t.step.includes("usdc->eure"))?.hash
              ? { txHash: deposit.txs.find((t) => t.step.includes("usdc->eure"))!.hash }
              : {}),
            ...(deposit.provider ? { venue: deposit.provider } : {}),
            ...(deposit.rate ? { rate: deposit.rate } : {}),
            ...(deposit.midRate ? { midRate: deposit.midRate } : {}),
            ...(spreadEur === undefined ? {} : { spreadEur }),
            ...(deposit.creditedEur === undefined ? {} : { creditedEur: deposit.creditedEur }),
          },
        }
      : {}),
    ...(deposit.realisedGainEur === undefined ? {} : { realisedGainEur: deposit.realisedGainEur }),
    at: deposit.receipt?.blockTimestamp ?? deposit.detectedAt,
  };
}

/** Build the settlement record for a SEPA credit. */
export function buildBankSettlement(
  order: MoneriumOrderLike,
  matchedOn: BankInvoiceSettlement["matchedOn"],
): BankInvoiceSettlement {
  const d = order.counterpart?.details ?? {};
  const name = d.name ?? ([d.firstName, d.lastName].filter(Boolean).join(" ") || undefined);
  return {
    method: "bank",
    ref: `monerium:${order.id}`,
    orderId: order.id,
    amountEur: Number(order.amount),
    ...(name ? { counterpartyName: name } : {}),
    ...(order.counterpart?.identifier?.iban ? { counterpartyIban: order.counterpart.identifier.iban } : {}),
    ...(order.memo ? { memo: order.memo } : {}),
    matchedOn,
    at: order.meta?.processedAt ?? new Date().toISOString(),
  };
}

/** The subset of a Monerium order these builders read. */
export interface MoneriumOrderLike {
  id: string;
  kind?: string;
  amount: string;
  address?: string;
  memo?: string;
  meta?: { state?: string; processedAt?: string };
  state?: string;
  counterpart?: {
    details?: { name?: string; firstName?: string; lastName?: string };
    identifier?: { iban?: string };
  };
}

/**
 * Does this SEPA credit name an invoice by its number?
 *
 * The everyday way an invoice gets paid: bank details on the sheet, the invoice
 * number in the reference. Matched on the normalised number appearing in the
 * normalised memo.
 *
 * DELIBERATELY CONSERVATIVE. A short number would match half the memos in a
 * ledger — "14" appears in a date, an address and another invoice's number — so
 * anything under six characters is not matched at all, and the payer's own
 * pay-link code remains the reliable route. A missed match leaves the credit
 * unattributed and someone reconciles it by hand; a wrong match books a
 * stranger's money against a customer's invoice and closes it. Those are not
 * equally bad.
 */
export const MIN_MATCHABLE_INVOICE_NUMBER = 6;

/**
 * The number must stand on its own in the memo, not merely appear inside it.
 *
 * A plain substring test booked a payment for INV-1000 against INV-100, and one
 * for RE-2026-10000 against RE-2026-1000 — the number of one invoice is a prefix
 * of a later one whenever the series outgrows its padding (and padding can be
 * set as low as 1). So the number's letters and digits must appear in order,
 * with any punctuation or spacing between them ("re 2026 0042" still names
 * RE-2026-0042), and with NO letter or digit directly before or after.
 */
export function orderNamesInvoice(order: MoneriumOrderLike, invoice: Invoice): boolean {
  const number = invoice.issued?.number;
  if (!number) return false;
  const chars = number.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (chars.length < MIN_MATCHABLE_INVOICE_NUMBER) return false;
  const pattern = new RegExp(`(?<![A-Z0-9])${chars.split("").join("[^A-Z0-9]*")}(?![A-Z0-9])`);
  return pattern.test((order.memo ?? "").toUpperCase());
}

/** Append a settlement, replacing any earlier row with the same ref. One
 *  invoice can legitimately be settled by several payments; one payment must
 *  never appear twice. */
export function withSettlement(existing: InvoiceSettlement[] | undefined, s: InvoiceSettlement): InvoiceSettlement[] {
  return [...(existing ?? []).filter((x) => settlementRef(x) !== settlementRef(s)), s];
}

/** Rows written before `ref` existed are keyed by their deposit id. */
export function settlementRef(s: InvoiceSettlement): string {
  return s.ref ?? (s.method === "bank" ? `monerium:${s.orderId}` : `deposit:${s.depositId}`);
}

export function assertDeletable(invoice: Invoice) {
  if (invoice.payment?.transferId || invoice.payment?.paidAt) {
    throw new InvoiceError(
      "This invoice has a payment against it and cannot be deleted. Reconcile it instead.",
    );
  }
  assertTransition(invoice.state, "DELETED");
}
