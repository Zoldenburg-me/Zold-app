/**
 * What a role may do.
 *
 * Separate from plans.ts on purpose: a plan says what the ORGANISATION bought,
 * a role says what this PERSON may do with it. Both must pass. Conflating them
 * is how a viewer on a Business plan ends up able to send money because the
 * feature "is included".
 */

import type { Role } from "./types.js";

export type Permission =
  | "org.read"
  | "org.update"
  | "org.billing"
  | "org.delete"
  | "members.read"
  | "members.invite"
  | "members.update"
  | "accounts.read"
  | "accounts.open"
  | "wallets.read"
  | "wallets.manage"
  | "contacts.read"
  | "contacts.manage"
  | "drafts.read"
  | "drafts.create"
  | "drafts.review"
  | "transfers.read"
  | "transfers.execute"
  | "invoices.read"
  | "invoices.manage"
  | "ledger.read"
  | "ledger.categorise"
  | "coa.read"
  | "coa.manage"
  | "reports.run";

const VIEWER: Permission[] = [
  "org.read",
  "members.read",
  "accounts.read",
  "wallets.read",
  "contacts.read",
  "drafts.read",
  "transfers.read",
  "invoices.read",
  "ledger.read",
  "coa.read",
];

/** Books, not money. The whole point of the role. */
const ACCOUNTANT: Permission[] = [
  ...VIEWER,
  "contacts.manage",
  "drafts.create",
  "ledger.categorise",
  "coa.manage",
  "reports.run",
];

/** Money, not books, and explicitly not approval of their own work. */
const PAYER: Permission[] = [
  ...VIEWER,
  "contacts.manage",
  "drafts.create",
  "transfers.execute",
  "invoices.manage",
];

const ADMIN: Permission[] = [
  ...new Set([
    ...ACCOUNTANT,
    ...PAYER,
    "org.update",
    "members.invite",
    "members.update",
    "accounts.open",
    "wallets.manage",
    "drafts.review",
  ] as Permission[]),
];

const OWNER: Permission[] = [
  ...new Set([...ADMIN, "org.billing", "org.delete"] as Permission[]),
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: VIEWER,
  accountant: ACCOUNTANT,
  payer: PAYER,
  admin: ADMIN,
  owner: OWNER,
};

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Four-eyes: the person who submitted a draft may not be the one who reviews
 * it, whatever their role. An admin who drafts a payment still needs a second
 * admin — otherwise "review" is a button the same person presses twice and the
 * control is theatre.
 */
export function canReviewDraft(
  role: Role,
  reviewerMemberId: string,
  draftCreatedByMemberId: string,
): { allowed: boolean; reason?: string } {
  if (!roleCan(role, "drafts.review")) {
    return { allowed: false, reason: `A ${role} cannot approve payments.` };
  }
  if (reviewerMemberId === draftCreatedByMemberId) {
    return {
      allowed: false,
      reason:
        "A payment must be reviewed by someone other than the person who drafted it.",
    };
  }
  return { allowed: true };
}

/**
 * An org must never lose its last owner — not by role change and not by
 * deactivation, which is the same hole reached two ways.
 */
export function wouldOrphanOrg(
  members: { id: string; role: Role; status: string }[],
  changingMemberId: string,
  next: { role?: Role; status?: string },
): boolean {
  const remaining = members.filter((m) => {
    const role = m.id === changingMemberId ? (next.role ?? m.role) : m.role;
    const status = m.id === changingMemberId ? (next.status ?? m.status) : m.status;
    return role === "owner" && status === "active";
  });
  return remaining.length === 0;
}
