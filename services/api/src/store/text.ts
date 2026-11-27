/**
 * Text Postgres's `json` type refuses: a NUL (22P05) or a lone UTF-16
 * surrogate (22P02). The JSON backend stores either, so without this a row
 * written today becomes one the Postgres store cannot write or import.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True if any string in `v` (keys included) is text Postgres refuses.
 *  A loop, not recursion: a deeply nested body must not exhaust the stack. */
export function hasUnstorableText(v: unknown): boolean {
  const todo: unknown[] = [v];
  while (todo.length) {
    const x = todo.pop();
    if (typeof x === "string") {
      if (UNSTORABLE.test(x)) return true;
    } else if (Array.isArray(x)) {
      for (const y of x) todo.push(y); // not push(...x): a wide array would overflow the argument list
    } else if (x !== null && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        if (UNSTORABLE.test(k)) return true;
        todo.push(y);
      }
    }
  }
  return false;
}

/** `s` with each NUL dropped and each lone surrogate replaced by U+FFFD, for
 *  text we did not write (a partner's error body) on its way into a row. */
export const storableText = (s: string): string =>
  s.replace(new RegExp(UNSTORABLE.source, "g"), (m) => (m === "\u0000" ? "" : "\uFFFD"));

/** The first `n` characters of `s`, never half of one (an emoji is two UTF-16 units). */
export const sliceChars = (s: string, n: number): string => Array.from(s).slice(0, n).join("");
