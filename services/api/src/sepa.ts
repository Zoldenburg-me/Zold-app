import { QR_MAX_BYTES } from "./qr.js";

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
const EPC_NAME_MAX = 70;
const EPC_AMOUNT_MAX = 999_999_999.99;

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

/** The BIC Monerium listed for the account's current IBAN, and only for it:
 *  a read from before a move belongs to the old IBAN. Unknown is undefined,
 *  never a BIC guessed from the country code. */
export function reportedBic(user: { iban?: string; ibanBic?: { iban: string; bic: string } }): string | undefined {
  const b = user.ibanBic;
  return b && user.iban && normalizeIban(b.iban) === normalizeIban(user.iban) ? b.bic : undefined;
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

/**
 * The EPC QR payload ("GiroCode", EPC069-12 version 002): what a European
 * banking app scans to prefill a SEPA credit transfer. No amount leaves the
 * field empty for the payer to type. The trailing "information" line is
 * optional and omitted.
 *
 * shortcut: qr.ts encodes level L up to version 6 (134 bytes) where EPC069-12
 * asks for level M, and an over-long name is cut to fit; bank apps read level
 * L, but extend qr.ts if one refuses it or a cut name trips Verification of Payee.
 */
export function epcQrPayload(p: { name: string; iban: string; bic?: string; amountEur?: number; remittance: string }): string {
  if (p.amountEur !== undefined && !(p.amountEur >= 0.01 && p.amountEur <= EPC_AMOUNT_MAX)) {
    throw new RangeError(`an EPC QR amount is 0.01 to ${EPC_AMOUNT_MAX} EUR`);
  }
  const amount = p.amountEur === undefined ? "" : `EUR${p.amountEur.toFixed(2)}`;
  const remittance = p.remittance.replace(/\s+/g, " ").trim().slice(0, SEPA_REMITTANCE_MAX);
  const build = (name: string) =>
    ["BCD", "002", "1", "SCT", p.bic ?? "", name, normalizeIban(p.iban), amount, "", "", remittance].join("\n");
  const name = [...p.name.replace(/\s+/g, " ").trim()].slice(0, EPC_NAME_MAX);
  while (name.length > 1 && new TextEncoder().encode(build(name.join(""))).length > QR_MAX_BYTES) name.pop();
  return build(name.join("").trimEnd());
}
