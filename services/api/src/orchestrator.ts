/**
 * Transfer orchestrator — drives one remittance through its on-chain and
 * partner legs, recording every state and tx hash:
 *
 *   CREATED -> DEBITED -> SWAPPED -> BRIDGED -> PAYOUT_READY -> PAID
 *                                                (recipient collects cash)
 *
 * Every leg is idempotent at the contract layer (transferId hash), so a crash
 * mid-flow can be resumed without double-spending. On failure the transfer is
 * marked FAILED; the BridgeEscrow.release() refund path is wired but manual
 * in the MVP.
 */
import { BRIDGE, FX, moneriumSandboxEnabled, USING_LOCAL_RPC } from "./config.js";
import { verifyTypedData } from "viem";
import { AnchorPaymentUncertainError } from "./stellar/anchor.js";
import { store, type Transfer, type TransferState, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { paymentMemo } from "./sepa.js";
import { createBridgeTransfer, BridgeTransferError, type BridgeTransferPlan } from "./bridge/bridgexyz.js";
import {
  executeTransferLiquidity,
  liquidityAmountOutUnits,
  liquidityProvider,
  prepareTransferLiquidity,
  serializeExecution,
  waitForAllowanceVisibility,
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
  swapperRate,
  transferIdHash,
  writeAndWait,
} from "./chain.js";
import { CANDIDE, transferTokenFromSafeAllowance } from "./wallet/candide.js";
import {
  createCashPickup,
  createCashPickupViaAnchor,
  completePickup,
  fundAndRefreshAnchorPickup,
  getPickup,
} from "./adapters/moneygram.js";
import { anchorModeEnabled, SECURITY } from "./config.js";

/**
 * FP4: the user's device signature over this payment's exact terms. The
 * backend cannot produce one — it can only relay a spend the device approved.
 */
export interface PaymentAuthorization {
  deadline: number;
  signature: `0x${string}`;
}

/**
 * FP5: verify the live on-chain swap rate hasn't drifted past tolerance from
 * the rate the quote assumed. Throws (→ FP3 compensation) if it has, so a
 * transfer never settles at economics the user didn't agree to.
 */
export async function assertQuoteRateBinding(transfer: Transfer): Promise<void> {
  const quote = store.findQuote(transfer.quoteId);
  if (!quote?.lockedSwapRate) return; // legacy/sepa quotes: nothing to bind
  const locked = BigInt(quote.lockedSwapRate);
  // Ask the provider that will actually fill the swap. Reading the FxSwapper
  // contract directly compared the quote against the local mock's rate even
  // when the deployment was pricing through a market maker — the check would
  // have passed on a number nothing was going to trade at.
  const { raw: live } = await liquidityProvider().indicativeRate("EURE_TO_USDC");
  const driftBps = (live > locked ? live - locked : locked - live) * 10_000n / locked;
  if (driftBps > BigInt(FX.QUOTE_BINDING_BPS)) {
    throw new Error(
      `FX rate moved since quote (${driftBps} bps > ${FX.QUOTE_BINDING_BPS} bps cap) — request a new quote`,
    );
  }
}

/** Test hook: FORCE_FAIL_STEP=<step> makes the orchestrator throw right
 *  after that step commits — used to exercise the compensation path. */
const failpoint = (step: string) => {
  if (process.env.FORCE_FAIL_STEP === step) throw new Error(`forced failure after ${step}`);
};

/**
 * The step names for the input-funds leg, in one place.
 *
 * Recovery decides whether any money actually moved by matching these names,
 * so the producer and every consumer have to agree. They did not: the Safe
 * path pushed "safe.transfer(orchestrator)" while compensateTransfer and
 * sweepStrandedTransfers still looked for an old ledger-debit step, so a failed
 * Safe-funded transfer recorded a €0 refund reading "nothing was debited"
 * while the EURe had already left the user's Safe — and the sweep then skipped
 * it forever, because setting `refund` is what marks a transfer as settled.
 *
 * Anything that adds a third funding source must add its step here.
 */
export const DEBIT_STEP = {
  safe: "safe.transfer(orchestrator)",
  /** SEPA, Safe-funded: only the fee moves, because the redeem burns the payout
   *  straight from the Safe. Recovery owes back the fee, not the whole send. */
  safeFee: "safe.transfer(fee)",
} as const;

/** Did the input leg move the sender's money? True once any funding source has
 *  committed its debit, which is what makes a failure owe a refund. */
function inputFundsMoved(txs: Transfer["txs"]): boolean {
  return txs.some(
    (x) =>
      x.step === DEBIT_STEP.safe ||
      x.step === DEBIT_STEP.safeFee,
  );
}

/**
 * How much actually left the user's Safe, which is what a refund owes back.
 *
 * Not always `sendEur`: the Safe-funded SEPA rail moves only the fee and lets
 * Monerium burn the payout from the Safe directly, so refunding `sendEur` there
 * would hand back money that never moved — and would fail anyway, because the
 * orchestrator is only holding the fee.
 */
function safeMovedEur(t: Transfer): number {
  const steps = new Set(t.txs.map((x) => x.step));
  if (steps.has(DEBIT_STEP.safe)) return t.sendEur;
  if (steps.has(DEBIT_STEP.safeFee)) {
    const payoutEur = t.receiveEur ?? t.sendEur - FX.FIXED_FEE_EUR;
    return Math.max(0, Math.round((t.sendEur - payoutEur) * 100) / 100);
  }
  return 0;
}

/** EUR this user has committed to Safe-funded transfers today. FAILED/REFUNDED
 * transfers released their reservation. */
export function safeFundedEurToday(userId: string, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return store.transfers
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
): Promise<void> {
  const a = addrs();
  const sendWei = eur.toWei(transfer.sendEur);

  await assertDeviceAuthorization(transfer, user, auth);
  if (transfer.txs.some((x) => x.step === DEBIT_STEP.safe)) {
    throw new Error("duplicate transfer: this transfer already moved EURe out of the Safe");
  }

  const moveHash = await moveTokenFromUserSafe(user, a.eure, orchestratorAddress, sendWei);
  txs.push({ step: DEBIT_STEP.safe, hash: moveHash });
  store.updateTransfer(transfer.id, { state: "DEBITED", txs });
  failpoint("safe.transfer");
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
): Promise<void> {
  await assertDeviceAuthorization(transfer, user, auth);
  if (transfer.txs.some((x) => x.step === DEBIT_STEP.safeFee)) {
    throw new Error("duplicate transfer: this transfer already moved its fee out of the Safe");
  }
  const feeEur = Math.max(0, transfer.sendEur - payoutEur);
  if (feeEur > 0) {
    const feeHash = await moveTokenFromUserSafe(user, addrs().eure, orchestratorAddress, eur.toWei(feeEur));
    txs.push({ step: DEBIT_STEP.safeFee, hash: feeHash });
  }
  store.updateTransfer(transfer.id, { state: "DEBITED", txs });
  failpoint("safe.transfer.fee");
}

export function safeDebitBlocker(user: User): string | null {
  if (activePasskeySafe(user)) {
    return passkeySafeAllowanceReady(user)
      ? null
      : "Co-signer service is not configured — please ensure CANDIDE_COSIGNER_ADDRESS and CANDIDE_COSIGNER_KEY are set in environment";
  }
  return (
    "Safe-held funds need an active passkey Safe with a co-signer service configured " +
    "before transfers can be executed"
  );
}

function activePasskeySafe(user: User): boolean {
  return (
    user.passkeySafe?.status === "active" &&
    user.address.toLowerCase() === user.passkeySafe.address.toLowerCase()
  );
}

function passkeySafeAllowanceReady(user: User): boolean {
  if (!activePasskeySafe(user) || !user.passkeySafe) return false;
  return Boolean(
    (user.passkeySafe.cosignerPolicy?.enabled && user.passkeySafe.cosignerAddress) ||
    (CANDIDE.cosignerAddress && CANDIDE.cosignerKey)
  );
}

async function moveTokenFromUserSafe(
  user: User,
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<string> {
  if (!passkeySafeAllowanceReady(user)) {
    throw new Error(safeDebitBlocker(user) ?? "Safe debit is not configured for this account");
  }
  if (user.passkeySafe && !user.passkeySafe.cosignerPolicy?.enabled && CANDIDE.cosignerAddress) {
    const a = addrs();
    store.updateUser(user.id, {
      passkeySafe: {
        ...user.passkeySafe,
        cosignerAddress: CANDIDE.cosignerAddress,
        cosignerPolicy: {
          enabled: true,
          allowanceModuleAddress: CANDIDE.allowanceModuleAddress,
          allowancePeriodMinutes: CANDIDE.cosignerAllowancePeriodMinutes.toString(),
          allowances: [
            { token: a.eure, symbol: "EURE", amount: CANDIDE.cosignerEureAllowanceWei.toString() },
            { token: a.usdc, symbol: "USDC", amount: CANDIDE.cosignerUsdcAllowanceUnits.toString() },
          ],
          allowanceAmount: CANDIDE.cosignerEureAllowanceWei.toString(),
        },
      },
    });
  }
  return transferTokenFromSafeAllowance({
    safeAddress: user.address,
    token,
    to,
    amount,
    moduleAddress: user.passkeySafe?.cosignerPolicy?.allowanceModuleAddress as `0x${string}` | undefined,
  });
}

function bridgeDestination(): { toAddress: string; blockchainMemo?: string } {
  if (BRIDGE.destinationAddress) {
    return {
      toAddress: BRIDGE.destinationAddress,
      ...(BRIDGE.destinationMemo ? { blockchainMemo: BRIDGE.destinationMemo } : {}),
    };
  }
  if (BRIDGE.live) {
    throw new Error(
      "BRIDGE_LIVE=1 requires BRIDGE_DESTINATION_ADDRESS until MoneyGram anchor payment instructions are wired into Bridge",
    );
  }
  return { toAddress: "bridge-dry-run-stellar-destination" };
}

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
 * FP3: mark FAILED, then immediately attempt compensation. The refund the
 * user gets depends on how far the transfer got — costs already incurred
 * (conversion round-trips at the prevailing rate) are itemized, uRamp-style.
 */
async function failAndCompensate(id: string, err: any, txs: Transfer["txs"]): Promise<Transfer> {
  const message = String(err?.shortMessage ?? err?.message ?? err);
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
  if (txs.some((x) => x.step === "bridge.xyz.destination_tx")) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${failed.error}; Bridge reported destination funding, so automatic local refund is unsafe until Bridge/anchor state is reconciled`,
      txs,
    });
  }
  try {
    return await compensateTransfer(id);
  } catch (e: any) {
    console.error(`compensation failed for ${id}: ${e?.message ?? e} — will retry on sweep`);
    return failed;
  }
}

/** Walk a failed transfer backwards: release escrow if locked and return
 * recoverable EURe to the sender's Safe. */
export async function compensateTransfer(id: string): Promise<Transfer> {
  const t = store.findTransfer(id);
  if (!t) throw new Error(`unknown transfer ${id}`);
  if (t.state === "REFUNDED" || t.state === "PAID" || t.refund) return t;
  const user = store.findUser(t.userId);
  if (!user) throw new Error(`unknown user for transfer ${id}`);
  const steps = new Set(t.txs.map((x) => x.step));
  const now = () => new Date().toISOString();

  if (!inputFundsMoved(t.txs)) {
    // Nothing moved — FAILED is the whole story.
    return store.updateTransfer(id, {
      refund: { amountEur: 0, recoveredFrom: "none", deductions: "nothing was debited", at: now() },
    });
  }

  const txs = t.txs;
  if (steps.has("bridge.lockForPayout") && !steps.has("bridge.settle")) {
    const h = await writeAndWait(orchestratorWallet, {
      address: addrs().bridge,
      abi: abis.BridgeEscrow,
      functionName: "release",
      args: [transferIdHash(t.id), orchestratorAddress],
    });
    txs.push({ step: "bridge.release", hash: h });
  }

  let refundEur: number;
  let recoveredFrom: string;
  let deductions = "none";
  const fee = FX.FIXED_FEE_EUR;
  if (!steps.has("liquidity.fx-swapper.eure-usdc") && !steps.has("swapper.swapExactIn")) {
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
    recoveredFrom = steps.has("bridge.lockForPayout") ? "released escrow" : "post-swap USDC";
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
    const swapped =
      steps.has("liquidity.fx-swapper.eure-usdc") || steps.has("swapper.swapExactIn");
    if (swapped) {
      /**
       * Reverse the swap and give the euros back. The rate movement of the
       * round trip is worn by the user as an ITEMIZED deduction (both legs at
       * execution prices, the received amount MEASURED as a Safe balance
       * delta, not read off the quote) — that honesty beats the alternative,
       * which was parking the money in MANUAL_REVIEW indefinitely: the first
       * live post-swap failure sat exactly there, 4.57 USDC of a user's €5
       * stranded on the orchestrator. Reversal failing still parks for
       * review — guessing is the one thing this path must never do.
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
        }
        const total = Math.floor((eurBack + feeBack) * 100) / 100;
        const lost = Math.max(0, safeMovedEur(t) - total);
        console.log(
          `FP3: reverse-swapped and returned €${total} to ${user.name}'s Safe for transfer ${t.id} (post-swap)`,
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
            `reverse swap did not complete (${err?.message ?? err}) — needs review before ` +
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
    const refundHash = await returnEureToSafe(user.address, safeRefundEur);
    txs.push({ step: "safe.refundTransfer", hash: refundHash });
    console.log(
      `FP3: returned €${safeRefundEur} to ${user.name}'s Safe for transfer ${t.id} (Safe-funded)`,
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
  try {
    return (await liquidityProvider().indicativeRate("EURE_TO_USDC")).raw;
  } catch {
    return (await swapperRate()).raw;
  }
}

/** Recovery sweep: compensate FAILED transfers that moved money, and
 *  fail-then-compensate transfers stranded mid-flow (e.g. by a crash). */
export async function sweepStrandedTransfers(): Promise<number> {
  const STALE_MS = 10 * 60_000;
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      if (t.state === "FAILED" && !t.refund && inputFundsMoved(t.txs)) {
        await compensateTransfer(t.id);
        n++;
      } else if (
        ["DEBITED", "SWAPPED", "BRIDGED"].includes(t.state) &&
        Date.now() - Date.parse(t.updatedAt) > STALE_MS
      ) {
        store.updateTransfer(t.id, { state: "FAILED", error: "stranded mid-flow — auto-compensating" });
        await compensateTransfer(t.id);
        n++;
      }
    } catch (e: any) {
      console.error(`sweep: compensation failed for ${t.id}: ${e?.message ?? e}`);
    }
  }
  return n;
}

/** Drive anchor-backed payouts that no browser is polling anymore. */
export async function sweepAnchorPayouts(): Promise<number> {
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      if (["PAYOUT_FUNDING_PENDING", "PAYOUT_FUNDED"].includes(t.state)) {
        const before = t.updatedAt;
        const updated = await refreshPayout(t);
        if (updated.updatedAt !== before) n++;
      }
    } catch (e: any) {
      console.error(`sweep: anchor payout refresh failed for ${t.id}: ${e?.message ?? e}`);
    }
  }
  return n;
}

export async function executeTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    // 1. Move the signed input amount to the orchestrator's working address.
    await debitInputFunds(transfer, user, auth, txs);

    // 2. Swap the convertible portion (send - fixed fee) EURe -> USDC.
    //    The fixed fee stays at the orchestrator address as revenue.
    await assertQuoteRateBinding(transfer);
    const liquidityPlan = await prepareTransferLiquidity(transfer);
    store.updateTransfer(transfer.id, { liquidity: liquidityPlan });
    const liquidity = await executeTransferLiquidity({ ...transfer, liquidity: liquidityPlan });
    txs.push(...liquidity.txs);
    const expectedOut = liquidity.amountOut;
    const usdcOut = liquidityAmountOutUnits(liquidity.quote);
    store.updateTransfer(transfer.id, {
      state: "SWAPPED",
      txs,
      usdcOut,
      liquidity: serializeExecution(liquidity),
    });

    // 3. Ask Bridge.xyz to fund the Stellar side. In dry-run mode we record
    //    Bridge-shaped deposit instructions and keep the local escrow leg so
    //    the no-credential demo can still complete. BRIDGE_LIVE=1 calls the
    //    Bridge Transfer API; once Bridge reports destination funding, refunds
    //    must reconcile Bridge + anchor state instead of assuming funds stayed
    //    local.
    let bridgePlan: BridgeTransferPlan;
    try {
      const destination = bridgeDestination();
      bridgePlan = await createBridgeTransfer(
        transfer.id,
        usd.fromUnits(expectedOut),
        {
          paymentRail: BRIDGE.destinationRail,
          currency: BRIDGE.destinationCurrency,
          toAddress: destination.toAddress,
          blockchainMemo: destination.blockchainMemo,
        },
        { sourceAddress: orchestratorAddress },
      );
      recordBridgePlan(txs, bridgePlan);
    } catch (err) {
      if (err instanceof BridgeTransferError && err.plan) recordBridgePlan(txs, err.plan);
      throw err;
    }

    if (bridgePlan.mode === "live") {
      const depositAddress = bridgePlan.sourceDepositInstructions?.to_address;
      if (!depositAddress || !/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) {
        throw new Error("Bridge did not return a Base deposit address; cannot fund transfer");
      }
      const depositHash = await writeAndWait(orchestratorWallet, {
        address: a.usdc,
        abi: abis.MockToken,
        functionName: "transfer",
        args: [depositAddress as `0x${string}`, expectedOut],
      });
      txs.push({ step: "bridge.xyz.deposit.transfer", hash: depositHash });
    } else {
      const approveBridgeHash = await writeAndWait(orchestratorWallet, {
        address: a.usdc,
        abi: abis.MockToken,
        functionName: "approve",
        args: [a.bridge, expectedOut],
      });
      txs.push({ step: "usdc.approve(bridge)", hash: approveBridgeHash });
      // Same replica race as approve->swap, one leg later: the lock SIMULATION
      // can land on an RPC replica that has not seen the approve block, and
      // reverts "allowance" against an allowance that is on chain.
      await waitForAllowanceVisibility(a.usdc, orchestratorAddress, a.bridge, expectedOut);

      const lockHash = await writeAndWait(orchestratorWallet, {
        address: a.bridge,
        abi: abis.BridgeEscrow,
        functionName: "lockForPayout",
        args: [tid, expectedOut, "stellar", `mgi:${transfer.recipientPhone}`],
      });
      txs.push({ step: "bridge.lockForPayout", hash: lockHash });
    }
    store.updateTransfer(transfer.id, { state: "BRIDGED", txs });
    failpoint(bridgePlan.mode === "live" ? "bridge.xyz.transfer" : "bridge.lockForPayout");

    // 4. Create the cash pickup at the quoted amount — a real SEP-24 anchor
    //    withdrawal when an anchor is configured, the mock otherwise.
    let pickup;
    if (anchorModeEnabled()) {
      try {
        // The anchor withdraws USDC and does its own FX to cash at the
        // counter — passing the KES figure here would ask it for ~130x the
        // value. usdcOut is what the bridge leg actually holds.
        pickup = await createCashPickupViaAnchor(transfer.id, {
          amountAsset: transfer.usdcOut ?? usd.fromUnits(expectedOut),
          payoutKes: transfer.receiveKes,
          recipientName: transfer.recipientName,
          recipientPhone: transfer.recipientPhone ?? "",
          sender: user,
        });
      } catch (err: any) {
        // Fail closed: a failed real payout must not masquerade as success.
        if (!SECURITY.allowMockFallback) {
          return failAndCompensate(
            transfer.id,
            new Error(`anchor payout failed: ${String(err?.message ?? err).slice(0, 200)} (set ALLOW_MOCK_FALLBACK=1 to simulate instead)`),
            txs,
          );
        }
        console.error(`anchor pickup failed, mock fallback allowed: ${err?.message ?? err}`);
      }
    }
    pickup ??= createCashPickup(
      transfer.id,
      transfer.receiveKes,
      transfer.recipientName,
      transfer.recipientPhone ?? "",
    );
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
  }
}

/**
 * SEPA (bank payout) rail:
 *   CREATED -> DEBITED -> PAYOUT_SUBMITTED -> PAID
 * The payout amount remains in the user's Safe for Monerium to redeem; only
 * the fee leg is moved before placing the order. If the real order is rejected,
 * the payout falls back to a simulated SEPA leg only when explicitly allowed.
 */
export async function executeSepaTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const txs = transfer.txs;

  try {
    const payoutEur = transfer.receiveEur ?? transfer.sendEur - FX.FIXED_FEE_EUR;
    const [firstName, ...rest] = transfer.recipientName.trim().split(/\s+/);
    const counterpart = {
      iban: transfer.recipientIban!,
      firstName,
      lastName: rest.join(" ") || firstName,
      country: user.country || "DE",
    };

    await debitSafeFundedSepaFee(transfer, user, auth, payoutEur, txs);

    if (moneriumSandboxEnabled()) {
      try {
        const order = await redeemToIban(
          user,
          payoutEur,
          counterpart,
          paymentMemo(transfer.id, transfer.reference),
          transfer.moneriumRedeem?.signature
            ? { ...transfer.moneriumRedeem, signature: transfer.moneriumRedeem.signature }
            : undefined,
        );
        return store.updateTransfer(transfer.id, {
          state: "PAYOUT_SUBMITTED",
          sepa: {
            mode: "sandbox",
            orderId: order.id,
            state: order.meta?.state ?? order.state ?? "placed",
          },
        });
      } catch (err: any) {
        // Fail closed unless simulation fallback is explicitly allowed.
        if (!SECURITY.allowMockFallback) {
          return failAndCompensate(
            transfer.id,
            new Error(`redeem order failed: ${String(err?.message ?? err).slice(0, 200)} (set ALLOW_MOCK_FALLBACK=1 to simulate instead)`),
            txs,
          );
        }
        return store.updateTransfer(transfer.id, {
          state: "PAID",
          sepa: {
            mode: "mock",
            state: "simulated",
            detail: `real redeem unavailable: ${String(err?.message ?? err).slice(0, 180)}`,
          },
        });
      }
    }

    return store.updateTransfer(transfer.id, {
      state: "PAID",
      sepa: { mode: "mock", state: "processed", detail: "simulated SEPA payout" },
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  }
}

/** Recipient collected the cash: settle the escrow and close the transfer. */
export async function settlePickup(transfer: Transfer): Promise<Transfer> {
  if (!["PAYOUT_READY", "PAYOUT_FUNDED"].includes(transfer.state)) {
    throw new Error(`transfer is ${transfer.state}, expected PAYOUT_READY/PAYOUT_FUNDED`);
  }
  const txs = [...transfer.txs];
  const steps = new Set(txs.map((x) => x.step));
  if (steps.has("bridge.lockForPayout") && !steps.has("bridge.settle")) {
    const settleHash = await writeAndWait(orchestratorWallet, {
      address: addrs().bridge,
      abi: abis.BridgeEscrow,
      functionName: "settle",
      args: [transferIdHash(transfer.id)],
    });
    txs.push({ step: "bridge.settle", hash: settleHash });
  }
  const pickup = completePickup(transfer.id);
  const stored = pickup ?? transfer.pickup!;
  return store.updateTransfer(transfer.id, {
    state: "PAID",
    txs,
    pickup: { ...stored, status: "PAID" },
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

export function pickupStatus(transferId: string) {
  return getPickup(transferId);
}
