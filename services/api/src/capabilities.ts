/**
 * What this deployment can actually do.
 *
 * One function, because the browser renders against it: a control the API
 * would refuse must not be drawn, and the only way to know is to be told.
 * Extracted from server.ts so /api/health is not the reason this lives in a
 * 3,800-line file.
 */
import { MONERIUM, SHOPIFY, moneriumOAuthEnabled } from "./config.js";
import { moneriumApiKeysAvailable, moneriumEnvironment } from "./adapters/monerium-connection.js";
import { cashRailOpen } from "./orchestrator.js";
import { shopifyAvailable } from "./routes/shopify.js";
import { candideRecoveryEnabled } from "./recovery/candide-guardian.js";

/**
 * What this deployment can actually do, so the browser can render against it
 * instead of offering an action the server will refuse.
 *
 * Deliberately NOT per-user, and deliberately public. These are properties of
 * the deployment rather than of an account, and /api/health already publishes
 * the contract addresses; every flag here is one refused request away from
 * being learned anyway.
 */
export function capabilities() {
  return {
    /** Deposits are real Monerium IBAN transfers, always: there is no mock. */
    sandbox: true,
    /** May the browser offer "sign up / sign in with Monerium" (OAuth)? */
    moneriumOAuth: moneriumOAuthEnabled(),
    /** Is the cash (EUR -> KES) corridor open? Bridge live AND an anchor
     *  configured; the UI hides the corridor rather than quote into a wall. */
    cashRail: cashRailOpen(),
    /** Is a Shopify payments app registered for this deployment? Without one
     *  the dashboard's Shopify card says so instead of offering a connect
     *  button that can only fail. */
    shopify: shopifyAvailable().available,
    /** Which Shopify shape this deployment runs — `custom-app` (manual
     *  payment method + orders webhook, installable today) or `payments-app`
     *  (a checkout payment method, needs Shopify's program approval). */
    shopifyMode: SHOPIFY.mode,
    /**
     * May a user connect their OWN Monerium app credentials? Needs the
     * encryption key, because the secret is never written in plaintext. The
     * environment tells the browser which portal the keys must come from —
     * sandbox keys against production, or the reverse, fail as "wrong secret".
     */
    moneriumApiKeys: moneriumApiKeysAvailable(),
    moneriumEnvironment: moneriumEnvironment(),
    /** May a user enrol email/SMS recovery, and may a lost device recover
     *  through it? Needs Candide's recovery service URL. */
    emailSmsRecovery: candideRecoveryEnabled(),
    moneriumHost: (() => { try { return new URL(MONERIUM.baseUrl).host; } catch { return MONERIUM.baseUrl; } })(),
  };
}
