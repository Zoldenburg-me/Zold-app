/**
 * Does a name we were given (a SEPA payer, later a Didit document) belong to
 * the person Monerium verified? docs/recovery-guardians-plan.md, *Name match*.
 *
 * Monerium gives one `name` string. Both sides are normalised (Unicode NFKD,
 * diacritics stripped, ß→ss, lower case, hyphens, apostrophes and other
 * punctuation to spaces) and split into tokens. A German umlaut matches both
 * of its spellings, so "Müller" matches "MUELLER" and "MULLER".
 *
 * - Split name (first + last): every last-name token and the first first-name
 *   token must appear among the Monerium tokens.
 * - One string (a bank's payer name, in any order): the first and the last
 *   Monerium token must both appear in it, and it may not name a second
 *   person ("und", "and", "&") or a company ("GmbH", "Ltd").
 * - A Monerium name of one word matches nothing: one shared word is not
 *   enough to tell two people apart.
 *
 * Anything else is a mismatch, and so is an empty side. It errs toward
 * mismatch: a married name the bank does not know yet, or a nickname, fails.
 */

const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };
const UMLAUT: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue" };

function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** A word's spellings: umlauts as ae/oe/ue, and as plain vowels. */
function spellings(word: string): string[] {
  const lower = word.normalize("NFC").toLowerCase();
  const expanded = clean(lower.replace(/[äöü]/g, (c) => UMLAUT[c]));
  const stripped = clean(lower);
  return [...new Set([expanded, stripped])].filter(Boolean);
}

/** The words of a name, each with the spellings it may take. */
export function nameTokens(name: string): string[][] {
  return name
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .map(spellings)
    .filter((v) => v.length > 0);
}

/** Words that make a payer string a joint account or a company. Ampersands
 *  and "+" are separators to nameTokens, so they are found in the raw string. */
const NOT_ONE_PERSON = new Set([
  "und", "and", "et", "y", "e", "en", "u", "or", "oder",
  "gmbh", "ug", "ag", "kg", "ohg", "gbr", "ev", "eg", "mbh", "co", "ltd", "llc", "inc", "plc", "sarl", "sas", "sa", "bv", "nv", "srl", "spa", "ab", "as", "oy",
]);
const namesOnePerson = (raw: string, tokens: string[][]) =>
  !/[&+]/.test(raw) && !tokens.some((t) => t.some((s) => NOT_ONE_PERSON.has(s)));

const has = (tokens: string[][], wanted: string[]) =>
  tokens.some((t) => t.some((s) => wanted.includes(s)));

export type PersonName = string | { firstName?: string; lastName?: string };

/** True only when `other` names the person on the Monerium profile. */
export function namesMatch(moneriumName: string | undefined, other: PersonName | undefined): boolean {
  if (!moneriumName || !other) return false;
  const verified = nameTokens(moneriumName);
  if (verified.length < 2) return false;
  if (typeof other === "string") {
    const given = nameTokens(other);
    if (!given.length || !namesOnePerson(other, given)) return false;
    return has(given, verified[0]) && has(given, verified[verified.length - 1]);
  }
  const first = nameTokens(other.firstName ?? "");
  const last = nameTokens(other.lastName ?? "");
  if (!first.length || !last.length) return false;
  return has(verified, first[0]) && last.every((t) => has(verified, t));
}
