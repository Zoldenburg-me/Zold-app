/**
 * Uniswap v3, executed on-chain.
 *
 * Bebop will not list EURe and has no testnet; CoW quotes but will not
 * execute. A pool is just a contract, so this venue can be tested on Base
 * Sepolia before real money.
 *
 * Unlike an RFQ maker's quote, a pool price is not a promise: it is wherever
 * the last trade left it, and anyone can move a thin pool. Every quote is
 * checked against the independent live mid, and the checked pool is pinned
 * onto the quote so execution cannot drift to another.
 */
import { encodeFunctionData } from "viem";
import { LIQUIDITY } from "../config.js";
import { addrs, eur, orchestratorAddress, orchestratorWallet, publicClient, usd, writeAndWait } from "../chain.js";
import { assertPriceSane, bestPool, erc20Abi, quoteExactInputSingle, quoteExactOutputSingle, rate6dp, routerAbi } from "../dex.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityQuote,
  LiquiditySide,
  SafeSwapContext,
  SafeSwapPlan,
  applySurplus,
  balanceAfterWrite,
  } from "./contract.js";

export class DexLiquidityProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  private tokens(side: LiquiditySide) {
    const a = addrs();
    return side === "EURE_TO_USDC"
      ? { tokenIn: a.eure, tokenOut: a.usdc, inName: "EURe" as const, outName: "USDC" as const }
      : { tokenIn: a.usdc, tokenOut: a.eure, inName: "USDC" as const, outName: "EURe" as const };
  }

  async quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote> {
    if (amountIn <= 0n) throw new Error("dex quote requires a positive amount");
    const { tokenIn, tokenOut, inName, outName } = this.tokens(side);

    const pool = await bestPool(tokenIn, tokenOut);
    if (!pool) {
      throw new Error(
        `no EURe/USDC pool with liquidity at fee tiers [${LIQUIDITY.DEX_FEE_TIERS.join(", ")}] on this chain. ` +
          `Refusing rather than settling elsewhere. On a testnet run \`npm run dex:setup\` to seed one.`,
      );
    }

    const expectedOut = await quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee: pool.fee });

    // Orient both sides to USDC-per-EURe before checking, so the guard compares
    // like with like whichever way the trade runs.
    const eureWei = side === "EURE_TO_USDC" ? amountIn : expectedOut;
    const usdcUnits = side === "EURE_TO_USDC" ? expectedOut : amountIn;
    const raw = rate6dp(eureWei, usdcUnits);
    const { mid, deviationBps } = await assertPriceSane(Number(raw) / 1e6);

    return {
      provider: "dex",
      side,
      quoteId,
      tokenIn: inName,
      tokenOut: outName,
      amountIn,
      expectedOut,
      minOut: (expectedOut * (10_000n - LIQUIDITY.DEX_SLIPPAGE_BPS)) / 10_000n,
      rate: raw,
      expiresAt,
      dex: { pool: pool.address, fee: pool.fee, mid, deviationBps },
    };
  }

  async execute(quote: LiquidityQuote, to: `0x${string}` = orchestratorAddress): Promise<LiquidityExecution> {
    if (Date.now() > Date.parse(quote.expiresAt)) {
      throw new Error("liquidity quote expired, request a new transfer");
    }
    if (!quote.dex) throw new Error("dex execution requires a dex quote — refusing to re-quote at execution time");
    const { tokenIn, tokenOut } = this.tokens(quote.side);

    // Measured, not assumed. amountOutMinimum makes the router revert on a bad
    // fill, but the amount actually received is what the rest of the transfer
    // is settled against, so it is read from the chain rather than copied from
    // the quote we hoped for.
    const balanceOf = (owner: `0x${string}`) =>
      publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;
    const before = await balanceOf(to);

    const approveHash = await writeAndWait(orchestratorWallet, {
      address: tokenIn,
      abi: [...erc20Abi],
      functionName: "approve",
      args: [LIQUIDITY.DEX_ROUTER, quote.amountIn],
    });
    const swapHash = await writeAndWait(orchestratorWallet, {
      address: LIQUIDITY.DEX_ROUTER,
      abi: [...routerAbi],
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.dex.fee,
          recipient: to,
          amountIn: quote.amountIn,
          // The binding: the floor the user was quoted, enforced by the router.
          amountOutMinimum: quote.minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    // Read past replica lag: a stale pre-swap balance here would report a
    // landed swap as unswapped, and compensation would refund EURe this side
    // no longer holds.
    const delivered = (await balanceAfterWrite(tokenOut, to, before)) - before;
    if (delivered < quote.minOut) {
      throw new Error(
        `dex swap delivered ${delivered} below the quoted floor ${quote.minOut} — refusing to settle`,
      );
    }
    const { amountOut, surplus } = applySurplus(quote, delivered);
    return {
      quote,
      amountOut,
      ...(surplus ? { surplus } : {}),
      txs: [
        { step: `${quote.tokenIn.toLowerCase()}.approve(dex-router)`, hash: approveHash },
        { step: `liquidity.dex.${quote.tokenIn.toLowerCase()}-${quote.tokenOut.toLowerCase()}`, hash: swapHash },
      ],
    };
  }

  /**
   * The same quote, packaged for the user's Safe to execute. Uniswap's router
   * is permissionless and takes an explicit recipient, so this needs no
   * re-quote: the pool, floor and amounts are exactly what quote() produced —
   * the user signs the price the pipeline saw, and the router enforces the
   * floor and delivers straight to `ctx.recipient`.
   */
  async safeSwapPlan(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    const quote = await this.quote(side, amountIn, quoteId, expiresAt);
    const { tokenIn, tokenOut } = this.tokens(side);
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.dex!.fee,
          recipient: ctx.recipient,
          amountIn: quote.amountIn,
          amountOutMinimum: quote.minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return {
      quote,
      approval: { token: tokenIn, spender: LIQUIDITY.DEX_ROUTER, amount: quote.amountIn },
      call: { to: LIQUIDITY.DEX_ROUTER, data, value: 0n },
    };
  }

  /**
   * Exact output: the router delivers exactly `amountOut` and pulls what that
   * costs, capped at `maxAmountIn`; the rest of the approval goes unused and
   * the tokens stay in the Safe. Quoted against the same pool and the same
   * live-mid check as an exact-input trade, and the quoted input is what the
   * user signs as the ceiling — `maxAmountIn` bounds it, never replaces it.
   */
  async safeExactOutputPlan(
    side: LiquiditySide,
    amountOut: bigint,
    maxAmountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    if (amountOut <= 0n) throw new Error("dex exact-output quote requires a positive amount");
    const { tokenIn, tokenOut, inName, outName } = this.tokens(side);
    const pool = await bestPool(tokenIn, tokenOut);
    if (!pool) throw new Error("no EURe/USDC pool with liquidity on this chain — refusing rather than settling elsewhere");
    const quotedIn = await quoteExactOutputSingle({ tokenIn, tokenOut, amountOut, fee: pool.fee });
    const amountInMaximum = (quotedIn * (10_000n + LIQUIDITY.DEX_SLIPPAGE_BPS)) / 10_000n;
    if (amountInMaximum > maxAmountIn) {
      throw new Error(
        `delivering exactly ${amountOut} ${outName} costs up to ${amountInMaximum} ${inName} at this pool, ` +
          `more than the ${maxAmountIn} available — refusing; the payment is short of the invoice`,
      );
    }
    const eureWei = side === "EURE_TO_USDC" ? quotedIn : amountOut;
    const usdcUnits = side === "EURE_TO_USDC" ? amountOut : quotedIn;
    const raw = rate6dp(eureWei, usdcUnits);
    const { mid, deviationBps } = await assertPriceSane(Number(raw) / 1e6);
    const quote: LiquidityQuote = {
      provider: "dex",
      side,
      quoteId,
      tokenIn: inName,
      tokenOut: outName,
      amountIn: amountInMaximum,
      expectedOut: amountOut,
      minOut: amountOut,
      rate: raw,
      expiresAt,
      dex: { pool: pool.address, fee: pool.fee, mid, deviationBps },
      exactOutput: { quotedIn, amountInMaximum },
    };
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: pool.fee,
          recipient: ctx.recipient,
          amountOut,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return {
      quote,
      approval: { token: tokenIn, spender: LIQUIDITY.DEX_ROUTER, amount: amountInMaximum },
      call: { to: LIQUIDITY.DEX_ROUTER, data, value: 0n },
    };
  }

  /** Cached probe, so typing in the amount box is not a quote storm. */
  async indicativeRate(side: LiquiditySide) {
    const now = Date.now();
    if (this.indicative && now - this.indicative.at < LIQUIDITY.INDICATIVE_TTL_MS) {
      return { rate: this.indicative.rate, raw: this.indicative.raw };
    }
    const probe = eur.toWei(LIQUIDITY.PROBE_EUR);
    const q = await this.quote(side, side === "EURE_TO_USDC" ? probe : usd.toUnits(LIQUIDITY.PROBE_EUR), `indicative-${now}`, new Date(now + 60_000).toISOString());
    const out = { rate: Number(q.rate) / 1e6, raw: q.rate };
    this.indicative = { at: now, ...out };
    return out;
  }
}
