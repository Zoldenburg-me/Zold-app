import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");

const initialPort = process.env.TRANSF_API_PORT ?? process.env.PORT;
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — mock mode
}
if (initialPort) process.env.TRANSF_API_PORT = initialPort;

// Base mainnet by default. The local hardhat stack sets its own RPC and chain
// id (scripts/_local-chain.ts); nothing else should ever land here by accident.
export const RPC_URL = process.env.TRANSF_RPC_URL ?? "https://mainnet.base.org";
export const API_PORT = Number(process.env.TRANSF_API_PORT ?? process.env.PORT ?? 3000);
export const API_HOST = process.env.TRANSF_API_HOST ?? "127.0.0.1";
export const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.TRANSF_PRODUCTION === "1";
export const PUBLIC_URL = process.env.TRANSF_PUBLIC_URL ?? "";

export const USING_LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(RPC_URL);

/**
 * Which chain we settle on. Wallet deployment, signatures and token balances
 * all need the same chain id, so it is derived from this one place.
 *
 * 8453 = Base mainnet (default — the production chain, where Monerium issues
 * the real EURe and Circle the real USDC), 31337 = the local hardhat stack the
 * test harnesses pin themselves to. Unknown ids are synthesized by chain.ts.
 */
export const CHAIN_ID = Number(process.env.TRANSF_CHAIN_ID ?? 8453);
/** Chains where the tokens are real money. Anything test-only refuses here. */
export const REAL_MONEY_CHAINS = new Set([1, 100, 137, 8453, 42161, 59144]);
export const IS_REAL_MONEY_CHAIN = REAL_MONEY_CHAINS.has(CHAIN_ID);
export const IS_LOCAL_CHAIN = CHAIN_ID === 31337;
export const USING_LOCAL_API_HOST = API_HOST === "127.0.0.1" || API_HOST === "localhost" || API_HOST === "::1";

/**
 * Does this process actually look like a developer laptop?
 *
 * A loopback bind alone does NOT mean local: the standard hosted shape is a
 * reverse proxy on :443 forwarding to 127.0.0.1:3000, so `API_HOST` says
 * nothing about who can reach the port. Anything that relaxes a control for
 * "local dev" — simulated deposits, auto-KYC, internal error text — has to see
 * the whole picture agree: loopback API, local RPC, and the hardhat chain id.
 * A hosted deploy pointed at a testnet then cannot inherit a dev-only default
 * by forgetting to set NODE_ENV.
 */
export const LOOKS_LOCAL = USING_LOCAL_API_HOST && USING_LOCAL_RPC && IS_LOCAL_CHAIN;
const LOOKS_HOSTED = Boolean(PUBLIC_URL) || !LOOKS_LOCAL;

/**
 * Monerium integration — PRODUCTION by default (api.monerium.app). There is no
 * mock mode any more: every account is a real Monerium account, connected
 * either by OAuth (the user signs up / signs in at Monerium) or by the user's
 * own API keys. The app's client credentials, when set, only re-read webhook
 * orders and reconcile; they never provision profiles for users.
 * Point MONERIUM_BASE_URL at https://api.monerium.dev for the sandbox.
 */
const MONERIUM_BASE_URL = process.env.MONERIUM_BASE_URL ?? "https://api.monerium.app";
export const MONERIUM = {
  clientId: process.env.MONERIUM_CLIENT_ID ?? "",
  clientSecret: process.env.MONERIUM_CLIENT_SECRET ?? "",
  oauthClientId: process.env.MONERIUM_OAUTH_CLIENT_ID ?? process.env.MONERIUM_CLIENT_ID ?? "",
  baseUrl: MONERIUM_BASE_URL,
  // Chain identifier Monerium should associate linked addresses with. Their
  // production names are ethereum/gnosis/polygon/base/arbitrum/linea; the
  // sandbox uses testnet names (basesepolia, sepolia, ...).
  chain: process.env.MONERIUM_CHAIN ?? "base",
  // Optional: pin a profile id instead of creating/discovering one.
  profileId: process.env.MONERIUM_PROFILE_ID ?? "",
  // How often to poll for incoming EURe issue orders (webhooks need a public
  // URL; polling works for local dev).
  pollMs: Number(process.env.MONERIUM_POLL_MS ?? 15_000),
  // User-owned account connect (Authorization Code + PKCE). Redirect URI must
  // exactly match the OAuth app registration.
  authUrl: process.env.MONERIUM_AUTH_URL ?? `${MONERIUM_BASE_URL}/auth`,
  redirectUri:
    process.env.MONERIUM_REDIRECT_URI ??
    `http://${API_HOST}:${API_PORT}/api/monerium/oauth/callback`,
  tokenEncryptionKey: process.env.MONERIUM_TOKEN_ENCRYPTION_KEY ?? "",
};

export const moneriumSandboxEnabled = () =>
  Boolean(MONERIUM.clientId && MONERIUM.clientSecret);

export const moneriumOAuthEnabled = () => Boolean(MONERIUM.oauthClientId);

/**
 * THE ONE HARNESS SEAM. scripts/_local-chain.ts sets LOCAL_HARNESS=1 for every
 * test suite, and it is honoured ONLY on the hardhat chain (31337) outside
 * production: that chain has no Monerium, no ERC-4337 bundler and no anchor,
 * so the suites need fake Safe ceremonies, a fake UserOperation hash, a
 * locally minted EURe for a mirrored deposit, and up-front account approval.
 * On every real-money chain the flag is inert by construction (the chain id
 * test cannot be configured away), and production refuses to start with it.
 * This replaces the old ALLOW_SIMULATION, which also opened product routes
 * (simulated deposits, self-approval, mock payouts) — those are gone.
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
   * HARNESS ONLY. The local hardhat chain (31337) has no Monerium, so the test
   * suites approve accounts up front with KYC_AUTO_APPROVE=1. The flag is
   * ignored on every other chain — there is no auto-approval on a chain where
   * money is real — and refused outright in production mode below.
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
  managedKycGuardian: process.env.RECOVERY_MANAGED_KYC_GUARDIAN !== "0",
  delayHours: Math.max(1, Number(process.env.RECOVERY_DELAY_HOURS ?? 72)),
  requestTtlHours: Math.max(1, Number(process.env.RECOVERY_REQUEST_TTL_HOURS ?? 24 * 14)),
  guardianSignerUrl: process.env.RECOVERY_GUARDIAN_SIGNER_URL ?? "",
  guardianSignerToken: process.env.RECOVERY_GUARDIAN_SIGNER_TOKEN ?? "",
  guardianSignerTimeoutMs: Math.max(1000, Number(process.env.RECOVERY_GUARDIAN_SIGNER_TIMEOUT_MS ?? 10_000)),
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
};

/**
 * The 3-minute SocialRecoveryModule is a TEST FIXTURE: it exists so a
 * recovery can be exercised end to end without waiting three days, and it
 * is the only variant deployed on Base Sepolia. On a chain where money is
 * real, a 3-minute grace period gives the owner no window to cancel a
 * hijacked recovery. Refuse to boot with it in production.
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
 * Bridge.xyz orchestration — the cash rail's exit to Stellar.
 *
 * Without BRIDGE_LIVE=1 the cash rail is CLOSED (no dry-run, no local escrow);
 * BRIDGE_LIVE=1 calls Bridge's Transfer API and waits for the
 * user/orchestrator-side deposit to fund it.
 */
export const BRIDGE = {
  live: process.env.BRIDGE_LIVE === "1",
  apiKey: process.env.BRIDGE_API_KEY ?? "",
  baseUrl: process.env.BRIDGE_BASE_URL ?? "https://api.bridge.xyz",
  onBehalfOf: process.env.BRIDGE_ON_BEHALF_OF ?? "",
  sourceRail: process.env.BRIDGE_SOURCE_RAIL ?? "base",
  destinationRail: process.env.BRIDGE_DESTINATION_RAIL ?? "stellar",
  destinationCurrency: process.env.BRIDGE_DESTINATION_CURRENCY ?? "usdc",
  destinationAddress: process.env.BRIDGE_DESTINATION_ADDRESS ?? "",
  destinationMemo: process.env.BRIDGE_DESTINATION_MEMO ?? "",
};

const configuredAnchorDomain = process.env.MG_ANCHOR_DOMAIN ?? "";
const configuredAnchorAsset = process.env.MG_ANCHOR_ASSET?.trim();

function isMoneyGramAnchorDomain(domain: string): boolean {
  return /(^|\.)moneygram\.com$/i.test(domain.trim());
}

function defaultAnchorAsset(domain: string): string {
  return isMoneyGramAnchorDomain(domain) ? "USDC" : "SRT";
}

const anchorAsset = configuredAnchorAsset || defaultAnchorAsset(configuredAnchorDomain);
if (isMoneyGramAnchorDomain(configuredAnchorDomain) && anchorAsset !== "USDC") {
  throw new Error(
    `MG_ANCHOR_ASSET=${anchorAsset} is incompatible with MoneyGram anchor ${configuredAnchorDomain}; use USDC`,
  );
}

export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const STELLAR_PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Stellar treasury + MoneyGram-style anchor (SEP-10/SEP-24). */
export const STELLAR = {
  // Public network by default. The Stellar testnet (horizon-testnet, the test
  // passphrase, friendbot) is opt-in for the anchor harnesses.
  horizon: process.env.STELLAR_HORIZON ?? "https://horizon.stellar.org",
  networkPassphrase: process.env.STELLAR_PASSPHRASE ?? STELLAR_PUBLIC_PASSPHRASE,
  friendbot: process.env.STELLAR_FRIENDBOT ?? "",
  // Anchor home domain for SEP-10/24. Stellar's public test anchor works
  // without any signup; MoneyGram production is the same protocol at their
  // domain with a partner-onboarded account.
  anchorDomain: configuredAnchorDomain,
  anchorAsset,
  // MoneyGram production may require SEP-10 custodial auth to include a
  // positive integer memo identifying the end user behind a shared account.
  authMemo: process.env.MG_AUTH_MEMO ?? "",
  clientDomain: process.env.MG_CLIENT_DOMAIN ?? "",
  clientDomainSigningSecret: process.env.MG_CLIENT_DOMAIN_SIGNING_SECRET ?? "",
  treasurySecret: process.env.STELLAR_TREASURY_SECRET ?? "",
};

export const anchorModeEnabled = () => Boolean(STELLAR.anchorDomain);

/**
 * Custody posture — whether the orchestrator is ever allowed to hold a user's
 * input funds.
 *
 * WHY THIS IS ITS OWN BLOCK. "We never take custody" is a claim with
 * regulatory weight (it is roughly the difference between a technical service
 * provider and a payment/crypto-asset service performed on a client's behalf).
 * Left implicit it is an emergent property of three unrelated settings —
 * which venue is configured, whether Bridge is live, and whether a venue call
 * happens to succeed — and a property nobody asserts and nothing records is
 * a coincidence that held last time somebody looked.
 *
 * So: every transfer RECORDS the custody mode it actually ran in
 * (`transfer.custody`), and `requireNonCustodial` turns the preference into a
 * refusal.
 *
 * WHY THE REFUSAL IS NOT ON BY DEFAULT, deliberately: with BRIDGE_LIVE unset
 * there is no external deposit address for a batch to deliver into, so the
 * output has nowhere to go but the orchestrator. Defaulting the refusal on
 * would brick every testnet deployment, including Base Sepolia. The DEFAULT
 * PATH is non-custodial; the
 * GUARANTEE is opt-in, and a deployment moving real money should set it.
 */
export const CUSTODY = {
  /** Refuse to create a transfer that would route the user's funds through the
   *  orchestrator, instead of silently falling back to it. */
  requireNonCustodial: process.env.REQUIRE_NON_CUSTODIAL === "1",
} as const;

/** FP1/FP2 security posture (red-team fixes). */
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
  /** Maximum JSON request body accepted by the API. */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? "64kb",
  /** Opaque bearer session lifetime. Default: 24 hours. */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 24 * 60 * 60 * 1000),
  /** Keep provider/chain internals out of hosted API responses — same
   *  local-only test as the simulation switch, for the same reason. */
  exposeInternalErrors: process.env.NODE_ENV !== "production" && LOOKS_LOCAL,
};

function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function requireExplicitHttpsUrl(name: string, value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (u.protocol !== "https:") throw new Error(`${name} must use https in production`);
  if (isLoopbackUrl(value)) throw new Error(`${name} must not point at localhost in production`);
}

function validateMoneriumWebhookSecret(value: string) {
  if (!value.startsWith("whsec_")) {
    throw new Error("MONERIUM_WEBHOOK_SECRET must use Monerium's whsec_ format");
  }
  const raw = value.slice("whsec_".length);
  if (Buffer.from(raw, "base64").length < 24) {
    throw new Error("MONERIUM_WEBHOOK_SECRET decodes to a weak key (need at least 24 bytes)");
  }
}

function assertProductionConfig() {
  if (!IS_PRODUCTION) return;
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  if (!KYC.operatorToken) fail("KYC_OPERATOR_TOKEN is required in production");
  if (process.env.KYC_AUTO_APPROVE === "1") fail("KYC_AUTO_APPROVE=1 is forbidden in production");
  if (process.env.LOCAL_HARNESS === "1") fail("LOCAL_HARNESS=1 is forbidden in production");
  for (const dead of ["ALLOW_SIMULATION", "ALLOW_MOCK_FALLBACK", "TESTNET_FAUCET_EUR", "KYC_PROVIDER", "SUMSUB_APP_TOKEN"]) {
    if (process.env[dead]) fail(`${dead} no longer exists — the mock, simulation, faucet and Sumsub paths were removed; unset it`);
  }
  /**
   * Mainnet means mainnet everywhere. A production deployment pointed at the
   * Monerium sandbox, a testnet chain, or a Monerium chain name from the other
   * environment would link addresses on one network and read balances on
   * another, and every symptom would look like a bug elsewhere.
   */
  if (!IS_REAL_MONEY_CHAIN) fail(`TRANSF_CHAIN_ID=${CHAIN_ID} is not a mainnet chain (expected one of ${[...REAL_MONEY_CHAINS].join(", ")})`);
  if (MONERIUM.baseUrl !== "https://api.monerium.app") fail(`MONERIUM_BASE_URL must be https://api.monerium.app in production (got ${MONERIUM.baseUrl})`);
  if (!/^(ethereum|gnosis|polygon|base|arbitrum|linea)$/.test(MONERIUM.chain)) {
    fail(`MONERIUM_CHAIN=${MONERIUM.chain} is not a Monerium production chain name`);
  }
  if (!moneriumOAuthEnabled() && !MONERIUM.tokenEncryptionKey) {
    fail("no way for a user to connect Monerium: set MONERIUM_OAUTH_CLIENT_ID (sign in with Monerium) and/or MONERIUM_TOKEN_ENCRYPTION_KEY (own API keys)");
  }
  if (Number(process.env.LIFI_CHAIN_ID ?? CHAIN_ID) !== CHAIN_ID) fail("LIFI_CHAIN_ID must equal TRANSF_CHAIN_ID");
  if (process.env.ALLOW_PLAINTEXT_STORE !== "1") {
    fail("ALLOW_PLAINTEXT_STORE=1 is required to acknowledge the JSON file store is not production storage");
  }

  if (SECURITY.moneriumWebhookSecret) {
    try { validateMoneriumWebhookSecret(SECURITY.moneriumWebhookSecret); } catch (e: any) { fail(e.message); }
  }
  if (moneriumSandboxEnabled() && !SECURITY.moneriumWebhookSecret) {
    fail("MONERIUM_WEBHOOK_SECRET is required in production when Monerium credentials are configured");
  }
  if (moneriumOAuthEnabled() && !MONERIUM.tokenEncryptionKey) {
    fail("MONERIUM_TOKEN_ENCRYPTION_KEY is required in production when Monerium OAuth is configured");
  }
  if (moneriumSandboxEnabled() || PUBLIC_URL) {
    if (!process.env.MONERIUM_REDIRECT_URI && LOOKS_HOSTED) {
      fail("MONERIUM_REDIRECT_URI must be explicit for hosted production");
    }
    if (MONERIUM.redirectUri && LOOKS_HOSTED) {
      try { requireExplicitHttpsUrl("MONERIUM_REDIRECT_URI", MONERIUM.redirectUri); } catch (e: any) { fail(e.message); }
    }
  }
  if (MONERIUM.tokenEncryptionKey && MONERIUM.tokenEncryptionKey.length < 32) {
    fail("MONERIUM_TOKEN_ENCRYPTION_KEY must be at least 32 characters");
  }
  if (BRIDGE.live) {
    if (!BRIDGE.apiKey) fail("BRIDGE_API_KEY is required when BRIDGE_LIVE=1");
    if (!BRIDGE.onBehalfOf) fail("BRIDGE_ON_BEHALF_OF is required when BRIDGE_LIVE=1");
  }
  /**
   * The app chain and the smart-account chain must agree in production.
   *
   * isDeployed() always asks CANDIDE_RPC_URL, so a mismatch means passkey Safes
   * deploy on one chain while balances, contracts and provisioning read another.
   * Nothing throws — the two subsystems simply disagree about whether an account
   * exists, and onboarding refuses with a message about deployment that reads as
   * unrelated. Locally that is a survivable annoyance and only a warning; in
   * production it is never intentional.
   */
  {
    const candideChainId = Number(process.env.CANDIDE_CHAIN_ID ?? CHAIN_ID);
    if (candideChainId !== CHAIN_ID) {
      fail(
        `CANDIDE_CHAIN_ID (${candideChainId}) must match TRANSF_CHAIN_ID (${CHAIN_ID}) — ` +
          `passkey Safes would deploy on one chain while the app reads another`,
      );
    }
  }
  if (RECOVERY.managedKycGuardian && !RECOVERY.guardianSignerUrl) {
    fail("RECOVERY_GUARDIAN_SIGNER_URL is required in production when managed KYC recovery is enabled");
  }
  if ((process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ?? "").toLowerCase() === RECOVERY_MODULE_3_MINUTES.toLowerCase()) {
    fail("CANDIDE_RECOVERY_MODULE_ADDRESS is the 3-minute test module — use the 3/7/14-day module in production");
  }
  if (RECOVERY.serviceUrl) {
    try { requireExplicitHttpsUrl("RECOVERY_SERVICE_URL", RECOVERY.serviceUrl); } catch (e: any) { fail(e.message); }
  }
  if (RECOVERY.guardianSignerUrl) {
    try { requireExplicitHttpsUrl("RECOVERY_GUARDIAN_SIGNER_URL", RECOVERY.guardianSignerUrl); } catch (e: any) { fail(e.message); }
    if (!RECOVERY.guardianSignerToken) {
      fail("RECOVERY_GUARDIAN_SIGNER_TOKEN is required when RECOVERY_GUARDIAN_SIGNER_URL is configured");
    }
  }
  if (anchorModeEnabled() && STELLAR.networkPassphrase === STELLAR_TESTNET_PASSPHRASE) {
    fail("production anchor mode must not use the Stellar testnet passphrase");
  }
  if (isMoneyGramAnchorDomain(STELLAR.anchorDomain)) {
    if (!STELLAR.authMemo) fail("MG_AUTH_MEMO is required for production MoneyGram custodial auth");
    if (!STELLAR.clientDomain) fail("MG_CLIENT_DOMAIN is required for production MoneyGram client attribution");
    if (!STELLAR.clientDomainSigningSecret) {
      fail("MG_CLIENT_DOMAIN_SIGNING_SECRET is required for production MoneyGram client attribution");
    }
    if (!STELLAR.treasurySecret) fail("STELLAR_TREASURY_SECRET is required for production MoneyGram anchor mode");
  }

  if (LOOKS_HOSTED) {
    if (LOOKS_LOCAL) fail("hosted production must not look like the local hardhat stack");
    if (!process.env.WEBAUTHN_ORIGINS) fail("WEBAUTHN_ORIGINS must be explicit in hosted production");
    for (const origin of SECURITY.origins) {
      if (isLoopbackUrl(origin)) fail(`WEBAUTHN_ORIGINS contains localhost origin ${origin}`);
      try { requireExplicitHttpsUrl("WEBAUTHN_ORIGINS entry", origin); } catch (e: any) { fail(e.message); }
    }
    if (!process.env.TRUSTED_PROXY_HOPS) {
      fail("TRUSTED_PROXY_HOPS must be explicit for hosted production");
    }
    if (!process.env.CANDIDE_COSIGNER_ADDRESS || !process.env.CANDIDE_COSIGNER_KEY) {
      fail("CANDIDE_COSIGNER_ADDRESS and CANDIDE_COSIGNER_KEY are required before hosted production funding");
    }
    // A standing allowance is deliberately NOT required. Spend authority is
    // granted per transfer for the exact debit amount, approved by the user's
    // passkey at send time — zero standing allowance is the designed resting
    // state.
    if (!process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS) {
      fail("CANDIDE_RECOVERY_GUARDIAN_ADDRESS is required before hosted production funding");
    }
  }

  if (problems.length) {
    throw new Error(`production configuration is incomplete:\n- ${problems.join("\n- ")}`);
  }
}

assertProductionConfig();

// Hardhat's well-known dev accounts — public knowledge, fine on 31337 only.
const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

/**
 * The keys this server signs with, from the environment.
 *
 * The operator roles can move test liquidity, submit payout steps, and
 * perform administrative actions. Hardhat's public development keys must
 * never hold those powers on a public chain, so off a local RPC they are
 * refused unless explicitly allowed.
 *
 * Accepts ORCHESTRATOR_KEY / RAMP_KEY / DEPLOYER_KEY, falling back to the
 * DEPLOY_*_KEY names so one .env serves both the deploy and the server.
 */
function operatorKey(role: "deployer" | "orchestrator" | "ramp"): `0x${string}` {
  const upper = role.toUpperCase();
  const fromEnv = process.env[`${upper}_KEY`] ?? process.env[`DEPLOY_${upper}_KEY`];
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(`${upper}_KEY is not a 32-byte hex private key`);
    }
    return fromEnv as `0x${string}`;
  }
  if (!USING_LOCAL_RPC && process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC !== "1") {
    throw new Error(
      `refusing to hold the ${role} role with hardhat's public development key on ${RPC_URL} — ` +
        `set ${upper}_KEY (or DEPLOY_${upper}_KEY) to a key this deployment actually controls`,
    );
  }
  return DEV_KEYS[role];
}

export const KEYS = {
  deployer: operatorKey("deployer"),
  orchestrator: operatorKey("orchestrator"),
  ramp: operatorKey("ramp"),
} as const;

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
export const FORWARDING = {
  rpcUrl: process.env.CANDIDE_FORWARDING_RPC_URL ?? process.env.FORWARDING_ADDRESS_RPC_URL ?? "",
  accountApiKey: process.env.CANDIDE_FORWARDING_ACCOUNT_API_KEY ?? "",
  sourceChainIds: parseChainIds(process.env.CANDIDE_FORWARDING_SOURCE_CHAIN_IDS),
  custodialWithdrawer: (process.env.CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER ?? "") as `0x${string}` | "",
  recoveryConfigured: evmAddressRe.test(process.env.CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER ?? ""),
};

/**
 * Gnosis Pay — permissionless card integration.
 *
 * NO API KEY EXISTS for permissionless mode: the user signs in with SIWE and
 * Gnosis Pay returns a JWT scoped to them. So there is nothing to gate on, and
 * unlike every other partner here this one is configured by default — the
 * honest default is the real base URL, because a blank one would make the
 * feature look unavailable when it is simply unconfigured for no reason.
 *
 * `partnerId` is deliberately optional and unset. It belongs to partner mode,
 * which brings webhooks and card-activity attribution and which we do not
 * have; sending one we were not issued would be claiming a relationship that
 * does not exist.
 *
 * siweChainId is 100 (Gnosis Chain) and is NOT derived from CHAIN_ID. Gnosis
 * Pay's account lives on their chain regardless of where Zold runs, and
 * deriving it would silently produce a message they reject.
 */
export const GNOSIS_PAY = {
  baseUrl: process.env.GNOSIS_PAY_BASE_URL ?? "https://api.gnosispay.com",
  siweChainId: Number(process.env.GNOSIS_PAY_SIWE_CHAIN_ID ?? 100),
  jwtTtlSeconds: Number(process.env.GNOSIS_PAY_JWT_TTL_SECONDS ?? 3600),
  timeoutMs: Number(process.env.GNOSIS_PAY_TIMEOUT_MS ?? 12_000),
  partnerId: process.env.GNOSIS_PAY_PARTNER_ID ?? "",
} as const;

export interface Deployments {
  eure: `0x${string}`;
  usdc: `0x${string}`;
  /** Local-only: the FxSwapper venue and the AdminTimelock that owns it. A
   *  real chain's entry carries the two token addresses and nothing else. */
  timelock?: `0x${string}`;
  swapper?: `0x${string}`;
  /** Present in older entries, never read. */
  bridge?: `0x${string}`;
}

/**
 * Contract addresses, keyed by chain id, so `npm run dev` and a testnet stack
 * can coexist and a stale file cannot point the app at addresses on the wrong
 * chain. Flat single-chain files are still read, treated as the local chain.
 */
export function loadDeployments(chainId: number = CHAIN_ID): Deployments {
  const p = path.join(ROOT, "deployments.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  // Flat single-chain shape: addresses at the top level.
  if (typeof raw.swapper === "string") {
    if (chainId !== 31337) {
      throw new Error(
        `deployments.json is in the old single-chain format and has no entry for chain ${chainId} — ` +
          `re-run the deploy for this chain`,
      );
    }
    const { vault: _unused, ...rest } = raw; // older files carry a vault address; nothing reads it
    return rest as Deployments;
  }
  const forChain = raw[String(chainId)];
  if (!forChain) {
    throw new Error(
      `deployments.json has no addresses for chain ${chainId} (has: ${Object.keys(raw).join(", ") || "none"}) — ` +
        `run the deploy against that chain first`,
    );
  }
  return forChain as Deployments;
}

/** Merge a fresh deployment into the per-chain file, leaving other chains alone. */
export function saveDeployments(chainId: number, addresses: Deployments) {
  const p = path.join(ROOT, "deployments.json");
  let raw: Record<string, unknown> = {};
  try {
    const existing = JSON.parse(readFileSync(p, "utf8"));
    // Migrate a flat single-chain file into its chain slot rather than dropping it.
    raw = typeof existing.swapper === "string" ? { "31337": existing } : existing;
  } catch {
    raw = {};
  }
  raw[String(chainId)] = addresses;
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
}

export function loadAbi(contract: string): any[] {
  const p = path.join(
    ROOT,
    "contracts/artifacts/contracts/src",
    `${contract}.sol`,
    `${contract}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

/**
 * Where the EURe<->USDC leg gets its liquidity.
 *
 * "fx-swapper" is the local mock: our own inventory at an owner-set rate, fine
 * for demos and the only thing that works on hardhat. "rfq" is just-in-time
 * liquidity from a market maker (Bebop), where the price is an executable
 * quote rather than a number we chose — which is the point, because a rate you
 * cannot actually trade at is a promise you cannot keep.
 *
 * BEBOP_API_KEY is effectively required on the chains that matter: ethereum
 * and arbitrum answer every unauthenticated request with UnknownError (tested
 * with a USDC->WETH control), and EURe is TokenNotSupported on the chains the
 * public endpoint does serve. Request access via Bebop's contact form and set
 * BEBOP_CHAIN=ethereum before adding rfq to the venue list.
 */
export const LIQUIDITY = {
  /**
   * THE DEFAULT IS A CUSTODY DECISION, not a pricing one.
   *
   * Only venues that implement `safeSwapPlan` can be executed BY THE USER'S
   * SAFE — the batch that approves the venue and delivers the output straight
   * to the payout destination, so the orchestrator never holds the input.
   * FxSwapper cannot (its inventory is `onlyTrader`) and CoW refuses, so a
   * deployment on either falls back to debiting the full amount to the
   * orchestrator's own address and swapping from there.
   *
   * Defaulting to that fallback would take possession of every cash-rail
   * transfer unless an operator knew to change one env var. `best` (over
   * LIQUIDITY_VENUES, itself defaulting to lifi,dex — both Safe-executable)
   * is the default, so the non-custodial path is what runs unless someone
   * opts out.
   *
   * Local hardhat has neither LI.FI nor a seeded pool, so `_local-chain.ts`
   * pins fx-swapper explicitly for dev and the harnesses. That is the right
   * shape: the weaker mode is opted INTO by the local demo rather than
   * inherited by production.
   */
  PROVIDER: (process.env.LIQUIDITY_PROVIDER ?? "best") as "fx-swapper" | "rfq" | "cow" | "dex" | "lifi" | "best",
  // Bebop's chain slug, e.g. "polygon", "base", "ethereum".
  BEBOP_CHAIN: process.env.BEBOP_CHAIN ?? "polygon",
  BEBOP_BASE_URL: process.env.BEBOP_BASE_URL ?? "https://api.bebop.xyz",
  BEBOP_API_KEY: process.env.BEBOP_API_KEY ?? "",
  BEBOP_TIMEOUT_MS: Number(process.env.BEBOP_TIMEOUT_MS ?? 8_000),
  /** Nominal EURe size used to probe an indicative rate for receipts. */
  PROBE_EUR: Number(process.env.LIQUIDITY_PROBE_EUR ?? 100),
  /** How long an indicative (display-only) rate may be reused. */
  INDICATIVE_TTL_MS: Number(process.env.LIQUIDITY_INDICATIVE_TTL_MS ?? 60_000),
  /**
   * CoW Protocol. Intent-based rather than RFQ: you sign an order and solvers
   * compete to fill it, so no inventory is carried on either side — which is
   * the reason it is here. Unlike Bebop it actually lists EURe, and it accepts
   * EIP-1271, so a Safe can sign the order itself.
   *
   * The API is per-network: "xdai" is Gnosis, where EURe liquidity is deepest
   * because Monerium is Gnosis-native.
   */
  COW_BASE_URL: process.env.COW_BASE_URL ?? "https://api.cow.fi",
  COW_NETWORK: process.env.COW_NETWORK ?? "xdai",
  COW_TIMEOUT_MS: Number(process.env.COW_TIMEOUT_MS ?? 15_000),
  /**
   * Uniswap v3, on-chain. The v3 interface is identical on Base Sepolia and
   * Base mainnet, so the path tested on the testnet is the path that ships.
   *
   * Defaults are the Base MAINNET deployments, verified with eth_getCode and
   * a chainId read against mainnet.base.org (Sep 2026), not copied from a docs
   * page: UniswapV3Factory, SwapRouter02, QuoterV2. Override per chain
   * (Base Sepolia: 0x4752ba5D… / 0x94cC0AaC… / 0xC5290058…).
   */
  DEX_FACTORY: (process.env.DEX_FACTORY ?? "0x33128a8fC17869897dcE68Ed026d694621f6FDfD") as `0x${string}`,
  DEX_ROUTER: (process.env.DEX_ROUTER ?? "0x2626664c2603336E57B271c5C0b26F421741e481") as `0x${string}`,
  DEX_QUOTER: (process.env.DEX_QUOTER ?? "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a") as `0x${string}`,
  /** Fee tiers probed, cheapest first. The deepest pool wins, not the first. */
  DEX_FEE_TIERS: (process.env.DEX_FEE_TIERS ?? "100,500,3000,10000")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
  /** Slippage floor written into the swap call as amountOutMinimum. */
  DEX_SLIPPAGE_BPS: BigInt(process.env.DEX_SLIPPAGE_BPS ?? 50),
  /**
   * How far the pool's implied EUR/USD may sit from the independent live mid
   * before we refuse to trade.
   *
   * This guard is the difference between a pool and a market maker. An RFQ
   * maker quotes a price it is willing to honour; an AMM pool is simply
   * whatever the last trade left behind, and anyone with capital can move a
   * thin one. Without this a skewed pool would let us settle a real transfer
   * at a garbage rate and report it as a market price.
   */
  DEX_MAX_MID_DEVIATION_BPS: BigInt(process.env.DEX_MAX_MID_DEVIATION_BPS ?? 300),
  /**
   * LI.FI — the production venue.
   *
   * Tested, not assumed: EURe->USDC quotes executable on Gnosis (1.1493), Base
   * (1.1506) and Polygon (1.1491) against a live mid of ~1.1511, routed through
   * Nordstern Finance / Fly / Bitget — venues a hand-rolled Uniswap adapter
   * would never see. That routing breadth is the whole argument for an
   * aggregator over a single pool.
   *
   * It CANNOT be exercised on a testnet: it lists Base Sepolia but answers
   * "No available quotes" even for WETH/USDC, which has real Uniswap depth
   * there. So `dex` stays as the locally-provable path and this is the one that
   * ships. Keep both.
   */
  LIFI_BASE_URL: process.env.LIFI_BASE_URL ?? "https://li.quest",
  LIFI_API_KEY: process.env.LIFI_API_KEY ?? "",
  LIFI_TIMEOUT_MS: Number(process.env.LIFI_TIMEOUT_MS ?? 15_000),
  /** Fraction, LI.FI's own units: 0.005 = 50bps. */
  LIFI_SLIPPAGE: Number(process.env.LIFI_SLIPPAGE ?? 0.005),
  /** Chain to route on. The app chain; EURe exists on 1/100/137/8453/42161/59144. */
  LIFI_CHAIN_ID: Number(process.env.LIFI_CHAIN_ID ?? CHAIN_ID),

  /**
   * Best execution. With more than one venue wired, picking one by config means
   * quietly settling at a worse price whenever the other is better — and having
   * an aggregator alongside a single-pool adapter makes that likely rather than
   * theoretical. `best` quotes every venue below in parallel and takes the
   * largest out for the same in.
   */
  VENUES: (process.env.LIQUIDITY_VENUES ?? "lifi,dex")
    .split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * Who keeps positive slippage — the difference between what a venue quoted
   * and what it actually delivered.
   *
   * Default "user", and that default is load-bearing. The receipt reports
   * marginBps MEASURED between the live mid and what we deliver; silently
   * pocketing surplus would make that number understate what we take, which is
   * the exact dishonesty the live-rates work existed to remove. "treasury" is
   * available but records the amount on the transfer so it stays visible and
   * can be reflected in the margin rather than hidden in it.
   */
  SURPLUS_POLICY: (process.env.LIQUIDITY_SURPLUS_POLICY ?? "user") as "user" | "treasury",
};

// Live mid-rate feed. Defaults to a free, key-less provider that publishes all
// three currencies we need against EUR. See rates.ts for why there is no stale
// fallback.
export const RATES = {
  URL: process.env.TRANSF_RATES_URL ?? "https://open.er-api.com/v6/latest/EUR",
  TTL_MS: Number(process.env.TRANSF_RATES_TTL_MS ?? 10 * 60 * 1000),
  TIMEOUT_MS: Number(process.env.TRANSF_RATES_TIMEOUT_MS ?? 8_000),
};

/**
 * Crypto in: USDC arriving at a payment-page deposit address, settled for the
 * owning account.
 *
 * Per-page opt-in (`User.paymentPage.autoConvert`) decides WHO is watched;
 * these settings decide how. The kill switch exists because this path can
 * credit e-money off an on-chain event, so an operator needs to be able to stop
 * it without a deploy.
 */
export const CRYPTO_IN = {
  enabled: process.env.CRYPTO_IN_ENABLED !== "0",
  pollMs: Number(process.env.CRYPTO_IN_POLL_MS ?? 15_000),
  /**
   * Below this, converting costs more than it delivers — a dust transfer would
   * be eaten by the swap and leave the user with a confusing €0.00 credit. Left
   * in place and recorded rather than converted.
   */
  minUsdc: Number(process.env.CRYPTO_IN_MIN_USDC ?? 1),
  /**
   * How far the venue's rate may sit from the live mid before we refuse.
   *
   * This is the same discipline as FP5's quote binding, for the same reason:
   * the FxSwapper's rate is one WE set, so without an independent check we
   * could credit e-money at a price no market would give — the exact failure
   * the live-rates work existed to end.
   */
  maxDriftBps: Number(process.env.CRYPTO_IN_MAX_DRIFT_BPS ?? 100),
  /**
   * Blocks to wait before treating a deposit as real. A reorg that unwinds the
   * incoming transfer after we have settled it leaves a false receipt. Zero on
   * hardhat, where a mined block is final and waiting would just hang the tests.
   */
  confirmations: Number(process.env.CRYPTO_IN_CONFIRMATIONS ?? (IS_LOCAL_CHAIN ? 0 : 2)),
  /** Cap on a single getLogs span, so a long outage cannot ask an RPC for a
   *  range it will refuse. The cursor catches up over several ticks instead. */
  maxBlockSpan: BigInt(process.env.CRYPTO_IN_MAX_BLOCK_SPAN ?? 5_000),
};


// FX configuration for the launch corridor (EUR -> KES cash pickup).
//
// Mid rates are NOT here — they come live from rates.ts, because a hardcoded
// constant goes stale silently while the receipt keeps claiming a margin over
// "the real exchange rate". EUR->USD is absent for the same reason: that leg
// is whatever the liquidity venue will really execute at, read in fx.ts. What
// stays here is our own pricing, which is genuinely ours to set.
export const FX = {
  SPREAD_BPS: 50, // our FX spread
  FIXED_FEE_EUR: 0.99,
  QUOTE_TTL_MS: 10 * 60 * 1000,
  DAILY_CAP_EUR: 2500,
  // FP5: max on-chain rate drift between quote and execution before the
  // transfer is rejected and refunded (bps).
  QUOTE_BINDING_BPS: 50,
};

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
