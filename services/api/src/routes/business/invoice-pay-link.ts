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
  type PaymentMethod,
  type PaymentRequest,
} from "../../payment-requests.js";
import { companyPageHandle, createPaymentRequest, orgsBackedBy } from "../payment-requests.js";
import type { Invoice, Organisation } from "../../domain/types.js";
import type { User } from "../../store/types.js";
import type { OrgContext } from "../org-context.js";
import { redactedMessage } from "../../http/log-cause.js";
import { roleCan } from "../../domain/roles.js";

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

/**
 * Why `user` cannot make a payment link for `org`, or undefined when they can.
 * The one verdict behind the routes that make links and the UI that offers
 * them. A personal space is backed by its owner's Safe, IBAN or not; a
 * business by the Safe connected to its euro account, an IBAN's or a
 * wallet-tier one's (orgsBackedBy).
 */
/**
 * Whose account a link made here pays into: the caller's, when their Safe
 * backs the organisation; else, in a business, the member's whose Safe backs
 * its euro account. An admin or payer may make a link into the company's
 * account (roles allow it: invoices.manage), and the money lands where the
 * company's account is, never in the caller's own Safe.
 */
export function linkPayee(org: Organisation, user: User): User | undefined {
  if (orgsBackedBy(user.id).has(org.id)) return user;
  if (org.type !== "business") return undefined;
  // Backed is backed, as orgsBackedBy reads it: a wallet-backed account stays gated (no IBAN).
  const backed = store.accountsOf(org.id).filter((a) => a.currency === "EUR" && a.backingUserId);
  const account = backed.find((a) => a.status === "active") ?? backed[0];
  const payee = account ? store.findUser(account.backingUserId!) : undefined;
  // A backer who has left the company is not where its customers' money goes.
  const member = payee && store.membersOf(org.id).some((m) => m.userId === payee.id && m.status === "active");
  return payee && member && orgsBackedBy(payee.id).has(org.id) ? payee : undefined;
}

/**
 * The ways a link may be paid. Made by the payee: whatever their account
 * takes. Made by another member: bank transfer only. The company page shows
 * the company's bank details and no crypto address, and a link in the
 * company's name must not publish the holder's personal deposit address.
 */
export function linkMethods(payee: User, caller: User): PaymentMethod[] {
  const own = payee.id === caller.id;
  return availableMethods(payee).filter((m) => m.available && (own || m.method === "bank")).map((m) => m.method);
}

export type PayLinkBlock = { code: "ACCOUNT_NOT_OPEN" | "NOT_THE_PAYEE" | "NO_PAGE" | "NO_METHOD"; reason: string };

export function payLinkBlocker(org: Organisation, user: User): PayLinkBlock | undefined {
  const r = payLinkPayee(org, user);
  return "payee" in r ? undefined : r;
}

/** The payee a link made here pays into, or why there is none. */
export function payLinkPayee(org: Organisation, user: User): { payee: User } | PayLinkBlock {
  if (org.type !== "personal" && !store.accounts.some((a) => a.orgId === org.id && a.backingUserId)) {
    return {
      code: "ACCOUNT_NOT_OPEN",
      reason: `Nothing is connected to ${org.name}’s euro account yet, so a payment link has nowhere to pay into. Connect the company’s IBAN, or your wallet, on Accounts.`,
    };
  }
  const payee = linkPayee(org, user);
  if (!payee) {
    return {
      code: "NOT_THE_PAYEE",
      reason: "A payment link pays into the account behind this organisation, and that account is another member’s. They can make the link.",
    };
  }
  const own = payee.id === user.id;
  // A link opens under a page (createPaymentRequest): the company's, else the
  // payee's own, and only the payee's own when the payee made it.
  if (!companyPageHandle(payee.id, org.id) && (!own || !payee.paymentPage?.handle)) {
    return {
      code: "NO_PAGE",
      reason: org.type !== "business"
        ? "A payment link opens under your payment page, and you have none yet. Set up your page first."
        : own
          ? `A payment link opens under a payment page, and neither ${org.name} nor you has one yet. Set up a payment page first.`
          : `A link you make for ${org.name} opens under its company payment page, which isn’t set up yet. Owners and admins set it up under Get paid.`,
    };
  }
  if (!linkMethods(payee, user).length) {
    return {
      code: "NO_METHOD",
      reason: own
        ? "No way to get paid is set up on this account yet: activate your IBAN with Monerium, or set up your payment page to take digital dollars."
        : `A link you make for ${org.name} is paid by bank transfer, and its account has no active IBAN yet.`,
    };
  }
  return { payee };
}

/** Whether this caller may make a payment link here, for the UI: it offers
 *  the control only where the API would accept it. */
export function payLinkOffer(ctx: OrgContext): { allowed: boolean; reason?: string; code?: string } {
  if (!roleCan(ctx.member.role, "invoices.manage")) return { allowed: false };
  const user = store.findUser(ctx.userId);
  const blocked = user ? payLinkBlocker(ctx.org, user) : { reason: "Your session has no account behind it." };
  // The code lets the UI put the fix beside the reason (NO_PAGE: "Set up the page").
  return blocked ? { allowed: false, reason: blocked.reason, ...("code" in blocked ? { code: blocked.code } : {}) } : { allowed: true };
}

/** Never throws: the invoice is already issued and numbered, and a 500 here
 *  would invite a retry that issues it twice. Say so and log instead. */
export async function payLinkForInvoice(ctx: OrgContext, invoice: Invoice, baseUrl: string): Promise<InvoicePayLink> {
  try {
    return await withInvoiceLinkLock(invoice, () => payLinkUnlocked(ctx, invoice, baseUrl));
  } catch (err) {
    if (err instanceof PaymentRequestError) return { ok: false, code: "REFUSED", reason: err.message };
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
  const found = payLinkPayee(ctx.org, user);
  if (!("payee" in found)) return { ok: false, ...found };
  const { payee } = found;
  const methods = linkMethods(payee, user);
  const input = validateCreate({ invoiceId: invoice.id, methods, expiresAt: linkExpiry(invoice.dueDate) }, payee);
  const link = await createPaymentRequest(payee, input, { kind: "app" }, ctx.org.id, user.id);
  return { ok: true, url: ownerPaymentRequest(link, baseUrl).url, amountEur: link.amountEur, reused: false };
}
