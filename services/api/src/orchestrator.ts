/**
 * Transfer orchestrator — drives one SEPA payout through its on-chain and
 * Monerium legs, recording every state and tx hash:
 *
 *   CREATED -> DEBITED -> PAYOUT_SUBMITTED -> PAID
 *
 * Every leg records its step before the next runs, and a debit already in
 * `txs` is refused, so a crash mid-flow cannot double-spend. Failures
 * auto-compensate: failAndCompensate refunds what is recoverable, and the
 * startup/5-minute sweep retries anything stranded.
 *
 * NO MOCK LEGS. There is no simulated SEPA payout: a rail is live or the
 * transfer is refused before anything leaves the user's Safe.
 */
import { railFeeEur } from "./config.js";
import { moneriumLiveFor } from "./adapters/monerium-connection.js";
import { verifyTypedData } from "viem";
import { store, type Transfer, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { MoneriumApiError } from "./adapters/monerium-client.js";
import { paymentMemo } from "./sepa.js";
import {
  destinationCommitment,
  eur,
  paymentAuthorizationTypedData,
  publicClient,
  returnEureToSafe,
  transferIdHash,
} from "./chain.js";
import {
  submitPasskeySafeOperation,
  type BrowserPasskeyAssertion,
  type PasskeySafeDeploymentPlan,
} from "./wallet/candide.js";
import { FX, HARNESS } from "./config.js";

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
  userOperation: Parameters<typeof submitPasskeySafeOperation>[1];
  assertion: BrowserPasskeyAssertion;
}

/**
 * The step names for the input-funds leg, in one place.
 *
 * Recovery decides whether any money actually moved by matching these names,
 * so the producer and every consumer have to agree. A consumer looking for a
 * step the producer never writes records a €0 refund reading "nothing was
 * debited" while the EURe has already left the user's Safe — and the sweep
 * then skips it forever, because setting `refund` is what marks a transfer as
 * settled.
 *
 * Anything that adds a rail or funding source that debits differently must
 * add its step here.
 */
export const DEBIT_STEP = {
  /** SEPA, Safe-funded: only the fee moves, because the redeem burns the payout
   *  straight from the Safe. Recovery owes back the fee, not the whole send. */
  safeFee: "safe.transfer(fee)",
} as const;

/** Did the input leg move the sender's money? True once the debit has
 *  committed, which is what makes a failure owe a refund. */
function inputFundsMoved(txs: Transfer["txs"]): boolean {
  return txs.some((x) => x.step === DEBIT_STEP.safeFee);
}

/**
 * How much actually left the user's Safe, which is what a refund owes back.
 *
 * Not `sendEur`: the SEPA rail moves only the fee and lets Monerium burn the
 * payout from the Safe directly, so refunding `sendEur` would hand back money
 * that never moved — and would fail anyway, because the orchestrator is only
 * holding the fee.
 */
function safeMovedEur(t: Transfer): number {
  if (!inputFundsMoved(t.txs)) return 0;
  const payoutEur = t.receiveEur ?? t.sendEur - railFeeEur("sepa");
  return Math.max(0, Math.round((t.sendEur - payoutEur) * 100) / 100);
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
  const opHash = await submitPasskeySafeOperation(execution.plan, execution.userOperation, execution.assertion);
  return opHash ?? "0x";
}

/**
 * Mark FAILED, then immediately attempt compensation. The refund owed is what
 * actually left the Safe — on the SEPA rail, the fee alone.
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
  try {
    return await compensateTransfer(id);
  } catch (e: any) {
    console.error(`compensation failed for ${id}: ${e?.message ?? e} — will retry on sweep`);
    return failed;
  }
}

/** Transfers whose execute*() is running right now, so the stranded-transfer
 *  sweep does not refund a transfer whose live call is merely slow. */
const executing = new Set<string>();

/** Walk a failed transfer backwards: return what left the sender's Safe. */
export async function compensateTransfer(id: string): Promise<Transfer> {
  const t = store.findTransfer(id);
  if (!t) throw new Error(`unknown transfer ${id}`);
  if (t.state === "REFUNDED" || t.state === "PAID" || t.refund) return t;
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

  if (!inputFundsMoved(t.txs)) {
    // Nothing moved — FAILED is the whole story.
    return store.updateTransfer(id, {
      refund: { amountEur: 0, recoveredFrom: "none", deductions: "nothing was debited", at: now() },
    });
  }

  const txs = t.txs;
  const movedEur = safeMovedEur(t);
  if (t.fundingSource !== "safe") {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error:
        `${t.error ?? "transfer failed"}; the debited fee needs a Safe-native treasury ` +
        `refund path before €${movedEur} can be returned`,
      txs,
    });
  }

  // The euros came out of the user's own Safe, so that is where they go back:
  // the very tokens that moved, not new ones.
  const refundHash = await returnEureToSafe(user.address, movedEur);
  txs.push({ step: "safe.refundTransfer", hash: refundHash });
  store.updateTransfer(id, { txs }); // on record before anything else can fail
  console.log(`Compensation: returned €${movedEur} to ${user.name}'s Safe for transfer ${t.id}`);
  const neverMoved = t.sendEur - movedEur;
  return store.updateTransfer(id, {
    state: "REFUNDED",
    txs,
    refund: {
      amountEur: movedEur,
      recoveredFrom: "Safe-funded EURe",
      deductions:
        neverMoved > 0
          ? `€${neverMoved.toFixed(2)} never left the Safe (payout burns from it directly)`
          : "none",
      at: now(),
    },
  });
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
        t.state === "DEBITED" &&
        !executing.has(t.id) &&
        Date.now() - Date.parse(t.updatedAt) > STALE_MS
      ) {
        store.updateTransfer(t.id, { state: "FAILED", error: "stranded mid-flow — auto-compensating" });
        await compensateTransfer(t.id);
        n++;
      } else if (
        t.state === "CREATED" &&
        t.auth?.authorizedAt &&
        Date.now() - Date.parse(t.auth.authorizedAt) > STALE_MS
      ) {
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
      console.error(`sweep: compensation failed for ${t.id}: ${e?.message ?? e}`);
    }
  }
  return n;
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
      throw new Error(
        "no Monerium connection for this account — sign in with Monerium or add your Monerium API keys before sending",
      );
    }

    await debitSafeFundedSepaFee(transfer, user, auth, payoutEur, txs, execution);

    {
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
