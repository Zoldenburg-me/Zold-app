/**
 * The person's name, as Zold shows it.
 *
 * Editable until Monerium has verified the person; from then on it is the
 * name their IBAN is held under, so it is locked. A company login has no
 * personal name to change: its account is named after the company
 * (app/core.js ownAccountName).
 */
import type { User } from "../store.js";

export interface NameRefusal {
  status: number;
  code: "NAME_VERIFIED" | "NAME_COMPANY" | "NAME_INVALID";
  error: string;
}

const MIN = 2;
const MAX = 80;
// Control characters, the markup brackets, the zero-width space and the
// direction marks and overrides: a name is printed on documents and receipts,
// and must read there as it was typed. The zero-width joiners (U+200C/D) stay:
// Persian and Indic names need them.
const FORBIDDEN = /[\u0000-\u001f\u007f<>\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

export function nameChange(
  user: Pick<User, "accountType" | "kycStatus">,
  raw: unknown,
): { name: string } | NameRefusal {
  if (user.accountType === "company") {
    return { status: 409, code: "NAME_COMPANY", error: "A company account is named after the company. Change the company's name in Zold Business, under Settings." };
  }
  if (user.kycStatus === "approved") {
    return { status: 409, code: "NAME_VERIFIED", error: "Your name is verified by Monerium and is the name your IBAN is held under, so it can't be changed here." };
  }
  if (typeof raw !== "string" || FORBIDDEN.test(raw)) {
    return { status: 400, code: "NAME_INVALID", error: "Enter your name using letters, spaces, apostrophes or hyphens." };
  }
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < MIN || name.length > MAX) {
    return { status: 400, code: "NAME_INVALID", error: `Your name needs ${MIN} to ${MAX} characters.` };
  }
  return { name };
}
