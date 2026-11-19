/**
 * One provider instance per id, so the indicative-rate caches hit.
 *
 * Every venue keeps a private indicative-rate cache for
 * LIQUIDITY.INDICATIVE_TTL_MS. A provider built fresh per call starts with an
 * empty cache, so each rate read re-probed every venue. These check that
 * providerById hands out the same object, that best resolves its venues
 * through it, and that a second rate read inside the TTL is served from cache.
 *
 * Venue prototypes are stubbed to throw, so no chain is started and no network.
 *
 * Run: npm run liquidity-provider:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";

process.env.LIQUIDITY_PROVIDER = "best";
process.env.LIQUIDITY_VENUES = "lifi,dex";
process.env.LIQUIDITY_INDICATIVE_TTL_MS = "60000";

const liquidity = await import("../services/api/src/liquidity.js");
const { DexLiquidityProvider } = await import("../services/api/src/liquidity/uniswap.js");
const { LifiLiquidityProvider } = await import("../services/api/src/liquidity/lifi.js");
const { providerById, liquidityProvider } = liquidity;

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);

// A venue object best did not get from providerById would reach a real
// network; refuse instead.
for (const cls of [DexLiquidityProvider, LifiLiquidityProvider]) {
  cls.prototype.indicativeRate = async () => {
    throw new Error(`${cls.name} built outside providerById`);
  };
}

assert.equal(providerById("dex"), providerById("dex"));
assert.equal(providerById("best"), providerById("best"));
assert.equal(liquidityProvider(), providerById("best"));
ok("providerById returns one instance per id");

assert.throws(() => providerById("nope" as any), /unknown liquidity provider "nope"/);
ok("an unknown id still throws");

const calls = { dex: 0, lifi: 0 };
(providerById("dex") as any).indicativeRate = async () => {
  calls.dex++;
  return { rate: 1.15, raw: 115n * 10n ** 16n };
};
(providerById("lifi") as any).indicativeRate = async () => {
  calls.lifi++;
  return { rate: 1.16, raw: 116n * 10n ** 16n };
};

const first = await liquidityProvider().indicativeRate("EURE_TO_USDC");
const second = await liquidityProvider().indicativeRate("EURE_TO_USDC");
assert.deepEqual(first, { rate: 1.16, raw: 116n * 10n ** 16n });
assert.deepEqual(second, first);
assert.deepEqual(calls, { dex: 1, lifi: 1 });
ok("best shares the venue instances and serves the second rate read from cache");

console.log(`\nliquidity provider: ${n} checks passed`);
