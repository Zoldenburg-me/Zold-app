/**
 * The rules of the org Safe signature queue (design note §2.4), with no I/O.
 *
 * An org Safe op is prepared once, with its digest fixed, and each owner
 * signs that digest with their own passkey. The chain is the truth:
 * - the threshold is read from the Safe every time and never stored, so a
 *   1-of-1 Safe relays on one signature and a 2-of-4 Safe on two;
 * - a signature counts only while its signer is an owner on chain. When the
 *   owner set changes, a removed owner's signature is dropped (owner, Q6) and
 *   the current owners sign instead;
 * - an op whose nonce the Safe has moved past can never execute, so it is
 *   invalidated, and an op past its expiry is expired.
 *
 * Only a member with the owner role signs. Payers, accountants and admins
 * draft and queue; they never sign (owner, Q1).
 */
import { roleCan } from "./roles.js";
import type { Member } from "./types.js";
import type { PendingSafeOp, SafeOpSignature } from "../store/types.js";

/** How long a queued op waits for its signatures. */
export const SAFE_OP_TTL_MS = 72 * 60 * 60_000;

/** What the chain says right now about the Safe an op belongs to. */
export interface SafeChainView {
  owners: `0x${string}`[];
  threshold: number;
  /** The EntryPoint's next nonce under the op's nonce key. */
  nonce: bigint;
}

export interface ChainCheck {
  /** Set when the op can never execute: it moves to this state. */
  end?: { state: "EXPIRED" | "INVALIDATED"; reason: string };
  /** The op's nonce is ahead of the Safe's: it waits for an earlier op. */
  waitingForEarlierOp: boolean;
  keep: SafeOpSignature[];
  dropped: SafeOpSignature[];
  threshold: number;
  thresholdMet: boolean;
}

/**
 * Check a PENDING op against the chain. Fails closed on a view the Safe could
 * not have (no owners, a threshold below 1 or above the owner count).
 */
export function checkAgainstChain(op: PendingSafeOp, chain: SafeChainView, now = Date.now()): ChainCheck {
  if (!chain.owners.length || !Number.isInteger(chain.threshold) || chain.threshold < 1 || chain.threshold > chain.owners.length) {
    throw new Error(`unreadable Safe state for ${op.safeAddress}: ${chain.owners.length} owners, threshold ${chain.threshold}`);
  }
  const owners = new Set(chain.owners.map((o) => o.toLowerCase()));
  const keep = op.signatures.filter((s) => owners.has(s.ownerAddress.toLowerCase()));
  const dropped = op.signatures.filter((s) => !owners.has(s.ownerAddress.toLowerCase()));
  const opNonce = BigInt(op.nonce);
  const end =
    Date.parse(op.expiresAt) <= now
      ? { state: "EXPIRED" as const, reason: "the op expired before enough owners signed" }
      : chain.nonce > opNonce
        ? { state: "INVALIDATED" as const, reason: "the Safe executed another operation with this nonce; queue it again" }
        : undefined;
  return {
    end,
    waitingForEarlierOp: chain.nonce < opNonce,
    keep,
    dropped,
    threshold: chain.threshold,
    thresholdMet: !end && chain.nonce === opNonce && keep.length >= chain.threshold,
  };
}

/** Who may put an op in the queue: anyone who may draft a payment. */
export function canQueueSafeOp(role: Member["role"]): boolean {
  return roleCan(role, "drafts.create");
}

/**
 * Why this member may not sign, or undefined. `ownerAddress` is the address
 * their login passkey signs as (null when it is not a P-256 key).
 */
export function signerRefusal(
  member: Pick<Member, "role" | "status">,
  ownerAddress: `0x${string}` | null,
  chainOwners: `0x${string}`[],
): { status: number; code: string; error: string } | undefined {
  if (member.status !== "active" || member.role !== "owner") {
    return { status: 403, code: "NOT_A_SIGNER", error: `Only an owner signs this account's operations; your role (${member.role}) drafts and queues them.` };
  }
  if (!ownerAddress) {
    return { status: 409, code: "NO_SIGNING_PASSKEY", error: "Your passkey cannot sign for a Safe." };
  }
  if (!chainOwners.some((o) => o.toLowerCase() === ownerAddress.toLowerCase())) {
    return { status: 403, code: "NOT_ON_CHAIN_OWNER", error: "Your passkey is not an owner of this account's Safe, so your signature would count for nothing." };
  }
  return undefined;
}

/** The creator may withdraw their op, and so may any owner. */
export function canCancelSafeOp(member: Pick<Member, "id" | "role">, op: Pick<PendingSafeOp, "createdByMemberId">): boolean {
  return member.role === "owner" || member.id === op.createdByMemberId;
}

// ---- the stored UserOperation ---------------------------------------------

const BIGINT_TAG = "$bigint";

/** JSON has no bigint; a UserOperation is mostly bigints. */
export function encodeUserOperation(op: unknown): string {
  return JSON.stringify(op, (_k, v) => (typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v));
}

export function decodeUserOperation<T>(json: string): T {
  return JSON.parse(json, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v[BIGINT_TAG] === "string"
      ? BigInt(v[BIGINT_TAG])
      : v,
  ) as T;
}
