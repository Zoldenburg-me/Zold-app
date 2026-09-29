/**
 * Advanced security: the account holder's own second owner, the signature
 * threshold, and spending limits (Safe's Allowance module) on their Safe.
 *
 * Every change is a UserOperation the passkey signs — prepare here, sign in
 * the browser, submit to `/safe/ops/:requestId` — the same two-step shape as
 * the recovery guardian setup. Nothing is stored about these settings: the
 * chain is read on every GET, because an owner added or removed on
 * app.safe.global changes the answer without Zold hearing about it.
 *
 * The refusals are the point of this file (wallet/safe-signers.ts says why):
 * - one extra owner at most through Zold, and never the Safe, the passkey or
 *   the recovery guardian;
 * - raising the threshold needs a second owner AND a guardian on chain, since
 *   after it Zold can sign nothing and only a recovery gets the account back;
 * - there is no route that lowers the threshold: at 2 Zold cannot sign it.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { parseUnits } from "viem";
import { HARNESS, SECURITY } from "../config.js";
import { addrs } from "../chain.js";
import { store, type User } from "../store.js";
import { ADDRESS_RE } from "../domain/contacts.js";
import { b64urlToBuf, bufToB64url } from "../webauthn.js";
import { wrap } from "./util.js";
import {
  CANDIDE,
  prepareSafeSetupOperation,
  readRecoveryState,
  submitPasskeySafeOperationWithReceipt,
  type PasskeySafeDeploymentPlan,
} from "../wallet/candide.js";
import {
  addOwnerTransaction,
  changeThresholdTransaction,
  readSafeSignerState,
  removeDelegateTransaction,
  removeOwnerTransaction,
  spendingLimitTransactions,
  type SafeSignerState,
} from "../wallet/safe-signers.js";

export interface SafeSignerDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const CEREMONY_TTL_MS = 5 * 60_000;
/** What the user types to raise the threshold. A checkbox is too easy to tick. */
export const LOCK_PHRASE = "LOCK";
const PERIOD_MINUTES: Record<string, number> = { once: 0, day: 24 * 60, week: 7 * 24 * 60, month: 30 * 24 * 60 };
const ZERO = "0x0000000000000000000000000000000000000000";

type OpKind = "add-owner" | "remove-owner" | "threshold" | "limit" | "remove-delegate";
const pendingOps = new Map<string, { userId: string; kind: OpKind; userOperation: any; expiresAt: number }>();

function prune(now = Date.now()) {
  for (const [id, entry] of pendingOps) if (entry.expiresAt < now) pendingOps.delete(id);
}

class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

function activePlan(user: User): PasskeySafeDeploymentPlan {
  const plan = user.passkeySafe;
  if (!plan || plan.status !== "active" || user.address.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Refusal(409, "an active passkey Safe is required first", "NO_SAFE");
  }
  if (!user.passkey?.publicKey) throw new Refusal(409, "a verified passkey is required first", "NO_PASSKEY");
  // The harness chain has no bundler and the harness answers no Safe reads;
  // an owner screen built on invented state would be the UPI lesson again.
  if (HARNESS.enabled) {
    throw new Refusal(409, "signer settings need a real chain — the local harness has no Safe to read", "NO_CHAIN");
  }
  return plan as PasskeySafeDeploymentPlan;
}

function tokens(): { symbol: string; address: `0x${string}`; decimals: number }[] {
  try {
    const d = addrs();
    return [
      { symbol: "EURe", address: d.eure, decimals: 18 },
      { symbol: "USDC", address: d.usdc, decimals: 6 },
    ];
  } catch {
    return [];
  }
}

function publicState(s: SafeSignerState, guardians: number) {
  return {
    ...s,
    guardians,
    lockPhrase: LOCK_PHRASE,
    tokens: tokens(),
    chainId: Number(CANDIDE.chainId),
    // Safe{Wallet}'s chain prefixes for the two chains this app runs on.
    safeAppUrl: `https://app.safe.global/home?safe=${CANDIDE.chainId === 8453n ? "base" : CANDIDE.chainId === 84532n ? "basesep" : `eip155:${CANDIDE.chainId}`}:${s.safeAddress}`,
  };
}

const toAssertion = (body: any) => ({
  authenticatorData: b64urlToBuf(body.authenticatorData),
  clientDataJSON: b64urlToBuf(body.clientDataJSON),
  signature: b64urlToBuf(body.signature),
});

export function createSafeSignerRouter(deps: SafeSignerDeps) {
  const router = express.Router();

  const userFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!deps.requireUserSession(req, res, user.id)) return undefined;
    return user;
  };

  /** Load the user, plan and on-chain state, or answer the refusal. */
  const context = async (req: express.Request, res: express.Response) => {
    const user = userFor(req, res);
    if (!user) return null;
    try {
      const plan = activePlan(user);
      const state = await readSafeSignerState(plan.address, plan.passkeyPublicKey);
      return { user, plan, state };
    } catch (err) {
      if (err instanceof Refusal) {
        res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
        return null;
      }
      throw err;
    }
  };

  const refuse = (res: express.Response, status: number, error: string, code?: string) =>
    res.status(status).json({ error, ...(code ? { code } : {}) });

  /** Prepare the passkey-signed op and hand the browser its challenge. */
  const prepare = async (res: express.Response, user: User, plan: PasskeySafeDeploymentPlan, kind: OpKind, txs: any[], summary: string) => {
    const prepared = await prepareSafeSetupOperation(plan, txs);
    prune();
    const requestId = randomUUID();
    pendingOps.set(requestId, { userId: user.id, kind, userOperation: prepared.userOperation, expiresAt: Date.now() + CEREMONY_TTL_MS });
    res.status(201).json({
      requestId,
      kind,
      summary,
      credentialId: user.passkey!.credentialId,
      rpId: user.passkey!.rpId ?? SECURITY.rpId,
      challenge: bufToB64url(Buffer.from(prepared.challenge.slice(2), "hex")),
      submitTo: `/api/users/${user.id}/safe/ops/${requestId}`,
    });
  };

  router.get(
    "/users/:id/safe/signers",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const recovery = await readRecoveryState(ctx.plan);
      res.json(publicState(ctx.state, recovery.guardians.length));
    }),
  );

  // ---- a second owner ------------------------------------------------------

  router.post(
    "/users/:id/safe/owners",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { user, plan, state } = ctx;
      const address = String(req.body?.address ?? "").trim();
      if (!ADDRESS_RE.test(address) || address.toLowerCase() === ZERO) return refuse(res, 400, "address must be a 0x address");
      if (req.body?.acknowledged !== true) {
        return refuse(res, 400, "confirm that you have read the warnings before adding an owner", "NOT_ACKNOWLEDGED");
      }
      const lower = address.toLowerCase();
      if (state.owners.some((o) => o.address.toLowerCase() === lower)) return refuse(res, 409, "that address is already an owner");
      if (lower === plan.address.toLowerCase()) return refuse(res, 400, "a Safe cannot own itself");
      if (state.owners.length >= 2) {
        return refuse(res, 409, "this account already has a second owner — remove it before adding another", "HAS_SECOND_OWNER");
      }
      const recovery = await readRecoveryState(plan);
      if (recovery.guardians.some((g) => g.toLowerCase() === lower)) {
        return refuse(res, 400, "the recovery guardian cannot also be an owner");
      }
      // Threshold stays where it is (1): either owner can act alone.
      await prepare(res, user, plan, "add-owner", [addOwnerTransaction(plan.address, address as `0x${string}`, state.threshold)],
        `Add ${address} as a second owner. Either owner can then move funds alone (1 of 2).`);
    }),
  );

  router.post(
    "/users/:id/safe/owners/:address/remove",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { user, plan, state } = ctx;
      const target = state.owners.find((o) => o.address.toLowerCase() === String(req.params.address).toLowerCase());
      if (!target) return refuse(res, 404, "that address is not an owner of this account");
      if (target.kind === "passkey") return refuse(res, 400, "the passkey cannot be removed from here — it is how Zold signs");
      const newThreshold = Math.min(state.threshold, state.owners.length - 1);
      await prepare(res, user, plan, "remove-owner",
        [removeOwnerTransaction(plan.address, state.owners.map((o) => o.address), target.address, Math.max(1, newThreshold))],
        `Remove ${target.address} as an owner.`);
    }),
  );

  // ---- require every owner -------------------------------------------------

  router.post(
    "/users/:id/safe/threshold",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { user, plan, state } = ctx;
      const threshold = Number(req.body?.threshold);
      if (!Number.isInteger(threshold) || threshold < 2) {
        return refuse(res, 400, "only raising the threshold is possible here — at 2 or more Zold can no longer sign a change back");
      }
      if (threshold > state.owners.length) {
        return refuse(res, 409, `a threshold of ${threshold} needs ${threshold} owners; this account has ${state.owners.length}`);
      }
      if (threshold <= state.threshold) return refuse(res, 409, `the threshold is already ${state.threshold}`);
      if (req.body?.confirm !== LOCK_PHRASE) {
        return refuse(res, 400, `type ${LOCK_PHRASE} to confirm`, "NOT_CONFIRMED");
      }
      // Fail closed: after this, recovery is the only way back. Without a
      // guardian on chain there is no way back at all.
      const recovery = await readRecoveryState(plan);
      if (!recovery.moduleEnabled || recovery.guardians.length === 0) {
        return refuse(res, 409,
          "no recovery guardian is on this account, so a locked account could never be reset — set up recovery first",
          "NO_GUARDIAN");
      }
      await prepare(res, user, plan, "threshold", [changeThresholdTransaction(plan.address, threshold)],
        `Require ${threshold} of ${state.owners.length} owners on every transaction. Zold will no longer be able to send.`);
    }),
  );

  // ---- spending limits (Allowance module) -----------------------------------

  router.post(
    "/users/:id/safe/spending-limits",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { user, plan, state } = ctx;
      if (!state.allowance.moduleDeployed) {
        return refuse(res, 409, `the Allowance module ${state.allowance.moduleAddress} has no code on chain ${CANDIDE.chainId}`, "NO_MODULE");
      }
      const delegate = String(req.body?.delegate ?? "").trim();
      if (!ADDRESS_RE.test(delegate) || delegate.toLowerCase() === ZERO) return refuse(res, 400, "delegate must be a 0x address");
      if (delegate.toLowerCase() === plan.address.toLowerCase()) return refuse(res, 400, "the account cannot be its own delegate");
      if (delegate.toLowerCase() === state.passkeyAddress.toLowerCase()) {
        return refuse(res, 400, "the passkey cannot spend through a limit — it signs as an owner");
      }
      const token = tokens().find((t) => t.address.toLowerCase() === String(req.body?.token ?? "").toLowerCase());
      if (!token) return refuse(res, 400, "token must be EURe or USDC on this chain");
      const period = String(req.body?.period ?? "");
      if (!(period in PERIOD_MINUTES)) return refuse(res, 400, "period must be once, day, week or month");
      let amount: bigint;
      try {
        amount = parseUnits(String(req.body?.amount ?? "").replace(",", ".").trim(), token.decimals);
      } catch {
        return refuse(res, 400, "amount must be a number");
      }
      if (amount <= 0n || amount >= 2n ** 96n) return refuse(res, 400, "amount must be positive");
      if (req.body?.acknowledged !== true) {
        return refuse(res, 400, "confirm that you have read the warnings before setting a limit", "NOT_ACKNOWLEDGED");
      }
      const delegateKnown = state.allowance.limits.some((l) => l.delegate.toLowerCase() === delegate.toLowerCase());
      await prepare(res, user, plan, "limit",
        spendingLimitTransactions({
          safeAddress: plan.address,
          moduleEnabled: state.allowance.enabled,
          delegateKnown,
          delegate: delegate as `0x${string}`,
          token: token.address,
          amount,
          resetMinutes: PERIOD_MINUTES[period],
        }),
        `Let ${delegate} spend up to ${req.body.amount} ${token.symbol} ${period === "once" ? "once" : `per ${period}`} without an owner signature.`);
    }),
  );

  router.post(
    "/users/:id/safe/spending-limits/:delegate/remove",
    wrap(async (req, res) => {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { user, plan, state } = ctx;
      const delegate = state.allowance.limits.find((l) => l.delegate.toLowerCase() === String(req.params.delegate).toLowerCase())?.delegate;
      if (!delegate) return refuse(res, 404, "that address is not a delegate on this account");
      await prepare(res, user, plan, "remove-delegate", [removeDelegateTransaction(delegate)],
        `Remove ${delegate} and every spending limit it holds.`);
    }),
  );

  // ---- submit any of the above ---------------------------------------------

  router.post(
    "/users/:id/safe/ops/:requestId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      prune();
      const pending = pendingOps.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) return refuse(res, 404, "request not found or expired");
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !signature) {
        return refuse(res, 400, "authenticatorData, clientDataJSON and signature required");
      }
      const plan = activePlan(user);
      pendingOps.delete(req.params.requestId);
      const op = await submitPasskeySafeOperationWithReceipt(plan, pending.userOperation, toAssertion(req.body));
      if (op.success === false) {
        return res.status(502).json({ error: "the operation was included but the Safe call reverted — nothing changed", txHash: op.txHash });
      }
      const state = await readSafeSignerState(plan.address, plan.passkeyPublicKey);
      const recovery = await readRecoveryState(plan);
      res.status(201).json({ ...publicState(state, recovery.guardians.length), txHash: op.txHash, userOpHash: op.userOpHash });
    }),
  );

  return router;
}
