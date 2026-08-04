/**
 * Best execution + surplus policy.
 *
 * Once more than one venue is wired, choosing by config means settling at the
 * worse price whenever the other venue is better — silently, and with nothing
 * in the record to show it happened. These cover the parts that make that
 * impossible: the larger out wins, losers and their reasons are recorded, a
 * dead venue does not sink a trade that another venue can price, and all
 * venues failing REFUSES rather than falling back to our own book.
 *
 * Also covers positive slippage. The default sends it to the user, and that
 * default is load-bearing: the receipt reports marginBps measured between the
 * live mid and what we deliver, so quietly keeping surplus would make that
 * number understate what we take. Under "treasury" the amount must still be
 * recorded.
 *
 * Stub venues, no chain and no network.
 *
 * Run: npm run best:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";

process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
process.env.ALLOW_FIXED_RATES = "1";

const liquidity = await import("../services/api/src/liquidity.js");
const { applySurplus } = liquidity;

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);

const ONE_HUNDRED = 100n * 10n ** 18n;
const quoteFrom = (provider: any, expectedOut: bigint): any => ({
  provider, side: "EURE_TO_USDC", quoteId: "q", tokenIn: "EURe", tokenOut: "USDC",
  amountIn: ONE_HUNDRED, expectedOut, minOut: (expectedOut * 995n) / 1000n,
  rate: (expectedOut * 10n ** 18n) / ONE_HUNDRED,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

// --- surplus policy --------------------------------------------------------
{
  const q = quoteFrom("lifi", 113_790_000n);
  const r = applySurplus(q, 114_000_000n); // 0.21 USDC more than quoted
  assert.equal(r.amountOut, 114_000_000n);
  assert.equal(r.surplus?.keptBy, "user");
  assert.equal(r.surplus?.amount, "210000");
  ok("positive slippage goes to the user by default, and is recorded");
}
{
  const q = quoteFrom("lifi", 113_790_000n);
  const r = applySurplus(q, 113_500_000n); // came in under the quote
  assert.equal(r.amountOut, 113_500_000n);
  assert.equal(r.surplus, undefined);
  ok("a shortfall is not dressed up as surplus (minOut is what refuses it)");
}
{
  const q = quoteFrom("lifi", 113_790_000n);
  const r = applySurplus(q, 113_790_000n);
  assert.equal(r.surplus, undefined);
  ok("an exact fill records no surplus");
}
{
  // Passed explicitly: config is frozen at first import, so an env flip after
  // that would silently test the default and pass for the wrong reason.
  const q = quoteFrom("lifi", 113_790_000n);
  const r = applySurplus(q, 114_000_000n, "treasury");
  assert.equal(r.amountOut, 113_790_000n, "user receives exactly what was quoted");
  assert.equal(r.surplus?.keptBy, "treasury");
  assert.equal(r.surplus?.amount, "210000");
  ok("under treasury policy the surplus is withheld but STILL RECORDED, never hidden");
}
{
  const { LIQUIDITY } = await import("../services/api/src/config.js");
  assert.equal(LIQUIDITY.SURPLUS_POLICY, "user");
  ok("the shipped default really is user — the honest one, not just the tested one");
}

// --- best execution: the real router, with injected venues -----------------
const { BestExecutionProvider } = liquidity as any;
const soon = () => new Date(Date.now() + 60_000).toISOString();

class StubVenue {
  constructor(private out: bigint | null, private label: string) {}
  async quote(_s: any, amountIn: bigint, quoteId: string, expiresAt: string) {
    if (this.out === null) throw new Error(`${this.label} is down`);
    return { ...quoteFrom(this.label, this.out), amountIn, quoteId, expiresAt };
  }
  async execute(q: any) { return { quote: q, amountOut: q.expectedOut, txs: [] }; }
  async indicativeRate() {
    if (this.out === null) throw new Error(`${this.label} is down`);
    return { rate: Number(this.out) / 1e8, raw: (this.out * 10n ** 18n) / ONE_HUNDRED };
  }
}
const router = (venues: [string, bigint | null][]) =>
  new BestExecutionProvider(venues.map(([id, out]) => ({ id, provider: new StubVenue(out, id) })));

{
  const q = await router([["dex", 113_000_000n], ["lifi", 113_790_000n]])
    .quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
  assert.equal(q.provider, "lifi");
  assert.equal(q.expectedOut, 113_790_000n);
  ok("the larger out wins for the same in (lifi 113.79 beats dex 113.00)");

  assert.equal(q.routing?.length, 2);
  assert.ok(q.routing?.some((r: any) => r.venue === "dex" && r.expectedOut === "113000000"));
  ok("the loser's price is recorded, so the choice is auditable afterwards");
}
{
  const q = await router([["dex", 114_500_000n], ["lifi", 113_790_000n]])
    .quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
  assert.equal(q.provider, "dex", "the aggregator must not win by default");
  ok("a pool that genuinely prices better than the aggregator is taken");
}
{
  const q = await router([["lifi", null], ["dex", 113_000_000n]])
    .quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
  assert.equal(q.provider, "dex");
  assert.ok(q.routing?.some((r: any) => r.venue === "lifi" && r.error?.includes("is down")));
  ok("one venue down does not sink a trade another venue can price, and the reason is kept");
}
{
  try {
    await router([["lifi", null], ["dex", null]]).quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
    throw new Error("EXPECTED REFUSAL");
  } catch (e: any) {
    assert.match(e.message, /no venue would quote/);
    assert.match(e.message, /lifi is down/);
    ok("every venue failing REFUSES rather than falling back to our own book, and names why");
  }
}
{
  try {
    await router([]).quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
    throw new Error("EXPECTED REFUSAL");
  } catch (e: any) {
    assert.match(e.message, /no venues configured/);
    ok("no venues configured refuses rather than silently using our own book");
  }
}
{
  const r = await router([["dex", 113_000_000n], ["lifi", 113_790_000n]]).indicativeRate("EURE_TO_USDC");
  assert.ok(Math.abs(r.rate - 1.1379) < 1e-9, `expected the better indicative rate, got ${r.rate}`);
  ok("the indicative rate shown on a receipt is the best venue's, not the first venue's");
}
{
  const q = quoteFrom("best", 113_790_000n);
  try {
    await router([["lifi", 113_790_000n]]).execute(q);
    throw new Error("EXPECTED REFUSAL");
  } catch (e: any) {
    assert.match(e.message, /lost its winning venue/);
    ok("a quote that lost its winning venue refuses rather than re-quoting at execution");
  }
}

console.log(`\nBEST EXECUTION TEST PASSED — ${n}/${n}: the better price wins, losers are recorded, surplus is measured and attributed`);
console.log("NOT covered here: a real multi-venue race. LI.FI has no testnet, so that can only be observed on a mainnet.");
