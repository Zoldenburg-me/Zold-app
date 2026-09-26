/**
 * Live FX mid rates.
 *
 * Don't hardcode these. A constant drifts (one was once 14% off) while the
 * receipt still tells the sender it is "the real exchange rate".
 *
 *   1. No stale fallback. If the feed is unreachable and the cache has aged
 *      out, quoting fails, so a sender is never quoted last month's market.
 *   2. The feed is a reference mid, never a price we trade at: venue quotes
 *      are checked against it (assertPriceSane) and receipts value crypto at
 *      it, but what a swap delivers is measured on chain.
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
  keepOptional(parsed, eur);
  return { eur, asOf: "pinned", fetchedAt: Date.now(), provider: "TRANSF_RATES_FIXED" };
}

/** Currencies every path needs; a response missing one is unusable. */
const REQUIRED = ["USD"] as const;
/** Kept when the feed carries them, for invoice totals shown in another
 *  currency (routes/business/shared.ts). Their absence refuses nothing. */
const OPTIONAL = ["KES"] as const;

export class RateUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `live FX rates unavailable: ${detail}. Quoting is disabled rather than ` +
        `falling back to a stale rate — retry, or set TRANSF_RATES_URL to a reachable feed.`,
    );
    this.name = "RateUnavailableError";
  }
}

function keepOptional(source: any, eur: Record<string, number>): void {
  for (const code of OPTIONAL) {
    const v = source?.[code];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) eur[code] = v;
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
  keepOptional(rates, eur);
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

/** Test/ops hook: drop the cache so the next call refetches. */
export function resetRateCache(): void {
  cache = null;
  inFlight = null;
}
