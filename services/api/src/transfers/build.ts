import { randomUUID } from "node:crypto";
import { BRIDGE, CUSTODY, FX, HARNESS, LIQUIDITY, railFeeEur } from "../config.js";
import {
  accountBalances,
  addrs,
  destinationCommitment,
  eur,
  orchestratorAddress,
  paymentAuthorizationTypedData,
  transferIdHash,
} from "../chain.js";
import { createBridgeTransfer } from "../bridge/bridgexyz.js";
import { prepareSafeSwapForTransfer } from "../liquidity.js";
import { moneriumRedeemMessage, paymentMemo } from "../sepa.js";
import { safeDebitBlocker, safeFundedEurToday } from "../orchestrator.js";
import { store, type Quote, type Transfer } from "../store.js";
import { assertDailyCap, requireKycApproved } from "../http/guards.js";
import { pendingTransferExecutions, prunePendingTransferExecutions } from "../http/pending.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  CANDIDE,
  prepareTransferBatchExecution,
  prepareTransferExecution,
  safeMessageHash,
} from "../wallet/candide.js";

/** How long a device signature stays submittable. */
export const AUTH_WINDOW_SEC = 15 * 60;

/**
 * Build a transfer from an open quote, and the authorization the device must
 * sign for it.
 *
 * ONE CODE PATH. This was extracted from POST /api/transfers unchanged so that
 * draft execution creates transfers the SAME way. A second, parallel
 * construction would be the classic route by which one caller quietly skips a
 * balance check, a daily cap, or the destination commitment — so the business
 * router is handed this function rather than being trusted to rebuild it.
 *
 * It returns a discriminated result rather than writing to a response: it has
 * two callers and only one of them owns an HTTP response. The `res` it passes
 * to requireKycApproved / assertDailyCap is a collector whose
 * `.status(x).json(y)` evaluates to the failure result itself, so every
 * refusal below reads exactly as it did when this was a route.
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
    recipientPhone?: string;
    recipientIban?: string;
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
    recipientPhone?: string;
    recipientIban?: string;
    reference?: string;
  },
  hold: { id?: string },
): Promise<TransferBuildResult> {
  const { res, out } = responseCollector();
  const { recipientName, recipientPhone, recipientIban, reference } = recipient;
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
      recipientPhone,
      recipientIban,
      reference: reference || undefined,
      state: "CREATED" as const,
      sendEur: quote.sendEur,
      receiveKes: quote.receiveKes,
      receiveEur: quote.receiveEur,
      fundingSource,
      txs: [],
      createdAt,
      updatedAt: createdAt,
    };
    if (transfer.rail === "sepa" && transfer.recipientIban) {
      const payoutEur = transfer.receiveEur ?? transfer.sendEur - railFeeEur("sepa");
      const redeem = moneriumRedeemMessage(payoutEur, transfer.recipientIban, createdAt);
      transfer.moneriumRedeem = {
        ...redeem,
        memo: paymentMemo(transfer.id, transfer.reference),
      };
    }
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
     * is taken before the quote is consumed and, on the cash rail, before a
     * live Bridge transfer is created — a refusal here leaves no spent quote
     * and no unfunded transfer at Bridge behind it.
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
      phone: transfer.recipientPhone,
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
    /**
     * Which custody mode this transfer will actually run in, recorded on the
     * transfer itself. Starts at the honest worst case and is narrowed only
     * when a Safe-executed batch is genuinely prepared — so a venue outage or
     * a missing config leaves the truthful answer behind rather than an
     * optimistic one nobody revisited.
     *
     * The SEPA rail is already non-custodial for the principal: Monerium's
     * redeem burns the payout straight from the Safe and only the fee moves.
     */
    let custody: NonNullable<Transfer["custody"]> =
      transfer.rail === "sepa"
        ? { mode: "non-custodial", feeToOrchestrator: transfer.sendEur > (transfer.receiveEur ?? 0) }
        : {
            mode: "orchestrator",
            reason: "no Safe-executed swap batch was prepared for this transfer",
            feeToOrchestrator: true,
          };
    const debitWei =
      transfer.rail === "sepa"
        ? eur.toWei(Math.max(0, transfer.sendEur - (transfer.receiveEur ?? transfer.sendEur - railFeeEur("sepa"))))
        : amountWei;
    if (
      debitWei > 0n &&
      user.passkey?.credentialId &&
      user.passkeySafe?.status === "active" &&
      user.address.toLowerCase() === user.passkeySafe.address.toLowerCase() &&
      // A legacy 2-of-2 Safe needs the co-signer KEY to counter-sign; a passkey-only
      // Safe needs nothing beyond the user's assertion. Deliberately the same
      // condition as the orchestrator's passkeySafeExecutionReady: requiring
      // more here (the address env var, say) would create transfers that pass
      // the readiness blocker but silently never get an execution prepared,
      // and then fail at authorize blaming the user.
      (!user.passkeySafe.cosignerAddress || CANDIDE.cosignerKey) &&
      !HARNESS.enabled
    ) {
      try {
        let prepared: Awaited<ReturnType<typeof prepareTransferExecution>> | undefined;
        let batch: { recipient: `0x${string}`; mode: "live" } | undefined;
        // Cash rail: try the full fee+approve+swap batch first (Change 2,
        // windows 1-3) — one signature, atomic, and the orchestrator never
        // holds the input. Falls back to the plain user-signed debit when the
        // configured venue cannot serve a Safe executor (FxSwapper, CoW) or
        // the venue is down; the fallback still never moves without the user.
        if (transfer.rail === "cash") {
          try {
            // A cash transfer exists only while the rail is open (BRIDGE_LIVE
            // and an anchor — /api/quotes refuses otherwise), so the output
            // always lands at Bridge's deposit address for this transfer.
            if (!BRIDGE.destinationAddress) {
              // Same refusal bridgeDestination() gives at execute — refuse
              // here rather than posting Bridge a transfer with an empty
              // to_address and discovering it one leg later.
              throw new Error(
                "BRIDGE_LIVE=1 requires BRIDGE_DESTINATION_ADDRESS until MoneyGram anchor payment instructions are wired into Bridge",
              );
            }
            const convertEur = transfer.sendEur - railFeeEur("cash");
            const rate = Number(quote.lockedSwapRate ?? "0") / 1e6;
            if (!(rate > 0)) throw new Error("no locked swap rate to size the Bridge transfer");
            const bridgeAmountUsdc = Math.floor(convertEur * rate * 100) / 100;
            let recipient: `0x${string}`;
            {
              const bridgePlan = await createBridgeTransfer(
                transfer.id,
                bridgeAmountUsdc,
                {
                  paymentRail: BRIDGE.destinationRail,
                  currency: BRIDGE.destinationCurrency,
                  toAddress: BRIDGE.destinationAddress,
                  blockchainMemo: BRIDGE.destinationMemo || undefined,
                },
                { sourceAddress: user.address },
              );
              const deposit = bridgePlan.sourceDepositInstructions?.to_address;
              if (!deposit || !/^0x[a-fA-F0-9]{40}$/.test(deposit)) {
                throw new Error("Bridge returned no Base deposit address for the swap to deliver into");
              }
              recipient = deposit as `0x${string}`;
            }
            const swap = await prepareSafeSwapForTransfer(transfer, {
              executor: user.address as `0x${string}`,
              recipient,
            });
            if (swap) {
              const convertWei = swap.plan.approval.amount;
              // Equality is the legitimate zero-fee shape; only a convert
              // amount EXCEEDING the signed debit total is incoherent.
              if (convertWei > debitWei) throw new Error("swap amount exceeds the authorized debit total");
              prepared = await prepareTransferBatchExecution(user.passkeySafe, {
                token: addrs().eure,
                feeTo: orchestratorAddress,
                // Exact by construction: fee + convert always equals the
                // debited total, whatever floating-point did to the euros.
                feeAmount: debitWei - convertWei,
                approval: { spender: swap.plan.approval.spender, amount: convertWei },
                call: swap.plan.call,
              });
              batch = { recipient, mode: "live" };
              // The batch delivers straight to Bridge's deposit address, so
              // the input never reaches an address we hold a key to.
              custody = { mode: "non-custodial", feeToOrchestrator: true };
              transfer.liquidity = swap.serialized;
              transfer.safeSwap = {
                recipient,
                mode: "live",
                // The amount the live Bridge transfer was created with. Execute
                // must re-create with EXACTLY this body — the idempotency key
                // is shared, and an idempotent replay with a different amount
                // is either rejected or silently ignored.
                bridgeAmountUsdc,
              };
            }
            if (!swap) {
              custody = {
                mode: "orchestrator",
                reason:
                  `the configured liquidity venue (${LIQUIDITY.PROVIDER}) cannot be executed by the ` +
                  "user's Safe, so the input is debited to the orchestrator and swapped from there",
                feeToOrchestrator: true,
              };
            }
          } catch (err: any) {
            custody = {
              mode: "orchestrator",
              reason: `Safe-executed batch unavailable: ${err?.message ?? err}`,
              feeToOrchestrator: true,
            };
            console.error(
              `Safe swap batch unavailable for ${transfer.id} (falling back to plain debit): ${err?.message ?? err}`,
            );
          }
        }
        prepared ??= await prepareTransferExecution(
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
          ...(batch ? { batch } : {}),
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
     * Turn the preference into a guarantee where an operator asked for one.
     *
     * REQUIRE_NON_CUSTODIAL=1 means this deployment has promised it does not
     * take possession of client funds, so a fallback to the orchestrator is a
     * broken promise, not a degraded mode — refuse and name the cause rather
     * than moving money in a way the deployment says it does not.
     *
     * This spends the quote (consumed above). That is acceptable precisely
     * because every cause here is a deployment-wide condition — the venue
     * cannot serve a Safe, Bridge is not live — so it fails on the first
     * transfer and is fixed once, not intermittently for one unlucky user.
     */
    if (CUSTODY.requireNonCustodial && custody.mode === "orchestrator") {
      return res.status(409).json({
        error:
          "refusing to create this transfer: REQUIRE_NON_CUSTODIAL=1 but it would route the sender's " +
          `funds through the orchestrator — ${custody.reason ?? "no Safe-executed batch was prepared"}`,
        custody,
      });
    }
    transfer.custody = custody;
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

