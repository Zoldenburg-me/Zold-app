/**
 * CoW Protocol — intent-based liquidity, no inventory on either side.
 *
 * Alongside the RFQ provider because Bebop lists EURe only on Ethereum
 * (Monerium market-makes there; Base, Polygon and Gnosis answer
 * "TokenNotSupported") and has no testnet. CoW quotes EURe near the mid rate
 * on Gnosis, where Monerium is native and EURe liquidity is deepest.
 *
 * Unlike RFQ there is no transaction to submit: you sign an order and solvers
 * compete to fill it. So `execute` places the order and returns; settlement is
 * asynchronous with no guaranteed deadline. The signature is EIP-1271, so the
 * user's Safe or the orchestrator can sign without an EOA.
 *
 * Not wired for execution yet. quote() is live; execute() refuses, because
 * placing an order needs an EIP-712 signature over CoW's order struct and a
 * decision about who signs (the Safe with the user present, or the
 * orchestrator). Quoting alone prices the corridor.
 */
import { LIQUIDITY } from "../config.js";
import { addrs, eur, orchestratorAddress, usd } from "../chain.js";
import { assertPriceSane, rate6dp } from "../dex.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityQuote,
  LiquiditySide,
  MAX_SLIPPAGE_BPS,
  } from "./contract.js";

export class CowLiquidityProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  private tokens(side: LiquiditySide) {
    const a = addrs();
    return side === "EURE_TO_USDC"
      ? { sell: a.eure, buy: a.usdc, tokenIn: "EURe" as const, tokenOut: "USDC" as const }
      : { sell: a.usdc, buy: a.eure, tokenIn: "USDC" as const, tokenOut: "EURe" as const };
  }

  async quote(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
  ): Promise<LiquidityQuote> {
    const { sell, buy, tokenIn, tokenOut } = this.tokens(side);
    const url = `${LIQUIDITY.COW_BASE_URL}/${LIQUIDITY.COW_NETWORK}/api/v1/quote`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(LIQUIDITY.COW_TIMEOUT_MS),
      body: JSON.stringify({
        sellToken: sell,
        buyToken: buy,
        from: orchestratorAddress,
        receiver: orchestratorAddress,
        sellAmountBeforeFee: amountIn.toString(),
        kind: "sell",
        partiallyFillable: false,
        signingScheme: "eip1271",
        onchainOrder: false,
        priceQuality: "optimal",
      }),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body?.quote) {
      throw new Error(
        `CoW quote failed (${res.status}): ${JSON.stringify(body?.description ?? body ?? {}).slice(0, 200)}`,
      );
    }
    const q = body.quote;
    const expectedOut = BigInt(q.buyAmount);
    // CoW commits to buyAmount for a filled order; the slippage bound is ours.
    const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
    // validTo is when the order stops being fillable — sooner than our window
    // means ours is a promise the solver will not keep.
    const validTo = q.validTo ? new Date(Number(q.validTo) * 1000).toISOString() : null;
    const raw = rate6dp(
      side === "EURE_TO_USDC" ? amountIn : expectedOut,
      side === "EURE_TO_USDC" ? expectedOut : amountIn,
    );
    await assertPriceSane(Number(raw) / 1e6, "CoW quote");
    return {
      provider: "cow",
      side,
      quoteId,
      tokenIn,
      tokenOut,
      amountIn,
      expectedOut,
      minOut,
      // Same 6dp convention as the swapper, oriented USDC-per-EURe both sides.
      rate: raw,
      expiresAt: validTo && Date.parse(validTo) < Date.parse(expiresAt) ? validTo : expiresAt,
      cow: {
        orderId: String(body.id ?? ""),
        feeAmount: String(q.feeAmount ?? "0"),
        validTo: Number(q.validTo ?? 0),
        appData: String(q.appData ?? ""),
      },
    };
  }

  async execute(): Promise<LiquidityExecution> {
    throw new Error(
      "CoW execution is not wired yet: placing an order needs an EIP-712 signature " +
        "over CoW's order struct, and a decision about who signs it (the user's Safe " +
        "with the user present, or the orchestrator). Quoting works; settle on a " +
        "venue that executes (dex, lifi, or best over both).",
    );
  }

  async indicativeRate(side: LiquiditySide) {
    const now = Date.now();
    if (this.indicative && now - this.indicative.at < LIQUIDITY.INDICATIVE_TTL_MS) {
      return { rate: this.indicative.rate, raw: this.indicative.raw };
    }
    const probe = await this.quote(
      side,
      side === "EURE_TO_USDC" ? eur.toWei(LIQUIDITY.PROBE_EUR) : usd.toUnits(LIQUIDITY.PROBE_EUR),
      "indicative",
      new Date(now + LIQUIDITY.INDICATIVE_TTL_MS).toISOString(),
    );
    const raw = probe.rate;
    const rate = Number(raw) / 1e6;
    this.indicative = { at: now, rate, raw };
    return { rate, raw };
  }
}
