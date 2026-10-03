import { envNumber } from "./env.js";

/**
 * Imported-wallet sync: ERC-20 transfers in and out of an org's read-only
 * wallets, on any chain with an RPC configured, written to the ledger.
 *
 * One RPC per chain, from `WALLET_SYNC_RPCS` ('{"1":"https://…"}') or
 * `WALLET_SYNC_RPC_<chainId>`. A wallet on a chain with no RPC is not synced
 * and its row says so; there is no public default, because a rate-limited
 * public node skips windows silently.
 */
function rpcMap(): Record<number, string> {
  const out: Record<number, string> = {};
  const raw = process.env.WALLET_SYNC_RPCS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`WALLET_SYNC_RPCS must be JSON like {"1":"https://…"}`);
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k);
      if (!Number.isInteger(id) || id <= 0 || typeof v !== "string" || !/^https?:\/\//.test(v)) {
        throw new Error(`WALLET_SYNC_RPCS: "${k}" must be a chain id mapped to an http(s) URL`);
      }
      out[id] = v;
    }
  }
  for (const [name, v] of Object.entries(process.env)) {
    const m = /^WALLET_SYNC_RPC_(\d+)$/.exec(name);
    if (!m || !v) continue;
    if (!/^https?:\/\//.test(v)) throw new Error(`${name} must be an http(s) URL`);
    out[Number(m[1])] = v;
  }
  return out;
}

const DEFAULT_TOKEN_LISTS = [
  "https://tokens.uniswap.org",
  ...["ethereum", "optimistic-ethereum", "xdai", "polygon-pos", "base", "arbitrum-one"].map(
    (platform) => `https://tokens.coingecko.com/${platform}/all.json`,
  ),
];

export const WALLET_SYNC = {
  enabled: process.env.WALLET_SYNC_ENABLED !== "0",
  rpcs: rpcMap(),
  pollMs: envNumber("WALLET_SYNC_POLL_MS", 60_000, { min: 250 }),
  /** Blocks behind the head before a transfer is booked. A reorged-away
   *  receipt would otherwise stay in the books. */
  confirmations: envNumber("WALLET_SYNC_CONFIRMATIONS", 12, { min: 0, integer: true }),
  /** One getLogs span. Most paid RPCs accept 10k blocks for a topic filter;
   *  2k stays under the stricter ones. */
  maxBlockSpan: BigInt(envNumber("WALLET_SYNC_MAX_BLOCK_SPAN", 2_000, { min: 1, integer: true })),
  /** Windows per wallet per tick, so a backfill catches up without one
   *  wallet holding the loop for minutes. */
  windowsPerTick: envNumber("WALLET_SYNC_WINDOWS_PER_TICK", 20, { min: 1, integer: true }),
  /** Token prices for anything that is not a known stablecoin. DefiLlama's
   *  coins API is keyless and prices by contract address at a timestamp. */
  priceUrl: process.env.WALLET_SYNC_PRICE_URL ?? "https://coins.llama.fi",
  priceTimeoutMs: envNumber("WALLET_SYNC_PRICE_TIMEOUT_MS", 10_000, { min: 100 }),
  /** DefiLlama's own confidence score, 0..1. Below it, no value. */
  minPriceConfidence: envNumber("WALLET_SYNC_MIN_PRICE_CONFIDENCE", 0.9, { min: 0 }),
  /** How far from the block time a price point may be, in seconds. */
  priceSearchWidthSec: envNumber("WALLET_SYNC_PRICE_SEARCH_WIDTH_SEC", 4 * 3600, { min: 60, integer: true }),
  /** Curated token lists (tokenlists.org format). A token on none of them is
   *  booked as a quantity with no value and no income rule: anyone can
   *  airdrop a token, and only a listed one is priced. `WALLET_SYNC_TOKEN_LISTS`
   *  is a JSON array of URLs replacing the default. */
  tokenLists: tokenListUrls(),
  tokenListTtlMs: envNumber("WALLET_SYNC_TOKEN_LIST_TTL_MS", 24 * 3600_000, { min: 60_000 }),
} as const;

function tokenListUrls(): string[] {
  const raw = process.env.WALLET_SYNC_TOKEN_LISTS;
  if (!raw) return DEFAULT_TOKEN_LISTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`WALLET_SYNC_TOKEN_LISTS must be a JSON array of URLs`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) {
    throw new Error(`WALLET_SYNC_TOKEN_LISTS must be a non-empty JSON array of http(s) URLs`);
  }
  return parsed as string[];
}
