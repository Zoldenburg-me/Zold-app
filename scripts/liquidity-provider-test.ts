/**
 * One provider instance per id, so the indicative-rate caches hit — and the
 * money paths never read them.
 *
 * Every venue keeps a private indicative-rate cache, per side, for
 * LIQUIDITY.INDICATIVE_TTL_MS. A provider built fresh per call starts with an
 * empty cache, so each rate read re-probed every venue. These check that
 * providerById hands out the same object, that best resolves its venues
 * through it, that a second rate read inside the TTL is served from cache,
 * that one side's cached rate is never returned for the other, and that the
 * quote-binding check reads fresh: a venue rate that moves between quote and
 * execute inside the TTL must refuse. The quote's locked rate and the
 * refund-sizing fallback read fresh too.
 *
 * Venue quote() is stubbed per instance (and throws on the prototype), so the
 * real cache code runs but no chain is started and no network is reached.
 *
 * Run: npm run liquidity-provider:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.LIQUIDITY_PROVIDER = "best";
process.env.LIQUIDITY_VENUES = "lifi,dex";
process.env.LIQUIDITY_INDICATIVE_TTL_MS = "60000";
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, KES: 147.53 });

const liquidity = await import("../services/api/src/liquidity.js");
const { DexLiquidityProvider } = await import("../services/api/src/liquidity/uniswap.js");
const { LifiLiquidityProvider } = await import("../services/api/src/liquidity/lifi.js");
const { assertQuoteRateBinding, compensationRate } = await import("../services/api/src/orchestrator.js");
const { createQuote } = await import("../services/api/src/fx.js");
const { initStore, store } = await import("../services/api/src/store.js");
const { providerById, liquidityProvider } = liquidity;
type Side = import("../services/api/src/liquidity.js").LiquiditySide;

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);

// A venue object best did not get from providerById would reach a real
// network; refuse instead.
for (const cls of [DexLiquidityProvider, LifiLiquidityProvider]) {
  cls.prototype.quote = async () => {
    throw new Error(`${cls.name} built outside providerById`);
  };
}

assert.equal(providerById("dex"), providerById("dex"));
assert.equal(providerById("best"), providerById("best"));
assert.equal(liquidityProvider(), providerById("best"));
ok("providerById returns one instance per id");

assert.throws(() => providerById("nope" as any), /unknown liquidity provider "nope"/);
ok("an unknown id still throws");

// What each venue will quote now, per side, in the swapper's 6dp form.
const market: Record<"dex" | "lifi", Record<Side, bigint>> = {
  dex: { EURE_TO_USDC: 1_150_000n, USDC_TO_EURE: 860_000n },
  lifi: { EURE_TO_USDC: 1_160_000n, USDC_TO_EURE: 850_000n },
};
const calls = { dex: 0, lifi: 0 };
for (const id of ["dex", "lifi"] as const) {
  (providerById(id) as any).quote = async (side: Side) => {
    calls[id]++;
    return { rate: market[id][side] };
  };
}

const first = await liquidityProvider().indicativeRate("EURE_TO_USDC");
const second = await liquidityProvider().indicativeRate("EURE_TO_USDC");
assert.deepEqual(first, { rate: 1.16, raw: 1_160_000n });
assert.deepEqual(second, first);
assert.deepEqual(calls, { dex: 1, lifi: 1 });
ok("best shares the venue instances and serves the second rate read from cache");

const reverse = await liquidityProvider().indicativeRate("USDC_TO_EURE");
assert.deepEqual(reverse, { rate: 0.86, raw: 860_000n });
assert.deepEqual(calls, { dex: 2, lifi: 2 });
assert.deepEqual(await providerById("lifi").indicativeRate("USDC_TO_EURE"), { rate: 0.85, raw: 850_000n });
assert.deepEqual(await providerById("lifi").indicativeRate("EURE_TO_USDC"), { rate: 1.16, raw: 1_160_000n });
assert.deepEqual(calls, { dex: 2, lifi: 2 });
ok("USDC_TO_EURE inside the TTL is probed, not served EURE_TO_USDC's cached rate (best and venue)");

// The quote locked R = 1.16 a moment ago. Inside the TTL the market moves
// 80 bps against the user; the cap is 50.
rmSync(process.env.TRANSF_DB_PATH!, { force: true });
initStore();
const now = new Date().toISOString();
store.addQuote({
  id: "q-provider-cache",
  userId: "u-provider-cache",
  rail: "cash",
  status: "OPEN",
  sendEur: 100,
  fixedFeeEur: 1,
  fxRate: 1,
  receiveKes: 12950,
  receiveEur: 0,
  midRate: 1,
  marginBps: 0,
  effectiveRate: 1,
  lockedSwapRate: String(first.raw),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: now,
});
const transfer = { id: "t-provider-cache", quoteId: "q-provider-cache" } as any;
await assertQuoteRateBinding(transfer);
assert.deepEqual(calls, { dex: 3, lifi: 3 });
ok("the binding check re-probes the venues instead of reading the cache");

market.dex.EURE_TO_USDC = 1_140_000n;
market.lifi.EURE_TO_USDC = 1_150_720n; // 1.16 less 80 bps
assert.deepEqual(await liquidityProvider().indicativeRate("EURE_TO_USDC"), first);
await assert.rejects(assertQuoteRateBinding(transfer), /FX rate moved since quote \(80 bps > 50 bps cap\)/);
ok("a rate that moves 80 bps inside the TTL refuses at execution, though the cache still says R");

const fresh = await liquidityProvider().indicativeRate("EURE_TO_USDC", { fresh: true });
assert.equal(fresh.raw, 1_150_720n);
ok("a fresh read also bypasses best's cache and returns the moved rate");

// best's cache now holds 1_150_720n. Move the market again: a cached read
// would lock or refund at the old rate.
market.lifi.EURE_TO_USDC = 1_155_000n;
const locked = await createQuote("u-provider-cache", { rail: "cash", sendEur: 100 });
assert.deepEqual(calls, { dex: 6, lifi: 6 });
assert.equal(locked.lockedSwapRate, "1155000");
ok("createQuote locks a fresh rate, not the cached one");

market.lifi.EURE_TO_USDC = 1_152_000n;
const unpriced = { id: "t-unpriced", quoteId: "q-none" } as any;
assert.equal(await compensationRate(unpriced), 1_152_000n);
assert.deepEqual(calls, { dex: 7, lifi: 7 });
ok("the refund fallback (no executed or locked rate) reads fresh, not the cache");

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
console.log(`\nliquidity provider: ${n} checks passed`);
