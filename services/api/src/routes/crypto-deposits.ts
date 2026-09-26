/**
 * Crypto in: what arrived at the payment page, and turning it into euros.
 *
 * The poller detects and does not sign. It runs with nobody present, so a
 * deposit stays detected until the holder authorises the conversion. A
 * missing signature is not a fault and must not be recorded as one.
 *
 * Non-custodial: the conversion batch approves the venue and swaps out of the
 * user's own Safe, delivering EURe back into it. The orchestrator is not in
 * the path and holds nothing.
 */
import express from "express";
import { wrap } from "./util.js";
import { LIQUIDITY, SECURITY } from "../config.js";
import { accountBalances, addrs, eur, orchestratorAddress } from "../chain.js";
import { safeDebitBlocker } from "../orchestrator.js";
import { prepareDepositConversion } from "../liquidity.js";
import {
  assertRateSane,
  depositConversionBlocker,
  recordInvoiceSettlement,
  settleConvertedDeposit,
} from "../adapters/crypto-deposits.js";
import { store, type CryptoDeposit, type User } from "../store.js";
import { custodyBlockerBeforeFunding, requireCapability, requireKycApproved } from "../http/guards.js";
import type { PendingPasskeySafeDeployment } from "../http/pending.js";
import { AUTH_WINDOW_SEC } from "../transfers/build.js";
import { publicUser } from "../users/public-user.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  prepareTransferBatchExecution,
  submitPasskeySafeOperationWithReceipt,
  type SubmittedOperation,
} from "../wallet/candide.js";
import { publicClient } from "../chain.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import { ownerInvoiceView } from "../domain/invoices.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface CryptoDepositDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const pendingDepositConversions = new Map<string, {
  userId: string;
  expiresAt: number;
  challenge: string;
  plan: NonNullable<User["passkeySafe"]>;
  userOperation: PendingPasskeySafeDeployment;
  quote: { provider: string; rate: string; minOut: string };
}>();

/**
 * Tie a payment to the invoice it settles.
 *
 * The account holder names the invoice. Don't infer it from amount and date:
 * a wrong guess in the books is worse than an unlinked payment.
 */
/**
 * Turn auto-settlement of payment-page crypto on or off.
 *
 * Session-gated to the account itself: this decides whether funds sent to the
 * public page deposit address are swept and settled. It deliberately does not
 * watch the user's main wallet address.
 */
/** What arrived as crypto and what became of it. Read-only; the poller owns
 *  every state change here. */

/**
 * The conversion as the chain recorded it, for the deposit and its Beleg.
 * The block time is read from the chain; a failed read leaves the time
 * absent rather than substituting the server clock.
 */
async function conversionFacts(
  submitted: SubmittedOperation,
  amountInUnits: string,
): Promise<CryptoDeposit["conversion"]> {
  let at: string | undefined;
  if (submitted.blockNumber && submitted.blockNumber > 0) {
    try {
      const blk = await publicClient.getBlock({ blockNumber: BigInt(submitted.blockNumber) });
      at = new Date(Number(blk.timestamp) * 1000).toISOString();
    } catch { /* recorded without a time rather than with the wrong one */ }
  }
  return {
    ...(submitted.userOpHash ? { userOpHash: submitted.userOpHash } : {}),
    ...(submitted.txHash ? { txHash: submitted.txHash } : {}),
    ...(submitted.blockNumber !== undefined ? { blockNumber: submitted.blockNumber } : {}),
    ...(at ? { at } : {}),
    amountInUnits,
    ...(submitted.gasCostWei ? { gasCostWei: submitted.gasCostWei } : {}),
    gasPaidBy: submitted.gasPaidBy,
  };
}

export function createCryptoDepositRouter(deps: CryptoDepositDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/users/:id/crypto-deposits/:depositId/invoice",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const deposit = store.cryptoDeposits.find(
        (d) => d.id === req.params.depositId && d.userId === user.id,
      );
      if (!deposit) return res.status(404).json({ error: "deposit not found" });

      const invoiceId = req.body?.invoiceId;
      if (invoiceId === null) {
        store.updateCryptoDeposit(deposit.id, { invoiceId: undefined });
        return res.json({ deposit: store.cryptoDeposits.find((d) => d.id === deposit.id) });
      }
      const invoice = store.invoices.find((i) => i.id === String(invoiceId ?? ""));
      // An invoice belongs to an organisation; only an active member of that
      // organisation may tie a payment to it. The id is not a capability.
      const member = invoice
        ? store.membersOf(invoice.orgId).some((m) => m.userId === user.id && m.status === "active")
        : false;
      if (!invoice || !member) return res.status(404).json({ error: "invoice not found" });

      const linked = store.updateCryptoDeposit(deposit.id, { invoiceId: invoice.id });
      // Already converted? Then the whole thread is known now and belongs on the
      // invoice immediately, rather than waiting for a conversion that happened
      // before the link existed.
      if (linked.state === "CONVERTED") recordInvoiceSettlement(linked);
      const after = store.invoices.find((i) => i.id === invoice.id)!;
      res.json({
        deposit: store.cryptoDeposits.find((d) => d.id === deposit.id),
        invoice: ownerInvoiceView(after),
      });
    }),
  );

  router.post(
    "/users/:id/crypto-deposits/:depositId/convert/prepare",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "onchain_balance", res)) return;

      const deposit = store.cryptoDeposits.find(
        (d) => d.id === req.params.depositId && d.userId === user.id,
      );
      if (!deposit) return res.status(404).json({ error: "deposit not found" });

      const blocker = depositConversionBlocker(user, deposit);
      if (blocker) return res.status(409).json({ error: blocker });
      const safeBlocker = safeDebitBlocker(user);
      if (safeBlocker) return res.status(409).json({ error: safeBlocker });

      try {
        const swap = await prepareDepositConversion(
          user.address as `0x${string}`,
          BigInt(deposit.amountUnits),
          `crypto-in-${deposit.id}`,
        );
        if (!swap) {
          return res.status(503).json({
            error:
              `the configured liquidity venue (${LIQUIDITY.PROVIDER}) cannot be executed by your ` +
              "account, so this deposit cannot be converted here. dex, lifi, rfq or best can.",
          });
        }
        // No fee on a conversion: the user is converting their own money and
        // keeping it. transferSwapBatchTransactions skips the fee leg at 0.
        const prepared = await prepareTransferBatchExecution(user.passkeySafe!, {
          token: addrs().usdc,
          feeTo: orchestratorAddress,
          feeAmount: 0n,
          approval: { spender: swap.plan.approval.spender, amount: swap.plan.approval.amount },
          call: swap.plan.call,
        });
        const challenge = passkeySafeChallenge(prepared.challenge);
        for (const [id, p] of pendingDepositConversions) {
          if (p.expiresAt < Date.now()) pendingDepositConversions.delete(id);
        }
        pendingDepositConversions.set(deposit.id, {
          userId: user.id,
          expiresAt: Date.now() + AUTH_WINDOW_SEC * 1000,
          challenge,
          plan: user.passkeySafe!,
          userOperation: prepared.userOperation,
          quote: {
            provider: swap.plan.quote.provider,
            rate: swap.plan.quote.rate.toString(),
            minOut: swap.plan.quote.minOut.toString(),
          },
        });
        res.json({
          depositId: deposit.id,
          credentialId: user.passkey?.credentialId,
          challenge,
          amountUsdc: deposit.amountUsdc,
          expectedEur: eur.fromWei(swap.plan.quote.expectedOut),
          minEur: eur.fromWei(swap.plan.quote.minOut),
          provider: swap.plan.quote.provider,
        });
      } catch (err: any) {
        res.status(502).json({ error: String(err?.shortMessage ?? err?.message ?? err) });
      }
    }),
  );

  router.post(
    "/users/:id/crypto-deposits/:depositId/convert",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "onchain_balance", res)) return;

      const deposit = store.cryptoDeposits.find(
        (d) => d.id === req.params.depositId && d.userId === user.id,
      );
      if (!deposit) return res.status(404).json({ error: "deposit not found" });

      // Claim the pending execution BEFORE any await, so two parallel submissions
      // of one signature cannot both proceed — the same race the transfer
      // authorize path had, and the same fix.
      const pending = pendingDepositConversions.get(deposit.id);
      if (!pending) {
        return res.status(409).json({ error: "no prepared conversion — call convert/prepare first" });
      }
      pendingDepositConversions.delete(deposit.id);
      if (pending.userId !== user.id) {
        return res.status(403).json({ error: "this conversion belongs to a different account" });
      }

      const a = req.body?.executionAssertion;
      if (!a?.authenticatorData || !a?.clientDataJSON || !a?.signature) {
        return res.status(400).json({
          error: "executionAssertion requires authenticatorData, clientDataJSON and signature",
        });
      }
      if (!user.passkey?.publicKey) {
        return res.status(409).json({ error: "no passkey registered for this account" });
      }
      if (a.credentialId !== user.passkey.credentialId) {
        return res.status(403).json({ error: "passkey credential does not match this account" });
      }

      try {
        const { signCount } = await verifyAssertionForChallenge(
          a.authenticatorData, a.clientDataJSON, a.signature,
          user.passkey.publicKey, user.passkey.signCount ?? 0,
          user.passkey.rpId ?? SECURITY.rpId, SECURITY.origins, pending.challenge,
        );
        store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }

      // Measure BEFORE submitting: the credited amount is the balance delta, not
      // anything the quote promised.
      const before = eur.toWei(await accountBalances(user.address).then((b) => b.safeBalanceEur));
      // The rate sanity check runs BEFORE the user-signed swap lands: after it,
      // a rate-feed outage would leave the EURe in the Safe with the deposit
      // still marked ready to convert.
      try {
        await assertRateSane(BigInt(pending.quote.rate));
      } catch (err: any) {
        return res.status(503).json({ error: String(err?.message ?? err) });
      }
      let submitted: SubmittedOperation;
      try {
        // The browser sends base64url; the Safe signature needs the bytes,
        // exactly as the transfer path decodes them.
        submitted = await submitPasskeySafeOperationWithReceipt(pending.plan, pending.userOperation, {
          authenticatorData: b64urlToBuf(a.authenticatorData),
          clientDataJSON: b64urlToBuf(a.clientDataJSON),
          signature: b64urlToBuf(a.signature),
        });
      } catch (err: any) {
        const reason = String(err?.shortMessage ?? err?.message ?? err);
        store.updateCryptoDeposit(deposit.id, { state: "REFUSED", reason });
        return res.status(502).json({ error: reason });
      }

      // The chain's transaction hash is what an auditor resolves; the userOp
      // hash is kept beside it because it is what the bundler answers for.
      const txs = [
        ...deposit.txs,
        { step: "safe.swap(usdc->eure)", hash: submitted.txHash ?? submitted.userOpHash ?? "0x" },
        ...(submitted.txHash && submitted.userOpHash ? [{ step: "userOperation", hash: submitted.userOpHash }] : []),
      ];
      const settled = await settleConvertedDeposit(
        deposit, user,
        { provider: pending.quote.provider, rate: BigInt(pending.quote.rate), minOut: BigInt(pending.quote.minOut) },
        before, txs,
        await conversionFacts(submitted, deposit.amountUnits),
      );
      const balances = await accountBalances(user.address);
      res.json({ deposit: settled, ...balances });
    }),
  );

  router.post(
    "/users/:id/auto-convert",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be true or false" });
      }
      // The output is e-money, so the same gate that gates a SEPA deposit
      // applies. Say so plainly rather than accepting the setting and silently
      // refusing every deposit later.
      if (enabled && !requireKycApproved(user, res)) return;
      const custodyBlocked = enabled ? custodyBlockerBeforeFunding(user) : null;
      if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
      const page = user.paymentPage;
      if (!page) return res.status(409).json({ error: "claim a payment page before enabling auto-settlement" });
      const updated = store.updateUser(user.id, {
        paymentPage: { ...page, autoConvert: enabled, updatedAt: new Date().toISOString() },
      });
      res.json({ ...publicUser(updated), ...(await accountBalances(updated.address).catch(() => ({}))) });
    }),
  );

  router.get(
    "/users/:id/crypto-deposits",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      res.json({
        autoConvert: !!user.paymentPage?.autoConvert,
        settlementAsset: user.paymentPage?.settlementAsset ?? "USDC",
        depositAddress: user.paymentPage?.depositAddress,
        deposits: store.cryptoDeposits
          .filter((d) => d.userId === user.id)
          .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
      });
    }),
  );

  return router;
}
