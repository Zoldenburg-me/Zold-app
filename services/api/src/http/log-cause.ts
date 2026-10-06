/**
 * One line for a server log about an error's cause: its name and short
 * message, with every URL replaced by `<url>`. A viem HTTP error's full
 * message names the URL it called, and a bundler or RPC URL can carry an API
 * key, so the raw cause never goes to the log.
 */
const URL_PATTERN = /\b(?:https?|wss?):\/\/\S+/gi;

export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, "<url>");
}

export function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return "no cause";
  if (typeof cause !== "object") return redactUrls(String(cause).split("\n")[0]);
  const e = cause as { name?: unknown; shortMessage?: unknown; message?: unknown };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const text = typeof e.shortMessage === "string" ? e.shortMessage : typeof e.message === "string" ? e.message : "";
  return redactUrls(`${name}: ${text.split("\n")[0]}`);
}
