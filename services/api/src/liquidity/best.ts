/**
 * Best execution across every wired venue.
 *
 * LI.FI aggregates and the Uniswap adapter sees one pool, so picking one by
 * config settles at the worse price whenever the other is better (LI.FI
 * quoted 1.1506 on Base, where a single pool gives whatever it holds).
 *
 * Venues are quoted in parallel and the largest out for the same in wins. One
 * venue refusing does not sink the trade. The price-vs-mid guard runs inside
 * each venue's own quote(), so a bad price has already refused there.
 *
 * Every venue's answer, including losers and their failure reasons, is
 * recorded on the quote so the choice can be reviewed later.
 *
 * Not netted against gas: on these L2s gas is cents against a corridor-sized
 * trade. A venue that wins on price by a hair could still lose on cost;
 * revisit if venues land that close.
 */
import { LIQUIDITY } from "../config.js";
import {
  LiquidityExecution,
  LiquidityProvider,
  LiquidityProviderId,
  LiquidityQuote,
  LiquiditySide,
  SafeSwapContext,
  SafeSwapPlan,
  } from "./contract.js";

export class BestExecutionProvider implements LiquidityProvider {
  private indicative: { at: number; rate: number; raw: bigint } | null = null;

  /** Venues may be injected. Tests need that because config is frozen at first
   *  import, so a later env change would test the default venues instead. */
  constructor(
    private injected?: { id: string; provider: LiquidityProvider }[],
    /** How to build a venue by id. Injected by the seam rather than imported
     *  from it: the registry knows every venue, and a venue importing the
     *  registry back would be a cycle for no gain. */
    private resolve: (id: LiquidityProviderId) => LiquidityProvider = () => {
      throw new Error("BestExecutionProvider was constructed without venues or a resolver");
    },
  ) {}

  private venues(): { id: string; provider: LiquidityProvider }[] {
    if (this.injected) {
      if (!this.injected.length) throw new Error("no venues configured — nothing to quote against");
      return this.injected;
    }
    const ids = LIQUIDITY.VENUES.filter((v) => v !== "best") as LiquidityProviderId[];
    if (!ids.length) throw new Error("LIQUIDITY_VENUES is empty — nothing to quote against");
    return ids.map((id) => ({ id, provider: this.resolve(id) }));
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
    return this.resolve(quote.provider).execute(quote, to);
  }

  /**
   * Exact output over the venues that can plan one (today: dex). The cheapest
   * ceiling wins; a venue that cannot deliver an exact amount is simply not a
   * candidate, so with none the caller fails closed.
   */
  async safeExactOutputPlan(
    side: LiquiditySide,
    amountOut: bigint,
    maxAmountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan> {
    const venues = this.venues().filter((v) => v.provider.safeExactOutputPlan);
    if (!venues.length) throw new Error("no configured venue can plan an exact-output swap (needs dex)");
    const settled = await Promise.allSettled(
      venues.map((v) => v.provider.safeExactOutputPlan!(side, amountOut, maxAmountIn, quoteId, expiresAt, ctx)),
    );
    const winners = settled
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((x): x is SafeSwapPlan => x !== null)
      .sort((a, b) => (a.quote.amountIn < b.quote.amountIn ? -1 : a.quote.amountIn > b.quote.amountIn ? 1 : 0));
    if (!winners.length) {
      const why = settled.map((r, i) => `${venues[i].id}: ${r.status === "rejected" ? String(r.reason?.message ?? r.reason).slice(0, 200) : "no plan"}`).join(" | ");
      throw new Error(`no venue can deliver exactly ${amountOut} — ${why}`);
    }
    return winners[0];
  }

  /**
   * Best execution over the venues that can serve a Safe executor. Venues
   * without safeSwapPlan (FxSwapper, CoW) are excluded here and their absence
   * is recorded in routing. If every capable venue fails this refuses, and
   * the transfer falls back to the plain user-signed debit path.
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
