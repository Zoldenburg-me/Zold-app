/**
 * Just-in-time liquidity from a market maker, via Bebop's PMM RFQ API.
 *
 * GET /pmm/{chain}/v3/quote returns an executable quote — `buyTokens[addr]`
 * carries `amount` and `minimumAmount`, and with gasless=false the response
 * carries a ready `tx` we submit with the orchestrator wallet. The price shown
 * is one a maker has committed to.
 *
 * Fails closed: an unreachable maker, an expired quote or a missing token
 * address refuses. Don't add a fallback to our own inventory; it would serve
 * the mock's price labelled as RFQ pricing.
 */
import { LIQUIDITY } from "../config.js";
import { abis, addrs, eur, orchestratorAddress, orchestratorWallet, publicClient, usd, writeAndWait } from "../chain.js";
import { assertPriceSane, erc20Abi, rate6dp } from "../dex.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityQuote,
  LiquiditySide,
  SafeSwapContext,
  SafeSwapPlan,
  MAX_SLIPPAGE_BPS,
  assertVenueTarget,
  balanceAfterWrite,
  } from "./contract.js";

export class RfqLiquidityProvider implements LiquidityProvider {
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
    ctx?: SafeSwapContext,
  ): Promise<LiquidityQuote> {
    const { sell, buy, tokenIn, tokenOut } = this.tokens(side);
    // The maker binds the taker into the quote, so a Safe-executed swap must
    // be quoted AS the Safe — the orchestrator-taker calldata is not reusable.
    const body = await this.request(
      new URLSearchParams({
        sell_tokens: sell,
        buy_tokens: buy,
        sell_amounts: amountIn.toString(),
        taker_address: ctx?.executor ?? orchestratorAddress,
        ...(ctx ? { receiver_address: ctx.recipient } : {}),
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
    const raw = rate6dp(
      side === "EURE_TO_USDC" ? amountIn : expectedOut,
      side === "EURE_TO_USDC" ? expectedOut : amountIn,
    );
    // A maker's price is checked against the independent mid like a pool's:
    // otherwise the rate-binding check would compare the maker to itself.
    await assertPriceSane(Number(raw) / 1e6, "RFQ maker");
    if (body.tx) {
      assertVenueTarget("Bebop", LIQUIDITY.BEBOP_CONTRACTS, body.tx.to, body.approvalTarget ?? body.tx.to, body.tx.value);
    }
    return {
      provider: "rfq",
      side,
      quoteId,
      tokenIn,
      tokenOut,
      amountIn,
      expectedOut,
      minOut,
      // Same 6dp convention as FxSwapper.rate, oriented to USDC-per-EURe on
      // BOTH sides (like dex/lifi): on the reverse side amountIn is 6dp and
      // expectedOut 18dp, and the naive ratio produced a ~1e30 number that
      // made every downstream sanity check refuse.
      rate: raw,
      expiresAt:
        makerExpiry && Date.parse(makerExpiry) < Date.parse(expiresAt) ? makerExpiry : expiresAt,
      rfq: {
        quoteId: String(body.quoteId ?? ""),
        tx: body.tx ?? null,
        // Bebop returns this separately from tx.to. Approve what the maker
        // names; when it names nothing, tx.to — both checked against
        // BEBOP_CONTRACTS above, so neither can be an arbitrary address.
        approvalTarget: body.approvalTarget ?? body.tx?.to,
      },
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
    if (to.toLowerCase() !== orchestratorAddress.toLowerCase()) {
      // Bebop pays the receiver named at quote time, and we quote with the
      // orchestrator as receiver, so any other `to` is a caller mistake.
      // Checked before submitting; after settlement the tokens would already
      // be converted.
      throw new Error(`RFQ quote pays ${orchestratorAddress}, not ${to}`);
    }
    const a = addrs();
    const token = quote.side === "EURE_TO_USDC" ? a.eure : a.usdc;
    const tokenOut = quote.side === "EURE_TO_USDC" ? a.usdc : a.eure;
    const spender = (quote.rfq?.approvalTarget ?? tx.to) as `0x${string}`;
    // Re-checked at execution: the quote may have been stored before the
    // allowlist changed, and this is the moment the calldata is signed.
    assertVenueTarget("Bebop", LIQUIDITY.BEBOP_CONTRACTS, tx.to, spender, tx.value);
    const balanceOf = (owner: `0x${string}`) =>
      publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;
    const before = await balanceOf(to);
    const approveHash = await writeAndWait(orchestratorWallet, {
      address: token,
      abi: abis.MockToken,
      functionName: "approve",
      args: [spender, quote.amountIn],
    });
    const swapHash = await orchestratorWallet.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value ?? 0),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    if (receipt.status !== "success") throw new Error("RFQ settlement reverted");
    // Measured, not copied from the quote: a fill at the maker's minimum is
    // still a fill, and the transfer must settle against what arrived.
    const delivered = (await balanceAfterWrite(tokenOut, to, before)) - before;
    if (delivered < quote.minOut) {
      throw new Error(`RFQ settlement delivered ${delivered} below the quoted floor ${quote.minOut} — refusing to settle`);
    }
    return {
      quote,
      amountOut: delivered,
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

  /**
   * Quote with the Safe as taker and the payout destination as receiver — the
   * maker settles straight to the recipient, so no forwarding leg exists. The
   * maker's expiry is short (about a minute); a batch signed after it reverts
   * atomically, which fails the transfer with nothing moved — the acceptable
   * direction.
   */
  async safeSwapPlan(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    const quote = await this.quote(side, amountIn, quoteId, expiresAt, ctx);
    const tx = quote.rfq?.tx;
    const spender = quote.rfq?.approvalTarget;
    if (!tx?.to || !tx.data || !spender) {
      throw new Error("RFQ maker returned no executable tx/approval target for a Safe-executed swap");
    }
    const { sell } = this.tokens(side);
    return {
      quote,
      approval: { token: sell as `0x${string}`, spender: spender as `0x${string}`, amount: amountIn },
      call: { to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value ?? "0") },
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
      side === "EURE_TO_USDC" ? eur.toWei(LIQUIDITY.PROBE_EUR) : usd.toUnits(LIQUIDITY.PROBE_EUR),
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
