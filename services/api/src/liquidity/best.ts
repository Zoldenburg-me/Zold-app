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
   *  import, so an env flip afterwards silently exercises the default and
   *  passes for the wrong reason. */
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
