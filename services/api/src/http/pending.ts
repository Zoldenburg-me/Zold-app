/**
 * Ceremonies in flight: the UserOperations and challenges a browser has been
 * given and has not yet returned.
 *
 * Held in memory. After a restart the user repeats the step, as with an
 * expired authorization: these are setup steps and move no money. Keeping the
 * maps in one module lets the routes that create an entry and the routes that
 * consume it share them explicitly. A transfer's or crypto send's operation
 * waiting for its passkey is in the store instead (store.putPendingExecution).
 *
 * Every map is pruned by expiry: each holds a challenge, which is a credential
 * with a deadline.
 */
import type { preparePasskeySafeDeployment } from "../wallet/candide.js";
import type { OrgSafePlan } from "../domain/types.js";

export type PendingPasskeySafeDeployment =
  Awaited<ReturnType<typeof preparePasskeySafeDeployment>>["userOperation"];

/** Safe deployments awaiting the passkey signature that authorises them. */
export const pendingPasskeySafeDeployments = new Map<
  string,
  /** `challenge`: what the passkey signs (base64url), checked before the
   *  operation goes to the bundler. */
  { userId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment; challenge: string }
>();

/** A company org's Safe deployment awaiting its first owner's passkey: bound
 *  to the org and the member who prepared it, and to the plan it deploys. */
export const pendingOrgSafeDeployments = new Map<
  string,
  { orgId: string; memberId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment; challenge: string; plan: OrgSafePlan }
>();

/**
 * Monerium link declarations awaiting the Safe's EIP-1271 signature. A
 * `move-iban` entry is bound to the one IBAN the user confirmed: the challenge
 * is the Safe message hash, which cannot carry the IBAN itself.
 */
export const pendingMoneriumLinkSignatures = new Map<
  string,
  {
    userId: string;
    expiresAt: number;
    challenge: string;
    profileId?: string;
    purpose?: "activate" | "move-iban";
    iban?: string;
  }
>();

const pruneExpired = (m: Map<string, { expiresAt: number }>, now: number) => {
  for (const [id, pending] of m) if (pending.expiresAt < now) m.delete(id);
};

export const prunePendingPasskeySafeDeployments = (now = Date.now()) =>
  pruneExpired(pendingPasskeySafeDeployments, now);
export const prunePendingOrgSafeDeployments = (now = Date.now()) =>
  pruneExpired(pendingOrgSafeDeployments, now);
export const prunePendingMoneriumLinkSignatures = (now = Date.now()) =>
  pruneExpired(pendingMoneriumLinkSignatures, now);
