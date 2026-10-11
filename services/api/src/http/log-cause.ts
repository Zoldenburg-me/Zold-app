/**
 * One line for a server log about an error's cause: its name and short
 * message, with every URL, bare host and network target replaced. A viem HTTP
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
  return redactUrls(firstLine(cause).slice(0, MAX_LOGGED));
}

/**
 * describeCause plus the stack's call frames, for a log line that needs to
 * say where it failed. A stack starts with the full message (a viem error's
 * names its URL and request body), so only the "at …" frames are kept.
 */
export function describeError(err: unknown): string {
  const stack = typeof (err as { stack?: unknown })?.stack === "string" ? (err as { stack: string }).stack : "";
  const frames = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ")).slice(0, 8);
  return [describeCause(err), ...frames.map((f) => `    ${redactUrls(f.slice(0, MAX_LOGGED))}`)].join("\n");
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
 * target and IP address replaced. Dotted words stay, so a field path such as
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
  return out.trim() || "unknown error";
}

/** One line safe to show the caller: URLs removed, hosts kept (a WebAuthn
 *  origin mismatch has to name the origin to be fixable). */
export function shortErrorForClient(err: unknown): string {
  return firstLine(err).slice(0, 300).replace(URL_PATTERN, "<url>");
}
