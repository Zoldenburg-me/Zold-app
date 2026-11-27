/**
 * Text Postgres's `json` type refuses: a NUL (22P05) or a lone UTF-16
 * surrogate (22P02). The JSON backend stores either, so without this a row
 * written today becomes one the Postgres store cannot write or import.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True if any string in `v` (keys included) is text Postgres refuses. */
export function hasUnstorableText(v: unknown): boolean {
  if (typeof v === "string") return UNSTORABLE.test(v);
  if (Array.isArray(v)) return v.some(hasUnstorableText);
  if (v !== null && typeof v === "object") return Object.entries(v).some(([k, x]) => UNSTORABLE.test(k) || hasUnstorableText(x));
  return false;
}

/** The first `n` characters of `s`, never half of one (an emoji is two UTF-16 units). */
export const sliceChars = (s: string, n: number): string => Array.from(s).slice(0, n).join("");
