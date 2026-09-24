/**
 * Human-chosen passwords — today only the optional second factor on an
 * Invoice-Me link. There is no account password anywhere: sign-in is a passkey.
 *
 * A link TOKEN is 32 random bytes, so a bare SHA-256 of it is fine. A password
 * is not: it is low-entropy, and an unsalted SHA-256 of one is recovered from a
 * leaked row in seconds with a wordlist. So passwords get their own policy
 * (NIST 800-63B shape: length and a blocklist, no composition rules) and a
 * salted, deliberately slow hash.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { tokenMatches } from "./invoices.js";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// The passwords that top every breach corpus, lower-cased. Short on purpose:
// the length floor already excludes most of any top-10k list, and this catches
// the long ones people still reach for.
const COMMON = new Set([
  "password1234", "password12345", "password123!", "passwort1234", "qwertyuiop12",
  "qwertyuiopas", "123456789012", "1234567890ab", "iloveyou1234", "letmein12345",
  "welcome12345", "administrator", "changeme1234", "abcdefghijkl", "aaaaaaaaaaaa",
  "passwordpassword", "qwerty123456", "1q2w3e4r5t6y", "zaq12wsxcde3", "trustno1trustno1",
]);

/** Why a password is refused, or undefined if it is acceptable. */
export function passwordProblem(pw: string, context: string[] = []): string | undefined {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return "That password is on common-password lists. Pick another.";
  if (new Set(lower).size < 5) return "That password repeats too few characters. Pick another.";
  if (isSequence(lower)) return "That password is a keyboard or number sequence. Pick another.";
  for (const c of context) {
    const word = c.trim().toLowerCase();
    if (word.length >= 4 && lower.includes(word)) {
      return "Do not build the password from the organisation's name or the invoice details.";
    }
  }
  return undefined;
}

/** 0123…, abcd…, and their reverses — each step the same ±1. */
function isSequence(s: string): boolean {
  const d = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(d) !== 1) return false;
  for (let i = 2; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== d) return false;
  return true;
}

// scrypt N=2^15, r=8, p=1: ~32 MiB and tens of ms per guess on a server core.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash`, both base64url. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * Constant-time check. A row written before scrypt holds a bare SHA-256 hex
 * digest; it still verifies, so no existing link stops working.
 */
export function passwordMatches(pw: string, stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return tokenMatches(pw, stored);
  const [, n, r, p, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64 ?? "", "base64url");
  if (!expected.length) return false;
  const got = scryptSync(pw, Buffer.from(saltB64 ?? "", "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return timingSafeEqual(got, expected);
}
