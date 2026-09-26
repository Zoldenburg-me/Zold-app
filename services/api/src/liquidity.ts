/**
 * The liquidity seam: which venue prices a trade and which one settles it.
 *
 * The venues live in ./liquidity/. This file chooses a provider and prepares
 * the Safe-executed swap that converts an inbound USDC deposit to EURe. A new
 * venue is a file there plus a case in providerById.
 *
 * An unknown provider id throws. Don't fall back to FxSwapper: a
 * LIQUIDITY_PROVIDER typo would then price real transfers off our own
 * inventory while reporting that a maker set the rate.
 *
 * Types and the two rules every venue shares are in ./liquidity/contract.ts,
 * re-exported here for existing importers.
 */
import { FX, LIQUIDITY } from "./config.js";
import { FxSwapperLiquidityProvider } from "./liquidity/fx-swapper.js";
import { RfqLiquidityProvider } from "./liquidity/rfq.js";
import { CowLiquidityProvider } from "./liquidity/cow.js";
import { DexLiquidityProvider } from "./liquidity/uniswap.js";
import { LifiLiquidityProvider } from "./liquidity/lifi.js";
import { BestExecutionProvider } from "./liquidity/best.js";
import type { LiquidityProvider, LiquidityProviderId, SafeSwapPlan } from "./liquidity/contract.js";

export * from "./liquidity/contract.js";
export { BestExecutionProvider };

/** One venue by id. Separate from liquidityProvider() so best execution can
 *  dispatch to the venue that actually priced a quote. */
export function providerById(id: LiquidityProviderId): LiquidityProvider {
  switch (id) {
    case "fx-swapper": return new FxSwapperLiquidityProvider();
    case "rfq": return new RfqLiquidityProvider();
    case "cow": return new CowLiquidityProvider();
    case "dex": return new DexLiquidityProvider();
    case "lifi": return new LifiLiquidityProvider();
    case "best": return new BestExecutionProvider(undefined, providerById);
    default:
      // No FxSwapper fallback: a LIQUIDITY_PROVIDER typo would then price
      // real transfers off our own inventory with no error.
      throw new Error(`unknown liquidity provider "${id}" — check LIQUIDITY_PROVIDER/LIQUIDITY_VENUES`);
  }
}

export function liquidityProvider(): LiquidityProvider {
  return providerById(LIQUIDITY.PROVIDER as LiquidityProviderId);
}

/**
 * The Safe-executed swap for an inbound crypto deposit: USDC in, EURe back
 * into the same Safe.
 *
 * One user-signed batch that approves the venue and executes the swap. The
 * orchestrator never holds the deposit, so the path is non-custodial and needs
 * no API-held owner key.
 *
 * The recipient must be the user's own Safe. There is no payout here; any
 * other recipient would make this a transfer, not a conversion.
 */
export async function prepareDepositConversion(
  safeAddress: `0x${string}`,
  amountUsdcUnits: bigint,
  quoteId: string,
): Promise<{ plan: SafeSwapPlan } | null> {
  const provider = liquidityProvider();
  if (!provider.safeSwapPlan) return null;
  const plan = await provider.safeSwapPlan(
    "USDC_TO_EURE",
    amountUsdcUnits,
    quoteId,
    new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    { executor: safeAddress, recipient: safeAddress },
  );
  return { plan };
}

