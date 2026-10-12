/**
 * The person's name, as Zold shows it.
 *
 * Editable until Monerium has approved the account; from then on it is
 * locked. Locked is not verified: whether Monerium reported this same name is
 * users/verified-name.ts, and only then does the app say so. A company login has no
 * personal name to change: its account is named after the company
 * (app/core.js ownAccountName).
 */
import type { User } from "../store.js";

export interface NameRefusal {
  status: number;
  code: "NAME_VERIFIED" | "NAME_COMPANY" | "NAME_INVALID" | "NAME_RESERVED";
  error: string;
}

const MIN = 2;
const MAX = 80;
// Every format and control character, the line and paragraph separators, and
// the markup brackets: a name is printed on payment pages, receipts, invoices
// and documents, and must read there as it was typed. Matched by category, not
// a hand-picked list, so a bidi mark or tag character cannot slip through. The
// zero-width joiners (U+200C/D) are format characters that Persian and Indic
// names need, so they alone are let through, and only between two visible
// characters: on their own, at an end or beside a space they draw nothing.
// A lone surrogate (Cs) is not text and does not survive printing.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u;
// Emoji and pictographs: a name is printed on payment pages, receipts and
// invoices, and Monerium's name check compares against an ID document. Covers
// pictographs and other symbols, skin-tone modifiers, flag letters, enclosing
// marks (keycaps) and the emoji variation selectors.
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{So}\p{Emoji_Modifier}\p{Regional_Indicator}\p{Me}\ufe0e\ufe0f]/u;
const JOINERS = /[\u200c\u200d]/g;
const LOOSE_JOINER = /(?:^|[\s\u200c\u200d])[\u200c\u200d]|[\u200c\u200d](?=$|[\s\u200c\u200d])/u;

/** NFC, trimmed, inner runs of spaces collapsed: the form names compare in. */
const settle = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ");

/**
 * A name as Zold stores it, or null when it is not one: NFC, trimmed, inner
 * runs of spaces collapsed, `min` to `max` characters (code points, not UTF-16
 * units). The raw text is checked before spaces collapse, so a separator never
 * turns into an ordinary space on the way in.
 */
export function cleanName(raw: unknown, { min = MIN, max = MAX }: { min?: number; max?: number } = {}): string | null {
  if (typeof raw !== "string") return null;
  const nfc = raw.normalize("NFC");
  if (FORBIDDEN.test(nfc.replace(JOINERS, "")) || PICTOGRAPHIC.test(nfc)) return null;
  const name = settle(nfc);
  if (LOOSE_JOINER.test(name)) return null;
  const length = [...name].length;
  return length < min || length > max ? null : name;
}

// A person's name is letters (with their accents and combining marks), single
// spaces, apostrophes, hyphens and the period of an initial — what a legal name
// on an ID holds. No digits or `&`: those belong to company and contact names,
// which keep cleanName alone. The joiners pass here; cleanName has already
// placed them.
const PERSON_CHARS = /^[\p{L}\p{Mn}\p{Mc} '\u2019\-\u2010\u2011.\u200c\u200d]+$/u;

/**
 * Words that make a person's name read as Zold staff or our partner. A name is
 * shown to whoever pays or is paid, so "Zold Support" collects on borrowed
 * trust. Shorter than the handle list (pay.ts): a name here is a legal name
 * checked against an ID, and a real Elon or Mr Bridge must be able to sign up.
 */
const IMPERSONATED_WORDS = new Set(["zold", "zoldenburg", "zoll", "monerium", "support", "admin", "administrator", "staff"]);

/** The staff or partner word a person's name would impersonate, or undefined. */
export function impersonatedPersonWord(name: string): string | undefined {
  const words = name.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  // Whole words only: "zold" inside a word would refuse a real Zoldan.
  return words.find((w) => IMPERSONATED_WORDS.has(w));
}

/**
 * A person's name as Zold stores it, or a refusal: cleanName, then letters,
 * spaces, apostrophes, hyphens and periods only, at least one letter, and no
 * staff or partner word. Signup, rename and a member invite use it.
 */
export function cleanPersonName(
  raw: unknown,
  bounds: { min?: number; max?: number } = {},
): { name: string } | { code: "NAME_INVALID" | "NAME_RESERVED"; error: string } {
  const { min = MIN, max = MAX } = bounds;
  const name = cleanName(raw, { min, max });
  if (name === null || !PERSON_CHARS.test(name) || !/\p{L}/u.test(name)) {
    return { code: "NAME_INVALID", error: `Enter the name in ${min} to ${max} characters, using letters, spaces, apostrophes, hyphens or periods.` };
  }
  const word = impersonatedPersonWord(name);
  if (word) return { code: "NAME_RESERVED", error: `A name can't contain "${word}": it would read as Zold staff or a partner.` };
  return { name };
}

/** Whether a submitted name is the stored one, as typed or as Zold would
 *  store it. A form sends every field on save; an unchanged name that an
 *  older rule let in is left alone, not refused. */
export const sameName = (submitted: unknown, stored: string | undefined): boolean =>
  typeof submitted === "string" && stored !== undefined && (submitted === stored || settle(submitted) === settle(stored));

export function nameChange(
  user: Pick<User, "accountType" | "kycStatus">,
  raw: unknown,
): { name: string } | NameRefusal {
  if (user.accountType === "company") {
    return { status: 409, code: "NAME_COMPANY", error: "A company account is named after the company. Change the company's name in Zold Business, under Settings." };
  }
  if (user.kycStatus === "approved") {
    return { status: 409, code: "NAME_VERIFIED", error: "Your name is locked once Monerium has approved your account, so it can't be changed here." };
  }
  const r = cleanPersonName(raw);
  return "code" in r ? { status: 400, ...r } : r;
}
