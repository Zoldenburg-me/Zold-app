/**
 * Which Safe a company org's money sits on (design note §2.2). The answer is
 * the org's own plan or a refusal by name: never the caller's passkey Safe,
 * which is why nothing here takes a user. Personal and sole_trader orgs are
 * backed by a member's own Safe (User.passkeySafe) and never come here.
 */
import { orgEntity } from "./org-entity.js";
import type { OrgSafePlan, Organisation } from "./types.js";

export class OrgSafePlanRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OrgSafePlanRefusal";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COORD = /^0x[0-9a-fA-F]{64}$/;

/** The shape a stored org plan must have; anything else is refused, not repaired. */
export function isOrgSafePlan(v: unknown): v is OrgSafePlan {
  const p = v as Partial<OrgSafePlan> | null;
  if (!p || typeof p !== "object" || p.kind !== "org") return false;
  if (typeof p.address !== "string" || !ADDRESS.test(p.address)) return false;
  if (typeof p.createdAt !== "string" || !Number.isFinite(Date.parse(p.createdAt))) return false;
  if (!Array.isArray(p.owners) || !p.owners.length) return false;
  const seen = new Set<string>();
  for (const o of p.owners) {
    if (!o || typeof o.x !== "string" || typeof o.y !== "string" || !COORD.test(o.x) || !COORD.test(o.y)) return false;
    const key = `${o.x.toLowerCase()}:${o.y.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** The org Safe of a company org, or a refusal that names what is missing. */
export function orgSafePlan(org: Pick<Organisation, "type" | "entity" | "safe">): OrgSafePlan {
  if (orgEntity(org) !== "company") {
    throw new OrgSafePlanRefusal(409, "NOT_A_COMPANY", "Only a company has its own Safe; this organisation's account is backed by a member's own Safe.");
  }
  if (!org.safe) {
    throw new OrgSafePlanRefusal(409, "ORG_SAFE_MISSING", "This company has no Safe of its own yet, so nothing can be paid from it.");
  }
  if (!isOrgSafePlan(org.safe)) {
    throw new OrgSafePlanRefusal(409, "ORG_SAFE_UNREADABLE", "This company's Safe record is unreadable, so nothing can be paid from it.");
  }
  return org.safe;
}
