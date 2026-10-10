/**
 * Turnkey, for social recovery guardians (docs/recovery-guardians-plan.md,
 * Phase 2). Off unless TURNKEY_GUARDIANS=1, and it stays off until the
 * Phase 0 recovery alerts (in-app banner and email) are live: every guardian
 * can start a takeover, and the alert is what lets the owner cancel it.
 *
 * On, every field must be set, or the API refuses to start: a switch that is
 * on with no way to reach Turnkey would offer a button that can only fail.
 *
 * The parent organisation's API key is used for two things only: creating a
 * sub-org whose sole root user is the person, and starting that person's
 * login. It never becomes a user inside a sub-org (wallet/turnkey.ts).
 */
const enabled = process.env.TURNKEY_GUARDIANS === "1";

export const TURNKEY = (() => {
  const cfg = {
    enabled,
    baseUrl: (process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com").replace(/\/+$/, ""),
    organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
    /**
     * The OAuth client ids a guardian's ID token may be issued for: our
     * Google web client id and our Apple services id. A token for anyone
     * else's app is refused, so a token minted for another site cannot add
     * or log in a guardian here.
     */
    oauthClientIds: (process.env.TURNKEY_OAUTH_CLIENT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (enabled) {
    const missing = [
      ["TURNKEY_ORGANIZATION_ID", cfg.organizationId],
      ["TURNKEY_API_PRIVATE_KEY", process.env.TURNKEY_API_PRIVATE_KEY ?? ""],
      ["TURNKEY_OAUTH_CLIENT_IDS", cfg.oauthClientIds.join(",")],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`TURNKEY_GUARDIANS=1 needs ${missing.join(", ")}`);
    if (!/^[0-9a-fA-F]{64}$/.test(process.env.TURNKEY_API_PRIVATE_KEY!)) {
      throw new Error("TURNKEY_API_PRIVATE_KEY must be the 32-byte P-256 private key as 64 hex characters");
    }
    if (!/^https:\/\//.test(cfg.baseUrl)) throw new Error("TURNKEY_API_BASE_URL must be https");
  }
  return cfg;
})();
