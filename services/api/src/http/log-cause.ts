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

export function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return "no cause";
  if (typeof cause !== "object") return redactUrls(String(cause).split("\n")[0]);
  const e = cause as { name?: unknown; shortMessage?: unknown; message?: unknown };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const text = typeof e.shortMessage === "string" ? e.shortMessage : typeof e.message === "string" ? e.message : "";
  return redactUrls(`${name}: ${text.split("\n")[0]}`);
}
