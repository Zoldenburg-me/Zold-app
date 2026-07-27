import { FX, LIQUIDITY } from "./config.js";
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
  /** RFQ only: the maker's quote id and the tx it wants submitted. */
  rfq?: { quoteId: string; tx: { to?: string; data?: string; value?: string } | null };
}

export interface LiquidityExecution {
  quote: LiquidityQuote;
  txs: Transfer["txs"];
  amountOut: bigint;
}

export interface LiquidityProvider {
  quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote>;
  execute(quote: LiquidityQuote, to?: `0x${string}`): Promise<LiquidityExecution>;
  /**
   * A cheap, display-only EUR->USD rate for building a receipt, as a float and
   * in the swapper's 6dp integer form.
   *
   * Separate from quote() on purpose. quote() is firm, per-amount and
   * short-lived — with a real market maker it consumes rate limit and may even
   * be a commitment. A user typing into an amount box needs neither. The rate
   * shown must still come from the PROVIDER rather than a constant, or the
   * receipt quietly reverts to advertising a price nobody will honour, which is
   * the bug the live-rates change existed to fix.
   */
  indicativeRate(side: LiquiditySide): Promise<{ rate: number; raw: bigint }>;
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

  /** The mock's own posted rate — the price it will really swap at. */
  async indicativeRate(_side: LiquiditySide) {
    const raw = (await publicClient.readContract({
      address: addrs().swapper,
      abi: abis.FxSwapper,
      functionName: "rate",
      args: [],
    })) as bigint;
    if (raw <= 0n) throw new Error("swapper rate is zero — cannot quote");
    return { rate: Number(raw) / 1e6, raw };
  }
}

/**
 * Just-in-time liquidity from a market maker, via Bebop's PMM RFQ API.
 *
 * GET /pmm/{chain}/v3/quote returns an executable quote — `buyTokens[addr]`
 * carries `amount` and `minimumAmount`, and with gasless=false the response
 * carries a ready `tx` we submit with the orchestrator wallet. So the price we
 * show is one a maker has actually committed to, not one we picked.
 *
 * Fail-closed everywhere: an unreachable maker, an expired quote, or a missing
 * token address refuses rather than silently falling back to our own inventory
 * at our own rate. Quietly serving the mock's price while claiming RFQ pricing
 * would be indistinguishable from working.
 */
class RfqLiquidityProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  private tokens(side: LiquiditySide) {
    const a = addrs();
    return side === "EURE_TO_USDC"
      ? { sell: a.eure, buy: a.usdc, tokenIn: "EURe" as const, tokenOut: "USDC" as const }
      : { sell: a.usdc, buy: a.eure, tokenIn: "USDC" as const, tokenOut: "EURe" as const };
  }

  private async request(params: URLSearchParams) {
    const url =
      `${LIQUIDITY.BEBOP_BASE_URL}/pmm/${LIQUIDITY.BEBOP_CHAIN}/v3/quote?${params}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (LIQUIDITY.BEBOP_API_KEY) headers["source-auth"] = LIQUIDITY.BEBOP_API_KEY;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(LIQUIDITY.BEBOP_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`RFQ quote failed (${res.status}): ${JSON.stringify(body)?.slice(0, 200)}`);
    }
    if (!body || body.status === "Failure" || body.error) {
      throw new Error(`RFQ maker declined: ${JSON.stringify(body?.error ?? body)?.slice(0, 200)}`);
    }
    return body;
  }

  async quote(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
  ): Promise<LiquidityQuote> {
    const { sell, buy, tokenIn, tokenOut } = this.tokens(side);
    const body = await this.request(
      new URLSearchParams({
        sell_tokens: sell,
        buy_tokens: buy,
        sell_amounts: amountIn.toString(),
        taker_address: orchestratorAddress,
        gasless: "false",
      }),
    );
    const leg = body.buyTokens?.[buy] ?? body.buyTokens?.[buy.toLowerCase()];
    if (!leg?.amount) throw new Error(`RFQ quote missing buyTokens entry for ${buy}`);
    const expectedOut = BigInt(leg.amount);
    // Prefer the maker's own minimumAmount; fall back to our slippage bound so
    // a maker that omits it cannot leave the swap unprotected.
    const minOut = leg.minimumAmount
      ? BigInt(leg.minimumAmount)
      : (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
    // The maker's expiry wins when it is sooner than ours — executing past it
    // is a guaranteed revert.
    const makerExpiry = body.expiry ? new Date(Number(body.expiry) * 1000).toISOString() : null;
    return {
      provider: "rfq",
      side,
      quoteId,
      tokenIn,
      tokenOut,
      amountIn,
      expectedOut,
      minOut,
      // Same 6dp convention as FxSwapper.rate: tokenOut units per 1e18 tokenIn.
      rate: amountIn > 0n ? (expectedOut * 10n ** 18n) / amountIn : 0n,
      expiresAt:
        makerExpiry && Date.parse(makerExpiry) < Date.parse(expiresAt) ? makerExpiry : expiresAt,
      rfq: { quoteId: String(body.quoteId ?? ""), tx: body.tx ?? null },
    };
  }

  async execute(
    quote: LiquidityQuote,
    to: `0x${string}` = orchestratorAddress,
  ): Promise<LiquidityExecution> {
    if (Date.now() > Date.parse(quote.expiresAt)) {
      throw new Error("liquidity quote expired, request a new transfer");
    }
    const tx = quote.rfq?.tx;
    if (!tx?.to || !tx?.data) {
      // A stored quote that lost its tx cannot be replayed — re-quoting here
      // would execute at a price the user never saw.
      throw new Error("RFQ quote carries no executable tx — request a new quote");
    }
    const a = addrs();
    const token = quote.side === "EURE_TO_USDC" ? a.eure : a.usdc;
    // The settlement contract pulls the sell token from the orchestrator.
    const approveHash = await writeAndWait(orchestratorWallet, {
      address: token,
      abi: abis.MockToken,
      functionName: "approve",
      args: [tx.to as `0x${string}`, quote.amountIn],
    });
    const swapHash = await orchestratorWallet.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value ?? 0),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    if (receipt.status !== "success") throw new Error("RFQ settlement reverted");
    if (to.toLowerCase() !== orchestratorAddress.toLowerCase()) {
      // Bebop pays the receiver named at quote time; we quote with the
      // orchestrator as receiver, so anything else is a caller mistake rather
      // than something to paper over by forwarding tokens silently.
      throw new Error(`RFQ quote pays ${orchestratorAddress}, not ${to}`);
    }
    return {
      quote,
      amountOut: quote.expectedOut,
      txs: [
        { step: `${quote.tokenIn.toLowerCase()}.approve(rfq-settlement)`, hash: approveHash },
        {
          step:
            quote.side === "EURE_TO_USDC" ? "liquidity.rfq.eure-usdc" : "liquidity.rfq.usdc-eure",
          hash: swapHash,
        },
      ],
    };
  }

  async indicativeRate(side: LiquiditySide) {
    const now = Date.now();
    if (this.indicative && now - this.indicative.at < LIQUIDITY.INDICATIVE_TTL_MS) {
      return { rate: this.indicative.rate, raw: this.indicative.raw };
    }
    // A nominal-size probe: a maker's price is size-dependent, so a receipt
    // built from a 1-wei quote would not resemble a real trade.
    const probe = await this.quote(
      side,
      eur.toWei(LIQUIDITY.PROBE_EUR),
      "indicative",
      new Date(now + LIQUIDITY.INDICATIVE_TTL_MS).toISOString(),
    );
    // rate is tokenOut(6dp) per 1e18 tokenIn — same convention as the swapper.
    const raw = probe.rate;
    const rate = Number(raw) / 1e6;
    this.indicative = { at: now, rate, raw };
    return { rate, raw };
  }
}

/**
 * Which liquidity source this deployment uses.
 *
 * Deliberately explicit: an RFQ provider that silently degrades to our own
 * inventory would price real transfers off a number we chose while reporting
 * that a market maker set it.
 */
export function liquidityProvider(): LiquidityProvider {
  return LIQUIDITY.PROVIDER === "rfq"
    ? new RfqLiquidityProvider()
    : new FxSwapperLiquidityProvider();
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
    ...(e.quote.rfq ? { rfq: e.quote.rfq } : {}),
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
  };
}
