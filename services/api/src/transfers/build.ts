import { randomUUID } from "node:crypto";
import { FX, HARNESS, railFeeEur } from "../config.js";
import {
  accountBalances,
  addrs,
  destinationCommitment,
  eur,
  orchestratorAddress,
  paymentAuthorizationTypedData,
  transferIdHash,
} from "../chain.js";
import { moneriumRedeemMessage, paymentMemo } from "../sepa.js";
import { safeDebitBlocker, safeFundedEurToday } from "../orchestrator.js";
import { store, type Quote, type Transfer } from "../store.js";
import { assertDailyCap, requireKycApproved } from "../http/guards.js";
import { pendingTransferExecutions, prunePendingTransferExecutions } from "../http/pending.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import { prepareTransferExecution, safeMessageHash } from "../wallet/candide.js";

/** How long a device signature stays submittable. */
export const AUTH_WINDOW_SEC = 15 * 60;

/**
 * Build a transfer from an open quote, and the authorization the device must
 * sign for it.
 *
 * This is the only code path that builds a transfer: POST /api/transfers and
 * draft execution both call it. Don't add a second construction in the
 * business router; that is how a caller ends up skipping a balance check, the
 * daily cap or the destination commitment.
 *
 * It returns a discriminated result because only one of its two callers owns
 * an HTTP response. The `res` passed to requireKycApproved / assertDailyCap is
 * a collector whose `.status(x).json(y)` evaluates to the failure result, so
 * the refusals below keep their route-handler shape.
 */
export type TransferBuildFailure = { ok: false; status: number; body: any };
export type TransferBuildResult =
  | { ok: true; transfer: Transfer; authorization: any }
  | TransferBuildFailure;

export function responseCollector() {
  const out: TransferBuildFailure = { ok: false, status: 500, body: undefined };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: any) {
      out.body = body;
      return out;
    },
  };
  return { res, out };
}

export async function buildTransferFromQuote(
  quote: Quote,
  recipient: {
    recipientName: string;
    recipientIban: string;
    reference?: string;
  },
): Promise<TransferBuildResult> {
  // Whatever way preparation ends — refusal, thrown error or success — a cap
  // hold it took must not outlive it. Releasing a committed hold is a no-op.
  const hold: { id?: string } = {};
  try {
    return await prepareTransferFromQuote(quote, recipient, hold);
  } finally {
    if (hold.id) store.releaseCapHold(hold.id);
  }
}

async function prepareTransferFromQuote(
  quote: Quote,
  recipient: {
    recipientName: string;
    recipientIban: string;
    reference?: string;
  },
  hold: { id?: string },
): Promise<TransferBuildResult> {
  const { res, out } = responseCollector();
  const { recipientName, recipientIban, reference } = recipient;
    const user = store.findUser(quote.userId)!;
    if (!requireKycApproved(user, res)) return out;
    const balances = await accountBalances(user.address);
    const fundingSource: Transfer["fundingSource"] = "safe";
    if (balances.safeBalanceEur < quote.sendEur) {
      return res.status(400).json({
        error: `insufficient Safe balance (€${balances.safeBalanceEur.toFixed(2)})`,
      });
    }
    const debitBlocker = safeDebitBlocker(user);
    if (fundingSource === "safe" && debitBlocker) {
      return res.status(409).json({
        error: debitBlocker,
        safeBalanceEur: balances.safeBalanceEur,
      });
    }
    if (!(await assertDailyCap(user, quote.sendEur, res))) return out;

    const createdAt = new Date().toISOString();
    const transfer: Transfer = {
      id: randomUUID(),
      userId: user.id,
      quoteId: quote.id,
      rail: quote.rail,
      recipientName,
      recipientIban,
      reference: reference || undefined,
      state: "CREATED" as const,
      sendEur: quote.sendEur,
      receiveEur: quote.receiveEur,
      fundingSource,
      txs: [],
      createdAt,
      updatedAt: createdAt,
    };
    const payoutEur = transfer.receiveEur ?? transfer.sendEur - railFeeEur("sepa");
    const redeem = moneriumRedeemMessage(payoutEur, recipientIban, createdAt);
    transfer.moneriumRedeem = {
      ...redeem,
      memo: paymentMemo(transfer.id, transfer.reference),
    };
    // The account must be bound to a device key before it can spend.
    const authorizer = user.authorizerAddress;
    if (!authorizer) {
      return res.status(409).json({
        error: "no device key registered for this account — POST /api/users/:id/authorizer first",
      });
    }
    /**
     * Hold the cap BEFORE anything leaves this process.
     *
     * assertDailyCap above refuses early with a useful message, but it ran
     * before the balance read, so it cannot hold against a parallel request.
     * The hold can: nothing yields between counting and recording it. And it
     * is taken before the quote is consumed, so a refusal here leaves no
     * spent quote behind it.
     */
    const held = store.holdDailyCap(user.id, transfer.sendEur, FX.DAILY_CAP_EUR, () =>
      safeFundedEurToday(user.id),
    );
    if (!held.ok) {
      return res.status(409).json({
        error:
          `amount exceeds the daily cap of €${held.capEur.toFixed(2)} ` +
          `(€${held.usedEur.toFixed(2)} already committed today) — ` +
          "another transfer is being prepared or was created today",
      });
    }
    hold.id = held.holdId;
    if (!store.consumeQuote(quote.id)) {
      return res.status(409).json({ error: "quote already consumed" });
    }
    // Fix the exact terms the device is asked to sign. Nothing moves until a
    // matching signature comes back to /authorize. The destination commitment
    // binds the payout target into the signature (see destinationCommitment):
    // the device signs *who* is paid, not only how much.
    const amountWei = eur.toWei(transfer.sendEur);
    const deadline = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC;
    const destination = destinationCommitment(transfer.rail, {
      iban: transfer.recipientIban,
      name: transfer.recipientName,
    });
    transfer.auth = { to: orchestratorAddress, amountWei: amountWei.toString(), destination, deadline };
    // The user-signed debit: a UserOperation moving this transfer's exact
    // amount (the fee alone on the SEPA rail — the payout burns straight from
    // the Safe) to the orchestrator's working address. The passkey signs its
    // hash at send time, so the chain enforces amount and destination; no
    // allowance and no server-relayable spend authority exists at any point.
    let safeExecution:
      | { credentialId: string; challenge: string; amountEur: number; token: "EURE" }
      | undefined;
    // The debit is the fee alone: the payout burns straight from the Safe.
    const debitWei = eur.toWei(Math.max(0, transfer.sendEur - payoutEur));
    if (
      debitWei > 0n &&
      user.passkey?.credentialId &&
      user.passkeySafe?.status === "active" &&
      user.address.toLowerCase() === user.passkeySafe.address.toLowerCase() &&
      !HARNESS.enabled
    ) {
      try {
        const prepared = await prepareTransferExecution(
          user.passkeySafe,
          addrs().eure,
          orchestratorAddress,
          debitWei,
        );
        prunePendingTransferExecutions();
        const challenge = passkeySafeChallenge(prepared.challenge);
        pendingTransferExecutions.set(transfer.id, {
          userId: user.id,
          expiresAt: deadline * 1000,
          challenge,
          plan: user.passkeySafe,
          userOperation: prepared.userOperation,
        });
        safeExecution = {
          credentialId: user.passkey.credentialId,
          challenge,
          amountEur: eur.fromWei(debitWei),
          token: "EURE",
        };
      } catch (err: any) {
        // The transfer is still created: without an execution the debit will
        // refuse with a precise reason, which beats failing creation for a
        // bundler hiccup. Say why here so the refusal is diagnosable.
        console.error(
          `Safe execution preparation failed for ${transfer.id}: ${err?.message ?? err}`,
        );
      }
    }
    /**
     * SEPA is non-custodial for the principal: Monerium's redeem burns the
     * payout straight from the Safe, and only the fee reaches the orchestrator.
     */
    transfer.custody = { mode: "non-custodial", feeToOrchestrator: debitWei > 0n };
    // The hold taken before any partner call becomes this row, in one step.
    store.addTransferUnderHold(transfer, held.holdId);
    return {
      ok: true as const,
      transfer,
      authorization: {
        authorizer,
        safeExecution,
        typedData: paymentAuthorizationTypedData({
          account: user.address,
          amountWei,
          to: orchestratorAddress,
          transferId: transferIdHash(transfer.id),
          destination,
          deadline,
        }),
        moneriumRedeem: transfer.moneriumRedeem
          ? {
              amount: transfer.moneriumRedeem.amount,
              iban: transfer.moneriumRedeem.iban,
              issuedAt: transfer.moneriumRedeem.issuedAt,
              message: transfer.moneriumRedeem.message,
              memo: transfer.moneriumRedeem.memo,
              credentialId: user.passkey?.credentialId,
              challenge: user.passkeySafe?.status === "active"
                ? passkeySafeChallenge(safeMessageHash(user.address, transfer.moneriumRedeem.message))
                : undefined,
            }
          : undefined,
        submitTo: `/api/transfers/${transfer.id}/authorize`,
      },
    };
}

