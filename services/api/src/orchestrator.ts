/**
 * Transfer orchestrator — drives one remittance through its on-chain and
 * partner legs, recording every state and tx hash:
 *
 *   CREATED -> DEBITED -> SWAPPED -> BRIDGED -> PAYOUT_READY -> PAID
 *                                                (recipient collects cash)
 *
 * Every leg records its step before the next runs, and a debit already in
 * `txs` is refused, so a crash mid-flow cannot double-spend. Failures
 * auto-compensate: failAndCompensate refunds what is recoverable, and the
 * startup/5-minute sweep retries anything stranded (SEPA and the PAYOUT_*
 * anchor states have their own legs; see executeSepaTransfer/refreshPayout).
 *
 * NO MOCK LEGS. There is no dry-run Bridge, no local escrow, no simulated
 * pickup and no simulated SEPA payout: a rail is live or the transfer is
 * refused before anything leaves the user's Safe. (`safeSwap.mode` keeps a
 * "dry-run" literal only for rows written before the rail was closed.)
 */
import { BRIDGE, FX, railFeeEur } from "./config.js";
import { DEBIT_STEP, safeMovedEur } from "./transfers/safe-moved.js";
import { usdIsStaging } from "./usd-token.js";
import { MONERIUM_NOT_CONNECTED, moneriumLiveFor } from "./adapters/monerium-connection.js";
import { verifyTypedData } from "viem";
import { AnchorPaymentUncertainError } from "./stellar/anchor.js";
import { store, type Transfer, type TransferState, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { MoneriumApiError } from "./adapters/monerium-client.js";
import { paymentMemo } from "./sepa.js";
import { createBridgeTransfer, BridgeTransferError, type BridgeTransferPlan } from "./bridge/bridgexyz.js";
import {
  executeTransferLiquidity,
  liquidityAmountOutUnits,
  liquidityProvider,
  prepareTransferLiquidity,
  serializeExecution,
  balanceAfterWrite,
} from "./liquidity.js";
import {
  abis,
  addrs,
  destinationCommitment,
  eur,
  usd,
  orchestratorAddress,
  orchestratorWallet,
  paymentAuthorizationTypedData,
  publicClient,
  returnEureToSafe,
  transferIdHash,
  writeAndWait,
  type WriteHooks,
} from "./chain.js";
import {
  SafeOperationUncertainError,
  submitPasskeySafeOperationWithReceipt,
  type BrowserPasskeyAssertion,
  type PasskeySafeDeploymentPlan,
} from "./wallet/candide.js";
import { createCashPickupViaAnchor, fundAndRefreshAnchorPickup } from "./adapters/moneygram.js";
import { anchorModeEnabled, HARNESS } from "./config.js";
import { describeCause } from "./http/log-cause.js";

/**
 * The user's device signature over this payment's exact terms. The
 * backend cannot produce one — it can only relay a spend the device approved.
 */
export interface PaymentAuthorization {
  deadline: number;
  signature: `0x${string}`;
}

/**
 * The user-signed debit of one transfer: a UserOperation prepared at transfer
 * creation moving the exact amount out of the user's Safe, plus the passkey
 * assertion over its hash collected at send time. The orchestrator relays it;
 * it cannot author one.
 */
export interface SafeExecution {
  plan: PasskeySafeDeploymentPlan;
  userOperation: Parameters<typeof submitPasskeySafeOperationWithReceipt>[1];
  assertion: BrowserPasskeyAssertion;
  /**
   * Present when the operation is the full fee+approve+swap batch: the debit
   * and the swap land atomically in one user-signed operation, with the output
   * delivered straight to `recipient`. The orchestrator then measures what
   * arrived there instead of executing a swap of its own.
   */
  batch?: { recipient: `0x${string}`; mode: "live" };
}

/**
 * Quote binding: verify the live on-chain swap rate hasn't drifted past tolerance from
 * the rate the quote assumed. Throws (→ compensation) if it has, so a
 * transfer never settles at economics the user didn't agree to.
 */
export async function assertQuoteRateBinding(transfer: Transfer): Promise<void> {
  const quote = store.findQuote(transfer.quoteId);
  if (!quote?.lockedSwapRate) return; // sepa quotes: nothing to bind
  const locked = BigInt(quote.lockedSwapRate);
  // Ask the provider that will actually fill the swap, not the FxSwapper
  // contract: a deployment pricing through a market maker must be checked
  // against a number something is going to trade at.
  const { raw: live } = await liquidityProvider().indicativeRate("EURE_TO_USDC");
  const driftBps = (live > locked ? live - locked : locked - live) * 10_000n / locked;
  if (driftBps > BigInt(FX.QUOTE_BINDING_BPS)) {
    throw new Error(
      `FX rate moved since quote (${driftBps} bps > ${FX.QUOTE_BINDING_BPS} bps cap) — request a new quote`,
    );
  }
}


export { DEBIT_STEP, safeMovedEur };

/** Did the input leg move the sender's money? True once any funding source has
 *  committed its debit, which is what makes a failure owe a refund. */
function inputFundsMoved(txs: Transfer["txs"]): boolean {
  return txs.some(
    (x) =>
      x.step === DEBIT_STEP.safe ||
      x.step === DEBIT_STEP.safeFee,
  );
}


/** EUR this user has committed to Safe-funded transfers today. FAILED/REFUNDED
 * transfers released their reservation. */
export function safeFundedEurToday(userId: string, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  // Transfers still being prepared hold their share of the cap before their
  // row exists — see store.holdDailyCap.
  return store.heldEurToday(userId, day) + store.transfers
    .filter(
      (t) =>
        t.userId === userId &&
        t.fundingSource === "safe" &&
        t.createdAt.slice(0, 10) === day &&
        !["FAILED", "REFUNDED"].includes(t.state),
    )
    .reduce((sum, t) => sum + t.sendEur, 0);
}

/** One daily budget over Safe-funded transfers. */
export async function dailyCapUsage(user: User): Promise<{
  capEur: number;
  usedEur: number;
  fromSafeEur: number;
}> {
  const fromSafeEur = safeFundedEurToday(user.id);
  return {
    capEur: FX.DAILY_CAP_EUR,
    usedEur: fromSafeEur,
    fromSafeEur,
  };
}

/**
 * Recompute the destination commitment from the payout this executor is
 * about to make. It is derived from the transfer's *current* recipient, not
 * from a value cached at signing time, so if the stored recipient was altered
 * after the device signed, the recomputed commitment no longer matches the
 * signature and the authorization check fails.
 */
function transferDestination(transfer: Transfer): `0x${string}` {
  return destinationCommitment(transfer.rail, {
    phone: transfer.recipientPhone,
    iban: transfer.recipientIban,
    name: transfer.recipientName,
  });
}

async function assertDeviceAuthorization(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<void> {
  if (!transfer.auth) throw new Error("transfer has no authorization terms");
  const amountWei = BigInt(transfer.auth.amountWei);
  if (amountWei !== eur.toWei(transfer.sendEur)) {
    throw new Error("stored amount no longer matches authorization terms");
  }
  if (auth.deadline !== transfer.auth.deadline) {
    throw new Error("submitted authorization deadline does not match transfer terms");
  }
  const destination = transferDestination(transfer);
  if (destination.toLowerCase() !== transfer.auth.destination.toLowerCase()) {
    throw new Error("stored payout destination no longer matches authorization terms");
  }
  if (Date.now() / 1000 > auth.deadline) throw new Error("authorization expired");
  const authorizer = user.authorizerAddress;
  if (!authorizer) throw new Error("no authorizer");
  const code = await publicClient.getBytecode({ address: authorizer });
  if (code && code !== "0x") {
    throw new Error("Safe-funded transfer needs on-chain policy for contract authorizers");
  }
  const ok = await verifyTypedData({
    address: authorizer,
    ...paymentAuthorizationTypedData({
      account: user.address,
      amountWei,
      to: transfer.auth.to,
      transferId: transferIdHash(transfer.id),
      destination,
      deadline: auth.deadline,
    }),
    signature: auth.signature,
  } as any);
  if (!ok) throw new Error("bad authorization");
}

async function debitInputFunds(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
  txs: Transfer["txs"],
  execution: SafeExecution | undefined,
): Promise<void> {
  await assertDeviceAuthorization(transfer, user, auth);
  if (transfer.txs.some((x) => x.step === DEBIT_STEP.safe)) {
    throw new Error("duplicate transfer: this transfer already moved EURe out of the Safe");
  }

  const moveHash = await submitSafeExecution(user, execution);
  txs.push({ step: DEBIT_STEP.safe, hash: moveHash });
  store.updateTransfer(transfer.id, { state: "DEBITED", txs });
}

/**
 * SEPA, Safe-funded: take only the fee.
 *
 * The payout itself is burned straight from the Safe by Monerium's redeem, so
 * moving the full amount to the orchestrator and forwarding it back would be a
 * round trip for nothing. Only the fee has to change hands.
 *
 * Consequence for recovery: less left the Safe than `sendEur`, so a failure
 * here owes the FEE back and not the whole transfer — see safeMovedEur.
 */
async function debitSafeFundedSepaFee(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
  payoutEur: number,
  txs: Transfer["txs"],
  execution: SafeExecution | undefined,
): Promise<void> {
  await assertDeviceAuthorization(transfer, user, auth);
  if (transfer.txs.some((x) => x.step === DEBIT_STEP.safeFee)) {
    throw new Error("duplicate transfer: this transfer already moved its fee out of the Safe");
  }
  const feeEur = Math.max(0, transfer.sendEur - payoutEur);
  if (feeEur > 0) {
    const feeHash = await submitSafeExecution(user, execution);
    txs.push({ step: DEBIT_STEP.safeFee, hash: feeHash });
  }
  store.updateTransfer(transfer.id, { state: "DEBITED", txs });
}

export function safeDebitBlocker(user: User): string | null {
  if (activePasskeySafe(user)) return null;
  return (
    "Safe-held funds need an active passkey Safe before transfers can be executed — " +
    "every debit is a UserOperation the passkey signs"
  );
}

function activePasskeySafe(user: User): boolean {
  return (
    user.passkeySafe?.status === "active" &&
    user.address.toLowerCase() === user.passkeySafe.address.toLowerCase()
  );
}

/** Can this account's send-time UserOperation actually be completed? A
 *  passkey Safe needs nothing but the user's assertion. */
function passkeySafeExecutionReady(user: User): boolean {
  return activePasskeySafe(user);
}

/**
 * The user-approved debit of one transfer: a UserOperation, prepared at
 * transfer creation for the exact token/amount/destination, whose hash the
 * user's passkey signed at send time. This process cannot produce that
 * signature — it can only relay it. No execution means no debit; there is no server-side fallback path.
 */
async function submitSafeExecution(user: User, execution: SafeExecution | undefined): Promise<string> {
  if (!passkeySafeExecutionReady(user)) {
    throw new Error(safeDebitBlocker(user) ?? "Safe debit is not configured for this account");
  }
  if (HARNESS.enabled) {
    return "0xmock-safe-execution-hash";
  }
  if (!execution) {
    throw new Error(
      "this transfer has no passkey-approved Safe execution — create the transfer again and approve it with your passkey",
    );
  }
  // A timeout after the bundler took the op throws SafeOperationUncertainError,
  // which failAndCompensate sends to review instead of refunding.
  const op = await submitPasskeySafeOperationWithReceipt(execution.plan, execution.userOperation, execution.assertion);
  // Included but reverted: the chain undid the call, so the debit never left
  // the Safe (gas did, unless sponsored). Throwing before the debit step is
  // recorded keeps the refund at zero.
  if (op.success === false) {
    throw new Error(`the Safe operation ${op.userOpHash} was included but reverted — the debit never left the Safe`);
  }
  return op.userOpHash ?? "0x";
}

function bridgeDestination(): { toAddress: string; blockchainMemo?: string } {
  if (!BRIDGE.destinationAddress) {
    throw new Error(
      "BRIDGE_DESTINATION_ADDRESS is required for the cash rail until MoneyGram anchor payment instructions are wired into Bridge",
    );
  }
  return {
    toAddress: BRIDGE.destinationAddress,
    ...(BRIDGE.destinationMemo ? { blockchainMemo: BRIDGE.destinationMemo } : {}),
  };
}

/** Both halves of the cash rail must be live: Bridge moves the USDC to
 *  Stellar, the anchor pays it out. Either missing means the rail is closed,
 *  and a closed rail refuses before anything is debited. */
/** Bridge only credits Circle's USDC, so the staging dollar (zUSD) keeps the rail shut. */
export const cashRailOpen = () => BRIDGE.live && anchorModeEnabled() && !usdIsStaging();

function recordBridgePlan(txs: Transfer["txs"], plan: BridgeTransferPlan) {
  txs.push({ step: `bridge.xyz.${plan.mode}.transfer`, hash: plan.transferId ?? plan.idempotencyKey });
  if (plan.sourceDepositInstructions?.to_address) {
    txs.push({ step: "bridge.xyz.deposit.address", hash: String(plan.sourceDepositInstructions.to_address) });
  }
  if (plan.sourceDepositInstructions?.blockchain_memo) {
    txs.push({ step: "bridge.xyz.deposit.memo", hash: String(plan.sourceDepositInstructions.blockchain_memo) });
  }
  if (plan.destinationTxHash) txs.push({ step: "bridge.xyz.destination_tx", hash: plan.destinationTxHash });
}

function cashPayoutState(pickup: NonNullable<Transfer["pickup"]>): TransferState {
  if (!pickup.anchorTransactionId) return "PAYOUT_READY";
  if (pickup.status === "PAID" || pickup.anchorStatus === "completed") return "PAID";
  if (pickup.anchorStatus === "pending_user_transfer_complete") return "PAYOUT_READY";
  if (pickup.anchorPaymentHash) return "PAYOUT_FUNDED";
  if (pickup.anchorStatus === "pending_user_transfer_start") return "PAYOUT_FUNDING_PENDING";
  return "PAYOUT_DETAILS_PENDING";
}

/**
 * Mark FAILED, then immediately attempt compensation. The refund the
 * user gets depends on how far the transfer got — costs already incurred
 * (conversion round-trips at the prevailing rate) are itemized on the refund.
 */
async function failAndCompensate(id: string, err: any, txs: Transfer["txs"]): Promise<Transfer> {
  const message = String(err?.shortMessage ?? err?.message ?? err);
  // An operator owns a transfer in review: a late failure adds its steps and
  // leaves the state and the reason for the review alone.
  if (store.findTransfer(id)?.state === "MANUAL_REVIEW") {
    console.error(`late failure on ${id}, which is in review: ${message}`);
    return store.updateTransfer(id, { txs });
  }
  // The debit was sent and may still land: whether money left the Safe is
  // unknown, so neither "nothing was debited" nor a refund is safe.
  if (err instanceof SafeOperationUncertainError) {
    console.error(`transfer ${id}: Safe operation ${err.userOpHash} unconfirmed:`, describeCause(err.cause));
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${message}; check the operation on chain before any refund`,
      txs: [...txs, { step: "safe.debit.unconfirmed", hash: err.userOpHash }],
    });
  }
  const failed = store.updateTransfer(id, {
    state: "FAILED",
    error: message,
    txs,
  });
  // Another submission of the same authorization got there first. A refund here
  // would hand back money whose payout may be in flight, so this is review-only.
  // The API claims an authorization before it can be submitted twice; this is
  // the backstop for any other route to the same duplicate.
  if (/duplicate transfer/i.test(message)) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${message}; this transfer was already debited once, so no automatic refund`,
      txs,
    });
  }
  if (txs.some((x) => FUNDS_AT_BRIDGE_STEPS.has(x.step))) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${failed.error}; funds already reached Bridge (deposit funded or destination paid), so automatic local refund is unsafe until Bridge/anchor state is reconciled`,
      txs,
    });
  }
  try {
    return await compensateTransfer(id);
  } catch (e: any) {
    console.error(`compensation failed for ${id}: ${describeCause(e)} — will retry on sweep`);
    return failed;
  }
}

/** Steps after which USDC is with Bridge and nothing local can be reversed:
 *  the plain deposit transfer as much as the batch delivery or the
 *  destination payment. */
const FUNDS_AT_BRIDGE_STEPS = new Set([
  "bridge.xyz.deposit.transfer",
  "bridge.xyz.deposit.funded",
  "bridge.xyz.destination_tx",
]);

/**
 * Steps written and persisted BEFORE an outbound call that may move money,
 * each with the steps that settle it. One left unsettled means the process
 * stopped (or the call failed) after the call may have gone out and before
 * its outcome was recorded, so the money may have moved: review, never refund.
 *
 * A chain write also settles on a definite failure: `.not-sent` (it threw
 * before any hash existed with an error proving the node refused it, see
 * writeDefinitelyRefused) and `.reverted`
 * (mined and reverted, with its hash). Nothing moved either way, so
 * compensation may retry. A reverted Bridge deposit is not in
 * FUNDS_AT_BRIDGE_STEPS: the USDC never left.
 */
const OUTBOUND_INTENT_STEPS = {
  "safe.refundTransfer.pending": [
    "safe.refundTransfer",
    "safe.refundTransfer.not-sent",
    "safe.refundTransfer.reverted",
  ],
  "monerium.redeem.pending": ["monerium.redeem.placed", "monerium.redeem.refused"],
  "bridge.xyz.deposit.pending": [
    "bridge.xyz.deposit.transfer",
    "bridge.xyz.deposit.not-sent",
    "bridge.xyz.deposit.reverted",
  ],
  // The orchestrator-run EURe -> USDC swap. A venue records its step only once
  // delivery is measured, so a swap that landed and then threw (a receipt
  // timeout, a stale balance read) leaves this unsettled.
  "liquidity.swap.pending": [
    "liquidity.fx-swapper.eure-usdc",
    "liquidity.rfq.eure-usdc",
    "liquidity.lifi.eure-usdc",
    "liquidity.dex.eure-usdc",
  ],
} satisfies Record<string, string[]>;
type OutboundIntent = keyof typeof OUTBOUND_INTENT_STEPS;

/** The first intent whose LAST occurrence has no settling step after it. A
 *  retry records a new intent, which an earlier attempt's outcome does not
 *  settle. */
function unsettledOutbound(txs: Transfer["txs"]): string | undefined {
  const steps = txs.map((x) => x.step);
  return (Object.keys(OUTBOUND_INTENT_STEPS) as OutboundIntent[]).find((intent) => {
    const at = steps.lastIndexOf(intent);
    if (at < 0) return false;
    const settling: string[] = OUTBOUND_INTENT_STEPS[intent];
    return !steps.slice(at + 1).some((s) => settling.includes(s));
  });
}

/** Record an outbound intent on the transfer before the call goes out. */
function recordOutboundIntent(id: string, txs: Transfer["txs"], step: OutboundIntent) {
  txs.push({ step, hash: "0x" });
  store.updateTransfer(id, { txs });
}

/** writeAndWait hooks for a chain write under an intent: record the intent
 *  before it is sent, and settle it on a definite not-sent or revert. */
function outboundWrite(
  id: string,
  txs: Transfer["txs"],
  intent: "safe.refundTransfer.pending" | "bridge.xyz.deposit.pending",
): WriteHooks {
  const base = intent.slice(0, -".pending".length);
  const settle = (step: string, hash: string) => {
    txs.push({ step, hash });
    store.updateTransfer(id, { txs });
  };
  return {
    beforeSend: () => recordOutboundIntent(id, txs, intent),
    onNotSent: () => settle(`${base}.not-sent`, "0x"),
    onReverted: (hash) => settle(`${base}.reverted`, hash),
  };
}

/** Transfers whose execute*() is running right now, so the stranded-transfer
 *  sweep does not refund a transfer whose live call is merely slow. */
const executing = new Set<string>();

/** Transfers being compensated right now. A refund is a chain write that
 *  lands before its step is recorded, so a second compensation started in
 *  that window would refund again. */
const compensating = new Set<string>();

/** Walk a failed transfer backwards: return recoverable EURe to the sender's
 * Safe. One compensation per transfer at a time: a call that finds one
 * running returns the transfer as it stands. */
export async function compensateTransfer(id: string): Promise<Transfer> {
  if (compensating.has(id)) {
    const t = store.findTransfer(id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    return t;
  }
  compensating.add(id);
  try {
    return await compensateTransferOnce(id);
  } finally {
    compensating.delete(id);
  }
}

/** Refund attempts that definitely failed (not-sent or reverted) before the
 *  refund is left for an operator instead of retried by the sweep. */
const MAX_REFUND_ATTEMPTS = 5;

async function compensateTransferOnce(id: string): Promise<Transfer> {
  const t = store.findTransfer(id);
  if (!t) throw new Error(`unknown transfer ${id}`);
  // An operator's resolution is the last word on a transfer that was in review.
  if (t.state === "REFUNDED" || t.state === "PAID" || t.state === "MANUAL_REVIEW" || t.refund || t.reviewResolution) {
    return t;
  }
  const user = store.findUser(t.userId);
  if (!user) throw new Error(`unknown user for transfer ${id}`);
  const steps = new Set(t.txs.map((x) => x.step));
  const now = () => new Date().toISOString();

  // A refund transaction already on record means the process stopped between
  // the chain write and the REFUNDED write. Refunding again would pay twice.
  if (steps.has("safe.refundTransfer")) {
    return store.updateTransfer(id, {
      state: "REFUNDED",
      refund: {
        amountEur: 0,
        recoveredFrom: "refund transaction already on record",
        deductions: "amount not recorded — the process stopped between the refund transaction and this record; see the safe.refundTransfer hash",
        at: now(),
      },
    });
  }
  const outbound = unsettledOutbound(t.txs);
  if (outbound) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error:
        `${t.error ?? "transfer failed"}; ${outbound} is on record without its outcome — the call may ` +
        `have moved money, so no automatic refund until it is checked`,
    });
  }
  // A refund that definitely failed may be retried, but not forever: one the
  // node refuses every time (an orchestrator with no gas, say) would add an
  // intent and its outcome on every sweep.
  const failedRefunds = t.txs.filter(
    (x) => x.step === "safe.refundTransfer.not-sent" || x.step === "safe.refundTransfer.reverted",
  ).length;
  if (failedRefunds >= MAX_REFUND_ATTEMPTS) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error:
        `${t.error ?? "transfer failed"}; ${failedRefunds} refund attempts were refused or reverted ` +
        `(nothing was sent), so the refund is left for an operator`,
    });
  }
  // USDC that reached Bridge is not ours to reverse, whichever leg put it there.
  if ([...steps].some((s) => FUNDS_AT_BRIDGE_STEPS.has(s))) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${t.error ?? "transfer failed"}; USDC already reached Bridge's deposit address, so nothing local can be refunded until Bridge/anchor state is reconciled`,
    });
  }

  if (!inputFundsMoved(t.txs)) {
    // Nothing moved — FAILED is the whole story.
    return store.updateTransfer(id, {
      refund: { amountEur: 0, recoveredFrom: "none", deductions: "nothing was debited", at: now() },
    });
  }

  const txs = t.txs;

  // Did a swap actually run? Every venue's step reads liquidity.<venue>.eure-usdc
  // ("swapper.swapExactIn" is the name older transfers in db.json carry). Match
  // every venue: a dex/rfq/lifi-swapped transfer that read as "still holding
  // EURe" would be refunded euros the orchestrator no longer holds.
  const swapRan = [...steps].some(
    (s) => s === "swapper.swapExactIn" || (s.startsWith("liquidity.") && s.endsWith(".eure-usdc")),
  );
  // A batched live send delivered its output straight to Bridge's deposit
  // address — this side holds nothing to reverse. Never guess at a custodian's
  // balance; reconcile it by hand.
  if (swapRan && t.safeSwap?.mode === "live") {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error:
        `${t.error ?? "transfer failed"}; the user-signed batch delivered USDC to Bridge deposit ` +
        `${t.safeSwap.recipient} — Bridge/anchor state must be reconciled before any refund`,
      txs,
    });
  }

  let refundEur: number;
  let recoveredFrom: string;
  let deductions = "none";
  const fee = railFeeEur(t.rail);
  if (!swapRan) {
    // Still holding the debited EURe in full.
    refundEur = t.sendEur;
    recoveredFrom = "debited EURe";
  } else {
    // Holding the fee remainder (EURe) + the swapped USDC. Convert using the
    // venue execution rate persisted with the liquidity plan, so refunds do not
    // accidentally read the local mock swapper's rate after a DEX/RFQ/LI.FI fill.
    const rate = await compensationRate(t);
    const eurBack = (t.usdcOut ?? 0) / (Number(rate) / 1e6);
    refundEur = Math.floor((fee + eurBack) * 100) / 100;
    // The swapped USDC sits with the orchestrator until Bridge takes it, and
    // that is the only place a refund can come from.
    recoveredFrom = "post-swap USDC";
    const lost = Math.max(0, t.sendEur - refundEur);
    if (lost > 0) deductions = `€${lost.toFixed(2)} conversion round-trip at execution rate`;
  }

  /**
   * A transfer refunds to the Safe.
   *
   * The euros came out of the user's own Safe, so that is the pot they go back
   * to. This also means the refund works off a local chain, because it hands
   * back the very tokens that moved instead of creating new ones.
   *
   * Only while they are still EURe, though. Once the input has been swapped to
   * USDC the orchestrator no longer holds what it took, and unwinding needs a
   * reverse swap and a decision about who wears the rate movement — so that
   * case goes to review rather than guessing.
   */
  if (t.fundingSource === "safe") {
    if (swapRan) {
      /**
       * Reverse the swap and give the euros back. The user bears the round
       * trip's rate movement as an itemized deduction: both legs at execution
       * prices, the received amount measured as a Safe balance delta. If the
       * reversal fails the transfer goes to MANUAL_REVIEW.
       */
      try {
        const provider = liquidityProvider();
        const usdcUnits = usd.toUnits(t.usdcOut ?? 0);
        if (usdcUnits <= 0n) throw new Error("no recorded USDC output to reverse");
        const rq = await provider.quote(
          "USDC_TO_EURE",
          usdcUnits,
          `${t.id}:refund`,
          new Date(Date.now() + 5 * 60_000).toISOString(),
        );
        const eureBalance = async () =>
          (await publicClient.readContract({
            address: addrs().eure,
            abi: abis.MockToken,
            functionName: "balanceOf",
            args: [user.address],
          })) as bigint;
        const before = await eureBalance();
        recordOutboundIntent(id, txs, "safe.refundTransfer.pending");
        const back = await provider.execute(rq, user.address as `0x${string}`);
        txs.push(...back.txs);
        const receivedWei =
          (await balanceAfterWrite(addrs().eure, user.address as `0x${string}`, before)) - before;
        if (receivedWei <= 0n) throw new Error("reverse swap delivered no EURe to the Safe");
        const eurBack = eur.fromWei(receivedWei);
        // The fee remainder never left EURe; hand it back too.
        const feeBack = Math.min(fee, Math.max(0, safeMovedEur(t) - eurBack));
        if (feeBack > 0) {
          const feeHash = await returnEureToSafe(user.address, feeBack);
          txs.push({ step: "safe.refundTransfer", hash: feeHash });
          store.updateTransfer(id, { txs }); // on record before anything else can fail
        }
        const total = Math.floor((eurBack + feeBack) * 100) / 100;
        const lost = Math.max(0, safeMovedEur(t) - total);
        console.log(
          `Compensation: reverse-swapped and returned €${total} to ${user.name}'s Safe for transfer ${t.id} (post-swap)`,
        );
        return store.updateTransfer(id, {
          state: "REFUNDED",
          txs,
          refund: {
            amountEur: total,
            recoveredFrom: "post-swap USDC, reverse-swapped",
            deductions: lost > 0 ? `€${lost.toFixed(2)} conversion round-trip at execution rates` : "none",
            at: now(),
          },
        });
      } catch (err: any) {
        return store.updateTransfer(id, {
          state: "MANUAL_REVIEW",
          error:
            `${t.error ?? "transfer failed"}; Safe-funded input was already swapped to USDC and the ` +
            `reverse swap did not complete (${describeCause(err)}) — needs review before ` +
            `€${refundEur} can be returned to ${user.address}`,
          txs,
        });
      }
    }
    // Refund what left the Safe, which on the SEPA rail is the fee alone.
    const movedEur = safeMovedEur(t);
    const safeRefundEur = Math.min(refundEur, movedEur);
    const safeDeductions =
      movedEur < t.sendEur
        ? `€${(t.sendEur - movedEur).toFixed(2)} never left the Safe (payout burns from it directly)`
        : deductions;
    const refundHash = await returnEureToSafe(
      user.address,
      safeRefundEur,
      outboundWrite(id, txs, "safe.refundTransfer.pending"),
    );
    txs.push({ step: "safe.refundTransfer", hash: refundHash });
    store.updateTransfer(id, { txs }); // on record before anything else can fail
    console.log(
      `Compensation: returned €${safeRefundEur} to ${user.name}'s Safe for transfer ${t.id} (Safe-funded)`,
    );
    return store.updateTransfer(id, {
      state: "REFUNDED",
      txs,
      refund: {
        amountEur: safeRefundEur,
        recoveredFrom: "Safe-funded EURe",
        deductions: safeDeductions,
        at: now(),
      },
    });
  }

  return store.updateTransfer(id, {
    state: "MANUAL_REVIEW",
    error:
      `${t.error ?? "transfer failed"}; ${recoveredFrom} needs a Safe-native treasury ` +
      `refund path before €${refundEur} can be returned`,
    txs,
  });
}

async function compensationRate(t: Transfer): Promise<bigint> {
  if (t.liquidity?.rate) {
    const rate = BigInt(t.liquidity.rate);
    if (rate > 0n) return rate;
  }
  const quote = store.findQuote(t.quoteId);
  if (quote?.lockedSwapRate) {
    const rate = BigInt(quote.lockedSwapRate);
    if (rate > 0n) return rate;
  }
  return (await liquidityProvider().indicativeRate("EURE_TO_USDC")).raw;
}

const STRANDED_MS = 10 * 60_000;

export type StrandedAction = "compensate" | "fail-and-compensate" | "review-outbound" | "review-unrecorded-debit";

/** What the sweep does with one transfer. `busy` says whether an execution or
 *  a compensation for it is running in this process; a running one is never
 *  stranded. MANUAL_REVIEW, like every state not named here, is left alone,
 *  and so is a transfer an operator resolved out of review. */
export function strandedAction(t: Transfer, now: number, busy: (id: string) => boolean): StrandedAction | null {
  if (busy(t.id) || t.reviewResolution) return null;
  if (t.state === "FAILED") return !t.refund && inputFundsMoved(t.txs) ? "compensate" : null;
  if (["DEBITED", "SWAPPED", "BRIDGED"].includes(t.state)) {
    if (now - Date.parse(t.updatedAt) <= STRANDED_MS) return null;
    return unsettledOutbound(t.txs) ? "review-outbound" : "fail-and-compensate";
  }
  if (t.state === "CREATED" && t.auth?.authorizedAt && now - Date.parse(t.auth.authorizedAt) > STRANDED_MS) {
    return "review-unrecorded-debit";
  }
  return null;
}

/** Recovery sweep: compensate FAILED transfers that moved money, and
 *  fail-then-compensate transfers stranded mid-flow (e.g. by a crash). */
export async function sweepStrandedTransfers(): Promise<number> {
  const busy = (id: string) => executing.has(id) || compensating.has(id);
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      const action = strandedAction(t, Date.now(), busy);
      if (action === "compensate") {
        await compensateTransfer(t.id);
        n++;
      } else if (action === "fail-and-compensate") {
        store.updateTransfer(t.id, { state: "FAILED", error: "stranded mid-flow — auto-compensating" });
        await compensateTransfer(t.id);
        n++;
      } else if (action === "review-outbound") {
        // A redeem order or a Bridge deposit went out (or was about to) before
        // the restart, and its outcome was never recorded.
        store.updateTransfer(t.id, {
          state: "MANUAL_REVIEW",
          error:
            `stranded mid-flow after ${unsettledOutbound(t.txs)} — the outbound call may have moved money; ` +
            "reconcile before any refund",
        });
        n++;
      } else if (action === "review-unrecorded-debit") {
        // Crash between submitting the user-signed UserOperation and
        // persisting DEBITED. The claim is consumed (/authorize now 409s) and
        // the operation may or may not have landed. A refund would pay twice
        // if it did, and CREATED would hide a possible debit, so an operator
        // checks the chain.
        store.updateTransfer(t.id, {
          state: "MANUAL_REVIEW",
          error:
            "authorization was claimed but no debit was recorded before a restart — " +
            "the user-signed operation may or may not have landed on chain; reconcile before any refund",
        });
        n++;
      }
    } catch (e: any) {
      console.error(`sweep: compensation failed for ${t.id}: ${describeCause(e)}`);
    }
  }
  return n;
}

/** Drive anchor-backed payouts that no browser is polling anymore. */
export async function sweepAnchorPayouts(): Promise<number> {
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      if (["PAYOUT_DETAILS_PENDING", "PAYOUT_FUNDING_PENDING", "PAYOUT_FUNDED"].includes(t.state)) {
        const before = t.updatedAt;
        const updated = await refreshPayout(t);
        if (updated.updatedAt !== before) n++;
      }
    } catch (e: any) {
      console.error(`sweep: anchor payout refresh failed for ${t.id}: ${describeCause(e)}`);
    }
  }
  return n;
}

export async function executeTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
  execution?: SafeExecution,
): Promise<Transfer> {
  const a = addrs();
  const txs = transfer.txs;
  executing.add(transfer.id);

  try {
    if (!cashRailOpen()) {
      throw new Error(
        "the cash rail is closed on this deployment (BRIDGE_LIVE and the payout anchor must both be configured) — nothing was debited",
      );
    }
    let expectedOut: bigint;
    let usdcOut: number;
    if (execution?.batch) {
      // 1+2 fused: the user-signed batch takes the fee, approves the venue and
      // swaps atomically, delivering straight to the batch recipient. The
      // orchestrator never holds the input: it refuses on staleness before
      // anything moves, then measures what arrived.
      // The expiry check is needed because the batch never calls the venue's
      // execute() (which refuses expired quotes), and the authorization window
      // (15 min) outlives the quote TTL (10 min).
      if (transfer.liquidity?.expiresAt && Date.now() > Date.parse(transfer.liquidity.expiresAt)) {
        throw new Error("liquidity quote expired before the batch was submitted — create the transfer again");
      }
      await assertQuoteRateBinding(transfer);
      const recipient = execution.batch.recipient;
      const usdcBalance = () =>
        publicClient.readContract({
          address: a.usdc,
          abi: abis.MockToken,
          functionName: "balanceOf",
          args: [recipient],
        }) as Promise<bigint>;
      const before = await usdcBalance();
      await debitInputFunds(transfer, user, auth, txs, execution);
      // The swap step is recorded WITH the debit, before any measurement: the
      // batch is atomic, so if the debit landed the swap landed. Recording it
      // only after a successful balance read would let a stale RPC replica
      // strand a swapped transfer looking unswapped — and compensation would
      // then "refund" EURe this side no longer holds.
      const opHash = txs.at(-1)?.hash ?? "0x";
      txs.push({ step: `liquidity.${transfer.liquidity?.provider ?? "safe"}.eure-usdc`, hash: opHash });
      store.updateTransfer(transfer.id, { txs });
      const delivered = (await balanceAfterWrite(a.usdc, recipient, before)) - before;
      const minOut = BigInt(transfer.liquidity?.minOut ?? "0");
      if (delivered < minOut) {
        // The venue enforces the floor, so this means a stale recipient read or
        // output delivered elsewhere. Don't settle a payout against money we
        // cannot see. The swap step recorded above makes compensation treat
        // this as post-swap.
        throw new Error(
          `Safe swap batch delivered ${delivered} to ${recipient}, below the signed floor ${minOut}`,
        );
      }
      // The live Bridge transfer was sized from the locked rate at creation;
      // the batch only guarantees the venue floor. An under-funded deposit
      // must not be recorded as funded and sent to the anchor.
      const bridgeUnits =
        transfer.safeSwap?.mode === "live" && transfer.safeSwap.bridgeAmountUsdc !== undefined
          ? usd.toUnits(transfer.safeSwap.bridgeAmountUsdc)
          : 0n;
      if (delivered < bridgeUnits) {
        throw new Error(
          `Safe swap batch delivered ${delivered} USDC units to Bridge, below the ${bridgeUnits} the Bridge transfer was created for — the payout would be under-funded`,
        );
      }
      expectedOut = delivered;
      usdcOut = usd.fromUnits(delivered);
      store.updateTransfer(transfer.id, {
        state: "SWAPPED",
        txs,
        usdcOut,
        liquidity: transfer.liquidity
          ? { ...transfer.liquidity, executedAt: new Date().toISOString(), txHash: opHash }
          : undefined,
      });
    } else {
      // 1. The user-signed UserOperation moves the input amount to the
      //    orchestrator's working address.
      await debitInputFunds(transfer, user, auth, txs, execution);

      // 2. Swap the convertible portion (send - fixed fee) EURe -> USDC.
      //    The fixed fee stays at the orchestrator address as revenue.
      await assertQuoteRateBinding(transfer);
      const liquidityPlan = await prepareTransferLiquidity(transfer);
      store.updateTransfer(transfer.id, { liquidity: liquidityPlan });
      recordOutboundIntent(transfer.id, txs, "liquidity.swap.pending");
      const liquidity = await executeTransferLiquidity({ ...transfer, liquidity: liquidityPlan });
      txs.push(...liquidity.txs);
      expectedOut = liquidity.amountOut;
      usdcOut = liquidityAmountOutUnits(liquidity.quote);
      store.updateTransfer(transfer.id, {
        state: "SWAPPED",
        txs,
        usdcOut,
        liquidity: serializeExecution(liquidity),
      });
    }

    // 3. Ask Bridge.xyz to fund the Stellar side (Bridge Transfer API). Once
    //    Bridge reports destination funding, refunds must reconcile Bridge +
    //    anchor state instead of assuming funds stayed local.
    let bridgePlan: BridgeTransferPlan;
    try {
      const destination = bridgeDestination();
      // A batched live send created this Bridge transfer at creation (for its
      // deposit address), so this is an idempotent replay and must send the
      // same body: the recorded amount and the user's Safe as source. A
      // different body under one idempotency key is rejected or answered with
      // the original.
      const batchLive = execution?.batch?.mode === "live";
      bridgePlan = await createBridgeTransfer(
        transfer.id,
        batchLive && transfer.safeSwap?.bridgeAmountUsdc
          ? transfer.safeSwap.bridgeAmountUsdc
          : usd.fromUnits(expectedOut),
        {
          paymentRail: BRIDGE.destinationRail,
          currency: BRIDGE.destinationCurrency,
          toAddress: destination.toAddress,
          blockchainMemo: destination.blockchainMemo,
        },
        { sourceAddress: batchLive ? user.address : orchestratorAddress },
      );
      recordBridgePlan(txs, bridgePlan);
    } catch (err) {
      if (err instanceof BridgeTransferError && err.plan) recordBridgePlan(txs, err.plan);
      throw err;
    }

    {
      const depositAddress = bridgePlan.sourceDepositInstructions?.to_address;
      if (!depositAddress || !/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) {
        throw new Error("Bridge did not return a Base deposit address; cannot fund transfer");
      }
      if (execution?.batch) {
        // The user-signed batch already delivered the USDC straight to the
        // deposit address — there is no orchestrator leg to run. The address
        // must still be THE address the batch was built against: Bridge's
        // idempotency key makes re-reads stable, but if these ever disagree
        // the money went somewhere this plan does not describe.
        if (depositAddress.toLowerCase() !== execution.batch.recipient.toLowerCase()) {
          throw new Error(
            `Bridge deposit address ${depositAddress} does not match the batch recipient ` +
              `${execution.batch.recipient} — the swap output location must be reconciled before payout`,
          );
        }
        txs.push({ step: "bridge.xyz.deposit.funded", hash: txs.at(-1)?.hash ?? "0x" });
      } else {
        const depositHash = await writeAndWait(
          orchestratorWallet,
          {
            address: a.usdc,
            abi: abis.MockToken,
            functionName: "transfer",
            args: [depositAddress as `0x${string}`, expectedOut],
          },
          outboundWrite(transfer.id, txs, "bridge.xyz.deposit.pending"),
        );
        txs.push({ step: "bridge.xyz.deposit.transfer", hash: depositHash });
      }
    }
    store.updateTransfer(transfer.id, { state: "BRIDGED", txs });

    // 4. Open the cash pickup at the anchor. The anchor withdraws USDC and does
    //    its own FX to cash at the counter — passing the KES figure here would
    //    ask it for ~130x the value. usdcOut is what the bridge leg holds.
    let pickup;
    try {
      pickup = await createCashPickupViaAnchor(transfer.id, {
        amountAsset: transfer.usdcOut ?? usd.fromUnits(expectedOut),
        payoutKes: transfer.receiveKes,
        recipientName: transfer.recipientName,
        recipientPhone: transfer.recipientPhone ?? "",
        // No originator details: nothing collects them per transfer yet, and
        // no sender profile is stored (data minimisation). A SEP-12
        // anchor refuses inside, naming what it needs.
        senderId: user.id,
      });
    } catch (err: any) {
      // Fail closed: a failed real payout must not masquerade as success.
      return failAndCompensate(
        transfer.id,
        new Error(`anchor payout failed: ${String(err?.message ?? err).slice(0, 200)}`),
        txs,
      );
    }
    const storedPickup = {
        referenceCode: pickup.referenceCode,
        provider: pickup.provider,
        status: pickup.status,
        interactiveUrl: pickup.interactiveUrl,
        anchorTransactionId: pickup.anchorTransactionId,
        anchorAmount: pickup.anchorAmount,
        anchorAsset: pickup.anchorAsset,
        anchorPaymentHash: pickup.anchorPaymentHash,
        anchorMemo: pickup.anchorMemo,
        anchorAmountIn: pickup.anchorAmountIn,
        anchorReferenceNumber: pickup.anchorReferenceNumber,
        moreInfoUrl: pickup.moreInfoUrl,
        anchorStatus: pickup.anchorStatus,
        bridgeTransferId: bridgePlan.transferId,
        bridgeState: bridgePlan.state,
        bridgeDepositAddress: bridgePlan.sourceDepositInstructions?.to_address,
        bridgeDepositMemo: bridgePlan.sourceDepositInstructions?.blockchain_memo,
        bridgeDestinationTxHash: bridgePlan.destinationTxHash,
      };
    return store.updateTransfer(transfer.id, {
      state: cashPayoutState(storedPickup),
      pickup: storedPickup,
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  } finally {
    executing.delete(transfer.id);
  }
}

/**
 * SEPA (bank payout) rail:
 *   CREATED -> DEBITED -> PAYOUT_SUBMITTED -> PAID
 * The payout amount remains in the user's Safe for Monerium to redeem; only
 * the fee leg is moved before placing the order — and only once the account
 * has a Monerium connection to place it on. A rejected order fails closed and
 * refunds the fee; nothing is ever marked paid without a real order.
 */
export async function executeSepaTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
  execution?: SafeExecution,
): Promise<Transfer> {
  executing.add(transfer.id);
  const txs = transfer.txs;

  try {
    const payoutEur = transfer.receiveEur ?? transfer.sendEur - railFeeEur("sepa");
    const [firstName, ...rest] = transfer.recipientName.trim().split(/\s+/);
    const counterpart = {
      iban: transfer.recipientIban!,
      firstName,
      lastName: rest.join(" ") || firstName,
      country: user.country || "DE",
    };

    // Real for the deployment (app credentials) OR for this user (their own
    // connected account): a redeem from a connected account is a real order.
    // Checked BEFORE the fee debit — a fee taken for a payout that cannot be
    // placed would only have to be refunded.
    if (!moneriumLiveFor(user)) {
      throw new Error(MONERIUM_NOT_CONNECTED.error);
    }

    await debitSafeFundedSepaFee(transfer, user, auth, payoutEur, txs, execution);

    {
      try {
        recordOutboundIntent(transfer.id, txs, "monerium.redeem.pending");
        const order = await redeemToIban(
          user,
          payoutEur,
          counterpart,
          paymentMemo(transfer.id, transfer.reference),
          transfer.moneriumRedeem?.signature
            ? { ...transfer.moneriumRedeem, signature: transfer.moneriumRedeem.signature }
            : undefined,
        );
        txs.push({ step: "monerium.redeem.placed", hash: order.id });
        return store.updateTransfer(transfer.id, {
          state: "PAYOUT_SUBMITTED",
          txs,
          sepa: {
            mode: "sandbox",
            orderId: order.id,
            state: order.meta?.state ?? order.state ?? "placed",
          },
        });
      } catch (err: any) {
        // A 4xx is Monerium refusing: the fee moved, so refund it rather than
        // pretend. Anything else (timeout, 5xx, reset) may have placed the
        // order — refunding then pays twice, so hold for review instead.
        const refused = err instanceof MoneriumApiError && err.status < 500;
        if (!refused) {
          return store.updateTransfer(transfer.id, {
            state: "MANUAL_REVIEW",
            error: `redeem order outcome unknown: ${String(err?.message ?? err).slice(0, 200)}; Monerium may have accepted it, so no automatic refund`,
            txs,
          });
        }
        txs.push({ step: "monerium.redeem.refused", hash: "0x" });
        return failAndCompensate(
          transfer.id,
          new Error(`redeem order failed: ${String(err?.message ?? err).slice(0, 200)}`),
          txs,
        );
      }
    }
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  } finally {
    executing.delete(transfer.id);
  }
}

/** The anchor reported the recipient collected the cash: close the transfer.
 *  Only reachable from refreshPayout, on the anchor's own PAID status. */
export async function settlePickup(transfer: Transfer): Promise<Transfer> {
  if (!["PAYOUT_READY", "PAYOUT_FUNDED"].includes(transfer.state)) {
    throw new Error(`transfer is ${transfer.state}, expected PAYOUT_READY/PAYOUT_FUNDED`);
  }
  return store.updateTransfer(transfer.id, {
    state: "PAID",
    pickup: { ...transfer.pickup!, status: "PAID" },
  });
}

const refreshPayoutLocks = new Map<string, Promise<Transfer>>();

/** Refresh an anchor-backed cash payout. If the anchor has supplied payment
 * instructions, fund it on-ledger and mark PAID only after anchor completion. */
export async function refreshPayout(
  transfer: Transfer,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<Transfer> {
  const locked = refreshPayoutLocks.get(transfer.id);
  if (locked) return locked;
  const run = refreshPayoutUnlocked(transfer, opts).finally(() => {
    if (refreshPayoutLocks.get(transfer.id) === run) refreshPayoutLocks.delete(transfer.id);
  });
  refreshPayoutLocks.set(transfer.id, run);
  return run;
}

async function refreshPayoutUnlocked(
  transfer: Transfer,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<Transfer> {
  if (!["PAYOUT_DETAILS_PENDING", "PAYOUT_FUNDING_PENDING", "PAYOUT_FUNDED", "PAYOUT_READY"].includes(transfer.state)) {
    return transfer;
  }
  if (transfer.state === "PAYOUT_FUNDED" && transfer.pickup?.status === "PAID") {
    return settlePickup(transfer);
  }
  if (!transfer.pickup?.anchorTransactionId) return transfer;
  try {
    const pickup = await fundAndRefreshAnchorPickup(
      transfer.id,
      transfer.pickup as any,
      opts.pollMs,
      opts.timeoutMs,
      // Persist the payment hash the moment it exists. Without this, a crash
      // during the poll loop below loses the record and the next call pays
      // the anchor a second time.
      (funded) => {
        store.updateTransfer(transfer.id, {
          pickup: { ...transfer.pickup, ...funded },
        });
      },
    );
    if (!pickup) return transfer;
    const updated = store.updateTransfer(transfer.id, {
      state: pickup.status === "PAID" ? "PAYOUT_FUNDED" : cashPayoutState({ ...transfer.pickup, ...pickup }),
      pickup: { ...transfer.pickup, ...pickup },
    });
    if (pickup.status === "PAID") return settlePickup(updated);
    return updated;
  } catch (err: any) {
    // A failure that may have moved money must never auto-refund the sender:
    // that would pay twice. Same reasoning as a completed Bridge destination leg.
    const latest = store.findTransfer(transfer.id);
    const maybePaid =
      err instanceof AnchorPaymentUncertainError || !!latest?.pickup?.anchorPaymentHash;
    // A transport failure says nothing about the payout; the next refresh
    // asks again. Only the anchor's own verdict may fail the transfer.
    const transient =
      err instanceof TypeError ||
      /fetch failed|ECONN|ETIMEDOUT|timed? ?out|aborted|socket hang up|\b5\d\d\b/i.test(String(err?.message ?? err));
    if (transient && !maybePaid) {
      console.error(`refreshPayout: transient anchor error for ${transfer.id}, state unchanged: ${describeCause(err)}`);
      return transfer;
    }
    if (maybePaid) {
      return store.updateTransfer(transfer.id, {
        state: "MANUAL_REVIEW",
        error:
          `anchor settlement unresolved: ${String(err?.message ?? err).slice(0, 200)}; ` +
          `a Stellar payment may already have been sent, so no automatic refund`,
      });
    }
    return failAndCompensate(
      transfer.id,
      new Error(`anchor settlement failed: ${String(err?.message ?? err).slice(0, 200)}`),
      transfer.txs,
    );
  }
}

