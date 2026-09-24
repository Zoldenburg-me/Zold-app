/**
 * SEPA remittance information: the line the payee reads on their statement.
 *
 * It is the only field that travels with the money, so merchants reconcile
 * against it. A bare `Zold <our uuid>` does not tell a merchant which of their
 * users a checkout payment was for. So the payer's reference leads and our
 * transfer id follows, and both sides reconcile from the same string.
 *
 * SEPA carries at most 140 characters of unstructured remittance information,
 * in the "SEPA Latin" subset. Banks may drop or mangle anything outside it,
 * and some truncate without rejecting, so we normalise here.
 */

/** Characters SEPA guarantees end to end. */
const SEPA_ALLOWED = /[^A-Za-z0-9/\-?:().,'+ ]/g;

export const SEPA_REMITTANCE_MAX = 140;

/** What the payee reads next to our transfer id on their statement, so a
 *  payment is still traceable back to a transfer. Kept short: every character
 *  here is one fewer for the payer's own reference. */
const TAG = "Powered by Zold";

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
 * With no reference the line is `Powered by Zold <transfer id>`, so a payee
 * sees who sent it and an operator can find the transfer from the statement.
 *
 * With one, the reference leads (the payee reconciles on it) and a short form
 * of our transfer id trails, always whole. If both do not fit, the reference
 * is truncated; callers should already have refused an over-long reference.
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
