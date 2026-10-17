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
import { redactedMessage } from "../../http/log-cause.js";
import { invoicePayLinkBlocker } from "../../domain/wallet-tier.js";

const DAY_MS = 24 * 60 * 60_000;
/** How long after its due date an invoice can still be paid by its link. */
const AFTER_DUE_MS = 60 * DAY_MS;
const MIN_LIFETIME_MS = 30 * DAY_MS;
const MAX_LIFETIME_MS = 364 * DAY_MS;

export type InvoicePayLink =
  | { ok: true; url: string; amountEur?: number; reused: boolean }
  | { ok: false; reason: string; code: string };

/** The invoice's open link, if it has one. A test link never counts, nor one
 *  whose payee may no longer collect invoices by link (a link made before
 *  the rule): its Pay button goes, its /pay page is a 404, and asking again
 *  is refused. A link whose payee row is gone is not offered either. */
export function openLinkFor(invoice: Pick<Invoice, "id" | "orgId">): PaymentRequest | undefined {
  const link = [...store.paymentRequests]
    .reverse()
    .find((p) => p.invoiceId === invoice.id && p.orgId === invoice.orgId && !p.test && effectiveState(p) === "OPEN");
  const payee = link && store.findUser(link.userId);
  return link && payee && !invoicePayLinkBlocker(payee) ? link : undefined;
}

/** Where the open link lives, relative to the site, for the invoice page. */
export function openLinkPath(invoice: Pick<Invoice, "id" | "orgId">): string | undefined {
  const link = openLinkFor(invoice);
  return link ? `/pay/${encodeURIComponent(link.handle)}/${displayCode(link.code)}` : undefined;
}

/** The invoice had a link and it ran out: the page says so instead of the
 *  Pay button silently going missing. */
export function payLinkLapsed(invoice: Pick<Invoice, "id" | "orgId">): boolean {
  return !openLinkFor(invoice) && store.paymentRequests.some(
    (p) => p.invoiceId === invoice.id && p.orgId === invoice.orgId && !p.test && effectiveState(p) === "EXPIRED",
  );
}

/** Open until well after the invoice falls due: a link that dies before the
 *  customer pays leaves them a Pay button that does nothing. */
export function linkExpiry(dueDate: string | undefined, now = new Date()): string {
  const due = dueDate ? Date.parse(`${dueDate}T23:59:59Z`) : NaN;
  const wanted = Number.isFinite(due) ? due + AFTER_DUE_MS - now.getTime() : MIN_LIFETIME_MS;
  const lifetime = Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, wanted));
  return new Date(now.getTime() + lifetime).toISOString();
}

/**
 * One link at a time per invoice, in this process. Finding no open link and
 * creating one are split by an await; two requests at once would each make
 * one. Callers run find-then-create inside this, and re-check inside it.
 * createPaymentRequest also refuses a second open link, so a caller outside
 * the lock gets a 409, not a second link.
 * shortcut: one process per db (one Akash lease); move the lock into the
 * store if the API ever runs more than once against the same data.
 */
const invoiceLocks = new Map<string, Promise<unknown>>();
export async function withInvoiceLinkLock<T>(invoice: Pick<Invoice, "id" | "orgId">, fn: () => Promise<T>): Promise<T> {
  const key = `${invoice.orgId}:${invoice.id}`;
  const prev = invoiceLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  invoiceLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (invoiceLocks.get(key) === tail) invoiceLocks.delete(key);
  }
}

/** Never throws: the invoice is already issued and numbered, and a 500 here
 *  would invite a retry that issues it twice. Say so and log instead. */
export async function payLinkForInvoice(ctx: OrgContext, invoice: Invoice, baseUrl: string): Promise<InvoicePayLink> {
  try {
    return await withInvoiceLinkLock(invoice, () => payLinkUnlocked(ctx, invoice, baseUrl));
  } catch (err) {
    if (err instanceof PaymentRequestError) return { ok: false, code: err.code ?? "REFUSED", reason: err.message };
    console.error(`invoice pay link: ${ctx.org.id}/${invoice.id}: ${redactedMessage(err)}`);
    return {
      ok: false,
      code: "ERROR",
      reason: "The Pay button could not be added just now. Add it later with Payment link in the invoice list.",
    };
  }
}

async function payLinkUnlocked(ctx: OrgContext, invoice: Invoice, baseUrl: string): Promise<InvoicePayLink> {
  const existing = openLinkFor(invoice);
  if (existing) {
    return { ok: true, url: ownerPaymentRequest(existing, baseUrl).url, amountEur: existing.amountEur, reused: true };
  }
  const user = store.findUser(ctx.userId);
  if (!user) return { ok: false, code: "NO_USER", reason: "Your session has no account behind it." };
  const blocked = invoicePayLinkBlocker(user);
  if (blocked) return { ok: false, code: "INVOICE_PAY_LINK_UNAVAILABLE", reason: blocked };
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
  const input = validateCreate({ invoiceId: invoice.id, methods, expiresAt: linkExpiry(invoice.dueDate) }, user);
  const link = await createPaymentRequest(user, input, { kind: "app" }, ctx.org.id);
  return { ok: true, url: ownerPaymentRequest(link, baseUrl).url, amountEur: link.amountEur, reused: false };
}
