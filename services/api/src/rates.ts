/**
 * Live FX mid rates.
 *
 * Don't hardcode these. A constant drifts (one was once 14% off) while the
 * receipt still tells the sender it is "the real exchange rate".
 *
 *   1. No stale fallback. If the feed is unreachable and the cache has aged
 *      out, quoting fails, so a sender is never quoted last month's market.
 *   2. The feed only supplies the fiat legs (USD->KES) that a payout partner
 *      settles. The EUR->USD leg is the on-chain swapper's executable rate,
 *      read from the chain (see fx.ts), since we cannot trade at a feed rate.
 */
import { RATES } from "./config.js";

export interface MidRates {
  /** Units of the quote currency per 1 EUR. */
  eur: Record<string, number>;
  /** When the provider says these were published. */
  asOf: string;
  /** When we fetched them. */
  fetchedAt: number;
  provider: string;
}

let cache: MidRates | null = null;
let inFlight: Promise<MidRates> | null = null;

/**
 * Pinned rates for tests and offline demos: TRANSF_RATES_FIXED='{"USD":1.14,…}'.
 *
 * Refused in production unless ALLOW_FIXED_RATES=1. A hosted deploy that
 * inherits this env var by accident would quote a frozen rate and still look
 * healthy.
 */
function pinned(): MidRates | null {
  const raw = process.env.TRANSF_RATES_FIXED;
  if (!raw) return null;
  // Read at call time, not import time: the same two signals config.ts uses,
  // but a harness can flip them per case.
  const production = process.env.NODE_ENV === "production" || process.env.TRANSF_PRODUCTION === "1";
  if (production && process.env.ALLOW_FIXED_RATES !== "1") {
    throw new RateUnavailableError(
      "TRANSF_RATES_FIXED is set in production — a frozen rate quotes real money at a " +
        "made-up price. Unset it, or set ALLOW_FIXED_RATES=1 to override deliberately.",
    );
  }
  const parsed = JSON.parse(raw);
  const eur: Record<string, number> = {};
  for (const code of REQUIRED) {
    const v = parsed[code];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new RateUnavailableError(`TRANSF_RATES_FIXED is missing a valid ${code}`);
    }
    eur[code] = v;
  }
  return { eur, asOf: "pinned", fetchedAt: Date.now(), provider: "TRANSF_RATES_FIXED" };
}

/** Currencies every quote path needs; a response missing one is unusable. */
const REQUIRED = ["USD", "KES"] as const;

export class RateUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `live FX rates unavailable: ${detail}. Quoting is disabled rather than ` +
        `falling back to a stale rate — retry, or set TRANSF_RATES_URL to a reachable feed.`,
    );
    this.name = "RateUnavailableError";
  }
}

function parse(body: any, provider: string): MidRates {
  // open.er-api.com: { result, time_last_update_utc, rates: {...} }
  // frankfurter:     { date, base, rates: {...} }
  const rates = body?.rates;
  if (!rates || typeof rates !== "object") throw new Error("no rates object in response");
  const eur: Record<string, number> = {};
  for (const code of REQUIRED) {
    const v = rates[code];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`missing or invalid rate for ${code}`);
    }
    eur[code] = v;
  }
  const base = body?.base ?? body?.base_code;
  if (base && String(base).toUpperCase() !== "EUR") {
    throw new Error(`feed returned base ${base}, expected EUR`);
  }
  return {
    eur,
    asOf: String(body?.time_last_update_utc ?? body?.date ?? "unknown"),
    fetchedAt: Date.now(),
    provider,
  };
}

async function fetchRates(): Promise<MidRates> {
  const url = RATES.URL;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(RATES.TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return parse(await res.json(), new URL(url).host);
}

const fresh = (r: MidRates | null): r is MidRates =>
  !!r && Date.now() - r.fetchedAt < RATES.TTL_MS;

/**
 * Current mid rates, cached for RATES.TTL_MS.
 *
 * Concurrent callers share one in-flight request: a burst of quotes must not
 * become a burst of upstream calls, and a rate-limited feed is an unavailable
 * feed.
 */
export async function midRates(): Promise<MidRates> {
  const fixed = pinned();
  if (fixed) return fixed;
  if (fresh(cache)) return cache;
  if (!inFlight) {
    inFlight = fetchRates()
      .then((r) => {
        cache = r;
        return r;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  try {
    return await inFlight;
  } catch (e: any) {
    // Deliberately no stale fallback — see the note at the top of this file.
    throw new RateUnavailableError(e?.message ?? String(e));
  }
}

/** Units of `code` per 1 EUR, from the live mid. */
export async function eurPer(code: string): Promise<number> {
  const r = await midRates();
  const v = r.eur[code.toUpperCase()];
  if (!v) throw new RateUnavailableError(`no rate for ${code}`);
  return v;
}

/**
 * Units of `code` per 1 USD, derived from the EUR legs.
 *
 * The fiat leg a payout partner settles is USD-denominated (we deliver USDC),
 * so this is the number that belongs downstream of the on-chain swap.
 */
export async function usdPer(code: string): Promise<number> {
  const r = await midRates();
  const usd = r.eur.USD;
  const target = r.eur[code.toUpperCase()];
  if (!usd || !target) throw new RateUnavailableError(`no rate for ${code}`);
  return target / usd;
}

/** Test/ops hook: drop the cache so the next call refetches. */
export function resetRateCache(): void {
  cache = null;
  inFlight = null;
  referenceCache.clear();
}

// ── ECB reference rates, for valuing what the books record ──────────────────

export interface ReferenceRate {
  /** Units of `code` per 1 EUR. */
  rate: number;
  code: string;
  /** The business day the ECB fixed it (YYYY-MM-DD). On a weekend, holiday or
   *  before the day's 16:00 CET publication this is EARLIER than the day
   *  asked for, and the Beleg says so. */
  asOf: string;
  provider: string;
  fetchedAt: string;
}

const referenceCache = new Map<string, ReferenceRate>();

/**
 * The ECB reference rate for a calendar day, from Frankfurter.
 *
 * Valuation, not pricing: a crypto receipt is booked at the day's reference
 * rate (the source the 2025 BMF letter on Aufzeichnungspflichten accepts when
 * applied consistently), while every trade is still checked against the live
 * mid. Pinned rates (TRANSF_RATES_FIXED) serve here too, under their own
 * provider name, so an offline harness can value a receipt without the ECB.
 *
 * Fails closed: no rate, no value, never a guess. The caller records nothing
 * and can value later.
 */
export async function referenceRate(code: string, day?: string): Promise<ReferenceRate> {
  const upper = code.toUpperCase();
  const fixed = pinned();
  if (fixed) {
    const v = fixed.eur[upper];
    if (!v) throw new RateUnavailableError(`no pinned reference rate for ${upper}`);
    const asOf = day ?? new Date().toISOString().slice(0, 10);
    return { rate: v, code: upper, asOf, provider: fixed.provider, fetchedAt: new Date().toISOString() };
  }
  const key = `${upper}:${day ?? "latest"}`;
  const hit = referenceCache.get(key);
  // A dated fixing never changes; "latest" may, once a day.
  if (hit && (day || Date.now() - Date.parse(hit.fetchedAt) < RATES.TTL_MS)) return hit;
  const url = new URL(`${RATES.ECB_URL.replace(/\/$/, "")}/${day ?? "latest"}`);
  url.searchParams.set("base", "EUR");
  url.searchParams.set("symbols", upper);
  let body: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(RATES.TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url.host} responded ${res.status}`);
    body = await res.json();
  } catch (e: any) {
    throw new RateUnavailableError(`ECB reference rate: ${e?.message ?? e}`);
  }
  const v = body?.rates?.[upper];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RateUnavailableError(`ECB reference feed has no ${upper} rate`);
  }
  if (String(body?.base ?? "EUR").toUpperCase() !== "EUR") {
    throw new RateUnavailableError(`ECB reference feed returned base ${body.base}, expected EUR`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.date ?? ""))) {
    throw new RateUnavailableError("ECB reference feed did not say which day it fixed");
  }
  const out: ReferenceRate = {
    rate: v,
    code: upper,
    asOf: body.date,
    provider: `ecb via ${url.host}`,
    fetchedAt: new Date().toISOString(),
  };
  referenceCache.set(key, out);
  return out;
}
