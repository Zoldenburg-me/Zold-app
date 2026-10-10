/**
 * What this deployment can actually do.
 *
 * One function, because the browser renders against it: a control the API
 * would refuse must not be drawn, and the only way to know is to be told.
 * Extracted from server.ts so /api/health is not the reason this lives in a
 * 3,800-line file.
 */
import { TURNKEY } from "./config.js";
import { EMAIL_VERIFICATION, ENS_GATEWAY, ENS_LOOKUP, FORWARDING, HARNESS, MONERIUM, SHOPIFY, TESTNET_FAUCET, moneriumOAuthEnabled } from "./config.js";
import { moneriumApiKeysAvailable, moneriumEnvironment } from "./adapters/monerium-connection.js";
import { cashRailOpen } from "./orchestrator.js";
import { usdLabel } from "./usd-token.js";
import { dripTokens, faucetEnabled } from "./faucet.js";
import { shopifyAvailable } from "./routes/shopify.js";
import { candideRecoveryEnabled } from "./recovery/candide-guardian.js";
import { zoldenburgRecoveryEnabled } from "./recovery/zoldenburg-guardian.js";
import { turnkeyGuardiansEnabled } from "./wallet/turnkey.js";

/**
 * What this deployment can do, so the browser only offers actions the server
 * will accept.
 *
 * Public and not per-user: these are properties of the deployment, and each
 * flag can be learned from a single refused request anyway. /api/health
 * already publishes the contract addresses.
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
    /** May a user add Zoldenburg as their recovery guardian, and may a lost
     *  device ask Zoldenburg to recover it? Needs the guardian address. */
    zoldenburgRecovery: zoldenburgRecoveryEnabled(),
    /** May a user make their own Google or Apple login a recovery guardian
     *  (a Turnkey wallet)? Off until TURNKEY_GUARDIANS=1, which waits for
     *  the recovery alerts; no screen offers it yet. */
    turnkeyGuardians: turnkeyGuardiansEnabled(),
    /** The OAuth client ids /guardian logs in with (not secrets: every login
     *  URL carries them), or null while the switch is off. */
    turnkeyLogins: turnkeyGuardiansEnabled() ? { google: TURNKEY.googleClientId, apple: TURNKEY.appleClientId } : null,
    /** Turnkey's API, which /guardian alone calls to sign a recovery. */
    turnkeyApi: turnkeyGuardiansEnabled() ? TURNKEY.baseUrl : null,
    /** May a new company login bring in an existing Safe instead of
     *  deploying one (routes/safe-import.ts)? Needs a real chain: under the
     *  local harness both import routes answer NO_CHAIN. Whether one account
     *  is still eligible is per user, and only `prepare` can tell. */
    safeImport: !HARNESS.enabled,
    /** Does a payment page take tokens from other chains? Only through a
     *  Candide forwarder; without one the page's address is the Safe and
     *  takes the app's USDC on this chain alone. */
    paymentPageForwarding: Boolean(FORWARDING.rpcUrl) && !usdLabel().staging,
    /** The app's dollar token, labelled by its own symbol(): "USDC" on Base
     *  mainnet, "zUSD" on a staging chain (`staging: true`). */
    usdToken: usdLabel(),
    /** The ENS name payment pages resolve under (`alice.zoldhq.com`), or
     *  null when this deployment runs no gateway. */
    ensParent: ENS_GATEWAY.enabled ? ENS_GATEWAY.parent : null,
    /** May a signed-in user look up an ENS name (GET /api/ens/lookup)? */
    ensLookup: ENS_LOOKUP.enabled,
    /** Does the app ask the user to confirm their email with a code? Off
     *  until EMAIL_VERIFICATION is enabled with an SMTP server. */
    emailVerification: EMAIL_VERIFICATION.enabled,
    /** Test EURe per account from the testnet faucet, or 0 when there is
     *  none — never on a chain where EURe is real money. */
    faucetEur: faucetEnabled() ? TESTNET_FAUCET.grantEur : 0,
    /** Tokens the public /faucet page drips, or none — same refusals. */
    faucetTokens: dripTokens().map((t) => t.symbol),
    moneriumHost: (() => { try { return new URL(MONERIUM.baseUrl).host; } catch { return MONERIUM.baseUrl; } })(),
  };
}
