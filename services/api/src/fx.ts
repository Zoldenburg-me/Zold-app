import { randomUUID } from "node:crypto";
import { FX } from "./config.js";
import { store, type Quote } from "./store.js";
import { eurPer, usdPer } from "./rates.js";
import { liquidityProvider } from "./liquidity.js";

import type { PayoutRail } from "./store.js";

/**
 * Quote engine.
 * - cash (EUR -> KES): executable EUR->USD, then live USD->KES, minus our
 *   spread, plus a fixed fee. On-chain leg swaps EURe->USDC; MoneyGram handles
 *   USD->KES at payout.
 * - upi  (EUR -> INR): same shape, INR leg, smaller fee.
 * - sepa (EUR -> EUR bank): no FX — fixed fee only; payout via Monerium
 *   redeem order (EURe burned, SEPA transfer out).
 *
 * TWO DIFFERENT RATES, ON PURPOSE:
 *
 *   midRate  — the true market mid from the live feed (EUR->KES/INR directly).
 *              This is the "real exchange rate" line on the receipt. It is a
 *              reference we do NOT trade at.
 *   fxRate   — what we can actually deliver: the on-chain swapper's EUR->USD
 *              rate (the one the swap will really execute at), times the live
 *              USD->fiat leg, minus our spread.
 *
 * marginBps is then MEASURED as the gap between them, not asserted. That
 * matters: the receipt used to state a flat "0.50% margin" while the mid was a
 * stale constant 14% off the market, so the stated margin and the real one had
 * nothing to do with each other. If the on-chain rate drifts from the market,
 * the margin line grows and the drift is visible instead of hidden.
 */
export interface QuoteRequest {
  rail: PayoutRail;
  sendEur?: number; // cash + sepa: sender-fixed
  receiveInr?: number; // upi: recipient-fixed (the amount on the merchant QR)
}

/** Legs of a corridor quote, resolved from the chain + the live feed. */
async function corridorRates(fiat: "KES" | "INR") {
  // Executable EUR->USD, asked of whichever liquidity source will actually
  // fill the swap — the local swapper or a market maker over RFQ. Reading the
  // swapper contract directly here would keep quoting the mock's price after a
  // deployment switched to RFQ, which looks completely healthy while being
  // wrong. FP5 re-checks the rate against the same provider at execution.
  const { rate, raw } = await liquidityProvider().indicativeRate("EURE_TO_USDC");
  const usdFiat = await usdPer(fiat); // live: what a partner settles at
  const marketMid = await eurPer(fiat); // live: true EUR->fiat mid, reference only
  const allIn = rate * usdFiat * (1 - FX.SPREAD_BPS / 10_000);
  return { marketMid, allIn, lockedSwapRate: String(raw) };
}

/** How far `allIn` sits below the market mid, in bps. Never negative. */
const marginBps = (mid: number, allIn: number) =>
  Math.max(0, Math.round(((mid - allIn) / mid) * 10_000));

export async function createQuote(userId: string, req: QuoteRequest): Promise<Quote> {
  const base = {
    id: randomUUID(),
    userId,
    rail: req.rail,
    status: "OPEN" as const,
    receiveKes: 0,
    receiveEur: 0,
    receiveInr: 0,
    expiresAt: new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };

  let quote: Quote;
  if (req.rail === "upi") {
    // Two quote modes: INR-fixed (merchant QR states the bill — compute the
    // EUR the sender pays) or EUR-fixed (sender picks what to send — compute
    // what arrives), used by the destination-first send flow.
    const { marketMid, allIn, lockedSwapRate } = await corridorRates("INR");
    let sendEur: number;
    let receiveInr: number;
    if (req.receiveInr && req.receiveInr > 0) {
      receiveInr = req.receiveInr;
      sendEur = round(receiveInr / allIn + FX.UPI_FIXED_FEE_EUR, 2);
    } else if (req.sendEur && req.sendEur > FX.UPI_FIXED_FEE_EUR) {
      sendEur = req.sendEur;
      receiveInr = round((sendEur - FX.UPI_FIXED_FEE_EUR) * allIn, 2);
    } else {
      throw new Error("receiveInr or sendEur required for upi quotes");
    }
    quote = {
      ...base,
      lockedSwapRate,
      sendEur,
      fixedFeeEur: FX.UPI_FIXED_FEE_EUR,
      midRate: round(marketMid, 4),
      fxRate: round(allIn, 4),
      marginBps: marginBps(marketMid, allIn),
      effectiveRate: round(receiveInr / sendEur, 4),
      receiveInr,
    };
  } else {
    const sendEur = req.sendEur ?? 0;
    const fee = FX.FIXED_FEE_EUR;
    const convertible = sendEur - fee;
    if (convertible <= 0) throw new Error("amount below fixed fee");
    if (req.rail === "sepa") {
      quote = {
        ...base,
        // No FX leg, so nothing to bind to the swapper.
        sendEur,
        fixedFeeEur: fee,
        midRate: 1,
        fxRate: 1,
        marginBps: 0,
        effectiveRate: round(convertible / sendEur, 4),
        receiveEur: round(convertible, 2),
      };
    } else {
      const { marketMid, allIn, lockedSwapRate } = await corridorRates("KES");
      const receiveKes = round(convertible * allIn, 2);
      quote = {
        ...base,
        lockedSwapRate,
        sendEur,
        fixedFeeEur: fee,
        midRate: round(marketMid, 4),
        fxRate: round(allIn, 4),
        marginBps: marginBps(marketMid, allIn),
        effectiveRate: round(receiveKes / sendEur, 4),
        receiveKes,
      };
    }
  }
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
