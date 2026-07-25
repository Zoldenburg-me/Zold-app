import { FX } from "./config.js";
import {
  abis,
  addrs,
  eur,
  orchestratorAddress,
  orchestratorWallet,
  publicClient,
  usd,
  writeAndWait,
} from "./chain.js";
import type { Transfer } from "./store.js";
import { store } from "./store.js";

const MAX_SLIPPAGE_BPS = 30n;

export type LiquiditySide = "EURE_TO_USDC" | "USDC_TO_EURE";
export type LiquidityToken = "EURe" | "USDC";
export type LiquidityProviderId = "fx-swapper" | "rfq";

export interface LiquidityQuote {
  provider: LiquidityProviderId;
  side: LiquiditySide;
  quoteId: string;
  tokenIn: LiquidityToken;
  tokenOut: LiquidityToken;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  rate: bigint;
  expiresAt: string;
}

export interface LiquidityExecution {
  quote: LiquidityQuote;
  txs: Transfer["txs"];
  amountOut: bigint;
}

export interface LiquidityProvider {
  quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote>;
  execute(quote: LiquidityQuote, to?: `0x${string}`): Promise<LiquidityExecution>;
}

class FxSwapperLiquidityProvider implements LiquidityProvider {
  async quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote> {
    const a = addrs();
    const functionName = side === "EURE_TO_USDC" ? "quoteOut" : "quoteReverseOut";
    const expectedOut = (await publicClient.readContract({
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName,
      args: [amountIn],
    })) as bigint;
    const rate = (await publicClient.readContract({
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: "rate",
      args: [],
    })) as bigint;
    return {
      provider: "fx-swapper",
      side,
      quoteId,
      tokenIn: side === "EURE_TO_USDC" ? "EURe" : "USDC",
      tokenOut: side === "EURE_TO_USDC" ? "USDC" : "EURe",
      amountIn,
      expectedOut,
      minOut: (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n,
      rate,
      expiresAt,
    };
  }

  async execute(quote: LiquidityQuote, to: `0x${string}` = orchestratorAddress): Promise<LiquidityExecution> {
    if (Date.now() > Date.parse(quote.expiresAt)) {
      throw new Error("liquidity quote expired, request a new transfer");
    }
    const a = addrs();
    const token = quote.side === "EURE_TO_USDC" ? a.eure : a.usdc;
    const swapFunction = quote.side === "EURE_TO_USDC" ? "swapExactIn" : "swapReverseExactIn";
    const approveStep = `${quote.tokenIn.toLowerCase()}.approve(swapper)`;
    const swapStep =
      quote.side === "EURE_TO_USDC"
        ? "liquidity.fx-swapper.eure-usdc"
        : "liquidity.fx-swapper.usdc-eure";

    const approveHash = await writeAndWait(orchestratorWallet, {
      address: token,
      abi: abis.MockToken,
      functionName: "approve",
      args: [a.swapper, quote.amountIn],
    });
    const swapHash = await writeAndWait(orchestratorWallet, {
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: swapFunction,
      args: [quote.amountIn, quote.minOut, to],
    });
    return {
      quote,
      amountOut: quote.expectedOut,
      txs: [
        { step: approveStep, hash: approveHash },
        { step: swapStep, hash: swapHash },
      ],
    };
  }
}

export function liquidityProvider(): LiquidityProvider {
  return new FxSwapperLiquidityProvider();
}

export async function executeTransferLiquidity(transfer: Transfer): Promise<LiquidityExecution> {
  const storedQuote = store.findQuote(transfer.quoteId);
  const quote = transfer.liquidity
    ? hydrateQuote(transfer.liquidity)
    : await liquidityProvider().quote(
        "EURE_TO_USDC",
        eur.toWei(transfer.sendEur - (transfer.rail === "upi" ? FX.UPI_FIXED_FEE_EUR : FX.FIXED_FEE_EUR)),
        transfer.quoteId,
        storedQuote?.expiresAt ?? new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
      );
  return liquidityProvider().execute(quote);
}

export async function prepareTransferLiquidity(transfer: Transfer): Promise<NonNullable<Transfer["liquidity"]>> {
  if (transfer.liquidity) return transfer.liquidity;
  const storedQuote = store.findQuote(transfer.quoteId);
  const quote = await liquidityProvider().quote(
    "EURE_TO_USDC",
    eur.toWei(transfer.sendEur - (transfer.rail === "upi" ? FX.UPI_FIXED_FEE_EUR : FX.FIXED_FEE_EUR)),
    transfer.quoteId,
    storedQuote?.expiresAt ?? new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
  );
  return {
    ...serializeExecution({ quote, amountOut: quote.expectedOut, txs: [] }),
    executedAt: undefined,
    txHash: undefined,
  };
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
  };
}
