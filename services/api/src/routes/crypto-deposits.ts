/**
 * Crypto in: what arrived at the payment page, and turning it into euros.
 *
 * THE POLLER DETECTS, IT DOES NOT SIGN. It runs with nobody present, so a
 * deposit sits as detected until the holder is there to authorise the
 * conversion — a missing signature is not a fault and must never be recorded
 * as one.
 *
 * NON-CUSTODIAL BY CONSTRUCTION. The conversion batch approves the venue and
 * swaps out of the user's own Safe, delivering EURe straight back into it.
 * The orchestrator is not in the path and holds nothing at any point.
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
import { store, type User } from "../store.js";
import { custodyBlockerBeforeFunding, requireCapability, requireKycApproved } from "../http/guards.js";
import type { PendingPasskeySafeDeployment } from "../http/pending.js";
import { AUTH_WINDOW_SEC } from "../transfers/build.js";
import { publicUser } from "../users/public-user.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  prepareTransferBatchExecution,
  submitPasskeySafeOperation,
} from "../wallet/candide.js";
import { verifyAssertionForChallenge } from "../webauthn.js";

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
 * Deliberately explicit rather than inferred. Matching an incoming amount to
 * an open invoice by value and date guesses, and a guess written into the
 * books as a fact is worse than an unlinked payment someone has to look at.
 * The account holder says which invoice this was.
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
        invoice: { ...after, linkTokenHash: undefined, linkPasswordHash: undefined },
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
      let opHash: string | null = null;
      try {
        opHash = await submitPasskeySafeOperation(pending.plan, pending.userOperation, {
          authenticatorData: a.authenticatorData,
          clientDataJSON: a.clientDataJSON,
          signature: a.signature,
        });
      } catch (err: any) {
        const reason = String(err?.shortMessage ?? err?.message ?? err);
        store.updateCryptoDeposit(deposit.id, { state: "REFUSED", reason });
        return res.status(502).json({ error: reason });
      }

      const txs = [...deposit.txs, { step: "safe.swap(usdc->eure)", hash: opHash ?? "0x" }];
      const settled = await settleConvertedDeposit(
        deposit, user,
        { provider: pending.quote.provider, rate: BigInt(pending.quote.rate), minOut: BigInt(pending.quote.minOut) },
        before, txs,
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
