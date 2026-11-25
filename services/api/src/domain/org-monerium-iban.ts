/**
 * How far a company's IBAN on its own Safe has got (design note §3.3), from
 * the stored rows alone. The steps: the company's Monerium keys are connected
 * with an approved profile, the company Safe is set up, an owner signs the
 * ownership declaration and Monerium links the Safe under that profile, Zold
 * requests the IBAN, and Monerium attributes one to the Safe. Only that last
 * step opens the account (`active`); nothing before it is shown as an IBAN.
 * A move Monerium reported is kept on the EUR account, not the key record, so
 * removing and reconnecting keys cannot offer a fresh issue for an IBAN that
 * still pays elsewhere.
 */
import type { Account, Organisation } from "./types.js";
import { orgEntity } from "./org-entity.js";
import { isOrgSafePlan } from "./org-safe-plan.js";

export type CompanyIbanState =
  | "not_a_company"
  | "keys_needed"
  | "safe_needed"
  | "ready"
  | "link_pending"
  | "iban_requested"
  | "issued"
  /** Issued once, then Monerium listed it on another address or chain. */
  | "moved";

/** The company's one EUR account, if it has one. */
export const companyEurAccount = (accounts: Account[]): Account | undefined => accounts.find((a) => a.currency === "EUR");

/** Whether Monerium has attributed an IBAN to the company Safe (the account
 *  holds it and is open). */
export function companyIbanIssued(account: Account | undefined): boolean {
  return !!account && account.status === "active" && !!account.identifier?.iban && !!account.address;
}

export function companyIbanState(org: Pick<Organisation, "type" | "entity" | "safe" | "monerium">, account: Account | undefined): CompanyIbanState {
  if (orgEntity(org) !== "company") return "not_a_company";
  if (companyIbanIssued(account)) return "issued";
  const m = org.monerium;
  const approved = !!m && !m.rejectedAt && !m.profileMissingAt && m.profile.state === "approved";
  if (!approved) return "keys_needed";
  const plan = org.safe;
  if (!plan || !isOrgSafePlan(plan) || plan.status !== "active" || !account?.address || account.address.toLowerCase() !== plan.address.toLowerCase()) {
    return "safe_needed";
  }
  // Kept on the account, so removing and reconnecting the keys cannot turn a
  // moved IBAN back into a first-time issue. Only for this Safe and profile:
  // different keys open a different company.
  const moved = account.moneriumIban;
  if (moved?.movedAwayAt && moved.profileId === m.profile.id && moved.safeAddress.toLowerCase() === plan.address.toLowerCase()) return "moved";
  const link = m.safe && m.safe.address.toLowerCase() === plan.address.toLowerCase() ? m.safe : undefined;
  if (!link) return "ready";
  if (link.movedAwayAt) return "moved";
  return link.linkedAt ? "iban_requested" : "link_pending";
}
