/**
 * Two conversions of one deposit at once book it once.
 *
 * The same signed conversion is submitted twice in parallel, as a double tap or
 * a retrying client would. The route claims the deposit before its first await
 * (it takes the prepared execution and marks the deposit converting), so the
 * second call is refused and the deposit records one swap and one credit.
 * Without both claims, both calls verify the passkey and submit; then only the
 * sign counter stands between them, and a synced passkey that always reports
 * 0 does not advance it.
 *
 * Offline: the router runs in-process, the Safe operation is the hardhat
 * harness stand-in, the venue plan is stubbed, and a stub JSON-RPC answers
 * balanceOf. Needs deployments.json for chain 31337, which `npm run check`
 * has written by the time this suite runs.
 *
 * Run: npm run convert:race:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

// Every EURe read is higher than the last, so a balance delta is always a
// delivery; USDC always covers the deposit.
let eureReads = 0n;
let usdcAddress = "";
const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const calls = [JSON.parse(body)].flat();
    const out = calls.map((c: any) => {
      if (c.method === "eth_chainId") return { jsonrpc: "2.0", id: c.id, result: "0x7a69" };
      if (c.method !== "eth_call") return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: c.method } };
      const usdc = String(c.params[0].to).toLowerCase() === usdcAddress;
      const value = usdc ? 1_000n * 10n ** 6n : ++eureReads * 100n * 10n ** 18n;
      return { jsonrpc: "2.0", id: c.id, result: "0x" + value.toString(16).padStart(64, "0") };
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
  });
});
rpc.listen(0, "127.0.0.1");
await new Promise<void>((r) => rpc.once("listening", () => r()));
process.env.TRANSF_RPC_URL = `http://127.0.0.1:${(rpc.address() as any).port}`;
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-convert-race-")), "db.json");
process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1379, KES: 147.53, INR: 109.87 });
process.env.ALLOW_FIXED_RATES = "1";

const { store, initStore } = await import("../services/api/src/store.js");
const { addrs } = await import("../services/api/src/chain.js");
const { createCryptoDepositRouter } = await import("../services/api/src/routes/crypto-deposits.js");
const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");

initStore();
usdcAddress = addrs().usdc.toLowerCase();

// The venue: a fixed plan at the pinned mid. FxSwapper has no Safe plan of its
// own; this one only has to price the swap the harness then "executes".
(FxSwapperLiquidityProvider.prototype as any).safeSwapPlan = async (
  side: string, amountIn: bigint, quoteId: string, expiresAt: string,
) => ({
  quote: { provider: "fx-swapper", side, quoteId, expiresAt, amountIn, rate: 1_137_900n, expectedOut: 400n * 10n ** 18n, minOut: 1n },
  approval: { token: addrs().usdc, spender: "0x000000000000000000000000000000000000dEaD", amount: amountIn },
  call: { to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 0n },
});

const ORIGIN = "http://localhost:3000";
const passkey = await makeSoftwarePasskey("race", ORIGIN);
const SAFE = "0x1111111111111111111111111111111111111111";
const hex = (b64: string) => "0x" + Buffer.from(b64, "base64url").toString("hex");
const now = new Date().toISOString();
store.addUser({
  id: "u-race", name: "Race GmbH", country: "DE", kycStatus: "approved", address: SAFE,
  wallet: { type: "candide-safe", deployed: true },
  passkey: { credentialId: passkey.credentialId, publicKey: { alg: "ES256", jwk: passkey.jwk }, signCount: 0, rpId: "localhost" },
  // Imported: the Safe is not derived from this key, so no address check.
  passkeySafe: {
    status: "active", address: SAFE, threshold: 1, importedAt: now,
    passkeyPublicKey: { x: hex(passkey.jwk.x!), y: hex(passkey.jwk.y!) },
  },
  paymentPage: { handle: "race", autoConvert: false, settlementAsset: "EURE" },
  createdAt: now,
} as any);
store.addCryptoDeposit({
  id: "d-race", userId: "u-race", chainId: 31337, token: "USDC",
  txHash: "0x" + "ab".repeat(32), logIndex: 0, amountUnits: "500000000", amountUsdc: 500,
  holding: "held", settlementAsset: "USDC", creditedUsdc: 500, settledAt: now, txs: [],
  detectedAt: now, updatedAt: now,
} as any);

const app = express();
app.use(express.json());
app.use("/api", createCryptoDepositRouter({ requireUserSession: () => ({ id: "s" }) }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/users/u-race/crypto-deposits/d-race`;
const post = async (p: string, body: unknown = {}) => {
  const res = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

let failed = false;
try {
  const prep = await post("/convert/prepare");
  assert.equal(prep.status, 200, `prepare: ${JSON.stringify(prep.data)}`);
  const executionAssertion = await passkey.assert(prep.data.challenge);

  const both = await Promise.all([post("/convert", { executionAssertion }), post("/convert", { executionAssertion })]);
  const statuses = both.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], `two parallel conversions answered ${JSON.stringify(both)}`);

  const d = store.cryptoDeposits.find((x) => x.id === "d-race")!;
  const swaps = d.txs.filter((t) => t.step === "safe.swap(usdc->eure)");
  assert.equal(swaps.length, 1, `the deposit records ${swaps.length} swaps`);
  assert.equal(d.holding, "converted");
  const won = both.find((r) => r.status === 200)!.data.deposit;
  assert.equal(d.creditedEur, won.creditedEur, "credited once: the one measured delivery");
  console.log("  ok  the same signed conversion submitted twice at once converts and credits once");

  const again = await post("/convert", { executionAssertion });
  assert.equal(again.status, 409, "a third submit after both finished finds nothing prepared");
  console.log("  ok  a later replay of the same signature finds nothing prepared");
} catch (err: any) {
  failed = true;
  console.error(`  FAIL ${err?.message ?? err}`);
} finally {
  server.close();
  rpc.close();
}
if (failed) process.exit(1);
console.log("convert-race: 2/2 checks passed");
