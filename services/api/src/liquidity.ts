/**
 * The liquidity seam: which venue prices a trade, which one settles it, and
 * how a quote survives the gap between them.
 *
 * The venues live in ./liquidity/. This file chooses a provider, persists the
 * quote that priced a transfer, and dispatches execution back to the venue
 * that quoted it. A new venue is a file there plus a case in providerById.
 *
 * An unknown provider id throws. Don't fall back to FxSwapper: a
 * LIQUIDITY_PROVIDER typo would then price real transfers off our own
 * inventory while reporting that a maker set the rate.
 *
 * Types and the two rules every venue shares are in ./liquidity/contract.ts,
 * re-exported here for existing importers.
 */
import { FX, LIQUIDITY, railFeeEur } from "./config.js";
import { eur, usd } from "./chain.js";
import type { Transfer } from "./store.js";
import { store } from "./store.js";
import { FxSwapperLiquidityProvider } from "./liquidity/fx-swapper.js";
import { RfqLiquidityProvider } from "./liquidity/rfq.js";
import { CowLiquidityProvider } from "./liquidity/cow.js";
import { DexLiquidityProvider } from "./liquidity/uniswap.js";
import { LifiLiquidityProvider } from "./liquidity/lifi.js";
import { BestExecutionProvider } from "./liquidity/best.js";
import type {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityProviderId,
  LiquidityQuote,
  SafeSwapContext,
  SafeSwapPlan,
} from "./liquidity/contract.js";

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

export async function executeTransferLiquidity(transfer: Transfer): Promise<LiquidityExecution> {
  const storedQuote = store.findQuote(transfer.quoteId);
  const quote = transfer.liquidity
    ? hydrateQuote(transfer.liquidity)
    : await liquidityProvider().quote(
        "EURE_TO_USDC",
        eur.toWei(transfer.sendEur - railFeeEur("cash")),
        transfer.quoteId,
        storedQuote?.expiresAt ?? new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
      );
  // Dispatch by the quote's OWN venue, not the currently-configured one: a
  // persisted quote must execute where it was priced. Routing it through
  // liquidityProvider() meant a deployment whose LIQUIDITY_PROVIDER changed
  // between prepare and execute could settle a dex/rfq/lifi-priced quote
  // through the FxSwapper mock, which never checks quote.provider.
  return providerById(quote.provider).execute(quote);
}

export async function prepareTransferLiquidity(transfer: Transfer): Promise<NonNullable<Transfer["liquidity"]>> {
  if (transfer.liquidity) return transfer.liquidity;
  const storedQuote = store.findQuote(transfer.quoteId);
  const quote = await liquidityProvider().quote(
    "EURE_TO_USDC",
    eur.toWei(transfer.sendEur - railFeeEur("cash")),
    transfer.quoteId,
    storedQuote?.expiresAt ?? new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
  );
  return {
    ...serializeExecution({ quote, amountOut: quote.expectedOut, txs: [] }),
    executedAt: undefined,
    txHash: undefined,
  };
}

/**
 * The Safe-executed swap for one transfer, prepared at CREATION time — its
 * calldata rides inside the UserOperation the user signs, so unlike the
 * orchestrator path there is no execute-time quote: the price serialized here
 * is the price the user's signature covers. Returns null when the configured
 * venue cannot serve a Safe executor (FxSwapper's permissioned inventory,
 * CoW) — the transfer then falls back to the plain user-signed debit.
 */
export async function prepareSafeSwapForTransfer(
  transfer: Transfer,
  ctx: SafeSwapContext,
): Promise<{ plan: SafeSwapPlan; serialized: NonNullable<Transfer["liquidity"]> } | null> {
  const provider = liquidityProvider();
  if (!provider.safeSwapPlan) return null;
  const storedQuote = store.findQuote(transfer.quoteId);
  const plan = await provider.safeSwapPlan(
    "EURE_TO_USDC",
    eur.toWei(transfer.sendEur - railFeeEur("cash")),
    transfer.quoteId,
    storedQuote?.expiresAt ?? new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    ctx,
  );
  return {
    plan,
    serialized: {
      ...serializeExecution({ quote: plan.quote, amountOut: plan.quote.expectedOut, txs: [] }),
      executedAt: undefined,
      txHash: undefined,
    },
  };
}

/**
 * The Safe-executed swap for an inbound crypto deposit: USDC in, EURe back
 * into the same Safe.
 *
 * Same shape as the cash rail: one user-signed batch that approves the venue
 * and executes the swap. The orchestrator never holds the deposit, so the path
 * is non-custodial and needs no API-held owner key.
 *
 * The recipient must be the user's own Safe. There is no payout here; any
 * other recipient would make this a transfer, not a conversion.
 */
export async function prepareDepositConversion(
  safeAddress: `0x${string}`,
  amountUsdcUnits: bigint,
  quoteId: string,
): Promise<{ plan: SafeSwapPlan; serialized: NonNullable<Transfer["liquidity"]> } | null> {
  const provider = liquidityProvider();
  if (!provider.safeSwapPlan) return null;
  const plan = await provider.safeSwapPlan(
    "USDC_TO_EURE",
    amountUsdcUnits,
    quoteId,
    new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    { executor: safeAddress, recipient: safeAddress },
  );
  return {
    plan,
    serialized: {
      ...serializeExecution({ quote: plan.quote, amountOut: plan.quote.expectedOut, txs: [] }),
      executedAt: undefined,
      txHash: undefined,
    },
  };
}

/**
 * The exact-output form of the conversion above: deliver exactly the invoice
 * amount in EURe and leave the unspent USDC in the Safe for the monthly
 * sweep. Refuses, rather than falling back to exact input, when the venue
 * cannot plan one — a payment that lands as a different amount is not the
 * conversion the user asked for.
 */
export async function prepareExactDepositConversion(
  safeAddress: `0x${string}`,
  amountOutEureWei: bigint,
  maxAmountUsdcUnits: bigint,
  quoteId: string,
): Promise<{ plan: SafeSwapPlan }> {
  const provider = liquidityProvider();
  if (!provider.safeExactOutputPlan) {
    throw new Error(
      `the configured liquidity venue (${LIQUIDITY.PROVIDER}) cannot plan an exact-output swap — ` +
        "only dex (Uniswap v3) can deliver exactly the invoice amount; refusing rather than converting a different amount",
    );
  }
  const plan = await provider.safeExactOutputPlan(
    "USDC_TO_EURE",
    amountOutEureWei,
    maxAmountUsdcUnits,
    quoteId,
    new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    { executor: safeAddress, recipient: safeAddress },
  );
  return { plan };
}

export function serializeExecution(e: LiquidityExecution): NonNullable<Transfer["liquidity"]> {
  return {
    provider: e.quote.provider,
    side: e.quote.side,
    quoteId: e.quote.quoteId,
    tokenIn: e.quote.tokenIn,
    tokenOut: e.quote.tokenOut,
    amountIn: e.quote.amountIn.toString(),
    expectedOut: e.quote.expectedOut.toString(),
    minOut: e.quote.minOut.toString(),
    rate: e.quote.rate.toString(),
    expiresAt: e.quote.expiresAt,
    ...(e.quote.rfq ? { rfq: e.quote.rfq } : {}),
    ...(e.quote.cow ? { cow: e.quote.cow } : {}),
    ...(e.quote.dex ? { dex: e.quote.dex } : {}),
    ...(e.quote.lifi ? { lifi: e.quote.lifi } : {}),
    executedAt: new Date().toISOString(),
    txHash: e.txs.at(-1)?.hash,
  };
}

export function liquidityAmountOutUnits(q: LiquidityQuote): number {
  return q.tokenOut === "USDC" ? usd.fromUnits(q.expectedOut) : eur.fromWei(q.expectedOut);
}

function hydrateQuote(q: NonNullable<Transfer["liquidity"]>): LiquidityQuote {
  return {
    provider: q.provider,
    side: q.side,
    quoteId: q.quoteId,
    tokenIn: q.tokenIn,
    tokenOut: q.tokenOut,
    amountIn: BigInt(q.amountIn),
    expectedOut: BigInt(q.expectedOut),
    minOut: BigInt(q.minOut),
    rate: BigInt(q.rate),
    expiresAt: q.expiresAt,
    ...(q.rfq ? { rfq: q.rfq } : {}),
    ...(q.cow ? { cow: q.cow } : {}),
    ...(q.dex ? { dex: q.dex } : {}),
    ...(q.lifi ? { lifi: q.lifi } : {}),
  };
}
