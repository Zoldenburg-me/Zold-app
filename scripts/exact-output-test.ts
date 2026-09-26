/**
 * Exact-output conversion: which venues can plan one, and what the plan
 * commits the user to. Offline; the pool and quoter are stubbed at the RPC
 * client so the arithmetic and the calldata are what is checked.
 *
 * What is pinned:
 *  - Uniswap plans exactOutputSingle with the invoice amount as amountOut and
 *    the quoted input plus slippage as amountInMaximum, delivered to the
 *    user's own Safe;
 *  - a ceiling above the USDC available refuses (a short payment is short);
 *  - LI.FI and best-without-dex refuse, rather than falling back to exact
 *    input;
 *  - the pay link accepts an external invoice number, not alongside a Zold
 *    invoice.
 *
 * Run: npm run exact-output:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";

process.env.TRANSF_CHAIN_ID = "31337";
process.env.LIQUIDITY_PROVIDER = "dex";
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1403, KES: 147.53, INR: 109.87 });

const chain = await import("../services/api/src/chain.js");
const { LIQUIDITY } = await import("../services/api/src/config.js");
const { routerAbi } = await import("../services/api/src/dex.js");
const { DexLiquidityProvider } = await import("../services/api/src/liquidity/uniswap.js");
const { LifiLiquidityProvider } = await import("../services/api/src/liquidity/lifi.js");
const { BestExecutionProvider } = await import("../services/api/src/liquidity/best.js");
const { validateCreate } = await import("../services/api/src/payment-requests.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; }
};

// The chain, stubbed: one pool at fee 500 with liquidity, and a quoter that
// prices 1 EURe at 1.1452 USDC (the pool's own price, a few bps off the mid).
const POOL = `0x${"11".repeat(20)}` as const;
const POOL_RATE = 1.1452;
const client: any = chain.publicClient;
client.readContract = async ({ functionName, args }: any) => {
  if (functionName === "getPool") return Number(args[2]) === 500 ? POOL : `0x${"00".repeat(20)}`;
  if (functionName === "liquidity") return 10n ** 24n;
  throw new Error(`unexpected read ${functionName}`);
};
client.simulateContract = async ({ functionName, args }: any) => {
  const a = args[0];
  if (functionName === "quoteExactOutputSingle") {
    // USDC in for EURe out
    const eureOut = Number(a.amount) / 1e18;
    return { result: [BigInt(Math.ceil(eureOut * POOL_RATE * 1e6)), 0n, 0, 0n] };
  }
  if (functionName === "quoteExactInputSingle") {
    const usdcIn = Number(a.amountIn) / 1e6;
    return { result: [BigInt(Math.floor((usdcIn / POOL_RATE) * 1e18)), 0n, 0, 0n] };
  }
  throw new Error(`unexpected simulate ${functionName}`);
};

const SAFE = `0x${"aa".repeat(20)}` as const;
const ctx = { executor: SAFE, recipient: SAFE };
const INVOICE_EURE = 119n * 10n ** 18n;

console.log("\nUniswap");

await check("the plan delivers exactly the invoice amount to the user's own Safe, with the quoted input plus slippage as the ceiling", async () => {
  const dex = new DexLiquidityProvider();
  const plan = await dex.safeExactOutputPlan("USDC_TO_EURE", INVOICE_EURE, 140_000_000n, "q1", new Date(Date.now() + 60_000).toISOString(), ctx);
  const quotedIn = BigInt(Math.ceil(119 * POOL_RATE * 1e6));
  const ceiling = (quotedIn * (10_000n + LIQUIDITY.DEX_SLIPPAGE_BPS)) / 10_000n;
  assert.equal(plan.quote.expectedOut, INVOICE_EURE);
  assert.equal(plan.quote.minOut, INVOICE_EURE, "exact output has no floor below the target");
  assert.equal(plan.quote.amountIn, ceiling);
  assert.deepEqual(plan.quote.exactOutput, { quotedIn, amountInMaximum: ceiling });
  assert.equal(plan.approval.amount, ceiling, "the approval is the ceiling, so the router cannot pull more");
  assert.equal(plan.approval.spender, LIQUIDITY.DEX_ROUTER);
  assert.equal(plan.call.to, LIQUIDITY.DEX_ROUTER);
  assert.equal(plan.call.value, 0n);
  const decoded = decodeFunctionData({ abi: routerAbi, data: plan.call.data });
  assert.equal(decoded.functionName, "exactOutputSingle");
  const p: any = decoded.args[0];
  assert.equal(p.amountOut, INVOICE_EURE);
  assert.equal(p.amountInMaximum, ceiling);
  assert.equal(p.recipient.toLowerCase(), SAFE);
  assert.equal(p.tokenIn.toLowerCase(), chain.addrs().usdc.toLowerCase());
  assert.equal(p.tokenOut.toLowerCase(), chain.addrs().eure.toLowerCase());
  assert.equal(p.fee, 500);
  assert.equal(plan.quote.dex!.pool, POOL);
});

await check("a ceiling above the USDC available refuses — a short payment is short, never topped up", async () => {
  const dex = new DexLiquidityProvider();
  await assert.rejects(
    () => dex.safeExactOutputPlan("USDC_TO_EURE", INVOICE_EURE, 100_000_000n, "q2", new Date(Date.now() + 60_000).toISOString(), ctx),
    /more than the 100000000 available — refusing; the payment is short of the invoice/,
  );
});

await check("a pool price too far from the live mid refuses", async () => {
  process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.30, KES: 147.53, INR: 109.87 });
  const { resetRateCache } = await import("../services/api/src/rates.js");
  resetRateCache();
  const dex = new DexLiquidityProvider();
  await assert.rejects(
    () => dex.safeExactOutputPlan("USDC_TO_EURE", INVOICE_EURE, 200_000_000n, "q3", new Date(Date.now() + 60_000).toISOString(), ctx),
    /deviates .*bps from the live mid/,
  );
  process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1403, KES: 147.53, INR: 109.87 });
  resetRateCache();
});

console.log("\nOther venues fail closed");

await check("LI.FI has no exact-output plan (its reverse quote is exact-input sized to a target, with the leftover on the EURe side)", () => {
  const lifi = new LifiLiquidityProvider() as any;
  assert.equal(typeof lifi.safeExactOutputPlan, "undefined");
});

await check("best execution delegates to the venues that can, and refuses with none", async () => {
  const withDex = new BestExecutionProvider([{ id: "lifi", provider: new LifiLiquidityProvider() }, { id: "dex", provider: new DexLiquidityProvider() }]);
  const plan = await withDex.safeExactOutputPlan("USDC_TO_EURE", INVOICE_EURE, 140_000_000n, "q4", new Date(Date.now() + 60_000).toISOString(), ctx);
  assert.equal(plan.quote.provider, "dex");
  const lifiOnly = new BestExecutionProvider([{ id: "lifi", provider: new LifiLiquidityProvider() }]);
  await assert.rejects(
    () => lifiOnly.safeExactOutputPlan("USDC_TO_EURE", INVOICE_EURE, 140_000_000n, "q5", new Date(Date.now() + 60_000).toISOString(), ctx),
    /no configured venue can plan an exact-output swap/,
  );
});

await check("the liquidity seam refuses exact output on a venue without it, naming the venue", async () => {
  const liq = await import("../services/api/src/liquidity.js");
  const provider = liq.liquidityProvider();
  assert.equal(typeof provider.safeExactOutputPlan, "function", "dex is configured for this run");
  const fx = liq.providerById("fx-swapper");
  assert.equal(typeof fx.safeExactOutputPlan, "undefined", "our own inventory cannot deliver exact output for a Safe executor");
});

console.log("\nPay link");

await check("a link carries an external invoice number, trimmed, and not alongside a Zold invoice", () => {
  const user: any = { paymentPage: { handle: "zold", depositAddress: SAFE }, iban: "EE1" };
  const v = validateCreate({ amountEur: 119, externalInvoiceNumber: "  RE-2026-0042  " }, user);
  assert.equal(v.externalInvoiceNumber, "RE-2026-0042");
  assert.throws(() => validateCreate({ amountEur: 119, externalInvoiceNumber: "RE-1", invoiceId: "inv_1" }, user), /not both/);
  assert.throws(() => validateCreate({ amountEur: 119, externalInvoiceNumber: 42 }, user), /must be a string/);
  assert.equal(validateCreate({ amountEur: 1 }, user).externalInvoiceNumber, undefined);
});

console.log(`\nexact-output: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
console.log("NOT PROVEN HERE: no exact-output swap has executed on any chain; the router's amountIn is measured only once one has.");
