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
 * The swap lands in a bundle with another party's userOp that also pays the
 * Safe: the conversion credits only its own output, and the scanner books the
 * other payment once. The Safe's prior balance is an odd number of wei, so a
 * rounded "before" would never see the conversion through. Two real Base
 * Sepolia EntryPoint v0.9 receipts (scripts/fixtures) check the log-span
 * parsing against what a bundler actually produces.
 *
 * Offline: the router runs in-process, the Safe operation is the hardhat
 * harness stand-in, the venue plan is stubbed, and a stub JSON-RPC answers
 * balanceOf, the swap's receipt, the scanner's getLogs and block reads. Needs
 * deployments.json for chain 31337, which `npm run check` has written by the
 * time this suite runs.
 *
 * Run: npm run convert:race:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { makeSoftwarePasskey } from "./_software-passkey.js";

// The Safe holds an odd number of wei that rounds UP at six decimals; once the
// swap's receipt has been read, the bundle's 150 EURe have landed. USDC always
// covers the deposit.
const PRIOR_WEI = 5n * 10n ** 17n + 999_999_999_999n;
let swapped = false;
const fixtures: Record<string, any> = JSON.parse(readFileSync(new URL("./fixtures/entrypoint-v9-receipts.json", import.meta.url), "utf8"));
let usdcAddress = "";
let eureAddress = "";
const SAFE = "0x1111111111111111111111111111111111111111";
const ENTRY_POINT = "0x433709009b8330fda32311df1c2afa402ed8d009"; // ENTRYPOINT_V9
// The harness stand-in's userOp hash (wallet/candide.ts).
const OUR_OP = `0x${"0".repeat(63)}1`;
const OTHER_OP = `0x${"0".repeat(63)}2`;
const word = (v: string | bigint) => "0x" + (typeof v === "bigint" ? v.toString(16) : v.slice(2)).padStart(64, "0");
/**
 * The swap lands in a bundle with another party's userOp, which also sends
 * this Safe 50 EURe and forges our op's event. Only the 100 inside our own
 * op's logs is the swap's.
 */
const swapReceipt = (hash: string) => {
  const at = { blockHash: word("0x1"), blockNumber: "0x1", transactionHash: hash, transactionIndex: "0x0", removed: false };
  const eureIn = (eure: bigint) => ({
    address: eureAddress,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", word("0x0"), word(SAFE)],
    data: word(eure * 10n ** 18n),
  });
  const opEnd = (op: string) => ({
    address: ENTRY_POINT,
    topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", op, word(SAFE), word("0x0")],
    data: "0x",
  });
  const logs = [
    { address: ENTRY_POINT, topics: ["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"], data: "0x" },
    eureIn(50n), opEnd(OTHER_OP),
    // A co-tenant contract forging our op's event must not open a span.
    { ...opEnd(OUR_OP), address: `0x${"ee".repeat(20)}` },
    eureIn(100n), opEnd(OUR_OP),
  ];
  return {
    ...at, contractAddress: null, cumulativeGasUsed: "0x0", effectiveGasPrice: "0x0", from: SAFE, gasUsed: "0x0",
    // Sent through a bundler's own contract, so `to` is not the EntryPoint.
    logsBloom: "0x" + "0".repeat(512), status: "0x1", to: `0x${"b0".repeat(20)}`, type: "0x2",
    logs: logs.map((l, i) => ({ ...at, ...l, logIndex: "0x" + i.toString(16) })),
  };
};
const block = (n: string) => ({
  number: n, hash: word(n), parentHash: word("0x0"), timestamp: "0x6700000" + n.slice(-1), nonce: "0x0000000000000000",
  difficulty: "0x0", gasLimit: "0x0", gasUsed: "0x0", miner: word("0x0").slice(0, 42), extraData: "0x", size: "0x0",
  logsBloom: "0x" + "0".repeat(512), transactionsRoot: word("0x0"), stateRoot: word("0x0"), receiptsRoot: word("0x0"),
  sha3Uncles: word("0x0"), baseFeePerGas: "0x0", mixHash: word("0x0"), transactions: [], uncles: [],
});
const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const calls = [JSON.parse(body)].flat();
    const out = calls.map((c: any) => {
      if (c.method === "eth_chainId") return { jsonrpc: "2.0", id: c.id, result: "0x7a69" };
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
      if (c.method === "eth_getTransactionReceipt") {
        if (fixtures[c.params[0]]) return ok(fixtures[c.params[0]]);
        swapped = true;
        return ok(swapReceipt(c.params[0]));
      }
      if (c.method === "eth_blockNumber") return ok("0x10");
      if (c.method === "eth_getBlockByNumber") return ok(block(c.params[0]));
      // The scanner's window: the bundle's EURe logs into the Safe.
      if (c.method === "eth_getLogs") return ok(swapped ? swapReceipt(word("0x0")).logs.filter((l) => l.address === eureAddress) : []);
      if (c.method !== "eth_call") return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: c.method } };
      const usdc = String(c.params[0].to).toLowerCase() === usdcAddress;
      const value = usdc ? 1_000n * 10n ** 6n : PRIOR_WEI + (swapped ? 150n * 10n ** 18n : 0n);
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
const { eureSwappedOut, pollCryptoDepositsOnce, tokenTransfers } = await import("../services/api/src/adapters/crypto-deposits.js");

initStore();
usdcAddress = addrs().usdc.toLowerCase();
eureAddress = addrs().eure.toLowerCase();

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
  assert.equal(d.creditedEur, 100, "the credit is the swap's own logged output, not a co-tenant op's EURe");
  assert.deepEqual(d.txs.find((t) => t.step === "safe.swap(usdc->eure)")?.outputLogIndexes, [4], "the swap step names the one log it credited");
  assert.equal(d.conversion?.otherInflowWei, (50n * 10n ** 18n).toString(), "the co-tenant's 50 is recorded, not credited");
  assert.equal(await eureSwappedOut(word("0x9"), `0x${"0".repeat(63)}3`, SAFE), undefined, "a bundle without our op measures nothing");
  console.log("  ok  only the swap's own userOp's EURe is credited from a shared bundle, over an odd-wei prior balance");

  // The scanner then reads the same transaction: the other op's payment is
  // money in and booked once; the conversion's own output is not.
  store.setCryptoDepositCursor("31337:safe-funding-v1", 0n);
  await pollCryptoDepositsOnce();
  await pollCryptoDepositsOnce();
  const inflows = store.cryptoDeposits.filter((x) => x.userId === "u-race" && x.token === "EURE");
  assert.equal(inflows.length, 1, `the bundle's EURe is booked as ${JSON.stringify(inflows.map((x) => [x.logIndex, x.amountEur]))}`);
  assert.ok(inflows[0].logIndex === 1 && inflows[0].amountEur === 50, `the other op's 50 EURe is the deposit: ${JSON.stringify(inflows[0])}`);
  console.log("  ok  the scanner books the other op's payment in that bundle once, and not the conversion's output");

  // Real bundles (Base Sepolia, EntryPoint v0.9). A swap: the Safe sent WETH
  // and received USDC inside its own op.
  const swap = "0xae0bbe7a29cda4a2163c55aefc960095d0f79f228a8a3e48da2b0ad007d0d963";
  const swapOp = "0xdc31f84e81d4c0cce5b2c4e9aa0283bf970f4030c2f66da7da096fd9e3239c67";
  const sepoliaUsdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  const weth = "0x4200000000000000000000000000000000000006";
  const safe = "0xd825a6f8011b32c1da1c0ca42c9eb9460404b337";
  const out = await tokenTransfers(swap, sepoliaUsdc, swapOp);
  assert.deepEqual(out?.map((t) => [t.to, t.value, t.logIndex]), [[safe, 1_611_154n, 2]], "a real swap's output is its one USDC log");
  assert.deepEqual((await tokenTransfers(swap, weth, swapOp))?.map((t) => [t.from, t.value]), [[safe, 499_999_999_999_999n]]);
  assert.equal(await tokenTransfers(swap, sepoliaUsdc, `0x${"ab".repeat(32)}`), undefined, "another op's hash finds nothing in a real bundle");
  // An op that deploys its account: the EntryPoint's AccountDeployed carries
  // the same userOp hash before BeforeExecution, and opens no span.
  const deploy = "0x74d9345e8fd3dfe6c48069751f6fa5c9e093b88db068c9607522044c38131a01";
  const deployOp = "0x24ef9336ae3275714092c15b66a9050288165798debd83c7d70c21eae5c9fc86";
  assert.deepEqual((await tokenTransfers(deploy, weth, deployOp))?.map((t) => [t.from, t.value, t.logIndex]), [[safe, 1n, 5]]);
  console.log("  ok  real EntryPoint v0.9 receipts parse to the op's own transfers");

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
console.log("convert-race: 6/6 checks passed");
