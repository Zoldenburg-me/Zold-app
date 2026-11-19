/**
 * Business organisations for the suites, built one way: the store rows an
 * in-process suite adds (store.addOrganisation(companyOrg(...))) and the
 * request bodies a suite against a running API posts. Each helper returns a
 * plain object; nothing here writes to a store or calls an API.
 *
 * Type imports only, so a DOM-free suite (business-home) loads it without
 * the store. Not a suite itself (leading underscore).
 */
import type { Account, Member, Organisation, OrgEntity, Role } from "../services/api/src/domain/types.js";

/** One timestamp for every row a suite builds. */
export const NOW = new Date().toISOString();
export const REPORTING = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;

// ── Store rows ──────────────────────────────────────────────────────────────

/** A business org, on the business plan unless `plan` says otherwise. No
 *  `entity` is the row a business org had before entities existed, which
 *  orgEntity reads as sole_trader. */
export function businessOrg(id: string, name: string, opts: { entity?: OrgEntity; legalName?: string; plan?: Organisation["plan"] } = {}): Organisation {
  return {
    id, type: "business", name,
    ...(opts.entity ? { entity: opts.entity } : {}),
    ...(opts.legalName ? { legalName: opts.legalName } : {}),
    plan: opts.plan ?? "business", reporting: { ...REPORTING }, verifications: {}, createdAt: NOW, updatedAt: NOW,
  } as Organisation;
}

/** A company: its account is its own Safe, never a member's. */
export const companyOrg = (id: string, name: string, legalName?: string) => businessOrg(id, name, { entity: "company", legalName });

export function personalOrg(id: string, name: string): Organisation {
  return { id, type: "personal", name, plan: "business", reporting: { ...REPORTING }, verifications: {}, createdAt: NOW, updatedAt: NOW } as Organisation;
}

/** An active member who accepted their invite. */
export function member(id: string, orgId: string, userId: string, role: Role): Member {
  return { id, orgId, userId, email: "", role, status: "active", invitedAt: NOW, acceptedAt: NOW };
}

/** A euro account nothing can be sent from yet. With `address`, a company's
 *  deployed Safe waiting for its IBAN; without, no Safe yet. */
export function gatedEurAccount(id: string, orgId: string, extra: Partial<Account> = {}): Account {
  return { id, orgId, currency: "EUR", label: "main", status: "gated", provider: "monerium", identifier: {}, createdAt: NOW, updatedAt: NOW, ...extra } as Account;
}

/** An active euro account at `address`: with `iban`, its IBAN; with
 *  `backingUserId`, spending from that member's Safe. With no
 *  `backingUserId`, a company's: the Safe at `address` is its own. */
export function activeEurAccount(
  id: string, orgId: string,
  opts: { iban?: string; address: `0x${string}`; backingUserId?: string },
  extra: Partial<Account> = {},
): Account {
  return {
    id, orgId, currency: "EUR", label: "main", status: "active", provider: "monerium",
    identifier: opts.iban ? { iban: opts.iban } : {}, address: opts.address,
    ...(opts.backingUserId ? { backingUserId: opts.backingUserId } : {}),
    createdAt: NOW, updatedAt: NOW, ...extra,
  } as Account;
}

// ── Request bodies, for a suite against a running API ──────────────────────

/** POST /api/orgs for a sole trader in Germany. */
export const soleTraderBody = (name: string) => ({ name, entity: "sole_trader", type: "business", country: "DE" });

/** POST /api/orgs/:orgId/contacts: one euro bank account under the contact's name. */
export const bankContactBody = (name: string, country: string, iban: string) => ({
  name, bankAccounts: [{ currency: "EUR", country, holderName: name, iban }],
});

/** A draft line paying a contact's first bank account. */
export const bankLine = (contact: { id: string; bankAccounts: { id: string; holderName: string }[] }, amount: string) => ({
  contactId: contact.id,
  destination: { kind: "bank", bankAccountId: contact.bankAccounts[0].id, displayName: contact.bankAccounts[0].holderName },
  asset: "EUR",
  amount,
});
