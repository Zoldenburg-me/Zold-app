import { randomUUID } from "node:crypto";
import { FX, railFeeEur } from "./config.js";
import { store, type Quote } from "./store.js";

import type { PayoutRail } from "./store.js";

/**
 * Quote engine.
 * - sepa (EUR -> EUR bank): no FX, fixed fee only; payout via Monerium
 *   redeem order (EURe burned, SEPA transfer out).
 *
 * A rail with an FX leg would quote two rates — the live market mid (a
 * reference we do not trade at) and what the venue can actually deliver —
 * and measure marginBps as the gap between them. SEPA has neither, so both
 * are 1 and the margin is 0.
 */
export interface QuoteRequest {
  rail: PayoutRail;
  sendEur?: number; // sender-fixed
}

export async function createQuote(userId: string, req: QuoteRequest): Promise<Quote> {
  const sendEur = req.sendEur ?? 0;
  const fee = railFeeEur(req.rail);
  const convertible = sendEur - fee;
  if (convertible <= 0) throw new Error(fee > 0 ? `amount must exceed the €${fee} fee` : "amount must be positive");
  const quote: Quote = {
    id: randomUUID(),
    userId,
    rail: req.rail,
    status: "OPEN",
    expiresAt: new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
    sendEur,
    fixedFeeEur: fee,
    midRate: 1,
    fxRate: 1,
    marginBps: 0,
    effectiveRate: round(convertible / sendEur, 4),
    receiveEur: round(convertible, 2),
  };
  store.addQuote(quote);
  return quote;
}

export function isExpired(q: Quote): boolean {
  return Date.now() > Date.parse(q.expiresAt);
}

function round(x: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
