/**
 * SEPA remittance information — the line the payee reads on their statement.
 *
 * This is the only field that travels with the money, so it is what a merchant
 * reconciles against. A bare `Zold <our uuid>` tells the payee nothing they
 * can act on: a merchant receiving a checkout payment could see that Zold sent
 * it but not which of their users it was for, leaving them matching payments
 * by hand — the manual step the product exists to remove.
 *
 * So the payer's reference leads and our transfer id follows, and both sides
 * can reconcile from the same string.
 *
 * The constraints are the scheme's, not ours. SEPA carries at most 140
 * characters of unstructured remittance information, in the "SEPA Latin"
 * subset. Banks along the way are entitled to drop or mangle anything outside
 * it, and some silently truncate instead of rejecting — so we normalise here
 * rather than discover it on a statement.
 */

/** Characters SEPA guarantees end to end. */
const SEPA_ALLOWED = /[^A-Za-z0-9/\-?:().,'+ ]/g;

export const SEPA_REMITTANCE_MAX = 140;

/** Our own tag, so a payment is still traceable back to a transfer. */
const TAG = "Zold";

/**
 * Fold a string into the SEPA Latin subset.
 *
 * Accents are decomposed and their marks dropped rather than replaced with a
 * space — "Müller" should reach the payee as "Muller", not "M ller". Anything
 * still outside the set becomes a space, and runs of whitespace collapse.
 */
export function toSepaCharset(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ß]/g, "ss")
    .replace(/[Øø]/g, "o")
    .replace(/[Ææ]/g, "ae")
    .replace(/[Đđ]/g, "d")
    .replace(SEPA_ALLOWED, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A slash may not lead, trail, or double up in SEPA remittance information —
 * those forms are reserved for structured codes, and a bank may read
 * `/ABC/` as a field marker rather than as the payer's text.
 */
function stripReservedSlashes(s: string): string {
  return s.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
}

/**
 * Build the remittance line for a payout.
 *
 * With no reference this is unchanged from before — `Zold <transfer id>` — so
 * payouts that are not merchant checkouts keep the string their operators are
 * used to seeing.
 *
 * With one, the reference leads (it is what the payee reconciles on) and a
 * short form of our transfer id trails, kept whole rather than truncated: an
 * id cut in half identifies nothing. If the reference is too long to fit
 * alongside it, the REFERENCE is what gets truncated, and the caller is
 * expected to have refused an over-long reference long before this point.
 */
export function paymentMemo(transferId: string, reference?: string): string {
  const shortId = transferId.replace(/-/g, "").slice(0, 8);
  const ref = stripReservedSlashes(toSepaCharset(reference ?? ""));
  if (!ref) return `${TAG} ${transferId}`.slice(0, SEPA_REMITTANCE_MAX);
  const suffix = ` ${TAG} ${shortId}`;
  const room = SEPA_REMITTANCE_MAX - suffix.length;
  return `${stripReservedSlashes(ref.slice(0, room)).trimEnd()}${suffix}`;
}

export function moneriumAmountString(amountEur: number): string {
  return amountEur.toFixed(2).replace(/\.?0+$/, "");
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

export function moneriumRedeemMessage(amountEur: number, iban: string, issuedAt: string): {
  amount: string;
  iban: string;
  issuedAt: string;
  message: string;
} {
  const amount = moneriumAmountString(amountEur);
  const normalizedIban = normalizeIban(iban);
  return {
    amount,
    iban: normalizedIban,
    issuedAt,
    message: `Send EUR ${amount} to ${normalizedIban} at ${issuedAt}`,
  };
}
