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
// Every format and control character, the line and paragraph separators, and
// the markup brackets: a name is printed on payment pages, receipts, invoices
// and documents, and must read there as it was typed. Matched by category, not
// a hand-picked list, so a bidi mark or tag character cannot slip through. The
// zero-width joiners (U+200C/D) are format characters that Persian and Indic
// names need, so they alone are let through.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const JOINERS = /[\u200c\u200d]/g;

/**
 * A name as Zold stores it, or null when it is not one: NFC, trimmed, inner
 * runs of spaces collapsed, `min` to `max` characters (code points, not UTF-16
 * units). The raw text is checked before spaces collapse, so a separator never
 * turns into an ordinary space on the way in.
 */
export function cleanName(raw: unknown, { min = MIN, max = MAX }: { min?: number; max?: number } = {}): string | null {
  if (typeof raw !== "string") return null;
  const nfc = raw.normalize("NFC");
  if (FORBIDDEN.test(nfc.replace(JOINERS, ""))) return null;
  const name = nfc.trim().replace(/\s+/g, " ");
  const length = [...name].length;
  return length < min || length > max ? null : name;
}

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
  const name = cleanName(raw);
  if (name === null) {
    return { status: 400, code: "NAME_INVALID", error: `Enter your name in ${MIN} to ${MAX} characters, using letters, spaces, apostrophes or hyphens.` };
  }
  return { name };
}
