/**
 * Whose money a deposit to an address is: the one question a Monerium issue
 * order (a SEPA credit minted as EURe) must answer before it is booked.
 *
 * - A person's Safe: the user at the address, when every account at that
 *   address is backed by that user (their personal account, a sole trader's
 *   account on the same Safe). Booked under the user, as it always was; the
 *   writer picks the org (booksFor).
 * - A company's own Safe: no user at the address and exactly one account
 *   there, a company org's EUR account with no backing user. Booked under
 *   that account.
 * - Anything else names no one or more than one holder and is not booked:
 *   a user's Safe that is also another org's account, two accounts at one
 *   address, an account whose org is gone or is not a company. Never a guess.
 */
import { store, type User } from "../store.js";
import type { Account, Organisation } from "../domain/types.js";
import { orgEntity } from "../domain/org-entity.js";

export type MoneyInHolder =
  | { kind: "user"; user: User }
  | { kind: "account"; account: Account; org: Organisation };

export type MoneyInResolution = MoneyInHolder | { kind: "none" } | { kind: "unbookable"; reason: string };

/** A holder as a log names it: ids only, never a person's or a company's name. */
export function bookHolderLabel(holder: MoneyInHolder): string {
  return holder.kind === "user" ? `user:${holder.user.id}` : `account:${holder.account.id}`;
}

export async function moneyInHolder(address: string): Promise<MoneyInResolution> {
  if (!address) return { kind: "none" };
  const user = await store.findUserByAddress(address);
  const accounts = await store.accountsAtAddress(address);
  if (user) {
    const others = accounts.filter((a) => a.backingUserId !== user.id);
    if (others.length) {
      return { kind: "unbookable", reason: `${address} is ${user.id}'s Safe and also account ${others.map((a) => a.id).join(", ")}, not backed by them` };
    }
    return { kind: "user", user };
  }
  if (!accounts.length) return { kind: "none" };
  if (accounts.length > 1) {
    return { kind: "unbookable", reason: `${address} is ${accounts.length} accounts (${accounts.map((a) => a.id).join(", ")})` };
  }
  const [account] = accounts;
  const org = await store.findOrganisation(account.orgId);
  if (!org || orgEntity(org) !== "company" || account.currency !== "EUR" || account.backingUserId) {
    return { kind: "unbookable", reason: `${address} is account ${account.id}, which is not a company Safe's EUR account` };
  }
  return { kind: "account", account, org };
}
