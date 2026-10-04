/**
 * The app's dollar token: what deployments.json names as `usdc` on this chain.
 *
 * On Base mainnet that is Circle's USDC. A staging chain can point `usdc` at
 * the ZoldUSD (zUSD) it deployed (`zusd`, from npm run deploy:zusd). The UI
 * labels amounts with the symbol read from the token itself, so a test token
 * is never drawn as USDC; and what only Circle's USDC can do (Bridge.xyz,
 * Candide's cross-chain forwarding) is closed on the staging dollar.
 */
import { parseAbi } from "viem";
import { CHAIN_ID } from "./config.js";
import { addrs, publicClient } from "./chain.js";

const SYMBOL = /^[A-Za-z0-9.]{1,11}$/;
const abi = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

let read: { symbol: string; name: string } | null = null;

/** Is the app's dollar token this deployment's own zUSD? */
export function usdIsStaging(): boolean {
  let d;
  try {
    d = addrs();
  } catch {
    return false; // no deployment for this chain, so no staging dollar either
  }
  return Boolean(d.zusd) && d.usdc.toLowerCase() === d.zusd!.toLowerCase();
}

/** How the token is shown; needs no deployment, so /api/health can always publish it. */
export function usdLabel() {
  return { symbol: read?.symbol ?? "USDC", name: read?.name ?? "USD Coin", staging: usdIsStaging() };
}

export function usdToken() {
  return { address: addrs().usdc, decimals: 6, ...usdLabel() };
}

/**
 * Read the token's symbol and name once, at boot. The staging dollar must be
 * labelled by what it says it is, so failing to read it is fatal; any other
 * token falls back to "USDC", which is what it is everywhere else.
 */
export async function loadUsdToken(): Promise<void> {
  const address = addrs().usdc;
  try {
    const [symbol, name] = await Promise.all([
      publicClient.readContract({ address, abi, functionName: "symbol" }),
      publicClient.readContract({ address, abi, functionName: "name" }),
    ]);
    if (!SYMBOL.test(symbol)) throw new Error(`symbol() returned ${JSON.stringify(symbol)}`);
    read = { symbol, name: String(name).slice(0, 64) };
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    if (usdIsStaging()) {
      throw new Error(`cannot read the staging dollar ${address} on chain ${CHAIN_ID} (${why}); refusing to label it`);
    }
    console.warn(`usd-token: could not read ${address} (${why}); labelling it USDC`);
  }
}
