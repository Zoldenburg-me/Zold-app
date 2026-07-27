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
import { FX, moneriumSandboxEnabled, USING_LOCAL_RPC } from "./config.js";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyTypedData } from "viem";
import { AnchorPaymentUncertainError } from "./stellar/anchor.js";
import { store, type Transfer, type TransferState, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { paymentMemo } from "./sepa.js";
import { simulateSepaDeposit } from "./adapters/monerium.js";
import { bridgeUsdcToStellar, CctpBridgeError, type CctpPlan } from "./bridge/cctp.js";
import {
  executeTransferLiquidity,
  liquidityAmountOutUnits,
  liquidityProvider,
  prepareTransferLiquidity,
  serializeExecution,
} from "./liquidity.js";
import {
  abis,
  addrs,
  destinationCommitment,
  eur,
  usd,
  orchestratorAddress,
  forwardEureForRedeem,
  orchestratorWallet,
  paymentAuthorizationTypedData,
  publicClient,
  transferIdHash,
  writeAndWait,
} from "./chain.js";
import { transferTokenFromSafe } from "./wallet/candide.js";
import {
  createCashPickup,
  createCashPickupViaAnchor,
  completePickup,
  fundAndRefreshAnchorPickup,
  getPickup,
} from "./adapters/moneygram.js";
import { anchorModeEnabled, CCTP, SECURITY, STELLAR } from "./config.js";
import { creditVpa } from "./adapters/upi.js";

/**
 * FP4: the user's device signature over this payment's exact terms. The
 * orchestrator cannot produce one — it can only carry it to the vault.
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
async function assertQuoteRateBinding(transfer: Transfer): Promise<void> {
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
 * Recompute the destination commitment from the payout this orchestrator is
 * about to make. It is derived from the transfer's *current* recipient, not
 * from a value cached at signing time, so if the stored recipient was altered
 * after the device signed, the recomputed commitment no longer matches the
 * signature and RemitVault.debit reverts with "bad authorization".
 */
function transferDestination(transfer: Transfer): `0x${string}` {
  return destinationCommitment(transfer.rail, {
    phone: transfer.recipientPhone,
    iban: transfer.recipientIban,
    vpa: transfer.recipientVpa,
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
  const authorizer = await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "authorizerOf",
    args: [user.address],
  }) as `0x${string}`;
  if (authorizer === "0x0000000000000000000000000000000000000000") {
    throw new Error("no authorizer");
  }
  const code = await publicClient.getBytecode({ address: authorizer });
  if (code && code !== "0x") {
    throw new Error("Safe-funded transfer needs on-chain policy for contract authorizers");
  }
  const ok = await verifyTypedData({
    address: authorizer,
    ...paymentAuthorizationTypedData({
      account: user.address,
      amountWei,
      to: orchestratorAddress,
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
  const tid = transferIdHash(transfer.id);
  const sendWei = eur.toWei(transfer.sendEur);

  if (transfer.fundingSource === "safe") {
    await assertDeviceAuthorization(transfer, user, auth);
    if (!user.privateKey) throw new Error("user has no wallet key to move Safe-held EURe");
    const moveHash = await transferTokenFromSafe({
      ownerKey: user.privateKey,
      token: a.eure,
      to: orchestratorAddress,
      amount: sendWei,
    });
    txs.push({ step: "safe.transfer(orchestrator)", hash: moveHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("safe.transfer");
    return;
  }

  const debitHash = await writeAndWait(orchestratorWallet, {
    address: a.vault,
    abi: abis.RemitVault,
    functionName: "debit",
    args: [
      user.address,
      sendWei,
      orchestratorAddress,
      tid,
      transferDestination(transfer),
      BigInt(auth.deadline),
      auth.signature,
    ],
  });
  txs.push({ step: "vault.debit", hash: debitHash });
  store.updateTransfer(transfer.id, { state: "DEBITED", txs });
  failpoint("vault.debit");
}

function cctpRecipientStellar(): string {
  const explicit = process.env.CCTP_STELLAR_RECIPIENT;
  if (explicit) return explicit;
  if (STELLAR.treasurySecret) return Keypair.fromSecret(STELLAR.treasurySecret).publicKey();
  if (CCTP.live) throw new Error("CCTP_LIVE=1 requires CCTP_STELLAR_RECIPIENT or STELLAR_TREASURY_SECRET");
  return Keypair.random().publicKey();
}

function recordCctpPlan(txs: Transfer["txs"], plan: CctpPlan) {
  txs.push({ step: `cctp.${plan.mode}.plan`, hash: plan.burnTx.data.slice(0, 66) });
  if (plan.approveTxHash) txs.push({ step: "cctp.approve", hash: plan.approveTxHash });
  if (plan.burnTxHash) txs.push({ step: "cctp.burn", hash: plan.burnTxHash });
  if (plan.attestation) txs.push({ step: "cctp.attestation", hash: plan.attestation.message.slice(0, 66) });
  txs.push({ step: "cctp.mint.prepared", hash: plan.stellarMint.contract });
  if (plan.stellarMintTxHash) txs.push({ step: "cctp.mint_and_forward", hash: plan.stellarMintTxHash });
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
  // The vault refused this debit because this transferId was already debited —
  // another submission of the same authorization got there first. A refund here
  // would hand back money whose payout is in flight, so this is review-only.
  // (The API now claims an authorization before it can be submitted twice; this
  // is the backstop for any other route to the same revert.)
  if (/duplicate transfer/i.test(message)) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${message}; this transfer was already debited once, so no automatic refund`,
      txs,
    });
  }
  if (txs.some((x) => x.step === "cctp.burn")) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${failed.error}; CCTP burn was submitted, so automatic local refund is unsafe until the burn/mint/anchor state is reconciled`,
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

/** Walk a failed transfer backwards: release escrow if locked, value the
 *  recovered assets at current rates, re-credit the sender's vault. */
export async function compensateTransfer(id: string): Promise<Transfer> {
  const t = store.findTransfer(id);
  if (!t) throw new Error(`unknown transfer ${id}`);
  if (t.state === "REFUNDED" || t.state === "PAID" || t.refund) return t;
  const user = store.findUser(t.userId);
  if (!user) throw new Error(`unknown user for transfer ${id}`);
  const steps = new Set(t.txs.map((x) => x.step));
  const now = () => new Date().toISOString();

  if (!steps.has("vault.debit")) {
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
  const fee = t.rail === "upi" ? FX.UPI_FIXED_FEE_EUR : FX.FIXED_FEE_EUR;
  if (!steps.has("liquidity.fx-swapper.eure-usdc") && !steps.has("swapper.swapExactIn")) {
    // Still holding the debited EURe in full.
    refundEur = t.sendEur;
    recoveredFrom = "debited EURe";
  } else {
    // Holding the fee remainder (EURe) + the swapped USDC; convert the USDC
    // back at the CURRENT rate — the user bears rate movement, itemized.
    const rate = (await publicClient.readContract({
      address: addrs().swapper,
      abi: abis.FxSwapper,
      functionName: "rate",
      args: [],
    })) as bigint;
    const eurBack = (t.usdcOut ?? 0) / (Number(rate) / 1e6);
    refundEur = Math.floor((fee + eurBack) * 100) / 100;
    recoveredFrom = steps.has("bridge.lockForPayout") ? "released escrow" : "post-swap USDC";
    const lost = Math.max(0, t.sendEur - refundEur);
    if (lost > 0) deductions = `€${lost.toFixed(2)} conversion round-trip at current rate`;
  }

  if (!USING_LOCAL_RPC) {
    // Whoever picks this up needs to know where the euros physically are. On
    // the SEPA rail we may already have forwarded the payout into the user's
    // own Safe for the redeem to burn — if the redeem then failed, that money
    // is with the user, and re-crediting the vault as well would pay them
    // twice. Say so here rather than leaving it to be rediscovered.
    const forwarded = txs.find((x) => x.step === "eure.transfer(user-safe)");
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error:
        "automatic refund requires minting EURe, which we cannot do off a local chain; " +
        "refusing on non-local RPC until a treasury-funded refund path exists" +
        (forwarded
          ? `. NOTE: €${refundEur} was already forwarded to the user's Safe for the redeem ` +
            `(tx ${forwarded.hash}) — check whether the redeem burned it before refunding anything`
          : ""),
      txs,
    });
  }

  const { creditHash } = await simulateSepaDeposit(user.address, refundEur, `refund-${t.id}`);
  txs.push({ step: "vault.refundCredit", hash: creditHash });
  console.log(`FP3: refunded €${refundEur} to ${user.name} for transfer ${t.id} (${recoveredFrom})`);
  return store.updateTransfer(id, {
    state: "REFUNDED",
    txs,
    refund: { amountEur: refundEur, recoveredFrom, deductions, at: now() },
  });
}

/** Recovery sweep: compensate FAILED transfers that moved money, and
 *  fail-then-compensate transfers stranded mid-flow (e.g. by a crash). */
export async function sweepStrandedTransfers(): Promise<number> {
  const STALE_MS = 10 * 60_000;
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      if (t.state === "FAILED" && !t.refund && t.txs.some((x) => x.step === "vault.debit")) {
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

    // 3. Bridge USDC toward Stellar. In dry-run mode we record the exact CCTP
    //    burn/mint plan and keep the local escrow leg so the no-credential demo
    //    can still complete. With CCTP_LIVE=1, the CCTP worker submits the Base
    //    Sepolia burn and polls Iris; failures after burn go to manual review.
    let cctpPlan: CctpPlan;
    try {
      cctpPlan = await bridgeUsdcToStellar(usd.fromUnits(expectedOut), cctpRecipientStellar());
      recordCctpPlan(txs, cctpPlan);
    } catch (err) {
      if (err instanceof CctpBridgeError) recordCctpPlan(txs, err.plan);
      throw err;
    }

    if (cctpPlan.mode !== "live") {
      const approveBridgeHash = await writeAndWait(orchestratorWallet, {
        address: a.usdc,
        abi: abis.MockToken,
        functionName: "approve",
        args: [a.bridge, expectedOut],
      });
      txs.push({ step: "usdc.approve(bridge)", hash: approveBridgeHash });

      const lockHash = await writeAndWait(orchestratorWallet, {
        address: a.bridge,
        abi: abis.BridgeEscrow,
        functionName: "lockForPayout",
        args: [tid, expectedOut, "stellar", `mgi:${transfer.recipientPhone}`],
      });
      txs.push({ step: "bridge.lockForPayout", hash: lockHash });
    }
    store.updateTransfer(transfer.id, { state: "BRIDGED", txs });
    failpoint(cctpPlan.mode === "live" ? "cctp.burn" : "bridge.lockForPayout");

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
 * UPI (India point-of-sale) rail:
 *   CREATED -> DEBITED -> SWAPPED -> PAID
 * Debits the sender's vault, swaps EURe -> USDC on-chain (the USDC is the
 * partner-settlement pool), then the UPI partner credits the recipient VPA
 * from its INR float instantly and returns a UTR. Mock partner for now; the
 * production adapter is a licensed Indian PA/PPI (TerraPay-style API).
 */
export async function executeUpiTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const txs = transfer.txs;

  try {
    await debitInputFunds(transfer, user, auth, txs);

    // Swap the convertible portion to USDC — the settlement asset we net
    // against the partner's INR float.
    await assertQuoteRateBinding(transfer);
    const liquidityPlan = await prepareTransferLiquidity(transfer);
    store.updateTransfer(transfer.id, { liquidity: liquidityPlan });
    const liquidity = await executeTransferLiquidity({ ...transfer, liquidity: liquidityPlan });
    txs.push(...liquidity.txs);
    store.updateTransfer(transfer.id, {
      state: "SWAPPED",
      txs,
      usdcOut: liquidityAmountOutUnits(liquidity.quote),
      liquidity: serializeExecution(liquidity),
    });

    // Partner credits the VPA from its INR float — instant on real UPI too.
    const credit = creditVpa(transfer.id, transfer.recipientVpa!, transfer.receiveInr!);
    return store.updateTransfer(transfer.id, {
      state: "PAID",
      upi: { provider: credit.provider, utr: credit.utr, state: credit.state },
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  }
}

/**
 * SEPA (bank payout) rail:
 *   CREATED -> DEBITED -> PAYOUT_SUBMITTED -> PAID
 * Debits the sender's vault on the local chain, then places a real Monerium
 * redeem order (EURe burned from the user's Safe, SEPA out to the recipient
 * IBAN). If the real order is rejected — typically because the Safe holds no
 * EURe on the sandbox chain — the payout falls back to a simulated SEPA leg
 * and records why, so the corridor still demos end to end.
 */
export async function executeSepaTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const txs = transfer.txs;

  try {
    await debitInputFunds(transfer, user, auth, txs);

    const payoutEur = transfer.receiveEur ?? transfer.sendEur - FX.FIXED_FEE_EUR;
    const [firstName, ...rest] = transfer.recipientName.trim().split(/\s+/);
    const counterpart = {
      iban: transfer.recipientIban!,
      firstName,
      lastName: rest.join(" ") || firstName,
      country: user.country || "DE",
    };

    if (moneriumSandboxEnabled()) {
      try {
        /**
         * On a chain where the vault holds Monerium's real EURe, the euros are
         * now sitting with the orchestrator (that is where debit sent them),
         * but a redeem burns from the user's OWN Safe — Monerium proves
         * ownership by asking the Safe to sign (EIP-1271). So the payout
         * amount has to be forwarded to the Safe before the redeem, or
         * Monerium has nothing to burn and the order fails.
         *
         * Only `payoutEur` moves, not the whole debit: the difference is our
         * fee, and it stays with the orchestrator. Sending the full amount
         * would hand the fee to the user and we would never collect it.
         *
         * On a local chain the vault holds a mock EURe that Monerium has
         * never heard of, so there is nothing to forward.
         */
        const forwardHash = await forwardEureForRedeem(user.address, payoutEur);
        if (forwardHash) txs.push({ step: "eure.transfer(user-safe)", hash: forwardHash });

        const order = await redeemToIban(
          user,
          payoutEur,
          counterpart,
          paymentMemo(transfer.id, transfer.reference),
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

/** Refresh an anchor-backed cash payout. If the anchor has supplied payment
 * instructions, fund it on-ledger and mark PAID only after anchor completion. */
export async function refreshPayout(
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
    // that would pay twice. Same reasoning as a submitted CCTP burn.
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
