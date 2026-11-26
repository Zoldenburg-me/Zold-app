/**
 * The org Safe signature queue: put an op in, keep it honest against the
 * chain, and relay it once the chain's threshold of owners has signed.
 * The rules are in domain/safe-op-queue.ts; this file adds the store and the
 * chain. Behind ORG_SAFE_QUEUE_ENABLED; personal and sole-trader Safes never
 * come here and keep assertPasskeyAloneCanSign.
 */
import { randomUUID } from "node:crypto";
import type { UserOperationV9 } from "abstractionkit";
import { orgSafeQueueEnabled } from "../config.js";
import { store, type PendingSafeOp, type SafeOpSignature } from "../store.js";
import type { Member, Organisation } from "../domain/types.js";
import {
  SAFE_OP_TTL_MS,
  canQueueSafeOp,
  checkAgainstChain,
  decodeUserOperation,
  encodeUserOperation,
  type ChainCheck,
  type SafeChainView,
} from "../domain/safe-op-queue.js";
import { b64urlToBuf } from "../webauthn.js";
import {
  BundlerRefusedError,
  CANDIDE,
  SafeOperationUncertainError,
  safeEntryPointNonce,
  safeOperationDigest,
  safeOwners,
  safeThreshold,
  submitMultiOwnerSafeOperation,
  webauthnOwnerFromStore,
  type SubmittedOperation,
} from "./candide.js";
import { redactedMessage } from "../http/log-cause.js";

export class SafeOpRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The chain, injected so a suite can play it. */
export interface SafeOpChain {
  read(safeAddress: `0x${string}`, nonce: bigint): Promise<SafeChainView>;
  relay(op: PendingSafeOp, signatures: SafeOpSignature[]): Promise<SubmittedOperation>;
}

export const liveSafeOpChain: SafeOpChain = {
  async read(safeAddress, nonce) {
    const [owners, threshold, next] = await Promise.all([
      safeOwners(safeAddress),
      safeThreshold(safeAddress),
      safeEntryPointNonce(safeAddress, nonce),
    ]);
    return { owners, threshold, nonce: next };
  },
  relay(op, signatures) {
    return submitMultiOwnerSafeOperation(
      op.safeAddress,
      decodeUserOperation<UserOperationV9>(op.userOperation),
      op.digest,
      signatures.map((s) => ({
        publicKey: webauthnOwnerFromStore(s.passkeyPublicKey),
        assertion: {
          authenticatorData: b64urlToBuf(s.authenticatorData),
          clientDataJSON: b64urlToBuf(s.clientDataJSON),
          signature: b64urlToBuf(s.signature),
        },
      })),
    );
  },
};

export function assertQueueOpen(): void {
  if (!orgSafeQueueEnabled()) {
    throw new SafeOpRefusal(409, "ORG_SAFE_QUEUE_OFF", "Multi-signature operations are not switched on for this deployment.");
  }
}

/**
 * Queue an op prepared once (prepareMultiOwnerSafeOperation): its digest and
 * nonce are fixed from here on. A member who may draft queues it; nobody's
 * signature comes with it, the creator's included. Refused unless the Safe is
 * one of the org's own accounts and {challenge, userOperation, nonce} agree:
 * the digest recomputed from the op, and the op's own sender and nonce.
 */
export async function queueSafeOp(args: {
  org: Organisation;
  member: Member;
  safeAddress: `0x${string}`;
  kind: string;
  /** Caller-supplied free text, for the queue's list only. Built server-side,
   *  never a client body field, and never the only thing an owner reads before
   *  signing: the sign view renders the decoded calls. */
  summary: string;
  prepared: { challenge: `0x${string}`; userOperation: unknown; nonce: bigint };
  /** The guardian a recovery-guardian op adds; checked again before each signature. */
  guardianAddress?: `0x${string}`;
  now?: number;
}): Promise<PendingSafeOp> {
  return store.tx(async () => {
    assertQueueOpen();
    const { prepared } = args;
    // The org's row held and the member read under it: a role change or
    // deactivation (which take the same lock) lands before or after, whole.
    const org = (await store.lockOrganisation(args.org.id)) ?? args.org;
    const member = (await store.findMember(args.member.id)) ?? args.member;
    if (org.type !== "business") throw new SafeOpRefusal(409, "NOT_A_BUSINESS", "Only a business organisation has a Safe with several owners.");
    if (member.orgId !== org.id || member.status !== "active" || !canQueueSafeOp(member.role)) {
      throw new SafeOpRefusal(403, "CANNOT_QUEUE", `Your role (${member.role}) cannot queue payments.`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(prepared.challenge)) throw new Error("a queued op needs its 32-byte digest");
    const safe = args.safeAddress.toLowerCase();
    if (!(await store.accountsOf(org.id)).some((a) => a.address?.toLowerCase() === safe)) {
      throw new SafeOpRefusal(409, "NOT_THE_ORG_SAFE", "This Safe is not one of the organisation's accounts.");
    }
    const op = prepared.userOperation as Partial<UserOperationV9> | null;
    let digest: string | null = null;
    if (op && typeof op === "object" && typeof op.sender === "string" && op.sender.toLowerCase() === safe && op.nonce === prepared.nonce) {
      try { digest = safeOperationDigest(args.safeAddress, op as UserOperationV9); } catch { digest = null; }
    }
    if (!digest || digest.toLowerCase() !== prepared.challenge.toLowerCase()) {
      throw new SafeOpRefusal(409, "OP_MISMATCH", "The operation does not match its digest, Safe or nonce.");
    }
    const now = args.now ?? Date.now();
    return await store.addSafeOp({
      id: `sop_${randomUUID()}`,
      orgId: org.id,
      safeAddress: args.safeAddress,
      chainId: Number(CANDIDE.chainId),
      kind: args.kind,
      summary: args.summary,
      digest: prepared.challenge,
      userOperation: encodeUserOperation(prepared.userOperation),
      nonce: prepared.nonce.toString(),
      createdByMemberId: member.id,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SAFE_OP_TTL_MS).toISOString(),
      state: "PENDING",
      signatures: [],
      dropped: [],
      ...(args.guardianAddress ? { guardianAddress: args.guardianAddress } : {}),
    });
  });
}

/**
 * Read the chain for a PENDING op and write down what it says: removed
 * owners' signatures are dropped (Q6), and an expired or stale-nonce op ends.
 * Returns the op as stored afterwards, and the chain's view.
 */
export async function refreshSafeOp(
  op: PendingSafeOp,
  chain: SafeOpChain,
  now = Date.now(),
): Promise<{ op: PendingSafeOp; view: SafeChainView; check: ChainCheck }> {
  if (op.chainId !== Number(CANDIDE.chainId)) {
    throw new SafeOpRefusal(409, "WRONG_CHAIN", `This op belongs to chain ${op.chainId}; this deployment runs chain ${CANDIDE.chainId}.`);
  }
  const view = await chain.read(op.safeAddress, BigInt(op.nonce));
  const check = checkAgainstChain(op, view, now);
  if (check.dropped.length) {
    await store.dropSafeOpSignatures(op.id, check.dropped.map((s) => s.ownerAddress), "no longer an owner of the Safe", new Date(now).toISOString());
  }
  if (check.end) await store.endPendingSafeOp(op.id, check.end);
  return { op: (await store.findSafeOp(op.id))!, view, check };
}

/**
 * Relay the op if, re-read from the chain now, enough current owners signed.
 * Exactly one caller relays (claimSafeOpRelay). Compensation is asymmetric:
 * only a refusal the bundler states, or an included op that reverted, is
 * FAILED; anything else may have landed and is MANUAL_REVIEW.
 */
export async function relayIfReady(op: PendingSafeOp, chain: SafeOpChain, now = Date.now()): Promise<PendingSafeOp> {
  const fresh = await refreshSafeOp(op, chain, now);
  if (fresh.op.state !== "PENDING" || !fresh.check.thresholdMet) return fresh.op;
  const claimed = await store.claimSafeOpRelay(op.id);
  if (!claimed) return (await store.findSafeOp(op.id))!;
  let outcome: SubmittedOperation;
  try {
    const owners = new Set(fresh.view.owners.map((o) => o.toLowerCase()));
    const signed = claimed.signatures.filter((s) => owners.has(s.ownerAddress.toLowerCase()));
    outcome = await chain.relay(claimed, signed.slice(0, fresh.check.threshold));
  } catch (err) {
    if (err instanceof BundlerRefusedError) return await store.finishSafeOp(op.id, { state: "FAILED", reason: err.message });
    if (err instanceof SafeOperationUncertainError) {
      return await store.finishSafeOp(op.id, { state: "MANUAL_REVIEW", reason: err.message, userOpHash: err.userOpHash });
    }
    return await store.finishSafeOp(op.id, { state: "MANUAL_REVIEW", reason: `the relay did not answer clearly: ${redactedMessage(err)}` });
  }
  if (outcome.success === false) {
    return await store.finishSafeOp(op.id, {
      state: "FAILED",
      reason: "the operation was included but the Safe call reverted — nothing changed",
      ...(outcome.userOpHash ? { userOpHash: outcome.userOpHash } : {}),
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
    });
  }
  return await store.finishSafeOp(op.id, {
    state: "EXECUTED",
    ...(outcome.userOpHash ? { userOpHash: outcome.userOpHash } : {}),
    ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
  });
}
