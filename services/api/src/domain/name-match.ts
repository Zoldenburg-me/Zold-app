/**
 * Does a name we were given (a SEPA payer, later a Didit document) belong to
 * the person Monerium verified? docs/recovery-guardians-plan.md, *Name match*.
 *
 * Both sides are normalised (Unicode NFKD, diacritics stripped, ß→ss, lower
 * case) and split into words; a hyphenated or apostrophised word keeps its
 * parts together ("Meyer-Schmidt" is one word of two parts). A German umlaut
 * matches both of its spellings, so "Müller" matches "MUELLER" and "MULLER".
 * Titles and suffixes (Dr, Prof, Jr, III) and single letters (initials) are
 * not name parts and are dropped first.
 *
 * - Monerium's name needs at least two words left: one shared word is not
 *   enough to tell two people apart.
 * - One string (a bank's payer name, in any order): every part of Monerium's
 *   first word and of its last word must appear in it, and it may not name a
 *   second person ("und", "and", "&", "+"; "or", "y", "e" only between two
 *   full names) or a company ("GmbH", "e.K.").
 * - Split name (first + last): every part of the first given name and of the
 *   whole last name must appear among Monerium's parts, under the same
 *   second-person and company rule.
 *
 * Anything else is a mismatch. It errs toward mismatch: a married name the
 * bank does not know yet, a dropped second given name, or a nickname fails.
 * A stranger with exactly the same name still matches; the one-time code in
 * the payment is what stops that.
 */

const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };
const UMLAUT: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue" };

/** Words that are never a name part. */
const TITLES = new Set([
  "dr", "prof", "professor", "mr", "mrs", "ms", "mx", "herr", "frau", "dipl", "ing", "mag", "phd", "md",
  "jr", "junior", "sr", "senior", "ii", "iii", "iv",
]);

/** Words that make a payer a joint account or a company. Only words that are
 *  not also someone's name or initial: "e", "y", "or", "sa" are left out. */
const NOT_ONE_PERSON = new Set([
  "und", "and", "oder",
  "gmbh", "mbh", "ug", "ag", "kg", "ohg", "gbr", "kgaa", "ltd", "llc", "inc", "plc", "llp", "corp",
  "sarl", "sas", "bv", "nv", "srl", "spa", "oy", "aps", "stiftung", "verein", "holding", "consulting",
]);
/** Joiners and dotted company forms that vanish once punctuation is split. */
const NOT_ONE_PERSON_RAW = /[&+]|\be\.\s?[kvg]\b/i;
/** Short joiners that are also names or initials ("Or Cohen", "Maria E.
 *  Garcia"). They count only between two full names of two words or more. */
const SOFT_JOINERS = new Set(["or", "et", "y", "e", "u", "en", "og", "och"]);

function joinsTwoNames(raw: string): boolean {
  const words = raw.toLowerCase().split(/[\s,;]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return words.some((w, i) => SOFT_JOINERS.has(w) && i >= 2 && words.length - i - 1 >= 2);
}

function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** A part's spellings: umlauts as ae/oe/ue, and as plain vowels. */
function spellings(part: string): string[] {
  const lower = part.normalize("NFC").toLowerCase();
  const expanded = clean(lower.replace(/[äöü]/g, (c) => UMLAUT[c]));
  const stripped = clean(lower);
  return [...new Set([expanded, stripped])].filter(Boolean);
}

type Part = string[];
type Word = Part[];

/** The words of a name, each a list of parts, each part its spellings.
 *  Titles, suffixes and single letters are gone. */
export function nameWords(name: string): Word[] {
  return name
    .normalize("NFC")
    .split(/[\s,;/()]+/u)
    .map((w) =>
      w
        .split(/[^\p{L}\p{N}]+/u)
        .map(spellings)
        .filter((p) => p.length > 0 && p.some((s) => s.length >= 2) && !p.some((s) => TITLES.has(s))),
    )
    .filter((w) => w.length > 0);
}

const allParts = (words: Word[]): Part[] => words.flat();

const hasPart = (parts: Part[], wanted: Part) => parts.some((p) => p.some((s) => wanted.includes(s)));
const hasWord = (parts: Part[], word: Word) => word.every((part) => hasPart(parts, part));

const onePerson = (raw: string, words: Word[]) =>
  !NOT_ONE_PERSON_RAW.test(raw) && !joinsTwoNames(raw) && !allParts(words).some((p) => p.some((s) => NOT_ONE_PERSON.has(s)));

export type PersonName = string | { firstName?: string; lastName?: string };

/** True only when `other` names the person on the Monerium profile. */
export function namesMatch(moneriumName: string | undefined, other: PersonName | undefined): boolean {
  if (!moneriumName || !other) return false;
  const verified = nameWords(moneriumName);
  if (verified.length < 2) return false;
  if (typeof other === "string") {
    const given = nameWords(other);
    if (!given.length || !onePerson(other, given)) return false;
    const parts = allParts(given);
    return hasWord(parts, verified[0]) && hasWord(parts, verified[verified.length - 1]);
  }
  const raw = `${other.firstName ?? ""} ${other.lastName ?? ""}`;
  const first = nameWords(other.firstName ?? "");
  const last = nameWords(other.lastName ?? "");
  if (!first.length || !last.length || !onePerson(raw, [...first, ...last])) return false;
  const parts = allParts(verified);
  return hasWord(parts, first[0]) && last.every((w) => hasWord(parts, w));
}
