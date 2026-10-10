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
 * Monerium could not be asked: a network error, a timeout, a 5xx or a body
 * that is not JSON. A 4xx is a settled answer and is not this.
 */
export class MoneriumTokensUnavailable extends Error {}

async function allTokens(baseUrl: string): Promise<MoneriumToken[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
  let res: Response;
  try {
    res = await moneriumFetch(`${baseUrl}/tokens`, { signal: AbortSignal.timeout(10_000) });
  } catch (err: any) {
    throw new MoneriumTokensUnavailable(`GET ${baseUrl}/tokens: ${err?.message ?? err}`);
  }
  if (res.status >= 500) throw new MoneriumTokensUnavailable(`GET ${baseUrl}/tokens -> ${res.status}`);
  if (!res.ok) throw new Error(`GET ${baseUrl}/tokens -> ${res.status}`);
  let raw: any[];
  try {
    raw = (await res.json()) as any[];
  } catch (err: any) {
    throw new MoneriumTokensUnavailable(`GET ${baseUrl}/tokens: unreadable body: ${err?.message ?? err}`);
  }
  const tokens = raw
    .filter((t) => t?.kind === "evm" && t?.address && t?.currency === "eur")
    .map((t) => ({
      address: t.address as `0x${string}`,
      decimals: Number(t.decimals),
      chain: String(t.chain),
      chainId: Number(t.chainId),
      symbol: String(t.symbol),
    }));
  cache = { at: Date.now(), tokens };
  return tokens;
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
 * the caller can ask to be retried. A 4xx still reads as none.
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
