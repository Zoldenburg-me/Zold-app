/**
 * Email/SMS recovery through Candide's guardian — two halves, two audiences.
 *
 * ENROLMENT (`/users/:id/recovery/candide/*`, session required): the account
 * holder, with their working passkey, registers an email or phone with
 * Candide (a SIWE statement the Safe signs, then an OTP) and then adds
 * Candide's guardian to the Safe's recovery module in a user-signed
 * operation. Two passkey ceremonies, one OTP.
 *
 * RECOVERY (`/recovery/candide/*`, NO session — the whole point is that the
 * device with the passkey is gone): the person names the account, registers
 * a NEW passkey in this browser, passes an OTP on every channel they
 * enrolled, and Candide signs and executes the recovery. After the module's
 * grace period, finalisation swaps the Safe's owner to the new passkey and
 * only then is the credential bound to the account.
 *
 * THE INVARIANT THAT MATTERS: until finalisation the new credential lives on
 * the recovery request, not on the user. Someone holding the OTP channels can
 * start a recovery — that is what the channels are for — but cannot sign in
 * or spend before the grace period has run, which is the window the rightful
 * owner has to cancel from their still-working device.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, KEYS, RECOVERY, SECURITY } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import {
  CANDIDE,
  assertRecoveryModuleDeployed,
  deployWebAuthnVerifierTransaction,
  isDeployed,
  passkeyAccountAddress,
  prepareSafeSetupOperation,
  readRecoveryState,
  recoveryCancelTransaction,
  recoveryGracePeriodSeconds,
  recoveryGuardianSetupTransactions,
  safeMessageHash,
  safeOwners,
  signMessageAsPasskeySafe,
  submitPasskeySafeOperation,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
  type PasskeySafeDeploymentPlan,
} from "../wallet/candide.js";
import {
  CandideGuardianError,
  assertModuleAgreement,
  candideRecoveryEnabled,
  deleteRegistration,
  deleteRegistrationStatement,
  executeRecovery,
  finalizeRecovery,
  maskTarget,
  normaliseChannelTarget,
  registerChannel,
  registrationStatement,
  requestSignatureChallenge,
  submitSignatureChallenge,
  verifyRegistration as verifyChannelOtp,
} from "../recovery/candide-guardian.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyAssertionForChallenge, verifyRegistration } from "../webauthn.js";
import { publicRecoveryRequest } from "../recovery.js";

export interface CandideRecoveryDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  publicUser: (user: User) => Record<string, unknown>;
  withSession: (user: User) => Record<string, unknown>;
}

type Assertion = { authenticatorData: string; clientDataJSON: string; signature: string };

const CEREMONY_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

/** In-flight enrolment ceremonies. Short-lived and process-local, like the
 *  Safe deployment ones: a ceremony that outlives a restart was abandoned. */
const pendingChannelRegistrations = new Map<
  string,
  {
    userId: string;
    channel: "email" | "sms";
    target: string;
    statement: string;
    challenge: string;
    moduleAddress: `0x${string}`;
    stage: "sign" | "otp";
    challengeId?: string;
    otpAttempts: number;
    expiresAt: number;
  }
>();
const pendingSafeOperations = new Map<
  string,
  { userId: string; kind: "guardian" | "cancel"; guardianAddress?: `0x${string}`; userOperation: any; expiresAt: number }
>();
const pendingChannelRemovals = new Map<
  string,
  { userId: string; registrationId: string; statement: string; challenge: string; expiresAt: number }
>();

function prune<T extends { expiresAt: number }>(map: Map<string, T>, now = Date.now()) {
  for (const [id, entry] of map) if (entry.expiresAt < now) map.delete(id);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function newCandideRequest(r: RecoveryRequest): RecoveryRequest {
  store.addRecoveryRequest(r);
  return r;
}
const passkeySafeChallenge = (h: `0x${string}`) => bufToB64url(Buffer.from(h.slice(2), "hex"));

function fail(res: express.Response, err: unknown) {
  if (err instanceof CandideGuardianError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  const message = String((err as any)?.message ?? err);
  return res.status(502).json({ error: message.slice(0, 300) });
}

// ---------------------------------------------------------------------------
// public projections

export function publicCandideRecovery(user: User) {
  const c = user.passkeySafe?.candideRecovery;
  const moduleAddress = c?.moduleAddress ?? user.passkeySafe?.recovery?.moduleAddress ?? CANDIDE.recoveryModuleAddress;
  const grace = recoveryGracePeriodSeconds(moduleAddress);
  return {
    available: candideRecoveryEnabled(),
    moduleAddress,
    gracePeriodSeconds: grace,
    guardianAddress: c?.guardianAddress,
    guardianStatus: c?.guardianStatus ?? "none",
    channels: (c?.channels ?? []).map((ch) => ({
      registrationId: ch.registrationId,
      channel: ch.channel,
      target: maskTarget(ch.channel, ch.target),
      verifiedAt: ch.verifiedAt,
    })),
  };
}

function publicRequest(r: RecoveryRequest) {
  return publicRecoveryRequest(r);
}

// ---------------------------------------------------------------------------
// shared: the user's plan, or a refusal

function activePlan(user: User): PasskeySafeDeploymentPlan {
  const plan = user.passkeySafe;
  if (!plan || plan.status !== "active" || user.address.toLowerCase() !== plan.address.toLowerCase()) {
    throw new CandideGuardianError("an active passkey Safe is required before recovery can be set up", 409, "NO_SAFE");
  }
  if (!user.passkey?.publicKey) {
    throw new CandideGuardianError("a verified passkey is required before recovery can be set up", 409, "NO_PASSKEY");
  }
  return plan as PasskeySafeDeploymentPlan;
}

async function verifyOwnerAssertion(user: User, body: any, challenge: string): Promise<User> {
  const { authenticatorData, clientDataJSON, signature } = (body ?? {}) as Partial<Assertion>;
  if (!authenticatorData || !clientDataJSON || !signature) {
    throw new CandideGuardianError("authenticatorData, clientDataJSON and signature required", 400, "BAD_ASSERTION");
  }
  const passkey = user.passkey!;
  const { signCount } = await verifyAssertionForChallenge(
    authenticatorData,
    clientDataJSON,
    signature,
    passkey.publicKey!,
    passkey.signCount ?? 0,
    passkey.rpId ?? SECURITY.rpId,
    SECURITY.origins,
    challenge,
    true,
  );
  return store.updateUser(user.id, { passkey: { ...passkey, signCount } });
}

const toAssertion = (body: any) => ({
  authenticatorData: b64urlToBuf(body.authenticatorData),
  clientDataJSON: b64urlToBuf(body.clientDataJSON),
  signature: b64urlToBuf(body.signature),
});

// ---------------------------------------------------------------------------
// finalisation — shared by the route and the sweep

/**
 * After the grace period: ask the service to finalize, confirm ON CHAIN that
 * the Safe's owners are the recovered set, and only then bind the new passkey
 * to the account. Returns the updated request; throws when it is too early.
 */
export async function finalizeCandideRecovery(
  request: RecoveryRequest,
  now = new Date(),
): Promise<RecoveryRequest> {
  if (request.status !== "GRACE_PERIOD" || !request.candide?.recoveryRequestId || !request.candide.newPasskey) {
    return request;
  }
  const c = request.candide;
  const np = c.newPasskey;
  const recoveryRequestId = c.recoveryRequestId;
  if (!np || !recoveryRequestId) return request;
  if (c.finalizeAfter && now < new Date(c.finalizeAfter)) {
    throw new CandideGuardianError(
      `the grace period runs until ${c.finalizeAfter} — the recovery can be finalized after that`,
      425,
      "GRACE_PERIOD",
    );
  }
  const user = store.findUser(request.userId);
  if (!user?.passkeySafe) throw new CandideGuardianError("the account behind this recovery no longer exists", 410, "GONE");
  const newOwners = (c.newOwners ?? []).map((a) => a.toLowerCase());
  const attempts = (c.finalizeAttempts ?? 0) + 1;

  let finalizeError: string | undefined;
  try {
    await finalizeRecovery(request.recoveryModuleAddress, recoveryRequestId);
  } catch (err: any) {
    // The service may have finalized on its own sweep, in which case the
    // chain already shows the new owners and the error is moot; anything else
    // is recorded and retried by the next sweep.
    finalizeError = String(err?.message ?? err).slice(0, 200);
  }

  let owners: string[];
  if (SECURITY.allowSimulation) {
    owners = finalizeError ? [] : newOwners;
  } else {
    try {
      owners = (await safeOwners(request.safeAddress)).map((a) => a.toLowerCase());
    } catch (err: any) {
      owners = [];
      finalizeError = `${finalizeError ? `${finalizeError}; ` : ""}could not read Safe owners: ${String(err?.message ?? err).slice(0, 120)}`;
    }
  }
  const recovered = newOwners.length > 0 && newOwners.every((o) => owners.includes(o));
  if (!recovered) {
    return store.updateRecoveryRequest(request.id, {
      candide: {
        ...c,
        finalizeAttempts: attempts,
        finalizeError: finalizeError ?? "the Safe's owners do not show the recovered set yet",
      },
    });
  }

  // The chain says the new passkey owns the Safe. Bind it, drop the lost
  // device's spending key (only the CURRENT authorizer may rotate it, and
  // that device is gone) and revoke every session the old device held.
  const owner = webauthnOwnerFromJwk(np.publicKey.jwk)!;
  store.updateUser(user.id, {
    passkey: {
      credentialId: np.credentialId,
      publicKey: np.publicKey,
      signCount: np.signCount,
      rpId: np.rpId,
      attestation: np.attestation,
      createdAt: np.createdAt,
    },
    passkeySafe: { ...user.passkeySafe, passkeyPublicKey: webauthnOwnerToStore(owner), recoveredAt: now.toISOString() },
    authorizerAddress: undefined,
  });
  for (const s of store.sessions) {
    if (s.userId === user.id && !s.revokedAt) store.revokeSession(s.id);
  }
  console.log(`RECOVERY: ${request.id} finalized — ${user.id}'s Safe ${request.safeAddress} now owned by the new passkey`);
  return store.updateRecoveryRequest(request.id, {
    status: "FINALIZED",
    finalizedAt: now.toISOString(),
    factors: { ...request.factors, otp: "passed" },
    candide: { ...c, finalizeAttempts: attempts, finalizeError: undefined },
  });
}

/** Finalize every recovery whose grace period has run. The service sponsors
 *  finalisation, so nobody has to come back to press a button. */
export async function sweepCandideRecoveries(now = new Date()): Promise<number> {
  if (!candideRecoveryEnabled()) return 0;
  let n = 0;
  for (const r of [...store.recoveryRequests]) {
    if (r.mode !== "candide") continue;
    if (r.status === "GRACE_PERIOD" && r.candide?.finalizeAfter && now >= new Date(r.candide.finalizeAfter)) {
      try {
        const out = await finalizeCandideRecovery(r, now);
        if (out.status === "FINALIZED") n++;
      } catch (err: any) {
        console.error(`recovery sweep: ${r.id}: ${err?.message ?? err}`);
      }
    } else if (["PASSKEY_PENDING", "OTP_PENDING"].includes(r.status) && now >= new Date(r.expiresAt)) {
      store.updateRecoveryRequest(r.id, { status: "EXPIRED" });
    }
  }
  return n;
}

/**
 * Deploy the new passkey's signer verifier so the recovered Safe's owner is
 * a contract that can validate signatures. Permissionless factory call from
 * the deployer key, on the app chain — skipped (and said so) when the
 * smart-account chain is not the app chain, which only happens locally.
 */
async function deployVerifierForOwner(owner: { x: bigint; y: bigint }): Promise<string | undefined> {
  if (SECURITY.allowSimulation) return undefined;
  if (BigInt(CHAIN_ID) !== BigInt(CANDIDE.chainId)) return undefined;
  const verifier = passkeyAccountAddress(owner);
  if (await isDeployed(verifier)) return undefined;
  const tx = deployWebAuthnVerifierTransaction(owner);
  const wallet = createWalletClient({
    account: privateKeyToAccount(KEYS.deployer),
    chain: { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [CANDIDE.rpcUrl] } } },
    transport: http(CANDIDE.rpcUrl),
  });
  return wallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value });
}

// ---------------------------------------------------------------------------
// the router

export function createCandideRecoveryRouter(deps: CandideRecoveryDeps) {
  const router = express.Router();
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      Promise.resolve(fn(req, res)).catch((err) => (res.headersSent ? next(err) : fail(res, err)));

  const userFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!deps.requireUserSession(req, res, user.id)) return undefined;
    return user;
  };

  // ---- enrolment ---------------------------------------------------------

  router.get(
    "/users/:id/recovery/candide",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const out: Record<string, unknown> = publicCandideRecovery(user);
      if (user.passkeySafe?.status === "active" && user.passkeySafe.candideRecovery) {
        try {
          const state = await readRecoveryState(user.passkeySafe as PasskeySafeDeploymentPlan, [
            user.passkeySafe.candideRecovery.guardianAddress,
          ]);
          out.onChain = {
            moduleEnabled: state.moduleEnabled,
            guardians: state.guardians,
            threshold: state.threshold,
            pendingRecovery: state.pending,
          };
        } catch (err: any) {
          out.onChain = { error: String(err?.message ?? err).slice(0, 160) };
        }
      }
      out.requests = store
        .recoveryRequestsForUser(user.id)
        .filter((r) => r.mode === "candide")
        .map(publicRequest);
      res.json(out);
    }),
  );

  router.post(
    "/users/:id/recovery/candide/channels",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (!candideRecoveryEnabled()) {
        return res.status(503).json({ error: "email/SMS recovery is not available on this deployment — RECOVERY_SERVICE_URL is unset" });
      }
      if (user.kycStatus !== "approved") {
        return res.status(409).json({ error: `KYC ${user.kycStatus}; recovery can be set up once the account is approved` });
      }
      const plan = activePlan(user);
      const { channel, target } = normaliseChannelTarget(req.body?.channel, req.body?.target);
      if (user.passkeySafe?.candideRecovery?.channels.some((c) => c.channel === channel && c.target === target)) {
        return res.status(409).json({ error: `${target} is already registered for recovery` });
      }
      const moduleAddress = user.passkeySafe?.candideRecovery?.moduleAddress
        ?? (await assertModuleAgreement(user.passkeySafe?.recovery?.moduleAddress ?? CANDIDE.recoveryModuleAddress));
      await assertRecoveryModuleDeployed(moduleAddress);
      if (!SECURITY.allowSimulation && !(await isDeployed(plan.address))) {
        return res.status(409).json({ error: "the passkey Safe must be deployed before recovery can be set up" });
      }
      prune(pendingChannelRegistrations);
      const statement = registrationStatement(plan.address, channel, target);
      const challenge = passkeySafeChallenge(safeMessageHash(plan.address, statement));
      const requestId = randomUUID();
      pendingChannelRegistrations.set(requestId, {
        userId: user.id,
        channel,
        target,
        statement,
        challenge,
        moduleAddress,
        stage: "sign",
        otpAttempts: 0,
        expiresAt: Date.now() + CEREMONY_TTL_MS,
      });
      res.status(201).json({
        requestId,
        channel,
        target: maskTarget(channel, target),
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge,
        message: statement,
        submitTo: `/api/users/${user.id}/recovery/candide/channels/${requestId}/signature`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/channels/:requestId/signature",
    wrap(async (req, res) => {
      let user = userFor(req, res);
      if (!user) return;
      prune(pendingChannelRegistrations);
      const pending = pendingChannelRegistrations.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.stage !== "sign") {
        return res.status(404).json({ error: "recovery registration not found or expired — start again" });
      }
      const plan = activePlan(user);
      user = await verifyOwnerAssertion(user, req.body, pending.challenge);
      const signature = await signMessageAsPasskeySafe(plan, plan.address, pending.statement, toAssertion(req.body));
      const { challengeId } = await registerChannel(plan.address, pending.channel, pending.target, pending.statement, signature);
      pending.stage = "otp";
      pending.challengeId = challengeId;
      pending.expiresAt = Date.now() + 2 * CEREMONY_TTL_MS;
      res.json({
        requestId: req.params.requestId,
        channel: pending.channel,
        target: maskTarget(pending.channel, pending.target),
        otpSent: true,
        submitTo: `/api/users/${user.id}/recovery/candide/channels/${req.params.requestId}/otp`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/channels/:requestId/otp",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      prune(pendingChannelRegistrations);
      const pending = pendingChannelRegistrations.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.stage !== "otp" || !pending.challengeId) {
        return res.status(404).json({ error: "no code is outstanding for this registration — start again" });
      }
      if (++pending.otpAttempts > OTP_MAX_ATTEMPTS) {
        pendingChannelRegistrations.delete(req.params.requestId);
        return res.status(429).json({ error: "too many wrong codes — start the registration again" });
      }
      const plan = activePlan(user);
      const { registrationId, guardianAddress } = await verifyChannelOtp(pending.challengeId, req.body?.otp);
      pendingChannelRegistrations.delete(req.params.requestId);

      const existing = user.passkeySafe!.candideRecovery;
      if (existing && existing.guardianAddress.toLowerCase() !== guardianAddress.toLowerCase()) {
        // Candide's guardian key changed underneath an enrolled account. The
        // old one stays in the module until a user-signed operation replaces
        // it; refusing here keeps the record truthful.
        return res.status(409).json({
          error: `the recovery service now signs with ${guardianAddress} but this Safe's guardian is ${existing.guardianAddress} — contact support before adding channels`,
        });
      }
      const state = await readRecoveryState(plan, existing ? [existing.guardianAddress] : []);
      const onChain = state.guardians.some((g) => g.toLowerCase() === guardianAddress.toLowerCase());
      const channel = { registrationId, channel: pending.channel, target: pending.target, verifiedAt: new Date().toISOString() };
      const updated = store.updateUser(user.id, {
        passkeySafe: {
          ...user.passkeySafe!,
          candideRecovery: {
            moduleAddress: pending.moduleAddress,
            guardianAddress,
            channels: [...(existing?.channels ?? []), channel],
            guardianStatus: onChain ? "active" : existing?.guardianStatus ?? "pending_setup",
            ...(existing?.guardianOpHash ? { guardianOpHash: existing.guardianOpHash } : {}),
            ...(onChain && !existing?.activatedAt ? { activatedAt: new Date().toISOString() } : existing?.activatedAt ? { activatedAt: existing.activatedAt } : {}),
          },
        },
      });
      res.status(201).json({
        ...deps.publicUser(updated),
        recovery: publicCandideRecovery(updated),
        next: onChain ? null : "guardian",
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/guardian",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const plan = activePlan(user);
      const c = user.passkeySafe!.candideRecovery;
      if (!c) return res.status(409).json({ error: "register an email or phone for recovery first" });
      const state = await readRecoveryState(plan);
      if (state.guardians.some((g) => g.toLowerCase() === c.guardianAddress.toLowerCase())) {
        const updated = store.updateUser(user.id, {
          passkeySafe: { ...user.passkeySafe!, candideRecovery: { ...c, guardianStatus: "active", activatedAt: c.activatedAt ?? new Date().toISOString() } },
        });
        return res.json({ ...deps.publicUser(updated), recovery: publicCandideRecovery(updated), status: "active" });
      }
      await assertRecoveryModuleDeployed(c.moduleAddress);
      // Threshold 1: Candide alone may recover. A second guardian raising it
      // to 2 needs a signer nobody runs today; recorded as a decision, not an
      // oversight.
      const txs = recoveryGuardianSetupTransactions(plan.address, c.moduleAddress, c.guardianAddress, 1, state.moduleEnabled);
      const prepared = await prepareSafeSetupOperation(plan, txs);
      prune(pendingSafeOperations);
      const requestId = randomUUID();
      pendingSafeOperations.set(requestId, {
        userId: user.id,
        kind: "guardian",
        guardianAddress: c.guardianAddress,
        userOperation: prepared.userOperation,
        expiresAt: Date.now() + CEREMONY_TTL_MS,
      });
      res.status(201).json({
        requestId,
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge: passkeySafeChallenge(prepared.challenge),
        enablesModule: !state.moduleEnabled,
        guardianAddress: c.guardianAddress,
        submitTo: `/api/users/${user.id}/recovery/candide/guardian/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/guardian/:requestId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      prune(pendingSafeOperations);
      const pending = pendingSafeOperations.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.kind !== "guardian") {
        return res.status(404).json({ error: "guardian setup request not found or expired" });
      }
      const plan = activePlan(user);
      const c = user.passkeySafe!.candideRecovery;
      if (!c) return res.status(409).json({ error: "register an email or phone for recovery first" });
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      const opHash = await submitPasskeySafeOperation(plan, pending.userOperation, toAssertion(req.body));
      pendingSafeOperations.delete(req.params.requestId);
      const state = await readRecoveryState(plan, [c.guardianAddress]);
      const onChain = state.guardians.some((g) => g.toLowerCase() === c.guardianAddress.toLowerCase());
      if (!onChain) {
        return res.status(502).json({
          error: "the operation was submitted but the module does not list the guardian yet — check the chain before retrying",
          opHash,
        });
      }
      const updated = store.updateUser(user.id, {
        passkeySafe: {
          ...user.passkeySafe!,
          candideRecovery: { ...c, guardianStatus: "active", guardianOpHash: opHash ?? undefined, activatedAt: new Date().toISOString() },
        },
      });
      res.status(201).json({ ...deps.publicUser(updated), recovery: publicCandideRecovery(updated), opHash });
    }),
  );

  router.delete(
    "/users/:id/recovery/candide/channels/:registrationId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const plan = activePlan(user);
      const c = user.passkeySafe!.candideRecovery;
      const channel = c?.channels.find((x) => x.registrationId === req.params.registrationId);
      if (!c || !channel) return res.status(404).json({ error: "no such recovery channel" });
      prune(pendingChannelRemovals);
      const statement = deleteRegistrationStatement(plan.address, channel.registrationId);
      const challenge = passkeySafeChallenge(safeMessageHash(plan.address, statement));
      const requestId = randomUUID();
      pendingChannelRemovals.set(requestId, {
        userId: user.id,
        registrationId: channel.registrationId,
        statement,
        challenge,
        expiresAt: Date.now() + CEREMONY_TTL_MS,
      });
      res.status(201).json({
        requestId,
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge,
        message: statement,
        submitTo: `/api/users/${user.id}/recovery/candide/channels/${channel.registrationId}/remove/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/channels/:registrationId/remove/:requestId",
    wrap(async (req, res) => {
      let user = userFor(req, res);
      if (!user) return;
      prune(pendingChannelRemovals);
      const pending = pendingChannelRemovals.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.registrationId !== req.params.registrationId) {
        return res.status(404).json({ error: "channel removal request not found or expired" });
      }
      const plan = activePlan(user);
      user = await verifyOwnerAssertion(user, req.body, pending.challenge);
      const signature = await signMessageAsPasskeySafe(plan, plan.address, pending.statement, toAssertion(req.body));
      await deleteRegistration(pending.registrationId, pending.statement, signature);
      pendingChannelRemovals.delete(req.params.requestId);
      const c = user.passkeySafe!.candideRecovery!;
      const updated = store.updateUser(user.id, {
        passkeySafe: {
          ...user.passkeySafe!,
          candideRecovery: { ...c, channels: c.channels.filter((x) => x.registrationId !== pending.registrationId) },
        },
      });
      res.json({ ...deps.publicUser(updated), recovery: publicCandideRecovery(updated) });
    }),
  );

  // ---- the owner's veto ---------------------------------------------------

  router.post(
    "/users/:id/recovery/candide/cancel",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const plan = activePlan(user);
      const state = await readRecoveryState(plan);
      if (!state.pending) return res.status(409).json({ error: "no recovery is pending on this Safe" });
      const prepared = await prepareSafeSetupOperation(plan, [recoveryCancelTransaction(state.moduleAddress)]);
      prune(pendingSafeOperations);
      const requestId = randomUUID();
      pendingSafeOperations.set(requestId, { userId: user.id, kind: "cancel", userOperation: prepared.userOperation, expiresAt: Date.now() + CEREMONY_TTL_MS });
      res.status(201).json({
        requestId,
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge: passkeySafeChallenge(prepared.challenge),
        pendingRecovery: state.pending,
        submitTo: `/api/users/${user.id}/recovery/candide/cancel/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/candide/cancel/:requestId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      prune(pendingSafeOperations);
      const pending = pendingSafeOperations.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.kind !== "cancel") {
        return res.status(404).json({ error: "cancel request not found or expired" });
      }
      const plan = activePlan(user);
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      const opHash = await submitPasskeySafeOperation(plan, pending.userOperation, toAssertion(req.body));
      pendingSafeOperations.delete(req.params.requestId);
      const now = new Date().toISOString();
      for (const r of store.recoveryRequestsForUser(user.id)) {
        if (r.mode === "candide" && ["OTP_PENDING", "GRACE_PERIOD"].includes(r.status)) {
          store.updateRecoveryRequest(r.id, { status: "CANCELED", canceledAt: now, cancelReason: "cancelled on chain by the account owner" });
        }
      }
      res.json({ canceled: true, opHash });
    }),
  );

  // ---- recovery from a new device (no session) ---------------------------

  const findRecoverable = (body: any): User | undefined => {
    const email = typeof body?.email === "string" ? body.email : "";
    const address = typeof body?.safeAddress === "string" && ADDRESS_RE.test(body.safeAddress) ? body.safeAddress : "";
    const user = email ? store.findUserByEmail(email) : address ? store.findUserBySafeAddress(address) : undefined;
    if (!user) return undefined;
    const c = user.passkeySafe?.candideRecovery;
    if (!c || c.guardianStatus !== "active" || user.passkeySafe?.status !== "active") return undefined;
    return user;
  };

  const requestFor = (req: express.Request, res: express.Response): RecoveryRequest | undefined => {
    const r = store.findRecoveryRequest(req.params.id);
    if (!r || r.mode !== "candide") {
      res.status(404).json({ error: "recovery not found" });
      return undefined;
    }
    if (["PASSKEY_PENDING", "OTP_PENDING"].includes(r.status) && Date.now() >= Date.parse(r.expiresAt)) {
      const expired = store.updateRecoveryRequest(r.id, { status: "EXPIRED" });
      res.status(410).json({ ...publicRequest(expired), error: "this recovery expired — start again" });
      return undefined;
    }
    return r;
  };

  router.post(
    "/recovery/candide",
    wrap(async (req, res) => {
      if (!candideRecoveryEnabled()) {
        return res.status(503).json({ error: "email/SMS recovery is not available on this deployment" });
      }
      const user = findRecoverable(req.body);
      if (!user) {
        return res.status(404).json({ error: "no account with email or SMS recovery set up matches that" });
      }
      const c = user.passkeySafe!.candideRecovery!;
      const open = store
        .recoveryRequestsForUser(user.id)
        .find((r) => r.mode === "candide" && ["PASSKEY_PENDING", "OTP_PENDING", "GRACE_PERIOD"].includes(r.status) && Date.now() < Date.parse(r.expiresAt));
      const grace = recoveryGracePeriodSeconds(c.moduleAddress) ?? 0;
      const now = new Date();
      const request: RecoveryRequest = open ?? newCandideRequest({
          id: randomUUID(),
          userId: user.id,
          safeAddress: user.passkeySafe!.address,
          mode: "candide",
          status: "PASSKEY_PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + RECOVERY.requestTtlHours * 3600_000).toISOString(),
          recoveryDelayHours: Math.max(1, Math.round(grace / 3600)),
          guardianAddress: c.guardianAddress,
          recoveryModuleAddress: c.moduleAddress,
          factors: { kyc: "passed", otp: "pending", liveness: "pending", manualReview: "pending" },
          candide: { gracePeriodSeconds: grace },
        });
      const out: Record<string, unknown> = {
        ...publicRequest(request),
        channels: c.channels.map((ch) => ({ channel: ch.channel, target: maskTarget(ch.channel, ch.target) })),
        gracePeriodSeconds: grace,
      };
      if (request.status === "PASSKEY_PENDING") {
        out.registerChallenge = issueChallenge("register", `recovery:${request.id}`);
        out.rpId = SECURITY.rpId;
        out.userHandle = user.id;
        out.displayName = user.name;
        out.submitTo = `/api/recovery/candide/${request.id}/passkey`;
      }
      res.status(open ? 200 : 201).json(out);
    }),
  );

  router.post(
    "/recovery/candide/:id/passkey",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status !== "PASSKEY_PENDING") {
        return res.status(409).json({ ...publicRequest(request), error: `recovery is ${request.status}` });
      }
      const user = store.findUser(request.userId);
      if (!user?.passkeySafe) return res.status(410).json({ error: "the account behind this recovery no longer exists" });
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if (store.findUserByCredential(credentialId)) {
        return res.status(409).json({ error: "that passkey already belongs to an account" });
      }
      let reg;
      try {
        reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, `recovery:${request.id}`);
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message ?? err) });
      }
      if (reg.credentialId !== credentialId) return res.status(400).json({ error: "credentialId does not match attestation" });
      if (reg.key.alg !== "ES256") return res.status(400).json({ error: "the new passkey must be a P-256 (ES256) credential to own a Safe" });
      const owner = webauthnOwnerFromJwk(reg.key.jwk);
      if (!owner) return res.status(400).json({ error: "could not read the new passkey's public key" });
      const plan = user.passkeySafe;
      const newOwners: `0x${string}`[] = [passkeyAccountAddress(owner), ...(plan.cosignerAddress ? [plan.cosignerAddress] : [])];
      const newThreshold = plan.threshold ?? 1;

      const sig = await requestSignatureChallenge(plan.address, newOwners, newThreshold);
      const updated = store.updateRecoveryRequest(request.id, {
        status: "OTP_PENDING",
        candide: {
          ...(request.candide ?? {}),
          newPasskey: {
            credentialId,
            publicKey: reg.key,
            signCount: reg.signCount,
            rpId: SECURITY.rpId,
            attestation,
            createdAt: new Date().toISOString(),
          },
          newOwners,
          newThreshold,
          serviceRequestId: sig.requestId,
          requiredVerifications: sig.requiredVerifications,
          auths: sig.auths.map((a) => ({ challengeId: a.challengeId, channel: a.channel, target: a.target, verified: false })),
        },
      });
      res.json({ ...publicRequest(updated), submitTo: `/api/recovery/candide/${request.id}/otp` });
    }),
  );

  router.post(
    "/recovery/candide/:id/otp",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      const c = request.candide;
      if (request.status !== "OTP_PENDING" || !c?.serviceRequestId || !c.auths || !c.newOwners || !c.newPasskey) {
        return res.status(409).json({ ...publicRequest(request), error: `recovery is ${request.status}` });
      }
      const challengeId = String(req.body?.challengeId ?? "");
      const auth = c.auths.find((a) => a.challengeId === challengeId);
      if (!auth) return res.status(404).json({ error: "unknown challenge for this recovery" });
      if (auth.verified) return res.status(409).json({ error: "that channel is already verified" });

      const result = await submitSignatureChallenge(c.serviceRequestId, challengeId, req.body?.otp);
      if (!result.success) return res.status(400).json({ error: "the code was not accepted" });
      const auths = c.auths.map((a) => (a.challengeId === challengeId ? { ...a, verified: true } : a));
      let patch: Partial<RecoveryRequest> = { candide: { ...c, auths } };

      if (result.guardianSignature && result.guardianAddress) {
        // Every channel is verified: Candide has signed. Execute now — the
        // grace period starts on chain, not when someone remembers to click.
        const executed = await executeRecovery(request.safeAddress, c.newOwners, c.newThreshold ?? 1, result.guardianAddress, result.guardianSignature);
        // Simulation-only: a test cannot wait for even the 3-minute module.
        // Ignored everywhere a chain is real, so it can never shorten a
        // production grace period.
        const simulatedGrace = SECURITY.allowSimulation ? Number(process.env.RECOVERY_SIMULATED_GRACE_SECONDS ?? "") : NaN;
        const grace = Number.isFinite(simulatedGrace) && simulatedGrace >= 0
          ? simulatedGrace
          : c.gracePeriodSeconds ?? recoveryGracePeriodSeconds(request.recoveryModuleAddress) ?? 0;
        const now = new Date();
        let verifierDeployTxHash: string | undefined;
        try {
          const owner = webauthnOwnerFromJwk(c.newPasskey.publicKey.jwk);
          if (owner) verifierDeployTxHash = await deployVerifierForOwner(owner);
        } catch (err: any) {
          console.error(`recovery ${request.id}: verifier deploy failed (will matter at first use): ${err?.message ?? err}`);
        }
        patch = {
          status: "GRACE_PERIOD",
          factors: { ...request.factors, otp: "passed" },
          candide: {
            ...c,
            auths,
            guardianAddress: result.guardianAddress,
            recoveryRequestId: executed.id,
            executedAt: now.toISOString(),
            gracePeriodSeconds: grace,
            finalizeAfter: new Date(now.getTime() + grace * 1000).toISOString(),
            ...(verifierDeployTxHash ? { verifierDeployTxHash } : {}),
          },
        };
        console.log(`RECOVERY: ${request.id} executed on chain for Safe ${request.safeAddress}; finalizable after ${patch.candide!.finalizeAfter}`);
      }
      const updated = store.updateRecoveryRequest(request.id, patch);
      res.json({
        ...publicRequest(updated),
        ...(updated.status === "GRACE_PERIOD" ? { finalizeVia: `/api/recovery/candide/${request.id}/finalize` } : {}),
      });
    }),
  );

  router.post(
    "/recovery/candide/:id/finalize",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status === "FINALIZED") return res.json(publicRequest(request));
      if (request.status !== "GRACE_PERIOD") {
        return res.status(409).json({ ...publicRequest(request), error: `recovery is ${request.status}` });
      }
      const updated = await finalizeCandideRecovery(request);
      if (updated.status !== "FINALIZED") {
        return res.status(502).json({ ...publicRequest(updated), error: updated.candide?.finalizeError ?? "not finalized yet" });
      }
      // The new passkey is bound; hand this browser a session so the user
      // lands in their account instead of at a sign-in prompt.
      const user = store.findUser(updated.userId)!;
      res.json({ ...publicRequest(updated), account: deps.withSession(user) });
    }),
  );

  router.get(
    "/recovery/candide/:id",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      res.json(publicRequest(request));
    }),
  );

  return router;
}
