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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anchorModeEnabled, API_HOST, API_PORT, CHAIN_ID, CRYPTO_IN, FX, KYC, MONERIUM, PRIVACY_BUNDLE, RECOVERY, moneriumSandboxEnabled, SECURITY, STELLAR } from "./config.js";
import { b64urlToBuf, bufToB64url, issueChallenge, verifyAssertion, verifyAssertionForChallenge, verifyRegistration } from "./webauthn.js";
import { moneriumRedeemMessage, paymentMemo, SEPA_REMITTANCE_MAX } from "./sepa.js";
import { initStore, store, type Transfer, type User } from "./store.js";
import { createQuote, isExpired } from "./fx.js";
import { issueIban, simulateSepaDeposit } from "./adapters/monerium.js";
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
  executeUpiTransfer,
  refreshPayout,
  settlePickup,
  sweepAnchorPayouts,
  sweepStrandedTransfers,
} from "./orchestrator.js";
import { startCryptoDepositPoller } from "./adapters/crypto-deposits.js";
import { HandleError, normaliseDisplayName, normaliseHandle, publicPayee } from "./pay.js";
import { qrSvg } from "./qr.js";
import { isValidVpa } from "./adapters/upi.js";
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
import {
  addrs,
  accountBalances,
  assertChainMatches,
  destinationCommitment,
  eur,
  orchestratorAddress,
  paymentAuthorizationTypedData,
  publicClient,
  setVaultAuthorizer,
  transferIdHash,
  vaultAuthorizerOf,
  vaultBalance,
} from "./chain.js";
import {
  CANDIDE,
  isDeployed,
  preparePasskeySafeDeployment,
  safeMessageHash,
  signMessageAsPasskeySafe,
  smartAccountFor,
  smartAccountForPasskeyCosigner,
  submitPasskeySafeDeployment,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "./wallet/candide.js";
import {
  exchangeAuthorizationCode,
  LINK_MESSAGE,
  moneriumBearerRequest,
  refreshAuthorizationToken,
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

app.use(express.static(pub));

type PendingPasskeySafeDeployment = Awaited<ReturnType<typeof preparePasskeySafeDeployment>>["userOperation"];
const pendingPasskeySafeDeployments = new Map<string, { userId: string; expiresAt: number; userOperation: PendingPasskeySafeDeployment }>();
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

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const block = await publicClient.getBlockNumber();
    res.json({ ok: true, block: Number(block), contracts: addrs() });
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

/** Never send wallet keys, OAuth state, or encrypted tokens to the client. */
const publicUser = ({ privateKey, moneriumConnect, monerium, passkey, ...u }: User & { [k: string]: any }) => ({
  ...u,
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
    return "a passkey/co-signer Safe plan is required before an account can be funded";
  }
  if (
    user.passkeySafe.status !== "active" ||
    user.address.toLowerCase() !== user.passkeySafe.address.toLowerCase()
  ) {
    return "activate the passkey/co-signer Safe before funding this account";
  }
  if (user.privateKey || user.ownerAddress) {
    return "server-held Safe owner keys must be removed before funding this account";
  }
  return null;
}

function passkeyRequiredBeforeFunding(user: User): string | null {
  const blocked = custodyBlockerBeforeFunding(user);
  if (!blocked) return null;
  return (
    blocked +
    (blocked.includes("passkey/co-signer Safe") ? "" : " — complete the passkey Safe setup first")
  );
}

function passkeySafePlan(
  user: User,
  publicKey: NonNullable<NonNullable<User["passkey"]>["publicKey"]>,
): User["passkeySafe"] | undefined {
  if (!publicKey || publicKey.alg !== "ES256") return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(CANDIDE.cosignerAddress)) return undefined;
  const cosignerAddress = CANDIDE.cosignerAddress as `0x${string}`;
  const owner = webauthnOwnerFromJwk(publicKey.jwk);
  if (!owner) return undefined;
  const account = smartAccountForPasskeyCosigner(owner, cosignerAddress);
  const recoveryGuardianAddress = /^0x[0-9a-fA-F]{40}$/.test(CANDIDE.recoveryGuardianAddress)
    ? (CANDIDE.recoveryGuardianAddress as `0x${string}`)
    : undefined;
  return {
    address: account.accountAddress as `0x${string}`,
    status: "planned",
    threshold: 2,
    cosignerAddress,
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
    const id = randomUUID();
    // Local simulation keeps the no-authenticator e2e path available. Outside
    // simulation, the real address is set by passkey/co-signer Safe deployment.
    const legacyWallet = SECURITY.allowSimulation;
    const privateKey = legacyWallet ? generatePrivateKey() : undefined;
    const ownerAddress = privateKey ? privateKeyToAccount(privateKey).address : undefined;
    const safeAddress = ownerAddress ? (smartAccountFor(ownerAddress).accountAddress as `0x${string}`) : ZERO_ADDRESS;
    const kycStatus = KYC.autoApprove ? "approved" : "pending";
    const user: User = {
      id,
      name,
      email,
      country,
      kycStatus,
      kyc: {
        provider: KYC.autoApprove ? "mock" : "manual",
        checkedAt: KYC.autoApprove ? new Date().toISOString() : undefined,
      },
      iban: kycStatus === "approved" && !sandbox ? issueIban(id) : "",
      address: safeAddress,
      ...(ownerAddress ? { ownerAddress } : {}),
      ...(privateKey ? { privateKey } : {}),
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
 * Turn auto-conversion of inbound crypto on or off.
 *
 * Session-gated to the account itself: this decides whether someone's USDC
 * becomes e-money at a rate they will not see beforehand, which is the user's
 * call and nobody else's. Switching it off does not un-convert anything that
 * already settled; it only stops future deposits being touched.
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
    const updated = store.updateUser(user.id, { autoConvert: enabled });
    res.json({ ...publicUser(updated), ...(await accountBalances(updated.address).catch(() => ({}))) });
  }),
);

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
 * KYC-gated, like every other route that leads to money arriving: an inbound
 * payment is only useful once it can be converted, and conversion refuses on an
 * unapproved account. Gating here means the public page never has to expose an
 * account's review status to explain itself.
 */
app.post(
  "/api/users/:id/handle",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    let handle: string;
    let displayName: string | undefined;
    try {
      handle = normaliseHandle(req.body?.handle);
      displayName = normaliseDisplayName(req.body?.displayName);
    } catch (e: any) {
      if (e instanceof HandleError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const taken = store.findUserByHandle(handle);
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: `"${handle}" is already taken` });
    }
    const updated = store.updateUser(user.id, { handle, payDisplayName: displayName });
    res.json({ handle: updated.handle, displayName: updated.payDisplayName, payUrl: `/pay/${handle}` });
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
    if (!user?.handle) return res.status(404).json({ error: "no such payment page" });
    res.json(publicPayee(user, payChain()));
  }),
);

/** The QR image, rendered server-side. Carries the bare address: see the note
 *  in pay.ts on why the EIP-681 URI is a link instead. */
app.get(
  "/api/pay/:handle/qr.svg",
  wrap(async (req, res) => {
    const user = store.findUserByHandle(req.params.handle);
    if (!user?.handle) return res.status(404).json({ error: "no such payment page" });
    res.type("image/svg+xml");
    res.setHeader("cache-control", "public, max-age=300");
    res.send(qrSvg(user.address));
  }),
);

/** The page itself. Served for any handle shape — the client fetches the payee
 *  and renders its own not-found, so a bad link still gets a real page. */
app.get("/pay/:handle", (_req, res) => {
  res.sendFile(path.join(pub, "pay.html"));
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
      autoConvert: !!user.autoConvert,
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
    const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0, vaultBalanceEur: 0 }));
    res.json({ ...publicUser(updated), ...balances });
  }),
);

app.post(
  "/api/users/:id/monerium/connect/start",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!MONERIUM.clientId || !MONERIUM.clientSecret) {
      return res.status(503).json({ error: "Monerium OAuth client is not configured" });
    }
    if (!MONERIUM.tokenEncryptionKey) {
      return res.status(503).json({ error: "Monerium token encryption key is not configured" });
    }
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const redirectUri = MONERIUM.redirectUri;
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
      client_id: MONERIUM.clientId,
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
        clientId: MONERIUM.clientId,
        clientSecret: MONERIUM.clientSecret,
      },
      {
        code,
        codeVerifier: user.moneriumConnect.codeVerifier,
        redirectUri: user.moneriumConnect.redirectUri,
      },
    );
    const snapshot = await readMoneriumAccountSnapshot(user, token.access_token);
    const firstProfile = snapshot.profiles[0];
    store.updateUser(user.id, {
      moneriumConnect: undefined,
      monerium: {
        connectedAt: new Date().toISOString(),
        profileId: firstProfile?.id,
        accessTokenEnc: encryptToken(token.access_token),
        refreshTokenEnc: token.refresh_token ? encryptToken(token.refresh_token) : undefined,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
        profiles: snapshot.profiles,
        ibans: snapshot.ibans,
        addresses: snapshot.addresses,
      },
      funding: {
        ...(user.funding ?? { mode: "sandbox", status: "kyc_pending" as const }),
        status: "kyc_pending" as const,
        detail: "select a Monerium profile and activate an app IBAN",
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
    await moneriumAccessToken(user);
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
    const accessToken = await moneriumAccessToken(user);

    if (!(await isDeployed(user.address))) {
      return res.status(409).json({
        error: "passkey Safe must be deployed before Monerium address linking",
      });
    }
    if (!user.passkey?.publicKey || !user.passkeySafe || user.passkeySafe.status !== "active") {
      return res.status(409).json({ error: "active passkey Safe required before Monerium address linking" });
    }
    const requestId = typeof req.body?.linkSignatureRequestId === "string" ? req.body.linkSignatureRequestId : "";
    prunePendingMoneriumLinkSignatures();
    const pending = requestId ? pendingMoneriumLinkSignatures.get(requestId) : undefined;
    if (!pending || pending.userId !== user.id) {
      return res.status(409).json({
        error: "fresh passkey Safe signature required for Monerium address linking",
        start: `/api/users/${user.id}/monerium/link-signature/start`,
      });
    }
    pendingMoneriumLinkSignatures.delete(requestId);
    const profileIdFromBody = typeof req.body?.profileId === "string" ? req.body.profileId : undefined;
    if (pending.profileId && profileIdFromBody && pending.profileId !== profileIdFromBody) {
      return res.status(400).json({ error: "profileId does not match the signed Monerium linking request" });
    }
    const profileId = pending.profileId ?? profileIdFromBody ?? user.monerium?.profileId;
    const { credentialId, authenticatorData, clientDataJSON, signature: assertionSignature } = req.body ?? {};
    if (credentialId !== user.passkey.credentialId) {
      return res.status(403).json({ error: "passkey credential does not match this account" });
    }
    if (!authenticatorData || !clientDataJSON || !assertionSignature) {
      return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
    }
    let signature: `0x${string}`;
    const passkeySafe = user.passkeySafe;
    try {
      const { signCount } = await verifyAssertionForChallenge(
        authenticatorData,
        clientDataJSON,
        assertionSignature,
        user.passkey.publicKey,
        user.passkey.signCount ?? 0,
        user.passkey.rpId ?? SECURITY.rpId,
        SECURITY.origins,
        pending.challenge,
        true,
      );
      user = store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
      signature = await signMessageAsPasskeySafe(passkeySafe, user.address, LINK_MESSAGE, {
        authenticatorData: b64urlToBuf(authenticatorData),
        clientDataJSON: b64urlToBuf(clientDataJSON),
        signature: b64urlToBuf(assertionSignature),
      });
    } catch (err: any) {
      return res.status(401).json({ error: String(err?.message ?? err) });
    }
    await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/addresses", {
      address: user.address,
      signature,
      chain: MONERIUM.chain,
      message: LINK_MESSAGE,
      ...(profileId ? { profile: profileId } : {}),
    });
    await moneriumBearerRequest(MONERIUM.baseUrl, accessToken, "POST", "/ibans", {
      address: user.address,
      chain: MONERIUM.chain,
    });
    const snapshot = await readMoneriumAccountSnapshot(user, accessToken);
    const iban = snapshot.ibans.find(
      (i: any) => String(i.address ?? "").toLowerCase() === user.address.toLowerCase() && i.iban,
    )?.iban;
    const updated = store.updateUser(user.id, {
      iban: iban ?? "",
      kycStatus: iban ? "approved" : user.kycStatus,
      kyc: {
        provider: "monerium",
        onboardingPath: "existing_monerium",
        checkedAt: iban ? new Date().toISOString() : undefined,
        // Record which Monerium profile this approval rests on. The approval is
        // delegated trust — nothing here checks that the connected profile is
        // the same person as the local account — so at minimum it must be
        // auditable after the fact.
        applicantId: profileId,
        reason: iban
          ? `approved via connected Monerium profile ${profileId ?? "(unnamed)"}`
          : user.kyc?.reason,
      },
      funding: {
        mode: "sandbox",
        status: iban ? "active" : "iban_pending",
        moneriumProfileId: profileId,
        detail: iban ? undefined : "Monerium IBAN requested; waiting for activation",
      },
      monerium: { ...user.monerium!, profileId, ...snapshot },
    });
    const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0, vaultBalanceEur: 0 }));
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
  provider: "mock" | "manual" | "monerium",
  reason?: string,
) {
  const updated = store.updateUser(user.id, {
    ...(decision === "approved"
      ? fundableUserPatch(user)
      : { funding: { ...user.funding!, status: "kyc_pending" as const } }),
    kycStatus: decision,
    kyc: {
      provider,
      checkedAt: new Date().toISOString(),
      reason: typeof reason === "string" ? reason : undefined,
    },
  });
  if (sandbox && decision === "approved") queueSandboxProvisioning(updated);
  const balances = await accountBalances(updated.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0, vaultBalanceEur: 0 }));
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

/** Refuse a send that would take the account past its daily cap, counting both
 *  funding sources. The arithmetic lives in dailyCapUsage so it can be tested
 *  without standing up the HTTP layer. */
async function assertDailyCap(
  user: User,
  sendEur: number,
  res: express.Response,
): Promise<boolean> {
  const { capEur, usedEur, fromVaultEur, fromSafeEur } = await dailyCapUsage(user);
  if (usedEur + sendEur > capEur) {
    res.status(400).json({
      error:
        `amount exceeds the daily cap of €${capEur.toFixed(2)} ` +
        `(already used €${usedEur.toFixed(2)} today: €${fromVaultEur.toFixed(2)} from the vault, ` +
        `€${fromSafeEur.toFixed(2)} from the Safe)`,
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
    if (["FINALIZED", "CANCELED", "EXPIRED"].includes(request.status)) {
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
          ? "guardian signer integration must submit the on-chain SocialRecoveryModule recovery transaction"
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
    if (!CANDIDE.cosignerKey) {
      return res.status(503).json({ error: "CANDIDE_COSIGNER_KEY is required before passkey Safe deployment" });
    }
    const deployment = await preparePasskeySafeDeployment(user.passkeySafe);
    if (deployment.challenge === "0x") {
      const updated = store.updateUser(user.id, {
        address: user.passkeySafe.address,
        ownerAddress: undefined,
        privateKey: undefined,
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
    if (balances.safeBalanceEur > 0 || balances.vaultBalanceEur > 0) {
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
    const updated = store.updateUser(user.id, {
      address: user.passkeySafe.address,
      ownerAddress: undefined,
      privateKey: undefined,
      wallet: { type: "candide-safe", deployed: true, deployOpHash: opHash ?? undefined },
      passkeySafe: activatePasskeySafePlan(user.passkeySafe),
    });
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
    const balances = await accountBalances(user.address).catch(() => ({ balanceEur: 0, safeBalanceEur: 0, vaultBalanceEur: 0 }));
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
    const { userId, sendEur, receiveInr, rail = "cash" } = req.body ?? {};
    const user = store.findUser(userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    if (!["cash", "sepa", "upi"].includes(rail)) {
      return res.status(400).json({ error: "rail must be cash, sepa or upi" });
    }
    if (rail === "upi") {
      const inr = Number(receiveInr);
      const eur = Number(sendEur);
      if (!(inr > 0) && !(eur > 0)) {
        return res.status(400).json({ error: "receiveInr or sendEur required for upi" });
      }
      const quote = await createQuote(userId, {
        rail,
        receiveInr: inr > 0 ? inr : undefined,
        sendEur: eur > 0 ? eur : undefined,
      });
      if (quote.sendEur > FX.DAILY_CAP_EUR) {
        return res.status(400).json({ error: `amount exceeds daily cap of €${FX.DAILY_CAP_EUR}` });
      }
      return res.status(201).json(quote);
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
    const { quoteId, recipientName, recipientPhone, recipientIban, recipientVpa, reference } =
      req.body ?? {};
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
    if (quote.rail === "upi") {
      if (!recipientVpa || !isValidVpa(recipientVpa)) {
        return res.status(400).json({ error: "valid recipientVpa required (e.g. merchant@okicici)" });
      }
    } else if (!recipientName) {
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
    let fundingSource: Transfer["fundingSource"] = "vault";
    if (balances.vaultBalanceEur < quote.sendEur) {
      if (balances.safeBalanceEur >= quote.sendEur) {
        fundingSource = "safe";
      } else {
        return res.status(400).json({
          error:
            `insufficient balance (safe €${balances.safeBalanceEur.toFixed(2)}, ` +
            `vault €${balances.vaultBalanceEur.toFixed(2)})`,
        });
      }
    }
    if (fundingSource === "safe" && !user.privateKey) {
      return res.status(409).json({
        error:
          "funds are in the Safe, but this account has no Safe owner key in the API store; " +
          "create a new passkey/Safe account or recover the Safe before this transfer can execute",
        safeBalanceEur: balances.safeBalanceEur,
        vaultBalanceEur: balances.vaultBalanceEur,
      });
    }
    if (!(await assertDailyCap(user, quote.sendEur, res))) return;

    const createdAt = new Date().toISOString();
    const transfer: Transfer = {
      id: randomUUID(),
      userId: user.id,
      quoteId: quote.id,
      rail: quote.rail,
      recipientName: recipientName || (quote.rail === "upi" ? recipientVpa : ""),
      recipientPhone,
      recipientIban,
      recipientVpa,
      reference: reference || undefined,
      state: "CREATED" as const,
      sendEur: quote.sendEur,
      receiveKes: quote.receiveKes,
      receiveEur: quote.receiveEur,
      receiveInr: quote.receiveInr,
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
    // FP4: the account must be bound to a device key before it can spend.
    const authorizer = await vaultAuthorizerOf(user.address);
    if (authorizer === "0x0000000000000000000000000000000000000000") {
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
      vpa: transfer.recipientVpa,
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
 * FP4: register the device key that may authorize debits from this account.
 * The browser generates the key, keeps the private half, and sends only the
 * address. The vault accepts the first binding from the ramp role and refuses
 * every later one from anybody but the device itself — so this endpoint can
 * establish a binding, never steal one.
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
    const onChain = await vaultAuthorizerOf(user.address);
    if (onChain !== "0x0000000000000000000000000000000000000000") {
      if (onChain.toLowerCase() !== address.toLowerCase()) {
        return res.status(409).json({
          error: "this account is already bound to a different device key — rotate it from that device",
          authorizerAddress: onChain,
        });
      }
      return res.json(publicUser(store.updateUser(user.id, { authorizerAddress: onChain })));
    }
    const hash = await setVaultAuthorizer(user.address, address as `0x${string}`);
    const updated = store.updateUser(user.id, { authorizerAddress: address as `0x${string}` });
    res.status(201).json({ ...publicUser(updated), txHash: hash });
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
    const user = store.findUser(transfer.userId)!;
    if (!requireKycApproved(user, res)) return;
    // Claim the authorization before anything awaits. Two parallel submissions
    // of the same signature both used to clear the CREATED check above, both
    // submitted `debit`, and the one the vault rejected as a duplicate took the
    // compensation path — re-crediting the sender while the other completed the
    // payout. The claim is atomic because nothing yields between here and it.
    if (!store.claimAuthorization(transfer.id)) {
      return res.status(409).json({ error: "authorization already submitted for this transfer" });
    }
    if (typeof redeemSignature === "string" && transfer.moneriumRedeem) {
      executableTransfer = store.updateTransfer(transfer.id, {
        moneriumRedeem: {
          ...transfer.moneriumRedeem,
          signature: redeemSignature as `0x${string}`,
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
        : executableTransfer.rail === "upi"
          ? await executeUpiTransfer(executableTransfer, user, auth)
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
// rejected by the vault as "bad authorization", which reads like a signing bug.
assertChainMatches().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
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
// the local vault should be loud rather than discovered later by a user
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
  console.log("monerium: mock mode (set MONERIUM_CLIENT_ID/SECRET in .env for sandbox)");
}
/**
 * Inbound crypto is a chain concern, not a Monerium one, so this runs whether
 * or not the sandbox is configured. It costs nothing until an account opts in:
 * with no watched users the poller returns before it ever calls getLogs.
 */
if (CRYPTO_IN.enabled) startCryptoDepositPoller();
app.listen(API_PORT, API_HOST, () => {
  console.log(`Zold API listening on http://${API_HOST}:${API_PORT}`);
});
