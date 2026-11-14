/**
 * The crypto-in scanner reads EURe and USDC Transfer logs with ONE getLogs per
 * block window (adapters/crypto-deposits.ts scanCryptoDeposits).
 *
 * A provider that caps getLogs at a small range (Alchemy's free tier allows
 * 10 blocks) bills each call; two calls per window, one per token, doubled
 * the cost for the same logs. One call naming both token addresses returns
 * them all, and each log is still attributed to its own token.
 *
 * The chain client is stubbed: what is under test is the request shape and
 * the split by log.address, not a node.
 *
 * Run: npm run crypto-in-getlogs:test
 */
// Must be first: pins the chain before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

process.env.CRYPTO_IN_MAX_BLOCK_SPAN = "10";
process.env.CRYPTO_IN_CONFIRMATIONS = "0";
process.env.CRYPTO_IN_WINDOWS_PER_TICK = "3";

const { publicClient, addrs } = await import("../services/api/src/chain.js");
const { store } = await import("../services/api/src/store.js");
const { pollCryptoDepositsOnce } = await import("../services/api/src/adapters/crypto-deposits.js");

const userId = randomUUID();
const safe = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
store.addUser({
  id: userId,
  name: "Getlogs Test",
  country: "DE",
  address: safe,
  iban: "",
  kycStatus: "approved",
  createdAt: new Date().toISOString(),
} as any);

const HEAD = 1_000n;
const calls: any[] = [];
const transfer = (token: `0x${string}`, block: bigint, value: bigint, logIndex: number) => ({
  address: token,
  blockNumber: block,
  logIndex,
  transactionHash: `0x${block.toString(16).padStart(8, "0")}${String(logIndex).padStart(56, "0")}`,
  args: { from: `0x${"11".repeat(20)}`, to: safe, value },
});
const client = publicClient as any;
client.getBlockNumber = async () => HEAD;
client.getBlock = async () => ({ timestamp: 1_791_700_000n });
client.getLogs = async (q: any) => {
  calls.push(q);
  const asked = [q.address].flat().map((a: string) => a.toLowerCase());
  const logs = [
    transfer(addrs().eure, 995n, 5n * 10n ** 18n, 0),
    transfer(addrs().usdc, 996n, 1_000_000n, 1),
  ];
  return logs.filter((l) =>
    asked.includes(l.address.toLowerCase()) && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
};

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The first tick only places the cursor (a fresh install looks back a bounded
// window); put it just before the logs so the next tick reads one window.
await pollCryptoDepositsOnce();
store.setCryptoDepositCursor("31337:safe-funding-v1", 990n);
calls.length = 0;
await pollCryptoDepositsOnce();

await check("one getLogs per window, naming both tokens", () => {
  assert.equal(calls.length, 1, `expected 1 getLogs for blocks 991..1000, got ${calls.length}`);
  const asked = [calls[0].address].flat().map((a: string) => a.toLowerCase()).sort();
  assert.deepEqual(asked, [addrs().eure, addrs().usdc].map((a) => a.toLowerCase()).sort());
  assert.equal(calls[0].fromBlock, 991n);
  assert.equal(calls[0].toBlock, 1000n);
});

await check("each log is recorded under its own token, with its own amount", () => {
  const mine = store.cryptoDeposits.filter((d: any) => d.userId === userId);
  const byToken = Object.fromEntries(mine.map((d: any) => [d.token, d.amountUnits]));
  assert.deepEqual(Object.keys(byToken).sort(), ["EURE", "USDC"]);
  assert.equal(byToken.EURE, String(5n * 10n ** 18n));
  assert.equal(byToken.USDC, "1000000");
});

await check("a conversion's EURe output is not recorded as a deposit", async () => {
  const conv = `0x${"cd".repeat(32)}`;
  const usdcRow = store.cryptoDeposits.find((d: any) => d.userId === userId && d.token === "USDC")!;
  store.updateCryptoDeposit(usdcRow.id, { holding: "converted", creditedEur: 0.89, conversion: { txHash: conv } } as any);
  const before = store.cryptoDeposits.filter((d: any) => d.userId === userId).length;
  client.getBlockNumber = async () => HEAD + 10n;
  client.getLogs = async (q: any) => (q.fromBlock <= HEAD + 5n && q.toBlock >= HEAD + 5n
    ? [{ ...transfer(addrs().eure, HEAD + 5n, 89n * 10n ** 16n, 0), transactionHash: conv }]
    : []);
  await pollCryptoDepositsOnce();
  assert.equal(store.cryptoDeposits.filter((d: any) => d.userId === userId).length, before);
});

const { isLogRangeRefusal } = await import("../services/api/src/log-range.js");
const ALCHEMY_RANGE = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";
const ALCHEMY_CUPS = "Your app has exceeded its compute units per second capacity.";
const ALCHEMY_MONTHLY = "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";
let heads = 0;
const widths: bigint[] = [];
const width = (q: { fromBlock: bigint; toBlock: bigint }) => q.toBlock - q.fromBlock + 1n;

await check("Alchemy's range cap halves the window; its rate limits and quota do not", () => {
  assert.equal(isLogRangeRefusal(new Error(ALCHEMY_RANGE)), true);
  for (const m of [ALCHEMY_CUPS, ALCHEMY_MONTHLY, "rate limit exceeded", "HTTP request failed.\n\nStatus: 429"]) {
    assert.equal(isLogRangeRefusal(new Error(m)), false, m);
  }
});

await check("a rate-limited tick makes one getLogs and holds the cursor", async () => {
  store.setCryptoDepositCursor("31337:safe-funding-v1", 1_010n);
  client.getBlockNumber = async () => { heads++; return 1_030n; };
  client.getLogs = async (q: any) => { widths.push(width(q)); throw new Error(ALCHEMY_CUPS); };
  await assert.rejects(pollCryptoDepositsOnce(), /compute units/);
  assert.deepEqual(widths, [10n], "no halving on a rate limit");
  assert.equal(store.cryptoDepositCursor("31337:safe-funding-v1"), 1_010n);
});

await check("one head per tick, and full windows again once the limit lifts", async () => {
  heads = 0;
  widths.length = 0;
  client.getLogs = async (q: any) => { widths.push(width(q)); return []; };
  await pollCryptoDepositsOnce();
  assert.equal(heads, 1, "getBlockNumber once for two windows");
  assert.deepEqual(widths, [10n, 10n]);
  assert.equal(store.cryptoDepositCursor("31337:safe-funding-v1"), 1_030n);
});

await check("the width the RPC answered is reused, not re-learned every window", async () => {
  widths.length = 0;
  client.getBlockNumber = async () => 1_036n;
  client.getLogs = async (q: any) => {
    widths.push(width(q));
    if (width(q) > 4n) throw new Error(ALCHEMY_RANGE);
    return [];
  };
  await pollCryptoDepositsOnce();
  assert.deepEqual(widths, [6n, 5n, 2n, 2n, 2n]);
  widths.length = 0;
  client.getBlockNumber = async () => 1_040n;
  await pollCryptoDepositsOnce();
  assert.deepEqual(widths, [2n, 2n], "no refusals paid twice");
});

await check("a shrunk width grows back to maxBlockSpan once the RPC answers wide ranges again", async () => {
  widths.length = 0;
  client.getBlockNumber = async () => 1_200n;
  client.getLogs = async (q: any) => { widths.push(width(q)); return []; };
  for (let tick = 0; tick < 8 && !widths.includes(10n); tick++) await pollCryptoDepositsOnce();
  assert.ok(widths.includes(10n), `never grew back: ${widths.join(",")}`);
  assert.deepEqual([...widths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), widths, "never narrows while every call answers");
});

await check("caught up, a tick reads one window and the head once", async () => {
  for (let tick = 0; tick < 3; tick++) {
    const cursor = store.cryptoDepositCursor("31337:safe-funding-v1")!;
    heads = 0;
    widths.length = 0;
    client.getBlockNumber = async () => { heads++; return cursor + 7n; };
    await pollCryptoDepositsOnce();
    assert.equal(heads, 1);
    assert.deepEqual(widths, [7n]);
  }
});

console.log(`\n${passed} passed, 0 failed`);
process.exit(0);
