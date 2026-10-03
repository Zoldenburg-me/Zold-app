/**
 * Which tokens are on a curated list (Uniswap's, CoinGecko's per chain).
 *
 * The lists decide whether a token is priced at all. Each URL is fetched at
 * most once per `tokenListTtlMs`; a copy that fails to refresh stays in use,
 * so a list host being down for a day does not stop the sync. A list that
 * has NEVER loaded is a reason to hold: calling a token unlisted because the
 * list was unreachable would book real pay as valueless, and that row's
 * class is fixed once written.
 */
import { WALLET_SYNC } from "../config.js";

export interface TokenListSet {
  has(chainId: number, address: string): boolean;
  /** How many tokens, for the log line. */
  size: number;
}

export type TokenListsResult = { ok: true; lists: TokenListSet } | { ok: false; reason: string };

const copies = new Map<string, { keys: Set<string>; loadedAt: number }>();

async function fetchList(url: string): Promise<Set<string>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(WALLET_SYNC.priceTimeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const body: any = await res.json();
  if (!Array.isArray(body?.tokens)) throw new Error("is not a token list");
  const keys = new Set<string>();
  for (const t of body.tokens) {
    if (typeof t?.chainId !== "number" || typeof t?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) continue;
    keys.add(`${t.chainId}:${t.address.toLowerCase()}`);
  }
  return keys;
}

export async function loadTokenLists(now = Date.now()): Promise<TokenListsResult> {
  const missing: string[] = [];
  for (const url of WALLET_SYNC.tokenLists) {
    const copy = copies.get(url);
    if (copy && now - copy.loadedAt < WALLET_SYNC.tokenListTtlMs) continue;
    try {
      copies.set(url, { keys: await fetchList(url), loadedAt: now });
    } catch (e) {
      const why = e instanceof Error ? e.message : "did not answer";
      console.warn(`token list ${url}: ${why}${copy ? " (keeping the last copy)" : ""}`);
      if (!copy) missing.push(url);
    }
  }
  if (missing.length) return { ok: false, reason: `${missing.length} of ${WALLET_SYNC.tokenLists.length} token lists never loaded` };
  const all = WALLET_SYNC.tokenLists.map((u) => copies.get(u)!.keys);
  return {
    ok: true,
    lists: {
      has: (chainId, address) => {
        const key = `${chainId}:${address.toLowerCase()}`;
        return all.some((s) => s.has(key));
      },
      size: all.reduce((n, s) => n + s.size, 0),
    },
  };
}

/** For tests. */
export const clearTokenLists = () => copies.clear();
