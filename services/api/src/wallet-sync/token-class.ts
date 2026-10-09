/**
 * What kind of thing a token is, for the books.
 *
 * - `emoney`: EURe, Monerium's euro e-money. One token is one euro, at par;
 *   it opens no tax lot and its disposal has no gain. Recognised by the
 *   issuer's contract address on each chain, never by symbol.
 * - `listed`: a virtual asset on a curated token list (USDC and USDT by
 *   address count as listed). Priced at receipt, FIFO lots, the income rule.
 * - `unlisted`: on no list. Anyone can deploy a token and send it to a Safe,
 *   so sync books nothing for it: an airdrop never inflates revenue or the
 *   database, and a thinly traded token is never priced. Rows booked before
 *   that rule are `unlisted_token` quantities with no value.
 */
import type { TokenClass } from "../domain/wallet-transfers.js";
import { USD_STABLECOINS } from "./valuation.js";

export type { TokenClass };

/** EURe by chain, from Monerium's token registry (GET api.monerium.app/tokens,
 *  read 2026-10-03). The app chain's own deployment is added at runtime. */
export const EMONEY_TOKENS: Record<number, Record<string, string>> = {
  1: { "0x39b8b6385416f4ca36a20319f70d28621895279d": "EURe" },
  100: { "0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430": "EURe" },
  137: { "0xe0aea583266584dafbb3f9c3211d5588c73fea8d": "EURe" },
  8453: { "0xbf6e2966a9c3d99c9e4d069e04f7bdb9c8aa762c": "EURe" },
  42161: { "0x0c06ccf38114ddfc35e07427b9424adcca9f44f8": "EURe" },
  59144: { "0x3ff47c5bf409c86533fe1f4907524d304062428d": "EURe" },
};

export function emoneySymbol(chainId: number, address: string, extra?: Record<number, Record<string, string>>): string | undefined {
  const a = address.toLowerCase();
  return extra?.[chainId]?.[a] ?? EMONEY_TOKENS[chainId]?.[a];
}

export function classifyToken(
  chainId: number,
  address: string,
  listed: (chainId: number, address: string) => boolean,
  extraEmoney?: Record<number, Record<string, string>>,
): TokenClass {
  const a = address.toLowerCase();
  if (emoneySymbol(chainId, a, extraEmoney)) return "emoney";
  if (USD_STABLECOINS[chainId]?.[a] || listed(chainId, a)) return "listed";
  return "unlisted";
}
