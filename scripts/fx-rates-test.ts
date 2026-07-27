/**
 * Live FX rate tests.
 *
 * The bug these exist for: the mid rates were hardcoded (EURUSD 1.08,
 * USDINR 87.2, USDKES 129.5) and drifted 5-14% from the market while the
 * receipt claimed "the real exchange rate" with a 0.50% margin. A EUR->INR
 * quote came out 14.3% under the mid.
 *
 * So the checks that matter are: rates come from the feed, a dead feed REFUSES
 * rather than serving something stale, and the quote's EUR leg equals the rate
 * the on-chain swapper will actually execute at — the three copies of 1.08 that
 * nothing kept in sync.
 *
 * Run: npm run fx:test
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const PORT = Number(process.env.TRANSF_RATES_STUB_PORT ?? 8549);
process.env.TRANSF_RATES_URL = `http://127.0.0.1:${PORT}/rates`;
process.env.TRANSF_RATES_TTL_MS = "500";
process.env.TRANSF_RATES_TIMEOUT_MS = "1500";

let mode: "ok" | "500" | "garbage" | "missing" | "hang" | "wrongbase" = "ok";
let hits = 0;
const LIVE = { USD: 1.1379, INR: 109.87, KES: 147.53 };

const stub: Server = createServer(async (req, res) => {
  hits++;
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (mode === "500") return send(500, { error: "upstream down" });
  if (mode === "garbage") return send(200, "not json at all");
  if (mode === "missing") return send(200, { base: "EUR", rates: { USD: 1.1379 } });
  if (mode === "hang") return; // never responds -> client timeout
  if (mode === "wrongbase") return send(200, { base: "USD", rates: LIVE });
  send(200, { base: "EUR", date: "2026-07-26", rates: LIVE });
});

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

await new Promise<void>((r) => stub.listen(PORT, r));
const rates = await import("../services/api/src/rates.js");

try {
  await t("rates come from the feed, not a constant", async () => {
    rates.resetRateCache();
    const usd = await rates.eurPer("USD");
    assert.equal(usd, LIVE.USD);
    const inr = await rates.eurPer("INR");
    assert.equal(inr, LIVE.INR);
    // The old hardcoded EUR->INR was 1.08 * 87.2 = 94.176. If that number can
    // still come out of the quote engine, nothing was actually fixed.
    assert.ok(
      Math.abs(inr - 94.176) > 1,
      `EUR/INR is still the old hardcoded 94.176 — feed not wired in`,
    );
  });

  await t("USD legs are derived from the EUR legs", async () => {
    rates.resetRateCache();
    const usdInr = await rates.usdPer("INR");
    assert.ok(Math.abs(usdInr - LIVE.INR / LIVE.USD) < 1e-9, `got ${usdInr}`);
    const usdKes = await rates.usdPer("KES");
    assert.ok(Math.abs(usdKes - LIVE.KES / LIVE.USD) < 1e-9, `got ${usdKes}`);
  });

  await t("results are cached — a burst of quotes is one upstream call", async () => {
    rates.resetRateCache();
    hits = 0;
    await Promise.all(Array.from({ length: 12 }, () => rates.eurPer("USD")));
    assert.equal(hits, 1, `expected 1 upstream call, got ${hits}`);
  });

  await t("a 5xx feed REFUSES to quote rather than serving a stale rate", async () => {
    rates.resetRateCache();
    await rates.eurPer("USD"); // warm the cache with a good value
    mode = "500";
    await new Promise((r) => setTimeout(r, 600)); // let the TTL lapse
    await assert.rejects(() => rates.eurPer("USD"), /live FX rates unavailable/);
    mode = "ok";
  });

  await t("a malformed feed response is refused", async () => {
    rates.resetRateCache();
    mode = "garbage";
    await assert.rejects(() => rates.eurPer("USD"), /live FX rates unavailable/);
    mode = "ok";
  });

  await t("a feed missing a currency we quote is refused", async () => {
    rates.resetRateCache();
    mode = "missing";
    await assert.rejects(() => rates.eurPer("USD"), /INR/);
    mode = "ok";
  });

  await t("a hanging feed times out instead of blocking quotes forever", async () => {
    rates.resetRateCache();
    mode = "hang";
    const started = Date.now();
    await assert.rejects(() => rates.eurPer("USD"), /live FX rates unavailable/);
    assert.ok(Date.now() - started < 5_000, "timeout did not fire");
    mode = "ok";
  });

  // Served from the same stub rather than a second server on another URL:
  // config.ts reads TRANSF_RATES_URL at import time, so re-pointing the env var
  // and re-importing does nothing — the cached config still holds the old URL
  // and the assertion passes for the wrong reason.
  await t("a wrong-base feed is refused rather than silently mis-scaled", async () => {
    rates.resetRateCache();
    mode = "wrongbase";
    await assert.rejects(() => rates.eurPer("USD"), /expected EUR/);
    mode = "ok";
  });

  await t("pinned rates serve tests/offline demos without touching the feed", async () => {
    rates.resetRateCache();
    mode = "500"; // feed is down; the pin must not need it
    process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
    assert.equal(await rates.eurPer("INR"), 109.87);
    delete process.env.TRANSF_RATES_FIXED;
    mode = "ok";
  });

  await t("a pinned rate is REFUSED in production unless explicitly allowed", async () => {
    rates.resetRateCache();
    process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1, INR: 100, KES: 140 });
    process.env.NODE_ENV = "production";
    // A frozen rate in production is the original bug wearing a different hat.
    await assert.rejects(() => rates.eurPer("INR"), /set in production/);
    process.env.ALLOW_FIXED_RATES = "1";
    assert.equal(await rates.eurPer("INR"), 100, "explicit override should work");
    delete process.env.ALLOW_FIXED_RATES;
    delete process.env.NODE_ENV;
    delete process.env.TRANSF_RATES_FIXED;
  });

  await t("a pinned set missing a currency is refused, not half-used", async () => {
    rates.resetRateCache();
    process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1, INR: 100 }); // no KES
    await assert.rejects(() => rates.eurPer("INR"), /missing a valid KES/);
    delete process.env.TRANSF_RATES_FIXED;
  });

  console.log(`\nFX RATES TEST PASSED — ${pass}/${pass}: rates are live, and a dead feed refuses instead of quoting stale`);
} finally {
  stub.close();
}
