/**
 * Uniswap v3 as an execution venue.
 *
 * WHY THIS EXISTS. The FxSwapper holds inventory we fund, which does not scale
 * past a demo — the whole point of the liquidity seam is to stop carrying a
 * treasury. The two venues tried before both dead-ended: Bebop returns
 * TokenNotSupported for EURe on every chain we care about and publishes no
 * testnet, and CoW quotes well on Gnosis but cannot execute without deciding
 * who signs the order. Uniswap v3 is the one venue that both lists our tokens
 * and can be exercised on a testnet, because the pool is just a contract.
 *
 * On mainnet the counterparty is everyone else's liquidity, so there is no
 * treasury. On a testnet nobody has made a EURe market, so `npm run dex:setup`
 * creates and seeds a pool — that is a TEST FIXTURE, not inventory, and it is
 * why the numbers on Base Sepolia are ours rather than a market's.
 *
 * Everything here fails closed. No pool, no liquidity, a stale quote, or a
 * price that disagrees with the independent FX feed all REFUSE. A swap that
 * silently settles at a bad rate is worse than one that does not happen.
 */
import { parseAbi } from "viem";
import { LIQUIDITY } from "./config.js";
import { publicClient } from "./chain.js";
import { eurPer } from "./rates.js";

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
export const poolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
export const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export interface DexPool {
  address: `0x${string}`;
  fee: number;
  liquidity: bigint;
}

/**
 * The deepest pool for the pair, not merely the first one that exists.
 *
 * A pool can exist with zero liquidity — `getPool` returns an address the
 * moment anybody calls `createPool`, initialised or not. Quoting against that
 * reverts deep inside the quoter with nothing useful attached, so the depth is
 * read here and an empty pool is treated as absent.
 */
export async function bestPool(
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
): Promise<DexPool | null> {
  const found: DexPool[] = [];
  for (const fee of LIQUIDITY.DEX_FEE_TIERS) {
    const address = (await publicClient.readContract({
      address: LIQUIDITY.DEX_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [tokenA, tokenB, fee],
    })) as `0x${string}`;
    if (address === ZERO) continue;
    const liquidity = (await publicClient.readContract({
      address,
      abi: poolAbi,
      functionName: "liquidity",
    })) as bigint;
    if (liquidity > 0n) found.push({ address, fee, liquidity });
  }
  if (!found.length) return null;
  return found.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0))[0];
}

/**
 * Simulate the swap the router would perform.
 *
 * QuoterV2 is deliberately non-view — it executes the swap and reverts to
 * return the result — so it must be `simulateContract`, never `readContract`.
 * The value is the router's own arithmetic rather than a reimplementation of
 * the tick math, which is the only way the quote and the trade agree.
 */
export async function quoteExactInputSingle(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  fee: number;
}): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: LIQUIDITY.DEX_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        fee: args.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const amountOut = (result as readonly bigint[])[0];
  if (!amountOut || amountOut <= 0n) {
    throw new Error("dex quoter returned zero out — pool cannot fill this size");
  }
  return amountOut;
}

/**
 * Refuse a pool price that disagrees with the outside world.
 *
 * THE POINT OF THIS FUNCTION. An RFQ maker names a price it will honour. A
 * pool has no opinion — its price is wherever the last trade left it, and a
 * thin pool can be pushed a long way by anyone willing to spend. Without an
 * independent check, skewing a pool would make this system quote, bind and
 * settle a real transfer at that skewed rate while reporting it as the market.
 *
 * `rates.ts` is the independent opinion: a different source, already
 * fail-closed, and already what the receipt is measured against. If the two
 * disagree by more than the band, we refuse rather than pick a winner.
 */
export async function assertPriceSane(
  impliedUsdPerEur: number,
  /** Which venue produced this price. Shared by the DEX and LI.FI providers,
   *  so the refusal must name the venue an operator is actually using. */
  venue = "dex pool",
): Promise<{ mid: number; deviationBps: number }> {
  if (!Number.isFinite(impliedUsdPerEur) || impliedUsdPerEur <= 0) {
    throw new Error(`${venue} implied rate is not a positive number — refusing to quote`);
  }
  // eurPer("USD") is USD per 1 EUR — the same orientation as the pool price.
  const mid = await eurPer("USD");
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error("live FX mid unavailable — refusing to trade against an unchecked pool price");
  }
  const deviationBps = Math.round((Math.abs(impliedUsdPerEur - mid) / mid) * 10_000);
  const limit = Number(LIQUIDITY.DEX_MAX_MID_DEVIATION_BPS);
  if (deviationBps > limit) {
    throw new Error(
      `${venue} price ${impliedUsdPerEur.toFixed(6)} USD/EUR deviates ${deviationBps}bps from the live mid ` +
        `${mid.toFixed(6)} (limit ${limit}bps). Refusing — a pool this far from the market is either thin ` +
        `or being moved, and settling against it would price a real transfer off a number nobody else agrees with.`,
    );
  }
  return { mid, deviationBps };
}

/**
 * USDC-per-EURe as the 6dp integer the rest of the system uses for `rate`.
 *
 * Always this orientation regardless of trade direction, matching FxSwapper's
 * single `rate()`; otherwise the reverse leg would report a reciprocal and
 * FP5's binding check would compare two different things.
 */
export function rate6dp(eureWei: bigint, usdcUnits: bigint): bigint {
  if (eureWei <= 0n) throw new Error("cannot derive a rate from a zero EURe amount");
  return (usdcUnits * 10n ** 18n) / eureWei;
}
