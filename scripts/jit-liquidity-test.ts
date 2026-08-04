/**
 * JIT (RFQ) liquidity provider tests.
 *
 * The EURe->USDC leg can be filled from our own inventory ("fx-swapper", an
 * owner-set rate) or just-in-time by a market maker over Bebop's PMM RFQ API,
 * where the price is one a maker has actually committed to.
 *
 * What matters here is that the RFQ path never degrades quietly. A maker that
 * is down, declining, slow, or returning a quote for the wrong token must
 * refuse — falling back to our own inventory at our own rate would price real
 * transfers off a number we chose while reporting that a maker set it, and
 * would look completely healthy doing it.
 *
 * Runs against a stub Bebop shaped like the documented v3 response
 * (buyTokens[addr].{amount,minimumAmount}, expiry, tx). No chain needed: the
 * provider is exercised directly.
 *
 * Run: npm run jit:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const PORT = Number(process.env.TRANSF_BEBOP_STUB_PORT ?? 8551);

process.env.LIQUIDITY_PROVIDER = "rfq";
process.env.BEBOP_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.BEBOP_CHAIN = "polygon";
process.env.BEBOP_TIMEOUT_MS = "1500";
process.env.LIQUIDITY_INDICATIVE_TTL_MS = "400";
// The provider reads token addresses from deployments; point it at a fixed set
// so the test needs no chain.
process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });

// The real deployed token addresses, read the same way the provider does.
// No RPC is needed: quote() only talks to the maker, and the execute() paths
// exercised here refuse before they ever reach the chain. Faking these instead
// would only prove the stub agrees with itself.
const { addrs } = await import("../services/api/src/chain.js");
const EURE = addrs().eure;
const USDC = addrs().usdc;
const SETTLEMENT = "0x3333333333333333333333333333333333333333";

let mode: "ok" | "500" | "decline" | "wrongtoken" | "notx" | "hang" | "shortexpiry" = "ok";
let lastQuery: URLSearchParams | null = null;
let hits = 0;
/** USDC (6dp) out per 1 EURe (18dp) in — the maker's price for this test. */
let makerRate = 1.1379;

const stub: Server = createServer((req, res) => {
  hits++;
  lastQuery = new URL(req.url ?? "", `http://x`).searchParams;
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (mode === "hang") return;
  if (mode === "500") return send(502, { error: "no makers" });
  if (mode === "decline") return send(200, { status: "Failure", error: { errorCode: 104 } });

  const sellAmt = BigInt(lastQuery.get("sell_amounts") ?? "0");
  const out = (sellAmt * BigInt(Math.round(makerRate * 1e6))) / 10n ** 18n;
  const buyKey = mode === "wrongtoken" ? "0x9999999999999999999999999999999999999999" : USDC;
  const expiry =
    mode === "shortexpiry"
      ? Math.floor(Date.now() / 1000) + 2 // sooner than the caller's window
      : Math.floor(Date.now() / 1000) + 3600;
  send(200, {
    quoteId: "bebop-quote-1",
    status: "Success",
    expiry,
    sellTokens: { [EURE]: { amount: sellAmt.toString(), decimals: 18, symbol: "EURe" } },
    buyTokens: {
      [buyKey]: {
        amount: out.toString(),
        minimumAmount: ((out * 9970n) / 10000n).toString(),
        decimals: 6,
        symbol: "USDC",
      },
    },
    ...(mode === "notx" ? {} : { tx: { to: SETTLEMENT, data: "0xdeadbeef", value: "0" } }),
  });
});

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

await new Promise<void>((r) => stub.listen(PORT, r));

try {
  const { liquidityProvider } = await import("../services/api/src/liquidity.js");
  const p = liquidityProvider();

  await t("rfq provider is selected from config, not hardcoded", async () => {
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q1", new Date(Date.now() + 600_000).toISOString());
    assert.equal(q.provider, "rfq", "expected the RFQ provider to be active");
  });

  await t("the maker is asked for the right pair, amount and taker", async () => {
    await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q2", new Date(Date.now() + 600_000).toISOString());
    assert.equal(lastQuery?.get("sell_tokens"), EURE);
    assert.equal(lastQuery?.get("buy_tokens"), USDC);
    assert.equal(lastQuery?.get("sell_amounts"), (100n * 10n ** 18n).toString());
    assert.ok(lastQuery?.get("taker_address"), "taker_address must be sent");
    assert.equal(lastQuery?.get("gasless"), "false", "we submit the tx ourselves");
  });

  await t("the quoted price is the MAKER's, not our own posted rate", async () => {
    makerRate = 1.2;
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q3", new Date(Date.now() + 600_000).toISOString());
    assert.equal(q.expectedOut, 120_000_000n, `100 EURe at 1.20 should buy 120 USDC, got ${q.expectedOut}`);
    assert.equal(q.rate, 1_200_000n, "rate uses the swapper's 6dp-per-1e18 convention");
    makerRate = 1.1379;
  });

  await t("the maker's own minimumAmount is used as minOut", async () => {
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q4", new Date(Date.now() + 600_000).toISOString());
    assert.equal(q.minOut, (q.expectedOut * 9970n) / 10000n);
    assert.ok(q.minOut < q.expectedOut, "minOut must bound the fill");
  });

  await t("a maker expiry sooner than ours wins", async () => {
    mode = "shortexpiry";
    const ours = new Date(Date.now() + 600_000).toISOString();
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q5", ours);
    assert.ok(Date.parse(q.expiresAt) < Date.parse(ours), "should adopt the maker's earlier expiry");
    mode = "ok";
  });

  await t("a maker that is down REFUSES — no fallback to our own inventory", async () => {
    mode = "500";
    await assert.rejects(
      () => p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q6", new Date(Date.now() + 600_000).toISOString()),
      /RFQ quote failed \(502\)/,
    );
    mode = "ok";
  });

  await t("a declined quote is refused, not read as a fill", async () => {
    mode = "decline";
    await assert.rejects(
      () => p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q7", new Date(Date.now() + 600_000).toISOString()),
      /RFQ maker declined/,
    );
    mode = "ok";
  });

  await t("a quote for the wrong token is refused", async () => {
    mode = "wrongtoken";
    await assert.rejects(
      () => p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q8", new Date(Date.now() + 600_000).toISOString()),
      /missing buyTokens entry/,
    );
    mode = "ok";
  });

  await t("a hanging maker times out instead of stalling the transfer", async () => {
    mode = "hang";
    const started = Date.now();
    await assert.rejects(() =>
      p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q9", new Date(Date.now() + 600_000).toISOString()),
    );
    assert.ok(Date.now() - started < 5_000, "timeout did not fire");
    mode = "ok";
  });

  await t("an expired quote is not executed", async () => {
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q10", new Date(Date.now() - 1).toISOString());
    await assert.rejects(() => p.execute(q), /expired/);
  });

  await t("a quote with no executable tx refuses rather than re-quoting", async () => {
    mode = "notx";
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q11", new Date(Date.now() + 600_000).toISOString());
    // Re-quoting at execution time would settle at a price the user never saw.
    await assert.rejects(() => p.execute(q), /no executable tx/);
    mode = "ok";
  });

  await t("indicative rates are cached — typing in the amount box is not a quote storm", async () => {
    hits = 0;
    await p.indicativeRate("EURE_TO_USDC");
    await p.indicativeRate("EURE_TO_USDC");
    await p.indicativeRate("EURE_TO_USDC");
    assert.equal(hits, 1, `expected 1 maker call, got ${hits}`);
  });

  await t("the indicative cache expires so a stale maker price is not shown", async () => {
    // Its own provider instance: the previous check leaves a warm cache, and
    // reusing it here made this test's result depend on how fast that one ran.
    const fresh = liquidityProvider();
    hits = 0;
    await fresh.indicativeRate("EURE_TO_USDC");
    assert.equal(hits, 1, "first call should reach the maker");
    await new Promise((r) => setTimeout(r, 500)); // past LIQUIDITY_INDICATIVE_TTL_MS
    await fresh.indicativeRate("EURE_TO_USDC");
    assert.equal(hits, 2, `cache should have lapsed, got ${hits} calls`);
  });

  await t("an rfq quote survives the prepare -> execute round trip", async () => {
    const { serializeExecution } = await import("../services/api/src/liquidity.js");
    const q = await p.quote("EURE_TO_USDC", 100n * 10n ** 18n, "q12", new Date(Date.now() + 600_000).toISOString());
    const stored = serializeExecution({ quote: q, amountOut: q.expectedOut, txs: [] });
    // Without this the maker's tx is dropped between the two steps and
    // execution fails on a quote that was perfectly good.
    assert.ok(stored.rfq?.tx?.data, "the maker's tx must be persisted");
    assert.equal(stored.rfq?.quoteId, "bebop-quote-1");
  });

  console.log(
    `\nJIT LIQUIDITY TEST PASSED — ${pass}/${pass}: RFQ prices come from the maker, and a bad maker refuses instead of falling back to our own book`,
  );
} finally {
  stub.close();
}
