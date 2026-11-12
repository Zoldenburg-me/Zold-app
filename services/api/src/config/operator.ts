/**
 * The operator of the admin dashboard: where it is served, its Cloudflare
 * Access application, and how long its sessions and enrolment links last.
 * None of these is a secret; the Access audience tag and team domain are
 * printed in the Cloudflare dashboard.
 */
import { IS_PRODUCTION, LOOKS_LOCAL } from "./env.js";
import { SECURITY } from "./security.js";

/** `zoldenburg.cloudflareaccess.com` or `https://zoldenburg.cloudflareaccess.com`,
 *  read as the bare host. */
function accessHost(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).host;
  } catch {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be a host such as <team>.cloudflareaccess.com");
  }
}

const explicitAdminOrigin = (process.env.ADMIN_ORIGIN ?? "").trim().replace(/\/+$/, "");

export const OPERATOR = {
  /** The one origin an operator passkey ceremony is verified against, and
   *  where /admin is served. Unset on the local stack, the first WebAuthn
   *  origin (the local API) stands in. */
  adminOrigin: explicitAdminOrigin || SECURITY.origins[0] || "",
  /** Set explicitly: /admin on any other host redirects here, and this host
   *  serves the dashboard and nothing else. */
  adminOriginExplicit: Boolean(explicitAdminOrigin),
  /** Every deployment but the local hardhat stack (zoldhq.com included,
   *  whatever its production flag): the dashboard runs only on its own
   *  origin, behind Cloudflare Access. */
  hardened: IS_PRODUCTION || !LOOKS_LOCAL,
  accessTeamHost: accessHost(process.env.CF_ACCESS_TEAM_DOMAIN ?? ""),
  /** The Access application's Application Audience (AUD) tag. */
  accessAud: (process.env.CF_ACCESS_AUD ?? "").trim(),
  /** Where the signing keys are fetched; derived from the team domain. Set
   *  only by the offline suites, which serve their own keys. */
  accessCertsUrl: (process.env.CF_ACCESS_CERTS_URL ?? "").trim(),
  sessionTtlMs: 8 * 60 * 60_000,
  sessionIdleMs: 30 * 60_000,
  enrolmentTtlMs: 15 * 60_000,
  /** Passkeys per operator: a primary and a backup, with room for a swap. */
  maxPasskeys: 5,
} as const;

if (explicitAdminOrigin) {
  let u: URL;
  try {
    u = new URL(explicitAdminOrigin);
  } catch {
    throw new Error("ADMIN_ORIGIN must be an origin such as https://admin.zoldhq.com");
  }
  if (u.origin !== explicitAdminOrigin) throw new Error("ADMIN_ORIGIN must be an origin only: scheme, host and port, no path");
}
