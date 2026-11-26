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
 * The person also proves they hold the bank account the owner enrolled: a
 * second 1 € from it, with a recovery code (recovery/zoldenburg-bank-check.ts).
 *
 * REVIEW (`/admin/recoveries*`, operator passkey): an operator checks the person
 * against the identity Monerium verified and signs as guardian from a hardware
 * wallet — in Safe Cover, or here via eth_signTypedData_v4 with the API
 * relaying. The request moves to GRACE_PERIOD only when the CHAIN shows the
 * recovery, and the new passkey is bound only when the chain shows it as the
 * owner. During the grace period the old passkey can cancel.
 */
import { mapSeq } from "../seq.js";
import express from "express";
import { hashTypedData } from "viem";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CHAIN_ID, HARNESS, RECOVERY, SECURITY } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { operatorLabel, requireOperator } from "../http/guards.js";
import { describeCause, describeError, shortErrorForClient, redactedMessage } from "../http/log-cause.js";
import { publicRecoveryRequest, starterRecoveryRequest } from "../recovery.js";
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
import { hostedGuardianBlocked, ONE_GUARDIAN_MESSAGE } from "../recovery/one-guardian.js";
import {
  CANDIDE,
  assertRecoveryModuleDeployed,
  passkeyAccountAddress,
  prepareSafeSetupOperation,
  SafeVerifierMissingError,
  readRecoveryState,
  recoveryGracePeriodSeconds,
  safeOwners,
  submitPasskeySafeOperationWithReceipt,
  webauthnOwnerFromJwk,
  type PasskeySafeDeploymentPlan,
  type RecoveryModuleState,
} from "../wallet/candide.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyRegistration } from "../webauthn.js";
import { ADDRESS_RE } from "../domain/contacts.js";
import { checkOpAssertion } from "../http/passkey-assertion.js";
import { ENROLMENT, enrolmentAvailable, enrolmentView, zoldenburgArmed } from "../recovery/zoldenburg-enrolment.js";
import {
  bankCheckPassed,
  bankCheckView,
  RECOVERY_BANK,
  canIssueRecoveryBankCode,
  checkRecoveryBankPayment,
  issueRecoveryBankCode,
} from "../recovery/zoldenburg-bank-check.js";

export interface ZoldenburgRecoveryDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;
  /** The module's guardians and pending recovery, read from the chain. Tests stage a pending one. */
  readState?: (plan: PasskeySafeDeploymentPlan) => Promise<RecoveryModuleState>;
  /** Moves a request to what the chain shows. Tests stage an execution made elsewhere. */
  sync?: typeof syncZoldenburgFromChain;
}

const CEREMONY_TTL_MS = 5 * 60_000;
/** A start that never registers a passkey expires after this. */
const PASSKEY_WAIT_MS = 60 * 60_000;
/** Requests one account may have waiting at once. Each holds a slot until
 *  it ends, and a passkey costs a stranger nothing: this many holding one
 *  refuse every new start until one ends (docs/recovery-and-signers.md). */
const MAX_OPEN_REQUESTS = 10;
const OPEN = ["PASSKEY_PENDING", "REVIEW_PENDING", "GRACE_PERIOD", "RELAYING"] as const;
/** A request no one has signed: the owner or the reviewer may still end it. */
const CANCELLABLE = ["PASSKEY_PENDING", "REVIEW_PENDING"] as const;

/**
 * How long a relay may hold RELAYING before the sweep asks the chain. A relay
 * waits up to 90 s for its receipt (recovery/zoldenburg-guardian.ts), so one
 * still RELAYING after this was cut off (a restart, a crash).
 */
export const RELAY_TIMEOUT_MS = 10 * 60_000;

/** The reserve a relay claims before its chain call (§2 rule 5). */
const relayFrom = (from: "REVIEW_PENDING" | "GRACE_PERIOD") => ({ status: "RELAYING" as const, relaying: { from, at: new Date().toISOString() } });

/** A relay that ended with nothing on chain gives the request back to the
 *  status it came from. A no-op once the relay's outcome moved it on. */
async function releaseRelay(id: string, from: "REVIEW_PENDING" | "GRACE_PERIOD", patch: Partial<RecoveryRequest> = {}) {
  return store.updateRecoveryRequestFrom(id, ["RELAYING"], { ...patch, status: from, relaying: undefined });
}

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
  if (err instanceof SafeVerifierMissingError) return res.status(err.status).json({ error: err.message, code: err.code });
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

/**
 * May Zoldenburg be removed now? Checked when the op is prepared AND again
 * right before it is submitted. Revoking a guardian does not end a recovery
 * the module already holds (verified against the deployed module in
 * scripts/recovery-module-fork-test.ts), so a pending one is cancelled first.
 */
function assertCanRemove(state: RecoveryModuleState): void {
  if (state.pending) throw new ZoldenburgRecoveryError("a recovery is pending on this account — cancel it first", 409, "RECOVERY_PENDING");
}

const moduleFor = (user: User) =>
  (user.passkeySafe?.recovery?.moduleAddress ?? user.passkeySafe?.candideRecovery?.moduleAddress ?? CANDIDE.recoveryModuleAddress) as `0x${string}`;

/** One guardian at a time (recovery/one-guardian.ts). */
function assertNoOtherGuardian(user: User, guardians: readonly string[]) {
  if (hostedGuardianBlocked(user, guardians)) throw new ZoldenburgRecoveryError(ONE_GUARDIAN_MESSAGE, 409, "OTHER_GUARDIAN");
}

/** Is Zoldenburg's CURRENT guardian the one recorded as active on this Safe? */
export function hasZoldenburgGuardian(user: User): boolean {
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
    enrolment: enrolmentView(user),
    requests: (await store
      .recoveryRequestsForUser(user.id))
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
/** The request's zoldenburg block as stored now. A write after a chain read
 *  spreads this, not a copy taken before the read, so a 1 € check that
 *  passed meanwhile is not put back. */
const zoldenburgNow = async (id: string) => (await store.findRecoveryRequest(id))!.zoldenburg!;

/** Requests closeOtherRequests skipped because their relay was in flight:
 *  closed when that relay settles without reaching the chain. */
const sparedWhileRelaying = new Set<string>();

/** A relay settled: if another recovery reached the chain meanwhile and this
 *  one did not, it ends as its siblings did. */
async function settleSpared(id: string): Promise<void> {
  return store.tx(async () => {
    if (!sparedWhileRelaying.delete(id)) return;
    const found = await store.findRecoveryRequest(id);
    if (!found) return;
    // The user's row is the lock every writer of their recovery takes.
    await store.lockUser(found.userId);
    const r = await store.updateRecoveryRequestFrom(id, ["PASSKEY_PENDING", "REVIEW_PENDING"], {
      status: "CANCELED",
      canceledAt: new Date().toISOString(),
      cancelReason: "another recovery for this account was signed",
    });
    if (r) console.warn(`RECOVERY: ${id} closed after its relay did not reach the chain (another recovery did)`);
  });
}

/** One recovery reached the chain: the others for the account end. The
 *  module holds one pending recovery, so none of them could be signed. */
async function closeOtherRequests(signed: RecoveryRequest, now: Date): Promise<void> {
  return store.tx(async () => {
    await store.lockUser(signed.userId);
    for (const r of (await store.recoveryRequestsForUser(signed.userId))) {
      if (r.id === signed.id || r.mode !== "zoldenburg" || !["PASSKEY_PENDING", "REVIEW_PENDING", "RELAYING"].includes(r.status)) continue;
      // Its signature is being relayed: closing it would hide what lands on chain.
      if (r.status === "RELAYING") {
        console.warn(`RECOVERY: ${r.id} left open while its signature is relayed (${signed.id} reached the chain)`);
        sparedWhileRelaying.add(r.id);
        continue;
      }
      await store.updateRecoveryRequestFrom(r.id, ["PASSKEY_PENDING", "REVIEW_PENDING"], { status: "CANCELED", canceledAt: now.toISOString(), cancelReason: "another recovery for this account was signed" });
    }
  });
}

export async function syncZoldenburgFromChain(request: RecoveryRequest, now = new Date()): Promise<RecoveryRequest> {
  const z = request.zoldenburg;
  if (!z?.newOwners?.length || !["REVIEW_PENDING", "GRACE_PERIOD"].includes(request.status)) return request;
  if (HARNESS.enabled) return request;
  const user = await store.findUser(request.userId);
  if (!user?.passkeySafe) return request;
  if (request.status === "REVIEW_PENDING") {
    const state = await readRecoveryState(user.passkeySafe as PasskeySafeDeploymentPlan);
    if (state.pending && sameSet(state.pending.newOwners, z.newOwners)) {
      const executeAfter = new Date(state.pending.executeAfter * 1000);
      console.log(`RECOVERY: ${request.id} seen executed on chain; finalizable after ${executeAfter.toISOString()}`);
      await closeOtherRequests(request, now);
      // From the status it was read in, or from a relay the sweep reconciles.
      const moved = await store.updateRecoveryRequestFrom(request.id, ["REVIEW_PENDING", "RELAYING"], {
        status: "GRACE_PERIOD",
        relaying: undefined,
        factors: { ...request.factors, kyc: "passed", manualReview: "passed" },
        zoldenburg: { ...(await zoldenburgNow(request.id)), executedAt: z.executedAt ?? now.toISOString(), finalizeAfter: executeAfter.toISOString() },
      });
      return moved ?? (await store.findRecoveryRequest(request.id)) ?? request;
    }
  }
  const owners = await safeOwners(request.safeAddress);
  if (sameSet(owners, z.newOwners)) return await bindAndFinish(request, user, now, undefined);
  return request;
}

async function bindAndFinish(request: RecoveryRequest, user: User, now: Date, txHash: `0x${string}` | undefined): Promise<RecoveryRequest> {
  return store.tx(async () => {
    const z = request.zoldenburg!;
    const locked = await store.lockUser(request.userId);
    // Bound once: a second finaliser or sync finds it finalised (or ended) and
    // binds nothing, so the recovered device's session is not revoked again.
    const current = await store.findRecoveryRequest(request.id);
    if (!current || !["REVIEW_PENDING", "GRACE_PERIOD", "RELAYING"].includes(current.status)) return current ?? request;
    await bindRecoveredPasskey(locked ?? user, z.newPasskey!, now);
    // Also reached without a grace period seen here (finalised in Safe Cover).
    await closeOtherRequests(request, now);
    console.log(`RECOVERY: ${request.id} finalized — ${user.id}'s Safe ${request.safeAddress} now owned by the new passkey`);
    return await store.updateRecoveryRequest(request.id, {
      status: "FINALIZED",
      relaying: undefined,
      finalizedAt: now.toISOString(),
      zoldenburg: { ...(await zoldenburgNow(request.id)), ...(txHash ? { finalizeTxHash: txHash } : {}), finalizeError: undefined },
    });
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
  const user = await store.findUser(request.userId);
  if (!user?.passkeySafe) throw new ZoldenburgRecoveryError("the account behind this recovery no longer exists", 410, "GONE");
  // One finaliser relays: the claim is committed before the chain call, and a
  // second finaliser (the sweep, an operator, the person) finds it RELAYING.
  const claimed = await store.tx(async () => {
    await store.lockUser(request.userId);
    return await store.updateRecoveryRequestFrom(request.id, ["GRACE_PERIOD"], relayFrom("GRACE_PERIOD"));
  });
  if (!claimed) return (await store.findRecoveryRequest(request.id)) ?? request;
  try {
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
      const back = await releaseRelay(request.id, "GRACE_PERIOD", {
        zoldenburg: { ...(await zoldenburgNow(request.id)), finalizeAttempts: ((await zoldenburgNow(request.id)).finalizeAttempts ?? 0) + 1, finalizeError: finalizeError ?? "the Safe's owners do not show the recovered set yet" },
      });
      return back ?? (await store.findRecoveryRequest(request.id)) ?? request;
    }
    return await bindAndFinish(request, user, now, txHash);
  } finally {
    // A throw: nothing recorded; the sweep or an operator finalises again.
    await releaseRelay(request.id, "GRACE_PERIOD");
  }
}

/**
 * A RELAYING request whose relay outlived RELAY_TIMEOUT_MS: what the chain
 * shows decides. A recovery or finalisation on chain moves it on; nothing on
 * chain gives it back to the status it came from, so the next sweep or an
 * operator relays again. A chain that cannot be read leaves it for the next
 * sweep.
 */
export async function reconcileRelay(r: RecoveryRequest, now = new Date(), sync = syncZoldenburgFromChain): Promise<RecoveryRequest> {
  const from = r.relaying?.from ?? "REVIEW_PENDING";
  const seen = await sync({ ...r, status: from }, now);
  if (seen.status !== from && seen.status !== "RELAYING") return seen;
  console.warn(`RECOVERY: ${r.id} was RELAYING past the relay timeout with nothing on chain; back to ${from}`);
  return (await releaseRelay(r.id, from)) ?? (await store.findRecoveryRequest(r.id)) ?? r;
}

export async function sweepZoldenburgRecoveries(now = new Date(), sync = syncZoldenburgFromChain): Promise<number> {
  if (!zoldenburgRecoveryEnabled()) return 0;
  let n = 0;
  for (const snap of [...await store.list("recoveryRequests")]) {
    if (snap.mode !== "zoldenburg") continue;
    // Read again: an earlier row's chain calls give a relay time to move this one.
    const r = (await store.findRecoveryRequest(snap.id)) ?? snap;
    const before = r.status;
    try {
      // A relay running: the owner's cancel and the expiry wait for it, since
      // either would leave a recovery pending on chain under a closed row.
      // One cut off is reconciled from the chain.
      if (r.status === "RELAYING") {
        // Measured on the wall clock: `now` may be a sweep's notion of time.
        if (Date.now() - Date.parse(r.relaying?.at ?? r.requestedAt) >= RELAY_TIMEOUT_MS) await reconcileRelay(r, now, sync);
        continue;
      }
      // Ask the chain before expiring: a signature relayed outside /admin
      // must still reach its grace period, or the owner is never alerted.
      let cur = r.status === "REVIEW_PENDING" ? await sync(r, now) : r;
      if (["PASSKEY_PENDING", "REVIEW_PENDING"].includes(cur.status) && now >= new Date(cur.expiresAt)) {
        // Only from the status it was read in, and not once a relay has claimed it.
        await store.tx(async () => {
          await store.lockUser(r.userId);
          await store.updateRecoveryRequestFrom(r.id, CANCELLABLE, { status: "EXPIRED" });
        });
        continue;
      }
      if (cur.status === "GRACE_PERIOD" && cur.zoldenburg?.finalizeAfter && now >= new Date(cur.zoldenburg.finalizeAfter)) {
        cur = await finalizeZoldenburgRecovery(cur, now);
      }
      if (cur.status === "FINALIZED" && before !== "FINALIZED") n++;
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
  const readState = deps.readState ?? readRecoveryState;
  const sync = deps.sync ?? syncZoldenburgFromChain;
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      Promise.resolve(fn(req, res)).catch((err) => (res.headersSent ? next(err) : fail(res, err)));

  const userFor = async (req: express.Request, res: express.Response): Promise<User | undefined> => {
    const user = await store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!(await deps.requireUserSession(req, res, user.id))) return undefined;
    return user;
  };

  // ---- the owner's choice ------------------------------------------------

  router.get(
    "/users/:id/recovery/zoldenburg",
    wrap(async (req, res) => {
      const user = await userFor(req, res);
      if (!user) return;
      res.json(await screenState(user));
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg",
    wrap(async (req, res) => {
      const user = await userFor(req, res);
      if (!user) return;
      const guardian = assertZoldenburgRecoveryEnabled();
      if (req.body?.acknowledged !== true) {
        return res.status(400).json({ error: "confirm that you read how Zoldenburg recovery works", code: "NOT_ACKNOWLEDGED" });
      }
      const plan = activePlan(user);
      // One guardian at a time: at threshold 1 Zoldenburg and a Google/Apple
      // login could each recover the account alone, and nothing collects two
      // signatures yet. Checked on the store first, then on the chain below,
      // and again right before the op is submitted.
      assertNoOtherGuardian(user, []);
      const moduleAddress = moduleFor(user);
      await assertRecoveryModuleDeployed(moduleAddress);
      // Read THIS module, whatever the stored plan says about Zoldenburg.
      const state = await readRecoveryState(
        { ...plan, recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "planned" } } as PasskeySafeDeploymentPlan,
      );
      assertNoOtherGuardian(user, state.guardians);
      const now = new Date().toISOString();
      if (!HARNESS.enabled && state.guardians.some((g) => g.toLowerCase() === guardian.toLowerCase())) {
        const updated = await store.patchUserSub(
          user.id,
          "passkeySafe",
          (ps) => ({
            ...ps!,
            recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "active", enabledAt: ps?.recovery?.enabledAt ?? now },
            recoveryChoice: { choice: "zoldenburg", at: now },
          }),
          // Added again: a new 1 € arms it, not one from an earlier time.
          { zoldenburgEnrolment: undefined },
        );
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
      const user = await userFor(req, res);
      if (!user) return;
      const plan = activePlan(user);
      const r = user.passkeySafe?.recovery;
      if (!r || r.status !== "active") return res.status(409).json({ error: "Zoldenburg is not a guardian on this account", code: "NOT_GUARDIAN" });
      const state = await readState(plan);
      assertCanRemove(state);
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
      const user = await userFor(req, res);
      if (!user) return;
      prune();
      const pending = pendingOps.get(req.params.requestId);
      if (!pending || pending.userId !== user.id) return res.status(404).json({ error: "request not found or expired — start again" });
      let plan;
      try {
        plan = activePlan(user);
        // A recovery can start between preparing the removal and the passkey
        // approving it; check again before it is submitted.
        if (pending.kind === "remove") assertCanRemove(await readState(plan));
      } catch (err) {
        pendingOps.delete(req.params.requestId);
        return fail(res, err);
      }
      if (!(await checkOpAssertion(user, req.body, pending.challenge, res))) return;
      if (pending.kind === "add") {
        // A Google/Apple guardian added since this op was prepared would sit
        // beside Zoldenburg at threshold 1.
        const zold = zoldenburgGuardianAddress()!;
        const onChain = await readRecoveryState(
          { ...plan, recovery: { moduleAddress: moduleFor(user), guardianAddress: zold, threshold: 1, status: "planned" } } as PasskeySafeDeploymentPlan,
        );
        try {
          assertNoOtherGuardian(user, onChain.guardians);
        } catch (err) {
          pendingOps.delete(req.params.requestId);
          throw err;
        }
      }
      const op = await submitPasskeySafeOperationWithReceipt(plan, pending.userOperation, toAssertion(req.body));
      pendingOps.delete(req.params.requestId);
      if (op.success === false) {
        return res.status(502).json({ error: "the operation was included but reverted — nothing changed", txHash: op.txHash });
      }
      const guardian = zoldenburgGuardianAddress()!;
      const moduleAddress = moduleFor(user);
      const now = new Date().toISOString();
      if (pending.kind === "add") {
        const updated = await store.patchUserSub(
          user.id,
          "passkeySafe",
          (ps) => ({
            ...ps!,
            recovery: { moduleAddress, guardianAddress: guardian, threshold: 1, status: "active", enabledAt: now, opHash: op.userOpHash ?? undefined },
            recoveryChoice: { choice: "zoldenburg", at: now },
          }),
          // Added again: a new 1 € arms it, not one from an earlier time.
          { zoldenburgEnrolment: undefined },
        );
        // Confirm on the chain, not on the op's say-so.
        if (!HARNESS.enabled) {
          const state = await readRecoveryState(updated.passkeySafe as PasskeySafeDeploymentPlan);
          if (!state.guardians.some((g) => g.toLowerCase() === guardian.toLowerCase())) {
            await store.patchUserSub(user.id, "passkeySafe", (ps) => ({ ...ps!, recovery: { ...ps!.recovery!, status: "planned" } }));
            return res.status(502).json({ error: "the operation was submitted but the module does not list Zoldenburg yet — check again shortly" });
          }
        }
        console.log(`RECOVERY: ${user.id} added Zoldenburg as guardian (${op.userOpHash})`);
        return res.json({ ...(await screenState(updated)), txHash: op.txHash, userOpHash: op.userOpHash });
      }
      // The enrolled bank account goes with the guardian (recovery-guardians-plan,
      // Data and GDPR): adding Zoldenburg again means sending 1 € again.
      const updated = await store.patchUserSub(
        user.id,
        "passkeySafe",
        (ps) => {
          const { recovery: _gone, ...rest } = ps!;
          return { ...rest, recoveryChoice: { choice: "declined", at: now } } as User["passkeySafe"];
        },
        { zoldenburgEnrolment: undefined },
      );
      console.log(`RECOVERY: ${user.id} removed Zoldenburg as guardian (${op.userOpHash})`);
      res.json({ ...(await screenState(updated)), txHash: op.txHash, userOpHash: op.userOpHash });
    }),
  );

  router.post(
    "/users/:id/recovery/zoldenburg/decline",
    wrap(async (req, res) => {
      const user = await userFor(req, res);
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
      const updated = await store.patchUserSub(user.id, "passkeySafe", (ps) => ({ ...ps!, recoveryChoice: { choice: "declined", at: new Date().toISOString() } }));
      res.json(await screenState(updated));
    }),
  );

  /** The owner still has their passkey and did not ask: end a request before
   *  anyone signs it. One already executed needs the on-chain cancel. */
  router.post(
    "/users/:id/recovery/zoldenburg/requests/:rid/cancel",
    wrap(async (req, res) => {
      const user = await userFor(req, res);
      if (!user) return;
      // The status, the relay test and the write are one transaction, as the
      // relay's own claim is: one of the two sees the other.
      const refused = await store.tx(async () => {
        // The user's row is the lock the relay's claim and the start take too.
        await store.lockUser(user.id);
        const r = await store.findRecoveryRequest(req.params.rid);
        if (!r || r.userId !== user.id || r.mode !== "zoldenburg") return { status: 404, body: { error: "recovery not found" } };
        // Its signature is being relayed now: once on chain, the passkey cancels it.
        if (r.status === "RELAYING") {
          return { status: 409, body: { error: "this recovery is being signed right now — cancel it with your passkey in a moment", code: "BEING_SIGNED" } };
        }
        if (!(CANCELLABLE as readonly string[]).includes(r.status)) {
          return { status: 409, body: { error: `recovery is ${r.status} — a started recovery is cancelled on chain with your passkey` } };
        }
        const canceled = await store.updateRecoveryRequestFrom(r.id, CANCELLABLE, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "cancelled by the account owner" });
        return canceled ? undefined : { status: 409, body: { error: "recovery moved on — reload" } };
      });
      if (refused) return res.status(refused.status).json(refused.body);
      res.json(await screenState(user));
    }),
  );

  // ---- asking for a recovery (no session) ---------------------------------

  const findRecoverable = async (body: any): Promise<User | undefined> => {
    const email = typeof body?.email === "string" ? body.email : "";
    const address = typeof body?.safeAddress === "string" && ADDRESS_RE.test(body.safeAddress) ? body.safeAddress : "";
    const user = email ? (await store.findUserByEmail(email)) : address ? (await store.findUserBySafeAddress(address)) : undefined;
    return user && user.passkeySafe?.status === "active" && hasZoldenburgGuardian(user) ? user : undefined;
  };

  const requestFor = async (req: express.Request, res: express.Response): Promise<RecoveryRequest | undefined> => {
    let r = await store.findRecoveryRequest(req.params.id);
    if (!r || r.mode !== "zoldenburg" || !secretMatches(r, presentedSecret(req))) {
      res.status(404).json({ error: "recovery not found" });
      return undefined;
    }
    const expired = (x: RecoveryRequest) => ["PASSKEY_PENDING", "REVIEW_PENDING"].includes(x.status) && Date.now() >= Date.parse(x.expiresAt);
    if (r.status === "RELAYING" && Date.now() >= Date.parse(r.expiresAt)) {
      // Neither expired nor open: its signature is being relayed now.
      res.status(409).json({ error: "this recovery is being signed right now — try again in a moment", code: "BEING_SIGNED" });
      return undefined;
    }
    if (expired(r)) {
      // Ask the chain before expiring, as the sweep does. An unreadable chain
      // stores nothing; the sweep tries again.
      try { r = await sync(r); } catch (err) {
        console.error(`recovery ${r.id}: chain read before expiry failed: ${describeCause(err)}`);
        res.status(503).json({ error: "could not read the recovery module — try again shortly", code: "CHAIN_UNREADABLE" });
        return undefined;
      }
    }
    if (expired(r)) {
      res.status(410).json({ ...starterRecoveryRequest(await store.updateRecoveryRequest(r.id, { status: "EXPIRED" })), error: "this recovery expired — start again" });
      return undefined;
    }
    return r;
  };

  /** A request as the person recovering sees it, with the 1 € check. */
  const askView = async (r: RecoveryRequest) => ({
    ...starterRecoveryRequest(r),
    bankCheck: bankCheckView(r, await store.findUser(r.userId)),
  });

  router.post(
    "/recovery/zoldenburg",
    wrap(async (req, res) => {
      assertZoldenburgRecoveryEnabled();
      const user = await findRecoverable(req.body);
      if (!user) return res.status(404).json({ error: "recovery not found" });
      // The open-request count, the eviction and the add are one transaction
      // under the user's lock: parallel starts would each count the same rows.
      const started = await store.tx(async () => {
        await store.lockUser(user.id);
        const now = new Date();
        const live = (await store
          .recoveryRequestsForUser(user.id))
          .filter((r) => r.mode === "zoldenburg" && (OPEN as readonly string[]).includes(r.status) && (r.status === "GRACE_PERIOD" || r.status === "RELAYING" || Date.now() < Date.parse(r.expiresAt)));
        // Only the starting browser may resume its request. Anyone else gets a
        // request of their own: several wait side by side, since the 1 € can
        // take days, and only the one whose own code is paid can be signed.
        const presented = presentedSecret(req);
        const open = live.find((r) => secretMatches(r, presented));
        if (!open) {
          const refuse = () => ({
            error: "a recovery for this account is already in progress — continue it in the browser that started it, or contact support",
            code: "RECOVERY_IN_PROGRESS",
          });
          // One is on chain: the owner's cancel or its end comes first.
          if (live.some((r) => r.status === "GRACE_PERIOD" || r.status === "RELAYING")) return refuse();
          if (live.length >= MAX_OPEN_REQUESTS) {
            // Full: the oldest with nothing invested gives way, once it is past
            // its passkey ceremony, so a flood cannot push out someone mid-way;
            // with none such, the start is refused until one ends.
            const idleBefore = now.getTime() - CEREMONY_TTL_MS;
            const idle = live
              .filter((r) => r.status === "PASSKEY_PENDING" && Date.parse(r.zoldenburg?.ceremonyAt ?? r.requestedAt) <= idleBefore)
              .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))[0];
            if (!idle) return refuse();
            await store.updateRecoveryRequestFrom(idle.id, ["PASSKEY_PENDING"], { status: "CANCELED", canceledAt: now.toISOString(), cancelReason: "superseded by a new recovery start" });
          }
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
            expiresAt: new Date(now.getTime() + PASSKEY_WAIT_MS).toISOString(),
            recoveryDelayHours: Math.max(1, Math.round((recoveryGracePeriodSeconds(moduleAddress) ?? 0) / 3600)),
            guardianAddress: user.passkeySafe!.recovery!.guardianAddress,
            recoveryModuleAddress: moduleAddress,
            factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
            zoldenburg: { accessHash: hashSecret(secret!), reference: newReference() },
          };
          await store.addRecoveryRequest(request);
        }
        const out: Record<string, unknown> = {
          ...starterRecoveryRequest(request),
          ...(secret ? { recoverySecret: secret } : {}),
          gracePeriodSeconds: recoveryGracePeriodSeconds(moduleAddress),
        };
        if (request.status === "PASSKEY_PENDING") {
          // A resume starts a new ceremony: it is not evicted mid-way at the cap.
          if (open) await store.updateRecoveryRequest(request.id, { zoldenburg: { ...request.zoldenburg!, ceremonyAt: now.toISOString() } });
          out.registerChallenge = issueChallenge("register", `recovery:${request.id}`);
          out.rpId = SECURITY.rpId;
          out.submitTo = `/api/recovery/zoldenburg/${request.id}/passkey`;
        }
        return { out, status: open ? 200 : 201 };
      });
      if ("error" in started) return res.status(409).json(started);
      res.status(started.status).json(started.out);
    }),
  );

  router.post(
    "/recovery/zoldenburg/:id/passkey",
    wrap(async (req, res) => {
      const request = await requestFor(req, res);
      if (!request) return;
      if (request.status !== "PASSKEY_PENDING") return res.status(409).json({ ...starterRecoveryRequest(request), error: `recovery is ${request.status}` });
      const user = await store.findUser(request.userId);
      if (!user?.passkeySafe) return res.status(410).json({ error: "the account behind this recovery no longer exists" });
      const { credentialId, attestation, clientDataJSON } = req.body ?? {};
      if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
        return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
      }
      if ((await store.findUserByCredential(credentialId))) return res.status(409).json({ error: "that passkey already belongs to an account" });
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
      const updated = await store.updateRecoveryRequest(request.id, {
        status: "REVIEW_PENDING",
        // The review and the 1 € check get the full wait from here.
        expiresAt: new Date(Date.now() + RECOVERY.requestTtlHours * 3600_000).toISOString(),
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
      res.json(await askView(updated));
    }),
  );

  router.get(
    "/recovery/zoldenburg/:id",
    wrap(async (req, res) => {
      let request = await requestFor(req, res);
      if (!request) return;
      request = await syncZoldenburgFromChain(request).catch(() => request!);
      res.json(await askView(request));
    }),
  );

  /** A recovery code for the second 1 €. Each call replaces the open code;
   *  the plain code is in this answer only. */
  router.post(
    "/recovery/zoldenburg/:id/bank-code",
    wrap(async (req, res) => {
      const request = await requestFor(req, res);
      if (!request) return;
      if (request.status !== "REVIEW_PENDING") return res.status(409).json({ ...(await askView(request)), error: `recovery is ${request.status}` });
      const user = await store.findUser(request.userId);
      if (!enrolmentAvailable()) return res.status(503).json({ error: "This check cannot run on this server yet. Contact support.", code: "ENROLMENT_UNAVAILABLE" });
      if (!user || !zoldenburgArmed(user)) {
        return res.status(409).json({ error: "This check is not available for this account. Contact support@zoldhq.com.", code: "NOT_ARMED" });
      }
      if (bankCheckPassed(request, user)) return res.status(409).json({ ...(await askView(request)), error: "The 1 € check has already passed.", code: "ALREADY_PASSED" });
      if (!canIssueRecoveryBankCode(request)) {
        return res.status(429).json({ ...(await askView(request)), error: "No more references for this recovery. Use the last one, or contact support@zoldhq.com.", code: "TOO_MANY_CODES" });
      }
      const { code, memo } = await issueRecoveryBankCode(request);
      res.status(201).json({ ...(await askView((await store.findRecoveryRequest(request.id))!)), code, memo });
    }),
  );

  /** Look for the second 1 € now. Monerium is asked at most every
   *  checkEveryMs per request, however many codes were issued; a faster
   *  click gets the last answer. */
  router.post(
    "/recovery/zoldenburg/:id/bank-check",
    wrap(async (req, res) => {
      const request = await requestFor(req, res);
      if (!request) return;
      const last = Date.parse(request.zoldenburg?.bankCheck?.lastReadAt ?? "");
      const next = Number.isFinite(last) ? last + ENROLMENT.checkEveryMs : 0;
      // What this click did, so the page says that and not an older answer:
      // `recent` asked nothing (the last read is under checkEveryMs old);
      // `reason` only when this click recorded one.
      const now = new Date();
      let check: { outcome: string; nextCheckAt?: string; reason?: string };
      if (now.getTime() >= next) {
        const outcome = await checkRecoveryBankPayment(request.id, undefined, now);
        const lc = (await store.findRecoveryRequest(request.id))!.zoldenburg?.bankCheck?.lastCheck;
        check = { outcome, ...(lc?.at === now.toISOString() ? { reason: lc.reason } : {}) };
      } else {
        check = { outcome: "recent", nextCheckAt: new Date(next).toISOString() };
      }
      res.json({ ...(await askView((await store.findRecoveryRequest(request.id))!)), check });
    }),
  );

  router.post(
    "/recovery/zoldenburg/:id/finalize",
    wrap(async (req, res) => {
      const request = await requestFor(req, res);
      if (!request) return;
      if (request.status === "FINALIZED") return res.json(starterRecoveryRequest(request));
      if (request.status !== "GRACE_PERIOD") return res.status(409).json({ ...starterRecoveryRequest(request), error: `recovery is ${request.status}` });
      const updated = await finalizeZoldenburgRecovery(request);
      if (updated.status !== "FINALIZED") {
        return res.status(502).json({ ...starterRecoveryRequest(updated), error: updated.zoldenburg?.finalizeError ?? "not finalized yet" });
      }
      // No session: the new passkey signs in through the ordinary login.
      res.json(starterRecoveryRequest(updated));
    }),
  );

  // ---- operator review -----------------------------------------------------

  const adminView = async (r: RecoveryRequest) => {
    const user = await store.findUser(r.userId);
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
      // The 1 € check (recovery/zoldenburg-enrolment.ts). Not armed: no
      // signing here and no Safe Cover link.
      enrolment: user
        ? {
            armed: zoldenburgArmed(user),
            bankAccountLast4: user.zoldenburgEnrolment?.bankAccountLast4,
            enrolledAt: user.zoldenburgEnrolment?.enrolledAt,
          }
        : { armed: false },
      // The second 1 €, from the enrolled account (recovery/zoldenburg-bank-check.ts).
      bankCheck: {
        passed: bankCheckPassed(r, user),
        passedAt: z?.bankCheck?.passedAt,
        // Passed once, no longer counts: the owner re-enrolled, or the
        // account is not armed any more.
        voided: Boolean(z?.bankCheck?.passedAt) && !bankCheckPassed(r, user),
        orderId: z?.bankCheck?.orderId,
        codeIssuedAt: z?.bankCheck?.code?.issuedAt,
        lastCheck: z?.bankCheck?.code ? z.bankCheck.lastCheck : undefined,
        lastReadAt: z?.bankCheck?.lastReadAt,
        codesIssued: z?.bankCheck?.codesIssued ?? 0,
        maxCodes: RECOVERY_BANK.maxCodes,
      },
      safeCoverLink:
        !(await refusalFor(r)) && z?.newOwners?.length && r.status === "REVIEW_PENDING"
          ? safeCoverRecoveryLink({ safeAddress: r.safeAddress, newOwners: z.newOwners, newThreshold: z.newThreshold ?? 1 })
          : null,
    };
  };

  /**
   * Why the operator may not sign for this request, or null. Every check
   * must have passed; there is no override. The enrolment 1 € armed the
   * account, and this request's 1 € came from the same bank account.
   */
  const refusalFor = async (r: RecoveryRequest): Promise<{ error: string; code: string } | null> => {
    const user = await store.findUser(r.userId);
    if (!user || !zoldenburgArmed(user)) {
      return {
        error: "this account never finished Zoldenburg enrolment (the 1 € from their bank), so Zoldenburg may not sign for it",
        code: "NOT_ARMED",
      };
    }
    if (!bankCheckPassed(r, user)) {
      return {
        error: "the person has not yet sent 1 € from the bank account enrolled for this account, so Zoldenburg may not sign",
        code: "BANK_CHECK_PENDING",
      };
    }
    const other = (await store
      .recoveryRequestsForUser(r.userId))
      .find((x) => x.id !== r.id && x.mode === "zoldenburg" && (x.status === "GRACE_PERIOD" || x.status === "RELAYING"));
    if (other) {
      return { error: `another recovery for this account (${other.zoldenburg?.reference}) is on chain or being signed`, code: "OTHER_RECOVERY" };
    }
    return null;
  };

  const adminRequest = async (req: express.Request, res: express.Response): Promise<RecoveryRequest | undefined> => {
    if (!requireOperator(req, res)) return undefined;
    const r = await store.findRecoveryRequest(req.params.id);
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
      const rows = await mapSeq(
        (await store.list("recoveryRequests"))
          .filter((r) => r.mode === "zoldenburg")
          .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
          .slice(0, 200),
        adminView,
      );
      // Who chose Zoldenburg as guardian (or declined), so the recovery page
      // shows which accounts an operator could ever be asked to recover.
      const enrolments = (await store.list("users"))
        .filter((u) => u.passkeySafe?.recoveryChoice || u.passkeySafe?.recovery)
        .map((u) => ({
          userId: u.id,
          name: u.name,
          email: u.email,
          safeAddress: u.passkeySafe!.address,
          ...recoveryEnrolment(u),
          armed: zoldenburgArmed(u),
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
      const guardianAddress = assertZoldenburgRecoveryEnabled();
      const issuedAt = typeof req.body?.issuedAt === "string" ? req.body.issuedAt : "";
      const age = Date.now() - Date.parse(issuedAt);
      if (!Number.isFinite(age) || age < -60_000 || age > 15 * 60_000) {
        return res.status(400).json({ error: "the check expired — start it again", code: "STALE" });
      }
      const digest = hashTypedData(guardianCheckTypedData(issuedAt) as any);
      await assertGuardianSignature(digest, req.body?.signature, guardianAddress);
      console.log(`RECOVERY: guardian wallet check passed for ${guardianAddress} (${operatorLabel(req)})`);
      res.json({ ok: true, guardianAddress });
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
      const r = await adminRequest(req, res);
      if (!r) return;
      if (r.status !== "REVIEW_PENDING") return res.status(409).json({ error: `recovery is ${r.status}` });
      const refusal = await refusalFor(r);
      if (refusal) return res.status(409).json(refusal);
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
      const r = await adminRequest(req, res);
      if (!r) return;
      if (r.status !== "REVIEW_PENDING") return res.status(409).json({ error: `recovery is ${r.status}` });
      if (Date.now() >= Date.parse(r.expiresAt)) return res.status(410).json({ error: "this request expired — the person must start again" });
      const refusal = await refusalFor(r);
      if (refusal) return res.status(409).json(refusal);
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
      // Read again after the awaits above: the owner may have cancelled, or a
      // re-enrolment voided the 1 € check, meanwhile.
      // The re-read, the checks and the claim are one transaction: a cancel or
      // a reject either lands before it (seen here) or after it (and finds
      // it RELAYING). The claim is committed before the chain call.
      const claim = await store.tx(async () => {
        await store.lockUser(r.userId);
        const current = (await store.findRecoveryRequest(r.id))!;
        if (current.status === "RELAYING") return { error: "this recovery is already being signed", code: "BUSY" };
        if (current.status !== "REVIEW_PENDING") return { error: `recovery is ${current.status}` };
        const refusalNow = await refusalFor(current);
        if (refusalNow) return refusalNow;
        if (!(await store.updateRecoveryRequestFrom(r.id, ["REVIEW_PENDING"], relayFrom("REVIEW_PENDING")))) return { error: "this recovery moved on — reload", code: "BUSY" };
        return undefined;
      });
      if (claim) return res.status(409).json(claim);
      try {
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
          const user = (await store.findUser(r.userId))!;
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
          console.error(`recovery ${r.id}: verifier deploy failed (the verifier sweep retries it): ${describeCause(err)}`);
        }
        const moved = await store.updateRecoveryRequestFrom(r.id, ["RELAYING"], {
          status: "GRACE_PERIOD",
          relaying: undefined,
          reviewedBy: operatorLabel(req),
          reviewReason: note,
          factors: { ...r.factors, kyc: "passed", manualReview: "passed" },
          // Read again after the chain calls above, as in syncZoldenburgFromChain.
          zoldenburg: {
            ...(await zoldenburgNow(r.id)),
            recoveryHash: digest,
            executeTxHash: txHash,
            executedAt: now.toISOString(),
            gracePeriodSeconds: grace,
            finalizeAfter: finalizeAfter.toISOString(),
            ...(verifierDeployTxHash ? { verifierDeployTxHash } : {}),
          },
        });
        // Reconciled from the chain meanwhile (a relay past its timeout): that stands.
        const updated = moved ?? (await store.findRecoveryRequest(r.id))!;
        await closeOtherRequests(r, now);
        console.log(`RECOVERY: ${r.id} signed by ${operatorLabel(req)} and executed (${txHash}); finalizable after ${finalizeAfter.toISOString()}`);
        res.json(await adminView(updated));
      } finally {
        // Nothing recorded (a throw, or no matching recovery on chain): back to
        // REVIEW_PENDING, where the sweep follows the chain as before.
        await releaseRelay(r.id, "REVIEW_PENDING");
        await settleSpared(r.id);
      }
    }),
  );

  /** After signing in Safe Cover: read the module and move the request. */
  router.post(
    "/admin/recoveries/:id/sync",
    wrap(async (req, res) => {
      const r = await adminRequest(req, res);
      if (!r) return;
      // A signature made outside /admin (Safe Cover, or by hand) is not
      // recorded as a review while a check is missing. The sweep still
      // follows the chain, so the owner's warning stays true.
      const refusal = r.status === "REVIEW_PENDING" ? (await refusalFor(r)) : null;
      if (refusal) return res.status(409).json(refusal);
      let updated = await syncZoldenburgFromChain(r);
      if (updated.status === "GRACE_PERIOD" && r.status === "REVIEW_PENDING") {
        const note = typeof req.body?.reviewNote === "string" ? req.body.reviewNote.trim().slice(0, 500) : "";
        updated = await store.updateRecoveryRequest(r.id, { reviewedBy: operatorLabel(req), ...(note ? { reviewReason: note } : {}) });
      }
      res.json(await adminView(updated));
    }),
  );

  router.post(
    "/admin/recoveries/:id/finalize",
    wrap(async (req, res) => {
      const r = await adminRequest(req, res);
      if (!r) return;
      if (r.status !== "GRACE_PERIOD") return res.status(409).json({ error: `recovery is ${r.status}` });
      res.json(await adminView(await finalizeZoldenburgRecovery(r)));
    }),
  );

  /** Give the person their references back, after support has spoken with
   *  them. The codes already issued stay valid; the Monerium read throttle
   *  is untouched. */
  router.post(
    "/admin/recoveries/:id/bank-reset",
    wrap(async (req, res) => {
      const r = await adminRequest(req, res);
      if (!r) return;
      if (r.status !== "REVIEW_PENDING") return res.status(409).json({ error: `recovery is ${r.status}` });
      const b = r.zoldenburg?.bankCheck;
      if (b?.passedAt && bankCheckPassed(r, await store.findUser(r.userId))) return res.status(409).json({ error: "the 1 € check has passed", code: "ALREADY_PASSED" });
      if (!b || !(b.codesIssued ?? 0)) return res.status(409).json({ error: "no references were issued for this recovery", code: "NOTHING_TO_RESET" });
      const updated = await store.updateRecoveryRequest(r.id, { zoldenburg: { ...r.zoldenburg, bankCheck: { ...b, codesIssued: 0 } } });
      console.log(`RECOVERY: ${r.id} references reset by ${operatorLabel(req)} (had ${b.codesIssued})`);
      res.json(await adminView(updated));
    }),
  );

  router.post(
    "/admin/recoveries/:id/reject",
    wrap(async (req, res) => {
      const r0 = await adminRequest(req, res);
      if (!r0) return;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
      // The status, the relay test and the write are one transaction, as the
      // relay's own claim is: one of the two sees the other.
      const out = await store.tx(async () => {
        await store.lockUser(r0.userId);
        const r = (await store.findRecoveryRequest(r0.id))!;
        if (r.status === "RELAYING") {
          return { status: 409, body: { error: "this recovery is being signed right now — once on chain only the owner's passkey can cancel it", code: "BEING_SIGNED" } };
        }
        if (!(CANCELLABLE as readonly string[]).includes(r.status)) {
          return { status: 409, body: { error: `recovery is ${r.status} — once executed only the owner's passkey can cancel it` } };
        }
        if (!reason) return { status: 400, body: { error: "give a reason — the person sees it" } };
        const updated = await store.updateRecoveryRequestFrom(r.id, CANCELLABLE, {
          status: "CANCELED",
          canceledAt: new Date().toISOString(),
          cancelReason: reason,
          reviewedBy: operatorLabel(req),
          factors: { ...r.factors, manualReview: "failed" },
        });
        return updated ? { updated } : { status: 409, body: { error: "recovery moved on — reload" } };
      });
      const { updated } = out;
      if (!updated) return res.status(out.status!).json(out.body);
      console.log(`RECOVERY: ${updated.id} rejected by ${operatorLabel(req)}`);
      res.json(await adminView(updated));
    }),
  );

  return router;
}
