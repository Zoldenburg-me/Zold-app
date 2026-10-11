import { IS_LOCAL_CHAIN, IS_PRODUCTION, LOOKS_LOCAL } from "./env.js";

/**
 * THE ONE HARNESS SEAM. scripts/_local-chain.ts sets LOCAL_HARNESS=1 for every
 * test suite, and it is honoured ONLY on the hardhat chain (31337) outside
 * production: that chain has no Monerium, no ERC-4337 bundler and no anchor,
 * so the suites need fake Safe ceremonies, a fake UserOperation hash, a
 * locally minted EURe for a mirrored deposit, and up-front account approval.
 * On every real-money chain the flag is inert by construction (the chain id
 * test cannot be configured away), and production refuses to start with it.
 * It opens no product route: there are no simulated deposits, self-approval
 * or mock payouts.
 */
export const HARNESS = {
  enabled: process.env.LOCAL_HARNESS === "1" && IS_LOCAL_CHAIN && !IS_PRODUCTION,
};

/**
 * Identity is Monerium's. An account is approved when a Monerium connection
 * (OAuth or the user's own API keys) attributes an IBAN to its Safe — there is
 * no in-house review, no auto-approval and no third-party KYC provider.
 */
export const KYC = {
  /**
   * Test harness only. The local hardhat chain (31337) has no Monerium, so the
   * test suites approve accounts up front with KYC_AUTO_APPROVE=1. The flag is
   * ignored on every other chain and refused in production mode below.
   */
  autoApprove: process.env.KYC_AUTO_APPROVE === "1" && HARNESS.enabled,
  /**
   * Shared secret for the operator/admin routes (ops dashboard, recovery
   * approvals). Unset means no operator path at all — fail closed rather than
   * leave an unauthenticated admin endpoint exposed.
   */
  operatorToken: process.env.KYC_OPERATOR_TOKEN ?? "",
};

export const RECOVERY = {
  /** How long a started recovery may wait for its passkey, codes or review. */
  requestTtlHours: Math.max(1, Number(process.env.RECOVERY_REQUEST_TTL_HOURS ?? 24 * 14)),
  /**
   * Candide's Safe Recovery Service — the email/SMS guardian.
   *
   * Candide acts as a guardian on the user's Safe and signs a recovery only
   * after the user passes an OTP on EVERY channel they registered. The URL is
   * issued by Candide on request; unset means the feature reports
   * `unavailable` and every route refuses, rather than pointing at a public
   * host that does not exist.
   */
  serviceUrl: (process.env.RECOVERY_SERVICE_URL ?? "").replace(/\/+$/, ""),
  /** SIWE domain/uri the service expects in registration statements. The
   *  SDK's defaults are what their service verifies; override only if Candide
   *  says so. */
  siweDomain: process.env.RECOVERY_SIWE_DOMAIN ?? "",
  siweUri: process.env.RECOVERY_SIWE_URI ?? "",
  /** How often finalizable recoveries are swept. */
  sweepMs: Math.max(10_000, Number(process.env.RECOVERY_SWEEP_MS ?? 60_000)),
  /**
   * Keys the HMAC of the bank account a user enrolled for Zoldenburg recovery
   * (recovery/zoldenburg-enrolment.ts), so the stored value names no IBAN.
   * Unset: nobody can enrol, so the operator can sign for nobody. Changing it
   * disarms every enrolment until the user sends 1 € again.
   */
  ibanHmacKey: process.env.RECOVERY_IBAN_HMAC_KEY ?? "",
};

if (RECOVERY.ibanHmacKey && RECOVERY.ibanHmacKey.length < 32) {
  throw new Error("RECOVERY_IBAN_HMAC_KEY is too short (need >= 32 chars) — generate one with `openssl rand -hex 32`");
}

/**
 * The 3-minute SocialRecoveryModule is a test fixture, so a recovery can run
 * end to end without waiting three days. It is the only variant deployed on
 * Base Sepolia. With real money, 3 minutes gives the owner no time to cancel
 * a hijacked recovery, so production refuses to boot with it.
 */
export const RECOVERY_MODULE_3_MINUTES = "0x949d01d424bE050D09C16025dd007CB59b3A8c66";

// A guessable operator token is worse than none: it is a remote approval
// switch for every account. Refuse to start rather than serve one.
if (KYC.operatorToken && KYC.operatorToken.length < 24) {
  throw new Error(
    "KYC_OPERATOR_TOKEN is too short (need >= 24 chars) — generate one with `openssl rand -base64 32`",
  );
}

/**
 * Custody posture: whether the orchestrator may ever hold a user's input funds.
 *
 * "We never take custody" has regulatory weight (roughly the line between a
 * technical service provider and a payment/crypto-asset service). Otherwise it
 * depends on three unrelated settings: the configured venue, whether Bridge is
 * live, and whether a venue call succeeds. So every transfer records the
 * custody mode it ran in (`transfer.custody`), and `requireNonCustodial` turns
 * the preference into a refusal.
 *
 * The refusal is off by default: with BRIDGE_LIVE unset there is no external
 * deposit address, so a batch's output can only go to the orchestrator, and
 * turning it on would break every testnet deployment including Base Sepolia.
 * The default path is non-custodial; a deployment moving real money should set
 * REQUIRE_NON_CUSTODIAL=1.
 */
export const CUSTODY = {
  /** Refuse to create a transfer that would route the user's funds through the
   *  orchestrator. */
  requireNonCustodial: process.env.REQUIRE_NON_CUSTODIAL === "1",
} as const;

/** Security posture: origin policy, rate limits and WebAuthn verification. */
export const SECURITY = {
  /**
   * How many reverse proxies sit in front of this process.
   *
   * Rate limits key on the client address, and with no proxy configured Express
   * reports the socket peer — which behind nginx is the proxy itself, so every
   * caller shares one bucket and a single client can exhaust the limit for
   * everybody. Set this to the real hop count so the client IP is taken from
   * the right position in X-Forwarded-For; leaving it 0 keeps the socket peer,
   * which is correct only when nothing is in front.
   */
  trustedProxyHops: Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 0)),
  /** WebAuthn relying-party id + origins allowed for ceremonies and for
   *  cross-origin state-changing requests. */
  rpId: process.env.RP_ID ?? "localhost",
  origins: (
    process.env.WEBAUTHN_ORIGINS ??
    `http://localhost:${process.env.TRANSF_API_PORT ?? 3000},http://127.0.0.1:${process.env.TRANSF_API_PORT ?? 3000}`
  ).split(",").map((s) => s.trim()).filter(Boolean),
  /** Shared secret for Monerium webhook deliveries. Unset = no signature
   *  check; the receiver is still safe because it re-reads the named order
   *  from Monerium rather than trusting the request body. */
  moneriumWebhookSecret: process.env.MONERIUM_WEBHOOK_SECRET ?? "",
  /** How far a signed webhook timestamp may be from now before we refuse it.
   *  Guards replay of a captured delivery we never received, which delivery-id
   *  dedupe cannot catch. 0 disables the check. */
  webhookToleranceSec: Number(process.env.MONERIUM_WEBHOOK_TOLERANCE_SEC ?? 300),
  /** Simple per-IP rate limits (requests per minute). */
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
  authRateLimitPerMin: Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? 20),
  /** Routes that call a partner or the chain per request (http/policy.ts). */
  partnerRateLimitPerMin: Number(process.env.PARTNER_RATE_LIMIT_PER_MIN ?? 30),
  documentRateLimitPerMin: Number(process.env.DOCUMENT_RATE_LIMIT_PER_MIN ?? 10),
  /** The operator dashboard with a valid token. Its refresh loop alone sends
   *  ~16 requests a minute; a wrong token stays on the auth bucket. */
  operatorRateLimitPerMin: Number(process.env.OPERATOR_RATE_LIMIT_PER_MIN ?? 300),
  /** Shopify's HMAC-signed calls, from Shopify's shared addresses. */
  shopifyRateLimitPerMin: Number(process.env.SHOPIFY_RATE_LIMIT_PER_MIN ?? 600),
  /** Maximum JSON request body accepted by the API. */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? "64kb",
  /** Opaque bearer session lifetime. Default: 24 hours. */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 24 * 60 * 60 * 1000),
  /** Keep provider/chain internals out of hosted API responses; a local
   *  stack is the one place a stack trace helps more than it leaks. */
  exposeInternalErrors: process.env.NODE_ENV !== "production" && LOOKS_LOCAL,
};
