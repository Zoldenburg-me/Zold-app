/**
 * Our own inventory, at a rate the owner sets.
 *
 * THE ONLY VENUE A SAFE CANNOT EXECUTE: the swapper's inventory is onlyTrader,
 * so there is no safeSwapPlan here and a deployment pinned to it takes custody
 * of the principal. Kept because local hardhat has neither LI.FI nor a seeded
 * pool — `scripts/_local-chain.ts` opts into it explicitly, and production
 * inherits the safe default instead.
 */
import { abis, addrs, orchestratorAddress, orchestratorWallet, publicClient, swapperAddress, writeAndWait } from "../chain.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityQuote,
  LiquiditySide,
  MAX_SLIPPAGE_BPS,
  waitForAllowanceVisibility,
} from "./contract.js";

export class FxSwapperLiquidityProvider implements LiquidityProvider {
  async quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote> {
    const a = addrs();
    const functionName = side === "EURE_TO_USDC" ? "quoteOut" : "quoteReverseOut";
    const expectedOut = (await publicClient.readContract({
      address: swapperAddress(),
      abi: abis.FxSwapper,
      functionName,
      args: [amountIn],
    })) as bigint;
    const rate = (await publicClient.readContract({
      address: swapperAddress(),
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
      args: [swapperAddress(), quote.amountIn],
    });
    await waitForAllowanceVisibility(token, orchestratorAddress, swapperAddress(), quote.amountIn);
    const swapHash = await writeAndWait(orchestratorWallet, {
      address: swapperAddress(),
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

  /** The mock's own posted rate — the price it will really swap at. */
  async indicativeRate(_side: LiquiditySide) {
    const raw = (await publicClient.readContract({
      address: swapperAddress(),
      abi: abis.FxSwapper,
      functionName: "rate",
      args: [],
    })) as bigint;
    if (raw <= 0n) throw new Error("swapper rate is zero — cannot quote");
    return { rate: Number(raw) / 1e6, raw };
  }
}
