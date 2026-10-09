/**
 * The name Monerium verified for an account, as opposed to the one the person
 * typed at signup.
 *
 * Zold checks no identity itself, so the signup name is self-declared even
 * once the account is approved. Monerium's name is the holder name it reports
 * for the account's IBAN, else the name on the connected profile once Monerium
 * has approved that profile. Anything that tells a third party who holds the
 * account (a Zold-signed document, the app's "verified" label) uses this, or
 * says plainly that the name is self-declared.
 */
import type { User } from "../store.js";
import { normalizeIban } from "../sepa.js";
import { moneriumIbanList } from "../domain/monerium-profile.js";

/** The holder name Monerium reported for this IBAN in the stored snapshot. */
function ibanHolderName(user: Pick<User, "monerium">, iban: string): string | undefined {
  const entry = moneriumIbanList(user.monerium?.ibans).find((i) => normalizeIban(i.iban) === normalizeIban(iban));
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  return name || undefined;
}

/** The name on the connected profile, only once Monerium approved it. */
function approvedProfileName(user: Pick<User, "monerium">): string | undefined {
  const id = user.monerium?.profileId;
  if (!id || !Array.isArray(user.monerium?.profiles)) return undefined;
  const p = user.monerium.profiles.find((x: any) => x?.id === id);
  const name = p?.state === "approved" && typeof p?.name === "string" ? p.name.trim() : "";
  return name || undefined;
}

export function moneriumVerifiedName(user: Pick<User, "monerium" | "iban">): string | undefined {
  return (user.iban ? ibanHolderName(user, user.iban) : undefined) ?? approvedProfileName(user);
}

/** "CHRISTIAN  LINDNER" and "Lindner, Christian" are the same person. Only
 *  case, accents, spacing, punctuation and word order are ignored: a word in
 *  any other script, or a symbol, Monerium did not report makes it another name. */
export const personKey = (name: string) =>
  name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean).sort().join(" ");
