import express from "express";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { anchorModeEnabled, API_HOST, API_PORT, BRIDGE, CHAIN_ID, CRYPTO_IN, CUSTODY, FX, HARNESS, KYC, LIQUIDITY, MONERIUM, PAYMENT_REQUESTS, PRIVACY_BUNDLE, PUBLIC_URL, RECOVERY, moneriumOAuthEnabled, moneriumSandboxEnabled, SECURITY, STELLAR } from "./config.js";
import { prepareSafeSwapForTransfer, prepareDepositConversion } from "./liquidity.js";
import { createBridgeTransfer } from "./bridge/bridgexyz.js";
import { countryBlock, normaliseCountryCode } from "./country-policy.js";
import { resolveSegment, capabilitiesFor, can, type Segment } from "./domain/segments.js";
import { auditEntry, redact } from "./audit.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyAssertion, verifyAssertionForChallenge, verifyRegistration } from "./webauthn.js";
import { moneriumRedeemMessage, paymentMemo, SEPA_REMITTANCE_MAX } from "./sepa.js";
import { initStore, store, type CryptoDeposit, type Quote, type ReceiptShare, type Transfer, type User } from "./store.js";
import {
  buildReceipt,
  DEFAULT_SHARE_FIELDS,
  parseShareFields,
  receiptSlug,
  SHARE_TTL_DAYS,
} from "./receipt.js";
import { createQuote, isExpired } from "./fx.js";
import {
  decryptToken,
  encryptToken,
  forgetUserClient,
  hasOwnMoneriumCredentials,
  moneriumAccessToken,
  moneriumApiKeysAvailable,
  moneriumEnvironment,
  moneriumLinkAccessToken,
  publicApiKeys,
  validateApiKeyInput,
  verifyApiKeys,
} from "./adapters/monerium-connection.js";
import { activatePaymentForwarder } from "./adapters/candide-forwarder.js";
import {
  checkConnection,
  handleWebhookEvent,
  refreshPendingIban,
  startDepositPoller,
} from "./adapters/monerium-sandbox.js";
import {
  dailyCapUsage,
  executeSepaTransfer,
  executeTransfer,
  refreshPayout,
  safeDebitBlocker,
  sweepAnchorPayouts,
  sweepStrandedTransfers,
  cashRailOpen,
} from "./orchestrator.js";
import {
  startCryptoDepositPoller,
  depositConversionBlocker,
  settleConvertedDeposit,
  recordInvoiceSettlement,
} from "./adapters/crypto-deposits.js";
import { HandleError, normaliseDisplayName, normaliseHandle, publicPayee } from "./pay.js";
import { qrSvg } from "./qr.js";
import { createOrgRouter } from "./routes/orgs.js";
import { createBusinessRouter, createInvoiceLinkRouter } from "./routes/business.js";
import { createGnosisPayRouter } from "./routes/gnosis-pay.js";
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
import { createCandideRecoveryRouter, sweepCandideRecoveries } from "./routes/recovery-candide.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createPaymentRequestRouter, onPaymentRequestPaid, sweepPaymentRequests } from "./routes/payment-requests.js";
import { createShopifyRouter, resolveShopifyRequest, shopifyAvailable } from "./routes/shopify.js";
import { candideRecoveryEnabled, maskTarget } from "./recovery/candide-guardian.js";
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
  preparePasskeySafeDeployment,
  prepareTransferBatchExecution,
  prepareTransferExecution,
  safeMessageHash,
  signMessageAsPasskeySafe,
  smartAccountForPasskey,
  smartAccountForPasskeyCosigner,
  submitPasskeySafeOperation,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "./wallet/candide.js";
import {
  exchangeAuthorizationCode,
  LINK_MESSAGE,
  MoneriumApiError,
  moneriumBearerRequest,
} from "./adapters/monerium-client.js";
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
    // A document verification code is likewise a bearer credential.
    req.path.startsWith("/v/") ||
    // A payment-request code (/pay/<handle>/<code>) is one too; the bare
    // /pay/<handle> page is public by design and stays on the general bucket.
    /^\/pay\/[^/]+\/[^/]+/.test(req.path) ||
    // Shopify's session webhooks are HMAC-signed; a forged one is a guess.
    req.path.startsWith("/shopify/") ||
    req.path === "/kyc/review" ||
    // Submitting Monerium API keys is a credential check against a third
    // party; guessing at it belongs on the tight bucket too.
    (req.path.endsWith("/monerium/api-keys") && req.method === "POST") ||
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
/** The org dashboard — business and premium personal accounts. */
app.get(["/business", "/business/"], (_req, res) =>
  res.sendFile(path.join(pub, "business.html")),
);
/** The supplier's invoice view, reached with a one-time link and no account. */
app.get("/invoice/:token", (_req, res) => res.sendFile(path.join(pub, "invoice.html")));
app.get("/v/:code", (_req, res) => res.sendFile(path.join(pub, "document.html")));

app.use(express.static(pub));

/**
 * The organisation domain (docs/business-accounts.md).
 *
 * Mounted as routers taking `requireSession` rather than importing the app, so
 * this file stays the single owner of authentication — a route module cannot
 * quietly acquire a second way to decide who is calling. Both sit under /api,
 * so they inherit the rate limiting and the auth-window middleware above.
 *
 * The invoice-link router is deliberately NOT session-guarded: it is reached by
 * a supplier who has no account, holding only the one-time token. Its
 * responses go through an allowlist view for that reason.
 */
app.use("/api/orgs", createOrgRouter(requireSession));
app.use("/api/orgs", createBusinessRouter(requireSession, buildTransferFromQuote));
app.use("/api/invoice-links", createInvoiceLinkRouter());
app.use("/api/gnosis-pay", createGnosisPayRouter(requireSession));

type PendingPasskeySafeDeployment = Awaited<ReturnType<typeof preparePasskeySafeDeployment>>["userOperation"];
const pendingPasskeySafeDeployments = new Map<string, { userId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment }>();
const pendingMoneriumLinkSignatures = new Map<string, {
  userId: string;
  expiresAt: number;
  challenge: string;
  profileId?: string;
}>();
/**
 * Per-transfer Safe executions awaiting the send-time passkey ceremony: the
 * UserOperation that will move this transfer's exact debit out of the user's
 * Safe. Keyed by TRANSFER id; dies with its authorization window. Held in
 * memory on purpose — a restart only means the user re-creates the transfer,
 * the same recovery as an expired authorization; nothing durable is lost.
 */
const pendingTransferExecutions = new Map<string, {
  userId: string;
  expiresAt: number;
  challenge: string;
  plan: NonNullable<User["passkeySafe"]>;
  userOperation: PendingPasskeySafeDeployment;
  /** Present when the operation is a full fee+approve+swap batch: where the
   *  swap output is delivered, so execution can measure and settle there. */
  batch?: { recipient: `0x${string}`; mode: "dry-run" | "live" };
}>();

function prunePendingTransferExecutions(now = Date.now()) {
  for (const [id, pending] of pendingTransferExecutions) {
    if (pending.expiresAt < now) pendingTransferExecutions.delete(id);
  }
}
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * What this deployment can actually do, so the browser can render against it.
 *
 * The simulate routes are dev-only — they 403 in production and off a
 * loopback socket — and without this nothing in any API response tells the
 * client which mode it is in, so the only way to find out is to press the
 * button and read the error. Offering an action the server will refuse is
 * exactly what makes a product read as unfinished.
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

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const block = await publicClient.getBlockNumber();
    res.json({ ok: true, block: Number(block), contracts: addrs(), capabilities: capabilities() });
  }),
);

/**
 * Public mid rates, so the marketing page can show the same number the product
 * would quote instead of baking its own constants in — a hardcoded figure
 * under a "real exchange rate" label goes stale in the shop window. No auth:
 * this is a public reference rate, not per-user pricing, and it carries no
 * spread or fee.
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
const publicUser = (
  { moneriumConnect, monerium, passkey, paymentPage, segment, usPersonAnswers, ...u }:
    User & { [k: string]: any },
) => ({
  ...u,
  // Recovery channel targets are masked on every surface, this one included:
  // the raw phone number and email exist to receive codes, not to be read
  // back by whoever holds a session.
  ...(u.passkeySafe?.candideRecovery
    ? {
        passkeySafe: {
          ...u.passkeySafe,
          candideRecovery: {
            ...u.passkeySafe.candideRecovery,
            channels: u.passkeySafe.candideRecovery.channels.map((c) => ({ ...c, target: maskTarget(c.channel, c.target) })),
          },
        },
      }
    : {}),
  /**
   * The client is told its capabilities, NOT the rule that produced them.
   *
   * `reasonCode` and the raw US answers are stripped: the first tells someone
   * which answer to change, and the second is theirs but has no business being
   * echoed back on every read. `gate` IS sent, because a gated segment must be
   * able to say what is missing.
   */
  ...(segment
    ? {
        segment: {
          value: segment.value,
          capabilities: capabilitiesFor(segment.value),
          ...(segment.gate ? { gate: segment.gate } : {}),
        },
      }
    : {}),
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
          method: monerium.method ?? (monerium.accessTokenEnc ? "oauth" : undefined),
          profileId: monerium.profileId,
          profiles: monerium.profiles,
          ibans: monerium.ibans,
          addresses: monerium.addresses,
          // Client id, environment and when it was verified. Never the secret,
          // and never its ciphertext.
          ...(monerium.apiKeys ? { apiKeys: publicApiKeys(monerium.apiKeys) } : {}),
        },
      }
    : {}),
});
const withSession = (user: User) => ({ ...publicUser(user), sessionToken: issueSession(user.id) });

// Email/SMS recovery through Candide's guardian. Mounted at /api so its
// no-session half sits under /recovery, which the limiter above already
// treats as an auth route.
app.use("/api", createCandideRecoveryRouter({ requireUserSession, publicUser, withSession }));
// Account documents: receipts, statements, balance and ownership letters, each
// verifiable at /v/<code>. The page is the record; the PDF is its print.
app.use("/api", createDocumentsRouter({ requireUserSession }));
// Payment requests (pay links): an amount asked for at /pay/<handle>/<code>,
// payable by USDC, by SEPA with the code as reference, or from another Zold
// account. Shopify rides on the same requests as a payments app.
app.use("/api", createPaymentRequestRouter(requireUserSession));
app.use("/api", createShopifyRouter(requireSession));
onPaymentRequestPaid(resolveShopifyRequest);

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

/*
 * Monerium token handling — encryption at rest, OAuth refresh, the app client
 * and the "whose credentials act for this user" decision — lives in
 * adapters/monerium-connection.ts, because the sandbox adapter's redeem and
 * deposit polling need the same answer as the routes below. Same AES-256-GCM
 * scheme as before (crypto-at-rest.ts, purpose `monerium`), so tokens written
 * by the previous in-file copy still decrypt.
 */

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
 *
 * HARNESS.enabled (hardhat only) waives it so the suites can fund an account
 * without a real authenticator.
 */
function custodyBlockerBeforeFunding(user: User): string | null {
  if (HARNESS.enabled) return null;
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
  const recoveryGuardianAddress = /^0x[0-9a-fA-F]{40}$/.test(CANDIDE.recoveryGuardianAddress)
    ? (CANDIDE.recoveryGuardianAddress as `0x${string}`)
    : undefined;
  return {
    address: account.accountAddress as `0x${string}`,
    status: "planned",
    threshold: cosignerAddress ? 2 : 1,
    ...(cosignerAddress ? { cosignerAddress } : {}),
    // No allowance module, no delegate, no spend amounts: nothing moves from
    // the Safe except UserOperations the user's own passkey signs. The policy
    // record only says whether a co-signing OWNER exists (and keeps the shape
    // stored accounts already have); the module address is there so standing
    // allowances on older Safes can be found and revoked.
    cosignerPolicy: {
      // Keyed on the GATED cosignerAddress (CANDIDE.cosignerEnabled applied),
      // not the raw env var: with the co-signer disabled this plan is a
      // 1-of-1 Safe, and recording enabled:true would make the UI describe a
      // co-signer that is not in the owner set.
      enabled: Boolean(cosignerAddress),
      allowanceModuleAddress: CANDIDE.allowanceModuleAddress,
      allowancePeriodMinutes: "0",
      allowances: [],
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

function prunePendingMoneriumLinkSignatures(now = Date.now()) {
  for (const [id, pending] of pendingMoneriumLinkSignatures) {
    if (pending.expiresAt < now) pendingMoneriumLinkSignatures.delete(id);
  }
}


/**
 * What a blocked person is told.
 *
 * PLAIN, AND NOT A REASON. Each line says what Zold cannot offer and stops
 * there. It does not cite a rule, a country policy or a partner, because the
 * user cannot act on any of that and because naming the rule tells someone
 * which answer to change. The internal reasonCode goes to the audit log.
 *
 * No legal advice, and no implication that the user has done something wrong —
 * which is why the unsupported case says the residence is not served rather
 * than anything about the person.
 */
/**
 * The single gate in front of every partner call.
 *
 * ENFORCED IN CODE, NOT IN THE UI. Hiding a button is a presentation choice
 * that a crafted request walks straight past; this is the check that actually
 * decides. An IN_COLLECTIONS account cannot reach Monerium, a Safe, a card or
 * an on-chain balance no matter what it POSTs, because every one of those
 * routes asks here first.
 *
 * A user with no segment is a pre-existing account from before segmentation.
 * They are treated as EU_FULL rather than refused: they were created under the
 * old country gate, which already required a Monerium-servable residence, and
 * locking them out of their own funded account would be a worse failure than
 * the one this guards. `npm run segments:test` covers the resolver; this
 * fallback is the migration seam and is deliberately narrow.
 */
function requireCapability(
  user: User,
  capability: Parameters<typeof can>[1],
  res: express.Response,
): boolean {
  const segment: Segment = user.segment?.value ?? "EU_FULL";
  if (can(segment, capability)) return true;
  store.audit(auditEntry("partner.call_refused", { segment, capability }, user.id));
  res.status(403).json({
    error: "This is not part of your account.",
    code: "CAPABILITY_UNAVAILABLE",
    capability,
    ...(user.segment?.gate ? { gate: user.segment.gate } : {}),
  });
  return false;
}

/** Bumped when the wording of the US questions or the consent text changes,
 *  so a stored answer can be tied to what was actually asked. */
/** Wording versions: the three separate questions, and the single combined
 *  one the app asks now. Recorded with every answer so a later reading knows
 *  what was actually put to the person. */
const US_QUESTIONS_VERSION = "2026-08-31";
const US_QUESTION_COMBINED_VERSION = "2026-09-05-combined";
const CONSENT_VERSION = "2026-08-31";

const BLOCKED_COPY: Record<Extract<Segment, `BLOCKED_${string}`>, string> = {
  BLOCKED_US: "Zold is not available to US persons.",
  BLOCKED_SANCTIONED: "Zold is not available in your country.",
  BLOCKED_UNSUPPORTED: "Zold cannot open an account for residents of your country yet.",
};

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { name, country, email, citizenships, accountType, usAnswers, consents,
      companyIncorporationCountry, softSignals } = req.body ?? {};
    if (!name || !country) return res.status(400).json({ error: "name and country required" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "invalid email" });
    }

    /**
     * SEGMENTATION, NOT A BARE COUNTRY GATE.
     *
     * `countryBlock()` is consulted INSIDE resolveSegment rather than run here
     * first, and the reason is not tidiness: it answers only "will Monerium
     * serve this residence", so on its own it would refuse Nigerians with a
     * message about Monerium's country policy — a partner's name in front of a
     * user who was never going to use that partner. The resolver asks the three
     * questions separately and returns which of them actually decided.
     *
     * Callers that send no segmentation fields are read as an individual with
     * a single citizenship equal to residence and all-no US answers.
     */
    const type: "individual" | "company" = accountType === "company" ? "company" : "individual";
    // The app asks ONE question (citizen, Green Card or tax resident); older
    // clients and the harnesses still send the three. Keep whichever shape
    // was answered rather than translating one into the other.
    const combined = typeof usAnswers?.usPerson === "boolean";
    const answers = {
      ...(combined
        ? { usPerson: usAnswers.usPerson === true }
        : {
            usCitizen: usAnswers?.usCitizen === true,
            usGreenCard: usAnswers?.usGreenCard === true,
            usTaxResident: usAnswers?.usTaxResident === true,
          }),
      ...(type === "company"
        ? { companyUsNexus: usAnswers?.companyUsNexus === true }
        : { companyUsNexus: null }),
    };
    let decision;
    try {
      decision = resolveSegment({
        residence: String(country),
        citizenships: Array.isArray(citizenships) && citizenships.length
          ? citizenships.map(String)
          : [String(country)],
        accountType: type,
        usAnswers: answers,
        ...(companyIncorporationCountry ? { companyIncorporationCountry: String(companyIncorporationCountry) } : {}),
        ...(softSignals ? { softSignals } : {}),
      });
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
    }

    // A blocked segment is recorded before it is refused: the decision has to
    // be auditable whether or not an account exists, and "we refused someone
    // and kept no record of why" is the failure this log exists to prevent.
    if (decision.segment.startsWith("BLOCKED_")) {
      store.audit(auditEntry("segment.decided", {
        residence: normaliseCountryCode(String(country)),
        citizenships: (Array.isArray(citizenships) ? citizenships : [country]).map((c: any) => normaliseCountryCode(String(c))),
        accountType: type,
        usAnswers: answers,
        segment: decision.segment,
        reasonCode: decision.reasonCode,
        email: redact(email ?? ""),
        outcome: "refused_at_signup",
      }));
      // Deliberately says what Zold cannot offer and NOT which rule fired.
      // reasonCode stays in the log; publishing it tells someone which answer
      // to change to get a different outcome.
      return res.status(403).json({
        error: BLOCKED_COPY[decision.segment as keyof typeof BLOCKED_COPY],
        code: decision.segment,
      });
    }
    const id = randomUUID();
    // The real address is set by passkey/co-signer Safe deployment. Identity
    // is Monerium's: the account stays pending until a Monerium connection
    // (OAuth or the user's own API keys) is activated and attributes an IBAN
    // to the Safe. No locally issued IBAN, and no auto-approval anywhere money
    // is real — KYC.autoApprove is true only on the hardhat harness chain.
    const approved = KYC.autoApprove;
    const user: User = {
      id,
      name,
      email,
      country: normaliseCountryCode(String(country)),
      kycStatus: approved ? "approved" : "pending",
      kyc: approved
        ? { provider: "mock", checkedAt: new Date().toISOString(), reason: "hardhat harness auto-approval" }
        : { provider: "monerium" },
      iban: "",
      address: ZERO_ADDRESS,
      wallet: { type: "candide-safe", deployed: false },
      // Harness accounts are "funded" with no IBAN: hardhat has no Monerium,
      // and the suites mint EURe to the Safe directly.
      funding: approved
        ? { mode: "sandbox", status: "active", detail: "hardhat harness account — no Monerium IBAN exists on this chain" }
        : { mode: "sandbox", status: "kyc_pending" },
      createdAt: new Date().toISOString(),
    };
    store.addUser(user);
    store.setSegment(user.id, {
      value: decision.segment,
      reasonCode: decision.reasonCode,
      decidedAt: new Date().toISOString(),
      decidedBy: "system",
      ...(decision.gate ? { gate: decision.gate } : {}),
    });
    store.updateUser(user.id, {
      citizenships: (Array.isArray(citizenships) && citizenships.length
        ? citizenships.map(String) : [String(country)]).map(normaliseCountryCode),
      accountType: type,
      ...(companyIncorporationCountry
        ? { companyIncorporationCountry: normaliseCountryCode(String(companyIncorporationCountry)) }
        : {}),
      ...(decision.review
        ? { softSignals: { ...(softSignals ?? {}), flaggedAt: new Date().toISOString(), reconfirmationPending: true } }
        : {}),
    });
    store.addUsAnswers(user.id, {
      ...answers,
      answeredAt: new Date().toISOString(),
      version: combined ? US_QUESTION_COMBINED_VERSION : US_QUESTIONS_VERSION,
    });
    for (const c of Array.isArray(consents) ? consents : []) {
      if (c?.kind !== "zold_terms" && c?.kind !== "partner_share") continue;
      store.addConsent(user.id, {
        kind: c.kind,
        ...(c.partner ? { partner: String(c.partner) } : {}),
        version: String(c.version ?? CONSENT_VERSION),
        at: new Date().toISOString(),
        ...(req.ip ? { ip: req.ip } : {}),
      });
    }
    store.audit(auditEntry("segment.decided", {
      residence: user.country,
      accountType: type,
      usAnswers: answers,
      segment: decision.segment,
      reasonCode: decision.reasonCode,
      softUsSignals: decision.review?.softUsSignals ?? [],
      outcome: "account_created",
    }, user.id));
    res.status(201).json(withSession(user));
  }),
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    let user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (user.funding?.status === "iban_pending") {
      user = await refreshPendingIban(user);
    }
    const balances = await accountBalances(user.address);
    res.json({ ...publicUser(user), ...balances });
  }),
);

/* ==========================================================================
   CONVERTING AN INBOUND CRYPTO DEPOSIT
   --------------------------------------------------------------------------
   Two calls, because a conversion moves the user's money and only their
   passkey may authorise that:

     prepare  -> builds the swap batch, returns a challenge to sign
     convert  -> verifies the assertion, submits, credits what ARRIVED

   The poller detects deposits and stops there. It runs with nobody present,
   so it cannot sign; a missing signature must never be recorded as a fault.

   NON-CUSTODIAL BY CONSTRUCTION. The batch approves the venue and swaps out of
   the user's own Safe, delivering EURe straight back into it. The orchestrator
   is not in the path and holds nothing at any point.
   ========================================================================== */
const pendingDepositConversions = new Map<string, {
  userId: string;
  expiresAt: number;
  challenge: string;
  plan: NonNullable<User["passkeySafe"]>;
  userOperation: PendingPasskeySafeDeployment;
  quote: { provider: string; rate: string; minOut: string };
}>();

/**
 * Tie a payment to the invoice it settles.
 *
 * Deliberately explicit rather than inferred. Matching an incoming amount to
 * an open invoice by value and date guesses, and a guess written into the
 * books as a fact is worse than an unlinked payment someone has to look at.
 * The account holder says which invoice this was.
 */
app.post(
  "/api/users/:id/crypto-deposits/:depositId/invoice",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const deposit = store.cryptoDeposits.find(
      (d) => d.id === req.params.depositId && d.userId === user.id,
    );
    if (!deposit) return res.status(404).json({ error: "deposit not found" });

    const invoiceId = req.body?.invoiceId;
    if (invoiceId === null) {
      store.updateCryptoDeposit(deposit.id, { invoiceId: undefined });
      return res.json({ deposit: store.cryptoDeposits.find((d) => d.id === deposit.id) });
    }
    const invoice = store.invoices.find((i) => i.id === String(invoiceId ?? ""));
    if (!invoice) return res.status(404).json({ error: "invoice not found" });

    const linked = store.updateCryptoDeposit(deposit.id, { invoiceId: invoice.id });
    // Already converted? Then the whole thread is known now and belongs on the
    // invoice immediately, rather than waiting for a conversion that happened
    // before the link existed.
    if (linked.state === "CONVERTED") recordInvoiceSettlement(linked);
    res.json({
      deposit: store.cryptoDeposits.find((d) => d.id === deposit.id),
      invoice: store.invoices.find((i) => i.id === invoice.id),
    });
  }),
);

app.post(
  "/api/users/:id/crypto-deposits/:depositId/convert/prepare",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireCapability(user, "onchain_balance", res)) return;

    const deposit = store.cryptoDeposits.find(
      (d) => d.id === req.params.depositId && d.userId === user.id,
    );
    if (!deposit) return res.status(404).json({ error: "deposit not found" });

    const blocker = depositConversionBlocker(user, deposit);
    if (blocker) return res.status(409).json({ error: blocker });
    const safeBlocker = safeDebitBlocker(user);
    if (safeBlocker) return res.status(409).json({ error: safeBlocker });

    try {
      const swap = await prepareDepositConversion(
        user.address as `0x${string}`,
        BigInt(deposit.amountUnits),
        `crypto-in-${deposit.id}`,
      );
      if (!swap) {
        return res.status(503).json({
          error:
            `the configured liquidity venue (${LIQUIDITY.PROVIDER}) cannot be executed by your ` +
            "account, so this deposit cannot be converted here. dex, lifi, rfq or best can.",
        });
      }
      // No fee on a conversion: the user is converting their own money and
      // keeping it. transferSwapBatchTransactions skips the fee leg at 0.
      const prepared = await prepareTransferBatchExecution(user.passkeySafe!, {
        token: addrs().usdc,
        feeTo: orchestratorAddress,
        feeAmount: 0n,
        approval: { spender: swap.plan.approval.spender, amount: swap.plan.approval.amount },
        call: swap.plan.call,
      });
      const challenge = passkeySafeChallenge(prepared.challenge);
      for (const [id, p] of pendingDepositConversions) {
        if (p.expiresAt < Date.now()) pendingDepositConversions.delete(id);
      }
      pendingDepositConversions.set(deposit.id, {
        userId: user.id,
        expiresAt: Date.now() + AUTH_WINDOW_SEC * 1000,
        challenge,
        plan: user.passkeySafe!,
        userOperation: prepared.userOperation,
        quote: {
          provider: swap.plan.quote.provider,
          rate: swap.plan.quote.rate.toString(),
          minOut: swap.plan.quote.minOut.toString(),
        },
      });
      res.json({
        depositId: deposit.id,
        credentialId: user.passkey?.credentialId,
        challenge,
        amountUsdc: deposit.amountUsdc,
        expectedEur: eur.fromWei(swap.plan.quote.expectedOut),
        minEur: eur.fromWei(swap.plan.quote.minOut),
        provider: swap.plan.quote.provider,
      });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.shortMessage ?? err?.message ?? err) });
    }
  }),
);

app.post(
  "/api/users/:id/crypto-deposits/:depositId/convert",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireCapability(user, "onchain_balance", res)) return;

    const deposit = store.cryptoDeposits.find(
      (d) => d.id === req.params.depositId && d.userId === user.id,
    );
    if (!deposit) return res.status(404).json({ error: "deposit not found" });

    // Claim the pending execution BEFORE any await, so two parallel submissions
    // of one signature cannot both proceed — the same race the transfer
    // authorize path had, and the same fix.
    const pending = pendingDepositConversions.get(deposit.id);
    if (!pending) {
      return res.status(409).json({ error: "no prepared conversion — call convert/prepare first" });
    }
    pendingDepositConversions.delete(deposit.id);
    if (pending.userId !== user.id) {
      return res.status(403).json({ error: "this conversion belongs to a different account" });
    }

    const a = req.body?.executionAssertion;
    if (!a?.authenticatorData || !a?.clientDataJSON || !a?.signature) {
      return res.status(400).json({
        error: "executionAssertion requires authenticatorData, clientDataJSON and signature",
      });
    }
    if (!user.passkey?.publicKey) {
      return res.status(409).json({ error: "no passkey registered for this account" });
    }
    if (a.credentialId !== user.passkey.credentialId) {
      return res.status(403).json({ error: "passkey credential does not match this account" });
    }

    try {
      const { signCount } = await verifyAssertionForChallenge(
        a.authenticatorData, a.clientDataJSON, a.signature,
        user.passkey.publicKey, user.passkey.signCount ?? 0,
        user.passkey.rpId ?? SECURITY.rpId, SECURITY.origins, pending.challenge,
      );
      store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
    } catch (err: any) {
      return res.status(401).json({ error: String(err?.message ?? err) });
    }

    // Measure BEFORE submitting: the credited amount is the balance delta, not
    // anything the quote promised.
    const before = eur.toWei(await accountBalances(user.address).then((b) => b.safeBalanceEur));
    let opHash: string | null = null;
    try {
      opHash = await submitPasskeySafeOperation(pending.plan, pending.userOperation, {
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: a.signature,
      });
    } catch (err: any) {
      const reason = String(err?.shortMessage ?? err?.message ?? err);
      store.updateCryptoDeposit(deposit.id, { state: "REFUSED", reason });
      return res.status(502).json({ error: reason });
    }

    const txs = [...deposit.txs, { step: "safe.swap(usdc->eure)", hash: opHash ?? "0x" }];
    const settled = await settleConvertedDeposit(
      deposit, user,
      { provider: pending.quote.provider, rate: BigInt(pending.quote.rate), minOut: BigInt(pending.quote.minOut) },
      before, txs,
    );
    const balances = await accountBalances(user.address);
    res.json({ deposit: settled, ...balances });
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
/** A payment REQUEST against that page: amount, description, the ways to pay
 *  and the live status. The code in the URL is the credential. */
app.get("/pay/:handle/:code", (_req, res) => {
  res.sendFile(path.join(pub, "pay-request.html"));
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
  "/api/users/:id/monerium/connect/start",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireCapability(user, "monerium", res)) return;
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
    if (!hasOwnMoneriumCredentials(user)) {
      return res.status(409).json({ error: "no Monerium account is connected to this account — connect one by OAuth or with your own API keys" });
    }
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
    if (!requireCapability(user, "monerium", res)) return;
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
       * No whitelabel path: the app never creates Monerium profiles for a
       * user. The address is linked under the profile the USER's own
       * connection (OAuth or API keys) exposes, so without one there is
       * nothing to link to and the route refuses above.
       */
      if (viaApp) {
        return res.status(409).json({
          error: "connect a Monerium account first — sign in with Monerium or add your Monerium API keys — before activating an IBAN",
        });
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
     * Wrong-profile bindings are DETECTED and parked, never unlinked. An
     * address linked under the app's DEFAULT profile has its IBAN request park
     * forever, and POST /addresses answers "already linked" without moving the
     * binding — but unlinking to re-link BURNS the address: Monerium answers
     * every later link attempt with "Cannot link, please contact support", and
     * a Safe's address cannot be changed. Detection tells the operator exactly
     * what to raise with Monerium; deletion turns a stuck account into a
     * bricked one (verified live on 0x9650E5…).
     */
    let wrongProfileBinding: string | undefined;
    if (viaApp && profileId) {
      try {
        const rec = await moneriumBearerRequest<any>(MONERIUM.baseUrl, accessToken, "GET", `/addresses/${user.address}`);
        if (rec?.profile && rec.profile !== profileId) wrongProfileBinding = rec.profile;
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
        console.error(`monerium activate: address linking refused for ${user.id}: ${err?.message ?? err}`);
        // "Cannot link ... contact support" is Monerium's permanent verdict on
        // a burned (once-unlinked) address. A Safe's address cannot change, so
        // record it: the client stops offering an activation that can only
        // fail, and the account page says why instead of erroring forever.
        if (/cannot link/i.test(String(err?.message ?? ""))) {
          store.updateUser(user.id, {
            funding: {
              ...(user.funding ?? { mode: "sandbox" as const }),
              mode: "sandbox",
              status: "error",
              addressUnlinkable: true,
              detail: "Monerium cannot link this address (support required) — this account cannot receive an IBAN; open a new account",
            } as User["funding"],
          });
        }
        // 400, not 502: Cloudflare swallows origin 502 bodies with its own
        // error page, so the reason above never reached the user.
        return res.status(400).json({ error: `Monerium refused the address linking: ${err?.message ?? err}` });
      }
    }
    try {
      await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/ibans", {
        address: user.address,
        chain: MONERIUM.chain,
      });
    } catch (err: any) {
      if (!alreadyDone(err)) {
        console.error(`monerium activate: IBAN request refused for ${user.id}: ${err?.message ?? err}`);
        return res.status(400).json({ error: `Monerium refused the IBAN request: ${err?.message ?? err}` });
      }
    }
    const snapshot = await readMoneriumAccountSnapshot(user, accessToken);
    /**
     * ADDRESS-MATCHED ONLY — an IBAN is money routing, not decoration.
     *
     * With app credentials the snapshot lists EVERY customer's IBAN, so
     * falling back to "the first IBAN in the snapshot" when this address's
     * has not been issued yet displays some OTHER account's IBAN as this one's
     * — and a payment sent to it mints into the other user's Safe. No IBAN yet
     * must mean iban_pending, never someone else's; refreshPendingIban polls
     * by address and attributes correctly.
     */
    const iban =
      snapshot.ibans.find(
        (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
      )?.iban ?? "";

    const updated = store.updateUser(user.id, {
      // What Monerium attributes to THIS address, or nothing. Falling back to
      // a previously stored value would preserve a mis-attribution.
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
        detail: iban
          ? undefined
          : wrongProfileBinding
            ? `address is linked under Monerium profile ${wrongProfileBinding} instead of this account's — needs Monerium support to move; do NOT unlink`
            : "Monerium IBAN requested; waiting for activation",
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
    forgetUserClient(user.id);
    const updated = store.updateUser(user.id, {
      moneriumConnect: undefined,
      monerium: undefined,
      funding: { ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }), status: "kyc_pending" as const },
    });
    res.json(publicUser(updated));
  }),
);

/**
 * Connect the user's OWN Monerium app credentials.
 *
 * For testing against your own Monerium account: create an app in the account's
 * developer section, paste its client id and secret here. The server proves the
 * pair against Monerium first (a stored credential nobody checked turns every
 * later failure into a phantom bug), then stores the secret encrypted and
 * treats the connection like an OAuth one — activation, deposit polling and
 * SEPA redeems run on these credentials, since the user's profile is invisible
 * to the app's own keys.
 *
 * WHAT IT DOES NOT DO: approve KYC. Connecting is not identity. Approval comes
 * from activation (address-matched IBAN on the connected account), exactly as
 * for the OAuth path — unless the connected account ALREADY attributes an IBAN
 * to this Safe, which is the same evidence activation would produce.
 */
app.post(
  "/api/users/:id/monerium/api-keys",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireCapability(user, "monerium", res)) return;
    if (!moneriumApiKeysAvailable()) {
      return res.status(503).json({
        error: "Monerium token encryption key is not configured — set MONERIUM_TOKEN_ENCRYPTION_KEY; API keys are never stored in plaintext",
      });
    }
    let input: ReturnType<typeof validateApiKeyInput>;
    try {
      input = validateApiKeyInput(req.body);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message ?? "invalid credentials" });
    }
    let verified: Awaited<ReturnType<typeof verifyApiKeys>>;
    try {
      verified = await verifyApiKeys(input.clientId, input.clientSecret);
    } catch (err: any) {
      if (err instanceof MoneriumApiError && err.status < 500) {
        store.audit(auditEntry("partner.call_refused", { partner: "monerium", capability: "api_keys", status: err.status }, user.id));
        return res.status(400).json({ error: err.message });
      }
      return res.status(503).json({ error: `Monerium could not be reached to verify the keys: ${String(err?.message ?? err).slice(0, 200)}` });
    }

    const approvedProfile = verified.profiles.find((p: any) => p.state === "approved");
    const profileId = approvedProfile?.id ?? verified.profiles[0]?.id;
    // ADDRESS-MATCHED ONLY, for the reason activate gives: any other IBAN in
    // the snapshot is somebody's money routing, not this account's.
    const ownIban =
      verified.ibans.find(
        (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
      )?.iban ?? "";
    const now = new Date().toISOString();
    const wasApproved = user.kycStatus === "approved";

    const updated = store.updateUser(user.id, {
      moneriumConnect: undefined,
      ...(wasApproved
        ? {}
        : ownIban
          ? {
              kycStatus: "approved" as const,
              kyc: {
                provider: "monerium" as const,
                onboardingPath: "existing_monerium" as const,
                checkedAt: now,
                applicantId: profileId,
                reason: `approved via connected Monerium profile ${profileId ?? "(unnamed)"} (IBAN already attributed to this account)`,
              },
            }
          : {
              kyc: {
                provider: "monerium" as const,
                onboardingPath: "existing_monerium" as const,
                applicantId: profileId,
                reason: "own Monerium API keys connected; activate IBAN with passkey",
              },
            }),
      ...(ownIban ? { iban: ownIban } : {}),
      funding: {
        ...(user.funding ?? {}),
        mode: "sandbox" as const,
        status: ownIban
          ? ("active" as const)
          : user.funding?.status === "active"
            ? ("active" as const)
            : ("provisioning" as const),
        moneriumProfileId: profileId,
        detail: ownIban
          ? `IBAN attributed to this account by your Monerium (${moneriumEnvironment()}) account`
          : user.funding?.status === "active"
              ? "own Monerium keys connected; the existing IBAN is kept and Monerium calls for this account now use your keys"
              : "own Monerium account connected — approve IBAN issuance with your passkey",
      },
      monerium: {
        connectedAt: now,
        method: "api_keys",
        profileId,
        apiKeys: {
          clientId: input.clientId,
          clientSecretEnc: encryptToken(input.clientSecret),
          baseUrl: MONERIUM.baseUrl,
          label: input.label,
          verifiedAt: now,
          accountEmail: typeof verified.context?.email === "string" ? verified.context.email : undefined,
        },
        profiles: verified.profiles,
        ibans: verified.ibans,
        addresses: verified.addresses,
      },
    });
    forgetUserClient(user.id);
    store.audit(auditEntry(
      "partner.credentials_connected",
      { partner: "monerium", method: "api_keys", clientId: input.clientId, environment: moneriumEnvironment(), profileId, ibanAttributed: Boolean(ownIban) },
      user.id,
    ));
    const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0 }));
    res.status(201).json({ ...publicUser(updated), ...balances });
  }),
);

/**
 * Forget the user's API keys. The IBAN Monerium issued stays recorded — it
 * exists at Monerium whether or not we hold a credential — but nothing on this
 * account can be read or redeemed until keys are connected again, and the
 * funding detail says so instead of leaving a silent dead rail.
 */
app.delete(
  "/api/users/:id/monerium/api-keys",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (user.monerium?.method !== "api_keys") {
      return res.status(409).json({ error: "no Monerium API keys are connected to this account" });
    }
    forgetUserClient(user.id);
    const updated = store.updateUser(user.id, {
      monerium: undefined,
      funding: user.funding
        ? {
            ...user.funding,
            detail: sandbox
              ? "own Monerium keys removed; the app's credentials act for this account again"
              : "own Monerium keys removed — deposits and payouts on this account are paused until keys are connected again",
          }
        : user.funding,
    });
    store.audit(auditEntry("partner.credentials_removed", { partner: "monerium", method: "api_keys" }, user.id));
    res.json(publicUser(updated));
  }),
);




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
    bridge: route.filter((x) => x.step.startsWith("bridge.")),
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
 * a dry orchestrator fails swaps and the fee leg; a dry deployer fails faucet
 * grants. Name them, so the dashboard can too. The co-signer sends no native
 * transactions — Safe debits are UserOperations through the bundler and
 * paymaster — but it stays listed so a residual balance is visible.
 */
let operatorGasCache: { at: number; value: { role: string; address: string; eth: number }[] } | null = null;
async function operatorGas() {
  if (operatorGasCache && Date.now() - operatorGasCache.at < 60_000) return operatorGasCache.value;
  const wallets: { role: string; address: `0x${string}` }[] = [
    { role: "co-signer (userOp counter-signer, no gas needed)", address: (CANDIDE.cosignerAddress || "0x") as `0x${string}` },
    { role: "orchestrator (swaps, fees)", address: orchestratorAddress },
    { role: "deployer (gas)", address: deployerWallet.account.address },
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
    if (!requireCapability(user, "safe", res)) return;
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
    const opHash = await submitPasskeySafeOperation(user.passkeySafe, pending.userOperation, {
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
    if (updated.kycStatus === "approved" && !updated.iban && updated.funding?.status !== "active") {
      updated = store.updateUser(user.id, {
        funding: {
          ...(updated.funding ?? {}),
          mode: "sandbox",
          status: "provisioning",
          detail: "smart wallet deployed — approve IBAN issuance with your passkey",
        },
      });
    }
    res.status(201).json({ ...publicUser(updated), deployOpHash: opHash });
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
    if (HARNESS.enabled) return true;
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


/**
 * Build a transfer from an open quote, and the authorization the device must
 * sign for it.
 *
 * Extracted from POST /api/transfers unchanged so that draft execution can
 * create transfers through the SAME code path. A second, parallel construction
 * would be the classic way for one caller to quietly skip a balance check, a
 * daily cap, or the destination commitment.
 *
 * Returns a discriminated result rather than writing to a response: it has two
 * callers now, and only one of them owns an HTTP response. The `res` it passes
 * to requireKycApproved / assertDailyCap is a collector whose
 * `.status(x).json(y)` evaluates to the failure result itself, so every
 * refusal below reads exactly as it did when this was a route.
 */
type TransferBuildFailure = { ok: false; status: number; body: any };
type TransferBuildResult =
  | { ok: true; transfer: Transfer; authorization: any }
  | TransferBuildFailure;

function responseCollector() {
  const out: TransferBuildFailure = { ok: false, status: 500, body: undefined };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: any) {
      out.body = body;
      return out;
    },
  };
  return { res, out };
}

async function buildTransferFromQuote(
  quote: Quote,
  recipient: {
    recipientName: string;
    recipientPhone?: string;
    recipientIban?: string;
    reference?: string;
  },
): Promise<TransferBuildResult> {
  const { res, out } = responseCollector();
  const { recipientName, recipientPhone, recipientIban, reference } = recipient;
    const user = store.findUser(quote.userId)!;
    if (!requireKycApproved(user, res)) return out;
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
    if (!(await assertDailyCap(user, quote.sendEur, res))) return out;

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
    // The user-signed debit: a UserOperation moving this transfer's exact
    // amount (the fee alone on the SEPA rail — the payout burns straight from
    // the Safe) to the orchestrator's working address. The passkey signs its
    // hash at send time, so the chain enforces amount and destination; no
    // allowance and no server-relayable spend authority exists at any point.
    let safeExecution:
      | { credentialId: string; challenge: string; amountEur: number; token: "EURE" }
      | undefined;
    /**
     * Which custody mode this transfer will actually run in, recorded on the
     * transfer itself. Starts at the honest worst case and is narrowed only
     * when a Safe-executed batch is genuinely prepared — so a venue outage or
     * a missing config leaves the truthful answer behind rather than an
     * optimistic one nobody revisited.
     *
     * The SEPA rail is already non-custodial for the principal: Monerium's
     * redeem burns the payout straight from the Safe and only the fee moves.
     */
    let custody: NonNullable<Transfer["custody"]> =
      transfer.rail === "sepa"
        ? { mode: "non-custodial", feeToOrchestrator: transfer.sendEur > (transfer.receiveEur ?? 0) }
        : {
            mode: "orchestrator",
            reason: "no Safe-executed swap batch was prepared for this transfer",
            feeToOrchestrator: true,
          };
    const debitWei =
      transfer.rail === "sepa"
        ? eur.toWei(Math.max(0, transfer.sendEur - (transfer.receiveEur ?? transfer.sendEur - FX.FIXED_FEE_EUR)))
        : amountWei;
    if (
      debitWei > 0n &&
      user.passkey?.credentialId &&
      user.passkeySafe?.status === "active" &&
      user.address.toLowerCase() === user.passkeySafe.address.toLowerCase() &&
      // A 2-of-2 Safe needs the co-signer KEY to counter-sign; a passkey-only
      // Safe needs nothing beyond the user's assertion. Deliberately the same
      // condition as the orchestrator's passkeySafeExecutionReady: requiring
      // more here (the address env var, say) would create transfers that pass
      // the readiness blocker but silently never get an execution prepared,
      // and then fail at authorize blaming the user.
      (!user.passkeySafe.cosignerAddress || CANDIDE.cosignerKey) &&
      !HARNESS.enabled
    ) {
      try {
        let prepared: Awaited<ReturnType<typeof prepareTransferExecution>> | undefined;
        let batch: { recipient: `0x${string}`; mode: "dry-run" | "live" } | undefined;
        // Cash rail: try the full fee+approve+swap batch first (Change 2,
        // windows 1-3) — one signature, atomic, and the orchestrator never
        // holds the input. Falls back to the plain user-signed debit when the
        // configured venue cannot serve a Safe executor (FxSwapper, CoW) or
        // the venue is down; the fallback still never moves without the user.
        if (transfer.rail === "cash") {
          try {
            // Where the output lands is the destination the payout leg names:
            // the Bridge deposit address in live mode, the orchestrator in
            // dry-run (the local demo settles from it).
            let recipient = orchestratorAddress;
            let mode: "dry-run" | "live" = "dry-run";
            let bridgeAmountUsdc: number | undefined;
            if (BRIDGE.live) {
              if (!BRIDGE.destinationAddress) {
                // Same refusal bridgeDestination() gives at execute — refuse
                // here rather than posting Bridge a transfer with an empty
                // to_address and discovering it one leg later.
                throw new Error(
                  "BRIDGE_LIVE=1 requires BRIDGE_DESTINATION_ADDRESS until MoneyGram anchor payment instructions are wired into Bridge",
                );
              }
              const convertEur = transfer.sendEur - FX.FIXED_FEE_EUR;
              const rate = Number(quote.lockedSwapRate ?? "0") / 1e6;
              if (!(rate > 0)) throw new Error("no locked swap rate to size the Bridge transfer");
              bridgeAmountUsdc = Math.floor(convertEur * rate * 100) / 100;
              const bridgePlan = await createBridgeTransfer(
                transfer.id,
                bridgeAmountUsdc,
                {
                  paymentRail: BRIDGE.destinationRail,
                  currency: BRIDGE.destinationCurrency,
                  toAddress: BRIDGE.destinationAddress,
                  blockchainMemo: BRIDGE.destinationMemo || undefined,
                },
                { sourceAddress: user.address },
              );
              const deposit = bridgePlan.sourceDepositInstructions?.to_address;
              if (!deposit || !/^0x[a-fA-F0-9]{40}$/.test(deposit)) {
                throw new Error("Bridge returned no Base deposit address for the swap to deliver into");
              }
              recipient = deposit as `0x${string}`;
              mode = "live";
            }
            const swap = await prepareSafeSwapForTransfer(transfer, {
              executor: user.address as `0x${string}`,
              recipient,
            });
            if (swap) {
              const convertWei = swap.plan.approval.amount;
              // Equality is the legitimate zero-fee shape; only a convert
              // amount EXCEEDING the signed debit total is incoherent.
              if (convertWei > debitWei) throw new Error("swap amount exceeds the authorized debit total");
              prepared = await prepareTransferBatchExecution(user.passkeySafe, {
                token: addrs().eure,
                feeTo: orchestratorAddress,
                // Exact by construction: fee + convert always equals the
                // debited total, whatever floating-point did to the euros.
                feeAmount: debitWei - convertWei,
                approval: { spender: swap.plan.approval.spender, amount: convertWei },
                call: swap.plan.call,
              });
              batch = { recipient, mode };
              // Live: the batch delivers straight to Bridge's deposit address,
              // so the input never reaches an address we hold a key to.
              // Dry-run: there IS no external destination, so the output lands
              // at the orchestrator for the local demo to settle from —
              // still a batch, still user-signed, but custodial, and it says so.
              custody =
                mode === "live"
                  ? { mode: "non-custodial", feeToOrchestrator: true }
                  : {
                      mode: "orchestrator",
                      reason:
                        "BRIDGE_LIVE is not set, so the swap has no external deposit address to " +
                        "deliver into and the output lands at the orchestrator",
                      feeToOrchestrator: true,
                    };
              transfer.liquidity = swap.serialized;
              transfer.safeSwap = {
                recipient,
                mode,
                // The amount the live Bridge transfer was created with. Execute
                // must re-create with EXACTLY this body — the idempotency key
                // is shared, and an idempotent replay with a different amount
                // is either rejected or silently ignored.
                ...(bridgeAmountUsdc !== undefined ? { bridgeAmountUsdc } : {}),
              };
            }
            if (!swap) {
              custody = {
                mode: "orchestrator",
                reason:
                  `the configured liquidity venue (${LIQUIDITY.PROVIDER}) cannot be executed by the ` +
                  "user's Safe, so the input is debited to the orchestrator and swapped from there",
                feeToOrchestrator: true,
              };
            }
          } catch (err: any) {
            custody = {
              mode: "orchestrator",
              reason: `Safe-executed batch unavailable: ${err?.message ?? err}`,
              feeToOrchestrator: true,
            };
            console.error(
              `Safe swap batch unavailable for ${transfer.id} (falling back to plain debit): ${err?.message ?? err}`,
            );
          }
        }
        prepared ??= await prepareTransferExecution(
          user.passkeySafe,
          addrs().eure,
          orchestratorAddress,
          debitWei,
        );
        prunePendingTransferExecutions();
        const challenge = passkeySafeChallenge(prepared.challenge);
        pendingTransferExecutions.set(transfer.id, {
          userId: user.id,
          expiresAt: deadline * 1000,
          challenge,
          plan: user.passkeySafe,
          userOperation: prepared.userOperation,
          ...(batch ? { batch } : {}),
        });
        safeExecution = {
          credentialId: user.passkey.credentialId,
          challenge,
          amountEur: eur.fromWei(debitWei),
          token: "EURE",
        };
      } catch (err: any) {
        // The transfer is still created: without an execution the debit will
        // refuse with a precise reason, which beats failing creation for a
        // bundler hiccup. Say why here so the refusal is diagnosable.
        console.error(
          `Safe execution preparation failed for ${transfer.id}: ${err?.message ?? err}`,
        );
      }
    }
    /**
     * Turn the preference into a guarantee where an operator asked for one.
     *
     * REQUIRE_NON_CUSTODIAL=1 means this deployment has promised it does not
     * take possession of client funds, so a fallback to the orchestrator is a
     * broken promise, not a degraded mode — refuse and name the cause rather
     * than moving money in a way the deployment says it does not.
     *
     * This spends the quote (consumed above). That is acceptable precisely
     * because every cause here is a deployment-wide condition — the venue
     * cannot serve a Safe, Bridge is not live — so it fails on the first
     * transfer and is fixed once, not intermittently for one unlucky user.
     */
    if (CUSTODY.requireNonCustodial && custody.mode === "orchestrator") {
      return res.status(409).json({
        error:
          "refusing to create this transfer: REQUIRE_NON_CUSTODIAL=1 but it would route the sender's " +
          `funds through the orchestrator — ${custody.reason ?? "no Safe-executed batch was prepared"}`,
        custody,
      });
    }
    transfer.custody = custody;
    store.addTransfer(transfer);
    return {
      ok: true as const,
      transfer,
      authorization: {
        authorizer,
        safeExecution,
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
    };
}

// --- Quotes & transfers ------------------------------------------------------

app.post(
  "/api/quotes",
  wrap(async (req, res) => {
    const { userId, sendEur, rail = "cash" } = req.body ?? {};
    if (rail === "cash" && !cashRailOpen()) {
      return res.status(503).json({
        error: "the cash rail is not open on this deployment — Bridge and the payout anchor are not configured",
        code: "RAIL_CLOSED",
      });
    }
    const user = store.findUser(userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireCapability(user, "onchain_balance", res)) return;
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
    const built = await buildTransferFromQuote(quote, {
      recipientName,
      recipientPhone,
      recipientIban,
      reference,
    });
    if (!built.ok) return res.status(built.status).json(built.body);
    res.status(201).json({ ...built.transfer, authorization: built.authorization });
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
    // User-signed execution: when creation prepared one, this transfer can
    // only debit through it — the UserOperation the passkey approves IS the
    // movement, and there is no server-side authority to fall back on.
    // Verified BEFORE the authorization is claimed (a bad assertion must not
    // consume the one-shot claim) and BEFORE the redeem assertion: the client
    // performs the execution ceremony first, so on authenticators with a real
    // signature counter the redeem assertion carries the HIGHER count —
    // verifying it first would store that count and make the execution
    // assertion read as a cloned-authenticator regression, failing every
    // Safe-funded SEPA send on counter-incrementing hardware.
    prunePendingTransferExecutions();
    const pendingExecution = pendingTransferExecutions.get(transfer.id);
    if (pendingExecution && pendingExecution.userId !== user.id) {
      return res.status(403).json({ error: "Safe execution belongs to a different account" });
    }
    const executionAssertion = req.body?.executionAssertion;
    if (pendingExecution) {
      if (!user.passkey?.publicKey) {
        return res.status(409).json({ error: "no passkey registered for this account" });
      }
      const { credentialId, authenticatorData, clientDataJSON, signature: assertionSignature } =
        executionAssertion ?? {};
      if (!executionAssertion) {
        return res.status(400).json({
          error:
            "this transfer's debit needs passkey approval — " +
            "submit executionAssertion signed over the safeExecution challenge",
        });
      }
      if (credentialId !== user.passkey.credentialId) {
        return res.status(403).json({ error: "passkey credential does not match this account" });
      }
      if (!authenticatorData || !clientDataJSON || !assertionSignature) {
        return res.status(400).json({
          error: "executionAssertion requires authenticatorData, clientDataJSON and signature",
        });
      }
      try {
        const { signCount } = await verifyAssertionForChallenge(
          authenticatorData,
          clientDataJSON,
          assertionSignature,
          user.passkey.publicKey,
          user.passkey.signCount ?? 0,
          user.passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          pendingExecution.challenge,
          true,
        );
        user = store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }
    }
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
    // same signature both clear the CREATED check above, and both could submit
    // the same spend. claimAuthorization is the atomic boundary: after it
    // succeeds once, every other caller sees the authorizedAt marker and stops.
    if (!store.claimAuthorization(transfer.id)) {
      return res.status(409).json({ error: "authorization already submitted for this transfer" });
    }
    // Hand the user-approved execution to the orchestrator. The claim above
    // makes this the single submission allowed to relay it; the debit leg
    // submits the UserOperation, so a failed relay flows through the same
    // FAILED/compensation path as any other debit failure.
    const execution = pendingExecution
      ? {
          plan: pendingExecution.plan,
          userOperation: pendingExecution.userOperation,
          assertion: {
            authenticatorData: b64urlToBuf(executionAssertion.authenticatorData),
            clientDataJSON: b64urlToBuf(executionAssertion.clientDataJSON),
            signature: b64urlToBuf(executionAssertion.signature),
          },
          ...(pendingExecution.batch ? { batch: pendingExecution.batch } : {}),
        }
      : undefined;
    if (pendingExecution) pendingTransferExecutions.delete(transfer.id);
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
        ? await executeSepaTransfer(executableTransfer, user, auth, execution)
        : await executeTransfer(executableTransfer, user, auth, execution);
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
    if (!sandbox) return res.status(400).json({ error: "Monerium app credentials are not configured, so webhook deliveries cannot be re-read" });
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
// Candide recoveries finalize themselves once the grace period has run, so a
// user who lost their phone on a Friday is not waiting for a click on Monday.
if (candideRecoveryEnabled()) {
  const runRecoverySweep = () =>
    sweepCandideRecoveries()
      .then((n) => n && console.log(`recovery sweep: finalized ${n} recover${n === 1 ? "y" : "ies"}`))
      .catch((e) => console.error(`recovery sweep failed: ${e?.message ?? e}`));
  setTimeout(runRecoverySweep, 5_000).unref();
  setInterval(runRecoverySweep, RECOVERY.sweepMs).unref();
  console.log(`RECOVERY: email/SMS guardian via ${RECOVERY.serviceUrl} (chain ${CANDIDE.chainId}, module ${CANDIDE.recoveryModuleAddress})`);
}
// Pay links: expire what is past its date, book our own SEPA payouts that
// carry a code, retry telling a merchant about a paid checkout.
setInterval(
  () =>
    sweepPaymentRequests()
      .then((r) => (r.expired || r.matched) && console.log(`pay-request sweep: ${r.expired} expired, ${r.matched} matched`))
      .catch((e) => console.error(`pay-request sweep failed: ${e?.message ?? e}`)),
  PAYMENT_REQUESTS.sweepMs,
).unref();
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
  console.log("monerium: no app credentials (MONERIUM_CLIENT_SECRET unset) — accounts connect by OAuth or their own API keys");
  if (moneriumApiKeysAvailable()) {
    // Users may still connect their OWN Monerium keys; their deposits and
    // redeem orders are polled on those. The poller does nothing until
    // someone has.
    console.log(`monerium: per-user API-key connections enabled (${moneriumEnvironment()}) — polling connected accounts on their own credentials`);
    startDepositPoller();
  }
}
/**
 * Inbound crypto is a chain concern, not a Monerium one, so this runs whether
 * or not the sandbox is configured. It costs nothing until an account opts in:
 * with no watched users the poller returns before it ever calls getLogs.
 */
if (CRYPTO_IN.enabled) startCryptoDepositPoller();
app.listen(API_PORT, API_HOST, () => {
  console.log(`Zold API listening on http://${API_HOST}:${API_PORT}`);
  /**
   * Say the custody posture out loud at startup.
   *
   * Whether the orchestrator ends up holding a user's funds is decided by the
   * interaction of the liquidity venue and whether Bridge is live, neither of
   * which announces itself. An operator who believes they are running a
   * non-custodial deployment should find out here, not from a regulator.
   */
  const safeExecutable = ["dex", "lifi", "rfq", "best"].includes(LIQUIDITY.PROVIDER);
  if (!safeExecutable) {
    console.warn(
      `CUSTODY: LIQUIDITY_PROVIDER=${LIQUIDITY.PROVIDER} cannot be executed by a user's Safe, so ` +
        "cash-rail transfers debit the full amount to the orchestrator and swap from there. " +
        "The non-custodial path needs dex, lifi, rfq or best.",
    );
  } else if (!BRIDGE.live) {
    console.warn(
      "CUSTODY: the Safe-executed swap batch is available, but BRIDGE_LIVE is not set — with no " +
        "external deposit address the batch delivers its output to the orchestrator. Cash-rail " +
        "transfers are recorded as custodial until Bridge is live.",
    );
  } else {
    console.log(
      "CUSTODY: cash-rail transfers run non-custodially — the user's Safe signs one batch that " +
        "delivers straight to Bridge. The SEPA rail moves only the fee.",
    );
  }
  if (CUSTODY.requireNonCustodial) {
    console.log("CUSTODY: REQUIRE_NON_CUSTODIAL=1 — a transfer that would use the orchestrator is refused.");
  }
  // There are no allowances: every debit is a UserOperation the user's
  // passkey signs for the exact amount and destination. An operator setting
  // these env knobs should hear that they do nothing — silently ignoring them
  // would read as authority that exists but doesn't.
  if (
    process.env.CANDIDE_COSIGNER_EURE_ALLOWANCE_WEI ||
    process.env.CANDIDE_COSIGNER_USDC_ALLOWANCE_UNITS ||
    process.env.CANDIDE_COSIGNER_ALLOWANCE_PERIOD_MINUTES ||
    process.env.CANDIDE_COSIGNER_ALLOWANCE_AMOUNT
  ) {
    console.warn(
      "NOTE: CANDIDE_COSIGNER_*_ALLOWANCE_* env vars are set but co-signer allowances do not " +
        "exist — every Safe debit is a UserOperation the user's passkey signs at send time. " +
        "Standing allowances on older Safes are revoked automatically on the next send.",
    );
  }
});
