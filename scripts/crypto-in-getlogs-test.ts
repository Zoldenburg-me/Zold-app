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

console.log(`\n${passed} passed, 0 failed`);
process.exit(0);
