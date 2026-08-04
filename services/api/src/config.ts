import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");

// Load .env if present (Node 20.12+ built-in; no dotenv dependency).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — mock mode
}

export const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
export const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
export const API_HOST = process.env.TRANSF_API_HOST ?? "127.0.0.1";
export const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.TRANSF_PRODUCTION === "1";
export const PUBLIC_URL = process.env.TRANSF_PUBLIC_URL ?? "";

export const USING_LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(RPC_URL);

/**
 * Which chain we settle on.
 *
 * This used to be `hardhat` everywhere, hardcoded. That matters more than it
 * looks: RemitVault builds its EIP-712 domain from `block.chainid`, so a
 * server signing against 31337 while the contract lives on 80002 produces
 * signatures the vault rejects — every debit reverts with "bad authorization"
 * and the error points at the signing code, which is innocent. Deriving the id
 * from one place removes that whole class of confusion.
 *
 * 31337 = hardhat (default), 80002 = Polygon Amoy, 137 = Polygon mainnet.
 */
export const CHAIN_ID = Number(process.env.TRANSF_CHAIN_ID ?? 31337);
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
 * Monerium integration. Mock mode by default; sandbox mode activates when
 * client credentials are present (create an app at https://monerium.dev,
 * sandbox environment, and put the credentials in .env).
 */
export const MONERIUM = {
  clientId: process.env.MONERIUM_CLIENT_ID ?? "",
  clientSecret: process.env.MONERIUM_CLIENT_SECRET ?? "",
  baseUrl: process.env.MONERIUM_BASE_URL ?? "https://api.monerium.dev",
  // Chain identifier Monerium should associate linked addresses with.
  // The sandbox expects testnet names ("sepolia", ...); production uses
  // mainnet names ("ethereum", "gnosis", "polygon").
  chain: process.env.MONERIUM_CHAIN ?? "sepolia",
  // Optional: pin a profile id instead of creating/discovering one.
  profileId: process.env.MONERIUM_PROFILE_ID ?? "",
  // How often to poll for incoming EURe issue orders (webhooks need a public
  // URL; polling works for local dev).
  pollMs: Number(process.env.MONERIUM_POLL_MS ?? 15_000),
  // User-owned account connect (Authorization Code + PKCE). Redirect URI must
  // exactly match the OAuth app registration.
  authUrl: process.env.MONERIUM_AUTH_URL ?? `${process.env.MONERIUM_BASE_URL ?? "https://api.monerium.dev"}/auth`,
  redirectUri:
    process.env.MONERIUM_REDIRECT_URI ??
    `http://${API_HOST}:${API_PORT}/api/monerium/oauth/callback`,
  tokenEncryptionKey: process.env.MONERIUM_TOKEN_ENCRYPTION_KEY ?? "",
};

export const moneriumSandboxEnabled = () =>
  Boolean(MONERIUM.clientId && MONERIUM.clientSecret);

/**
 * KYC gate. Local demos auto-approve by default so existing self-contained
 * tests keep running. Production and KYC_AUTO_APPROVE=0 start users in
 * `pending`; an external provider integration should call the review seam.
 */
export const KYC = {
  autoApprove:
    process.env.KYC_AUTO_APPROVE === "1" ||
    (process.env.KYC_AUTO_APPROVE !== "0" && process.env.NODE_ENV !== "production" && LOOKS_LOCAL),
  /**
   * Shared secret an operator (or a KYC provider's webhook) presents to record
   * a decision. This is the ONLY approval path that survives production: the
   * mock-review endpoint is gated on ALLOW_SIMULATION, and turning that on to
   * approve a user would also re-open simulated deposits and cash pickup.
   *
   * Unset means no operator path at all — fail closed rather than leave an
   * unauthenticated admin endpoint exposed.
   */
  operatorToken: process.env.KYC_OPERATOR_TOKEN ?? "",
};

// A guessable operator token is worse than none: it is a remote approval
// switch for every account. Refuse to start rather than serve one.
if (KYC.operatorToken && KYC.operatorToken.length < 24) {
  throw new Error(
    "KYC_OPERATOR_TOKEN is too short (need >= 24 chars) — generate one with `openssl rand -base64 32`",
  );
}

/**
 * CCTP bridge (Base Sepolia -> Stellar testnet). Dry-run by default: the
 * worker builds and logs the exact transactions; CCTP_LIVE=1 plus a funded
 * key executes them for real.
 */
export const CCTP = {
  live: process.env.CCTP_LIVE === "1",
  env: process.env.CCTP_ENV ?? "testnet",
  baseRpc: process.env.CCTP_BASE_RPC ?? "https://sepolia.base.org",
  // Circle CCTP V2 testnet deployments (Base Sepolia, domain 6).
  tokenMessenger: (process.env.CCTP_TOKEN_MESSENGER ??
    "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA") as `0x${string}`,
  messageTransmitter: (process.env.CCTP_MESSAGE_TRANSMITTER ??
    "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275") as `0x${string}`,
  usdc: (process.env.CCTP_USDC ??
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
  stellarDomain: 27,
  // Stellar testnet CCTP contracts (C-strkeys). All mints route through the
  // CctpForwarder: mintRecipient AND destinationCaller must be the forwarder.
  stellarForwarder:
    process.env.CCTP_STELLAR_FORWARDER ?? "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  stellarMessageTransmitter:
    process.env.CCTP_STELLAR_MSG_TRANSMITTER ?? "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
  irisBase: process.env.CCTP_IRIS_BASE ?? "https://iris-api-sandbox.circle.com",
  // Funded Base Sepolia EOA for live burns (never a hardhat dev key).
  burnerKey: (process.env.CCTP_BURNER_KEY ?? "") as `0x${string}` | "",
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
  horizon: process.env.STELLAR_HORIZON ?? "https://horizon-testnet.stellar.org",
  sorobanRpc: process.env.STELLAR_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.STELLAR_PASSPHRASE ?? STELLAR_TESTNET_PASSPHRASE,
  friendbot: process.env.STELLAR_FRIENDBOT ?? "https://friendbot.stellar.org",
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

/** FP1/FP2 security posture (red-team fixes). */
export const SECURITY = {
  /** Simulation endpoints (mock SEPA deposit, pickup, self-serve KYC review)
   *  are dev-only unless explicitly re-enabled. Gated on LOOKS_LOCAL rather
   *  than the API host alone: behind a reverse proxy the old test passed, which
   *  handed a hosted deploy free EURe and self-approved KYC. */
  allowSimulation:
    process.env.ALLOW_SIMULATION === "1" || (process.env.NODE_ENV !== "production" && LOOKS_LOCAL),
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
  /** When a real rail (anchor / Monerium sandbox) fails, fall back to a
   *  simulated payout only if explicitly allowed — otherwise fail closed. */
  allowMockFallback: process.env.ALLOW_MOCK_FALLBACK === "1",
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

  if (process.env.KYC_AUTO_APPROVE === "1") fail("KYC_AUTO_APPROVE=1 is forbidden in production");
  if (!KYC.operatorToken) fail("KYC_OPERATOR_TOKEN is required in production");
  if (process.env.ALLOW_SIMULATION === "1") fail("ALLOW_SIMULATION=1 is forbidden in production");
  if (process.env.ALLOW_MOCK_FALLBACK === "1") fail("ALLOW_MOCK_FALLBACK=1 is forbidden in production");
  if (process.env.ALLOW_PLAINTEXT_STORE !== "1") {
    fail("ALLOW_PLAINTEXT_STORE=1 is required to acknowledge the JSON file store is not production storage");
  }

  if (SECURITY.moneriumWebhookSecret) {
    try { validateMoneriumWebhookSecret(SECURITY.moneriumWebhookSecret); } catch (e: any) { fail(e.message); }
  }
  if (moneriumSandboxEnabled() && !SECURITY.moneriumWebhookSecret) {
    fail("MONERIUM_WEBHOOK_SECRET is required in production when Monerium credentials are configured");
  }
  if (moneriumSandboxEnabled() && !MONERIUM.tokenEncryptionKey) {
    fail("MONERIUM_TOKEN_ENCRYPTION_KEY is required in production when Monerium credentials are configured");
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
  if (CCTP.live) {
    fail("CCTP_LIVE=1 is a testnet burn/mint path and is forbidden in production");
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
    if (!process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS && !process.env.CANDIDE_COSIGNER_ADDRESS) {
      fail("CANDIDE_RECOVERY_GUARDIAN_ADDRESS or CANDIDE_COSIGNER_ADDRESS is required before hosted production funding");
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
 * deploy.ts has always been able to take real keys (DEPLOY_*_KEY) while the
 * server could not, so the only way to run against a testnet was to let the
 * hardhat development keys hold the privileged roles. That is not a smaller
 * version of the same risk: the ramp role may bind a payment authorizer to any
 * account that has not bound one yet (RemitVault.setAuthorizer), and the
 * orchestrator role submits debits — with published keys in both, anyone can
 * claim a new user's account before the user's own device does and spend its
 * balance. FP4 buys nothing in that configuration.
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

export interface Deployments {
  eure: `0x${string}`;
  timelock?: `0x${string}`;
  usdc: `0x${string}`;
  vault: `0x${string}`;
  swapper: `0x${string}`;
  bridge: `0x${string}`;
}

/**
 * Contract addresses, keyed by chain id.
 *
 * A single flat set meant deploying to a testnet overwrote the local one, so
 * `npm run dev` and a testnet stack could not coexist — and worse, a stale
 * file would silently point the app at addresses on the wrong chain. Legacy
 * flat files are still read, treated as the local chain.
 */
export function loadDeployments(chainId: number = CHAIN_ID): Deployments {
  const p = path.join(ROOT, "deployments.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  // Legacy shape: addresses at the top level, from before this was per-chain.
  if (typeof raw.vault === "string") {
    if (chainId !== 31337) {
      throw new Error(
        `deployments.json is in the old single-chain format and has no entry for chain ${chainId} — ` +
          `re-run the deploy for this chain`,
      );
    }
    return raw as Deployments;
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
    // Migrate a legacy flat file into its chain slot rather than dropping it.
    raw = typeof existing.vault === "string" ? { "31337": existing } : existing;
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
 * BEBOP_API_KEY is optional: Bebop's public RFQ endpoint works without one,
 * but a partner key gets better pricing and higher rate limits.
 */
export const LIQUIDITY = {
  PROVIDER: (process.env.LIQUIDITY_PROVIDER ?? "fx-swapper") as "fx-swapper" | "rfq" | "cow" | "dex",
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
   * Uniswap v3, on-chain. The only venue we can actually execute against on a
   * testnet: Bebop has no testnet at all and CoW has no Base Sepolia, so both
   * adapters can only ever be exercised with real money on a mainnet. The v3
   * interface is identical on Base Sepolia and Base mainnet, so the path we
   * test is the path that ships.
   *
   * Defaults are the verified Base Sepolia deployments (checked with
   * eth_getCode, not copied from a docs page). Override per chain.
   */
  DEX_FACTORY: (process.env.DEX_FACTORY ?? "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24") as `0x${string}`,
  DEX_ROUTER: (process.env.DEX_ROUTER ?? "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4") as `0x${string}`,
  DEX_QUOTER: (process.env.DEX_QUOTER ?? "0xC5290058841028F1614F3A6F0F5816cAd0df5E27") as `0x${string}`,
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
};

// Live mid-rate feed. Defaults to a free, key-less provider that publishes all
// three currencies we need against EUR. See rates.ts for why there is no stale
// fallback.
export const RATES = {
  URL: process.env.TRANSF_RATES_URL ?? "https://open.er-api.com/v6/latest/EUR",
  TTL_MS: Number(process.env.TRANSF_RATES_TTL_MS ?? 10 * 60 * 1000),
  TIMEOUT_MS: Number(process.env.TRANSF_RATES_TIMEOUT_MS ?? 8_000),
};

// FX configuration for the launch corridor (EUR -> KES cash pickup).
//
// The mid rates are NOT here any more — they come from rates.ts, because the
// constants that used to live here (EURUSD 1.08, USDINR 87.2, USDKES 129.5)
// silently went 5-14% stale while the receipt claimed a 0.50% margin over "the
// real exchange rate". What stays here is our own pricing, which is genuinely
// ours to set.
//
// EUR->USD is deliberately absent too: that leg is whatever the on-chain
// swapper will really execute at, read from the chain in fx.ts. It used to be
// hardcoded as 1.08 in THREE places (here twice, plus deploy.ts) with nothing
// keeping them equal, and FP5's binding check compared only two of them — so
// editing the quote's copy alone would have promised a rate the swap could not
// deliver, silently.
/**
 * Crypto in: USDC arriving at a user's account, converted to EURe.
 *
 * Per-user opt-in (`User.autoConvert`) decides WHO is watched; these settings
 * decide how. The kill switch exists because this path credits e-money off an
 * on-chain event, so an operator needs to be able to stop it without a deploy.
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
   * incoming transfer after we have credited EURe is an unbacked credit, and
   * the vault has no way to claw it back. Zero on hardhat, where a mined block
   * is final and waiting would just hang the tests.
   */
  confirmations: Number(process.env.CRYPTO_IN_CONFIRMATIONS ?? (IS_LOCAL_CHAIN ? 0 : 2)),
  /** Cap on a single getLogs span, so a long outage cannot ask an RPC for a
   *  range it will refuse. The cursor catches up over several ticks instead. */
  maxBlockSpan: BigInt(process.env.CRYPTO_IN_MAX_BLOCK_SPAN ?? 5_000),
};

export const FX = {
  SPREAD_BPS: 50, // our FX spread
  FIXED_FEE_EUR: 0.99,
  // UPI is a point-of-sale rail — small fixed fee, same spread.
  UPI_FIXED_FEE_EUR: 0.29,
  QUOTE_TTL_MS: 10 * 60 * 1000,
  DAILY_CAP_EUR: 2500, // mirrors RemitVault.dailyCap
  // FP5: max on-chain rate drift between quote and execution before the
  // transfer is rejected and refunded (bps).
  QUOTE_BINDING_BPS: 50,
};
