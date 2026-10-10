/**
 * Recovery with a Turnkey guardian: the owner's own Google or Apple login
 * signs the module's ExecuteRecovery digest on /guardian, and the API relays
 * it (docs/recovery-guardians-plan.md, Phase 2).
 *
 * The request lifecycle is the Zoldenburg one (routes/recovery-zoldenburg.ts):
 * PASSKEY_PENDING → REVIEW_PENDING (waiting for the guardian's signature) →
 * GRACE_PERIOD → FINALIZED, with the new credential held on the request until
 * the chain shows it as the Safe's owner. What differs is who signs and what
 * is checked before a signature is relayed:
 *  - the signer must be the guardian recorded on the request when it started;
 *  - the module must still list that guardian, at threshold 1 (collecting
 *    several approvals is not built), and hold no other recovery;
 *  - the digest is recomputed from the module and must equal its own
 *    getRecoveryHash, as for the operator's signature;
 *  - the owner has been emailed that someone asked (no operator reviews this
 *    path, so the alert and the waiting period are the owner's defence: no
 *    mail, no relay).
 *
 * The chain sits behind `TurnkeyRecoveryChain` so a test can stand in for it.
 */
import type { Hex } from "viem";
import { HARNESS } from "../config.js";
import { store, type RecoveryRequest, type User } from "../store.js";
import { describeCause, redactedMessage } from "../http/log-cause.js";
import { mailAvailable } from "../adapters/mailer.js";
import {
  readRecoveryState,
  recoveryGracePeriodSeconds,
  safeOwners,
  webauthnOwnerFromJwk,
  type PasskeySafeDeploymentPlan,
  type RecoveryModuleState,
} from "../wallet/candide.js";
import { TurnkeyGuardianError, recoverTurnkeySigner, turnkeySignatureHex } from "../wallet/turnkey.js";
import { bindRecoveredPasskey, deployVerifierForOwner } from "./recovered-passkey.js";
import { recoveryDigest, recoveryTypedData, zoldenburgChain, type RecoveryTypedData } from "./zoldenburg-guardian.js";

type WebauthnOwner = NonNullable<ReturnType<typeof webauthnOwnerFromJwk>>;

/** What a Turnkey recovery needs from the chain. */
export interface TurnkeyRecoveryChain {
  readState(plan: PasskeySafeDeploymentPlan): Promise<RecoveryModuleState>;
  nonce(moduleAddress: `0x${string}`, safeAddress: `0x${string}`): Promise<bigint>;
  /** The module's own getRecoveryHash for these values. */
  onChainDigest(td: RecoveryTypedData): Promise<Hex>;
  relayRecovery(td: RecoveryTypedData, guardian: `0x${string}`, signature: Hex): Promise<{ txHash: `0x${string}` }>;
  relayFinalize(moduleAddress: `0x${string}`, safeAddress: `0x${string}`): Promise<{ txHash: `0x${string}` }>;
  safeOwners(safeAddress: `0x${string}`): Promise<`0x${string}`[]>;
  deployVerifier(owner: WebauthnOwner): Promise<string | undefined>;
}

/** Under the local harness a relayed recovery is remembered here, pending for
 *  RECOVERY_SIMULATED_GRACE_SECONDS, since there is no module to ask. */
const harnessPending = new Map<string, NonNullable<RecoveryModuleState["pending"]>>();

/** The module as it is (zoldenburgChain answers for the harness itself). */
export const turnkeyRecoveryChain: TurnkeyRecoveryChain = {
  async readState(plan) {
    // Under the harness the module is simulated from the stored guardians.
    const stored = (plan as NonNullable<User["passkeySafe"]>).socialGuardians ?? [];
    const active = stored.filter((g) => g.status === "active").map((g) => g.address);
    const state = await readRecoveryState(plan, active);
    const pending = HARNESS.enabled ? harnessPending.get(plan.address) : undefined;
    return pending ? { ...state, pending } : state;
  },
  nonce: (m, s) => zoldenburgChain.nonce(m, s),
  onChainDigest: (td) => zoldenburgChain.onChainDigest(td),
  async relayRecovery(td, guardian, signature) {
    const out = await zoldenburgChain.relayRecovery(td, guardian, signature);
    if (HARNESS.enabled) {
      const grace = Number(process.env.RECOVERY_SIMULATED_GRACE_SECONDS ?? "0") || 0;
      harnessPending.set(td.message.wallet, { newOwners: td.message.newOwners, newThreshold: Number(td.message.newThreshold), executeAfter: Math.floor(Date.now() / 1000) + grace });
    }
    return out;
  },
  relayFinalize: (m, s) => zoldenburgChain.relayFinalize(m, s),
  async safeOwners(safe) {
    if (HARNESS.enabled) return (harnessPending.get(safe)?.newOwners ?? []) as `0x${string}`[];
    return safeOwners(safe);
  },
  deployVerifier: (owner) => deployVerifierForOwner(owner),
};

/** Has the owner been told? The alert sweep marks `requested` when the mail
 *  went out, or when an earlier one in its window covers it. */
export const ownerWasAlerted = (r: RecoveryRequest): boolean => mailAvailable() && Boolean(r.ownerAlerts?.requested);

/** One signature in flight per request: two would both pass the reads. */
const signing = new Set<string>();

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

/** The one active Turnkey guardian on an account that may be recovered with
 *  it: its own deployed Safe, not an imported one. */
export function turnkeyGuardianFor(user: User | undefined) {
  const safe = user?.passkeySafe;
  if (!user || !safe || safe.status !== "active" || safe.importedAt) return undefined;
  const active = (safe.socialGuardians ?? []).filter((g) => g.status === "active");
  return active.length === 1 ? active[0] : undefined;
}

/** The ExecuteRecovery digest for this request, refused unless the module
 *  computes the same. */
export async function turnkeyRecoveryDigest(request: RecoveryRequest, chain: TurnkeyRecoveryChain) {
  const t = request.turnkey;
  if (!t?.newOwners?.length) throw new TurnkeyGuardianError("register the new passkey first", 409, "NO_NEW_PASSKEY");
  const nonce = await chain.nonce(request.recoveryModuleAddress, request.safeAddress);
  const td = recoveryTypedData({
    moduleAddress: request.recoveryModuleAddress,
    safeAddress: request.safeAddress,
    newOwners: t.newOwners,
    newThreshold: t.newThreshold ?? 1,
    nonce,
  });
  const digest = recoveryDigest(td);
  if ((await chain.onChainDigest(td)).toLowerCase() !== digest.toLowerCase()) {
    throw new TurnkeyGuardianError("the module computes a different recovery digest — nothing was signed", 503, "DIGEST_MISMATCH");
  }
  return { td, digest };
}

const planOf = (request: RecoveryRequest): { user: User; plan: PasskeySafeDeploymentPlan } => {
  const user = store.findUser(request.userId);
  if (!user?.passkeySafe) throw new TurnkeyGuardianError("the account behind this recovery no longer exists", 410, "GONE");
  return { user, plan: user.passkeySafe as PasskeySafeDeploymentPlan };
};

/**
 * The guardian's answer from Turnkey (r, s, v), checked and relayed. Returns
 * the request in GRACE_PERIOD; every refusal is a TurnkeyGuardianError and
 * relays nothing.
 */
export async function acceptTurnkeySignature(
  request: RecoveryRequest,
  sig: { r: string; s: string; v: string },
  chain: TurnkeyRecoveryChain,
  { ownerAlerted = ownerWasAlerted, now = new Date() }: { ownerAlerted?: (r: RecoveryRequest) => boolean; now?: Date } = {},
): Promise<RecoveryRequest> {
  if (request.status !== "REVIEW_PENDING") throw new TurnkeyGuardianError(`recovery is ${request.status}`, 409, "NOT_WAITING");
  if (!ownerAlerted(store.findRecoveryRequest(request.id) ?? request)) {
    throw new TurnkeyGuardianError(
      "the account's owner has not been emailed about this recovery yet — try again in a few minutes",
      409,
      "OWNER_NOT_ALERTED",
    );
  }
  if (signing.has(request.id)) throw new TurnkeyGuardianError("this recovery is already being approved", 409, "BUSY");
  signing.add(request.id);
  try {
    return await relayApproved(request, sig, chain, now);
  } finally {
    signing.delete(request.id);
  }
}

async function relayApproved(request: RecoveryRequest, sig: { r: string; s: string; v: string }, chain: TurnkeyRecoveryChain, now: Date): Promise<RecoveryRequest> {
  const t = request.turnkey!;
  const { plan } = planOf(request);
  const state = await chain.readState(plan);
  if (state.pending) {
    if (sameSet(state.pending.newOwners, t.newOwners ?? [])) return syncTurnkeyFromChain(request, chain, now);
    throw new TurnkeyGuardianError("another recovery is already pending on this account", 409, "RECOVERY_PENDING");
  }
  if (!state.guardians.some((g) => g.toLowerCase() === request.guardianAddress.toLowerCase())) {
    throw new TurnkeyGuardianError("this login is no longer a guardian of the account", 409, "GUARDIAN_GONE");
  }
  if (state.threshold !== 1) {
    throw new TurnkeyGuardianError("this account needs several guardians to approve, which is not built yet", 409, "NEEDS_MORE_APPROVALS");
  }
  const { td, digest } = await turnkeyRecoveryDigest(request, chain);
  const signature = turnkeySignatureHex(sig); // BAD_SIGNATURE on a malformed one
  const signer = await recoverTurnkeySigner(digest, sig);
  if (signer.toLowerCase() !== request.guardianAddress.toLowerCase()) {
    throw new TurnkeyGuardianError("this signature is not from the guardian on the account — log in with the Google or Apple account you added", 400, "WRONG_SIGNER");
  }
  // The owner may have cancelled while the module was read.
  const current = store.findRecoveryRequest(request.id)?.status;
  if (current !== "REVIEW_PENDING") throw new TurnkeyGuardianError(`recovery is ${current}`, 409, "NOT_WAITING");
  const { txHash } = await chain.relayRecovery(td, request.guardianAddress, signature);
  const after = await chain.readState(plan);
  if (!after.pending || !sameSet(after.pending.newOwners, t.newOwners!)) {
    throw new TurnkeyGuardianError(`the transaction ${txHash} was included but the module shows no matching recovery — check the chain`, 503, "NOT_EXECUTED");
  }
  const finalizeAfter = new Date(after.pending.executeAfter * 1000);
  let verifierDeployTxHash: string | undefined;
  try {
    const owner = webauthnOwnerFromJwk(t.newPasskey!.publicKey.jwk);
    if (owner) verifierDeployTxHash = await chain.deployVerifier(owner);
  } catch (err) {
    console.error(`recovery ${request.id}: verifier deploy failed (will matter at first use): ${describeCause(err)}`);
  }
  console.log(`RECOVERY: ${request.id} approved by its Turnkey guardian and executed (${txHash}); finalizable after ${finalizeAfter.toISOString()}`);
  // The module holds one recovery; the account's other open requests are moot.
  for (const other of store.recoveryRequestsForUser(request.userId)) {
    if (other.id !== request.id && other.mode === "turnkey" && ["PASSKEY_PENDING", "REVIEW_PENDING"].includes(other.status)) {
      store.updateRecoveryRequest(other.id, { status: "CANCELED", canceledAt: now.toISOString(), cancelReason: "another recovery of this account went on chain" });
    }
  }
  return store.updateRecoveryRequest(request.id, {
    status: "GRACE_PERIOD",
    factors: { ...request.factors, manualReview: "passed" },
    turnkey: {
      ...t,
      recoveryHash: digest,
      executeTxHash: txHash,
      executedAt: now.toISOString(),
      gracePeriodSeconds: recoveryGracePeriodSeconds(request.recoveryModuleAddress) ?? undefined,
      finalizeAfter: finalizeAfter.toISOString(),
      ...(verifierDeployTxHash ? { verifierDeployTxHash } : {}),
    },
  });
}

/** Move the request to what the chain says, as syncZoldenburgFromChain does. */
export async function syncTurnkeyFromChain(request: RecoveryRequest, chain: TurnkeyRecoveryChain, now = new Date()): Promise<RecoveryRequest> {
  const t = request.turnkey;
  if (!t?.newOwners?.length || !["REVIEW_PENDING", "GRACE_PERIOD"].includes(request.status)) return request;
  const { user, plan } = planOf(request);
  if (request.status === "REVIEW_PENDING") {
    const state = await chain.readState(plan);
    if (state.pending && sameSet(state.pending.newOwners, t.newOwners)) {
      return store.updateRecoveryRequest(request.id, {
        status: "GRACE_PERIOD",
        turnkey: { ...t, executedAt: t.executedAt ?? now.toISOString(), finalizeAfter: new Date(state.pending.executeAfter * 1000).toISOString() },
      });
    }
  }
  if (sameSet(await chain.safeOwners(request.safeAddress), t.newOwners)) return bindAndFinish(request, user, now, undefined);
  return request;
}

function bindAndFinish(request: RecoveryRequest, user: User, now: Date, txHash: `0x${string}` | undefined): RecoveryRequest {
  const t = request.turnkey!;
  bindRecoveredPasskey(user, t.newPasskey!, now);
  console.log(`RECOVERY: ${request.id} finalized — ${user.id}'s Safe ${request.safeAddress} now owned by the new passkey`);
  return store.updateRecoveryRequest(request.id, {
    status: "FINALIZED",
    finalizedAt: now.toISOString(),
    turnkey: { ...t, ...(txHash ? { finalizeTxHash: txHash } : {}), finalizeError: undefined },
  });
}

/** After the grace period: relay finalizeRecovery, then bind the passkey only
 *  if the chain shows it as the Safe's owner. */
export async function finalizeTurnkeyRecovery(request: RecoveryRequest, chain: TurnkeyRecoveryChain, now = new Date()): Promise<RecoveryRequest> {
  const t = request.turnkey;
  if (request.status !== "GRACE_PERIOD" || !t?.newPasskey || !t.newOwners?.length) return request;
  if (t.finalizeAfter && now < new Date(t.finalizeAfter)) {
    throw new TurnkeyGuardianError(`the waiting period runs until ${t.finalizeAfter}`, 425, "GRACE_PERIOD");
  }
  const { user } = planOf(request);
  let finalizeError: string | undefined;
  let txHash: `0x${string}` | undefined;
  try {
    txHash = (await chain.relayFinalize(request.recoveryModuleAddress, request.safeAddress)).txHash;
  } catch (err) {
    // Anyone may finalise; the owner read decides.
    finalizeError = redactedMessage(err).slice(0, 200);
  }
  let owners: string[] = [];
  try {
    owners = await chain.safeOwners(request.safeAddress);
  } catch (err) {
    finalizeError = `${finalizeError ? `${finalizeError}; ` : ""}could not read Safe owners: ${redactedMessage(err).slice(0, 120)}`;
  }
  if (!sameSet(owners, t.newOwners)) {
    return store.updateRecoveryRequest(request.id, {
      turnkey: { ...t, finalizeAttempts: (t.finalizeAttempts ?? 0) + 1, finalizeError: finalizeError ?? "the Safe's owners do not show the recovered set yet" },
    });
  }
  return bindAndFinish(request, user, now, txHash);
}

/** Expire unanswered requests, pick up executions, finalise after the wait. */
export async function sweepTurnkeyRecoveries(now = new Date(), chain: TurnkeyRecoveryChain = turnkeyRecoveryChain): Promise<number> {
  let n = 0;
  for (const r of [...store.recoveryRequests]) {
    if (r.mode !== "turnkey") continue;
    // The store updates rows in place, so read the status before any write.
    const before = r.status;
    try {
      if (["PASSKEY_PENDING", "REVIEW_PENDING"].includes(r.status) && now >= new Date(r.expiresAt)) {
        store.updateRecoveryRequest(r.id, { status: "EXPIRED" });
        continue;
      }
      let cur = r.status === "REVIEW_PENDING" ? await syncTurnkeyFromChain(r, chain, now) : r;
      if (cur.status === "GRACE_PERIOD" && cur.turnkey?.finalizeAfter && now >= new Date(cur.turnkey.finalizeAfter)) {
        cur = await finalizeTurnkeyRecovery(cur, chain, now);
      }
      if (cur.status === "FINALIZED" && before !== "FINALIZED") n++;
    } catch (err) {
      console.error(`recovery sweep (turnkey): ${r.id}: ${describeCause(err)}`);
    }
  }
  return n;
}
