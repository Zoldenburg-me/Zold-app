/**
 * Quotes and transfers: the money path's HTTP surface.
 *
 * Transfers are built in transfers/build.ts, which draft execution also
 * calls; these routes own the request shape, the reads and the send-time
 * authorization. Don't build transfers here: there must be one builder.
 */
import express from "express";
import { wrap } from "./util.js";
import { FX, SECURITY, railFeeEur } from "../config.js";
import { ibanChecksumValid, normaliseIban } from "../domain/contacts.js";
import { createQuote, isExpired } from "../fx.js";
import { SEPA_REMITTANCE_MAX } from "../sepa.js";
import {
  cashRailOpen,
  executeSepaTransfer,
  executeTransfer,
  refreshPayout,
} from "../orchestrator.js";
import { store } from "../store.js";
import { requireCapability, requireKycApproved } from "../http/guards.js";
import { pendingTransferExecutions, prunePendingTransferExecutions } from "../http/pending.js";
import { buildTransferFromQuote } from "../transfers/build.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import { safeMessageHash, signMessageAsPasskeySafe } from "../wallet/candide.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import { verifyPasskeyStepUp } from "./auth.js";
import { publicUser } from "../users/public-user.js";

/** requireUserSession is injected — server.ts owns authentication. */
export interface TransferDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


// --- Quotes & transfers ------------------------------------------------------

/**
 * Register the device key that may authorize transfers from this account.
 * The browser generates the key, keeps the private half, and sends only the
 * address. This binding is app state until Safe-native module policies replace
 * it on-chain.
 */
/**
 * Submit the device signature for a CREATED transfer and execute it.
 * The terms were fixed at creation, so the signature covers exactly what the
 * orchestrator submits — it cannot re-price or redirect the payment.
 */

export function createTransferRouter(deps: TransferDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/quotes",
    wrap(async (req, res) => {
      const { userId, sendEur, rail = "cash" } = req.body ?? {};
      if (rail === "cash" && !cashRailOpen()) {
        return res.status(503).json({
          error: "the cash rail is not open on this deployment — Bridge and the payout anchor are not configured",
          code: "RAIL_CLOSED",
        });
      }
      const user = store.findUser(userId);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireCapability(user, "onchain_balance", res)) return;
      if (!requireKycApproved(user, res)) return;
      if (!["cash", "sepa"].includes(rail)) {
        return res.status(400).json({ error: "rail must be cash or sepa" });
      }
      const amount = Number(sendEur);
      const railFee = railFeeEur(rail);
      if (!(amount > railFee)) {
        return res.status(400).json({ error: railFee > 0 ? `amount must exceed the €${railFee} fee` : "amount must be positive" });
      }
      if (amount > FX.DAILY_CAP_EUR) {
        return res.status(400).json({ error: `amount exceeds daily cap of €${FX.DAILY_CAP_EUR}` });
      }
      res.status(201).json(await createQuote(userId, { rail, sendEur: amount }));
    }),
  );

  router.post(
    "/transfers",
    wrap(async (req, res) => {
      const { quoteId, recipientName, recipientPhone, recipientIban, reference } = req.body ?? {};
      const quote = store.findQuote(quoteId);
      if (!quote) return res.status(404).json({ error: "quote not found" });
      if (!requireUserSession(req, res, quote.userId)) return;
      if ((quote.status ?? "OPEN") !== "OPEN") {
        return res.status(409).json({ error: `quote already ${quote.status.toLowerCase()}` });
      }
      if (isExpired(quote)) {
        store.updateQuote(quote.id, { status: "EXPIRED" });
        return res.status(410).json({ error: "quote expired, request a new one" });
      }
      if (typeof recipientName !== "string" || !recipientName.trim() || recipientName.length > 140) {
        return res.status(400).json({ error: "recipientName required (up to 140 characters)" });
      }
      if (quote.rail === "sepa") {
        if (typeof recipientIban !== "string" || !recipientIban.trim()) {
          return res.status(400).json({ error: "recipientIban required for bank payout" });
        }
        if (!ibanChecksumValid(normaliseIban(recipientIban))) {
          return res.status(400).json({ error: "recipientIban is not a valid IBAN" });
        }
      }
      if (quote.rail === "cash" && (typeof recipientPhone !== "string" || !recipientPhone.trim() || recipientPhone.length > 32)) {
        return res.status(400).json({ error: "recipientPhone required for cash pickup" });
      }
      // Remittance reference: carried to the payee on the SEPA rail so they can
      // reconcile the payment against their own records. Refused rather than
      // truncated past the scheme's 140 characters — the caller is reconciling on
      // this string, so a silently shortened one is worse than an error.
      if (reference !== undefined && reference !== null) {
        if (typeof reference !== "string") {
          return res.status(400).json({ error: "reference must be a string" });
        }
        if (reference.length > SEPA_REMITTANCE_MAX) {
          return res.status(400).json({
            error: `reference must be ${SEPA_REMITTANCE_MAX} characters or fewer (SEPA remittance limit)`,
          });
        }
        if (quote.rail !== "sepa") {
          return res.status(400).json({
            error: "reference is only carried on the sepa rail",
          });
        }
      }
      const built = await buildTransferFromQuote(quote, {
        recipientName,
        recipientPhone,
        recipientIban,
        reference,
      });
      if (!built.ok) return res.status(built.status).json(built.body);
      res.status(201).json({ ...built.transfer, authorization: built.authorization });
    }),
  );

  router.get(
    "/users/:id/transfers",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const transfers = store.transfers
        .filter((t) => t.userId === user.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      res.json({ transfers });
    }),
  );

  router.get(
    "/users/:id/activity",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const transfers = store.transfers
        .filter((t) => t.userId === user.id)
        .map((t) => ({ kind: "transfer" as const, at: t.createdAt, ...t }));
      const funding = store.cryptoDeposits
        .filter((d) => d.userId === user.id)
        .map((d) => ({
          kind: "funding" as const,
          id: d.id,
          at: d.detectedAt,
          chainId: d.chainId,
          token: d.token,
          txHash: d.txHash,
          amountEur: d.amountEur ?? d.creditedEur,
          amountUsdc: d.amountUsdc ?? d.creditedUsdc,
          state: d.state,
          reason: d.reason,
          settlementAsset: d.settlementAsset,
          detectedAt: d.detectedAt,
          updatedAt: d.updatedAt,
        }));
      res.json({
        activity: [...transfers, ...funding].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      });
    }),
  );

  router.get(
    "/transfers/:id",
    wrap(async (req, res) => {
      const t = store.findTransfer(req.params.id);
      if (!t) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, t.userId)) return;
      res.json(t);
    }),
  );

  router.post(
    "/transfers/:id/refresh-payout",
    wrap(async (req, res) => {
      const t = store.findTransfer(req.params.id);
      if (!t) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, t.userId)) return;
      res.json(await refreshPayout(t, { timeoutMs: 0 }));
    }),
  );

  router.post(
    "/users/:id/authorizer",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireKycApproved(user, res)) return;
      if (!(await verifyPasskeyStepUp(user, req.body, res))) return;
      const address = req.body?.address;
      if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return res.status(400).json({ error: "address required (0x-prefixed, 20 bytes)" });
      }
      if (user.authorizerAddress) {
        if (user.authorizerAddress.toLowerCase() !== address.toLowerCase()) {
          return res.status(409).json({
            error: "this account is already bound to a different device key — rotate it from that device",
            authorizerAddress: user.authorizerAddress,
          });
        }
        return res.json(publicUser(user));
      }
      const updated = store.updateUser(user.id, { authorizerAddress: address as `0x${string}` });
      res.status(201).json(publicUser(updated));
    }),
  );

  router.post(
    "/transfers/:id/authorize",
    wrap(async (req, res) => {
      const transfer = store.findTransfer(req.params.id);
      if (!transfer) return res.status(404).json({ error: "transfer not found" });
      if (!requireUserSession(req, res, transfer.userId)) return;
      if (transfer.state !== "CREATED") {
        return res.status(409).json({ error: `transfer is ${transfer.state}, expected CREATED` });
      }
      if (!transfer.auth) return res.status(409).json({ error: "transfer has no authorization terms" });
      const signature = req.body?.signature;
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return res.status(400).json({ error: "signature required" });
      }
      if (Date.now() / 1000 > transfer.auth.deadline) {
        return res.status(410).json({ error: "authorization window expired, create a new transfer" });
      }
      let executableTransfer = transfer;
      const redeemSignature = req.body?.moneriumRedeemSignature;
      if (redeemSignature !== undefined) {
        if (!transfer.moneriumRedeem) {
          return res.status(400).json({ error: "this transfer has no Monerium redeem authorization terms" });
        }
        if (typeof redeemSignature !== "string" || !/^0x[0-9a-fA-F]+$/.test(redeemSignature)) {
          return res.status(400).json({ error: "moneriumRedeemSignature must be a 0x signature" });
        }
      }
      let user = store.findUser(transfer.userId)!;
      if (!requireKycApproved(user, res)) return;
      // User-signed execution: when creation prepared one, the transfer can
      // only debit through the UserOperation the passkey approves.
      // Verified before the authorization is claimed (a bad assertion must not
      // consume the one-shot claim) and before the redeem assertion. The
      // client runs the execution ceremony first, so on authenticators with a
      // signature counter the redeem assertion has the higher count; checking
      // it first would make the execution assertion look like a cloned
      // authenticator and fail every Safe-funded SEPA send.
      prunePendingTransferExecutions();
      const pendingExecution = pendingTransferExecutions.get(transfer.id);
      if (pendingExecution && pendingExecution.userId !== user.id) {
        return res.status(403).json({ error: "Safe execution belongs to a different account" });
      }
      const executionAssertion = req.body?.executionAssertion;
      if (pendingExecution) {
        if (!user.passkey?.publicKey) {
          return res.status(409).json({ error: "no passkey registered for this account" });
        }
        const { credentialId, authenticatorData, clientDataJSON, signature: assertionSignature } =
          executionAssertion ?? {};
        if (!executionAssertion) {
          return res.status(400).json({
            error:
              "this transfer's debit needs passkey approval — " +
              "submit executionAssertion signed over the safeExecution challenge",
          });
        }
        if (credentialId !== user.passkey.credentialId) {
          return res.status(403).json({ error: "passkey credential does not match this account" });
        }
        if (!authenticatorData || !clientDataJSON || !assertionSignature) {
          return res.status(400).json({
            error: "executionAssertion requires authenticatorData, clientDataJSON and signature",
          });
        }
        try {
          const { signCount } = await verifyAssertionForChallenge(
            authenticatorData,
            clientDataJSON,
            assertionSignature,
            user.passkey.publicKey,
            user.passkey.signCount ?? 0,
            user.passkey.rpId ?? SECURITY.rpId,
            SECURITY.origins,
            pendingExecution.challenge,
            true,
          );
          user = store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
        } catch (err: any) {
          return res.status(401).json({ error: String(err?.message ?? err) });
        }
      }
      let effectiveRedeemSignature = typeof redeemSignature === "string" ? redeemSignature as `0x${string}` : undefined;
      const redeemAssertion = req.body?.moneriumRedeemAssertion;
      if (!effectiveRedeemSignature && redeemAssertion !== undefined) {
        if (!transfer.moneriumRedeem) {
          return res.status(400).json({ error: "this transfer has no Monerium redeem authorization terms" });
        }
        if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
          return res.status(409).json({ error: "active passkey Safe required for Monerium redeem authorization" });
        }
        const passkeySafe = user.passkeySafe;
        const { credentialId, authenticatorData, clientDataJSON, signature: assertionSignature } = redeemAssertion ?? {};
        if (credentialId !== user.passkey.credentialId) {
          return res.status(403).json({ error: "passkey credential does not match this account" });
        }
        if (!authenticatorData || !clientDataJSON || !assertionSignature) {
          return res.status(400).json({ error: "moneriumRedeemAssertion requires authenticatorData, clientDataJSON and signature" });
        }
        const expectedChallenge = passkeySafeChallenge(safeMessageHash(user.address, transfer.moneriumRedeem.message));
        try {
          const { signCount } = await verifyAssertionForChallenge(
            authenticatorData,
            clientDataJSON,
            assertionSignature,
            user.passkey.publicKey,
            user.passkey.signCount ?? 0,
            user.passkey.rpId ?? SECURITY.rpId,
            SECURITY.origins,
            expectedChallenge,
            true,
          );
          user = store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
          effectiveRedeemSignature = await signMessageAsPasskeySafe(
            passkeySafe,
            user.address,
            transfer.moneriumRedeem.message,
            {
              authenticatorData: b64urlToBuf(authenticatorData),
              clientDataJSON: b64urlToBuf(clientDataJSON),
              signature: b64urlToBuf(assertionSignature),
            },
          );
        } catch (err: any) {
          return res.status(401).json({ error: String(err?.message ?? err) });
        }
      }
      if (
        transfer.rail === "sepa" &&
        transfer.moneriumRedeem &&
        !effectiveRedeemSignature
      ) {
        return res.status(400).json({
          error: "passkey Safe Monerium redeem approval is required before this SEPA transfer can execute",
        });
      }
      // Claim the authorization before execution. Two parallel submissions of the
      // same signature both clear the CREATED check above, and both could submit
      // the same spend. claimAuthorization is the atomic boundary: after it
      // succeeds once, every other caller sees the authorizedAt marker and stops.
      if (!store.claimAuthorization(transfer.id)) {
        return res.status(409).json({ error: "authorization already submitted for this transfer" });
      }
      // Hand the user-approved execution to the orchestrator. The claim above
      // makes this the single submission allowed to relay it; the debit leg
      // submits the UserOperation, so a failed relay flows through the same
      // FAILED/compensation path as any other debit failure.
      const execution = pendingExecution
        ? {
            plan: pendingExecution.plan,
            userOperation: pendingExecution.userOperation,
            assertion: {
              authenticatorData: b64urlToBuf(executionAssertion.authenticatorData),
              clientDataJSON: b64urlToBuf(executionAssertion.clientDataJSON),
              signature: b64urlToBuf(executionAssertion.signature),
            },
            ...(pendingExecution.batch ? { batch: pendingExecution.batch } : {}),
          }
        : undefined;
      if (pendingExecution) pendingTransferExecutions.delete(transfer.id);
      if (effectiveRedeemSignature && transfer.moneriumRedeem) {
        executableTransfer = store.updateTransfer(transfer.id, {
          moneriumRedeem: {
            ...transfer.moneriumRedeem,
            signature: effectiveRedeemSignature,
            signedAt: new Date().toISOString(),
          },
        });
      } else {
        executableTransfer = store.findTransfer(transfer.id)!;
      }
      const auth = { deadline: transfer.auth.deadline, signature: signature as `0x${string}` };
      const result =
        executableTransfer.rail === "sepa"
          ? await executeSepaTransfer(executableTransfer, user, auth, execution)
          : await executeTransfer(executableTransfer, user, auth, execution);
      res.status(result.state === "FAILED" ? 502 : 200).json(result);
    }),
  );

  return router;
}
