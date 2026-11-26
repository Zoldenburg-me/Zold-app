import { normalizeIban } from "../sepa.js";

/**
 * The Monerium order state that means the order was carried out: for a
 * redeem, the SEPA payment left Monerium. Placed, pending and every other
 * state prove only that Monerium holds the order.
 */
export const MONERIUM_ORDER_PROCESSED = "processed";

export const moneriumOrderProcessed = (state: string | undefined): boolean => state === MONERIUM_ORDER_PROCESSED;

/** A Monerium amount in euros, or undefined unless it is a plain decimal
 *  with at most two significant decimals ("12.5", "12.50", "12.500000").
 *  `Number` alone reads "0x10" as 16 and "Infinity" as an amount. */
export function moneriumAmountEur(v: unknown): number | undefined {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d{1,12}(\.\d{1,2}0*)?$/.test(s)) return undefined;
  return Number(s);
}

/** Which field of a redeem order Monerium reports differs from the redeem a
 *  transfer signed (amount, IBAN) from `address`, or undefined when none
 *  does. Names the field only: the values are Monerium's and the payee's. */
export function redeemOrderDiffers(order: any, signed: { amount: string; iban: string }, address: string): string | undefined {
  if (order?.kind !== "redeem") return "kind";
  if (String(order.currency ?? "").toLowerCase() !== "eur") return "currency";
  const got = moneriumAmountEur(order.amount);
  const want = moneriumAmountEur(signed.amount);
  if (got === undefined || want === undefined || Math.round(got * 100) !== Math.round(want * 100)) return "amount";
  if (String(order.address ?? "").toLowerCase() !== address.toLowerCase()) return "Safe address";
  const iban = order.counterpart?.identifier?.iban;
  if (typeof iban !== "string" || normalizeIban(iban) !== normalizeIban(signed.iban)) return "recipient IBAN";
  return undefined;
}

/** Why a redeem order's memo is not the memo the transfer signed, or
 *  undefined when it is. Compared with the stored memo, never a regenerated
 *  one: an older transfer signed the full-id memo, and paymentMemo now makes a
 *  short-id one. An order that carries no memo proves nothing either way, so it
 *  is a mismatch (review), never PAID. */
export function redeemMemoDiffers(order: any, signedMemo: string | undefined): string | undefined {
  if (!signedMemo) return "payment memo (the transfer signed none)";
  if (typeof order?.memo !== "string" || order.memo === "") return "payment memo (Monerium's answer carries none)";
  if (order.memo !== signedMemo) return "payment memo";
  return undefined;
}
