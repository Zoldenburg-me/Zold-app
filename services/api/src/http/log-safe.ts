/**
 * A URL as a log line may show it: scheme and host only.
 *
 * Providers put API keys in the path (Candide's paymaster is
 * /api/v3/<chain>/<key>), the query or the userinfo, and log lines leave the
 * host. An unparseable value is not echoed, since it may be a key itself.
 */
export function urlForLog(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable URL)";
  }
}
