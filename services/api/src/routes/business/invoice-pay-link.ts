/**
 * The payment link that collects an issued invoice.
 *
 * Issuing makes one, so the customer gets a single link: the invoice, with a
 * Pay button that opens this. One open link per invoice: asking again returns
 * the one already open, so an invoice is never collectable twice over.
 *
 * Best effort at issue. The invoice exists whether or not a link can be made,
 * and the reason a link could not be made is said, never hidden: no account
 * open yet, the caller is not the member whose account backs it, or no payment
 * method is set up.
 */
import { store } from "../../store.js";
import {
  PaymentRequestError,
  availableMethods,
  displayCode,
  effectiveState,
  ownerPaymentRequest,
  validateCreate,
  type PaymentRequest,
} from "../../payment-requests.js";
import { createPaymentRequest, orgsBackedBy } from "../payment-requests.js";
import type { Invoice } from "../../domain/types.js";
import type { OrgContext } from "../org-context.js";

const DAY_MS = 24 * 60 * 60_000;
/** How long after its due date an invoice can still be paid by its link. */
const AFTER_DUE_MS = 60 * DAY_MS;
const MIN_LIFETIME_MS = 30 * DAY_MS;
const MAX_LIFETIME_MS = 364 * DAY_MS;

export type InvoicePayLink =
  | { ok: true; url: string; amountEur?: number; reused: boolean }
  | { ok: false; reason: string; code: string };

/** The invoice's open link, if it has one. A test link never counts. */
export function openLinkFor(invoice: Pick<Invoice, "id" | "orgId">): PaymentRequest | undefined {
  return [...store.paymentRequests]
    .reverse()
    .find((p) => p.invoiceId === invoice.id && p.orgId === invoice.orgId && !p.test && effectiveState(p) === "OPEN");
}

/** Where the open link lives, relative to the site, for the invoice page. */
export function openLinkPath(invoice: Pick<Invoice, "id" | "orgId">): string | undefined {
  const link = openLinkFor(invoice);
  return link ? `/pay/${encodeURIComponent(link.handle)}/${displayCode(link.code)}` : undefined;
}

/** Open until well after the invoice falls due: a link that dies before the
 *  customer pays leaves them a Pay button that does nothing. */
export function linkExpiry(dueDate: string | undefined, now = new Date()): string {
  const due = dueDate ? Date.parse(`${dueDate}T23:59:59Z`) : NaN;
  const wanted = Number.isFinite(due) ? due + AFTER_DUE_MS - now.getTime() : MIN_LIFETIME_MS;
  const lifetime = Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, wanted));
  return new Date(now.getTime() + lifetime).toISOString();
}

export async function payLinkForInvoice(ctx: OrgContext, invoice: Invoice, baseUrl: string): Promise<InvoicePayLink> {
  const existing = openLinkFor(invoice);
  if (existing) {
    return { ok: true, url: ownerPaymentRequest(existing, baseUrl).url, amountEur: existing.amountEur, reused: true };
  }
  const user = store.findUser(ctx.userId);
  if (!user) return { ok: false, code: "NO_USER", reason: "Your session has no account behind it." };
  if (!store.accounts.some((a) => a.orgId === ctx.org.id && a.backingUserId)) {
    return {
      ok: false,
      code: "ACCOUNT_NOT_OPEN",
      reason: `${ctx.org.name}’s euro account is not open yet, so there is nothing to pay into. The invoice shows your bank details instead.`,
    };
  }
  if (!orgsBackedBy(user.id).has(ctx.org.id)) {
    return {
      ok: false,
      code: "NOT_THE_PAYEE",
      reason: "A payment link pays into the account behind this organisation, and that account is another member’s. They can add the Pay button from the invoice.",
    };
  }
  const methods = availableMethods(user).filter((m) => m.available).map((m) => m.method);
  if (!methods.length) {
    return { ok: false, code: "NO_METHOD", reason: "No way to get paid is set up on this account yet. The invoice shows your bank details instead." };
  }
  try {
    const input = validateCreate({ invoiceId: invoice.id, methods, expiresAt: linkExpiry(invoice.dueDate) }, user);
    const link = await createPaymentRequest(user, input, { kind: "app" }, ctx.org.id);
    return { ok: true, url: ownerPaymentRequest(link, baseUrl).url, amountEur: link.amountEur, reused: false };
  } catch (err) {
    if (err instanceof PaymentRequestError) return { ok: false, code: "REFUSED", reason: err.message };
    throw err;
  }
}
