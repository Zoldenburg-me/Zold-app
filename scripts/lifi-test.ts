/**
 * LI.FI liquidity provider tests.
 *
 * LI.FI is the venue intended for production: aggregated routing rather than
 * one pool we picked. Tested live before building this — 100 EURe -> USDC
 * quoted executable on Gnosis (1.1493), Base (1.1506) and Polygon (1.1491)
 * against a live mid of ~1.1511, routed through Nordstern Finance, Fly and
 * Bitget, none of which a hardcoded venue list would contain.
 *
 * What matters here is that aggregation does not become a blind spot. We are
 * handing route selection to a third party, so every way its answer can be
 * wrong has to refuse rather than settle: unreachable, erroring, priced in a
 * token we did not ask for, carrying no executable transaction, naming no
 * approval target, or simply quoting a rate the rest of the market disagrees
 * with.
 *
 * Runs against a stub shaped like the real /v1/quote response, whose fields
 * were captured from a live Base mainnet call. No chain needed: quote() only
 * talks to LI.FI, and the execute() paths here refuse before reaching the chain.
 *
 * Run: npm run lifi:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const PORT = Number(process.env.TRANSF_LIFI_STUB_PORT ?? 8553);

process.env.LIQUIDITY_PROVIDER = "lifi";
process.env.LIFI_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LIFI_TIMEOUT_MS = "1500";
process.env.LIQUIDITY_INDICATIVE_TTL_MS = "400";
process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
process.env.ALLOW_FIXED_RATES = "1";
process.env.DEX_MAX_MID_DEVIATION_BPS = "300";

const { addrs } = await import("../services/api/src/chain.js");
const EURE = addrs().eure;
const USDC = addrs().usdc;
/** Deliberately NOT tx.to — the whole point of the approvalAddress check. */
const APPROVAL = "0x4444444444444444444444444444444444444444";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

type Mode = "ok" | "500" | "wrongtoken" | "notx" | "noapproval" | "hang" | "skewed" | "noamounts";
let mode: Mode = "ok";
let lastQuery: URLSearchParams | null = null;
const asked = () => lastQuery as URLSearchParams | null;

function quoteBody(rate: number, toToken: string) {
  const out = BigInt(Math.round(100 * rate * 1e6));
  return {
    tool: "nordstern",
    toolDetails: { name: "Nordstern Finance" },
    action: { fromToken: { address: EURE, decimals: 18 }, toToken: { address: toToken, decimals: 6 } },
    estimate: {
      tool: "nordstern",
      approvalAddress: APPROVAL,
      fromAmount: (100n * 10n ** 18n).toString(),
      toAmount: out.toString(),
      toAmountMin: ((out * 995n) / 1000n).toString(),
      executionDuration: 0,
    },
    transactionRequest: { to: DIAMOND, data: "0xdeadbeef", value: "0x0", gasLimit: "0x2625a0" },
  };
}

const server: Server = createServer(async (req, res) => {
  lastQuery = new URL(req.url ?? "", `http://127.0.0.1:${PORT}`).searchParams;
  if (mode === "hang") return; // never responds; the timeout must fire
  if (mode === "500") {
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ message: "internal" }));
  }
  const body: any = quoteBody(mode === "skewed" ? 1.1379 * 1.06 : 1.1379, mode === "wrongtoken" ? EURE : USDC);
  if (mode === "notx") delete body.transactionRequest;
  if (mode === "noapproval") delete body.estimate.approvalAddress;
  if (mode === "noamounts") { delete body.estimate.toAmount; delete body.estimate.toAmountMin; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

const { liquidityProvider } = await import("../services/api/src/liquidity.js");
const p = liquidityProvider();
const soon = () => new Date(Date.now() + 60_000).toISOString();
const ONE_HUNDRED = 100n * 10n ** 18n;

let n = 0;
const ok = (label: string) => console.log(`${++n}. ${label}`);
async function refuses(label: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    throw new Error(`EXPECTED REFUSAL: ${label}`);
  } catch (e: any) {
    if (/^EXPECTED REFUSAL/.test(e.message)) throw e;
    assert.match(e.message, match, `${label}: wrong reason — ${e.message}`);
    ok(`${label} — refused: ${e.message.slice(0, 74)}…`);
  }
}

try {
  // --- the happy path, and what it must carry ------------------------------
  {
    mode = "ok";
    const q = await p.quote("EURE_TO_USDC", ONE_HUNDRED, "q1", soon());
    assert.equal(q.provider, "lifi");
    assert.equal(q.expectedOut, 113_790_000n);
    ok(`a maker quote is taken at the maker's number (100 EURe -> ${Number(q.expectedOut) / 1e6} USDC)`);

    assert.equal(q.rate, 1_137_900n);
    ok("the 18dp/6dp gap is carried into a 6dp rate correctly");

    assert.ok(q.minOut < q.expectedOut && q.minOut > 0n);
    ok(`the maker's own slippage floor is preserved as minOut (${Number(q.minOut) / 1e6})`);

    assert.equal(q.lifi?.approvalAddress, APPROVAL);
    assert.notEqual(q.lifi?.approvalAddress.toLowerCase(), q.lifi?.tx.to.toLowerCase());
    ok("approval target is the one NAMED, not tx.to — the Bebop bug, kept fixed");

    assert.equal(q.lifi?.tx.to, DIAMOND);
    assert.ok(q.lifi?.tx.data);
    ok("the executable transaction is pinned onto the quote, so execute cannot re-quote");

    assert.equal(asked()?.get("fromToken"), EURE);
    assert.equal(asked()?.get("slippage"), "0.005");
    ok("the request asks for the tokens and slippage we configured");
  }

  // --- every way the aggregator's answer can be wrong ----------------------
  mode = "500";
  await refuses("an erroring aggregator", () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()), /refused to quote \(500\)/);

  mode = "wrongtoken";
  await refuses(
    "a quote priced in a token we did not ask for",
    () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()),
    /priced .* but we asked for/,
  );

  mode = "notx";
  await refuses("a quote with no executable transaction", () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()), /no executable transaction/);

  mode = "noapproval";
  await refuses("a quote naming no approval target", () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()), /names no approval target/);

  mode = "noamounts";
  await refuses("a quote with no amounts", () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()), /no amounts/);

  mode = "skewed";
  await refuses(
    "a route priced 6% off the independent mid",
    () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()),
    /deviates \d+bps from the live mid/,
  );

  mode = "hang";
  await refuses("an aggregator that never answers", () => p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon()), /unreachable/);

  // --- refusals before any chain call --------------------------------------
  mode = "ok";
  await refuses("a zero-amount quote", () => p.quote("EURE_TO_USDC", 0n, "q", soon()), /positive amount/);

  {
    const q = await p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", new Date(Date.now() - 1000).toISOString());
    await refuses("an expired quote at execution", () => p.execute(q), /expired/);
  }
  {
    const q = await p.quote("EURE_TO_USDC", ONE_HUNDRED, "q", soon());
    delete q.lifi;
    await refuses("a quote with no pinned route", () => p.execute(q), /refusing to re-quote at execution/);
  }

  console.log(`\nLI.FI TEST PASSED — ${n}/${n}: aggregated routes are bound, checked against an independent mid, and refused when wrong`);
  console.log("NOT covered here: a real swap. LI.FI returns no quotes on any testnet, so this can only run for real on a mainnet.");
} finally {
  server.close();
}
