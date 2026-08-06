import express from "express";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { anchorModeEnabled, API_HOST, API_PORT, CHAIN_ID, CRYPTO_IN, FX, IS_PRODUCTION, KYC, MONERIUM, PRIVACY_BUNDLE, PUBLIC_URL, RECOVERY, SUMSUB, moneriumOAuthEnabled, moneriumSandboxEnabled, sumsubEnabled, SECURITY, STELLAR, TESTNET_FAUCET } from "./config.js";
import { countryBlock, normaliseCountryCode } from "./country-policy.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyAssertion, verifyAssertionForChallenge, verifyRegistration } from "./webauthn.js";
import { moneriumRedeemMessage, paymentMemo, SEPA_REMITTANCE_MAX } from "./sepa.js";
import { initStore, store, type CryptoDeposit, type ReceiptShare, type Transfer, type User } from "./store.js";
import {
  buildReceipt,
  DEFAULT_SHARE_FIELDS,
  parseShareFields,
  receiptSlug,
  SHARE_TTL_DAYS,
} from "./receipt.js";
import { createQuote, isExpired } from "./fx.js";
import { faucetFundSafe } from "./faucet.js";
import { issueIban, simulateSepaDeposit } from "./adapters/monerium.js";
import { activatePaymentForwarder } from "./adapters/candide-forwarder.js";
import {
  checkConnection,
  handleWebhookEvent,
  provisionFunding,
  refreshPendingIban,
  startDepositPoller,
} from "./adapters/monerium-sandbox.js";
import {
  dailyCapUsage,
  executeSepaTransfer,
  executeTransfer,
  refreshPayout,
  safeDebitBlocker,
  settlePickup,
  sweepAnchorPayouts,
  sweepStrandedTransfers,
} from "./orchestrator.js";
import { startCryptoDepositPoller } from "./adapters/crypto-deposits.js";
import { HandleError, normaliseDisplayName, normaliseHandle, publicPayee } from "./pay.js";
import { qrSvg } from "./qr.js";
import { senderProfileToSep9 } from "./adapters/moneygram.js";
import { toAlpha3 } from "./stellar/sep9.js";
import { getTreasury, missingRequiredFields, sep10Auth, sep12CustomerFields } from "./stellar/anchor.js";
import { formatReport, reconcile } from "./reconcile.js";
import {
  approveRecoveryRequest,
  assertRecoveryAvailable,
  buildRecoveryRequest,
  isEvmAddress,
  publicRecoveryRequest,
  readinessStatus,
} from "./recovery.js";
import { submitGuardianRecovery } from "./recovery-signer.js";
import {
  abis,
  addrs,
  accountBalances,
  deployerWallet,
  assertChainMatches,
  warnIfSmartAccountChainDiffers,
  destinationCommitment,
  eur,
  orchestratorAddress,
  paymentAuthorizationTypedData,
  publicClient,
  transferIdHash,
} from "./chain.js";
import {
  CANDIDE,
  isDeployed,
  preparePasskeySafeAllowanceSetup,
  preparePasskeySafeDeployment,
  readCosignerTokenAllowance,
  safeMessageHash,
  signMessageAsPasskeySafe,
  smartAccountForPasskey,
  smartAccountForPasskeyCosigner,
  submitPasskeySafeDeployment,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "./wallet/candide.js";
import {
  exchangeAuthorizationCode,
  LINK_MESSAGE,
  MoneriumApiError,
  MoneriumClient,
  moneriumBearerRequest,
  refreshAuthorizationToken,
} from "./adapters/monerium-client.js";
import {
  createSumsubShareToken,
  createSumsubWebSdkLink,
  decisionFromSumsubWebhook,
  getSumsubApplicant,
  senderProfileFromSumsubApplicant,
  sumsubExternalUserId,
  userIdFromSumsubExternalId,
  verifySumsubWebhookDigest,
} from "./adapters/sumsub.js";
const app = express();
// Keep the raw body around for webhook signature checks — HMAC has to run
// over the exact bytes sent, not a re-serialised object.
app.use(express.json({
  limit: SECURITY.jsonBodyLimit,
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

/** How long a device signature stays submittable (FP4). */
const AUTH_WINDOW_SEC = 15 * 60;

// ---------------------------------------------------------------------------
// FP1: origin policy + per-IP rate limiting (dependency-free)

// State-changing requests from foreign origins are refused outright; allowed
// origins get explicit CORS headers, everyone else gets none.
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && SECURITY.origins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST");
    if (req.method === "OPTIONS") return res.status(204).end();
  } else if (origin && req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(403).json({ error: "origin not allowed" });
  }
  next();
});

// Where the client address comes from. Default 0 = the socket peer, correct
// only with nothing in front; behind a proxy that address is the proxy, so every
// caller shares one bucket and one client can rate-limit the whole service.
app.set("trust proxy", SECURITY.trustedProxyHops);

/**
 * Is this request from the loopback interface, with nothing claiming to have
 * forwarded it? Simulation endpoints mint balances and self-approve KYC, so they
 * get this check on top of the config switch: a misconfigured
 * ALLOW_SIMULATION on a hosted box still cannot be reached from outside.
 */
function isLocalRequest(req: express.Request): boolean {
  if (req.header("x-forwarded-for") || req.header("forwarded")) return false;
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

function requireSimulationAllowed(req: express.Request, res: express.Response): boolean {
  if (!SECURITY.allowSimulation) {
    res.status(403).json({ error: "simulation endpoints are disabled in production" });
    return false;
  }
  if (!isLocalRequest(req)) {
    res.status(403).json({ error: "simulation endpoints are reachable from localhost only" });
    return false;
  }
  return true;
}

const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, perMin: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return true;
  }
  return ++h.n <= perMin;
}
app.use("/api", (req, res, next) => {
  const ip = req.ip ?? "?";
  const authRoute =
    req.path.startsWith("/passkey") ||
    req.path.startsWith("/recovery") ||
    // A receipt slug is a bearer credential, so looking one up is a guess at a
    // secret and belongs on the tighter bucket with the other guessable things.
    req.path.startsWith("/r/") ||
    req.path === "/kyc/review" ||
    (req.path === "/users" && req.method === "POST");
  const ok = authRoute
    ? rateLimit(`a:${ip}`, SECURITY.authRateLimitPerMin)
    : rateLimit(`g:${ip}`, SECURITY.rateLimitPerMin);
  if (!ok) return res.status(429).json({ error: "rate limited — slow down" });
  next();
});

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
/**
 * Landing page at /, the app at /app.
 *
 * These are declared BEFORE express.static, which would otherwise answer / with
 * index.html and never reach them. The app's own assets are absolute
 * (/device.js, /vendor/...), so it serves correctly from any path — but the
 * import map depends on that, so do not make them relative.
 *
 * /landing.html still resolves, because links to it exist in the wild.
 */
app.get("/", (_req, res) => res.sendFile(path.join(pub, "landing.html")));
app.get(["/app", "/app/"], (_req, res) => res.sendFile(path.join(pub, "index.html")));
app.get(["/admin", "/admin/"], (_req, res) => res.sendFile(path.join(pub, "admin.html")));

app.use(express.static(pub));

type PendingPasskeySafeDeployment = Awaited<ReturnType<typeof preparePasskeySafeDeployment>>["userOperation"];
const pendingPasskeySafeDeployments = new Map<string, { userId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment }>();
/** Allowance repair ceremonies in flight. The refreshed plan rides along
 *  because the stored one may name the codeless module this repairs. */
const pendingAllowanceSetups = new Map<string, {
  userId: string;
  expiresAt: number;
  plan: NonNullable<User["passkeySafe"]>;
  userOperation: PendingPasskeySafeDeployment;
}>();
const pendingMoneriumLinkSignatures = new Map<string, {
  userId: string;
  expiresAt: number;
  challenge: string;
  profileId?: string;
}>();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * What this deployment can actually do, so the browser can render against it.
 *
 * THE BUG THIS FIXES: the app showed an "Add money" control wired to
 * /api/simulate/sepa-deposit unconditionally, and that route is dev-only — it
 * 403s in production and off a loopback socket. Nothing in any API response
 * told the client which mode it was in, so the only way to find out was to
 * press the button and read the error. Offering an action the server will
 * refuse is exactly what makes a product read as unfinished.
 *
 * Deliberately NOT per-user, and deliberately public. These are properties of
 * the deployment rather than of an account, and /api/health already publishes
 * the contract addresses. Nothing here is exploitable either: the simulate
 * routes are gated on this flag AND on a loopback socket with no forwarding
 * headers, so learning the flag's value buys nothing a single refused request
 * would not have revealed.
 */
export function capabilities() {
  return {
    /** May the browser offer simulated deposits and cash pickups at all? */
    simulation: SECURITY.allowSimulation,
    /**
     * Are deposits real Monerium IBAN transfers? This is the difference
     * between "Add money" being a button and being a set of bank details the
     * user transfers to, so the UI needs it alongside the flag above.
     */
    sandbox,
    kycProvider: KYC.provider,
    sumsub: sumsubEnabled(),
  };
}

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const block = await publicClient.getBlockNumber();
    res.json({ ok: true, block: Number(block), contracts: addrs(), capabilities: capabilities() });
  }),
);

/**
 * Public mid rates, so the marketing page can show the same number the product
 * would quote instead of baking its own constants in.
 *
 * The landing page used to hardcode `1.08 * 129.5` and print "Real exchange
 * rate" above it — the same lie as the quote engine's, in the shop window. No
 * auth: this is a public reference rate, not per-user pricing, and it carries
 * no spread or fee.
 */
app.get(
  "/api/rates",
  wrap(async (_req, res) => {
    const { midRates } = await import("./rates.js");
    try {
      const r = await midRates();
      res.json({ eur: r.eur, asOf: r.asOf, provider: r.provider });
    } catch (e: any) {
      // Say so rather than serving a number nobody can stand behind.
      res.status(503).json({ error: e?.message ?? "rates unavailable" });
    }
  }),
);

// --- Users ------------------------------------------------------------------

const sandbox = moneriumSandboxEnabled();

/** Never send payment-page deposit keys, OAuth state, or encrypted tokens to the client. */
const publicUser = ({ moneriumConnect, monerium, passkey, paymentPage, ...u }: User & { [k: string]: any }) => ({
  ...u,
  ...(paymentPage
    ? {
        paymentPage: {
          handle: paymentPage.handle,
          displayName: paymentPage.displayName,
          depositAddress: paymentPage.depositAddress,
          recipientAddress: paymentPage.recipientAddress,
          forwarder: paymentPage.forwarder
            ? {
                provider: paymentPage.forwarder.provider,
                destinationChainId: paymentPage.forwarder.destinationChainId,
                sourceChainIds: paymentPage.forwarder.sourceChainIds,
                active: paymentPage.forwarder.active,
                expiresAt: paymentPage.forwarder.expiresAt,
              }
            : undefined,
          supportedTokens: paymentPage.supportedTokens,
          settlementAsset: paymentPage.settlementAsset,
          autoConvert: paymentPage.autoConvert,
          createdAt: paymentPage.createdAt,
          updatedAt: paymentPage.updatedAt,
        },
      }
    : {}),
  ...(passkey
    ? {
        passkey: {
          credentialId: passkey.credentialId,
          rpId: passkey.rpId,
          createdAt: passkey.createdAt,
        },
      }
    : {}),
  ...(monerium
    ? {
        monerium: {
          connectedAt: monerium.connectedAt,
          profileId: monerium.profileId,
          profiles: monerium.profiles,
          ibans: monerium.ibans,
          addresses: monerium.addresses,
        },
      }
    : {}),
});
const withSession = (user: User) => ({ ...publicUser(user), sessionToken: issueSession(user.id) });

function publicPrivacyPlan(plan: (typeof PRIVACY_BUNDLE.plans)[number]) {
  const grossMarginBps = Math.round(((plan.priceEur - plan.estimatedCostEur) / plan.priceEur) * 10_000);
  return {
    ...plan,
    grossMarginBps,
    marginProtected: grossMarginBps >= PRIVACY_BUNDLE.minMarginBps,
  };
}

function nextMonthlyRenewal() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function issueSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SECURITY.sessionTtlMs).toISOString();
  store.addSession({ id: randomUUID(), userId, tokenHash: tokenHash(token), createdAt: now, lastUsedAt: now, expiresAt });
  return token;
}

function base64url(buf: Buffer) {
  return buf.toString("base64url");
}

function pkceChallenge(verifier: string) {
  return base64url(createHash("sha256").update(verifier).digest());
}

function moneriumTokenKey(): Buffer {
  if (!MONERIUM.tokenEncryptionKey) {
    throw new Error("MONERIUM_TOKEN_ENCRYPTION_KEY is required before connecting user Monerium accounts");
  }
  return createHash("sha256").update(MONERIUM.tokenEncryptionKey).digest();
}

function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", moneriumTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [base64url(iv), base64url(cipher.getAuthTag()), base64url(ciphertext)].join(".");
}

function decryptToken(value: string): string {
  const [iv64, tag64, ciphertext64] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", moneriumTokenKey(), Buffer.from(iv64, "base64url"));
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function moneriumAccessToken(user: User): Promise<string> {
  if (!user.monerium?.accessTokenEnc) throw new Error("Monerium account is not connected");
  if (
    user.monerium.refreshTokenEnc &&
    user.monerium.expiresAt &&
    Date.now() > Date.parse(user.monerium.expiresAt) - 60_000
  ) {
    const refreshed = await refreshAuthorizationToken(
      {
        baseUrl: MONERIUM.baseUrl,
        clientId: MONERIUM.clientId,
        clientSecret: MONERIUM.clientSecret,
      },
      decryptToken(user.monerium.refreshTokenEnc),
    );
    const next = store.updateUser(user.id, {
      monerium: {
        ...user.monerium,
        accessTokenEnc: encryptToken(refreshed.access_token),
        refreshTokenEnc: refreshed.refresh_token
          ? encryptToken(refreshed.refresh_token)
          : user.monerium.refreshTokenEnc,
        expiresAt: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : user.monerium.expiresAt,
      },
    });
    return decryptToken(next.monerium!.accessTokenEnc!);
  }
  return decryptToken(user.monerium.accessTokenEnc);
}

let moneriumAppClientCache: MoneriumClient | null = null;
function moneriumAppClient(): MoneriumClient {
  moneriumAppClientCache ??= new MoneriumClient({
    baseUrl: MONERIUM.baseUrl,
    clientId: MONERIUM.clientId,
    clientSecret: MONERIUM.clientSecret,
  });
  return moneriumAppClientCache;
}

/**
 * Token for Monerium address-linking calls. A connected Monerium account uses
 * its own OAuth token; an account approved in-house has no connected account,
 * so the sandbox app credentials (client-credentials grant) act for it. This
 * is the seam that used to be provisionFunding's server-held-key path before
 * API-held Safe owner keys were removed — the Safe's EIP-1271 signature still
 * comes from the user's passkey ceremony either way.
 */
async function moneriumLinkAccessToken(user: User): Promise<{ accessToken: string; viaApp: boolean }> {
  if (user.monerium?.accessTokenEnc) {
    return { accessToken: await moneriumAccessToken(user), viaApp: false };
  }
  if (!MONERIUM.clientSecret) {
    throw new Error(
      "no Monerium access for this account — connect a Monerium account, or set MONERIUM_CLIENT_SECRET for app-level address linking",
    );
  }
  return { accessToken: await moneriumAppClient().bearerToken(), viaApp: true };
}

async function readMoneriumAccountSnapshot(user: User, accessToken?: string) {
  accessToken ??= await moneriumAccessToken(user);
  const [context, profileRes, ibanRes, addressRes] = await Promise.all([
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/auth/context"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/profiles"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/ibans"),
    moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", "/addresses"),
  ]);
  const profiles = Array.isArray(profileRes) ? profileRes : (profileRes?.profiles ?? []);
  const ibans = Array.isArray(ibanRes) ? ibanRes : (ibanRes?.ibans ?? []);
  const addresses = Array.isArray(addressRes) ? addressRes : (addressRes?.addresses ?? []);
  return { context, profiles, ibans, addresses };
}

function bearerToken(req: express.Request): string | undefined {
  const h = req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}

function requireSession(req: express.Request, res: express.Response) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "authorization required" });
    return undefined;
  }
  const session = store.findSessionByTokenHash(tokenHash(token));
  if (!session) {
    res.status(401).json({ error: "invalid session" });
    return undefined;
  }
  if (session.revokedAt || Date.now() >= Date.parse(session.expiresAt)) {
    res.status(401).json({ error: "session expired" });
    return undefined;
  }
  store.touchSession(session.id);
  return session;
}

function requireUserSession(req: express.Request, res: express.Response, userId: string) {
  const session = requireSession(req, res);
  if (!session) return undefined;
  if (session.userId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return undefined;
  }
  return session;
}

function requireKycApproved(user: User, res: express.Response) {
  if (user.kycStatus === "approved") return true;
  res.status(409).json({
    error: `KYC ${user.kycStatus}; account funding and transfers are disabled until KYC is approved`,
    kycStatus: user.kycStatus,
  });
  return false;
}

function fundableUserPatch(user: User): Partial<User> {
  const blocked = custodyBlockerBeforeFunding(user);
  if (blocked) {
    return {
      iban: "",
      funding: {
        mode: sandbox ? "sandbox" : "mock",
        status: "error",
        detail: blocked,
      },
    };
  }
  if (sandbox) {
    return { funding: { mode: "sandbox", status: "provisioning" } };
  }
  return {
    iban: user.iban || issueIban(user.id),
    funding: { mode: "mock", status: "active" },
  };
}

/**
 * Refuse to issue an IBAN to an account nobody can get back into.
 *
 * An IBAN is the point of no return: once it exists, money can arrive, and an
 * account whose only credential is a session token becomes unreachable the
 * moment that token is gone. Worse, the spending key is bound on-chain and
 * only the CURRENT key may rotate it, so a lost browser is not a lockout —
 * it is permanent. Onboarding lets people skip the passkey, which is fine
 * while an account is empty and unacceptable once it can hold money.
 *
 * Gated on allowSimulation so local demos and e2e still run end to end
 * without a real authenticator.
 */
function custodyBlockerBeforeFunding(user: User): string | null {
  if (SECURITY.allowSimulation) return null;
  if (!user.passkey?.publicKey) {
    return (
      "a verified passkey is required before an account can be funded — without one there is " +
      "no way to sign back in, and a lost device key cannot be replaced"
    );
  }
  if (!user.passkeySafe) {
    return "a passkey Safe plan is required before an account can be funded";
  }
  if (
    user.passkeySafe.status !== "active" ||
    user.address.toLowerCase() !== user.passkeySafe.address.toLowerCase()
  ) {
    return "activate the passkey Safe before funding this account";
  }
  return null;
}

function passkeyRequiredBeforeFunding(user: User): string | null {
  const blocked = custodyBlockerBeforeFunding(user);
  if (!blocked) return null;
  return (
    blocked +
    (blocked.includes("passkey Safe") ? "" : " — complete the passkey Safe setup first")
  );
}

function passkeySafePlan(
  user: User,
  publicKey: NonNullable<NonNullable<User["passkey"]>["publicKey"]>,
): User["passkeySafe"] | undefined {
  if (!publicKey || publicKey.alg !== "ES256") return undefined;
  const cosignerAddress =
    CANDIDE.cosignerEnabled && /^0x[0-9a-fA-F]{40}$/.test(CANDIDE.cosignerAddress)
      ? (CANDIDE.cosignerAddress as `0x${string}`)
      : undefined;
  const owner = webauthnOwnerFromJwk(publicKey.jwk);
  if (!owner) return undefined;
  const account = cosignerAddress
    ? smartAccountForPasskeyCosigner(owner, cosignerAddress)
    : smartAccountForPasskey(owner);
  const tokenAllowances = (() => {
    if (!cosignerAddress) return [];
    const a = addrs();
    return [
      { token: a.eure, symbol: "EURE" as const, amount: CANDIDE.cosignerEureAllowanceWei.toString() },
      { token: a.usdc, symbol: "USDC" as const, amount: CANDIDE.cosignerUsdcAllowanceUnits.toString() },
    ];
  })();
  const recoveryGuardianAddress = /^0x[0-9a-fA-F]{40}$/.test(CANDIDE.recoveryGuardianAddress)
    ? (CANDIDE.recoveryGuardianAddress as `0x${string}`)
    : undefined;
  return {
    address: account.accountAddress as `0x${string}`,
    status: "planned",
    threshold: cosignerAddress ? 2 : 1,
    ...(cosignerAddress ? { cosignerAddress } : {}),
    cosignerPolicy: {
      enabled: Boolean(CANDIDE.cosignerAddress),
      allowanceModuleAddress: CANDIDE.allowanceModuleAddress,
      allowancePeriodMinutes: CANDIDE.cosignerAllowancePeriodMinutes.toString(),
      allowances: tokenAllowances,
      allowanceAmount: tokenAllowances.find((x) => BigInt(x.amount) > 0n)?.amount ?? "0",
    },
    passkeyPublicKey: webauthnOwnerToStore(owner),
    ...(recoveryGuardianAddress
      ? {
          recovery: {
            moduleAddress: CANDIDE.recoveryModuleAddress,
            guardianAddress: recoveryGuardianAddress,
            threshold: 1,
            status: "planned",
          },
        }
      : {}),
    createdAt: new Date().toISOString(),
    previousAddress: user.address,
  };
}

function activatePasskeySafePlan(plan: NonNullable<User["passkeySafe"]>): User["passkeySafe"] {
  return {
    ...plan,
    status: "active",
    ...(plan.recovery
      ? {
          recovery: {
            ...plan.recovery,
            status: "active",
            enabledAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

function passkeySafeChallenge(challenge: `0x${string}`): string {
  return bufToB64url(Buffer.from(challenge.slice(2), "hex"));
}

function prunePendingPasskeySafeDeployments(now = Date.now()) {
  for (const [id, pending] of pendingPasskeySafeDeployments) {
    if (pending.expiresAt < now) pendingPasskeySafeDeployments.delete(id);
  }
}

function prunePendingAllowanceSetups(now = Date.now()) {
  for (const [id, pending] of pendingAllowanceSetups) {
    if (pending.expiresAt < now) pendingAllowanceSetups.delete(id);
  }
}

/** The co-signer allowance policy as the CURRENT environment defines it. The
 *  stored plan's policy is a snapshot from planning time and may name a module
 *  address that never had code — the repair path must not re-install that. */
function currentCosignerPolicy(): NonNullable<NonNullable<User["passkeySafe"]>["cosignerPolicy"]> {
  const a = addrs();
  return {
    enabled: true,
    allowanceModuleAddress: CANDIDE.allowanceModuleAddress,
    allowancePeriodMinutes: CANDIDE.cosignerAllowancePeriodMinutes.toString(),
    allowances: [
      { token: a.eure, symbol: "EURE" as const, amount: CANDIDE.cosignerEureAllowanceWei.toString() },
      { token: a.usdc, symbol: "USDC" as const, amount: CANDIDE.cosignerUsdcAllowanceUnits.toString() },
    ],
    allowanceAmount: CANDIDE.cosignerEureAllowanceWei.toString(),
  };
}

function prunePendingMoneriumLinkSignatures(now = Date.now()) {
  for (const [id, pending] of pendingMoneriumLinkSignatures) {
    if (pending.expiresAt < now) pendingMoneriumLinkSignatures.delete(id);
  }
}

function queueSandboxProvisioning(user: User) {
  const blocked = passkeyRequiredBeforeFunding(user);
  if (blocked) {
    console.log(`provisioning deferred for ${user.id}: ${blocked}`);
    store.updateUser(user.id, {
      funding: { ...(user.funding ?? {}), status: "error", detail: blocked } as User["funding"],
    });
    return;
  }
  provisionFunding(user).catch((err) =>
    console.error(`provisioning failed for ${user.id}: ${err?.message ?? err}`),
  );
}

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { name, country, email } = req.body ?? {};
    if (!name || !country) return res.status(400).json({ error: "name and country required" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "invalid email" });
    }
    const blockedCountry = countryBlock(String(country));
    if (blockedCountry) {
      return res.status(403).json({
        error: blockedCountry.message,
        code: "COUNTRY_NOT_SUPPORTED",
        country: blockedCountry.code,
        reason: blockedCountry.reason,
      });
    }
    const id = randomUUID();
    // The real address is set by passkey/co-signer Safe deployment.
    const kycStatus = KYC.autoApprove ? "approved" : "pending";
    const user: User = {
      id,
      name,
      email,
      country: normaliseCountryCode(String(country)),
      kycStatus,
      kyc: {
        provider: KYC.autoApprove ? "mock" : "manual",
        checkedAt: KYC.autoApprove ? new Date().toISOString() : undefined,
      },
      iban: kycStatus === "approved" && !sandbox ? issueIban(id) : "",
      address: ZERO_ADDRESS,
      wallet: { type: "candide-safe", deployed: false },
      funding:
        kycStatus === "approved"
          ? { mode: sandbox ? "sandbox" : "mock", status: sandbox ? "provisioning" : "active" }
          : { mode: sandbox ? "sandbox" : "mock", status: "kyc_pending" },
      createdAt: new Date().toISOString(),
    };
    store.addUser(user);
    if (sandbox && kycStatus === "approved") {
      // Wallet deploy (~20s) + Monerium provisioning run in the background;
      // the UI polls funding status until the IBAN lands.
      queueSandboxProvisioning(user);
    }
    res.status(201).json(withSession(user));
  }),
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    let user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (sandbox && user.funding?.status === "iban_pending") {
      user = await refreshPendingIban(user);
    }
    const balances = await accountBalances(user.address);
    res.json({ ...publicUser(user), ...balances });
  }),
);

/**
 * Travel Rule originator data — who is sending the money.
 *
 * The cash rail hands money to a stranger at a counter, and the anchor's
 * licence obliges it to know who funded that. MoneyGram requires these as
 * SEP-9 fields; without them a SEP-12 customer sits at NEEDS_INFO and the
 * withdrawal can never complete.
 *
 * Deliberately text-only: no document images. Those belong with a KYC
 * provider, and this store is plaintext JSON on disk.
 */
/**
 * Turn auto-settlement of payment-page crypto on or off.
 *
 * Session-gated to the account itself: this decides whether funds sent to the
 * public page deposit address are swept and settled. It deliberately does not
 * watch the user's main wallet address.
 */
app.post(
  "/api/users/:id/auto-convert",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }
    // The output is e-money, so the same gate that gates a SEPA deposit
    // applies. Say so plainly rather than accepting the setting and silently
    // refusing every deposit later.
    if (enabled && !requireKycApproved(user, res)) return;
    const custodyBlocked = enabled ? custodyBlockerBeforeFunding(user) : null;
    if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
    const page = user.paymentPage;
    if (!page) return res.status(409).json({ error: "claim a payment page before enabling auto-settlement" });
    const updated = store.updateUser(user.id, {
      paymentPage: { ...page, autoConvert: enabled, updatedAt: new Date().toISOString() },
    });
    res.json({ ...publicUser(updated), ...(await accountBalances(updated.address).catch(() => ({}))) });
  }),
);

function normaliseSettlementAsset(raw: unknown): "EURE" | "USDC" {
  if (raw === undefined || raw === null || raw === "") return "EURE";
  if (typeof raw !== "string") throw new HandleError("settlementAsset must be EURE or USDC");
  const asset = raw.trim().toUpperCase();
  if (asset !== "EURE" && asset !== "USDC") throw new HandleError("settlementAsset must be EURE or USDC");
  return asset;
}

/** The chain and token a payment page asks payers to use. USDC because that is
 *  what the crypto-in converter knows how to turn into spendable euros. */
function payChain() {
  return {
    chainId: CHAIN_ID,
    token: { symbol: "USDC", address: addrs().usdc, decimals: 6 },
  };
}

/**
 * Claim or change the account's payment handle.
 *
 * Passkey-Safe gated, not KYC-gated. A user can activate a public payment page
 * before review, but only after their Safe exists on-chain and is the account
 * of record. Settlement/conversion can still apply its own compliance gates.
 */
app.post(
  "/api/users/:id/handle",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    let handle: string;
    let displayName: string | undefined;
    let settlementAsset: "EURE" | "USDC";
    try {
      handle = normaliseHandle(req.body?.handle);
      displayName = normaliseDisplayName(req.body?.displayName);
      settlementAsset = normaliseSettlementAsset(req.body?.settlementAsset);
    } catch (e: any) {
      if (e instanceof HandleError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const taken = store.findUserByHandle(handle);
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: `"${handle}" is already taken` });
    }
    if (
      user.passkeySafe?.status !== "active" ||
      user.address.toLowerCase() !== user.passkeySafe.address.toLowerCase() ||
      !(await isDeployed(user.address))
    ) {
      return res.status(409).json({
        error: "deploy and activate the passkey Safe before activating a payment page",
      });
    }
    const now = new Date().toISOString();
    const existing = user.paymentPage;
    const forwarder = await activatePaymentForwarder({ userId: user.id, handle, recipient: user.address });
    const tokens = [
      { chainId: CHAIN_ID, symbol: "EURE" as const, address: addrs().eure, decimals: 18 },
      { chainId: CHAIN_ID, symbol: "USDC" as const, address: addrs().usdc, decimals: 6 },
    ];
    const updated = store.updateUser(user.id, {
      handle: undefined,
      payDisplayName: undefined,
      autoConvert: undefined,
      paymentPage: {
        handle,
        displayName,
        depositAddress: forwarder.address,
        recipientAddress: user.address,
        forwarder: forwarder.forwarder,
        supportedTokens: tokens,
        settlementAsset,
        autoConvert: existing?.autoConvert ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    });
    res.json({
      handle: updated.paymentPage!.handle,
      displayName: updated.paymentPage!.displayName,
      payUrl: `/pay/${handle}`,
      paymentPage: publicUser(updated).paymentPage,
    });
  }),
);

/**
 * Public payee lookup. No session: this is the point of a payment link.
 *
 * The response comes from publicPayee, which is an allowlist — see pay.ts.
 *
 * Handles ARE enumerable, and pretending otherwise would be worse than the
 * fact: 200 versus 404 tells a caller whether a handle is claimed, and handles
 * are short and human-readable by design. That is true of every username
 * system and is not fixable while the link is meant to be shared, so the
 * honest response is to say it — the page tells the payee that anyone who
 * knows OR GUESSES the handle can find the address, rather than implying the
 * link is a secret.
 */
app.get(
  "/api/pay/:handle",
  wrap(async (req, res) => {
    const user = store.findUserByHandle(req.params.handle);
    if (!user?.paymentPage?.handle) return res.status(404).json({ error: "no such payment page" });
    res.json(publicPayee(user, payChain()));
  }),
);

/** The QR image, rendered server-side. Carries the bare address: see the note
 *  in pay.ts on why the EIP-681 URI is a link instead. */
app.get(
  "/api/pay/:handle/qr.svg",
  wrap(async (req, res) => {
    const user = store.findUserByHandle(req.params.handle);
    if (!user?.paymentPage?.handle) return res.status(404).json({ error: "no such payment page" });
    res.type("image/svg+xml");
    res.setHeader("cache-control", "public, max-age=300");
    res.send(qrSvg(publicPayee(user, payChain()).address));
  }),
);

/** The page itself. Served for any handle shape — the client fetches the payee
 *  and renders its own not-found, so a bad link still gets a real page. */
app.get("/pay/:handle", (_req, res) => {
  res.sendFile(path.join(pub, "pay.html"));
});

/* ---------------------------------------------------------------------------
 * Shareable receipts
 *
 * Unlike /pay/:handle, this link IS the credential: a slug is the only thing
 * standing between a stranger and someone's transfer, which is why the slug
 * carries real entropy and why the route is bucketed with the auth endpoints
 * against scanning.
 * ------------------------------------------------------------------------- */

/** The sender's own view of the share, with the URL to hand out. */
function shareResponse(req: express.Request, share: ReceiptShare) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return {
    slug: share.slug,
    url: `${base}/r/${share.slug}`,
    fields: share.fields,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
  };
}

/**
 * Create or re-scope the share for a transfer.
 *
 * Re-posting edits the existing share rather than minting a second slug, so
 * narrowing a selection narrows what is actually public. It also keeps the link
 * a sender has already sent working — reissuing on every edit would silently
 * break the copy in someone's chat window.
 *
 * The expiry is NOT extended by an edit. A share is a 30-day window opened
 * once; letting a tweak reset the clock would make an indefinitely-live link
 * out of a link the sender believed was expiring.
 */
app.post(
  "/api/transfers/:id/share",
  wrap(async (req, res) => {
    const transfer = store.findTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, transfer.userId)) return;
    // Nothing has settled or moved before CREATED clears, and a receipt for a
    // transfer that may still be refused would publish an outcome that has not
    // happened yet.
    if (transfer.state === "CREATED") {
      return res.status(409).json({ error: "this transfer has not been authorised yet — nothing to share" });
    }
    const existing = store.findReceiptShareByTransfer(transfer.id);
    const fields = parseShareFields(req.body, existing?.fields ?? DEFAULT_SHARE_FIELDS);
    if (existing && !existing.revokedAt) {
      return res.json(shareResponse(req, store.updateReceiptShare(existing.id, { fields })));
    }
    const now = new Date();
    const share: ReceiptShare = {
      id: randomUUID(),
      slug: receiptSlug((n) => randomBytes(n)),
      transferId: transfer.id,
      userId: transfer.userId,
      fields,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    // A revoked share is replaced rather than resurrected: the old slug stays
    // recorded as revoked, so a later visitor gets 410 rather than a typo-like
    // 404 while the new share gets a fresh unguessable slug.
    store.addReceiptShare(share);
    res.status(201).json(shareResponse(req, share));
  }),
);

app.get(
  "/api/transfers/:id/share",
  wrap(async (req, res) => {
    const transfer = store.findTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, transfer.userId)) return;
    const share = store.findReceiptShareByTransfer(transfer.id);
    if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
    res.json(shareResponse(req, share));
  }),
);

/** Kill the link. The slug stays recorded so a later visitor is told it was
 *  revoked rather than getting the same 404 as a typo. */
app.delete(
  "/api/transfers/:id/share",
  wrap(async (req, res) => {
    const transfer = store.findTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, transfer.userId)) return;
    const share = store.findReceiptShareByTransfer(transfer.id);
    if (!share || share.revokedAt) return res.status(404).json({ error: "no live share for this transfer" });
    res.json(shareResponse(req, store.revokeReceiptShare(share.id)));
  }),
);

/**
 * The public payload. No session, and no user record beyond the sender's name
 * at the granularity the sender chose.
 *
 * Every refusal is a 404 with the same shape whether the slug is unknown or
 * merely dead, except that a revoked or expired share says which — the holder
 * of a real link deserves to know why it stopped working, and a scanner learns
 * nothing from it that a 404 did not already tell them.
 */
app.get(
  "/api/r/:slug",
  wrap(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    // A receipt names people and amounts; keeping it out of search indexes is
    // as much a part of "share only what's needed" as the field pickers.
    res.setHeader("x-robots-tag", "noindex, nofollow");
    const share = store.findReceiptShareBySlug(String(req.params.slug));
    if (!share) return res.status(404).json({ error: "no such receipt" });
    if (share.revokedAt) return res.status(410).json({ error: "the sender revoked this receipt", revoked: true });
    if (Date.parse(share.expiresAt) < Date.now()) {
      return res.status(410).json({ error: "this receipt link has expired", expired: true });
    }
    const transfer = store.findTransfer(share.transferId);
    const sender = store.findUser(share.userId);
    if (!transfer || !sender) return res.status(404).json({ error: "no such receipt" });
    res.json(
      buildReceipt({
        slug: share.slug,
        transfer,
        sender,
        quote: store.findQuote(transfer.quoteId),
        fields: share.fields,
        expiresAt: share.expiresAt,
      }),
    );
  }),
);

/** The page. Rendered for any slug shape; the client fetches and draws its own
 *  expired/revoked/not-found states, so a dead link is still a real page. */
app.get("/r/:slug", (_req, res) => {
  res.sendFile(path.join(pub, "receipt.html"));
});

/** What arrived as crypto and what became of it. Read-only; the poller owns
 *  every state change here. */
app.get(
  "/api/users/:id/crypto-deposits",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    res.json({
      autoConvert: !!user.paymentPage?.autoConvert,
      settlementAsset: user.paymentPage?.settlementAsset ?? "USDC",
      depositAddress: user.paymentPage?.depositAddress,
      deposits: store.cryptoDeposits
        .filter((d) => d.userId === user.id)
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    });
  }),
);

app.post(
  "/api/users/:id/sender-profile",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const b = req.body ?? {};
    const str = (v: any) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
    const firstName = str(b.firstName);
    const lastName = str(b.lastName);
    if (!firstName || !lastName) {
      return res.status(400).json({ error: "firstName and lastName are required" });
    }
    const birthDate = str(b.birthDate);
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return res.status(400).json({ error: "birthDate must be ISO yyyy-mm-dd" });
    }
    const idType = str(b.idType);
    if (idType && !["passport", "drivers_license", "id_card"].includes(idType)) {
      return res.status(400).json({ error: "idType must be passport, drivers_license or id_card" });
    }
    // SEP-9 country codes are ISO 3166-1 alpha-3 ("DEU", "USA"). Accept
    // either form from callers and normalise; reject what we cannot map
    // rather than storing a code the anchor would misread.
    const rawCc = str(b.addressCountryCode) ?? user.country;
    const addressCountryCode = toAlpha3(rawCc);
    if (rawCc && !addressCountryCode) {
      return res.status(400).json({
        error: `unrecognised country code "${rawCc}" — use an ISO 3166-1 alpha-2 or alpha-3 code`,
      });
    }
    const idCountryCode = toAlpha3(str(b.idCountryCode));
    // ISO 3166-2, e.g. "US-MN"; MoneyGram only uses it for USA/CAN/MEX.
    const stateOrProvince = str(b.stateOrProvince);
    if (stateOrProvince && !/^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/.test(stateOrProvince)) {
      return res.status(400).json({
        error: 'stateOrProvince must be ISO 3166-2, for example "US-MN"',
      });
    }
    const updated = store.updateUser(user.id, {
      senderProfile: {
        firstName,
        lastName,
        birthDate,
        address: str(b.address),
        city: str(b.city),
        postalCode: str(b.postalCode),
        stateOrProvince,
        addressCountryCode,
        idType: idType as any,
        idNumber: str(b.idNumber),
        idCountryCode,
        mobileNumber: str(b.mobileNumber),
        emailAddress: str(b.emailAddress) ?? user.email,
        occupation: str(b.occupation),
        updatedAt: new Date().toISOString(),
      },
    });
    res.json(publicUser(updated));
  }),
);

/**
 * What the configured anchor still wants before it will pay out cash. Lets the
 * app ask up front instead of discovering it when a transfer is mid-flight.
 */
app.get(
  "/api/users/:id/sender-profile/requirements",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!anchorModeEnabled()) {
      return res.json({ anchor: null, missing: [], detail: "no anchor configured; cash payouts are mocked" });
    }
    const treasury = await getTreasury();
    const jwt = await sep10Auth(STELLAR.anchorDomain, treasury);
    const declared = await sep12CustomerFields(STELLAR.anchorDomain, jwt, treasury.publicKey());
    const missing = missingRequiredFields(declared.fields, senderProfileToSep9(user));
    res.json({
      anchor: STELLAR.anchorDomain,
      customerStatus: declared.status,
      required: Object.entries(declared.fields)
        .filter(([, f]) => f.optional !== true)
        .map(([name]) => name),
      missing,
      ready: missing.length === 0,
    });
  }),
);

app.get(
  "/api/users/:id/kyc",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    res.json({
      userId: user.id,
      country: user.country,
      kycStatus: user.kycStatus,
      kyc: user.kyc,
      funding: user.funding,
    });
  }),
);

/**
 * Self-serve identity approval. ONLY where the deployment has already decided
 * every user is approved (KYC_AUTO_APPROVE) or is an explicit simulation —
 * this route briefly ran ungated, which let any session approve its own KYC
 * on any deployment, the exact hole requireOperator exists to close.
 */
app.post(
  "/api/users/:id/kyc",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (user.kycStatus === "approved") return res.status(409).json({ error: "account is already approved" });
    if (!KYC.autoApprove && !SECURITY.allowSimulation) {
      return res.status(403).json({ error: "identity review is operator-only on this deployment" });
    }
    const result = await applyKycDecision(user, "approved", "mock", "in-house verification auto-approved");
    res.json(result);
  }),
);

app.post(
  "/api/users/:id/sumsub/start",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (user.kycStatus === "approved") return res.status(409).json({ error: "account is already approved" });
    if (!sumsubEnabled()) {
      // Only the deployment-wide auto-approve flips this; in simulation the
      // explicit route for self-approval is mock-review, not "start sumsub".
      if (KYC.autoApprove) {
        const result = await applyKycDecision(user, "approved", "mock", "in-house verification auto-approved");
        return res.json({ verificationUrl: "", kyc: result.kyc, funding: result.funding, kycStatus: result.kycStatus });
      }
      return res.status(503).json({ error: "Sumsub KYC is not configured" });
    }
    const base = PUBLIC_URL || `http://${API_HOST}:${API_PORT}`;
    const externalUserId = sumsubExternalUserId(user.id);
    const link = await createSumsubWebSdkLink(SUMSUB, {
      user,
      successUrl: `${base}/app?kyc=sumsub_success`,
      rejectUrl: `${base}/app?kyc=sumsub_rejected`,
    });
    const updated = store.updateUser(user.id, {
      kyc: {
        ...user.kyc,
        provider: "sumsub",
        onboardingPath: "new_monerium",
        reason: "Sumsub identity verification started",
        sumsub: {
          ...user.kyc?.sumsub,
          externalUserId,
        },
      },
      funding: {
        ...(user.funding ?? { mode: sandbox ? "sandbox" : "mock", status: "kyc_pending" as const }),
        status: "kyc_pending" as const,
        detail: "complete Sumsub identity verification",
      },
    });
    res.json({ verificationUrl: link.url, kyc: publicUser(updated).kyc, funding: updated.funding });
  }),
);

app.get(
  "/api/privacy-bundles",
  wrap(async (_req, res) => {
    res.json({
      enabled: PRIVACY_BUNDLE.enabled,
      fulfillment: {
        kokio: PRIVACY_BUNDLE.kokioLive ? "live" : "pending_partner_credentials",
        mysterium: PRIVACY_BUNDLE.mysteriumLive ? "live" : "pending_partner_credentials",
      },
      guardrails: {
        minMarginBps: PRIVACY_BUNDLE.minMarginBps,
        noUnlimitedUsage: true,
        downgradeWhenMarginUnsafe: true,
      },
      plans: PRIVACY_BUNDLE.plans.map(publicPrivacyPlan),
    });
  }),
);

app.post(
  "/api/users/:id/privacy-bundle",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    if (!PRIVACY_BUNDLE.enabled) return res.status(503).json({ error: "privacy bundle is not enabled" });

    const plan = PRIVACY_BUNDLE.plans.find((p) => p.id === req.body?.planId);
    if (!plan) return res.status(400).json({ error: "unknown privacy bundle plan" });
    const publicPlan = publicPrivacyPlan(plan);
    if (!publicPlan.marginProtected) {
      return res.status(409).json({
        error: "plan is below the configured margin floor",
        plan: publicPlan,
      });
    }

    const now = new Date().toISOString();
    const status =
      PRIVACY_BUNDLE.kokioLive && PRIVACY_BUNDLE.mysteriumLive ? "active" : "pending_fulfillment";
    const updated = store.updateUser(user.id, {
      privacyBundle: {
        planId: plan.id,
        status,
        startedAt: now,
        renewsAt: nextMonthlyRenewal(),
        esim: {
          provider: "kokio",
          status: PRIVACY_BUNDLE.kokioLive ? "active" : "pending",
          dataGb: plan.esimGb,
          region: plan.esimRegion,
        },
        vpn: {
          provider: "mysterium",
          status: PRIVACY_BUNDLE.mysteriumLive ? "active" : "pending",
          bandwidthGb: plan.vpnGb,
          devices: plan.vpnDevices,
        },
        usage: {
          esimGb: 0,
          vpnGb: 0,
          periodStartedAt: now,
        },
      },
    });
    res.status(201).json({ user: publicUser(updated), plan: publicPlan });
  }),
);

app.post(
  "/api/users/:id/privacy-bundle/cancel",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!user.privacyBundle || user.privacyBundle.status === "canceled") {
      return res.status(409).json({ error: "no active privacy bundle" });
    }
    const updated = store.updateUser(user.id, {
      privacyBundle: {
        ...user.privacyBundle,
        status: "canceled",
        canceledAt: new Date().toISOString(),
      },
    });
    res.json(publicUser(updated));
  }),
);

app.post(
  "/api/users/:id/funding-onboarding-path",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (user.kycStatus === "approved") {
      return res.status(409).json({ error: "account is already approved" });
    }
    const path = req.body?.path;
    if (!["existing_monerium", "new_monerium"].includes(path)) {
      return res.status(400).json({ error: "path must be existing_monerium or new_monerium" });
    }

    // Only the deployment-wide auto-approve flips this. Simulation mode keeps
    // its ONE explicit approval route (mock-review) so the KYC gate stays
    // testable locally — choosing a path is not an identity decision.
    if (path === "new_monerium" && KYC.autoApprove) {
      const result = await applyKycDecision(user, "approved", "manual", "in-house identity verification auto-approved");
      return res.json(result);
    }

    const updated = store.updateUser(user.id, {
      kyc: {
        ...user.kyc,
        provider: path === "existing_monerium" ? "monerium" : "manual",
        onboardingPath: path,
        reason:
          path === "existing_monerium"
            ? "existing Monerium account selected; OAuth connection pending"
            : "standard identity review selected",
      },
      funding: {
        ...(user.funding ?? { mode: sandbox ? "sandbox" : "mock", status: "kyc_pending" as const }),
        status: "kyc_pending" as const,
        detail:
          path === "existing_monerium"
            ? "connect existing Monerium account"
            : "identity review required",
      },
    });
    const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
    res.json({ ...publicUser(updated), ...balances });
  }),
);

app.post(
  "/api/users/:id/monerium/connect/start",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!moneriumOAuthEnabled()) {
      return res.status(503).json({ error: "Monerium OAuth client is not configured" });
    }
    if (!MONERIUM.tokenEncryptionKey) {
      return res.status(503).json({ error: "Monerium token encryption key is not configured" });
    }
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const redirectUri =
      typeof req.body?.redirectUri === "string" && req.body.redirectUri.startsWith("http")
        ? req.body.redirectUri
        : MONERIUM.redirectUri;
    store.updateUser(user.id, {
      kyc: { ...user.kyc, provider: "monerium", onboardingPath: "existing_monerium" },
      funding: {
        ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }),
        status: "kyc_pending" as const,
        detail: "connect existing Monerium account",
      },
      moneriumConnect: {
        state,
        codeVerifier,
        redirectUri,
        createdAt: new Date().toISOString(),
      },
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: MONERIUM.oauthClientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
    res.status(201).json({ redirectUrl: `${MONERIUM.authUrl}?${params}` });
  }),
);

app.get(
  "/api/monerium/oauth/callback",
  wrap(async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code) return res.status(400).json({ error: "state and code required" });
    const user = store.users.find((u) => u.moneriumConnect?.state === state);
    if (!user?.moneriumConnect) return res.status(400).json({ error: "unknown or expired OAuth state" });
    if (Date.now() - Date.parse(user.moneriumConnect.createdAt) > 10 * 60_000) {
      store.updateUser(user.id, { moneriumConnect: undefined });
      return res.status(410).json({ error: "OAuth state expired; start Monerium connect again" });
    }

    const token = await exchangeAuthorizationCode(
      {
        baseUrl: MONERIUM.baseUrl,
        clientId: MONERIUM.oauthClientId,
        clientSecret: MONERIUM.clientSecret,
      },
      {
        code,
        codeVerifier: user.moneriumConnect.codeVerifier,
        redirectUri: user.moneriumConnect.redirectUri,
      },
    );
    const snapshot = await readMoneriumAccountSnapshot(user, token.access_token);
    const approvedProfile = snapshot.profiles.find((p: any) => p.state === "approved");
    const profileId = approvedProfile?.id ?? snapshot.profiles[0]?.id;

    store.updateUser(user.id, {
      moneriumConnect: undefined,
      kyc: {
        provider: "monerium",
        onboardingPath: "existing_monerium",
        checkedAt: undefined,
        applicantId: profileId,
        reason: "existing Monerium account connected; activate IBAN with passkey",
      },
      funding: {
        mode: "sandbox",
        status: "provisioning",
        moneriumProfileId: profileId,
        detail: "smart wallet deployed — approve IBAN issuance with your passkey",
      },
      monerium: {
        connectedAt: new Date().toISOString(),
        profileId,
        accessTokenEnc: encryptToken(token.access_token),
        refreshTokenEnc: token.refresh_token ? encryptToken(token.refresh_token) : undefined,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
        profiles: snapshot.profiles,
        ibans: snapshot.ibans,
        addresses: snapshot.addresses,
      },
    });
    // The app lives at /app, not /, since the landing page took the root.
    res.redirect("/app?monerium=connected");
  }),
);

app.get(
  "/api/users/:id/monerium/accounts",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const snapshot = await readMoneriumAccountSnapshot(user);
    const updated = store.updateUser(user.id, {
      monerium: { ...user.monerium!, ...snapshot },
    });
    res.json(publicUser(updated).monerium);
  }),
);

app.post(
  "/api/users/:id/monerium/link-signature/start",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const custodyBlocked = custodyBlockerBeforeFunding(user);
    if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
    if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
      return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
    }
    if (!CANDIDE.cosignerKey) {
      return res.status(503).json({ error: "CANDIDE_COSIGNER_KEY is required to co-sign Monerium address linking" });
    }
    // Fail here, before the passkey ceremony, if no Monerium access exists —
    // a ceremony whose submit is doomed just burns the user's approval.
    await moneriumLinkAccessToken(user);
    if (!(await isDeployed(user.address))) {
      return res.status(409).json({ error: "passkey Safe must be deployed before Monerium address linking" });
    }
    prunePendingMoneriumLinkSignatures();
    const requestId = randomUUID();
    const profileId = typeof req.body?.profileId === "string" ? req.body.profileId : user.monerium?.profileId;
    const challenge = passkeySafeChallenge(safeMessageHash(user.address, LINK_MESSAGE));
    pendingMoneriumLinkSignatures.set(requestId, {
      userId: user.id,
      profileId,
      challenge,
      expiresAt: Date.now() + 5 * 60_000,
    });
    res.status(201).json({
      requestId,
      credentialId: user.passkey.credentialId,
      challenge,
      rpId: user.passkey.rpId ?? SECURITY.rpId,
      message: LINK_MESSAGE,
      address: user.address,
      submitTo: `/api/users/${user.id}/monerium/activate`,
    });
  }),
);

app.post(
  "/api/users/:id/monerium/activate",
  wrap(async (req, res) => {
    let user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const custodyBlocked = custodyBlockerBeforeFunding(user);
    if (custodyBlocked) {
      return res.status(409).json({ error: custodyBlocked });
    }
    const { accessToken, viaApp } = await moneriumLinkAccessToken(user);

    if (!(await isDeployed(user.address))) {
      return res.status(409).json({
        error: "passkey Safe must be deployed before Monerium address linking",
      });
    }
    if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
      return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
    }
    // Captured under the guard above: `user` is reassigned below (store
    // updates), which discards TypeScript's narrowing on these.
    const passkey = user.passkey;
    const passkeyKey = user.passkey.publicKey;
    const passkeySafe = user.passkeySafe;

    prunePendingMoneriumLinkSignatures();
    let profileId: string | undefined;
    let signature: `0x${string}`;

    const rawSignature = req.body?.signature;
    if (typeof rawSignature === "string" && /^0x[0-9a-fA-F]+$/.test(rawSignature)) {
      signature = rawSignature as `0x${string}`;
      profileId = typeof req.body?.profileId === "string" ? req.body.profileId : user.monerium?.profileId;
    } else {
      const requestId =
        typeof req.body?.requestId === "string"
          ? req.body.requestId
          : typeof req.body?.linkSignatureRequestId === "string"
          ? req.body.linkSignatureRequestId
          : "";
      const pending = requestId ? pendingMoneriumLinkSignatures.get(requestId) : undefined;
      if (!pending || pending.userId !== user.id) {
        return res.status(409).json({
          error: "fresh passkey Safe signature required for Monerium address linking",
          start: `/api/users/${user.id}/monerium/link-signature/start`,
        });
      }
      pendingMoneriumLinkSignatures.delete(requestId);
      const { authenticatorData, clientDataJSON, signature: assertionSignature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !assertionSignature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      profileId =
        pending.profileId ?? user.monerium?.profileId ?? user.funding?.moneriumProfileId;
      /**
       * In-house path: the address must be linked under a PER-CUSTOMER
       * profile, or Monerium never issues the IBAN — the app's default
       * profile accepts the link and then sits on the request forever. This
       * branch existed, was dropped in a rework, and every in-house
       * activation after that parked at "waiting for activation".
       */
      if (!profileId && viaApp) {
        profileId =
          MONERIUM.profileId ||
          (await moneriumAppClient().createProfile("personal", user.email ?? user.name))?.id;
        // Persist NOW: every later step can fail, and a retry that cannot
        // see the profile would mint another orphan on the Monerium app.
        if (profileId) {
          user = store.updateUser(user.id, {
            funding: {
              ...(user.funding ?? { mode: "sandbox", status: "provisioning" }),
              moneriumProfileId: profileId,
            } as User["funding"],
          });
        }
      }
      try {
        const { signCount } = await verifyAssertionForChallenge(
          authenticatorData,
          clientDataJSON,
          assertionSignature,
          passkeyKey,
          passkey.signCount ?? 0,
          passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          pending.challenge,
          true,
        );
        user = store.updateUser(user.id, { passkey: { ...passkey, signCount } });
        signature = await signMessageAsPasskeySafe(passkeySafe, user.address, LINK_MESSAGE, {
          authenticatorData: b64urlToBuf(authenticatorData),
          clientDataJSON: b64urlToBuf(clientDataJSON),
          signature: b64urlToBuf(assertionSignature),
        });
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }
    }
    /**
     * Wrong-profile links are rebound, not tolerated. Addresses linked while
     * the per-customer profile branch was missing sit under the app's DEFAULT
     * profile, where an IBAN request parks forever — and POST /addresses
     * answers "already linked" without moving the binding, so a retry changes
     * nothing. This ceremony holds a fresh Safe signature, so unlink and let
     * the re-link below bind the address where IBANs actually issue.
     */
    if (viaApp && profileId) {
      try {
        const rec = await moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", `/addresses/${user.address}`);
        if (rec?.profile && rec.profile !== profileId) {
          await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "DELETE", `/addresses/${user.address}`);
        }
      } catch {
        // not linked yet — the normal first-run case
      }
    }
    const alreadyDone = (err: unknown) =>
      err instanceof MoneriumApiError &&
      err.status < 500 &&
      /already|exist|duplicate/i.test(err.message);
    try {
      await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/addresses", {
        address: user.address,
        signature,
        chain: MONERIUM.chain,
        message: LINK_MESSAGE,
        ...(profileId ? { profile: profileId } : {}),
      });
    } catch (err: any) {
      if (!alreadyDone(err)) {
        return res.status(502).json({ error: `Monerium refused the address linking: ${err?.message ?? err}` });
      }
    }
    try {
      await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/ibans", {
        address: user.address,
        chain: MONERIUM.chain,
      });
    } catch (err: any) {
      if (!alreadyDone(err)) {
        return res.status(502).json({ error: `Monerium refused the IBAN request: ${err?.message ?? err}` });
      }
    }
    const snapshot = await readMoneriumAccountSnapshot(user, accessToken);
    /**
     * ADDRESS-MATCHED ONLY — an IBAN is money routing, not decoration.
     *
     * There used to be a fallback here to "the first IBAN in the snapshot"
     * for when Monerium had not issued this address's IBAN yet. With app
     * credentials that snapshot lists EVERY customer's IBAN, so each
     * activation that outran issuance displayed some OTHER account's IBAN
     * as its own — and a real sandbox payment sent to "my IBAN" minted into
     * the other user's Safe (transfer 0a34425a: €22.01 landed in the wrong
     * account). No IBAN yet must mean iban_pending, never someone else's;
     * refreshPendingIban polls by address and attributes correctly.
     */
    const iban =
      snapshot.ibans.find(
        (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
      )?.iban ?? "";

    const updated = store.updateUser(user.id, {
      // What Monerium attributes to THIS address, or nothing. Falling back to
      // a previously stored value would preserve exactly the mis-attribution
      // this route used to create.
      iban,
      ...(viaApp
        ? {}
        : {
            kycStatus: "approved" as const,
            kyc: {
              provider: "monerium" as const,
              onboardingPath: "existing_monerium" as const,
              checkedAt: new Date().toISOString(),
              applicantId: profileId,
              reason: `approved via connected Monerium profile ${profileId ?? "(unnamed)"}`,
            },
          }),
      funding: {
        mode: "sandbox",
        status: iban ? "active" : "iban_pending",
        moneriumProfileId: profileId,
        detail: iban ? undefined : "Monerium IBAN requested; waiting for activation",
      },
      monerium: { ...user.monerium!, profileId, ...snapshot },
    });
    const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
    res.json({ ...publicUser(updated), ...balances });
  }),
);

app.delete(
  "/api/users/:id/monerium/connect",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const updated = store.updateUser(user.id, {
      moneriumConnect: undefined,
      monerium: undefined,
      funding: { ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }), status: "kyc_pending" as const },
    });
    res.json(publicUser(updated));
  }),
);

/**
 * Apply a KYC decision. Shared by the operator seam and the local mock-review
 * endpoint so the two cannot drift — the authorization differs, the effect on
 * the account must not.
 */
async function applyKycDecision(
  user: User,
  decision: "approved" | "rejected" | "manual_review",
  provider: "mock" | "manual" | "monerium" | "sumsub",
  reason?: string,
) {
  const updated = store.updateUser(user.id, {
    ...(decision === "approved"
      ? fundableUserPatch(user)
      : { funding: { ...user.funding!, status: "kyc_pending" as const } }),
    kycStatus: decision,
    kyc: {
      ...user.kyc,
      provider,
      checkedAt: new Date().toISOString(),
      reason: typeof reason === "string" ? reason : undefined,
    },
  });
  if (sandbox && decision === "approved") queueSandboxProvisioning(updated);
  const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
  return { ...publicUser(updated), ...balances };
}

function readDecision(body: any, res: express.Response): "approved" | "rejected" | "manual_review" | undefined {
  const decision = body?.decision;
  if (!["approved", "rejected", "manual_review"].includes(decision)) {
    res.status(400).json({ error: "decision must be approved, rejected or manual_review" });
    return undefined;
  }
  return decision;
}

async function shareApprovedSumsubKycWithMonerium(user: User, applicantId: string): Promise<User> {
  if (!moneriumSandboxEnabled()) return user;
  const profileId =
    user.funding?.moneriumProfileId ||
    user.monerium?.profileId ||
    MONERIUM.profileId ||
    (await new MoneriumClient(MONERIUM).createProfile("personal", user.email ?? user.name)).id;
  const share = await createSumsubShareToken(SUMSUB, applicantId, SUMSUB.moneriumClientId);
  await new MoneriumClient(MONERIUM).shareKyc(profileId, share.token);
  return store.updateUser(user.id, {
    funding: {
      ...(user.funding ?? { mode: sandbox ? "sandbox" : "mock", status: "kyc_pending" as const }),
      moneriumProfileId: profileId,
      detail: "Sumsub KYC shared with Monerium; waiting for Monerium profile review",
    },
    monerium: { ...(user.monerium ?? { connectedAt: new Date().toISOString() }), profileId },
    kyc: {
      ...user.kyc,
      provider: "sumsub",
      sumsub: {
        ...user.kyc?.sumsub,
        externalUserId: user.kyc?.sumsub?.externalUserId ?? sumsubExternalUserId(user.id),
        applicantId,
        moneriumShare: { profileId, status: "pending", updatedAt: new Date().toISOString() },
      },
    },
  });
}

/** Refuse a send that would take the account past its daily cap, counting both
 *  funding sources. The arithmetic lives in dailyCapUsage so it can be tested
 *  without standing up the HTTP layer. */
async function assertDailyCap(
  user: User,
  sendEur: number,
  res: express.Response,
): Promise<boolean> {
  const { capEur, usedEur, fromSafeEur } = await dailyCapUsage(user);
  if (usedEur + sendEur > capEur) {
    res.status(400).json({
      error:
        `amount exceeds the daily cap of €${capEur.toFixed(2)} ` +
        `(already used €${usedEur.toFixed(2)} today from the Safe: €${fromSafeEur.toFixed(2)})`,
    });
    return false;
  }
  return true;
}

/**
 * Operator authentication. Deliberately NOT a user session: a user must never
 * be able to approve their own KYC, which is exactly what the session-scoped
 * mock-review endpoint allows. Fails closed when no token is configured, so an
 * unset secret means no approval path rather than an open one.
 */
function requireOperator(req: express.Request, res: express.Response): boolean {
  const expected = KYC.operatorToken;
  if (!expected) {
    res.status(503).json({
      error: "no KYC operator token configured — set KYC_OPERATOR_TOKEN to enable operator review",
    });
    return false;
  }
  const provided = bearerToken(req) ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "operator authorization required" });
    return false;
  }
  return true;
}

function operatorLabel(req: express.Request): string {
  const token = bearerToken(req) ?? "";
  return `operator:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

function recoveryPublicList(userId: string) {
  const now = new Date();
  return store.recoveryRequestsForUser(userId)
    .map((r) => {
      const status = readinessStatus(r, now);
      if (status !== r.status) store.updateRecoveryRequest(r.id, { status });
      return publicRecoveryRequest({ ...r, status });
    })
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
}

function adminUserSummary(userId: string) {
  const u = store.findUser(userId);
  if (!u) return undefined;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    country: u.country,
    kycStatus: u.kycStatus,
    kycProvider: u.kyc?.provider,
    funding: u.funding,
    safeAddress: u.address,
    iban: u.iban,
  };
}

function lastHash(txs: { step: string; hash: string }[] = []) {
  return txs.at(-1)?.hash;
}

/** Keep enough to recognise a payee, never the whole identifier. */
function maskIdentifier(v?: string): string | undefined {
  if (!v) return v;
  const s = String(v).replace(/\s+/g, "");
  return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function adminTransfer(transfer: Transfer) {
  const quote = store.findQuote(transfer.quoteId);
  const route = [
    ...transfer.txs.map((tx) => ({ kind: "chain" as const, ...tx })),
    ...(transfer.liquidity?.txHash
      ? [{ kind: "liquidity" as const, step: `liquidity.${transfer.liquidity.provider}`, hash: transfer.liquidity.txHash }]
      : []),
    ...(transfer.pickup?.anchorPaymentHash
      ? [{ kind: "payout" as const, step: "moneygram.anchor.payment", hash: transfer.pickup.anchorPaymentHash }]
      : []),
  ];
  return {
    kind: "transfer" as const,
    id: transfer.id,
    user: adminUserSummary(transfer.userId),
    quote,
    rail: transfer.rail,
    state: transfer.state,
    statusDetail:
      transfer.error ??
      transfer.sepa?.detail ??
      transfer.pickup?.anchorStatus ??
      transfer.pickup?.status ??
      transfer.sepa?.state,
    sendEur: transfer.sendEur,
    receiveEur: transfer.receiveEur,
    receiveKes: transfer.receiveKes,
    recipientName: transfer.recipientName,
    // Masked in the ops list: the dashboard needs to distinguish payees, not
    // hold their full identifiers on every poll.
    recipientPhone: maskIdentifier(transfer.recipientPhone),
    recipientIban: maskIdentifier(transfer.recipientIban),
    fundingSource: transfer.fundingSource,
    payout:
      transfer.rail === "sepa"
        ? {
            provider: transfer.sepa?.mode === "sandbox" ? "Monerium" : "Mock SEPA",
            orderId: transfer.sepa?.orderId,
            state: transfer.sepa?.state,
            detail: transfer.sepa?.detail,
            redeemSignedAt: transfer.moneriumRedeem?.signedAt,
            memo: transfer.moneriumRedeem?.memo,
          }
        : {
            provider: transfer.pickup?.provider ?? "MoneyGram",
            referenceCode: transfer.pickup?.referenceCode,
            status: transfer.pickup?.status,
            anchorStatus: transfer.pickup?.anchorStatus,
            anchorTransactionId: transfer.pickup?.anchorTransactionId,
            anchorReferenceNumber: transfer.pickup?.anchorReferenceNumber,
            anchorAsset: transfer.pickup?.anchorAsset,
            anchorAmount: transfer.pickup?.anchorAmount,
            anchorAmountIn: transfer.pickup?.anchorAmountIn,
            moreInfoUrl: transfer.pickup?.moreInfoUrl,
          },
    liquidity: transfer.liquidity,
    bridge: route.filter((x) => x.step.startsWith("cctp.") || x.step.startsWith("bridge.")),
    route,
    lastHash: lastHash(transfer.txs),
    refund: transfer.refund,
    error: transfer.error,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  };
}

function adminFunding(deposit: CryptoDeposit) {
  return {
    kind: "funding" as const,
    id: deposit.id,
    user: adminUserSummary(deposit.userId),
    chainId: deposit.chainId,
    token: deposit.token,
    state: deposit.state,
    statusDetail: deposit.reason,
    txHash: deposit.txHash,
    logIndex: deposit.logIndex,
    amountEur: deposit.amountEur ?? deposit.creditedEur,
    amountUsdc: deposit.amountUsdc ?? deposit.creditedUsdc,
    settlementAsset: deposit.settlementAsset,
    paymentAddress: deposit.paymentAddress,
    provider: deposit.provider,
    rate: deposit.rate,
    txs: deposit.txs,
    route: [
      { kind: "chain" as const, step: `erc20.${deposit.token}.transfer.in`, hash: deposit.txHash },
      ...deposit.txs.map((tx) => ({ kind: "chain" as const, ...tx })),
    ],
    reason: deposit.reason,
    detectedAt: deposit.detectedAt,
    createdAt: deposit.detectedAt,
    updatedAt: deposit.updatedAt,
  };
}

/**
 * Operator / provider KYC review — the approval path that survives production.
 *
 * Without this the only way to approve anyone on a hosted deploy is
 * ALLOW_SIMULATION=1, which also re-opens simulated SEPA deposits and cash
 * pickup: you would have to turn on fake money to onboard a real user.
 *
 * A real provider integration (Sumsub/Persona) posts its decision here from
 * its webhook using the same token; it cannot hold a user session, which is
 * why this is not scoped under /users/:id.
 */
app.post(
  "/api/kyc/review",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const user = store.findUser(req.body?.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    const decision = readDecision(req.body, res);
    if (!decision) return;
    const result = await applyKycDecision(user, decision, "manual", req.body?.reason);
    console.log(`KYC: ${decision} for ${user.id} by operator`);
    res.json(result);
  }),
);

/**
 * Deployer float for the ops dashboard. The faucet and gas both spend from
 * this address, and running it dry fails silently at onboarding time — the
 * faucet logs "top it up" to a console nobody watches. 60s cache: the
 * dashboard polls every 10s and two RPC reads per tick would be rude.
 */
let deployerFloatCache: { at: number; value: { address: string; eur: number; eth: number } } | null = null;
async function deployerFloat() {
  if (deployerFloatCache && Date.now() - deployerFloatCache.at < 60_000) return deployerFloatCache.value;
  const address = deployerWallet.account.address;
  const [eth, eure] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>,
  ]);
  const value = { address, eur: eur.fromWei(eure), eth: Number(eth) / 1e18 };
  deployerFloatCache = { at: Date.now(), value };
  return value;
}

/**
 * Gas balances of every EOA that sends transactions for the platform. Each is
 * a distinct outage when dry, and the errors do not say which wallet is empty:
 * a dry CO-SIGNER fails every Safe debit with "gas required exceeds allowance
 * (0)" — which reads as a token-allowance problem and cost a day being chased
 * as one; a dry orchestrator fails swaps and escrow legs; a dry deployer
 * fails faucet grants. Name them, so the dashboard can too.
 */
let operatorGasCache: { at: number; value: { role: string; address: string; eth: number }[] } | null = null;
async function operatorGas() {
  if (operatorGasCache && Date.now() - operatorGasCache.at < 60_000) return operatorGasCache.value;
  const wallets: { role: string; address: `0x${string}` }[] = [
    { role: "co-signer (Safe debits)", address: (CANDIDE.cosignerAddress || "0x") as `0x${string}` },
    { role: "orchestrator (swap/escrow)", address: orchestratorAddress },
    { role: "deployer (faucet/gas)", address: deployerWallet.account.address },
  ];
  const value = await Promise.all(
    wallets
      .filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address))
      .map(async (w) => ({
        role: w.role,
        address: w.address,
        eth: Number(await publicClient.getBalance({ address: w.address })) / 1e18,
      })),
  );
  operatorGasCache = { at: Date.now(), value };
  return value;
}

app.get(
  "/api/admin/stats",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const users = store.users;
    const transfers = store.transfers;
    const totalUsers = users.length;
    const kycPending = users.filter((u) => u.kycStatus === "pending" || u.kycStatus === "manual_review").length;
    const kycApproved = users.filter((u) => u.kycStatus === "approved").length;
    const activeSafes = users.filter((u) => u.passkeySafe?.status === "active" || u.wallet?.deployed).length;
    const totalTransfers = transfers.length;
    const totalVolumeEur = transfers.reduce((sum, t) => sum + (t.sendEur || 0), 0);
    res.json({
      totalUsers,
      kycPending,
      kycApproved,
      activeSafes,
      totalTransfers,
      totalVolumeEur,
      faucetGrantEur: TESTNET_FAUCET.grantEur || 0,
      deployer: await deployerFloat().catch(() => null),
      operatorGas: await operatorGas().catch(() => null),
    });
  }),
);

app.get(
  "/api/admin/users",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const list = store.users.map((u) => publicUser(u));
    res.json(list);
  }),
);

app.get(
  "/api/admin/transactions",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    // Paginated, newest first: one leaked operator token should not dump the
    // whole ops ledger in a single request.
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const entries = [
      ...store.transfers.map(adminTransfer),
      ...store.cryptoDeposits.map(adminFunding),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    res.json({
      total: entries.length,
      offset,
      transactions: entries.slice(offset, offset + limit),
    });
  }),
);

app.post(
  "/api/admin/users/:id/issue-iban",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    /**
     * Honesty gates. This route mints a LOCAL display IBAN and marks funding
     * active. In sandbox mode Monerium issues real, routable IBANs through
     * the user's passkey ceremony — assigning a fabricated one here would
     * mask real funding state with an IBAN money can never reach (7 test
     * accounts carried exactly that). And skipping the custody gate makes an
     * account look fundable with no passkey Safe to receive anything.
     */
    if (moneriumSandboxEnabled()) {
      return res.status(409).json({
        error:
          "this deployment issues real Monerium IBANs — the user activates theirs with a passkey tap " +
          "(Activate IBAN on their home screen); a manually assigned IBAN would not be routable",
      });
    }
    const custodyBlocked = passkeyRequiredBeforeFunding(user);
    if (custodyBlocked) return res.status(409).json({ error: custodyBlocked });
    const iban = issueIban(user.id);
    const updated = store.updateUser(user.id, {
      iban,
      funding: { mode: "sandbox", status: "active", detail: "admin manual IBAN assignment" },
    });
    res.json(publicUser(updated));
  }),
);

app.post(
  "/api/webhooks/sumsub",
  wrap(async (req, res) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!SUMSUB.webhookSecretKey) return res.status(503).json({ error: "Sumsub webhook secret is not configured" });
    if (!raw || !verifySumsubWebhookDigest(
      SUMSUB.webhookSecretKey,
      raw,
      req.header("x-payload-digest") ?? undefined,
      req.header("x-payload-digest-alg") ?? "HMAC_SHA256_HEX",
    )) {
      return res.status(401).json({ error: "invalid Sumsub webhook signature" });
    }
    const payload = req.body ?? {};
    const decision = decisionFromSumsubWebhook(payload);
    if (!decision) return res.json({ ok: true, ignored: payload.type ?? "unknown" });
    const applicantId = typeof payload.applicantId === "string" ? payload.applicantId : undefined;
    const externalUserId = typeof payload.externalUserId === "string" ? payload.externalUserId : undefined;
    const userId = userIdFromSumsubExternalId(externalUserId);
    let user = (userId ? store.findUser(userId) : undefined) ??
      store.users.find((u) => u.kyc?.sumsub?.applicantId === applicantId);
    if (!user) return res.status(404).json({ error: "no local user for Sumsub applicant" });

    user = store.updateUser(user.id, {
      kyc: {
        ...user.kyc,
        provider: "sumsub",
        onboardingPath: "new_monerium",
        sumsub: {
          ...user.kyc?.sumsub,
          externalUserId: externalUserId ?? user.kyc?.sumsub?.externalUserId ?? sumsubExternalUserId(user.id),
          applicantId,
          reviewStatus: payload.reviewStatus,
          reviewAnswer: payload.reviewResult?.reviewAnswer,
          reviewedAt: new Date().toISOString(),
        },
      },
    });

    if (applicantId) {
      try {
        const applicant = await getSumsubApplicant(SUMSUB, applicantId);
        const senderProfile = senderProfileFromSumsubApplicant(applicant, user);
        if (senderProfile) user = store.updateUser(user.id, { senderProfile });
      } catch (err: any) {
        console.warn(`SUMSUB: applicant ${applicantId} data read failed for ${user.id}: ${err?.message ?? err}`);
      }
    }

    const reason = payload.reviewResult?.clientComment || payload.reviewResult?.moderationComment;
    const result = await applyKycDecision(user, decision, "sumsub", reason);
    if (decision === "approved" && applicantId) {
      try {
        user = await shareApprovedSumsubKycWithMonerium(store.findUser(user.id)!, applicantId);
      } catch (err: any) {
        const latest = store.findUser(user.id)!;
        store.updateUser(user.id, {
          kyc: {
            ...latest.kyc,
            provider: "sumsub",
            sumsub: {
              ...latest.kyc?.sumsub,
              externalUserId: latest.kyc?.sumsub?.externalUserId ?? sumsubExternalUserId(user.id),
              applicantId,
              moneriumShare: {
                profileId: latest.funding?.moneriumProfileId ?? latest.monerium?.profileId ?? MONERIUM.profileId,
                status: "error",
                updatedAt: new Date().toISOString(),
                error: String(err?.message ?? err).slice(0, 240),
              },
            },
          },
        });
        console.warn(`SUMSUB: Monerium KYC share failed for ${user.id}: ${err?.message ?? err}`);
      }
    }
    console.log(`SUMSUB: ${decision} for ${user.id} applicant ${applicantId ?? "(unknown)"}`);
    res.json({ ok: true, userId: user.id, kycStatus: result.kycStatus });
  }),
);

app.get(
  "/api/users/:id/recovery",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const blocked = assertRecoveryAvailable(user);
    res.json({
      managedKycGuardian: RECOVERY.managedKycGuardian,
      available: !blocked,
      blocked,
      delayHours: RECOVERY.delayHours,
      guardianAddress: user.passkeySafe?.recovery?.guardianAddress,
      recoveryModuleAddress: user.passkeySafe?.recovery?.moduleAddress,
      requests: recoveryPublicList(user.id),
    });
  }),
);

app.post(
  "/api/users/:id/recovery/requests",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const newOwnerAddress = req.body?.newOwnerAddress;
    if (newOwnerAddress !== undefined && !isEvmAddress(newOwnerAddress)) {
      return res.status(400).json({ error: "newOwnerAddress must be a 0x address" });
    }
    try {
      const request = buildRecoveryRequest(
        user,
        randomUUID(),
        new Date(),
        newOwnerAddress,
        user.email,
      );
      store.addRecoveryRequest(request);
      res.status(201).json(publicRecoveryRequest(request));
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err) });
    }
  }),
);

app.post(
  "/api/recovery/requests",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const user = store.findUser(req.body?.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    const newOwnerAddress = req.body?.newOwnerAddress;
    if (newOwnerAddress !== undefined && !isEvmAddress(newOwnerAddress)) {
      return res.status(400).json({ error: "newOwnerAddress must be a 0x address" });
    }
    const contact = typeof req.body?.contact === "string" ? req.body.contact.slice(0, 120) : user.email;
    try {
      const request = buildRecoveryRequest(user, randomUUID(), new Date(), newOwnerAddress, contact);
      store.addRecoveryRequest(request);
      console.log(`RECOVERY: request ${request.id} opened for ${user.id} by ${operatorLabel(req)}`);
      res.status(201).json(publicRecoveryRequest(request));
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err) });
    }
  }),
);

app.post(
  "/api/recovery/requests/:id/approve",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    const request = store.findRecoveryRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "recovery request not found" });
    const user = store.findUser(request.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    const blocked = assertRecoveryAvailable(user);
    if (blocked) return res.status(409).json({ error: blocked });
    try {
      const approved = approveRecoveryRequest(
        request,
        new Date(),
        operatorLabel(req),
        typeof req.body?.reason === "string" ? req.body.reason : undefined,
      );
      const updated = store.updateRecoveryRequest(request.id, approved);
      console.log(`RECOVERY: request ${request.id} approved; ready at ${updated.readyAt}`);
      res.json(publicRecoveryRequest(updated));
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err) });
    }
  }),
);

app.post(
  "/api/recovery/requests/:id/cancel",
  wrap(async (req, res) => {
    const request = store.findRecoveryRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "recovery request not found" });
    const operator = bearerToken(req) && KYC.operatorToken && bearerToken(req) === KYC.operatorToken;
    if (!operator && !requireUserSession(req, res, request.userId)) return;
    if (["FINALIZED", "CANCELED", "EXPIRED", "GUARDIAN_SUBMITTED"].includes(request.status)) {
      return res.status(409).json({ error: `recovery request is ${request.status}` });
    }
    const updated = store.updateRecoveryRequest(request.id, {
      status: "CANCELED",
      canceledAt: new Date().toISOString(),
      cancelReason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
    });
    res.json(publicRecoveryRequest(updated));
  }),
);

app.post(
  "/api/recovery/requests/:id/guardian-submit",
  wrap(async (req, res) => {
    if (!requireOperator(req, res)) return;
    let request = store.findRecoveryRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "recovery request not found" });
    const status = readinessStatus(request, new Date());
    if (status !== request.status) request = store.updateRecoveryRequest(request.id, { status });
    try {
      const guardianSubmission = await submitGuardianRecovery(request, new Date());
      const updated = store.updateRecoveryRequest(request.id, {
        status: "GUARDIAN_SUBMITTED",
        guardianSubmission,
      });
      console.log(`RECOVERY: guardian signer accepted request ${request.id}`);
      res.json(publicRecoveryRequest(updated));
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const statusCode = message.includes("RECOVERY_GUARDIAN_SIGNER_URL") ? 503 : 409;
      const updated = store.updateRecoveryRequest(request.id, {
        guardianSubmission: {
          mode: "external_signer",
          requestedAt: new Date().toISOString(),
          error: message.slice(0, 240),
        },
      });
      res.status(statusCode).json({ ...publicRecoveryRequest(updated), error: message });
    }
  }),
);

app.get(
  "/api/recovery/requests/:id",
  wrap(async (req, res) => {
    const request = store.findRecoveryRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "recovery request not found" });
    const operator = bearerToken(req) && KYC.operatorToken && bearerToken(req) === KYC.operatorToken;
    if (!operator && !requireUserSession(req, res, request.userId)) return;
    const status = readinessStatus(request, new Date());
    const latest = status === request.status ? request : store.updateRecoveryRequest(request.id, { status });
    res.json({
      ...publicRecoveryRequest(latest),
      guardianAction:
        latest.status === "READY_FOR_GUARDIAN"
          ? "POST /api/recovery/requests/:id/guardian-submit to hand off to the isolated guardian signer"
          : latest.status === "GUARDIAN_SUBMITTED"
            ? "guardian signer accepted the recovery handoff; watch the on-chain SocialRecoveryModule recovery state"
          : undefined,
    });
  }),
);

/** Local demo convenience: the user drives their own KYC decision. Gated on
 *  ALLOW_SIMULATION because it is self-approval — see /api/kyc/review for the
 *  path that works in production. */
app.post(
  "/api/users/:id/kyc/mock-review",
  wrap(async (req, res) => {
    if (!SECURITY.allowSimulation || !isLocalRequest(req)) {
      return res.status(403).json({
        error: "mock KYC review is disabled in production — use POST /api/kyc/review with an operator token",
      });
    }
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const decision = readDecision(req.body, res);
    if (!decision) return;
    res.json(await applyKycDecision(user, decision, "mock", req.body?.reason));
  }),
);

app.delete(
  "/api/session",
  wrap(async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    store.revokeSession(session.id);
    res.status(204).end();
  }),
);

app.get(
  "/api/session",
  wrap(async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const user = store.findUser(session.userId);
    if (!user) return res.status(404).json({ error: "session user not found" });
    const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
    res.json({ ...publicUser(user), ...balances });
  }),
);

// --- Passkeys (FP2: full WebAuthn verification) ------------------------------
// Registration parses and verifies the attestation (challenge, origin,
// rpIdHash) and stores the COSE public key + sign counter. Login verifies the
// assertion signature server-side before a session is issued.

app.post(
  "/api/webauthn/challenge",
  wrap(async (req, res) => {
    const purpose =
      req.body?.purpose === "register"
        ? "register"
        : req.body?.purpose === "step_up"
          ? "step_up"
          : "login";
    // register and step_up act on a known account, so the challenge is bound to
    // it: an assertion collected for one account can no longer be spent on
    // another's step-up. Login is unbound by necessity — there is no session yet.
    let binding: string | undefined;
    if (purpose !== "login") {
      const session = requireSession(req, res);
      if (!session) return;
      binding = session.userId;
    }
    res.json({ challenge: issueChallenge(purpose, binding), rpId: SECURITY.rpId });
  }),
);

app.post(
  "/api/users/:id/passkey",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const { credentialId, attestation, clientDataJSON } = req.body ?? {};
    if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
      return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
    }
    if (store.findUserByCredential(credentialId)) {
      return res.status(409).json({ error: "credential already registered" });
    }
    // Replacing the account's authenticator is an account-takeover path if a
    // bearer token is enough for it: a stolen 24h session would become permanent
    // access, and the real passkey would be silently discarded. The current
    // authenticator has to approve its own replacement. First registration (no
    // verified passkey yet) is unaffected.
    if (user.passkey?.publicKey && !(await verifyPasskeyStepUp(user, req.body, res))) return;
    let reg;
    try {
      reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins, user.id);
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
    }
    if (reg.credentialId !== credentialId) {
      return res.status(400).json({ error: "credentialId does not match attestation" });
    }
    const passkey = {
      credentialId,
      publicKey: reg.key,
      signCount: reg.signCount,
      rpId: SECURITY.rpId,
      attestation,
      createdAt: new Date().toISOString(),
    };
    const plannedSafe = passkeySafePlan(user, reg.key);
    const updated = store.updateUser(user.id, {
      passkey: {
        ...passkey,
      },
      ...(plannedSafe ? { passkeySafe: plannedSafe } : {}),
    });
    res.status(201).json(publicUser(updated));
  }),
);

app.post(
  "/api/users/:id/passkey-safe/deployment",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!user.passkey?.publicKey || !user.passkeySafe) {
      return res.status(409).json({ error: "register a passkey before preparing the passkey Safe" });
    }
    if (user.passkeySafe.status === "active") {
      return res.json({ safeAddress: user.passkeySafe.address, status: "active" });
    }
    if (user.passkeySafe.cosignerAddress && !CANDIDE.cosignerKey) {
      return res.status(503).json({ error: "CANDIDE_COSIGNER_KEY is required before passkey Safe deployment" });
    }
    /**
     * Deploying a passkey Safe goes through an ERC-4337 bundler and paymaster.
     * A local hardhat node has neither, so under `npm run dev` this reaches
     * Candide asking about CANDIDE_CHAIN_ID for a Safe that exists only on this
     * machine, and the browser reports the network failure as "Failed to fetch"
     * — which reads as a bug in our code rather than a chain that cannot do the
     * operation.
     *
     * Explain it when it happens rather than refusing up front: an already
     * deployed Safe short-circuits before any bundler call, and that path works
     * locally (monerium:oauth:test relies on it). Guessing ahead of the failure
     * broke a passing flow.
     */
    let deployment: Awaited<ReturnType<typeof preparePasskeySafeDeployment>>;
    try {
      deployment = await preparePasskeySafeDeployment(user.passkeySafe);
    } catch (err: any) {
      const mismatch = BigInt(CHAIN_ID) !== BigInt(CANDIDE.chainId);
      return res.status(mismatch ? 409 : 502).json({
        error: mismatch
          ? `passkey Safe deployment needs an ERC-4337 bundler. This API is on chain ${CHAIN_ID} ` +
            `while Candide is configured for chain ${CANDIDE.chainId}, and a local hardhat node has ` +
            `no bundler or paymaster. Run against chain ${CANDIDE.chainId} (npm run api) rather than ` +
            `npm run dev. Underlying error: ${err?.message ?? err}`
          : `passkey Safe deployment failed: ${err?.message ?? err}`,
      });
    }
    if (deployment.challenge === "0x") {
      const updated = store.updateUser(user.id, {
        address: user.passkeySafe.address,
        wallet: { type: "candide-safe", deployed: true },
        passkeySafe: activatePasskeySafePlan(user.passkeySafe),
      });
      return res.json(publicUser(updated));
    }
    prunePendingPasskeySafeDeployments();
    const requestId = randomUUID();
    pendingPasskeySafeDeployments.set(requestId, {
      userId: user.id,
      expiresAt: Date.now() + 5 * 60_000,
      userOperation: deployment.userOperation,
    });
    res.status(201).json({
      requestId,
      safeAddress: deployment.safeAddress,
      credentialId: user.passkey.credentialId,
      challenge: passkeySafeChallenge(deployment.challenge),
      submitTo: `/api/users/${user.id}/passkey-safe/deployment/${requestId}`,
    });
  }),
);

app.post(
  "/api/users/:id/passkey-safe/deployment/:requestId",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!user.passkeySafe) return res.status(409).json({ error: "no passkey Safe plan for this account" });
    prunePendingPasskeySafeDeployments();
    const pending = pendingPasskeySafeDeployments.get(req.params.requestId);
    if (!pending || pending.userId !== user.id) {
      return res.status(404).json({ error: "passkey Safe deployment request not found or expired" });
    }
    const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (!authenticatorData || !clientDataJSON || !signature) {
      return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
    }
    const balances = await accountBalances(user.address);
    if (balances.safeBalanceEur > 0) {
      return res.status(409).json({
        error: "current account still has funds; move balances before activating the passkey Safe address",
        ...balances,
      });
    }
    const opHash = await submitPasskeySafeDeployment(user.passkeySafe, pending.userOperation, {
      authenticatorData: b64urlToBuf(authenticatorData),
      clientDataJSON: b64urlToBuf(clientDataJSON),
      signature: b64urlToBuf(signature),
    });
    pendingPasskeySafeDeployments.delete(req.params.requestId);
    let updated = store.updateUser(user.id, {
      address: user.passkeySafe.address,
      wallet: { type: "candide-safe", deployed: true, deployOpHash: opHash ?? undefined },
      passkeySafe: activatePasskeySafePlan(user.passkeySafe),
    });
    // The Safe can be linked to Monerium now, but the link signature is a
    // passkey ceremony the client drives next. Until this patch, an account
    // whose deploy happened after KYC approval kept the stale pre-deploy
    // funding error forever and nothing ever issued its IBAN. Record where
    // provisioning actually stands so both the client and a reload know the
    // one remaining step.
    if (sandbox && updated.kycStatus === "approved" && !updated.iban && updated.funding?.status !== "active") {
      updated = store.updateUser(user.id, {
        funding: {
          ...(updated.funding ?? {}),
          mode: "sandbox",
          status: "provisioning",
          detail: "smart wallet deployed — approve IBAN issuance with your passkey",
        },
      });
    }
    // Fire-and-forget: the testnet faucet seeds the new Safe with EURe, and
    // its failure must never fail a deployment that already succeeded.
    void faucetFundSafe(user.id);
    res.status(201).json({ ...publicUser(updated), deployOpHash: opHash });
  }),
);

/**
 * What the chain says the co-signer may spend from this Safe. The database
 * records what deployment intended; debits read the chain, and the two have
 * disagreed — Safes deployed against a codeless allowance module are active,
 * hold money, and cannot debit. The client uses this to offer the repair.
 */
app.get(
  "/api/users/:id/passkey-safe/allowance",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const active =
      user.passkeySafe?.status === "active" &&
      user.address.toLowerCase() === user.passkeySafe.address.toLowerCase();
    if (!active) return res.json({ configured: false, reason: "no active passkey Safe" });
    if (!CANDIDE.cosignerAddress || !CANDIDE.cosignerKey) {
      return res.json({ configured: false, reason: "no co-signer configured on this deployment" });
    }
    const a = await readCosignerTokenAllowance(user.address, addrs().eure);
    res.json({
      configured: Boolean(a && a.amount > 0n),
      remainingEur: a ? eur.fromWei(a.remaining) : 0,
    });
  }),
);

app.post(
  "/api/users/:id/passkey-safe/allowance",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
      return res.status(409).json({ error: "an active passkey Safe is required before configuring its allowance" });
    }
    if (!CANDIDE.cosignerAddress || !CANDIDE.cosignerKey) {
      return res.status(503).json({ error: "CANDIDE_COSIGNER_ADDRESS and CANDIDE_COSIGNER_KEY are required to configure a spending allowance" });
    }
    const plan = { ...user.passkeySafe, cosignerPolicy: currentCosignerPolicy() };
    let prepared: Awaited<ReturnType<typeof preparePasskeySafeAllowanceSetup>>;
    try {
      prepared = await preparePasskeySafeAllowanceSetup(plan);
    } catch (err: any) {
      return res.status(502).json({ error: `allowance setup failed: ${err?.message ?? err}` });
    }
    prunePendingAllowanceSetups();
    const requestId = randomUUID();
    pendingAllowanceSetups.set(requestId, {
      userId: user.id,
      expiresAt: Date.now() + 5 * 60_000,
      plan,
      userOperation: prepared.userOperation,
    });
    res.status(201).json({
      requestId,
      safeAddress: prepared.safeAddress,
      credentialId: user.passkey.credentialId,
      challenge: passkeySafeChallenge(prepared.challenge),
      rpId: user.passkey.rpId ?? SECURITY.rpId,
      submitTo: `/api/users/${user.id}/passkey-safe/allowance/${requestId}`,
    });
  }),
);

app.post(
  "/api/users/:id/passkey-safe/allowance/:requestId",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!user.passkeySafe) return res.status(409).json({ error: "no passkey Safe for this account" });
    prunePendingAllowanceSetups();
    const pending = pendingAllowanceSetups.get(req.params.requestId);
    if (!pending || pending.userId !== user.id) {
      return res.status(404).json({ error: "allowance setup request not found or expired" });
    }
    const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (!authenticatorData || !clientDataJSON || !signature) {
      return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
    }
    const opHash = await submitPasskeySafeDeployment(pending.plan, pending.userOperation, {
      authenticatorData: b64urlToBuf(authenticatorData),
      clientDataJSON: b64urlToBuf(clientDataJSON),
      signature: b64urlToBuf(signature),
    });
    pendingAllowanceSetups.delete(req.params.requestId);
    // Record the policy that is now actually on-chain. plan.cosignerAddress
    // (the owner set) is deliberately untouched: owners did not change.
    const updated = store.updateUser(user.id, {
      passkeySafe: { ...user.passkeySafe, cosignerPolicy: pending.plan.cosignerPolicy },
    });
    res.status(201).json({ ...publicUser(updated), allowanceOpHash: opHash });
  }),
);

app.post(
  "/api/passkey/login",
  wrap(async (req, res) => {
    const { credentialId, authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
      return res.status(400).json({ error: "credentialId, authenticatorData, clientDataJSON and signature required" });
    }
    // Also limit per credential: the per-IP bucket does nothing against attempts
    // spread across many sources at one account.
    if (!rateLimit(`c:${tokenHash(String(credentialId))}`, SECURITY.authRateLimitPerMin)) {
      return res.status(429).json({ error: "rate limited — slow down" });
    }
    const user = store.findUserByCredential(credentialId);
    if (!user?.passkey?.publicKey) {
      return res.status(404).json({ error: "no verified passkey for this credential — register again" });
    }
    try {
      const { signCount } = await verifyAssertion(
        authenticatorData,
        clientDataJSON,
        signature,
        user.passkey.publicKey,
        user.passkey.signCount ?? 0,
        user.passkey.rpId ?? SECURITY.rpId,
        SECURITY.origins,
      );
      store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
    } catch (err: any) {
      return res.status(401).json({ error: String(err?.message ?? err) });
    }
    const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
    res.json({ ...withSession(user), ...balances });
  }),
);

async function verifyPasskeyStepUp(user: User, body: any, res: express.Response): Promise<boolean> {
  if (!user.passkey?.publicKey) {
    if (SECURITY.allowSimulation) return true;
    res.status(409).json({ error: "a verified passkey is required before binding a spending key" });
    return false;
  }
  const stepUp = body?.stepUp ?? {};
  const { credentialId, authenticatorData, clientDataJSON, signature } = stepUp;
  if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
    res.status(401).json({ error: "fresh passkey approval required before binding a spending key" });
    return false;
  }
  if (credentialId !== user.passkey.credentialId) {
    res.status(403).json({ error: "passkey credential does not match this account" });
    return false;
  }
  try {
    const { signCount } = await verifyAssertion(
      authenticatorData,
      clientDataJSON,
      signature,
      user.passkey.publicKey,
      user.passkey.signCount ?? 0,
      user.passkey.rpId ?? SECURITY.rpId,
      SECURITY.origins,
      "step_up",
      user.id,
    );
    store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
    return true;
  } catch (err: any) {
    res.status(401).json({ error: String(err?.message ?? err) });
    return false;
  }
}

// --- Funding (mock Monerium SEPA webhook) -----------------------------------

app.post(
  "/api/simulate/sepa-deposit",
  wrap(async (req, res) => {
    if (!requireSimulationAllowed(req, res)) return;
    if (sandbox) {
      return res.status(400).json({
        error:
          "sandbox mode: make a (simulated) SEPA transfer to the IBAN from the Monerium sandbox portal — deposits are picked up automatically",
      });
    }
    const { iban, amountEur } = req.body ?? {};
    const amount = Number(amountEur);
    if (!iban || !(amount > 0)) return res.status(400).json({ error: "iban and amountEur required" });
    const user = store.findUserByIban(iban);
    if (!user) return res.status(404).json({ error: "no account with that IBAN" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    const ref = `sepa-${randomUUID()}`;
    const txs = await simulateSepaDeposit(user.address, amount, ref);
    const balances = await accountBalances(user.address);
    res.json({ credited: amount, ...balances, paymentRef: ref, ...txs });
  }),
);

// --- Quotes & transfers ------------------------------------------------------

app.post(
  "/api/quotes",
  wrap(async (req, res) => {
    const { userId, sendEur, rail = "cash" } = req.body ?? {};
    const user = store.findUser(userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    if (!["cash", "sepa"].includes(rail)) {
      return res.status(400).json({ error: "rail must be cash or sepa" });
    }
    const amount = Number(sendEur);
    if (!(amount > FX.FIXED_FEE_EUR)) {
      return res.status(400).json({ error: `amount must exceed the €${FX.FIXED_FEE_EUR} fee` });
    }
    if (amount > FX.DAILY_CAP_EUR) {
      return res.status(400).json({ error: `amount exceeds daily cap of €${FX.DAILY_CAP_EUR}` });
    }
    res.status(201).json(await createQuote(userId, { rail, sendEur: amount }));
  }),
);

app.post(
  "/api/transfers",
  wrap(async (req, res) => {
    const { quoteId, recipientName, recipientPhone, recipientIban, reference } = req.body ?? {};
    const quote = store.findQuote(quoteId);
    if (!quote) return res.status(404).json({ error: "quote not found" });
    if (!requireUserSession(req, res, quote.userId)) return;
    if ((quote.status ?? "OPEN") !== "OPEN") {
      return res.status(409).json({ error: `quote already ${quote.status.toLowerCase()}` });
    }
    if (isExpired(quote)) {
      store.updateQuote(quote.id, { status: "EXPIRED" });
      return res.status(410).json({ error: "quote expired, request a new one" });
    }
    if (!recipientName) {
      return res.status(400).json({ error: "recipientName required" });
    }
    if (quote.rail === "sepa" && !recipientIban) {
      return res.status(400).json({ error: "recipientIban required for bank payout" });
    }
    if (quote.rail === "cash" && !recipientPhone) {
      return res.status(400).json({ error: "recipientPhone required for cash pickup" });
    }
    // Remittance reference: carried to the payee on the SEPA rail so they can
    // reconcile the payment against their own records. Refused rather than
    // truncated past the scheme's 140 characters — the caller is reconciling on
    // this string, so a silently shortened one is worse than an error.
    if (reference !== undefined && reference !== null) {
      if (typeof reference !== "string") {
        return res.status(400).json({ error: "reference must be a string" });
      }
      if (reference.length > SEPA_REMITTANCE_MAX) {
        return res.status(400).json({
          error: `reference must be ${SEPA_REMITTANCE_MAX} characters or fewer (SEPA remittance limit)`,
        });
      }
      if (quote.rail !== "sepa") {
        return res.status(400).json({
          error: "reference is only carried on the sepa rail",
        });
      }
    }
    const user = store.findUser(quote.userId)!;
    if (!requireKycApproved(user, res)) return;
    const balances = await accountBalances(user.address);
    const fundingSource: Transfer["fundingSource"] = "safe";
    if (balances.safeBalanceEur < quote.sendEur) {
      return res.status(400).json({
        error: `insufficient Safe balance (€${balances.safeBalanceEur.toFixed(2)})`,
      });
    }
    const debitBlocker = safeDebitBlocker(user);
    if (fundingSource === "safe" && debitBlocker) {
      return res.status(409).json({
        error: debitBlocker,
        safeBalanceEur: balances.safeBalanceEur,
      });
    }
    if (!(await assertDailyCap(user, quote.sendEur, res))) return;

    const createdAt = new Date().toISOString();
    const transfer: Transfer = {
      id: randomUUID(),
      userId: user.id,
      quoteId: quote.id,
      rail: quote.rail,
      recipientName,
      recipientPhone,
      recipientIban,
      reference: reference || undefined,
      state: "CREATED" as const,
      sendEur: quote.sendEur,
      receiveKes: quote.receiveKes,
      receiveEur: quote.receiveEur,
      fundingSource,
      txs: [],
      createdAt,
      updatedAt: createdAt,
    };
    if (transfer.rail === "sepa" && transfer.recipientIban) {
      const payoutEur = transfer.receiveEur ?? transfer.sendEur - FX.FIXED_FEE_EUR;
      const redeem = moneriumRedeemMessage(payoutEur, transfer.recipientIban, createdAt);
      transfer.moneriumRedeem = {
        ...redeem,
        memo: paymentMemo(transfer.id, transfer.reference),
      };
    }
    // The account must be bound to a device key before it can spend.
    const authorizer = user.authorizerAddress;
    if (!authorizer) {
      return res.status(409).json({
        error: "no device key registered for this account — POST /api/users/:id/authorizer first",
      });
    }
    if (!store.consumeQuote(quote.id)) {
      return res.status(409).json({ error: "quote already consumed" });
    }
    // Fix the exact terms the device is asked to sign. Nothing moves until a
    // matching signature comes back to /authorize. The destination commitment
    // binds the payout target into the signature (see destinationCommitment):
    // the device signs *who* is paid, not only how much.
    const amountWei = eur.toWei(transfer.sendEur);
    const deadline = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC;
    const destination = destinationCommitment(transfer.rail, {
      phone: transfer.recipientPhone,
      iban: transfer.recipientIban,
      name: transfer.recipientName,
    });
    transfer.auth = { to: orchestratorAddress, amountWei: amountWei.toString(), destination, deadline };
    store.addTransfer(transfer);
    res.status(201).json({
      ...transfer,
      authorization: {
        authorizer,
        typedData: paymentAuthorizationTypedData({
          account: user.address,
          amountWei,
          to: orchestratorAddress,
          transferId: transferIdHash(transfer.id),
          destination,
          deadline,
        }),
        moneriumRedeem: transfer.moneriumRedeem
          ? {
              amount: transfer.moneriumRedeem.amount,
              iban: transfer.moneriumRedeem.iban,
              issuedAt: transfer.moneriumRedeem.issuedAt,
              message: transfer.moneriumRedeem.message,
              memo: transfer.moneriumRedeem.memo,
              credentialId: user.passkey?.credentialId,
              challenge: user.passkeySafe?.status === "active"
                ? passkeySafeChallenge(safeMessageHash(user.address, transfer.moneriumRedeem.message))
                : undefined,
            }
          : undefined,
        submitTo: `/api/transfers/${transfer.id}/authorize`,
      },
    });
  }),
);

app.get(
  "/api/users/:id/transfers",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const transfers = store.transfers
      .filter((t) => t.userId === user.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ transfers });
  }),
);

app.get(
  "/api/users/:id/activity",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const transfers = store.transfers
      .filter((t) => t.userId === user.id)
      .map((t) => ({ kind: "transfer" as const, at: t.createdAt, ...t }));
    const funding = store.cryptoDeposits
      .filter((d) => d.userId === user.id)
      .map((d) => ({
        kind: "funding" as const,
        id: d.id,
        at: d.detectedAt,
        chainId: d.chainId,
        token: d.token,
        txHash: d.txHash,
        amountEur: d.amountEur ?? d.creditedEur,
        amountUsdc: d.amountUsdc ?? d.creditedUsdc,
        state: d.state,
        reason: d.reason,
        settlementAsset: d.settlementAsset,
        detectedAt: d.detectedAt,
        updatedAt: d.updatedAt,
      }));
    res.json({
      activity: [...transfers, ...funding].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    });
  }),
);

app.get(
  "/api/transfers/:id",
  wrap(async (req, res) => {
    const t = store.findTransfer(req.params.id);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(t);
  }),
);

app.post(
  "/api/transfers/:id/refresh-payout",
  wrap(async (req, res) => {
    const t = store.findTransfer(req.params.id);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(await refreshPayout(t, { timeoutMs: 0 }));
  }),
);

// Monerium webhook receiver (production path; polling covers local dev).
/**
 * Register the device key that may authorize transfers from this account.
 * The browser generates the key, keeps the private half, and sends only the
 * address. This binding is app state until Safe-native module policies replace
 * it on-chain.
 */
app.post(
  "/api/users/:id/authorizer",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    if (!(await verifyPasskeyStepUp(user, req.body, res))) return;
    const address = req.body?.address;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: "address required (0x-prefixed, 20 bytes)" });
    }
    if (user.authorizerAddress) {
      if (user.authorizerAddress.toLowerCase() !== address.toLowerCase()) {
        return res.status(409).json({
          error: "this account is already bound to a different device key — rotate it from that device",
          authorizerAddress: user.authorizerAddress,
        });
      }
      return res.json(publicUser(user));
    }
    const updated = store.updateUser(user.id, { authorizerAddress: address as `0x${string}` });
    res.status(201).json(publicUser(updated));
  }),
);

/**
 * FP4: submit the device signature for a CREATED transfer and execute it.
 * The terms were fixed at creation, so the signature covers exactly what the
 * orchestrator submits — it cannot re-price or redirect the payment.
 */
app.post(
  "/api/transfers/:id/authorize",
  wrap(async (req, res) => {
    const transfer = store.findTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, transfer.userId)) return;
    if (transfer.state !== "CREATED") {
      return res.status(409).json({ error: `transfer is ${transfer.state}, expected CREATED` });
    }
    if (!transfer.auth) return res.status(409).json({ error: "transfer has no authorization terms" });
    const signature = req.body?.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return res.status(400).json({ error: "signature required" });
    }
    if (Date.now() / 1000 > transfer.auth.deadline) {
      return res.status(410).json({ error: "authorization window expired, create a new transfer" });
    }
    let executableTransfer = transfer;
    const redeemSignature = req.body?.moneriumRedeemSignature;
    if (redeemSignature !== undefined) {
      if (!transfer.moneriumRedeem) {
        return res.status(400).json({ error: "this transfer has no Monerium redeem authorization terms" });
      }
      if (typeof redeemSignature !== "string" || !/^0x[0-9a-fA-F]+$/.test(redeemSignature)) {
        return res.status(400).json({ error: "moneriumRedeemSignature must be a 0x signature" });
      }
    }
    let user = store.findUser(transfer.userId)!;
    if (!requireKycApproved(user, res)) return;
    let effectiveRedeemSignature = typeof redeemSignature === "string" ? redeemSignature as `0x${string}` : undefined;
    const redeemAssertion = req.body?.moneriumRedeemAssertion;
    if (!effectiveRedeemSignature && redeemAssertion !== undefined) {
      if (!transfer.moneriumRedeem) {
        return res.status(400).json({ error: "this transfer has no Monerium redeem authorization terms" });
      }
      if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
        return res.status(409).json({ error: "active passkey Safe required for Monerium redeem authorization" });
      }
      const passkeySafe = user.passkeySafe;
      const { credentialId, authenticatorData, clientDataJSON, signature: assertionSignature } = redeemAssertion ?? {};
      if (credentialId !== user.passkey.credentialId) {
        return res.status(403).json({ error: "passkey credential does not match this account" });
      }
      if (!authenticatorData || !clientDataJSON || !assertionSignature) {
        return res.status(400).json({ error: "moneriumRedeemAssertion requires authenticatorData, clientDataJSON and signature" });
      }
      const expectedChallenge = passkeySafeChallenge(safeMessageHash(user.address, transfer.moneriumRedeem.message));
      try {
        const { signCount } = await verifyAssertionForChallenge(
          authenticatorData,
          clientDataJSON,
          assertionSignature,
          user.passkey.publicKey,
          user.passkey.signCount ?? 0,
          user.passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          expectedChallenge,
          true,
        );
        user = store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
        effectiveRedeemSignature = await signMessageAsPasskeySafe(
          passkeySafe,
          user.address,
          transfer.moneriumRedeem.message,
          {
            authenticatorData: b64urlToBuf(authenticatorData),
            clientDataJSON: b64urlToBuf(clientDataJSON),
            signature: b64urlToBuf(assertionSignature),
          },
        );
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }
    }
    if (
      transfer.rail === "sepa" &&
      transfer.moneriumRedeem &&
      !effectiveRedeemSignature
    ) {
      return res.status(400).json({
        error: "passkey Safe Monerium redeem approval is required before this SEPA transfer can execute",
      });
    }
    // Claim the authorization before execution. Two parallel submissions of the
    // same signature both used to clear the CREATED check above, and both could
    // submit the same spend. claimAuthorization is the atomic boundary: after it
    // succeeds once, every other caller sees the authorizedAt marker and stops.
    if (!store.claimAuthorization(transfer.id)) {
      return res.status(409).json({ error: "authorization already submitted for this transfer" });
    }
    if (effectiveRedeemSignature && transfer.moneriumRedeem) {
      executableTransfer = store.updateTransfer(transfer.id, {
        moneriumRedeem: {
          ...transfer.moneriumRedeem,
          signature: effectiveRedeemSignature,
          signedAt: new Date().toISOString(),
        },
      });
    } else {
      executableTransfer = store.findTransfer(transfer.id)!;
    }
    const auth = { deadline: transfer.auth.deadline, signature: signature as `0x${string}` };
    const result =
      executableTransfer.rail === "sepa"
        ? await executeSepaTransfer(executableTransfer, user, auth)
        : await executeTransfer(executableTransfer, user, auth);
    res.status(result.state === "FAILED" ? 502 : 200).json(result);
  }),
);

/**
 * Verify the shared-secret HMAC on a Monerium webhook.
 *
 * Returns true when no secret is configured — the endpoint is still safe in
 * that case because handleWebhookEvent re-reads the order from Monerium and
 * ignores everything else in the body. Set MONERIUM_WEBHOOK_SECRET to also
 * keep strangers from making us do the lookup.
 *
 * Monerium signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with the
 * base64-decoded `whsec_...` secret and sends `webhook-signature: v1,<base64>`.
 */
/**
 * The signed timestamp is what stops a captured delivery being replayed years
 * later. Delivery-id dedupe only rejects ids we have already seen, so it does
 * nothing for a capture we never received. Accepts both the ISO-8601 and the
 * unix-seconds forms, since we have not seen a real Monerium delivery yet.
 * MONERIUM_WEBHOOK_TOLERANCE_SEC=0 disables the check.
 */
export function withinReplayWindow(
  timestamp: string,
  toleranceSec = SECURITY.webhookToleranceSec,
  now = Date.now(),
): boolean {
  if (!toleranceSec) return true;
  const asNumber = Number(timestamp);
  const sentMs = Number.isFinite(asNumber) && timestamp.trim() !== ""
    ? asNumber * 1000
    : Date.parse(timestamp);
  if (!Number.isFinite(sentMs)) return false;
  return Math.abs(now - sentMs) <= toleranceSec * 1000;
}

function verifyWebhookSignature(req: express.Request): boolean {
  const secret = SECURITY.moneriumWebhookSecret;
  if (!secret) return true;
  const id = req.header("webhook-id") ?? "";
  const timestamp = req.header("webhook-timestamp") ?? "";
  const provided = req.header("webhook-signature") ?? "";
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!id || !timestamp || !raw || !provided) return false;
  if (!withinReplayWindow(timestamp)) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
  const expected = `v1,${createHmac("sha256", key).update(signed).digest("base64")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post(
  "/api/webhooks/monerium",
  wrap(async (req, res) => {
    if (!sandbox) return res.status(400).json({ error: "monerium sandbox not configured" });
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ error: "invalid webhook signature" });
    }
    const webhookId = req.header("webhook-id");
    if (webhookId && store.isWebhookProcessed(webhookId)) {
      return res.json({ handled: false, duplicate: true });
    }
    const result = await handleWebhookEvent(req.body);
    // Only spend the delivery id on a settled answer. `unavailable` means we
    // could not reach Monerium to check — marking it processed would make our
    // own outage look like a duplicate when Monerium retries the same id, and
    // the deposit would never arrive by this path. 503 asks for that retry.
    if (result.outcome === "unavailable") {
      return res.status(503).json({ ...result, retry: true });
    }
    if (webhookId) store.markWebhookProcessed(webhookId);
    res.json(result);
  }),
);

// Simulate the recipient collecting cash at a MoneyGram agent.
app.post(
  "/api/simulate/pickup",
  wrap(async (req, res) => {
    if (!requireSimulationAllowed(req, res)) return;
    const t = store.findTransfer(req.body?.transferId);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(await settlePickup(t));
  }),
);

app.use(((err, _req, res, _next) => {
  console.error(err);
  const detail = String(err?.shortMessage ?? err?.message ?? err);
  res.status(500).json({ error: SECURITY.exposeInternalErrors ? detail : "internal server error" });
}) as express.ErrorRequestHandler);

initStore();
// Fail fast on a chain mismatch: signatures built for the wrong chain id are
// rejected as "bad authorization", which reads like a signing bug.
assertChainMatches().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
// Same class of problem, quieter symptom: the smart-account chain can differ
// from the app chain without anything throwing.
warnIfSmartAccountChainDiffers();
// FP3: compensate anything stranded by a crash or failed payout, then keep
// sweeping in the background.
sweepStrandedTransfers()
  .then((n) => n && console.log(`FP3 sweep: compensated ${n} stranded transfer(s)`))
  .catch((e) => console.error(`FP3 sweep failed: ${e?.message ?? e}`));
setInterval(() => sweepStrandedTransfers().catch(() => {}), 5 * 60_000).unref();
sweepAnchorPayouts()
  .then((n) => n && console.log(`anchor sweep: refreshed ${n} payout(s)`))
  .catch((e) => console.error(`anchor sweep failed: ${e?.message ?? e}`));
setInterval(
  () =>
    sweepAnchorPayouts()
      .then((n) => n && console.log(`anchor sweep: refreshed ${n} payout(s)`))
      .catch((e) => console.error(`anchor sweep failed: ${e?.message ?? e}`)),
  30_000,
).unref();

// Reconciler: log-only, never repairs. Drift between Monerium's ledger and
// local receipt state should be loud rather than discovered later by a user
// missing money. `npm run reconcile` runs the same check on demand.
const runReconcile = () =>
  reconcile()
    .then((r) => {
      if (!r.ok) console.warn(`LEDGER DRIFT\n${formatReport(r)}`);
    })
    .catch((e) => console.error(`reconcile failed: ${e?.message ?? e}`));
setTimeout(runReconcile, 10_000).unref();
setInterval(runReconcile, 15 * 60_000).unref();
if (sandbox) {
  checkConnection()
    .then((ctx) => {
      console.log(`monerium sandbox connected (${ctx?.email ?? ctx?.userId ?? "ok"})`);
      startDepositPoller();
    })
    .catch((err) => {
      console.error(`monerium sandbox auth FAILED — check .env credentials: ${err.message}`);
    });
} else {
  console.log("monerium: mock mode (set MONERIUM_CLIENT_ID for OAuth, plus MONERIUM_CLIENT_SECRET for app-level API calls)");
}
/**
 * Inbound crypto is a chain concern, not a Monerium one, so this runs whether
 * or not the sandbox is configured. It costs nothing until an account opts in:
 * with no watched users the poller returns before it ever calls getLogs.
 */
if (CRYPTO_IN.enabled) startCryptoDepositPoller();
app.listen(API_PORT, API_HOST, () => {
  console.log(`Zold API listening on http://${API_HOST}:${API_PORT}`);
  // A co-signer with a zero allowance is the silent version of today's outage:
  // deployment installs the module and delegate, grants nothing, and every
  // debit refuses with "allowance is 0". Say so at boot, not at send time.
  if (
    CANDIDE.cosignerAddress &&
    CANDIDE.cosignerKey &&
    CANDIDE.cosignerEureAllowanceWei <= 0n &&
    CANDIDE.cosignerUsdcAllowanceUnits <= 0n
  ) {
    console.warn(
      "WARNING: a co-signer is configured but CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI and " +
        "CANDIDE_COSIGNER_USDC_ALLOWANCE_UNITS are both unset/0 — passkey Safes will deploy " +
        "with a spending allowance of 0 and every debit will refuse. Set the allowance(s) " +
        "and restart before onboarding accounts.",
    );
  }
});
