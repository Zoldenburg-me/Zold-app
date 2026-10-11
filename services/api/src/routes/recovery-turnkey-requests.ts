/**
 * Recovering an account with its Turnkey guardian (recovery/turnkey-recovery.ts
 * holds the rules). Every route is a 404 while TURNKEY_GUARDIANS is off.
 *
 * The lost-device half, no Zold session (the device is new), each call
 * carrying the per-request secret the starting browser was given once
 * (`x-recovery-secret`), as for Zoldenburg recovery:
 * - POST /recovery/turnkey/requests {email}: start (or resume, with the
 *   secret); the account must have exactly one active Google/Apple guardian.
 *   Answers name no account, Safe or guardian (heldView): anyone who knows
 *   the email can start one.
 * - POST /recovery/turnkey/requests/:id/passkey: the new passkey, held on the
 *   request until the chain shows it as owner.
 * - GET  /recovery/turnkey/requests/:id[/digest]: status; the digest the
 *   guardian signs, recomputed from the module (the digest alone).
 * - POST /recovery/turnkey/requests/:id/signature {r,s,v}: Turnkey's answer;
 *   checked and relayed (multiConfirmRecovery, execute). The wait starts.
 * - POST /recovery/turnkey/requests/:id/finalize: after the wait.
 *
 * The owner's half, signed in: GET /users/:id/recovery/turnkey/requests (open
 * requests and the module's pending recovery, for the alert banner) and
 * POST …/requests/:rid/cancel before anything was signed. A recovery already
 * on chain is cancelled with the passkey (routes/recovery-candide.ts).
 */
import express from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SECURITY } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { describeError, redactedMessage } from "../http/log-cause.js";
import { publicRecoveryRequest } from "../recovery.js";
import {
  acceptTurnkeySignature,
  ownerWasAlerted,
  finalizeTurnkeyRecovery,
  isBeingSigned,
  syncTurnkeyFromChain,
  turnkeyGuardianFor,
  turnkeyRecoveryChain,
  turnkeyRecoveryDigest,
  type TurnkeyRecoveryChain,
} from "../recovery/turnkey-recovery.js";
import { passkeyAccountAddress, recoveryGracePeriodSeconds, webauthnOwnerFromJwk, type PasskeySafeDeploymentPlan } from "../wallet/candide.js";
import { TurnkeyGuardianError, turnkeyGuardiansEnabled } from "../wallet/turnkey.js";
import { issueChallenge, verifyRegistration } from "../webauthn.js";
import { wrap } from "./util.js";

export interface TurnkeyRecoveryDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  enabled?: () => boolean;
  /** The recovery module, or a stand-in under test. */
  chain?: TurnkeyRecoveryChain;
  /** Was the owner emailed about this request? (recovery/owner-alerts.ts) */
  ownerAlerted?: (r: RecoveryRequest) => boolean;
}

/**
 * Requests waiting for a guardian per account. Anyone who knows the email can
 * start one, so a new start past the cap expires the oldest request that has
 * no new passkey yet, and never one that has: a stranger's starts cannot
 * expire the owner's request once its passkey is in. With every slot holding
 * a passkey the start is refused until one times out (TURNKEY_REQUEST_TTL_MS).
 */
const MAX_OPEN = 5;
/** How long a Google/Apple recovery waits for its guardian's login. The
 *  login is the next step on the same page, so an hour is generous, and it
 *  frees a slot a stranger filled. The waiting period starts after. */
export const TURNKEY_REQUEST_TTL_MS = 3600_000;

const OPEN = ["PASSKEY_PENDING", "REVIEW_PENDING", "GRACE_PERIOD"];
const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
const presentedSecret = (req: express.Request): string => {
  const h = req.get("x-recovery-secret");
  return typeof h === "string" && h ? h : typeof req.body?.recoverySecret === "string" ? req.body.recoverySecret : "";
};
function secretMatches(r: RecoveryRequest, secret: string): boolean {
  const want = r.turnkey?.accessHash;
  if (!want || !secret) return false;
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A request as its secret's holder sees it. Whoever knows the email can start
 * a request and hold its secret, so this names no account, Safe, module or
 * guardian (publicRecoveryRequest, for the owner's session, does).
 */
function heldView(r: RecoveryRequest) {
  const t = r.turnkey;
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    requestedAt: r.requestedAt,
    expiresAt: r.expiresAt,
    recoveryDelayHours: r.recoveryDelayHours,
    ...(r.canceledAt ? { canceledAt: r.canceledAt } : {}),
    ...(r.finalizedAt ? { finalizedAt: r.finalizedAt } : {}),
    turnkey: {
      newPasskeyRegistered: Boolean(t?.newPasskey),
      ...(t?.executeTxHash ? { executeTxHash: t.executeTxHash } : {}),
      ...(t?.finalizeAfter ? { finalizeAfter: t.finalizeAfter } : {}),
      ...(t?.finalizeTxHash ? { finalizeTxHash: t.finalizeTxHash } : {}),
      ...(t?.finalizeError ? { finalizeError: FINALIZE_PENDING } : {}),
    },
  };
}

/** Our refusals keep their status and code; anything else is a 503 with a
 *  fixed message and a reference to the log line, never the cause (an RPC,
 *  bundler or Turnkey reply). 503, not 502: Cloudflare replaces a 502's body. */
function fail(res: express.Response, err: unknown) {
  if (err instanceof TurnkeyGuardianError) return res.status(err.status).json({ error: err.message, code: err.code });
  const ref = randomUUID().slice(0, 8);
  console.error(`recovery (turnkey) [${ref}]: ${describeError(err)}`);
  return res.status(503).json({ error: `this didn’t go through — try again in a minute (ref ${ref})`, code: "UNAVAILABLE", ref });
}

/** What a failed finalise tells the browser: it is retried, nothing more. */
const FINALIZE_PENDING = "finishing didn’t go through yet — it is tried again automatically";

/** The account's Turnkey requests still open: in their waiting period, or not yet timed out. */
const liveTurnkeyRequests = (userId: string) =>
  store
    .recoveryRequestsForUser(userId)
    .filter((r) => r.mode === "turnkey" && OPEN.includes(r.status) && (r.status === "GRACE_PERIOD" || Date.now() < Date.parse(r.expiresAt)));

export function createTurnkeyRecoveryRouter({
  requireUserSession,
  enabled = turnkeyGuardiansEnabled,
  chain = turnkeyRecoveryChain,
  ownerAlerted = ownerWasAlerted,
}: TurnkeyRecoveryDeps) {
  const router = express.Router();
  const off = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (enabled()) return next();
    res.status(404).json({ error: "Turnkey guardians are not available on this deployment", code: "TURNKEY_OFF" });
  };
  router.use("/recovery/turnkey/requests", off);
  router.use("/users/:id/recovery/turnkey/requests", off);

  /** The request named in the path, if the caller holds its secret; expired
   *  ones are marked so and answered 410. */
  const requestFor = (req: express.Request, res: express.Response): RecoveryRequest | undefined => {
    const r = store.findRecoveryRequest(req.params.id);
    if (!r || r.mode !== "turnkey" || !secretMatches(r, presentedSecret(req))) {
      res.status(404).json({ error: "recovery not found" });
      return undefined;
    }
    if (["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status) && Date.now() >= Date.parse(r.expiresAt)) {
      res.status(410).json({ ...heldView(store.updateRecoveryRequest(r.id, { status: "EXPIRED" })), error: "this recovery expired — start again" });
      return undefined;
    }
    return r;
  };

  router.post(
    "/recovery/turnkey/requests",
    wrap(async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email : "";
      const user = email ? store.findUserByEmail(email) : undefined;
      const guardian = turnkeyGuardianFor(user);
      if (!user || !guardian) return res.status(404).json({ error: "recovery not found" });
      const mine = liveTurnkeyRequests(user.id);
      // The starting browser resumes its own request by the secret.
      const open = mine.find((r) => secretMatches(r, presentedSecret(req)));
      if (!open && mine.some((r) => r.status === "GRACE_PERIOD")) {
        return res.status(409).json({
          error: "a recovery of this account is already under way — continue it in the browser that started it",
          code: "RECOVERY_IN_PROGRESS",
        });
      }
      const plan = user.passkeySafe as PasskeySafeDeploymentPlan;
      // The module the guardian was added on, as the add route read it.
      let moduleAddress: `0x${string}`;
      try {
        moduleAddress = open?.recoveryModuleAddress ?? (await chain.readState(plan)).moduleAddress;
      } catch (err) {
        return fail(res, err);
      }
      const secret = open ? undefined : randomBytes(32).toString("base64url");
      let request = open;
      if (!request) {
        // Read again after the await: a start racing this one is counted.
        const waiting = liveTurnkeyRequests(user.id)
          .filter((r) => r.status !== "GRACE_PERIOD")
          .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
        if (waiting.length >= MAX_OPEN) {
          const spare = waiting.find((r) => r.status === "PASSKEY_PENDING");
          if (!spare) {
            return res.status(429).json({ error: "too many recoveries of this account are waiting — try again in an hour", code: "TOO_MANY_RECOVERIES" });
          }
          store.updateRecoveryRequest(spare.id, { status: "EXPIRED" });
        }
        const now = new Date();
        request = {
          id: randomUUID(),
          userId: user.id,
          safeAddress: plan.address,
          mode: "turnkey",
          status: "PASSKEY_PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + TURNKEY_REQUEST_TTL_MS).toISOString(),
          recoveryDelayHours: Math.max(1, Math.round((recoveryGracePeriodSeconds(moduleAddress) ?? 0) / 3600)),
          guardianAddress: guardian.address,
          recoveryModuleAddress: moduleAddress,
          factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
          turnkey: { accessHash: hashSecret(secret!), guardianSubOrgId: guardian.turnkeySubOrgId },
        };
        store.addRecoveryRequest(request);
        console.log(`RECOVERY: ${request.id} started for ${user.id} with its Turnkey guardian`);
      }
      const out: Record<string, unknown> = {
        ...heldView(request),
        ...(secret ? { recoverySecret: secret } : {}),
        gracePeriodSeconds: recoveryGracePeriodSeconds(moduleAddress),
      };
      if (request.status === "PASSKEY_PENDING") {
        out.registerChallenge = issueChallenge("register", `recovery:${request.id}`);
        out.rpId = SECURITY.rpId;
        out.userHandle = user.id;
        out.submitTo = `/api/recovery/turnkey/requests/${request.id}/passkey`;
      }
      res.status(open ? 200 : 201).json(out);
    }),
  );

  router.post(
    "/recovery/turnkey/requests/:id/passkey",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status !== "PASSKEY_PENDING") return res.status(409).json({ ...heldView(request), error: `recovery is ${request.status}` });
      if (!store.findUser(request.userId)?.passkeySafe) return res.status(410).json({ error: "the account behind this recovery no longer exists" });
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if (store.findUserByCredential(credentialId)) return res.status(409).json({ error: "that passkey already belongs to an account" });
      let reg;
      try {
        reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, `recovery:${request.id}`);
      } catch (err) {
        return res.status(400).json({ error: redactedMessage(err) });
      }
      if (reg.credentialId !== credentialId) return res.status(400).json({ error: "credentialId does not match attestation" });
      if (reg.key.alg !== "ES256") return res.status(400).json({ error: "the new passkey must be a P-256 (ES256) credential to own a Safe" });
      const owner = webauthnOwnerFromJwk(reg.key.jwk);
      if (!owner) return res.status(400).json({ error: "could not read the new passkey's public key" });
      const updated = store.updateRecoveryRequest(request.id, {
        status: "REVIEW_PENDING",
        turnkey: {
          ...request.turnkey,
          newPasskey: { credentialId, publicKey: reg.key, signCount: reg.signCount, rpId: SECURITY.rpId, attestation, createdAt: new Date().toISOString() },
          // The new passkey becomes the ONLY owner.
          newOwners: [passkeyAccountAddress(owner)],
          newThreshold: 1,
        },
      });
      res.json(heldView(updated));
    }),
  );

  router.get(
    "/recovery/turnkey/requests/:id",
    wrap(async (req, res) => {
      let request = requestFor(req, res);
      if (!request) return;
      request = await syncTurnkeyFromChain(request, chain).catch(() => request!);
      res.json({ ...heldView(request), gracePeriodSeconds: recoveryGracePeriodSeconds(request.recoveryModuleAddress) });
    }),
  );

  router.get(
    "/recovery/turnkey/requests/:id/digest",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      try {
        if (request.status !== "REVIEW_PENDING") throw new TurnkeyGuardianError(`recovery is ${request.status}`, 409, "NOT_WAITING");
        const { digest } = await turnkeyRecoveryDigest(request, chain);
        // The sub-org and the address to sign with come from the guardian's
        // own login (/recovery/turnkey/login), not from here.
        res.json({ digest });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/requests/:id/signature",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      try {
        const { r, s, v } = req.body ?? {};
        res.json(heldView(await acceptTurnkeySignature(request, { r, s, v }, chain, { ownerAlerted })));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.post(
    "/recovery/turnkey/requests/:id/finalize",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status === "FINALIZED") return res.json(heldView(request));
      if (request.status !== "GRACE_PERIOD") return res.status(409).json({ ...heldView(request), error: `recovery is ${request.status}` });
      try {
        const updated = await finalizeTurnkeyRecovery(request, chain);
        if (updated.status !== "FINALIZED") {
          return res.status(503).json({ ...heldView(updated), error: FINALIZE_PENDING });
        }
        // No session: the new passkey signs in through the ordinary login.
        res.json(heldView(updated));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  // ---- the owner's half ---------------------------------------------------

  const ownerFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    return requireUserSession(req, res, user.id) ? user : undefined;
  };

  router.get(
    "/users/:id/recovery/turnkey/requests",
    wrap(async (req, res) => {
      const user = ownerFor(req, res);
      if (!user) return;
      const requests = store
        .recoveryRequestsForUser(user.id)
        .filter((r) => r.mode === "turnkey" && OPEN.includes(r.status))
        .map(publicRecoveryRequest);
      const out: Record<string, unknown> = { requests };
      if (user.passkeySafe?.status === "active") {
        try {
          const state = await chain.readState(user.passkeySafe as PasskeySafeDeploymentPlan);
          out.onChain = { pendingRecovery: state.pending, guardians: state.guardians };
        } catch (err) {
          console.error(`recovery (turnkey): owner's module read failed: ${describeError(err)}`);
          out.onChainError = "couldn’t read the recovery module just now";
        }
      }
      res.json(out);
    }),
  );

  router.post(
    "/users/:id/recovery/turnkey/requests/:rid/cancel",
    wrap(async (req, res) => {
      const user = ownerFor(req, res);
      if (!user) return;
      const r = store.findRecoveryRequest(req.params.rid);
      if (!r || r.userId !== user.id || r.mode !== "turnkey") return res.status(404).json({ error: "recovery not found" });
      if (!["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status)) {
        return res.status(409).json({ error: `recovery is ${r.status} — a recovery on chain is cancelled with your passkey`, code: "NOT_CANCELABLE" });
      }
      // Its signature is being relayed now: the result would overwrite the
      // cancel. Once on chain, the passkey cancels it.
      if (isBeingSigned(r.id)) {
        return res.status(409).json({ error: "this recovery is being approved right now — cancel it with your passkey in a moment", code: "BEING_SIGNED" });
      }
      const updated = store.updateRecoveryRequest(r.id, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "cancelled by the account owner" });
      console.log(`RECOVERY: ${r.id} cancelled by its owner before the guardian signed`);
      res.json(publicRecoveryRequest(updated));
    }),
  );

  return router;
}
