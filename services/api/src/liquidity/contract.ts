/**
 * The contract every liquidity venue shares: the quote shape, the execution
 * shape, and two safety rules.
 *
 * Approve the spender the venue names. Venue calldata runs with the
 * orchestrator's key or, in a batch, the user's passkey, so the API's answer
 * is a transaction we sign. LI.FI and Bebop return the approval spender
 * separately from the call target. They are the same contract today, but
 * approving the target would break with no error once routing moves to a
 * settlement contract or Permit2.
 *
 * Measure and attribute surplus. The receipt reports margin between the live
 * mid and what we deliver; unrecorded positive slippage would make that number
 * understate what we take.
 */
import { ENTRYPOINT_V9 } from "abstractionkit";
import { decodeEventLog } from "viem";
import { LIQUIDITY } from "../config.js";
import {
  abis,
  addrs,
  publicClient,
  } from "../chain.js";
import type { Transfer } from "../store.js";
/**
 * A venue's calldata is executed with the orchestrator's key or, in a batch,
 * the user's passkey. Whatever the API answered is therefore a transaction we
 * are about to sign: the target and the approval spender must be contracts we
 * named in config, and a token swap carries no native value.
 */
export function assertVenueTarget(
  venue: string,
  allowed: string[],
  to: string | undefined,
  spender: string | undefined,
  value: unknown,
): void {
  const ok = (addr?: string) => !!addr && allowed.includes(addr.toLowerCase());
  if (!allowed.length) {
    throw new Error(`${venue}: no settlement contracts are configured, so its calldata cannot be executed — refusing`);
  }
  if (!ok(to)) throw new Error(`${venue} named ${to} as the call target, which is not a configured ${venue} contract — refusing`);
  if (!ok(spender)) throw new Error(`${venue} asked for an approval to ${spender}, which is not a configured ${venue} contract — refusing`);
  if (value !== undefined && value !== null && value !== "" && BigInt(String(value)) !== 0n) {
    throw new Error(`${venue} calldata carries native value on a token swap — refusing`);
  }
}

export const MAX_SLIPPAGE_BPS = 30n;

/**
 * Refuse a venue's floor that sits further below its own expected output than
 * our slippage tolerance. LI.FI and an RFQ maker send minOut themselves, and
 * it is the amountOutMinimum the user signs: a floor at 0 would let the swap
 * settle at any price while the quote shows a good one. One unit of slack
 * absorbs a venue that rounds the floor down where we round toward it.
 */
export function assertMinOutBound(venue: string, expectedOut: bigint, minOut: bigint, maxSlippageBps: bigint): void {
  if (expectedOut <= 0n) throw new Error(`${venue} quoted no output — refusing`);
  const floor = (expectedOut * (10_000n - maxSlippageBps)) / 10_000n;
  if (minOut + 1n < floor) {
    throw new Error(
      `${venue} set a minimum output of ${minOut} against an expected ${expectedOut}, below our ${maxSlippageBps} bps slippage floor ${floor} — refusing`,
    );
  }
  if (minOut > expectedOut) {
    throw new Error(`${venue} set a minimum output of ${minOut} above its expected ${expectedOut} — refusing`);
  }
}

/** The pair a third-party venue is asked to trade. */
export interface VenueTokens {
  eure: `0x${string}`;
  usdc: `0x${string}`;
}
/** deployments.json for TRANSF_CHAIN_ID, read at call time, never at import. */
export const defaultTokens = (): VenueTokens => addrs();

export type LiquiditySide = "EURE_TO_USDC" | "USDC_TO_EURE";
export type LiquidityToken = "EURe" | "USDC";
export type LiquidityProviderId = "fx-swapper" | "rfq" | "cow" | "dex" | "lifi" | "best";

export interface LiquidityQuote {
  provider: LiquidityProviderId;
  side: LiquiditySide;
  quoteId: string;
  tokenIn: LiquidityToken;
  tokenOut: LiquidityToken;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  rate: bigint;
  expiresAt: string;
  /** RFQ only: the maker's quote id, the tx it wants submitted, and the
   *  address that must be approved to pull the sell token. */
  rfq?: {
    quoteId: string;
    tx: { to?: string; data?: string; value?: string } | null;
    approvalTarget?: string;
  };
  /** CoW only: the order the solvers will fill. */
  cow?: { orderId: string; feeAmount: string; validTo: number; appData: string };
  /** DEX only: the exact pool the quote was taken from, plus the independent
   *  mid it was checked against. execute() must reuse this pool — re-picking
   *  at execution could route through a different, unchecked one. */
  dex?: { pool: `0x${string}`; fee: number; mid: number; deviationBps: number };
  /** Best-execution only: what each venue offered, so the choice is auditable
   *  after the fact rather than a number that appeared from nowhere. */
  routing?: { venue: string; expectedOut: string | null; error?: string }[];
  /** Exact-output only: what the pool quoted as the input, and the ceiling
   *  the user signs. `amountIn` above IS the ceiling; the real input is
   *  measured after the swap. */
  exactOutput?: { quotedIn: bigint; amountInMaximum: bigint };
  /** LI.FI only: the route it priced and the tx it wants submitted. Held on
   *  the quote because prepare and execute are separate steps — re-quoting at
   *  execution would settle at a price the user never saw. */
  lifi?: {
    tool: string;
    approvalAddress: `0x${string}`;
    tx: { to: `0x${string}`; data: `0x${string}`; value?: string; gasLimit?: string };
    toToken: `0x${string}`;
    mid: number;
    deviationBps: number;
  };
}

export interface LiquidityExecution {
  quote: LiquidityQuote;
  txs: Transfer["txs"];
  amountOut: bigint;
  /**
   * Positive slippage: what arrived beyond the quote. Measured, and recorded
   * whoever keeps it, so it cannot pass as undisclosed margin.
   */
  surplus?: { amount: string; keptBy: "user" | "treasury" };
}

/**
 * A swap executed by the user's Safe: who runs the calldata and where the
 * output token goes. Venues that bind the taker into their quote (RFQ makers,
 * LI.FI routes) must be quoted with this context. Re-targeting their calldata
 * afterwards gives a transaction the venue will refuse or misdeliver.
 */
export interface SafeSwapContext {
  executor: `0x${string}`;
  recipient: `0x${string}`;
}

/**
 * Everything a user-signed batch needs from the venue: the price being signed,
 * the approval the venue names (spender is the venue's own answer, never
 * assumed equal to call.to — the Bebop/LI.FI approvalTarget trap), and the
 * executable call. The caller composes [approve, call] into the UserOperation.
 */
export interface SafeSwapPlan {
  quote: LiquidityQuote;
  approval: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  call: { to: `0x${string}`; data: `0x${string}`; value: bigint };
}

export interface LiquidityProvider {
  quote(side: LiquiditySide, amountIn: bigint, quoteId: string, expiresAt: string): Promise<LiquidityQuote>;
  execute(quote: LiquidityQuote, to?: `0x${string}`): Promise<LiquidityExecution>;
  /**
   * Build a swap the user's Safe can execute itself — the venue-specific half
   * of Change 2 windows 1-3. OPTIONAL because not every venue can serve an
   * arbitrary executor: FxSwapper is onlyTrader (our own permissioned
   * inventory — when we are the counterparty the custody question is a
   * counterparty question, not a window to close), and CoW does not execute
   * here at all. A venue without this method makes the transfer fall back to
   * the plain user-signed debit with the orchestrator swapping after.
   */
  safeSwapPlan?(
    side: LiquiditySide,
    amountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan>;
  /**
   * An EXACT-OUTPUT swap the user's Safe executes: deliver exactly `amountOut`
   * of tokenOut to the recipient, spending at most `maxAmountIn`, and leave
   * the unspent input in the Safe. This is what lets a crypto-paid invoice
   * land as exactly the invoice amount in EURe, with the leftover swept once
   * a month instead of appearing as a stray figure on every payment.
   *
   * OPTIONAL and honest: only a venue whose contract takes an output amount
   * can offer it. Uniswap's router does. An aggregator's "reverse quote"
   * (LI.FI /quote/toAmount) sizes the INPUT so the expected output lands near
   * the target, but still executes exact-input with a minimum — the leftover
   * would land on the output side. That is not this method, so LI.FI does not
   * implement it and the caller fails closed.
   */
  safeExactOutputPlan?(
    side: LiquiditySide,
    amountOut: bigint,
    maxAmountIn: bigint,
    quoteId: string,
    expiresAt: string,
    ctx: SafeSwapContext,
  ): Promise<SafeSwapPlan>;
  /**
   * A cheap, display-only EUR->USD rate for building a receipt, as a float and
   * in the swapper's 6dp integer form.
   *
   * Separate from quote(), which is firm, per-amount and short-lived; with a
   * real market maker it uses rate limit and may be a commitment. Don't
   * replace this with a constant: the receipt would show a price nobody honours.
   */
  indicativeRate(side: LiquiditySide): Promise<{ rate: number; raw: bigint }>;
}

/**
 * Read a balance until it reflects a write we know happened (bounded).
 *
 * Same replica-lag disease as waitForAllowanceVisibility, on the read side:
 * the compensation reverse swap DELIVERED (Safe went 40 -> 44.01 EURe on
 * chain) and its own verification then read a stale replica, saw no delta,
 * and declared the delivery missing. Returns the last read either way — the
 * caller still decides what a zero delta means. `atLeast` is the balance the
 * write is known to have produced, when the caller knows it from the logs.
 */
export async function balanceAfterWrite(
  token: `0x${string}`,
  who: `0x${string}`,
  before: bigint,
  atLeast = before + 1n,
): Promise<bigint> {
  let last = before;
  for (let i = 0; i < 12; i++) {
    last = (await publicClient.readContract({
      address: token,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [who],
    })) as bigint;
    if (last >= atLeast) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/**
 * Wait until a fresh read shows the allowance the approve just set.
 *
 * The public RPC is load-balanced: the swap simulation can hit a replica that
 * has not seen the approve block, and the swap reverts
 * ERC20InsufficientAllowance although the allowance is on chain (a real €5
 * transfer auto-refunded this way). Bounded: a lagging replica catches up in a
 * block or two; a missing approve stays missing and the swap's revert says so.
 */
export async function waitForAllowanceVisibility(
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const current = (await publicClient.readContract({
      address: token,
      abi: abis.MockToken,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
    if (current >= amount) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}


/**
 * Measure positive slippage and apply the configured policy.
 *
 * Called by every venue after it reads the delivered amount. Surplus is
 * recorded whoever keeps it: under the default the user simply receives it,
 * and under "treasury" the amount is still written down, because a surplus
 * nobody can see is indistinguishable from an undisclosed margin.
 */
export function applySurplus(
  quote: LiquidityQuote,
  amountOut: bigint,
  /** Defaults to the configured policy. Passed explicitly only by tests, which
   *  cannot re-read config once the module is cached. */
  policy: "user" | "treasury" = LIQUIDITY.SURPLUS_POLICY,
): {
  amountOut: bigint;
  surplus?: LiquidityExecution["surplus"];
} {
  const raw = amountOut - quote.expectedOut;
  if (raw <= 0n) return { amountOut };
  if (policy === "treasury") {
    return { amountOut: quote.expectedOut, surplus: { amount: raw.toString(), keptBy: "treasury" } };
  }
  return { amountOut, surplus: { amount: raw.toString(), keptBy: "user" } };
}

/** The ERC-20 event, declared here rather than pulled from the mock's ABI —
 *  the real USDC emits the same signature and this path must not depend on our
 *  own token's artifact. */
export const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** The EntryPoint's BeforeExecution() and UserOperationEvent(bytes32,...).
 *  A bundle executes its userOps in order after BeforeExecution, and each
 *  op's logs end with its own UserOperationEvent. */
const BEFORE_EXECUTION_TOPIC = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const USER_OP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
/** The EntryPoint the Safe's userOps go through (UserOperationV9). */
const ENTRY_POINT = ENTRYPOINT_V9.toLowerCase();

/**
 * Transfer logs of one token in one transaction's receipt. When the
 * transaction is an EntryPoint bundle, only the logs of `userOpHash`'s own
 * execution count: another party's userOp in the same bundle may send the
 * same token to the same Safe. Undefined when there is no receipt to read, or
 * a userOp is named or present but that one's event is not in the receipt.
 */
export async function tokenTransfers(txHash: string | undefined, token: string, userOpHash: string | null | undefined) {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return undefined;
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  let logs = receipt.logs;
  // Markers count only from the EntryPoint itself: any contract in the bundle
  // can emit a log shaped like one. receipt.to may be a bundler's own contract.
  const marker = (i: number, topic: string) =>
    logs[i].address.toLowerCase() === ENTRY_POINT && logs[i].topics[0] === topic;
  const end = logs.findIndex((l, i) => marker(i, USER_OP_EVENT_TOPIC) && l.topics[1]?.toLowerCase() === userOpHash?.toLowerCase());
  if (end >= 0) {
    let start = end - 1;
    while (start >= 0 && !marker(start, USER_OP_EVENT_TOPIC) && !marker(start, BEFORE_EXECUTION_TOPIC)) start--;
    logs = logs.slice(start + 1, end);
  } else if (userOpHash || logs.some((_, i) => marker(i, USER_OP_EVENT_TOPIC))) {
    // A userOp whose own event is not in this receipt: nothing here is its.
    return undefined;
  }
  const transfers: { from: string; to: string; value: bigint; logIndex: number }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.topics[0] !== TRANSFER_TOPIC) continue;
    const { args } = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    transfers.push({ from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value, logIndex: Number(log.logIndex) });
  }
  return transfers;
}

/**
 * What one transaction delivered of `token` to `to`, summed from its own
 * Transfer logs (scoped to `userOpHash` in a bundle), with the log indexes.
 * A balance delta would also count anything else that reached `to` in the
 * same window; `to` moving the token to itself delivers nothing. Undefined
 * when there is no receipt to read: the caller must not guess.
 */
export async function deliveredFromReceipt(
  txHash: string | undefined,
  token: string,
  to: string,
  userOpHash?: string | null,
): Promise<{ wei: bigint; logIndexes: number[] } | undefined> {
  const r = to.toLowerCase();
  const transfers = (await tokenTransfers(txHash, token, userOpHash))?.filter((t) => t.to === r && t.from !== r);
  return transfers && { wei: transfers.reduce((n, t) => n + t.value, 0n), logIndexes: transfers.map((t) => t.logIndex) };
}
