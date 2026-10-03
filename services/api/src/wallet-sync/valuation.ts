/**
 * What a token transfer was worth in euro when it arrived.
 *
 * Two paths, both ending at the ECB reference rate for the block's day (the
 * rate the rest of the books use, rates.ts):
 *
 * - A known USD stablecoin, recognised by CONTRACT ADDRESS on its chain, is
 *   one US dollar. The symbol proves nothing: anyone can deploy a token
 *   called USDC.
 * - Anything else is priced in USD by DefiLlama's coins API, by chain and
 *   contract address at the block's timestamp. The answer is refused when
 *   the point is further from the block than WALLET_SYNC.priceSearchWidthSec,
 *   below DefiLlama's own confidence floor, or not a positive number.
 *
 * Fails closed, two ways. `transient: false` is an answer: this token has no
 * usable price, and the caller books the row unvalued. `transient: true` is an
 * outage (the feed or the ECB did not answer): the caller holds the window and
 * tries again, so a blip during a backfill does not leave real income
 * unvalued for good.
 */
import { WALLET_SYNC } from "../config.js";
import { referenceRate } from "../rates.js";
import { cleanSymbol, type Valuation } from "../domain/wallet-transfers.js";

/** USD stablecoins by chain and lower-case contract address. */
export const USD_STABLECOINS: Record<number, Record<string, string>> = {
  1: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  },
  10: { "0x0b2c639c533813f4aa9d7837caf62653d097ff85": "USDC" },
  137: { "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC" },
  8453: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
  42161: { "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC" },
};

/** DefiLlama's names for the chains it prices. */
const PRICE_CHAIN: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "xdai",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
};

export interface ValuationQuery {
  chainId: number;
  token: `0x${string}`;
  /** Whole tokens. */
  amount: number;
  /** ISO time of the block. */
  blockTime: string;
}

export type ValuationResult =
  | { ok: true; valuation: Valuation }
  | { ok: false; reason: string; transient: boolean };

type UsdPrice = { usd: number; symbol: string; source: string } | { reason: string; transient: boolean };

const refused = (reason: string): UsdPrice => ({ reason, transient: false });
const unreachable = (reason: string): UsdPrice => ({ reason, transient: true });

/** The feed's answers by chain, token and hour: a spam airdrop of one token to
 *  many wallets, or a busy window, is one call per hour, not one per
 *  transfer. Outages are not cached. Bounded; cleared when full. */
const priceCache = new Map<string, UsdPrice>();
const PRICE_CACHE_MAX = 5000;
/** For tests that change the stubbed feed between calls. */
export const clearPriceCache = () => priceCache.clear();

async function usdPrice(q: ValuationQuery): Promise<UsdPrice> {
  const token = q.token.toLowerCase();
  const stable = USD_STABLECOINS[q.chainId]?.[token];
  if (stable) return { usd: 1, symbol: stable, source: `${stable} at 1 USD` };
  const hour = Math.floor(Date.parse(q.blockTime) / 3_600_000);
  const cacheKey = `${q.chainId}:${token}:${hour}`;
  const hit = priceCache.get(cacheKey);
  if (hit) return hit;
  const answer = await fetchUsdPrice(q, token);
  if (!("transient" in answer && answer.transient)) {
    if (priceCache.size >= PRICE_CACHE_MAX) priceCache.clear();
    priceCache.set(cacheKey, answer);
  }
  return answer;
}

async function fetchUsdPrice(q: ValuationQuery, token: string): Promise<UsdPrice> {

  const chain = PRICE_CHAIN[q.chainId];
  if (!chain) return refused(`the price feed has no name for chain ${q.chainId}`);
  const ts = Math.floor(Date.parse(q.blockTime) / 1000);
  const hours = Math.max(1, Math.round(WALLET_SYNC.priceSearchWidthSec / 3600));
  const coin = `${chain}:${token}`;
  const url = `${WALLET_SYNC.priceUrl.replace(/\/$/, "")}/prices/historical/${ts}/${coin}?searchWidth=${hours}h`;
  let body: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(WALLET_SYNC.priceTimeoutMs), headers: { accept: "application/json" } });
    // Only an outage holds the window. A 4xx other than "slow down" is the
    // feed's answer about this request, and retrying it every tick would
    // freeze the wallet behind one token.
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return unreachable(`the price feed answered ${res.status}`);
    }
    if (!res.ok) return refused(`the price feed answered ${res.status}`);
    body = await res.json();
  } catch {
    return unreachable("the price feed did not answer");
  }
  const coins = body?.coins && typeof body.coins === "object" ? body.coins : {};
  const p = Object.entries(coins).find(([k]) => k.toLowerCase() === coin)?.[1] as any;
  if (!p) return refused("the price feed has no price for this token");
  if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0) {
    return refused("the price feed returned no positive price");
  }
  if (typeof p.confidence !== "number" || !Number.isFinite(p.confidence)) {
    return refused(`the price feed gave no confidence (the floor is ${WALLET_SYNC.minPriceConfidence})`);
  }
  if (p.confidence < WALLET_SYNC.minPriceConfidence) {
    return refused(`the price feed's confidence ${p.confidence} is under ${WALLET_SYNC.minPriceConfidence}`);
  }
  if (typeof p.timestamp !== "number" || Math.abs(p.timestamp - ts) > WALLET_SYNC.priceSearchWidthSec) {
    return refused("the nearest price point is too far from the block");
  }
  const symbol = cleanSymbol(p.symbol);
  if (!symbol) return refused("the price feed did not name the token");
  const at = new Date(p.timestamp * 1000).toISOString();
  return { usd: p.price, symbol, source: `${symbol} at ${p.price} USD (DefiLlama, ${at})` };
}

export async function valueTransfer(q: ValuationQuery): Promise<ValuationResult> {
  if (!Number.isFinite(Date.parse(q.blockTime))) return { ok: false, reason: "no block time", transient: true };
  const price = await usdPrice(q);
  if ("reason" in price) return { ok: false, reason: price.reason, transient: price.transient };
  let ecb;
  try {
    ecb = await referenceRate("USD", q.blockTime.slice(0, 10));
  } catch {
    return { ok: false, reason: "the ECB reference rate did not answer", transient: true };
  }
  const eurPerUnit = price.usd / ecb.rate;
  const eurValue = Math.round(q.amount * eurPerUnit * 100) / 100;
  if (!Number.isFinite(eurPerUnit) || !Number.isFinite(eurValue) || !(ecb.rate > 0)) {
    return { ok: false, reason: "the value does not fit a number", transient: false };
  }
  return {
    ok: true,
    valuation: {
      eurPerUnit,
      eurValue,
      source: `${price.source}; ECB ${ecb.rate} USD per EUR (${ecb.asOf})`,
      asOf: ecb.asOf,
      symbol: price.symbol,
    },
  };
}
