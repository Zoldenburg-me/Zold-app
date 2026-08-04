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
const CACHE_MS = 10 * 60 * 1000;

export interface MoneriumToken {
  address: `0x${string}`;
  decimals: number;
  chain: string;
  chainId: number;
  symbol: string;
}

let cache: { at: number; tokens: MoneriumToken[] } | null = null;

async function allTokens(baseUrl: string): Promise<MoneriumToken[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
  const res = await fetch(`${baseUrl}/tokens`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${baseUrl}/tokens -> ${res.status}`);
  const raw = (await res.json()) as any[];
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

/** Same lookup, but a failure to reach Monerium is an error rather than a null. */
export async function requireMoneriumEure(
  baseUrl: string,
  chainId: number,
): Promise<MoneriumToken> {
  const tokens = await allTokens(baseUrl);
  const t = tokens.find((x) => x.chainId === chainId);
  if (!t) throw new Error(`Monerium issues no EUR token on chain ${chainId}`);
  return t;
}

/** Chains where Monerium issues EURe, for error messages and diagnostics. */
export async function moneriumEvmChains(baseUrl: string) {
  return (await allTokens(baseUrl)).map((t) => `${t.chain} (${t.chainId})`);
}
