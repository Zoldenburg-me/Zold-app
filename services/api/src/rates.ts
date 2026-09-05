/**
 * Live FX mid rates.
 *
 * Never hardcode these. A constant drifts silently while the receipt keeps
 * telling the sender it is using "the real exchange rate" — a number that is
 * wrong by 14% and labelled honest is worse than one that is openly a mock,
 * so the rate comes from a feed.
 *
 * Two rules follow from that:
 *
 *   1. NO STALE FALLBACK. If the feed cannot be reached and the cache has aged
 *      out, quoting fails. Serving a stale rate is how a sender is quietly
 *      quoted last month's market; refusing is visible and recoverable.
 *   2. The feed only supplies the FIAT legs (USD->INR, USD->KES) that a payout
 *      partner settles. The EUR->USD leg is whatever the on-chain swapper will
 *      actually execute at, read from the chain — see fx.ts. A feed rate we
 *      cannot trade at is a promise we cannot keep.
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
 * A rate that does not move is exactly the thing this module exists to
 * prevent, so it is fail-closed in production the way ALLOW_MOCK_FALLBACK is.
 * A hosted deploy that inherits this env var by accident would quote a frozen
 * rate and look completely healthy doing it.
 */
function pinned(): MidRates | null {
  const raw = process.env.TRANSF_RATES_FIXED;
  if (!raw) return null;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_FIXED_RATES !== "1") {
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
const REQUIRED = ["USD", "INR", "KES"] as const;

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
}

/** For /api/health and the startup log — never throws. */
export function rateCacheStatus() {
  return cache
    ? {
        provider: cache.provider,
        asOf: cache.asOf,
        ageMs: Date.now() - cache.fetchedAt,
        fresh: fresh(cache),
        eur: cache.eur,
      }
    : { provider: null, asOf: null, ageMs: null, fresh: false, eur: {} };
}
