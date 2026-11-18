import type { Account, OrgEntity, Organisation } from "./types.js";

export const ORG_ENTITIES: readonly OrgEntity[] = ["company", "sole_trader"];

export const isOrgEntity = (v: unknown): v is OrgEntity => ORG_ENTITIES.includes(v as OrgEntity);

/**
 * What a business org is in law. A row with no `entity` reads as sole_trader:
 * Zold is redeployed from zero, so only rows made before the field existed
 * (and test fixtures) lack it, and sole_trader is the model they were built on
 * (a member's own Safe backs the account). Personal orgs have none.
 */
export function orgEntity(org: Pick<Organisation, "type" | "entity">): OrgEntity | undefined {
  if (org.type !== "business") return undefined;
  return org.entity ?? "sole_trader";
}

/**
 * The entity is locked once an EUR account has somewhere for money to land: a
 * Safe address (an org Safe exists before its IBAN), a backer's Safe bound to
 * it (POST .../fund or adoption) or an IBAN, or a stored org Safe plan (its
 * deployment may have landed before it was confirmed). Changing it after that
 * would change who owns money that is already there.
 */
export function entityLocked(
  org: Pick<Organisation, "safe">,
  accounts: readonly Pick<Account, "currency" | "address" | "backingUserId" | "identifier">[],
): boolean {
  return !!org.safe || accounts.some((a) => a.currency === "EUR" && (!!a.address || !!a.backingUserId || !!a.identifier?.iban));
}
