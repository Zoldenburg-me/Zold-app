import { CHAIN_ID } from "./env.js";

const evmAddressRe = /^0x[0-9a-fA-F]{40}$/;
const parseChainIds = (raw: string | undefined) =>
  (raw ?? String(CHAIN_ID))
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);

/**
 * Candide Forwarding Address service for payment-page receive addresses.
 *
 * The activation call needs a server-side account API key. Local/hardhat runs
 * may fall back to the user's Safe address so tests can run without a Candide
 * account, but hosted production must be explicitly configured before payment
 * pages can be activated.
 */
/** The name this key once had in a deployed .env. It was never read, so
 *  forwarding activation failed with nothing pointing at the typo; say so. */
if (process.env.CANDIDE_FORWARDING_API_KEY && !process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY) {
  console.warn(
    "NOTE: CANDIDE_FORWARDING_API_KEY is set but is not read — rename it to CANDIDE_FORWARDING_ACCOUNT_API_KEY.",
  );
}
export const FORWARDING = {
  rpcUrl: process.env.CANDIDE_FORWARDING_RPC_URL ?? process.env.FORWARDING_ADDRESS_RPC_URL ?? "",
  accountApiKey: process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY ?? "",
  sourceChainIds: parseChainIds(process.env.CANDIDE_FORWARDING_SOURCE_CHAIN_IDS),
  custodialWithdrawer: (process.env.CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER ?? "") as `0x${string}` | "",
  recoveryConfigured: evmAddressRe.test(process.env.CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER ?? ""),
};

/**
 * Email verification: a 6-digit code sent over SMTP (adapters/mailer.ts).
 * Off unless EMAIL_VERIFICATION=1, and then every SMTP field must be set:
 * a flag that is on with no way to send would show a code screen for a mail
 * that never leaves. Off, signup and recovery treat the email as they always
 * have (docs/email-verification.md).
 */
export const EMAIL_VERIFICATION = (() => {
  const enabled = process.env.EMAIL_VERIFICATION === "1";
  const smtp = {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.MAIL_FROM ?? "",
    /** Port 465 speaks TLS from the first byte; others upgrade with STARTTLS. */
    secure: (process.env.SMTP_PORT ?? "587") === "465",
  };
  if (enabled) {
    const missing = (["host", "user", "pass", "from"] as const).filter((k) => !smtp[k]);
    if (missing.length) {
      throw new Error(`EMAIL_VERIFICATION=1 needs ${missing.map((k) => (k === "from" ? "MAIL_FROM" : `SMTP_${k.toUpperCase()}`)).join(", ")}`);
    }
    if (!Number.isInteger(smtp.port) || smtp.port <= 0) throw new Error("SMTP_PORT must be a port number");
  }
  return {
    enabled,
    smtp,
    codeTtlMs: 15 * 60_000,
    maxAttempts: 5,
    resendAfterMs: 60_000,
    maxSendsPerHour: 5,
  } as const;
})();

/**
 * Gnosis Pay, permissionless card integration.
 *
 * Permissionless mode has no API key: the user signs in with SIWE and Gnosis
 * Pay returns a JWT scoped to them. There is nothing to gate on, so unlike the
 * other partners this one defaults to the real base URL.
 *
 * `partnerId` stays unset. It belongs to partner mode (webhooks, card-activity
 * attribution), which we have not been granted.
 *
 * siweChainId is 100 (Gnosis Chain). Don't derive it from CHAIN_ID: the Gnosis
 * Pay account lives on their chain wherever Zold runs, and they reject a SIWE
 * message for any other chain.
 */
export const GNOSIS_PAY = {
  baseUrl: process.env.GNOSIS_PAY_BASE_URL ?? "https://api.gnosispay.com",
  siweChainId: Number(process.env.GNOSIS_PAY_SIWE_CHAIN_ID ?? 100),
  jwtTtlSeconds: Number(process.env.GNOSIS_PAY_JWT_TTL_SECONDS ?? 3600),
  timeoutMs: Number(process.env.GNOSIS_PAY_TIMEOUT_MS ?? 12_000),
  partnerId: process.env.GNOSIS_PAY_PARTNER_ID ?? "",
} as const;

/**
 * Shopify payments app.
 *
 * The app is registered ONCE in a Shopify Partner account; every merchant
 * installs the same app into their store. `apiKey`/`apiSecret` are that app's
 * client id and secret. The secret signs every request Shopify sends us
 * (Shopify-Hmac-Sha256) and the OAuth callback, so without it nothing here can
 * be trusted and the router reports `unavailable`.
 *
 * `shopBaseUrl` exists for the test stub only: in production every call goes
 * to https://<shop>.myshopify.com.
 */
/**
 * TWO WAYS INTO A SHOPIFY STORE, and only one of them is open to us today.
 *  - `payments-app`: Zold is a payment method inside checkout (offsite
 *    payments app). Needs Shopify's Payments Apps program approval before any
 *    store can install it; nobody has been granted that.
 *  - `custom-app` (default): the store offers a MANUAL payment method named
 *    Zold, we receive the orders/create webhook, open a payment request for
 *    the order, and mark the order paid through the Admin API when the
 *    deposit is attributed. Installable on one store by custom distribution
 *    with no Shopify review, which is why it is the default.
 */
const SHOPIFY_MODE = ((): "payments-app" | "custom-app" => {
  const m = (process.env.SHOPIFY_MODE ?? "custom-app").trim();
  if (m !== "payments-app" && m !== "custom-app") throw new Error(`SHOPIFY_MODE must be payments-app or custom-app, got ${m}`);
  return m;
})();

export const SHOPIFY = {
  apiKey: process.env.SHOPIFY_API_KEY ?? "",
  apiSecret: process.env.SHOPIFY_API_SECRET ?? "",
  apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-07",
  mode: SHOPIFY_MODE,
  scopes: process.env.SHOPIFY_SCOPES ?? (SHOPIFY_MODE === "payments-app" ? "write_payment_gateways,write_payment_sessions" : "read_orders,write_orders"),
  /** custom-app: an order is ours when one of its payment gateway names
   *  contains this (case-insensitive). The merchant names the manual method. */
  manualGateway: (process.env.SHOPIFY_MANUAL_GATEWAY ?? "zold").trim().toLowerCase(),
  /** custom-app: how long an order's payment request stays open. A manual-
   *  payment order waits for the buyer, so this is longer than a checkout
   *  session; after it the order is still there, but a late deposit lands on
   *  the page unattributed and the merchant marks the order paid by hand. */
  orderTtlMs: Number(process.env.SHOPIFY_ORDER_TTL_MS ?? 24 * 60 * 60_000),
  shopBaseUrl: process.env.SHOPIFY_SHOP_BASE_URL ?? "",
  timeoutMs: Number(process.env.SHOPIFY_TIMEOUT_MS ?? 12_000),
  enabled: Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET),
} as const;

const boolEnv = (key: string) => process.env[key] === "1";

export const PRIVACY_BUNDLE = {
  enabled: process.env.PRIVACY_BUNDLE_ENABLED !== "0",
  kokioLive: boolEnv("KOKIO_LIVE"),
  mysteriumLive: boolEnv("MYSTERIUM_LIVE"),
  minMarginBps: Number(process.env.PRIVACY_BUNDLE_MIN_MARGIN_BPS ?? 3500),
  plans: [
    {
      id: "travel-shield",
      name: "Travel Shield",
      priceEur: 9.99,
      estimatedCostEur: Number(process.env.PRIVACY_BUNDLE_TRAVEL_COST_EUR ?? 5.25),
      esimGb: 3,
      esimRegion: "regional",
      vpnGb: 25,
      vpnDevices: 3,
      billingPeriod: "month",
      positioning: "For one trip or a backup private connection.",
    },
    {
      id: "global-shield",
      name: "Global Shield",
      priceEur: 19.99,
      estimatedCostEur: Number(process.env.PRIVACY_BUNDLE_GLOBAL_COST_EUR ?? 10.75),
      esimGb: 10,
      esimRegion: "global",
      vpnGb: 100,
      vpnDevices: 5,
      billingPeriod: "month",
      positioning: "Best for regular travel and public Wi-Fi.",
    },
    {
      id: "nomad-shield",
      name: "Nomad Shield",
      priceEur: 34.99,
      estimatedCostEur: Number(process.env.PRIVACY_BUNDLE_NOMAD_COST_EUR ?? 19.5),
      esimGb: 25,
      esimRegion: "global",
      vpnGb: 250,
      vpnDevices: 10,
      billingPeriod: "month",
      positioning: "For heavy roaming without selling unlimited usage.",
    },
  ],
};
