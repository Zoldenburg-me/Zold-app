/**
 * Which EURe contract Monerium actually issues on a given chain.
 *
 * Locally we deploy a MockToken and mint it ourselves, which is the only way
 * to have EURe on a hardhat node. On a chain where Monerium is really live
 * (Amoy, Sepolia, Base Sepolia, …) minting our own would be worse than
 * useless: a deposit mints Monerium's REAL EURe into the user's Safe, and
 * the Safe balance is the account balance.
 *
 * The address is read from Monerium rather than hardcoded — it differs per
 * chain, and a wrong one is invisible: balances read zero and it looks like
 * the deposit never arrived.
 */
import { moneriumFetch } from "./monerium-limit.js";
import { redactedMessage } from "../http/log-cause.js";

const CACHE_MS = 10 * 60 * 1000;

export interface MoneriumToken {
  address: `0x${string}`;
  decimals: number;
  chain: string;
  chainId: number;
  symbol: string;
}

let cache: { at: number; tokens: MoneriumToken[] } | null = null;

/**
 * Monerium could not be asked: a network error, a timeout, a 5xx, a 4xx that
 * means "not now" (429, 408, 425) or "not you" (401, 403), or a body that is
 * not a token list. Only a 400 or 404 is a settled answer and is not this.
 */
export class MoneriumTokensUnavailable extends Error {
  override name = "MoneriumTokensUnavailable";
}

const SETTLED_STATUSES = new Set([400, 404]);
/**
 * After an outage, callers get the same error without asking again for this
 * long. The poller walks its orders one by one, so without it each pending
 * order would wait out its own 10 s timeout in the same tick.
 */
const OUTAGE_COOLDOWN_MS = 2_000;
let outage: { until: number; error: MoneriumTokensUnavailable } | null = null;
/** One request at a time: concurrent callers share it. */
let inFlight: Promise<MoneriumToken[]> | null = null;

async function allTokens(baseUrl: string): Promise<MoneriumToken[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
  if (outage && Date.now() < outage.until) throw outage.error;
  inFlight ??= fetchTokens(baseUrl).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchTokens(baseUrl: string): Promise<MoneriumToken[]> {
  try {
    const tokens = await readTokens(baseUrl);
    cache = { at: Date.now(), tokens };
    outage = null;
    return tokens;
  } catch (err) {
    if (err instanceof MoneriumTokensUnavailable) outage = { until: Date.now() + OUTAGE_COOLDOWN_MS, error: err };
    throw err;
  }
}

async function readTokens(baseUrl: string): Promise<MoneriumToken[]> {
  const where = `GET ${baseUrl}/tokens`;
  let res: Response;
  try {
    res = await moneriumFetch(`${baseUrl}/tokens`, { signal: AbortSignal.timeout(10_000) });
  } catch (err: any) {
    throw new MoneriumTokensUnavailable(`${where}: ${redactedMessage(err)}`);
  }
  if (SETTLED_STATUSES.has(res.status)) throw new Error(`${where} -> ${res.status}`);
  if (!res.ok) throw new MoneriumTokensUnavailable(`${where} -> ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err: any) {
    throw new MoneriumTokensUnavailable(`${where}: unreadable body: ${redactedMessage(err)}`);
  }
  if (!Array.isArray(raw)) throw new MoneriumTokensUnavailable(`${where}: body is not a token list`);
  return raw
    .filter((t) => t?.kind === "evm" && t?.address && t?.currency === "eur")
    .map((t) => ({
      address: t.address as `0x${string}`,
      decimals: Number(t.decimals),
      chain: String(t.chain),
      chainId: Number(t.chainId),
      symbol: String(t.symbol),
    }));
}

/**
 * The real EURe for `chainId`, or null if Monerium does not issue there (which
 * is the normal case for a local hardhat node).
 */
export async function moneriumEure(
  baseUrl: string,
  chainId: number,
): Promise<MoneriumToken | null> {
  try {
    const tokens = await allTokens(baseUrl);
    return tokens.find((t) => t.chainId === chainId) ?? null;
  } catch {
    // Caller decides: the deploy refuses rather than silently falling back to
    // a mock on a chain where the real token exists.
    return null;
  }
}

/**
 * The same lookup for a caller deciding whether a deposit landed: an outage
 * throws MoneriumTokensUnavailable instead of reading as "no EURe here", so
 * the caller can ask to be retried. A 400 or 404 still reads as none.
 */
export async function moneriumEureOrUnavailable(
  baseUrl: string,
  chainId: number,
): Promise<MoneriumToken | null> {
  try {
    const tokens = await allTokens(baseUrl);
    return tokens.find((t) => t.chainId === chainId) ?? null;
  } catch (err) {
    if (err instanceof MoneriumTokensUnavailable) throw err;
    return null;
  }
}

/** Chains where Monerium issues EURe, for error messages and diagnostics. */
export async function moneriumEvmChains(baseUrl: string) {
  return (await allTokens(baseUrl)).map((t) => `${t.chain} (${t.chainId})`);
}
