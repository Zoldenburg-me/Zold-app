/**
 * Recovering an account with its Turnkey guardian (recovery/turnkey-recovery.ts
 * holds the rules). Every route is a 404 while TURNKEY_GUARDIANS is off.
 *
 * The lost-device half, no Zold session (the device is new), each call
 * carrying the per-request secret the starting browser was given once
 * (`x-recovery-secret`), as for Zoldenburg recovery:
 * - POST /recovery/turnkey/requests {email}: start (or resume, with the
 *   secret); the account must have exactly one active Google/Apple guardian.
 * - POST /recovery/turnkey/requests/:id/passkey: the new passkey, held on the
 *   request until the chain shows it as owner.
 * - GET  /recovery/turnkey/requests/:id[/digest]: status; the digest the
 *   guardian signs, recomputed from the module.
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
import { RECOVERY, SECURITY } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { describeError, redactedMessage, shortErrorForClient } from "../http/log-cause.js";
import { publicRecoveryRequest } from "../recovery.js";
import {
  acceptTurnkeySignature,
  ownerWasAlerted,
  finalizeTurnkeyRecovery,
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

/** Open requests one account may have before the oldest expires. Several may
 *  be open at once: only the guardian's login can sign one, so a stranger who
 *  knows the email cannot lock the owner out by starting first. */
const MAX_OPEN = 5;

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

/** Our refusals keep their status and code; anything else is a 503 that says
 *  little (503, not 502: Cloudflare replaces a 502's body). */
function fail(res: express.Response, err: unknown) {
  if (err instanceof TurnkeyGuardianError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`recovery (turnkey): ${describeError(err)}`);
  return res.status(503).json({ error: shortErrorForClient(err) });
}

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
      res.status(410).json({ ...publicRecoveryRequest(store.updateRecoveryRequest(r.id, { status: "EXPIRED" })), error: "this recovery expired — start again" });
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
      const mine = store
        .recoveryRequestsForUser(user.id)
        .filter((r) => r.mode === "turnkey" && OPEN.includes(r.status) && (r.status === "GRACE_PERIOD" || Date.now() < Date.parse(r.expiresAt)));
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
        const now = new Date();
        request = {
          id: randomUUID(),
          userId: user.id,
          safeAddress: plan.address,
          mode: "turnkey",
          status: "PASSKEY_PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + RECOVERY.requestTtlHours * 3600_000).toISOString(),
          recoveryDelayHours: Math.max(1, Math.round((recoveryGracePeriodSeconds(moduleAddress) ?? 0) / 3600)),
          guardianAddress: guardian.address,
          recoveryModuleAddress: moduleAddress,
          factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
          turnkey: { accessHash: hashSecret(secret!), guardianSubOrgId: guardian.turnkeySubOrgId },
        };
        store.addRecoveryRequest(request);
        console.log(`RECOVERY: ${request.id} started for ${user.id} with its Turnkey guardian`);
        const waiting = [...mine, request].filter((r) => r.status !== "GRACE_PERIOD").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
        for (const old of waiting.slice(0, Math.max(0, waiting.length - MAX_OPEN))) store.updateRecoveryRequest(old.id, { status: "EXPIRED" });
      }
      const out: Record<string, unknown> = {
        ...publicRecoveryRequest(request),
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
      if (request.status !== "PASSKEY_PENDING") return res.status(409).json({ ...publicRecoveryRequest(request), error: `recovery is ${request.status}` });
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
      res.json(publicRecoveryRequest(updated));
    }),
  );

  router.get(
    "/recovery/turnkey/requests/:id",
    wrap(async (req, res) => {
      let request = requestFor(req, res);
      if (!request) return;
      request = await syncTurnkeyFromChain(request, chain).catch(() => request!);
      res.json({ ...publicRecoveryRequest(request), gracePeriodSeconds: recoveryGracePeriodSeconds(request.recoveryModuleAddress) });
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
        res.json({ digest, guardianAddress: request.guardianAddress, subOrgId: request.turnkey?.guardianSubOrgId });
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
        res.json(publicRecoveryRequest(await acceptTurnkeySignature(request, { r, s, v }, chain, { ownerAlerted })));
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
      if (request.status === "FINALIZED") return res.json(publicRecoveryRequest(request));
      if (request.status !== "GRACE_PERIOD") return res.status(409).json({ ...publicRecoveryRequest(request), error: `recovery is ${request.status}` });
      try {
        const updated = await finalizeTurnkeyRecovery(request, chain);
        if (updated.status !== "FINALIZED") {
          return res.status(503).json({ ...publicRecoveryRequest(updated), error: updated.turnkey?.finalizeError ?? "not finalized yet" });
        }
        // No session: the new passkey signs in through the ordinary login.
        res.json(publicRecoveryRequest(updated));
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
          out.onChainError = redactedMessage(err).slice(0, 160);
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
      const updated = store.updateRecoveryRequest(r.id, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "cancelled by the account owner" });
      console.log(`RECOVERY: ${r.id} cancelled by its owner before the guardian signed`);
      res.json(publicRecoveryRequest(updated));
    }),
  );

  return router;
}
