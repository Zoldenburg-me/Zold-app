/**
 * Venue execute() settles from its own swap's Transfer logs, not a balance delta.
 *
 * The orchestrator's balance is shared: another operation's money can reach it
 * while a swap runs. Each venue (dex, rfq, lifi) runs its real execute() here
 * against a stubbed chain client whose swap delivers X to `to` in its receipt
 * while the balance also gains a co-inflow Y from some other transaction. The
 * settled amountOut must be X. A balance that rose by less than the receipt
 * says the token left `to` mid-swap, or the read is behind: that refuses.
 *
 * Offline: no node, no venue. What this cannot show is a real router's logs;
 * the stub emits one Transfer to `to`, as a direct swap does.
 *
 *   npm run venue-receipt:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import { BASE_SEPOLIA_TOKENS } from "./_base-sepolia-tokens.js";

const BEBOP = "0x3333333333333333333333333333333333333333";
const LIFI = "0x4444444444444444444444444444444444444444";
const VENUE = "0x5555555555555555555555555555555555555555";
process.env.BEBOP_CONTRACTS = BEBOP;
process.env.LIFI_CONTRACTS = LIFI;
process.env.DEX_ROUTER = VENUE;
process.env.LIQUIDITY_SURPLUS_POLICY = "user";

const chain = await import("../services/api/src/chain.js");
const { TRANSFER_EVENT, settleFromReceipt } = await import("../services/api/src/liquidity/contract.js");
const { DexLiquidityProvider } = await import("../services/api/src/liquidity/uniswap.js");
const { RfqLiquidityProvider } = await import("../services/api/src/liquidity/rfq.js");
const { LifiLiquidityProvider } = await import("../services/api/src/liquidity/lifi.js");
const { publicClient, orchestratorWallet, orchestratorAddress } = chain;
const { eure: EURE, usdc: USDC } = BASE_SEPOLIA_TOKENS;

// ── the stubbed chain: balances, receipts, and what the next swap does ───────
const balances = new Map<string, bigint>();
const key = (token: string, who: string) => `${token.toLowerCase()}:${who.toLowerCase()}`;
const receipts = new Map<string, any>();
let swap = { delivered: 0n, coInflow: 0n };
let seq = 0;

function transferLog(token: string, from: string, to: string, value: bigint, logIndex: number) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: "Transfer", args: { from, to } as any }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    logIndex,
  };
}
/** One mined transaction. A swap's receipt holds only its own delivery; the
 *  co-inflow is some other transaction's money arriving in the same window. */
function mine(isSwap: boolean): `0x${string}` {
  const hash = keccak256(toHex(`tx-${++seq}`));
  const logs: any[] = [];
  if (isSwap) {
    const k = key(USDC, orchestratorAddress);
    balances.set(k, (balances.get(k) ?? 0n) + swap.delivered + swap.coInflow);
    logs.push(transferLog(USDC, VENUE, orchestratorAddress, swap.delivered, 0));
  }
  receipts.set(hash, { status: "success", transactionHash: hash, logs });
  return hash;
}
const pc = publicClient as any;
const wallet = orchestratorWallet as any;
pc.readContract = async ({ address, functionName, args }: any) => {
  assert.equal(functionName, "balanceOf");
  return balances.get(key(address, args[0])) ?? 0n;
};
pc.simulateContract = async (args: any) => ({ request: args });
pc.waitForTransactionReceipt = async ({ hash }: any) => receipts.get(hash);
pc.getTransactionReceipt = async ({ hash }: any) => {
  const r = receipts.get(hash);
  if (!r) throw new Error(`no receipt for ${hash}`);
  return r;
};
wallet.writeContract = async (req: any) => mine(req.functionName !== "approve");
wallet.sendTransaction = async () => mine(true);

// ── one quote per venue, EURe -> USDC, 100 EURe for ~113.79 USDC ─────────────
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const base = {
  side: "EURE_TO_USDC" as const, tokenIn: "EURe" as const, tokenOut: "USDC" as const,
  amountIn: 100n * 10n ** 18n, expectedOut: 113_790_000n, minOut: 113_500_000n, rate: 1_137_900n,
};
const tokens = () => BASE_SEPOLIA_TOKENS;
const dex = new DexLiquidityProvider();
// The dex venue reads its tokens from deployments.json; name them here instead.
(dex as any).tokens = () => ({ tokenIn: EURE, tokenOut: USDC, inName: "EURe", outName: "USDC" });
const venues: [string, () => Promise<any>][] = [
  ["dex", () => dex.execute({
    ...base, provider: "dex", quoteId: "d", expiresAt: expiresAt(),
    dex: { pool: "0x0000000000000000000000000000000000000001", fee: 500, mid: 1.1379, deviationBps: 0 },
  } as any)],
  ["rfq", () => new RfqLiquidityProvider(tokens).execute({
    ...base, provider: "rfq", quoteId: "r", expiresAt: expiresAt(),
    rfq: { quoteId: "bebop-1", approvalTarget: BEBOP, tx: { to: BEBOP, data: "0x01", value: "0" } },
  } as any)],
  ["lifi", () => new LifiLiquidityProvider(tokens).execute({
    ...base, provider: "lifi", quoteId: "l", expiresAt: expiresAt(),
    lifi: { tool: "stub", approvalAddress: LIFI, tx: { to: LIFI, data: "0x01", value: "0" }, toToken: USDC, mid: 1.1379, deviationBps: 0 },
  } as any)],
];

let pass = 0;
for (const [name, execute] of venues) {
  swap = { delivered: 113_800_000n, coInflow: 25_000_000n };
  const got = await execute();
  assert.equal(
    got.amountOut, 113_800_000n,
    `${name}: settled ${got.amountOut}, but its swap delivered 113800000; the rest is another transaction's money`,
  );
  // rfq settles the maker's whole fill; the others split off what beat the quote.
  if (name !== "rfq") assert.equal(got.surplus?.amount, "10000", `${name}: surplus must come from the swap's own output`);
  console.log(`${++pass}. ${name}: a co-inflow during the swap is not settled as its output`);

  // The balance rose by less than the receipt shows: the token left `to` while
  // the swap ran, or the read is behind. Neither settles on a guess.
  swap = { delivered: 113_800_000n, coInflow: -1_000_000n };
  await assert.rejects(execute, /balance shows only/, `${name}: a short balance delta must refuse`);
  console.log(`${++pass}. ${name}: a balance delta short of the receipt refuses`);

  // A swap whose receipt delivers below the floor refuses, whatever else arrived.
  swap = { delivered: 100_000_000n, coInflow: 20_000_000n };
  await assert.rejects(execute, /below the quoted floor/, `${name}: an under-floor fill must refuse`);
  console.log(`${++pass}. ${name}: an under-floor fill refuses even when a co-inflow covers the gap`);
}

// No receipt to read (the Safe batch's bundle hash missing): nothing settles.
await assert.rejects(
  () => settleFromReceipt("Safe swap batch", undefined, USDC, orchestratorAddress, 0n),
  /no transaction receipt/,
);
console.log(`${++pass}. no receipt to read refuses rather than falling back to the balance delta`);

console.log(`\nVENUE RECEIPT TEST PASSED — ${pass}/${pass}: every venue settles from its own swap's Transfer logs`);
process.exit(0);
