/**
 * Ceremonies in flight: the UserOperations and challenges a browser has been
 * handed and not yet come back with.
 *
 * HELD IN MEMORY ON PURPOSE. A restart only means the user repeats the step —
 * the same recovery as an expired authorization — and nothing here is worth
 * the durability of a write. Keeping them in one module means the routes that
 * create an entry and the routes that consume it share the map explicitly
 * instead of through a 3,800-line file's scope.
 *
 * Every map is pruned by expiry rather than trusted to stay small; each holds
 * a challenge, which is a credential with a deadline.
 */
import type { preparePasskeySafeDeployment } from "../wallet/candide.js";
import type { User } from "../store.js";

export type PendingPasskeySafeDeployment =
  Awaited<ReturnType<typeof preparePasskeySafeDeployment>>["userOperation"];

/** Safe deployments awaiting the passkey signature that authorises them. */
export const pendingPasskeySafeDeployments = new Map<
  string,
  { userId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment }
>();

/** Monerium link declarations awaiting the Safe's EIP-1271 signature. */
export const pendingMoneriumLinkSignatures = new Map<
  string,
  { userId: string; expiresAt: number; challenge: string; profileId?: string }
>();

/**
 * Per-transfer Safe executions awaiting the send-time passkey ceremony: the
 * UserOperation that will move this transfer's exact debit out of the user's
 * Safe. Keyed by TRANSFER id; dies with its authorization window.
 */
export const pendingTransferExecutions = new Map<
  string,
  {
    userId: string;
    expiresAt: number;
    challenge: string;
    plan: NonNullable<User["passkeySafe"]>;
    userOperation: PendingPasskeySafeDeployment;
    /** Present when the operation is a full fee+approve+swap batch: where the
     *  swap output is delivered, so execution can measure and settle there. */
    batch?: { recipient: `0x${string}`; mode: "live" };
  }
>();

const pruneExpired = (m: Map<string, { expiresAt: number }>, now: number) => {
  for (const [id, pending] of m) if (pending.expiresAt < now) m.delete(id);
};

export const prunePendingTransferExecutions = (now = Date.now()) =>
  pruneExpired(pendingTransferExecutions, now);
export const prunePendingPasskeySafeDeployments = (now = Date.now()) =>
  pruneExpired(pendingPasskeySafeDeployments, now);
export const prunePendingMoneriumLinkSignatures = (now = Date.now()) =>
  pruneExpired(pendingMoneriumLinkSignatures, now);
