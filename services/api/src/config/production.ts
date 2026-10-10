/**
 * Production refuses to start on an incomplete or test configuration.
 *
 * Imported by config.ts for its side effect, right after the values it checks
 * and before the signing keys are read. Every problem is collected, in the
 * order below, and reported in one error.
 */
import { CHAIN_ID, IS_PRODUCTION, IS_REAL_MONEY_CHAIN, LOOKS_LOCAL, PUBLIC_URL, REAL_MONEY_CHAINS } from "./env.js";
import { MONERIUM, moneriumOAuthEnabled, moneriumSandboxEnabled } from "./monerium.js";
import { dataKeyProblems } from "./data-keys.js";
import { KYC, RECOVERY, RECOVERY_MODULE_3_MINUTES, SECURITY } from "./security.js";
import { anchorModeEnabled, BRIDGE, isMoneyGramAnchorDomain, STELLAR, STELLAR_TESTNET_PASSPHRASE } from "./cash-rail.js";

const LOOKS_HOSTED = Boolean(PUBLIC_URL) || !LOOKS_LOCAL;

type Fail = (message: string) => void;

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

/** The operator path exists, and no test-only switch is set. */
function checkRuntimeFlags(fail: Fail) {
  if (!KYC.operatorToken) fail("KYC_OPERATOR_TOKEN is required in production");
  if (process.env.KYC_AUTO_APPROVE === "1") fail("KYC_AUTO_APPROVE=1 is forbidden in production");
  if (process.env.LOCAL_HARNESS === "1") fail("LOCAL_HARNESS=1 is forbidden in production");
  // The break-glass that lets an external RPC run on hardhat's public keys:
  // anyone can sign as those roles.
  if (process.env.ALLOW_DEV_KEYS_ON_EXTERNAL_RPC === "1") fail("ALLOW_DEV_KEYS_ON_EXTERNAL_RPC=1 is forbidden in production");
  for (const dead of ["ALLOW_SIMULATION", "ALLOW_MOCK_FALLBACK", "KYC_PROVIDER", "SUMSUB_APP_TOKEN"]) {
    if (process.env[dead]) fail(`${dead} no longer exists — the mock, simulation and Sumsub paths were removed; unset it`);
  }
  if (process.env.FAUCET_KEY || process.env.TESTNET_FAUCET_EUR || process.env.FAUCET_DRIPS) {
    fail("FAUCET_KEY / TESTNET_FAUCET_EUR / FAUCET_DRIPS are testnet-only and forbidden in production");
  }
}

/**
 * Mainnet means mainnet everywhere. A production deployment pointed at the
 * Monerium sandbox, a testnet chain, or a Monerium chain name from the other
 * environment would link addresses on one network and read balances on
 * another, and every symptom would look like a bug elsewhere.
 */
function checkMainnet(fail: Fail) {
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
}

/** Webhook secret, OAuth redirect and the key that encrypts users' tokens. */
function checkMoneriumSecrets(fail: Fail) {
  if (SECURITY.moneriumWebhookSecret) {
    try { validateMoneriumWebhookSecret(SECURITY.moneriumWebhookSecret); } catch (e: any) { fail(e.message); }
  }
  if (moneriumSandboxEnabled() && !SECURITY.moneriumWebhookSecret) {
    fail("MONERIUM_WEBHOOK_SECRET is required in production when Monerium credentials are configured");
  }
  if (moneriumOAuthEnabled() && !MONERIUM.tokenEncryptionKey) {
    fail("MONERIUM_TOKEN_ENCRYPTION_KEY is required in production when Monerium OAuth is configured");
  }
  if (moneriumSandboxEnabled() || moneriumOAuthEnabled() || PUBLIC_URL) {
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
}

/** The v2 key ring and the blind index key, when set, parse and differ. */
function checkDataKeys(fail: Fail) {
  for (const problem of dataKeyProblems()) fail(problem);
}

function checkBridge(fail: Fail) {
  if (!BRIDGE.live) return;
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
function checkSmartAccount(fail: Fail) {
  const candideChainId = Number(process.env.CANDIDE_CHAIN_ID ?? CHAIN_ID);
  if (candideChainId !== CHAIN_ID) {
    fail(
      `CANDIDE_CHAIN_ID (${candideChainId}) must match TRANSF_CHAIN_ID (${CHAIN_ID}) — ` +
        `passkey Safes would deploy on one chain while the app reads another`,
    );
  }
  if ((process.env.CANDIDE_RECOVERY_MODULE_ADDRESS ?? "").toLowerCase() === RECOVERY_MODULE_3_MINUTES.toLowerCase()) {
    fail("CANDIDE_RECOVERY_MODULE_ADDRESS is the 3-minute test module — use the 3/7/14-day module in production");
  }
  if (RECOVERY.serviceUrl) {
    try { requireExplicitHttpsUrl("RECOVERY_SERVICE_URL", RECOVERY.serviceUrl); } catch (e: any) { fail(e.message); }
  }
}

function checkAnchor(fail: Fail) {
  if (anchorModeEnabled() && STELLAR.networkPassphrase === STELLAR_TESTNET_PASSPHRASE) {
    fail("production anchor mode must not use the Stellar testnet passphrase");
  }
  if (!isMoneyGramAnchorDomain(STELLAR.anchorDomain)) return;
  if (!STELLAR.authMemo) fail("MG_AUTH_MEMO is required for production MoneyGram custodial auth");
  if (!STELLAR.clientDomain) fail("MG_CLIENT_DOMAIN is required for production MoneyGram client attribution");
  if (!STELLAR.clientDomainSigningSecret) {
    fail("MG_CLIENT_DOMAIN_SIGNING_SECRET is required for production MoneyGram client attribution");
  }
  if (!STELLAR.treasurySecret) fail("STELLAR_TREASURY_SECRET is required for production MoneyGram anchor mode");
}

/** Payment links, Shopify redirects and receipt links are absolute; in
 *  production only this says their origin, never the Host header. */
function checkPublicUrl(fail: Fail) {
  if (!PUBLIC_URL) {
    fail("TRANSF_PUBLIC_URL is required in production: absolute links are never built from the Host header");
    return;
  }
  try { requireExplicitHttpsUrl("TRANSF_PUBLIC_URL", PUBLIC_URL); } catch (e: any) { fail(e.message); }
}

function checkHosted(fail: Fail) {
  if (!LOOKS_HOSTED) return;
  if (LOOKS_LOCAL) fail("hosted production must not look like the local hardhat stack");
  if (!process.env.WEBAUTHN_ORIGINS) fail("WEBAUTHN_ORIGINS must be explicit in hosted production");
  for (const origin of SECURITY.origins) {
    if (isLoopbackUrl(origin)) fail(`WEBAUTHN_ORIGINS contains localhost origin ${origin}`);
    try { requireExplicitHttpsUrl("WEBAUTHN_ORIGINS entry", origin); } catch (e: any) { fail(e.message); }
  }
  if (!process.env.TRUSTED_PROXY_HOPS) {
    fail("TRUSTED_PROXY_HOPS must be explicit for hosted production");
  }
  // No co-signer is required: Safes are passkey-only (1-of-1).
  // No standing allowance is required either: the user's passkey approves
  // each transfer for its exact debit amount at send time.
  // Zoldenburg's guardian (the operator hardware wallet's address). Users
  // opt in to it; without it the onboarding offer has nothing to add.
  if (!process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS) {
    fail("CANDIDE_RECOVERY_GUARDIAN_ADDRESS is required before hosted production funding");
  }
}

function assertProductionConfig() {
  if (!IS_PRODUCTION) return;
  const problems: string[] = [];
  const fail: Fail = (message) => problems.push(message);
  for (const check of [checkRuntimeFlags, checkMainnet, checkMoneriumSecrets, checkDataKeys, checkBridge, checkSmartAccount, checkAnchor, checkHosted, checkPublicUrl]) {
    check(fail);
  }
  if (problems.length) {
    throw new Error(`production configuration is incomplete:\n- ${problems.join("\n- ")}`);
  }
}

assertProductionConfig();
