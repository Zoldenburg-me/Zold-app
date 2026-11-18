/**
 * The I/O half of domain/org-signers.ts: a company org's members as the join
 * needs them, and the Safe's owners and threshold read from chain on every
 * call. Nothing read here is stored.
 */
import { store } from "../store.js";
import { OrgSafePlanRefusal, orgSafePlan } from "../domain/org-safe-plan.js";
import { assertReadableSafeState } from "../domain/safe-op-queue.js";
import { orgSigners, type OrgSigners, type SignerMember } from "../domain/org-signers.js";
import type { Member, Organisation } from "../domain/types.js";
import { safeOwners, safeThreshold } from "./candide.js";
import { passkeyOwnerAddressOfJwk } from "./safe-signers.js";

type Address = `0x${string}`;

export interface OrgSafeReader {
  read(safeAddress: Address): Promise<{ owners: Address[]; threshold: number }>;
}

export const liveOrgSafeReader: OrgSafeReader = {
  async read(safeAddress) {
    const [owners, threshold] = await Promise.all([safeOwners(safeAddress), safeThreshold(safeAddress)]);
    return { owners, threshold };
  },
};

/** The address this member's login passkey signs as; null with no login, no
 *  passkey, or a key that is not P-256. Never Member.signerAddress: signing
 *  is by the passkey they log in with. */
export function ownerAddressOfMember(member: Pick<Member, "userId">): Address | null {
  const jwk = member.userId ? store.findUser(member.userId)?.passkey?.publicKey?.jwk : undefined;
  return jwk ? passkeyOwnerAddressOfJwk(jwk) : null;
}

/** The active owner member of this org whose login passkey signs as
 *  `address`, or undefined. Only this org's members are searched. */
export function memberForOwner(orgId: string, address: string): Member | undefined {
  return store.membersOf(orgId).find((m) => {
    if (m.status !== "active" || m.role !== "owner") return false;
    const a = ownerAddressOfMember(m);
    return !!a && a.toLowerCase() === address.toLowerCase();
  });
}

/** This org's members, for the join. */
export function signerMembersOf(orgId: string): SignerMember[] {
  return store.membersOf(orgId).map((m) => {
    const user = m.userId ? store.findUser(m.userId) : undefined;
    return {
      memberId: m.id,
      role: m.role,
      status: m.status,
      name: user?.name,
      hasUser: !!user,
      passkeyAddress: user ? ownerAddressOfMember(m) : null,
      ...(m.signerAddress ? { label: m.signerAddress } : {}),
    };
  });
}

export type OrgSafeView =
  | { state: "not_set_up" }
  | ({ state: "set_up"; safeAddress: Address; threshold: number } & OrgSigners);

/**
 * The company org's Safe as the chain has it. `not_set_up` until the org has
 * a plan and an EUR account at its address (the deployment). Throws
 * OrgSafePlanRefusal for an org that has no Safe of its own, and a plain
 * error when the chain cannot be read or reads as no Safe could be: a failed
 * read is never an empty owner set.
 */
export async function readOrgSafe(org: Organisation, reader: OrgSafeReader = liveOrgSafeReader): Promise<OrgSafeView> {
  let plan;
  try {
    plan = orgSafePlan(org);
  } catch (err) {
    if (err instanceof OrgSafePlanRefusal && err.code === "ORG_SAFE_MISSING") return { state: "not_set_up" };
    throw err;
  }
  const deployed = store.accountsOf(org.id).some((a) => a.currency === "EUR" && a.address?.toLowerCase() === plan.address.toLowerCase());
  if (!deployed) return { state: "not_set_up" };
  const chain = await reader.read(plan.address);
  assertReadableSafeState(plan.address, chain);
  return { state: "set_up", safeAddress: plan.address, threshold: chain.threshold, ...orgSigners(signerMembersOf(org.id), chain.owners) };
}
