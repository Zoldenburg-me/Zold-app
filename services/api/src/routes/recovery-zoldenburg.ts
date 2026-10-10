/**
 * Recovery through Zoldenburg as guardian, in three parts.
 *
 * CHOICE (`/users/:id/recovery/zoldenburg*`, session): the account holder adds
 * Zoldenburg's guardian with a passkey-signed operation, removes it the same
 * way, or declines — and declining records that they acknowledged Zoldenburg
 * then cannot recover the account (only the EURe balance is reclaimable, from
 * Monerium). Nothing adds the guardian without this.
 *
 * ASK (`/recovery/zoldenburg*`, no session — the passkey is gone): the person
 * names the account, registers a new passkey in this browser and gets a
 * reference to quote to support. Same custody rule as the Candide flow: the
 * new credential waits on the request, and the starting browser holds a
 * per-request secret every by-id route requires.
 *
 * REVIEW (`/admin/recoveries*`, operator token): an operator checks the person
 * against the identity Monerium verified and signs as guardian from a hardware
 * wallet — in Safe Cover, or here via eth_signTypedData_v4 with the API
 * relaying. The request moves to GRACE_PERIOD only when the CHAIN shows the
 * recovery, and the new passkey is bound only when the chain shows it as the
 * owner. During the grace period the old passkey can cancel.
 */
import express from "express";
import { hashTypedData } from "viem";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CHAIN_ID, HARNESS, RECOVERY, SECURITY } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { operatorLabel, requireOperator } from "../http/guards.js";
import { describeCause, describeError, shortErrorForClient, redactedMessage } from "../http/log-cause.js";
import { publicRecoveryRequest } from "../recovery.js";
import { recoveryEnrolment } from "../admin/onboarding.js";
import { bindRecoveredPasskey, deployVerifierForOwner } from "../recovery/recovered-passkey.js";
import {
  ZoldenburgRecoveryError,
  assertGuardianSignature,
  assertZoldenburgRecoveryEnabled,
  guardianCheckForWallet,
  guardianCheckTypedData,
  recoveryDigest,
  recoveryTypedData,
  safeCoverRecoveryLink,
  typedDataForWallet,
  zoldenburgChain,
  zoldenburgGuardianAddress,
  zoldenburgGuardianRemoveTransaction,
  zoldenburgGuardianSetupTransactions,
  zoldenburgRecoveryEnabled,
} from "../recovery/zoldenburg-guardian.js";
import {
  CANDIDE,
  assertRecoveryModuleDeployed,
  passkeyAccountAddress,
  prepareSafeSetupOperation,
  readRecoveryState,
  recoveryGracePeriodSeconds,
  safeOwners,
  submitPasskeySafeOperationWithReceipt,
  webauthnOwnerFromJwk,
  type PasskeySafeDeploymentPlan,
} from "../wallet/candide.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyRegistration } from "../webauthn.js";
import { ADDRESS_RE } from "../domain/contacts.js";
import { checkOpAssertion } from "../http/passkey-assertion.js";

export interface ZoldenburgRecoveryDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

const CEREMONY_TTL_MS = 5 * 60_000;
const OPEN = ["PASSKEY_PENDING", "REVIEW_PENDING", "GRACE_PERIOD"] as const;

const pendingOps = new Map<string, { userId: string; kind: "add" | "remove"; userOperation: any; expiresAt: number; challenge: string }>();
const prune = (now = Date.now()) => {
  for (const [id, e] of pendingOps) if (e.expiresAt < now) pendingOps.delete(id);
};

const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
function presentedSecret(req: express.Request): string {
  const h = req.get("x-recovery-secret");
  if (typeof h === "string" && h) return h;
  const b = req.body?.recoverySecret;
  return typeof b === "string" ? b : "";
}
function secretMatches(r: RecoveryRequest, secret: string): boolean {
  const stored = r.zoldenburg?.accessHash;
  if (!stored || !secret || secret.length > 256) return false;
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Eight characters a person can read out on a call; not a capability. */
const newReference = () => randomBytes(5).toString("hex").toUpperCase().replace(/(.{5})/, "$1-").slice(0, 11);

const passkeySafeChallenge = (h: `0x${string}`) => bufToB64url(Buffer.from(h.slice(2), "hex"));
const toAssertion = (body: any) => ({
  authenticatorData: b64urlToBuf(body.authenticatorData),
  clientDataJSON: b64urlToBuf(body.clientDataJSON),
  signature: b64urlToBuf(body.signature),
});
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

function fail(res: express.Response, err: unknown) {
  if (err instanceof ZoldenburgRecoveryError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  // 503, not 502: Cloudflare replaces an origin 502's body with its own page.
  console.error(`recovery (zoldenburg): ${describeError(err)}`);
  return res.status(503).json({ error: shortErrorForClient(err) });
}

function activePlan(user: User): PasskeySafeDeploymentPlan {
  const plan = user.passkeySafe;
  if (!plan || plan.status !== "active" || user.address.toLowerCase() !== plan.address.toLowerCase()) {
    throw new ZoldenburgRecoveryError("an active passkey Safe is required first", 409, "NO_SAFE");
  }
  if (!user.passkey?.publicKey) throw new ZoldenburgRecoveryError("a verified passkey is required first", 409, "NO_PASSKEY");
  return plan as PasskeySafeDeploymentPlan;
}

const moduleFor = (user: User) =>
  (user.passkeySafe?.recovery?.moduleAddress ?? user.passkeySafe?.candideRecovery?.moduleAddress ?? CANDIDE.recoveryModuleAddress) as `0x${string}`;

/** Is Zoldenburg's CURRENT guardian the one recorded as active on this Safe? */
function hasZoldenburgGuardian(user: User): boolean {
  const g = zoldenburgGuardianAddress();
  const r = user.passkeySafe?.recovery;
  return Boolean(g && r?.status === "active" && r.guardianAddress.toLowerCase() === g.toLowerCase());
}

/** The owner's view: stored choice, what the chain says, and any request
 *  someone opened against the account (which they can cancel). */
async function screenState(user: User) {
  const guardian = zoldenburgGuardianAddress();
  const moduleAddress = moduleFor(user);
  const out: Record<string, unknown> = {
    available: zoldenburgRecoveryEnabled(),
    guardianAddress: guardian,
    moduleAddress,
    gracePeriodSeconds: recoveryGracePeriodSeconds(moduleAddress),
    choice: user.passkeySafe?.recoveryChoice ?? null,
    active: hasZoldenburgGuardian(user),
    requests: store
      .recoveryRequestsForUser(user.id)
      .filter((r) => r.mode === "zoldenburg" && (OPEN as readonly string[]).includes(r.status))
      .map(publicRecoveryRequest),
  };
  if (user.passkeySafe?.status === "active") {
    try {
      const state = await readRecoveryState(user.passkeySafe as PasskeySafeDeploymentPlan);
      out.onChain = {
        moduleEnabled: state.moduleEnabled,
        guardians: state.guardians,
        isGuardian: Boolean(guardian && state.guardians.some((g) => g.toLowerCase() === guardian.toLowerCase())),
        pendingRecovery: state.pending,
      };
    } catch (err: any) {
      out.onChainError = redactedMessage(err).slice(0, 200);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// chain-driven transitions — shared by the routes, the admin console and the sweep

/**
 * Read the module and move the request to what the chain says: a pending
 * recovery naming exactly this request's owners starts the grace period
 * (whether it was relayed here or executed in Safe Cover); owners already
 * equal to them means it was finalised elsewhere.
 */
export async function syncZoldenburgFromChain(request: RecoveryRequest, now = new Date()): Promise<RecoveryRequest> {
  const z = request.zoldenburg;
  if (!z?.newOwners?.length || !["REVIEW_PENDING", "GRACE_PERIOD"].includes(request.status)) return request;
  if (HARNESS.enabled) return request;
  const user = store.findUser(request.userId);
  if (!user?.passkeySafe) return request;
  if (request.status === "REVIEW_PENDING") {
    const state = await readRecoveryState(user.passkeySafe as PasskeySafeDeploymentPlan);
    if (state.pending && sameSet(state.pending.newOwners, z.newOwners)) {
      const executeAfter = new Date(state.pending.executeAfter * 1000);
      console.log(`RECOVERY: ${request.id} seen executed on chain; finalizable after ${executeAfter.toISOString()}`);
      return store.updateRecoveryRequest(request.id, {
        status: "GRACE_PERIOD",
        factors: { ...request.factors, kyc: "passed", manualReview: "passed" },
        zoldenburg: { ...z, executedAt: z.executedAt ?? now.toISOString(), finalizeAfter: executeAfter.toISOString() },
      });
    }
  }
  const owners = await safeOwners(request.safeAddress);
  if (sameSet(owners, z.newOwners)) return bindAndFinish(request, user, now, undefined);
  return request;
}

function bindAndFinish(request: RecoveryRequest, user: User, now: Date, txHash: `0x${string}` | undefined): RecoveryRequest {
  const z = request.zoldenburg!;
  bindRecoveredPasskey(user, z.newPasskey!, now);
  console.log(`RECOVERY: ${request.id} finalized — ${user.id}'s Safe ${request.safeAddress} now owned by the new passkey`);
  return store.updateRecoveryRequest(request.id, {
    status: "FINALIZED",
    finalizedAt: now.toISOString(),
    zoldenburg: { ...z, ...(txHash ? { finalizeTxHash: txHash } : {}), finalizeError: undefined },
  });
}

/** After the grace period: relay finalizeRecovery, then bind the passkey only
 *  if the chain shows it as the Safe's owner. */
export async function finalizeZoldenburgRecovery(request: RecoveryRequest, now = new Date()): Promise<RecoveryRequest> {
  const z = request.zoldenburg;
  if (request.status !== "GRACE_PERIOD" || !z?.newPasskey || !z.newOwners?.length) return request;
  if (z.finalizeAfter && now < new Date(z.finalizeAfter)) {
    throw new ZoldenburgRecoveryError(`the grace period runs until ${z.finalizeAfter}`, 425, "GRACE_PERIOD");
  }
  const user = store.findUser(request.userId);
  if (!user?.passkeySafe) throw new ZoldenburgRecoveryError("the account behind this recovery no longer exists", 410, "GONE");
  let finalizeError: string | undefined;
  let txHash: `0x${string}` | undefined;
  try {
    txHash = (await zoldenburgChain.relayFinalize(request.recoveryModuleAddress, request.safeAddress)).txHash;
  } catch (err: any) {
    // Safe Cover (or anyone) may have finalised already; the owner read decides.
    finalizeError = redactedMessage(err).slice(0, 200);
  }
  let owners: string[] = [];
  if (HARNESS.enabled) owners = finalizeError ? [] : z.newOwners;
  else {
    try { owners = await safeOwners(request.safeAddress); } catch (err: any) {
      finalizeError = `${finalizeError ? `${finalizeError}; ` : ""}could not read Safe owners: ${redactedMessage(err).slice(0, 120)}`;
    }
  }
  if (!sameSet(owners, z.newOwners)) {
    return store.updateRecoveryRequest(request.id, {
      zoldenburg: { ...z, finalizeAttempts: (z.finalizeAttempts ?? 0) + 1, finalizeError: finalizeError ?? "the Safe's owners do not show the recovered set yet" },
    });
  }
  return bindAndFinish(request, user, now, txHash);
}

export async function sweepZoldenburgRecoveries(now = new Date()): Promise<number> {
  if (!zoldenburgRecoveryEnabled()) return 0;
  let n = 0;
  for (const r of [...store.recoveryRequests]) {
    if (r.mode !== "zoldenburg") continue;
    try {
      if (["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status) && now >= new Date(r.expiresAt)) {
        store.updateRecoveryRequest(r.id, { status: "EXPIRED" });
        continue;
      }
      let cur = r.status === "REVIEW_PENDING" ? await syncZoldenburgFromChain(r, now) : r;
      if (cur.status === "GRACE_PERIOD" && cur.zoldenburg?.finalizeAfter && now >= new Date(cur.zoldenburg.finalizeAfter)) {
        cur = await finalizeZoldenburgRecovery(cur, now);
      }
      if (cur.status === "FINALIZED" && r.status !== "FINALIZED") n++;
    } catch (err: any) {
      console.error(`recovery sweep: ${r.id}: ${describeCause(err)}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// the router

export function createZoldenburgRecoveryRouter(deps: ZoldenburgRecoveryDeps) {
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

  // ---- the owner's choice ------------------------------------------------

  router.get(
    "/users/:id/recovery/zoldenburg",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      res.json(await screenState(user));
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const guardian = assertZoldenburgRecoveryEnabled();
      if (req.body?.acknowledged !== true) {
        return res.status(400).json({ error: "confirm that you read how Zoldenburg recovery works", code: "NOT_ACKNOWLEDGED" });
      }
      const plan = activePlan(user);
      // One guardian at a time: at threshold 1 Zoldenburg and a Google/Apple
      // login could each recover the account alone, and nothing collects two
      // signatures yet. Checked on the store first, then on the chain below.
      const social = user.passkeySafe?.socialGuardians ?? [];
      if (social.some((g) => g.status === "active")) {
        throw new ZoldenburgRecoveryError("remove your backup login first — one guardian at a time", 409, "OTHER_GUARDIAN");
      }
      const moduleAddress = moduleFor(user);
      await assertRecoveryModuleDeployed(moduleAddress);
      // Read THIS module, whatever the stored plan says about Zoldenburg.
      const state = await readRecoveryState(
        { ...plan, recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "planned" } } as PasskeySafeDeploymentPlan,
      );
      if (state.guardians.some((g) => social.some((s) => s.address.toLowerCase() === g.toLowerCase()))) {
        throw new ZoldenburgRecoveryError("remove your backup login first — one guardian at a time", 409, "OTHER_GUARDIAN");
      }
      const now = new Date().toISOString();
      if (!HARNESS.enabled && state.guardians.some((g) => g.toLowerCase() === guardian.toLowerCase())) {
        const updated = store.updateUser(user.id, {
          passkeySafe: {
            ...user.passkeySafe!,
            recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "active", enabledAt: user.passkeySafe?.recovery?.enabledAt ?? now },
            recoveryChoice: { choice: "zoldenburg", at: now },
          },
        });
        return res.json(await screenState(updated));
      }
      const txs = zoldenburgGuardianSetupTransactions(plan.address, moduleAddress, guardian, state.moduleEnabled);
      const prepared = await prepareSafeSetupOperation(plan, txs);
      prune();
      const requestId = randomUUID();
      pendingOps.set(requestId, { userId: user.id, kind: "add", userOperation: prepared.userOperation, expiresAt: Date.now() + CEREMONY_TTL_MS, challenge: passkeySafeChallenge(prepared.challenge) });
      res.status(201).json({
        requestId,
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge: passkeySafeChallenge(prepared.challenge),
        guardianAddress: guardian,
        submitTo: `/api/users/${user.id}/recovery/zoldenburg/ops/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/remove",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const plan = activePlan(user);
      const r = user.passkeySafe?.recovery;
      if (!r || r.status !== "active") return res.status(409).json({ error: "Zoldenburg is not a guardian on this account", code: "NOT_GUARDIAN" });
      const state = await readRecoveryState(plan);
      if (state.pending) {
        return res.status(409).json({ error: "a recovery is pending on this account — cancel it first", code: "RECOVERY_PENDING" });
      }
      const tx = await zoldenburgGuardianRemoveTransaction(plan.address, r.moduleAddress, r.guardianAddress, state.guardians);
      const prepared = await prepareSafeSetupOperation(plan, [tx]);
      prune();
      const requestId = randomUUID();
      pendingOps.set(requestId, { userId: user.id, kind: "remove", userOperation: prepared.userOperation, expiresAt: Date.now() + CEREMONY_TTL_MS, challenge: passkeySafeChallenge(prepared.challenge) });
      res.status(201).json({
        requestId,
        credentialId: user.passkey!.credentialId,
        rpId: user.passkey!.rpId ?? SECURITY.rpId,
        challenge: passkeySafeChallenge(prepared.challenge),
        submitTo: `/api/users/${user.id}/recovery/zoldenburg/ops/${requestId}`,
      });
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/ops/:requestId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      prune();
      const pending = pendingOps.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) return res.status(404).json({ error: "request not found or expired — start again" });
      let plan;
      try {
        plan = activePlan(user);
      } catch (err) {
        return fail(res, err);
      }
      if (!(await checkOpAssertion(user, req.body, pending.challenge, res))) return;
      const op = await submitPasskeySafeOperationWithReceipt(plan, pending.userOperation, toAssertion(req.body));
      pendingOps.delete(req.params.requestId);
      if (op.success === false) {
        return res.status(502).json({ error: "the operation was included but reverted — nothing changed", txHash: op.txHash });
      }
      const guardian = zoldenburgGuardianAddress()!;
      const moduleAddress = moduleFor(user);
      const now = new Date().toISOString();
      if (pending.kind === "add") {
        const updated = store.updateUser(user.id, {
          passkeySafe: {
            ...user.passkeySafe!,
            recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "active", enabledAt: now, opHash: op.userOpHash ?? undefined },
            recoveryChoice: { choice: "zoldenburg", at: now },
          },
        });
        // Confirm on the chain, not on the op's say-so.
        if (!HARNESS.enabled) {
          const state = await readRecoveryState(updated.passkeySafe as PasskeySafeDeploymentPlan);
          if (!state.guardians.some((g) => g.toLowerCase() === guardian.toLowerCase())) {
            store.updateUser(user.id, { passkeySafe: { ...updated.passkeySafe!, recovery: { ...updated.passkeySafe!.recovery!, status: "planned" } } });
            return res.status(502).json({ error: "the operation was submitted but the module does not list Zoldenburg yet — check again shortly" });
          }
        }
        console.log(`RECOVERY: ${user.id} added Zoldenburg as guardian (${op.userOpHash})`);
        return res.json({ ...(await screenState(updated)), txHash: op.txHash, userOpHash: op.userOpHash });
      }
      const { recovery: _gone, ...rest } = user.passkeySafe!;
      const updated = store.updateUser(user.id, { passkeySafe: { ...rest, recoveryChoice: { choice: "declined", at: now } } as User["passkeySafe"] });
      console.log(`RECOVERY: ${user.id} removed Zoldenburg as guardian (${op.userOpHash})`);
      res.json({ ...(await screenState(updated)), txHash: op.txHash, userOpHash: op.userOpHash });
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/decline",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (req.body?.acknowledged !== true) {
        return res.status(400).json({ error: "confirm the warning before skipping recovery", code: "NOT_ACKNOWLEDGED" });
      }
      if (hasZoldenburgGuardian(user)) {
        return res.status(409).json({ error: "Zoldenburg is already a guardian — remove it with your passkey instead", code: "IS_GUARDIAN" });
      }
      // The choice is recorded on the Safe plan. Without one there is nothing
      // to decline for, and a plan built from the choice alone would be a Safe
      // with no address or owner.
      if (!user.passkeySafe) {
        return res.status(409).json({ error: "set up your passkey and smart account before choosing recovery", code: "NO_SAFE" });
      }
      const updated = store.updateUser(user.id, {
        passkeySafe: { ...user.passkeySafe, recoveryChoice: { choice: "declined", at: new Date().toISOString() } },
      });
      res.json(await screenState(updated));
    }),
  );

  /** The owner still has their passkey and did not ask: end a request before
   *  anyone signs it. One already executed needs the on-chain cancel. */
  router.post(
    "/users/:id/recovery/zoldenburg/requests/:rid/cancel",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const r = store.findRecoveryRequest(req.params.rid);
      if (!r || r.userId !== user.id || r.mode !== "zoldenburg") return res.status(404).json({ error: "recovery not found" });
      if (!["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status)) {
        return res.status(409).json({ error: `recovery is ${r.status} — a started recovery is cancelled on chain with your passkey` });
      }
      store.updateRecoveryRequest(r.id, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "cancelled by the account owner" });
      res.json(await screenState(user));
    }),
  );

  // ---- asking for a recovery (no session) ---------------------------------

  const findRecoverable = (body: any): User | undefined => {
    const email = typeof body?.email === "string" ? body.email : "";
    const address = typeof body?.safeAddress === "string" && ADDRESS_RE.test(body.safeAddress) ? body.safeAddress : "";
    const user = email ? store.findUserByEmail(email) : address ? store.findUserBySafeAddress(address) : undefined;
    return user && user.passkeySafe?.status === "active" && hasZoldenburgGuardian(user) ? user : undefined;
  };

  const requestFor = (req: express.Request, res: express.Response): RecoveryRequest | undefined => {
    const r = store.findRecoveryRequest(req.params.id);
    if (!r || r.mode !== "zoldenburg" || !secretMatches(r, presentedSecret(req))) {
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
    "/recovery/zoldenburg",
    wrap(async (req, res) => {
      assertZoldenburgRecoveryEnabled();
      const user = findRecoverable(req.body);
      if (!user) return res.status(404).json({ error: "recovery not found" });
      const now = new Date();
      let open = store
        .recoveryRequestsForUser(user.id)
        .find((r) => r.mode === "zoldenburg" && (OPEN as readonly string[]).includes(r.status) && (r.status === "GRACE_PERIOD" || Date.now() < Date.parse(r.expiresAt)));
      // Only the starting browser may resume. A request is replaced only by
      // a caller that presents its secret, so naming the account can no
      // longer cancel a victim's in-progress initiation.
      if (open && !secretMatches(open, presentedSecret(req))) {
        return res.status(409).json({
          error: "a recovery for this account is already in progress — continue it in the browser that started it, or contact support",
          code: "RECOVERY_IN_PROGRESS",
        });
      }
      const moduleAddress = user.passkeySafe!.recovery!.moduleAddress;
      const secret = open ? undefined : randomBytes(32).toString("base64url");
      let request = open;
      if (!request) {
        request = {
          id: randomUUID(),
          userId: user.id,
          safeAddress: user.passkeySafe!.address,
          mode: "zoldenburg",
          status: "PASSKEY_PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + RECOVERY.requestTtlHours * 3600_000).toISOString(),
          recoveryDelayHours: Math.max(1, Math.round((recoveryGracePeriodSeconds(moduleAddress) ?? 0) / 3600)),
          guardianAddress: user.passkeySafe!.recovery!.guardianAddress,
          recoveryModuleAddress: moduleAddress,
          factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
          zoldenburg: { accessHash: hashSecret(secret!), reference: newReference() },
        };
        store.addRecoveryRequest(request);
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
        out.submitTo = `/api/recovery/zoldenburg/${request.id}/passkey`;
      }
      res.status(open ? 200 : 201).json(out);
    }),
  );

  router.post(
    "/recovery/zoldenburg/:id/passkey",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status !== "PASSKEY_PENDING") return res.status(409).json({ ...publicRecoveryRequest(request), error: `recovery is ${request.status}` });
      const user = store.findUser(request.userId);
      if (!user?.passkeySafe) return res.status(410).json({ error: "the account behind this recovery no longer exists" });
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if (store.findUserByCredential(credentialId)) return res.status(409).json({ error: "that passkey already belongs to an account" });
      let reg;
      try {
        reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, `recovery:${request.id}`);
      } catch (err: any) {
        return res.status(400).json({ error: redactedMessage(err) });
      }
      if (reg.credentialId !== credentialId) return res.status(400).json({ error: "credentialId does not match attestation" });
      if (reg.key.alg !== "ES256") return res.status(400).json({ error: "the new passkey must be a P-256 (ES256) credential to own a Safe" });
      const owner = webauthnOwnerFromJwk(reg.key.jwk);
      if (!owner) return res.status(400).json({ error: "could not read the new passkey's public key" });
      // The new passkey becomes the ONLY owner.
      const newOwners: `0x${string}`[] = [passkeyAccountAddress(owner)];
      const updated = store.updateRecoveryRequest(request.id, {
        status: "REVIEW_PENDING",
        zoldenburg: {
          ...request.zoldenburg,
          newPasskey: {
            credentialId,
            publicKey: reg.key,
            signCount: reg.signCount,
            rpId: SECURITY.rpId,
            attestation,
            createdAt: new Date().toISOString(),
          },
          newOwners,
          newThreshold: 1,
        },
      });
      console.log(`RECOVERY: ${request.id} (${updated.zoldenburg?.reference}) awaiting operator review for ${user.id}`);
      res.json(publicRecoveryRequest(updated));
    }),
  );

  router.get(
    "/recovery/zoldenburg/:id",
    wrap(async (req, res) => {
      let request = requestFor(req, res);
      if (!request) return;
      request = await syncZoldenburgFromChain(request).catch(() => request!);
      res.json(publicRecoveryRequest(request));
    }),
  );

  router.post(
    "/recovery/zoldenburg/:id/finalize",
    wrap(async (req, res) => {
      const request = requestFor(req, res);
      if (!request) return;
      if (request.status === "FINALIZED") return res.json(publicRecoveryRequest(request));
      if (request.status !== "GRACE_PERIOD") return res.status(409).json({ ...publicRecoveryRequest(request), error: `recovery is ${request.status}` });
      const updated = await finalizeZoldenburgRecovery(request);
      if (updated.status !== "FINALIZED") {
        return res.status(502).json({ ...publicRecoveryRequest(updated), error: updated.zoldenburg?.finalizeError ?? "not finalized yet" });
      }
      // No session: the new passkey signs in through the ordinary login.
      res.json(publicRecoveryRequest(updated));
    }),
  );

  // ---- operator review -----------------------------------------------------

  const adminView = (r: RecoveryRequest) => {
    const user = store.findUser(r.userId);
    const z = r.zoldenburg;
    return {
      ...publicRecoveryRequest(r),
      reviewedBy: r.reviewedBy,
      reviewReason: r.reviewReason,
      // What the operator checks the caller against. Monerium verified the
      // identity; Zold holds the result, not the documents.
      account: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
            country: user.country,
            createdAt: user.createdAt,
            kycStatus: user.kycStatus,
            moneriumMethod: user.monerium?.method ?? (user.monerium ? "oauth" : undefined),
            moneriumProfileId: user.monerium?.profileId,
            // Every profile the account has recorded, oldest first: a relink
            // shows here as a second entry, not as a silently new id.
            moneriumProfileHistory: user.moneriumProfileHistory ?? [],
            iban: user.iban,
          }
        : null,
      safeCoverLink:
        z?.newOwners?.length && r.status === "REVIEW_PENDING"
          ? safeCoverRecoveryLink({ safeAddress: r.safeAddress, newOwners: z.newOwners, newThreshold: z.newThreshold ?? 1 })
          : null,
    };
  };

  const adminRequest = (req: express.Request, res: express.Response): RecoveryRequest | undefined => {
    if (!requireOperator(req, res)) return undefined;
    const r = store.findRecoveryRequest(req.params.id);
    if (!r || r.mode !== "zoldenburg") {
      res.status(404).json({ error: "recovery not found" });
      return undefined;
    }
    return r;
  };

  router.get(
    "/admin/recoveries",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const rows = store.recoveryRequests
        .filter((r) => r.mode === "zoldenburg")
        .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
        .slice(0, 200)
        .map(adminView);
      // Who chose Zoldenburg as guardian (or declined), so the recovery page
      // shows which accounts an operator could ever be asked to recover.
      const enrolments = store.users
        .filter((u) => u.passkeySafe?.recoveryChoice || u.passkeySafe?.recovery)
        .map((u) => ({
          userId: u.id,
          name: u.name,
          email: u.email,
          safeAddress: u.passkeySafe!.address,
          ...recoveryEnrolment(u),
        }));
      res.json({
        enabled: zoldenburgRecoveryEnabled(),
        guardianAddress: zoldenburgGuardianAddress() ?? null,
        chainId: CHAIN_ID,
        requests: rows,
        enrolments,
      });
    }),
  );

  /** Test the guardian wallet without touching any Safe: sign a harmless
   *  message, and the API says whether it recovers to the guardian. */
  router.post(
    "/admin/recoveries/guardian-check/challenge",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const guardian = assertZoldenburgRecoveryEnabled();
      const td = guardianCheckTypedData(new Date().toISOString());
      res.json({ guardianAddress: guardian, typedData: guardianCheckForWallet(td) });
    }),
  );

  router.post(
    "/admin/recoveries/guardian-check",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      const guardian = assertZoldenburgRecoveryEnabled();
      const issuedAt = typeof req.body?.issuedAt === "string" ? req.body.issuedAt : "";
      const age = Date.now() - Date.parse(issuedAt);
      if (!Number.isFinite(age) || age < -60_000 || age > 15 * 60_000) {
        return res.status(400).json({ error: "the check expired — start it again", code: "STALE" });
      }
      const digest = hashTypedData(guardianCheckTypedData(issuedAt) as any);
      await assertGuardianSignature(digest, req.body?.signature, guardian);
      console.log(`RECOVERY: guardian wallet check passed for ${guardian} (${operatorLabel(req)})`);
      res.json({ ok: true, guardianAddress: guardian });
    }),
  );

  /** The typed data to sign on the hardware wallet, checked against the
   *  digest the module computes before it is handed out. */
  const typedDataFor = async (r: RecoveryRequest) => {
    const z = r.zoldenburg!;
    const nonce = await zoldenburgChain.nonce(r.recoveryModuleAddress, r.safeAddress);
    const td = recoveryTypedData({
      moduleAddress: r.recoveryModuleAddress,
      safeAddress: r.safeAddress,
      newOwners: z.newOwners!,
      newThreshold: z.newThreshold ?? 1,
      nonce,
    });
    const digest = recoveryDigest(td);
    const onChain = await zoldenburgChain.onChainDigest(td);
    if (onChain.toLowerCase() !== digest.toLowerCase()) {
      throw new ZoldenburgRecoveryError(
        `the module computes ${onChain} but the typed data hashes to ${digest} — refusing to ask for a signature over data the module will not accept`,
        502,
        "DIGEST_MISMATCH",
      );
    }
    return { td, digest };
  };

  router.post(
    "/admin/recoveries/:id/sign-request",
    wrap(async (req, res) => {
      const r = adminRequest(req, res);
      if (!r) return;
      if (r.status !== "REVIEW_PENDING") return res.status(409).json({ error: `recovery is ${r.status}` });
      const guardian = assertZoldenburgRecoveryEnabled();
      if (r.guardianAddress.toLowerCase() !== guardian.toLowerCase()) {
        return res.status(409).json({ error: `this Safe's guardian is ${r.guardianAddress}, not the configured ${guardian}`, code: "GUARDIAN_CHANGED" });
      }
      const { td, digest } = await typedDataFor(r);
      res.json({ guardianAddress: guardian, digest, typedData: typedDataForWallet(td) });
    }),
  );

  router.post(
    "/admin/recoveries/:id/execute",
    wrap(async (req, res) => {
      const r = adminRequest(req, res);
      if (!r) return;
      if (r.status !== "REVIEW_PENDING") return res.status(409).json({ error: `recovery is ${r.status}` });
      if (Date.now() >= Date.parse(r.expiresAt)) return res.status(410).json({ error: "this request expired — the person must start again" });
      const note = typeof req.body?.reviewNote === "string" ? req.body.reviewNote.trim().slice(0, 500) : "";
      if (note.length < 10) {
        return res.status(400).json({ error: "record how the person was verified (at least a sentence) before signing", code: "NO_REVIEW_NOTE" });
      }
      const guardian = assertZoldenburgRecoveryEnabled();
      if (r.guardianAddress.toLowerCase() !== guardian.toLowerCase()) {
        return res.status(409).json({ error: `this Safe's guardian is ${r.guardianAddress}, not the configured ${guardian}`, code: "GUARDIAN_CHANGED" });
      }
      // Recomputed now, with the current nonce: a signature over anything
      // else is refused here rather than by a reverted transaction.
      const { td, digest } = await typedDataFor(r);
      const signature = await assertGuardianSignature(digest, req.body?.signature, guardian);
      const { txHash } = await zoldenburgChain.relayRecovery(td, guardian, signature);
      const now = new Date();
      // Harness-only, as in the Candide flow: a test cannot wait for even the
      // 3-minute module, and HARNESS is false on every real-money chain.
      const simulatedGrace = HARNESS.enabled ? Number(process.env.RECOVERY_SIMULATED_GRACE_SECONDS ?? "") : NaN;
      const grace = Number.isFinite(simulatedGrace) && simulatedGrace >= 0
        ? simulatedGrace
        : recoveryGracePeriodSeconds(r.recoveryModuleAddress) ?? 0;
      let finalizeAfter = new Date(now.getTime() + grace * 1000);
      if (!HARNESS.enabled) {
        const user = store.findUser(r.userId)!;
        const state = await readRecoveryState(user.passkeySafe as PasskeySafeDeploymentPlan);
        if (!state.pending || !sameSet(state.pending.newOwners, r.zoldenburg!.newOwners!)) {
          return res.status(502).json({ error: `the transaction ${txHash} was included but the module shows no matching recovery — check the chain` });
        }
        finalizeAfter = new Date(state.pending.executeAfter * 1000);
      }
      let verifierDeployTxHash: string | undefined;
      try {
        const owner = webauthnOwnerFromJwk(r.zoldenburg!.newPasskey!.publicKey.jwk);
        if (owner) verifierDeployTxHash = await deployVerifierForOwner(owner);
      } catch (err: any) {
        console.error(`recovery ${r.id}: verifier deploy failed (will matter at first use): ${describeCause(err)}`);
      }
      const updated = store.updateRecoveryRequest(r.id, {
        status: "GRACE_PERIOD",
        reviewedBy: operatorLabel(req),
        reviewReason: note,
        factors: { ...r.factors, kyc: "passed", manualReview: "passed" },
        zoldenburg: {
          ...r.zoldenburg,
          recoveryHash: digest,
          executeTxHash: txHash,
          executedAt: now.toISOString(),
          gracePeriodSeconds: grace,
          finalizeAfter: finalizeAfter.toISOString(),
          ...(verifierDeployTxHash ? { verifierDeployTxHash } : {}),
        },
      });
      console.log(`RECOVERY: ${r.id} signed by ${operatorLabel(req)} and executed (${txHash}); finalizable after ${finalizeAfter.toISOString()}`);
      res.json(adminView(updated));
    }),
  );

  /** After signing in Safe Cover: read the module and move the request. */
  router.post(
    "/admin/recoveries/:id/sync",
    wrap(async (req, res) => {
      const r = adminRequest(req, res);
      if (!r) return;
      let updated = await syncZoldenburgFromChain(r);
      if (updated.status === "GRACE_PERIOD" && r.status === "REVIEW_PENDING") {
        const note = typeof req.body?.reviewNote === "string" ? req.body.reviewNote.trim().slice(0, 500) : "";
        updated = store.updateRecoveryRequest(r.id, { reviewedBy: operatorLabel(req), ...(note ? { reviewReason: note } : {}) });
      }
      res.json(adminView(updated));
    }),
  );

  router.post(
    "/admin/recoveries/:id/finalize",
    wrap(async (req, res) => {
      const r = adminRequest(req, res);
      if (!r) return;
      if (r.status !== "GRACE_PERIOD") return res.status(409).json({ error: `recovery is ${r.status}` });
      res.json(adminView(await finalizeZoldenburgRecovery(r)));
    }),
  );

  router.post(
    "/admin/recoveries/:id/reject",
    wrap(async (req, res) => {
      const r = adminRequest(req, res);
      if (!r) return;
      if (!["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status)) {
        return res.status(409).json({ error: `recovery is ${r.status} — once executed only the owner's passkey can cancel it` });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
      if (!reason) return res.status(400).json({ error: "give a reason — the person sees it" });
      const updated = store.updateRecoveryRequest(r.id, {
        status: "CANCELED",
        canceledAt: new Date().toISOString(),
        cancelReason: reason,
        reviewedBy: operatorLabel(req),
        factors: { ...r.factors, manualReview: "failed" },
      });
      console.log(`RECOVERY: ${r.id} rejected by ${operatorLabel(req)}`);
      res.json(adminView(updated));
    }),
  );

  return router;
}
