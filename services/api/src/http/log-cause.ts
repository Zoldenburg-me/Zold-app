/**
 * One line for a server log about an error's cause: its name and short
 * message, with every URL, bare host and network target replaced and every
 * email, IBAN and phone masked (redactPii). A viem HTTP
 * error's full message names the URL it called, Node's DNS and socket errors
 * name the host or address bare, and a bundler or RPC endpoint can carry an
 * API key in its path or subdomain, so the raw cause never goes to the log.
 *
 * A bare host is a name with two or more dots, or one dot followed by a port
 * or a path, ending in a letters-only label; a sentence's full stop or an
 * amount like 12.50 is not one.
 */
const URL_PATTERN = /\b(?:https?|wss?):\/\/\S+/gi;
const NET_TARGET_PATTERN = /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\s+\S+/g;
const HOST_PATTERN =
  /\b(?:[\w-]+\.){2,}[a-z]{2,24}(?::\d+)?(?:\/\S*)?|\b[\w-]+\.[a-z]{2,24}(?::\d+(?:\/\S*)?|\/\S*)/gi;
const IP_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;

export function redactUrls(text: string): string {
  return text
    .replace(URL_PATTERN, "<url>")
    .replace(NET_TARGET_PATTERN, "$1 <host>")
    .replace(HOST_PATTERN, "<host>")
    .replace(IP_PATTERN, "<host>");
}

/**
 * Personal data a provider's error can echo: an email, an IBAN, a phone
 * number. Each is replaced by a mask that still says which one it was.
 *
 * An IBAN is a SEPA country code, two check digits, then either one compact
 * run of exactly that country's length or groups of four with single spaces
 * cut at that length, in either case, and it must pass the mod-97 check; the
 * word after it (`… 0130 00 INVALID`), a reference that is too short for its
 * country and one of the right shape that fails the check stay. An order id, a hex
 * address or a tx hash is not one.
 *
 * A phone is `+` or `00` and a country code, or a national number with a
 * leading 0 (`030/1234567`, `(030) 123 4567`), then digit groups separated by
 * a space, `-` or `/`, with an optional `(0)` trunk and parentheses around the
 * area code; 8 to 15 digits, 16 with the trunk. A `00` or national number
 * needs a separator, and a national one a subscriber group of three or more
 * digits, so an amount, an id, a date, a timestamp or a block number is not
 * one; a compact national number (`0301234567`) is not covered. Groups past
 * the digit limit are left unmasked rather than the whole match.
 *
 * An email's local part may carry `+` and `%`; its domain may already be
 * `<host>`, since redactUrls runs first.
 */
const EMAIL_PATTERN = /[\w.%+-]+@(?:<host>|[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,})/g;
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GG: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22,
  IM: 22, IS: 26, IT: 27, JE: 22, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31,
  NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};
const SEPA = Object.keys(IBAN_LENGTH).join("|");
const IBAN_PATTERN = new RegExp(
  `\\b(?:${SEPA})\\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)(?![A-Za-z0-9])`,
  "gi",
);
const PHONE_SEP = String.raw`(?: ?[/-] ?| )`;
const PHONE_GROUP = String.raw`(?:\(\d{1,5}\)|\d+)`;
const PHONE_PATTERN = new RegExp(
  String.raw`(?<![\w.,+/-])(?:` +
    String.raw`\+[1-9]\d{0,2}(?:${PHONE_SEP}?\(0\))?${PHONE_SEP}?${PHONE_GROUP}(?:${PHONE_SEP}${PHONE_GROUP}){0,5}` +
    String.raw`|00[1-9]\d{0,2}(?:${PHONE_SEP}?\(0\))?(?:${PHONE_SEP}${PHONE_GROUP}){1,6}` +
    String.raw`|(?:\(0\d{1,4}\)|0\d{1,4})${PHONE_SEP}\d{3,}(?:${PHONE_SEP}${PHONE_GROUP}){0,4}` +
    String.raw`)(?![\w/-])`,
  "g",
);
const PHONE_LAST_GROUP = new RegExp(`${PHONE_SEP}${PHONE_GROUP}$`);

/** a•••@domain: the shape recovery/candide-guardian.ts maskTarget shows. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${head}${"•".repeat(Math.max(1, local.length - head.length))}@${domain}`;
}

/** DE89…3000: first four and last four, spaces dropped. */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s/g, "");
  return `${compact.slice(0, 4)}…${compact.slice(-4)}`;
}

/** +••••••••••678: the last three digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `+${"•".repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}

/** ISO 13616 mod-97: the first four characters moved to the end, letters as
 *  10 to 35, the number mod 97 is 1. */
function ibanChecksumOk(iban: string): boolean {
  const s = (iban.slice(4) + iban.slice(0, 4)).toUpperCase();
  let rem = 0;
  for (const c of s) {
    const v = parseInt(c, 36);
    rem = v < 10 ? (rem * 10 + v) % 97 : (rem * 100 + v) % 97;
  }
  return rem === 1;
}

/** Masks the country's IBAN length of a spaced match and keeps the groups
 *  after it; a shorter match, a compact one of another length, or one that
 *  fails the checksum is not an IBAN. */
function maskIbanMatch(match: string): string {
  const want = IBAN_LENGTH[match.slice(0, 2).toUpperCase()];
  let end = match.length;
  if (match.includes(" ")) {
    let seen = 0;
    end = 0;
    while (end < match.length && seen < want) if (match[end++] !== " ") seen++;
    if (seen < want) return match;
  } else if (match.length !== want) return match;
  const iban = match.slice(0, end);
  return ibanChecksumOk(iban.replace(/ /g, "")) ? maskIban(iban) + match.slice(end) : match;
}

function maskPhoneMatch(match: string): string {
  const digitCount = (s: string) => s.replace(/\D/g, "").length;
  const max = /\(0\)/.test(match) ? 16 : 15;
  let phone = match;
  while (digitCount(phone) > max && PHONE_LAST_GROUP.test(phone)) phone = phone.replace(PHONE_LAST_GROUP, "");
  const n = digitCount(phone);
  return n < 8 || n > max ? match : maskPhone(phone) + match.slice(phone.length);
}

export function redactPii(text: string): string {
  return text.replace(EMAIL_PATTERN, maskEmail).replace(IBAN_PATTERN, maskIbanMatch).replace(PHONE_PATTERN, maskPhoneMatch);
}

/** Only this much of a line is redacted and logged: the host pattern
 *  backtracks quadratically on long dotted or hyphenated runs, and an RPC or
 *  bundler can echo a large body into an error message. */
const MAX_LOGGED = 500;

function firstLine(cause: unknown): string {
  if (cause === undefined || cause === null) return "no cause";
  if (typeof cause !== "object") return String(cause).split("\n")[0];
  const e = cause as { name?: unknown; shortMessage?: unknown; message?: unknown };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const text = typeof e.shortMessage === "string" ? e.shortMessage : typeof e.message === "string" ? e.message : "";
  return `${name}: ${text.split("\n")[0]}`;
}

export function describeCause(cause: unknown): string {
  return redactPii(redactUrls(firstLine(cause).slice(0, MAX_LOGGED)));
}

/**
 * The first eight "at …" frames of an error's stack, each redacted. A stack
 * starts with the full message (a viem error's names its URL and request
 * body), so nothing else of it is kept.
 */
export function callFrames(err: unknown): string[] {
  const stack = typeof (err as { stack?: unknown })?.stack === "string" ? (err as { stack: string }).stack : "";
  const frames = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ")).slice(0, 8);
  return frames.map((f) => redactPii(redactUrls(f.slice(0, MAX_LOGGED))));
}

/** describeCause plus the stack's call frames, for a log line that needs to
 *  say where it failed. */
export function describeError(err: unknown): string {
  return [describeCause(err), ...callFrames(err).map((f) => `    ${f}`)].join("\n");
}

/**
 * An error's text for matching against a pattern, never for a log line, a row
 * or a response: it is the raw message, a URL and its key included.
 */
export function errorText(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown; details?: unknown } | null | undefined;
  return [e?.shortMessage, e?.message, e?.details].filter((t) => typeof t === "string").join(" ") || String(err ?? "");
}

function originOrPlaceholder(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<url>";
  }
}

/**
 * An error's own words, for a stored row or a response body: the first line
 * of its short message, without the error's name, with every URL, network
 * target and IP address replaced, and every email, IBAN and phone masked
 * (redactPii). Dotted words stay, so a field path such as
 * `counterpart.identifier.iban` still says which field failed; a key-bearing
 * host appears in a URL or after a network error code, and both are replaced.
 * `keepHosts` cuts each URL to its origin instead, for a message that must
 * name an origin to be fixable (a WebAuthn origin mismatch).
 */
export function redactedMessage(err: unknown, opts: { keepHosts?: boolean } = {}): string {
  if (err === undefined || err === null) return "unknown error";
  const e = err as { shortMessage?: unknown; message?: unknown };
  const text =
    typeof err !== "object" ? String(err)
    : typeof e.shortMessage === "string" ? e.shortMessage
    : typeof e.message === "string" ? e.message
    : String(err);
  const line = (text.split("\n").find((l) => l.trim()) ?? "").slice(0, MAX_LOGGED);
  const out = opts.keepHosts
    ? line.replace(URL_PATTERN, originOrPlaceholder)
    : line.replace(URL_PATTERN, "<url>").replace(NET_TARGET_PATTERN, "$1 <host>").replace(IP_PATTERN, "<host>");
  return redactPii(out).trim() || "unknown error";
}

/** One line safe to show the caller: URLs removed, hosts kept (a WebAuthn
 *  origin mismatch has to name the origin to be fixable). */
export function shortErrorForClient(err: unknown): string {
  return firstLine(err).slice(0, 300).replace(URL_PATTERN, "<url>");
}
