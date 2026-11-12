/**
 * A warning on a burst of 401/403 answers from Monerium.
 *
 * A revoked, expired or rotated credential (the app's, or a user's OAuth
 * token or API keys) shows up here first, before anyone reports a failed
 * payout. One refusal is routine (a user's token expired); five within a
 * minute is worth a look. moneriumFetch feeds every response in.
 *
 * The warning names the method and the route with every id, IBAN and the
 * query removed, never a token, a secret or whose account it was.
 */

export interface RefusalAlarmOptions {
  threshold?: number;
  windowMs?: number;
  warn?: (message: string) => void;
}

const ROUTE_WORD = /^[a-z][a-z-]*$/;

/** The path of a Monerium URL with anything that is not a plain route word
 *  (an id, an IBAN, an address) replaced by `:id`, and no query. */
export function routeForLog(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "(unparsed)";
  }
  return `/${path.split("/").filter(Boolean).map((s) => (ROUTE_WORD.test(s) ? s : ":id")).join("/")}`;
}

export function refusalAlarm({ threshold = 5, windowMs = 60_000, warn = (m) => console.warn(m) }: RefusalAlarmOptions = {}) {
  let recent: number[] = [];
  let warned = false;
  return {
    record(status: number, method: string, url: string, now = Date.now()) {
      if (status !== 401 && status !== 403) return;
      recent = recent.filter((t) => now - t < windowMs);
      // A quiet window ends a burst; the next one warns again.
      if (recent.length === 0) warned = false;
      recent.push(now);
      if (warned || recent.length < threshold) return;
      warned = true;
      warn(
        `monerium: ${recent.length} refusals (401/403) from Monerium in ${Math.round(windowMs / 1000)} s, ` +
          `latest ${method.toUpperCase()} ${routeForLog(url)} (${status}). A revoked or rotated credential shows up here first.`,
      );
    },
  };
}

/** The process-wide alarm moneriumFetch reports to. */
export const moneriumRefusals = refusalAlarm();
