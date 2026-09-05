import { encodeFunctionData } from "viem";
import { FX, LIQUIDITY } from "./config.js";
import {
  abis,
  addrs,
  eur,
  orchestratorAddress,
  orchestratorWallet,
  publicClient,
  swapperAddress,
  usd,
  writeAndWait,
} from "./chain.js";
import { assertPriceSane, bestPool, erc20Abi, quoteExactInputSingle, rate6dp, routerAbi } from "./dex.js";
import type { Transfer } from "./store.js";
import { store } from "./store.js";

const MAX_SLIPPAGE_BPS = 30n;

export type LiquiditySide = "EURE_TO_USDC" | "USDC_TO_EURE";
export type LiquidityToken = "EURe" | "USDC";
export type LiquidityProviderId = "fx-swapper" | "rfq" | "cow" | "dex" | "lifi" | "best";

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
  /** RFQ only: the maker's quote id, the tx it wants submitted, and the
   *  address that must be approved to pull the sell token. */
  rfq?: {
    quoteId: string;
    tx: { to?: string; data?: string; value?: string } | null;
    approvalTarget?: string;
  };
  /** CoW only: the order the solvers will fill. */
  cow?: { orderId: string; feeAmount: string; validTo: number; appData: string };
  /** DEX only: the exact pool the quote was taken from, plus the independent
   *  mid it was checked against. execute() must reuse this pool — re-picking
   *  at execution could route through a different, unchecked one. */
  dex?: { pool: `0x${string}`; fee: number; mid: number; deviationBps: number };
  /** Best-execution only: what each venue offered, so the choice is auditable
   *  after the fact rather than a number that appeared from nowhere. */
  routing?: { venue: string; expectedOut: string | null; error?: string }[];
  /** LI.FI only: the route it priced and the tx it wants submitted. Held on
   *  the quote because prepare and execute are separate steps — re-quoting at
   *  execution would settle at a price the user never saw. */
  lifi?: {
    tool: string;
    approvalAddress: `0x${string}`;
    tx: { to: `0x${string}`; data: `0x${string}`; value?: string; gasLimit?: string };
    toToken: `0x${string}`;
    mid: number;
    deviationBps: number;
  };
}

export interface LiquidityExecution {
  quote: LiquidityQuote;
  txs: Transfer["txs"];
  amountOut: bigint;
  /**
   * Positive slippage: what arrived beyond what was quoted. Always MEASURED,
   * never assumed, and recorded whoever keeps it — a surplus nobody can see is
   * indistinguishable from a margin nobody disclosed.
   */
  surplus?: { amount: string; keptBy: "user" | "treasury" };
}

/**
 * A swap the USER'S SAFE executes, not the orchestrator: who runs the calldata
 * and where the output token is delivered. Venues that bind the taker into
 * their quote (RFQ makers, LI.FI routes) must be quoted WITH this context —
 * re-targeting their calldata after the fact silently produces a transaction
 * the venue will refuse or misdeliver.
 */
export interface SafeSwapContext {
  executor: `0x${string}`;
  recipient: `0x${string}`;
}

/**
 * Everything a user-signed batch needs from the venue: the price being signed,
 * the approval the venue names (spender is the venue's own answer, never
 * assumed equal to call.to — the Bebop/LI.FI approvalTarget trap), and the
 * executable call. The caller composes [approve, call] into the UserOperation.
 */
export interface SafeSwapPlan {
  quote: LiquidityQuote;
  approval: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  call: { to: `0x${string}`; data: `0x${string}`; value: bigint };
}

export interface LiquidityProvider {
  quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote>;
  execute(quote: LiquidityQuote, to?: `0x${string}`): Promise<LiquidityExecution>;
  /**
   * Build a swap the user's Safe can execute itself — the venue-specific half
   * of Change 2 windows 1-3. OPTIONAL because not every venue can serve an
   * arbitrary executor: FxSwapper is onlyTrader (our own permissioned
   * inventory — when we are the counterparty the custody question is a
   * counterparty question, not a window to close), and CoW does not execute
   * here at all. A venue without this method makes the transfer fall back to
   * the plain user-signed debit with the orchestrator swapping after.
   */
  safeSwapPlan?(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan>;
  /**
   * A cheap, display-only EUR->USD rate for building a receipt, as a float and
   * in the swapper's 6dp integer form.
   *
   * Separate from quote() on purpose. quote() is firm, per-amount and
   * short-lived — with a real market maker it consumes rate limit and may even
   * be a commitment. A user typing into an amount box needs neither. The rate
   * shown must still come from the PROVIDER rather than a constant, or the
   * receipt quietly advertises a price nobody will honour.
   */
  indicativeRate(side: LiquiditySide): Promise<{ rate: number; raw: bigint }>;
}

/**
 * Read a balance until it reflects a write we know happened (bounded).
 *
 * Same replica-lag disease as waitForAllowanceVisibility, on the read side:
 * the compensation reverse swap DELIVERED (Safe went 40 -> 44.01 EURe on
 * chain) and its own verification then read a stale replica, saw no delta,
 * and declared the delivery missing. Returns the last read either way — the
 * caller still decides what a zero delta means.
 */
export async function balanceAfterWrite(
  token: `0x${string}`,
  who: `0x${string}`,
  before: bigint,
): Promise<bigint> {
  let last = before;
  for (let i = 0; i < 12; i++) {
    last = (await publicClient.readContract({
      address: token,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [who],
    })) as bigint;
    if (last > before) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/**
 * Wait until a fresh read actually shows the allowance the approve just set.
 *
 * The public RPC is load-balanced: the swap SIMULATION can land on a replica
 * that has not seen the approve block yet, and the swap then reverts
 * ERC20InsufficientAllowance against an allowance that is genuinely on
 * chain — a real €5 transfer failed and auto-refunded over exactly this.
 * Bounded: a lagging replica converges within a block or two; a truly
 * missing approve stays missing and the swap's own revert reports it.
 */
export async function waitForAllowanceVisibility(
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const current = (await publicClient.readContract({
      address: token,
      abi: abis.MockToken,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
    if (current >= amount) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

class FxSwapperLiquidityProvider implements LiquidityProvider {
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
      rate: rate6dp(
        side === "EURE_TO_USDC" ? amountIn : expectedOut,
        side === "EURE_TO_USDC" ? expectedOut : amountIn,
      ),
      expiresAt:
        makerExpiry && Date.parse(makerExpiry) < Date.parse(expiresAt) ? makerExpiry : expiresAt,
      rfq: {
        quoteId: String(body.quoteId ?? ""),
        tx: body.tx ?? null,
        // Bebop returns this separately from tx.to. They are the same contract
        // today, so approving tx.to happens to work — and would break silently
        // the moment they differ (a separate settlement contract, or Permit2
        // instead of a standard approval). Approve what the maker names.
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
      // Bebop pays the receiver named at quote time; we quote with the
      // orchestrator as receiver, so anything else is a caller mistake rather
      // than something to paper over by forwarding tokens silently. Checked
      // BEFORE anything is submitted: validating after the settlement would
      // convert the caller's tokens and then throw — the worst of both.
      throw new Error(`RFQ quote pays ${orchestratorAddress}, not ${to}`);
    }
    const a = addrs();
    const token = quote.side === "EURE_TO_USDC" ? a.eure : a.usdc;
    // Approve the address the maker nominated, not the tx target. Bebop
    // returns approvalTarget separately; the two coincide today, so approving
    // tx.to works by luck rather than by contract.
    const spender = (quote.rfq?.approvalTarget ?? tx.to) as `0x${string}`;
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

/**
 * CoW Protocol — intent-based liquidity, no inventory on either side.
 *
 * Why this exists alongside the RFQ provider: Bebop does not list EURe (tested
 * against Monerium's production addresses on Base, Polygon and Gnosis — all
 * "TokenNotSupported"), and has no testnet at all. CoW does quote EURe, at
 * essentially the mid rate, on Gnosis where Monerium is native and EURe
 * liquidity is deepest.
 *
 * The model differs from RFQ in a way that matters here. There is no
 * transaction to submit: you sign an ORDER and solvers compete to fill it. So
 * `execute` places the order and returns; settlement happens when a solver
 * picks it up, which is asynchronous and not guaranteed within any deadline.
 * The signature is EIP-1271, so the user's Safe — or the orchestrator — can
 * sign without an EOA.
 *
 * NOT WIRED FOR EXECUTION YET. quote() is live and correct; execute() refuses,
 * because placing an order needs an EIP-712 signature over CoW's order struct
 * and a decision about who signs (the Safe, with the user present, or the
 * orchestrator). Quoting is useful on its own — it prices the corridor without
 * committing to anything.
 */
class CowLiquidityProvider implements LiquidityProvider {
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
      rate: rate6dp(
        side === "EURE_TO_USDC" ? amountIn : expectedOut,
        side === "EURE_TO_USDC" ? expectedOut : amountIn,
      ),
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
        "with the user present, or the orchestrator). Quoting works; use " +
        "LIQUIDITY_PROVIDER=fx-swapper to settle.",
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

/**
 * Uniswap v3, executed on-chain.
 *
 * The venue that finally settles: Bebop will not list EURe and has no testnet,
 * CoW quotes but deliberately refuses to execute. A pool is just a contract, so
 * this one can be proven on Base Sepolia before it ever sees real money.
 *
 * The important difference from RFQ is that a pool price is not a promise. A
 * maker quotes what it will honour; a pool is wherever the last trade left it,
 * and anyone can move a thin one. So every quote is checked against the
 * independent live mid, and the pool the check ran on is pinned onto the quote
 * so execution cannot drift to a different one.
 */
class DexLiquidityProvider implements LiquidityProvider {
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

    const delivered = (await balanceOf(to)) - before;
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
class LifiLiquidityProvider implements LiquidityProvider {
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
    await publicClient.waitForTransactionReceipt({ hash: swapHash });

    // Measured. LI.FI's slippage bound is enforced inside its own contract, but
    // what the rest of the transfer settles against is what actually arrived.
    const delivered = (await balanceOf(to)) - before;
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

/**
 * Best execution across every wired venue.
 *
 * WHY THIS HAS TO EXIST once there is more than one venue. LI.FI aggregates,
 * the Uniswap adapter sees one pool; picking between them by config means
 * settling at the worse price every time the other is better, silently. The
 * live numbers make that concrete rather than theoretical — LI.FI quoted
 * 1.1506 on Base where a single pool would have been whatever that pool held.
 *
 * Venues are quoted in PARALLEL and the largest out for the same in wins. A
 * venue that refuses does not sink the trade; a venue that refuses for a reason
 * that should stop the trade (a price the independent mid disagrees with) has
 * already refused inside its own quote(), which is why that guard lives per
 * venue rather than here.
 *
 * Every venue's answer is recorded on the quote, including the losers and the
 * reasons they failed, so the choice can be reviewed afterwards instead of
 * being a number that appeared from nowhere.
 *
 * NOT netted against gas. On the L2s in play gas is cents against a
 * corridor-sized trade, and pretending to a precision we do not have would be
 * worse than the omission — but it does mean a venue that wins by a hair on
 * price could lose on cost. Revisit if venues ever land that close.
 */
export class BestExecutionProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  /** Venues may be injected. Tests need that because config is frozen at first
   *  import, so an env flip afterwards silently exercises the default and
   *  passes for the wrong reason. */
  constructor(private injected?: { id: string; provider: LiquidityProvider }[]) {}

  private venues(): { id: string; provider: LiquidityProvider }[] {
    if (this.injected) {
      if (!this.injected.length) throw new Error("no venues configured — nothing to quote against");
      return this.injected;
    }
    const ids = LIQUIDITY.VENUES.filter((v) => v !== "best") as LiquidityProviderId[];
    if (!ids.length) throw new Error("LIQUIDITY_VENUES is empty — nothing to quote against");
    return ids.map((id) => ({ id, provider: providerById(id) }));
  }

  async quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote> {
    const venues = this.venues();
    const settled = await Promise.allSettled(
      venues.map((v) => v.provider.quote(side, amountIn, quoteId, expiresAt)),
    );

    const routing = settled.map((r, i) => ({
      venue: venues[i].id,
      expectedOut: r.status === "fulfilled" ? r.value.expectedOut.toString() : null,
      ...(r.status === "rejected" ? { error: String(r.reason?.message ?? r.reason).slice(0, 200) } : {}),
    }));

    const winners = settled
      .map((r, i) => (r.status === "fulfilled" ? { q: r.value, id: venues[i].id } : null))
      .filter((x): x is { q: LiquidityQuote; id: string } => x !== null)
      .sort((a, b) => (b.q.expectedOut > a.q.expectedOut ? 1 : b.q.expectedOut < a.q.expectedOut ? -1 : 0));

    if (!winners.length) {
      const why = routing.map((r) => `${r.venue}: ${r.error ?? "no quote"}`).join(" | ");
      throw new Error(`no venue would quote ${side} — refusing rather than settling. ${why}`);
    }

    // The winner's own quote is returned intact, so execute() dispatches to the
    // venue that actually priced it and every venue-specific binding it carries
    // (the LI.FI tx, the pinned pool) survives.
    return { ...winners[0].q, routing };
  }

  async execute(quote: LiquidityQuote, to?: `0x${string}`): Promise<LiquidityExecution> {
    if (quote.provider === "best") {
      throw new Error("best-execution quote lost its winning venue — refusing to re-quote at execution time");
    }
    return providerById(quote.provider).execute(quote, to);
  }

  /**
   * Best execution over the venues that can serve a Safe executor. Venues
   * without safeSwapPlan (FxSwapper, CoW) are excluded HERE, not silently
   * downgraded — their absence is recorded in routing so a route choice under
   * this mode stays auditable. All capable venues failing refuses, and the
   * transfer falls back to the plain user-signed debit path.
   */
  async safeSwapPlan(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    const venues = this.venues();
    const settled = await Promise.allSettled(
      venues.map((v) =>
        v.provider.safeSwapPlan
          ? v.provider.safeSwapPlan(side, amountIn, quoteId, expiresAt, ctx)
          : Promise.reject(new Error("venue cannot serve a Safe executor")),
      ),
    );
    const routing = settled.map((r, i) => ({
      venue: venues[i].id,
      expectedOut: r.status === "fulfilled" ? r.value.quote.expectedOut.toString() : null,
      ...(r.status === "rejected" ? { error: String(r.reason?.message ?? r.reason).slice(0, 200) } : {}),
    }));
    const winners = settled
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((x): x is SafeSwapPlan => x !== null)
      .sort((a, b) =>
        b.quote.expectedOut > a.quote.expectedOut ? 1 : b.quote.expectedOut < a.quote.expectedOut ? -1 : 0,
      );
    if (!winners.length) {
      const why = routing.map((r) => `${r.venue}: ${r.error ?? "no plan"}`).join(" | ");
      throw new Error(`no venue can fill a Safe-executed ${side} — ${why}`);
    }
    return { ...winners[0], quote: { ...winners[0].quote, routing } };
  }

  async indicativeRate(side: LiquiditySide) {
    const now = Date.now();
    if (this.indicative && now - this.indicative.at < LIQUIDITY.INDICATIVE_TTL_MS) {
      return { rate: this.indicative.rate, raw: this.indicative.raw };
    }
    const rates = await Promise.allSettled(this.venues().map((v) => v.provider.indicativeRate(side)));
    const ok = rates.filter((r): r is PromiseFulfilledResult<{ rate: number; raw: bigint }> => r.status === "fulfilled");
    if (!ok.length) throw new Error("no venue could supply an indicative rate");
    const best = ok.map((r) => r.value).sort((a, b) => b.rate - a.rate)[0];
    this.indicative = { at: now, ...best };
    return best;
  }
}

/**
 * Measure positive slippage and apply the configured policy.
 *
 * Called by every venue after it reads the delivered amount. Surplus is
 * recorded whoever keeps it: under the default the user simply receives it,
 * and under "treasury" the amount is still written down, because a surplus
 * nobody can see is indistinguishable from an undisclosed margin.
 */
export function applySurplus(
  quote: LiquidityQuote,
  amountOut: bigint,
  /** Defaults to the configured policy. Passed explicitly only by tests, which
   *  cannot re-read config once the module is cached. */
  policy: "user" | "treasury" = LIQUIDITY.SURPLUS_POLICY,
): {
  amountOut: bigint;
  surplus?: LiquidityExecution["surplus"];
} {
  const raw = amountOut - quote.expectedOut;
  if (raw <= 0n) return { amountOut };
  if (policy === "treasury") {
    return { amountOut: quote.expectedOut, surplus: { amount: raw.toString(), keptBy: "treasury" } };
  }
  return { amountOut, surplus: { amount: raw.toString(), keptBy: "user" } };
}

/** One venue by id. Separate from liquidityProvider() so best execution can
 *  dispatch to the venue that actually priced a quote. */
export function providerById(id: LiquidityProviderId): LiquidityProvider {
  switch (id) {
    case "fx-swapper": return new FxSwapperLiquidityProvider();
    case "rfq": return new RfqLiquidityProvider();
    case "cow": return new CowLiquidityProvider();
    case "dex": return new DexLiquidityProvider();
    case "lifi": return new LifiLiquidityProvider();
    case "best": return new BestExecutionProvider();
    default:
      // Never fall back to FxSwapper here: that would silently price real
      // transfers off our own inventory on any LIQUIDITY_PROVIDER typo, the
      // exact degradation this seam exists to refuse.
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
        eur.toWei(transfer.sendEur - FX.FIXED_FEE_EUR),
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
    eur.toWei(transfer.sendEur - FX.FIXED_FEE_EUR),
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
    eur.toWei(transfer.sendEur - FX.FIXED_FEE_EUR),
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
 * The Safe-executed swap for an inbound crypto deposit — USDC in, EURe back
 * into the SAME Safe it came from.
 *
 * The same shape the cash rail uses: one user-signed batch that approves the
 * venue and executes the swap, with the output delivered straight back to the
 * user. The orchestrator never holds the deposit, so the path is non-custodial
 * end to end and needs no API-held owner key.
 *
 * RECIPIENT IS THE USER'S OWN SAFE, deliberately. On the cash rail the output
 * goes to a payout destination; here there is no payout — the user is
 * converting their own money and keeping it. Anything else would be a transfer
 * wearing a conversion's clothes.
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
