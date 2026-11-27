/**
 * A bank payout from a company's own IBAN (routes/business/org-monerium-payouts.ts),
 * read from the stored row alone.
 *
 * `pending` is the honest state while Monerium holds the order: the money has
 * not necessarily left. `sent` is Monerium's own `processed` state, the only
 * one that says the SEPA payment was carried out. `failed` means no payout
 * was sent (or Monerium rejected it). `unknown` means Zold cannot tell whether
 * Monerium took the order: the user must not read it as paid, and nothing is
 * retried automatically.
 */
import type { CompanyBankPayout, CompanyPayoutState } from "./types.js";
import { moneriumOrderProcessed } from "./monerium-order.js";

/** What Monerium's order state means for a payout. */
export function payoutStateOf(providerState: string | undefined): CompanyPayoutState {
  if (moneriumOrderProcessed(providerState)) return "sent";
  if (providerState === "rejected" || providerState === "failed" || providerState === "cancelled") return "failed";
  return "pending";
}

/** A payout as a member sees it. The signed message stays server-side: it is
 *  the exact text a passkey approved, not something to re-display. */
export function publicPayout(p: CompanyBankPayout) {
  return {
    id: p.id,
    amountEur: p.amountEur,
    recipientName: p.recipientName,
    recipientIban: p.recipientIban,
    ...(p.reference ? { reference: p.reference } : {}),
    state: p.state,
    ...(p.orderId ? { orderId: p.orderId } : {}),
    ...(p.providerState ? { providerState: p.providerState } : {}),
    ...(p.error ? { error: p.error } : {}),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** The payouts to show, newest first: the latest `limit`, and every older
 *  unresolved one, which still holds money and may need an owner. */
export const recentPayouts = (payouts: CompanyBankPayout[] | undefined, limit = 20): CompanyBankPayout[] =>
  [...(payouts ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((p, i) => i < limit || p.state === "pending" || p.state === "unknown");

/** The rows to keep on the account. An unresolved payout (`pending` or
 *  `unknown`) reserves money, so it is never dropped by the history cap: only
 *  terminal rows are capped, newest first. */
export function capPayouts(payouts: CompanyBankPayout[], terminalLimit = 50): CompanyBankPayout[] {
  const unresolved = payouts.filter((p) => p.state === "pending" || p.state === "unknown");
  const terminal = payouts.filter((p) => p.state !== "pending" && p.state !== "unknown").slice(0, terminalLimit);
  const keep = new Set([...unresolved, ...terminal]);
  return payouts.filter((p) => keep.has(p));
}
