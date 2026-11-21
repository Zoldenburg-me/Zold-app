/**
 * Venue execute() settles from its own swap's Transfer logs, not a balance delta.
 *
 * The orchestrator's balance is shared: another operation's money can reach it
 * while a swap runs. Each venue (dex, rfq, lifi, fx-swapper) runs its real execute() here
 * against a stubbed chain client whose swap delivers X to `to` in its receipt
 * while the balance also gains a co-inflow Y from some other transaction. The
 * settled amountOut must be X. A balance that rose by less than the receipt
 * says the token left `to` mid-swap, or the read is behind: that refuses, and
 * the refusal carries the swap's txs so the caller can put the landed swap on
 * record. A route that pays `to` in several Transfers (multi-hop, a fee split)
 * settles their sum.
 *
 * Offline: no node, no venue. What this cannot show is a real router's logs;
 * the stub emits the Transfers it is told to.
 *
 *   npm run venue-receipt:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import { BASE_SEPOLIA_TOKENS } from "./_base-sepolia-tokens.js";

const BEBOP = "0x3333333333333333333333333333333333333333";
const LIFI = "0x4444444444444444444444444444444444444444";
const VENUE = "0x5555555555555555555555555555555555555555";
process.env.BEBOP_CONTRACTS = BEBOP;
process.env.LIFI_CONTRACTS = LIFI;
process.env.DEX_ROUTER = VENUE;
process.env.LIQUIDITY_SURPLUS_POLICY = "user";
// The fx-swapper reads its addresses from deployments.json; there is no deploy
// here, so answer that one read.
const SWAPPER = "0x6666666666666666666666666666666666666666";
const realReadFileSync = fs.readFileSync;
fs.readFileSync = ((p: any, ...rest: any[]) =>
  String(p).endsWith("deployments.json")
    ? JSON.stringify({ swapper: SWAPPER, eure: BASE_SEPOLIA_TOKENS.eure, usdc: BASE_SEPOLIA_TOKENS.usdc })
    : (realReadFileSync as any)(p, ...rest)) as typeof fs.readFileSync;
syncBuiltinESMExports();

const chain = await import("../services/api/src/chain.js");
const { TRANSFER_EVENT, settleFromReceipt, SwapSettlementError } = await import("../services/api/src/liquidity/contract.js");
const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");
const { DexLiquidityProvider } = await import("../services/api/src/liquidity/uniswap.js");
const { RfqLiquidityProvider } = await import("../services/api/src/liquidity/rfq.js");
const { LifiLiquidityProvider } = await import("../services/api/src/liquidity/lifi.js");
const { publicClient, orchestratorWallet, orchestratorAddress } = chain;
const { eure: EURE, usdc: USDC } = BASE_SEPOLIA_TOKENS;

// ── the stubbed chain: balances, receipts, and what the next swap does ───────
const balances = new Map<string, bigint>();
const key = (token: string, who: string) => `${token.toLowerCase()}:${who.toLowerCase()}`;
const receipts = new Map<string, any>();
/** `delivered` arrives in one Transfer, or in `split` parts (several hops or a
 *  fee split paying `to`); `elsewhere` is a Transfer in the same receipt to
 *  someone else, which is not `to`'s output. */
let swap: { delivered: bigint; coInflow: bigint; split?: bigint[]; elsewhere?: bigint } = { delivered: 0n, coInflow: 0n };
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
    const parts = swap.split ?? [swap.delivered];
    assert.equal(parts.reduce((n, x) => n + x, 0n), swap.delivered, "the split must sum to the delivery");
    parts.forEach((v, i) => logs.push(transferLog(USDC, i ? BEBOP : VENUE, orchestratorAddress, v, logs.length)));
    if (swap.elsewhere) logs.push(transferLog(USDC, VENUE, LIFI, swap.elsewhere, logs.length));
  }
  receipts.set(hash, { status: "success", transactionHash: hash, logs });
  return hash;
}
const pc = publicClient as any;
const wallet = orchestratorWallet as any;
pc.readContract = async ({ address, functionName, args }: any) => {
  if (functionName === "allowance") return 2n ** 255n;
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
  ["fx-swapper", () => new FxSwapperLiquidityProvider().execute({
    ...base, provider: "fx-swapper", quoteId: "f", expiresAt: expiresAt(),
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
  // rfq and the swapper settle the whole fill; the others split off what beat the quote.
  if (name !== "rfq" && name !== "fx-swapper") assert.equal(got.surplus?.amount, "10000", `${name}: surplus must come from the swap's own output`);
  console.log(`${++pass}. ${name}: a co-inflow during the swap is not settled as its output`);

  // The balance rose by less than the receipt shows: the token left `to` while
  // the swap ran, or the read is behind. Neither settles on a guess.
  // The refusal carries the landed swap's txs: the caller records them.
  swap = { delivered: 113_800_000n, coInflow: -1_000_000n };
  const swapStep = `liquidity.${name}.eure-usdc`;
  const carriesSwap = (re: RegExp) => (err: any) => {
    assert.match(err.message, re);
    assert.ok(err instanceof SwapSettlementError, `${name}: a settlement refusal must be a SwapSettlementError`);
    const step = err.txs.find((x: any) => x.step === swapStep);
    assert.ok(step && /^0x[0-9a-f]{64}$/.test(step.hash), `${name}: the refusal must carry ${swapStep} with its hash`);
    return true;
  };
  await assert.rejects(execute, carriesSwap(/balance shows only/), `${name}: a short balance delta must refuse`);
  console.log(`${++pass}. ${name}: a balance delta short of the receipt refuses, carrying the swap's hash`);

  // Several Transfers to `to` in the swap's receipt are summed; one to someone
  // else in the same receipt is not `to`'s output.
  swap = { delivered: 113_800_000n, coInflow: 0n, split: [100_000_000n, 13_000_000n, 800_000n], elsewhere: 5_000_000n };
  const multi = await execute();
  assert.equal(multi.amountOut, 113_800_000n, `${name}: settled ${multi.amountOut}, not the sum of the Transfers to \`to\``);
  console.log(`${++pass}. ${name}: several Transfers to the recipient are summed, others in the receipt are not`);

  // A swap whose receipt delivers below the floor refuses, whatever else arrived.
  // The swapper has no floor of its own beyond the contract's minOut.
  if (name === "fx-swapper") continue;
  swap = { delivered: 100_000_000n, coInflow: 20_000_000n };
  await assert.rejects(execute, carriesSwap(/below the quoted floor/), `${name}: an under-floor fill must refuse`);
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
