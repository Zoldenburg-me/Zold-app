/**
 * DEX liquidity provider — guard tests. No chain, no pool, no network.
 *
 * These cover the parts that decide whether a bad price can reach a real
 * transfer: the mid-deviation band, the decimal-sensitive rate arithmetic, and
 * the refusals that run before any chain call. What they cannot cover is a real
 * swap, which needs a seeded pool — see `npm run dex:setup`.
 */
import "./_local-chain.js";
import assert from "node:assert";

process.env.LIQUIDITY_PROVIDER = "dex";
// Pin the mid so the band tests are deterministic and offline.
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, INR: 96.55, KES: 129.64 });
process.env.ALLOW_FIXED_RATES = "1";
process.env.DEX_MAX_MID_DEVIATION_BPS = "300";

const { assertPriceSane, rate6dp } = await import("../services/api/src/dex.js");
const { liquidityProvider } = await import("../services/api/src/liquidity.js");

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);
async function refuses(label: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    throw new Error(`EXPECTED REFUSAL: ${label}`);
  } catch (e: any) {
    if (/^EXPECTED REFUSAL/.test(e.message)) throw e;
    assert.match(e.message, match, `${label}: wrong reason — ${e.message}`);
    ok(`${label} — refused: ${e.message.slice(0, 72)}…`);
  }
}

// --- rate arithmetic: 18dp EURe in, 6dp USDC out ---------------------------
{
  const r = rate6dp(10n ** 20n /* 100 EURe */, 113_830_000n /* 113.83 USDC */);
  assert.strictEqual(r, 1_138_300n, `expected 1.1383 in 6dp, got ${r}`);
  ok("rate6dp maps 100 EURe -> 113.83 USDC to 1.1383, across an 18dp/6dp gap");
}
{
  // The decimal trap: if the 1e18 scale were dropped the answer is off by 1e12.
  const r = rate6dp(10n ** 18n, 1_137_900n);
  assert.strictEqual(r, 1_137_900n);
  ok("rate6dp is scale-correct for a single unit (catches a dropped 1e18)");
}
assert.throws(() => rate6dp(0n, 1n), /zero EURe/);
ok("rate6dp refuses a zero denominator rather than dividing by it");

// --- the mid-deviation band ------------------------------------------------
{
  const { mid, deviationBps } = await assertPriceSane(1.1379);
  assert.strictEqual(mid, 1.1379);
  assert.strictEqual(deviationBps, 0);
  ok("a pool exactly on the mid passes with 0bps deviation");
}
{
  const { deviationBps } = await assertPriceSane(1.1379 * 1.02); // 200bps
  assert.ok(deviationBps > 190 && deviationBps < 210, `got ${deviationBps}bps`);
  ok(`a pool 2% off the mid still passes inside the 300bps band (${deviationBps}bps)`);
}
await refuses("a pool 5% above the mid", () => assertPriceSane(1.1379 * 1.05), /deviates \d+bps from the live mid/);
await refuses("a pool 5% below the mid", () => assertPriceSane(1.1379 * 0.95), /deviates \d+bps from the live mid/);
await refuses("a zero pool price", () => assertPriceSane(0), /not a positive number/);
await refuses("a NaN pool price", () => assertPriceSane(Number.NaN), /not a positive number/);

// --- refusals that run before any chain call -------------------------------
const p = liquidityProvider();
await refuses("a zero-amount quote", () => p.quote("EURE_TO_USDC", 0n, "q", new Date(Date.now() + 60_000).toISOString()), /positive amount/);

const base = {
  provider: "dex" as const, side: "EURE_TO_USDC" as const, quoteId: "q",
  tokenIn: "EURe" as const, tokenOut: "USDC" as const,
  amountIn: 10n ** 18n, expectedOut: 1_137_900n, minOut: 1_132_210n, rate: 1_137_900n,
};
await refuses(
  "an expired quote at execution",
  () => p.execute({ ...base, expiresAt: new Date(Date.now() - 1_000).toISOString(), dex: { pool: "0x0000000000000000000000000000000000000001", fee: 500, mid: 1.1379, deviationBps: 0 } }),
  /expired/,
);
await refuses(
  "a quote with no pinned pool (would re-quote at execution)",
  () => p.execute({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  /refusing to re-quote at execution/,
);

console.log(`\nDEX TEST PASSED — ${n}/${n}: pool prices are checked against an independent mid, and a skewed pool refuses`);
console.log("NOT covered here: a real swap. That needs a seeded pool — npm run dex:setup");
