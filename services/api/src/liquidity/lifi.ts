/**
 * LI.FI — aggregated liquidity, and the venue intended for production.
 *
 * WHY THIS OVER A HAND-ROLLED POOL ADAPTER. A DexLiquidityProvider can only
 * ever see the pools it was taught about; an aggregator sees the market. Tested
 * live rather than assumed: 100 EURe -> USDC returned executable quotes on
 * Gnosis (1.1493), Base (1.1506) and Polygon (1.1491) against a live mid of
 * ~1.1511 — 4 to 17bps — routed through Nordstern Finance, Fly and Bitget.
 * None of those would have been in a hardcoded venue list.
 *
 * WHY `dex` STAYS. LI.FI lists Base Sepolia but returns "No available quotes"
 * there even for WETH/USDC, which has real Uniswap depth — so this adapter can
 * only ever be exercised with real money on a mainnet, the same gap that left
 * the Bebop adapter correct and unrun. The Uniswap path remains the one that
 * can be proven locally. Neither replaces the other.
 *
 * Fail-closed throughout, and one guard that matters more here than anywhere
 * else: we are trusting a third party's routing, so the price it returns is
 * still checked against the independent live mid before we bind to it.
 */
import { LIQUIDITY } from "../config.js";
import { addrs, eur, orchestratorAddress, orchestratorWallet, publicClient, usd, writeAndWait } from "../chain.js";
import { assertPriceSane, erc20Abi, rate6dp } from "../dex.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityQuote,
  LiquiditySide,
  SafeSwapContext,
  SafeSwapPlan,
  applySurplus,
  assertVenueTarget,
  balanceAfterWrite,
  } from "./contract.js";

export class LifiLiquidityProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  private async fetchQuote(side: LiquiditySide, amountIn: bigint, ctx?: SafeSwapContext) {
    const a = addrs();
    const fromToken = side === "EURE_TO_USDC" ? a.eure : a.usdc;
    const toToken = side === "EURE_TO_USDC" ? a.usdc : a.eure;
    const url = new URL("/v1/quote", LIQUIDITY.LIFI_BASE_URL);
    url.searchParams.set("fromChain", String(LIQUIDITY.LIFI_CHAIN_ID));
    url.searchParams.set("toChain", String(LIQUIDITY.LIFI_CHAIN_ID));
    url.searchParams.set("fromToken", fromToken);
    url.searchParams.set("toToken", toToken);
    url.searchParams.set("fromAmount", amountIn.toString());
    // LI.FI builds calldata FOR the fromAddress — a Safe-executed swap must be
    // quoted as the Safe, with the payout destination as toAddress, or the
    // route it returns is executable only by the orchestrator.
    url.searchParams.set("fromAddress", ctx?.executor ?? orchestratorAddress);
    if (ctx) url.searchParams.set("toAddress", ctx.recipient);
    url.searchParams.set("slippage", String(LIQUIDITY.LIFI_SLIPPAGE));

    const headers: Record<string, string> = { accept: "application/json" };
    if (LIQUIDITY.LIFI_API_KEY) headers["x-lifi-api-key"] = LIQUIDITY.LIFI_API_KEY;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(LIQUIDITY.LIFI_TIMEOUT_MS) });
    } catch (e: any) {
      throw new Error(`LI.FI unreachable (${e?.message ?? e}) — refusing to quote rather than pricing off our own book`);
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`LI.FI refused to quote (${res.status}): ${String(body?.message ?? res.statusText).slice(0, 160)}`);
    }
    const estimate = body?.estimate;
    const tx = body?.transactionRequest;
    if (!estimate?.toAmount || !estimate?.toAmountMin) throw new Error("LI.FI quote has no amounts — refusing");
    if (!tx?.to || !tx?.data) throw new Error("LI.FI quote carries no executable transaction — refusing");
    if (!estimate?.approvalAddress) throw new Error("LI.FI quote names no approval target — refusing");
    assertVenueTarget("LI.FI", LIQUIDITY.LIFI_CONTRACTS, tx.to, estimate.approvalAddress, tx.value);

    // The token it actually priced, not the one we hoped for. LI.FI resolves
    // symbols, and settling into a token we do not hold would be silent.
    const got = String(body?.action?.toToken?.address ?? "").toLowerCase();
    if (got !== toToken.toLowerCase()) {
      throw new Error(`LI.FI priced ${got} but we asked for ${toToken.toLowerCase()} — refusing a quote in the wrong token`);
    }
    return { estimate, tx, tool: String(body?.toolDetails?.name ?? body?.tool ?? "lifi"), toToken };
  }

  async quote(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx?: SafeSwapContext,
  ): Promise<LiquidityQuote> {
    if (amountIn <= 0n) throw new Error("lifi quote requires a positive amount");
    const { estimate, tx, tool, toToken } = await this.fetchQuote(side, amountIn, ctx);
    const expectedOut = BigInt(estimate.toAmount);
    const minOut = BigInt(estimate.toAmountMin);

    const eureWei = side === "EURE_TO_USDC" ? amountIn : expectedOut;
    const usdcUnits = side === "EURE_TO_USDC" ? expectedOut : amountIn;
    const raw = rate6dp(eureWei, usdcUnits);
    const { mid, deviationBps } = await assertPriceSane(Number(raw) / 1e6, "LI.FI route");

    return {
      provider: "lifi",
      side,
      quoteId,
      tokenIn: side === "EURE_TO_USDC" ? "EURe" : "USDC",
      tokenOut: side === "EURE_TO_USDC" ? "USDC" : "EURe",
      amountIn,
      expectedOut,
      minOut,
      rate: raw,
      // LI.FI returns no expiry of its own (executionDuration is 0), so the
      // only staleness bound is the one we impose.
      expiresAt,
      lifi: {
        tool,
        approvalAddress: estimate.approvalAddress,
        tx: { to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit },
        toToken,
        mid,
        deviationBps,
      },
    };
  }

  async execute(quote: LiquidityQuote, to: `0x${string}` = orchestratorAddress): Promise<LiquidityExecution> {
    if (Date.now() > Date.parse(quote.expiresAt)) {
      throw new Error("liquidity quote expired, request a new transfer");
    }
    if (!quote.lifi) throw new Error("lifi execution requires a lifi quote — refusing to re-quote at execution time");
    if (to.toLowerCase() !== orchestratorAddress.toLowerCase()) {
      // The route was quoted with the orchestrator as sender and no toAddress,
      // so LI.FI delivers to the orchestrator whatever `to` says. Refuse before
      // submitting rather than converting the tokens and then reporting a
      // failed delivery.
      throw new Error(`lifi quote delivers to ${orchestratorAddress}, not ${to} — request a quote for that recipient`);
    }
    assertVenueTarget("LI.FI", LIQUIDITY.LIFI_CONTRACTS, quote.lifi.tx.to, quote.lifi.approvalAddress, quote.lifi.tx.value);
    const a = addrs();
    const tokenIn = quote.side === "EURE_TO_USDC" ? a.eure : a.usdc;

    const balanceOf = (owner: `0x${string}`) =>
      publicClient.readContract({ address: quote.lifi!.toToken, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;
    const before = await balanceOf(to);

    // Approve what the maker NAMES, not tx.to. They are the same contract today
    // — which is exactly why approving tx.to would work by luck and break
    // silently the day routing moves to a separate settlement contract or
    // Permit2. Same trap as on the Bebop adapter.
    const approveHash = await writeAndWait(orchestratorWallet, {
      address: tokenIn,
      abi: [...erc20Abi],
      functionName: "approve",
      args: [quote.lifi.approvalAddress, quote.amountIn],
    });

    const swapHash = await orchestratorWallet.sendTransaction({
      to: quote.lifi.tx.to,
      data: quote.lifi.tx.data,
      ...(quote.lifi.tx.value ? { value: BigInt(quote.lifi.tx.value) } : {}),
    } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    if (receipt.status !== "success") throw new Error("lifi route reverted");

    // Measured, past replica lag. LI.FI's slippage bound is enforced inside
    // its own contract, but what the rest of the transfer settles against is
    // what actually arrived.
    const delivered = (await balanceAfterWrite(quote.lifi.toToken, to, before)) - before;
    if (delivered < quote.minOut) {
      throw new Error(`lifi swap delivered ${delivered} below the quoted floor ${quote.minOut} — refusing to settle`);
    }
    const { amountOut, surplus } = applySurplus(quote, delivered);
    return {
      quote,
      amountOut,
      ...(surplus ? { surplus } : {}),
      txs: [
        { step: `${quote.tokenIn.toLowerCase()}.approve(lifi)`, hash: approveHash },
        { step: `liquidity.lifi.${quote.tokenIn.toLowerCase()}-${quote.tokenOut.toLowerCase()}`, hash: swapHash },
      ],
    };
  }

  /**
   * A route quoted FOR the Safe: LI.FI builds calldata for the fromAddress it
   * was asked about, so the executor and recipient are baked in at quote time
   * and the user signs exactly the route being executed. The approval spender
   * is LI.FI's own approvalAddress, never assumed equal to tx.to.
   */
  async safeSwapPlan(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    const quote = await this.quote(side, amountIn, quoteId, expiresAt, ctx);
    if (!quote.lifi) throw new Error("LI.FI quote carries no executable route for a Safe-executed swap");
    const a = addrs();
    const tokenIn = side === "EURE_TO_USDC" ? a.eure : a.usdc;
    return {
      quote,
      approval: { token: tokenIn, spender: quote.lifi.approvalAddress, amount: amountIn },
      call: {
        to: quote.lifi.tx.to,
        data: quote.lifi.tx.data,
        value: quote.lifi.tx.value ? BigInt(quote.lifi.tx.value) : 0n,
      },
    };
  }

  async indicativeRate(side: LiquiditySide) {
    const now = Date.now();
    if (this.indicative && now - this.indicative.at < LIQUIDITY.INDICATIVE_TTL_MS) {
      return { rate: this.indicative.rate, raw: this.indicative.raw };
    }
    const probe = side === "EURE_TO_USDC" ? eur.toWei(LIQUIDITY.PROBE_EUR) : usd.toUnits(LIQUIDITY.PROBE_EUR);
    const q = await this.quote(side, probe, `indicative-${now}`, new Date(now + 60_000).toISOString());
    const out = { rate: Number(q.rate) / 1e6, raw: q.rate };
    this.indicative = { at: now, ...out };
    return out;
  }
}
