/**
 * Turnkey wallets for social recovery guardians (docs/recovery-guardians-plan.md,
 * Phase 2). A guardian is an Ethereum account in a Turnkey sub-organisation
 * whose only root user is the person: the user's own Google or Apple login
 * (`self-social`) or, later, someone they trust.
 *
 * THE INVARIANT: every sub-org this API creates has exactly one root user,
 * the person, at root quorum 1, with no API key and no authenticator of ours
 * and no delegated access. `buildGuardianSubOrg` makes that payload and
 * `assertPersonOnlySubOrg` checks it again right before it is sent;
 * scripts/turnkey-guardian-test.ts greps this file for anything else. With
 * that shape the parent organisation can read a sub-org but cannot sign with,
 * export or delete its wallet (Turnkey docs, checked 2026-10-10).
 *
 * The backend never signs. The guardian signs the ExecuteRecovery digest in
 * the browser (sign_raw_payload, NO_OP hash); the API only turns Turnkey's
 * r, s, v into a 65-byte signature and recovers the address.
 *
 * Not verified against Turnkey: nothing here has reached api.turnkey.com.
 */
import { createECDH, createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient, createActivityPoller, type TurnkeyApiTypes } from "@turnkey/http";
import { getAddress, isAddress, recoverAddress, type Hex } from "viem";
import { TURNKEY } from "../config.js";
import { redactedMessage } from "../http/log-cause.js";

export type GuardianSubOrgParams = TurnkeyApiTypes["v1CreateSubOrganizationIntentV8"];

export class TurnkeyGuardianError extends Error {
  constructor(message: string, readonly status = 409, readonly code?: string) {
    super(message);
  }
}

export const turnkeyGuardiansEnabled = (): boolean => TURNKEY.enabled;

// ---------------------------------------------------------------------------
// The sub-org payload

/** The one guardian account: Ethereum, secp256k1, first BIP-44 address. */
const GUARDIAN_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

/**
 * Logins a guardian may use. Never an OIDC issuer we run (Auth0, Cognito, a
 * Turnkey-issued token for X or Discord): we could mint its tokens and so log
 * in as the guardian.
 */
const OIDC_ISSUERS: Record<string, OidcProvider> = {
  // Google also issues the bare "accounts.google.com"; one spelling only, so
  // one person cannot end up with two sub-orgs that Turnkey tells apart.
  "https://accounts.google.com": "Google",
  "https://appleid.apple.com": "Apple",
};
type OidcProvider = "Google" | "Apple";

/** The guardian sub-org for one login. The name is random: it carries no
 *  user id and no email, so Turnkey's records do not link it to an account. */
export function buildGuardianSubOrg(args: { oidcToken: string; providerName: OidcProvider }): GuardianSubOrgParams {
  const params: GuardianSubOrgParams = {
    subOrganizationName: `zold-guardian-${randomBytes(16).toString("hex")}`,
    rootUsers: [
      {
        userName: "Guardian",
        apiKeys: [],
        authenticators: [],
        oauthProviders: [{ providerName: args.providerName, oidcToken: args.oidcToken }],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Recovery guardian", accounts: [{ ...GUARDIAN_ACCOUNT }] },
  };
  return assertPersonOnlySubOrg(params);
}

const onlyKeys = (o: object, allowed: string[], what: string) => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`guardian sub-org: unexpected ${what} field(s) ${extra.join(", ")}`);
};

/**
 * The invariant, checked on the exact object sent. An allowlist, not a
 * denylist: a field Turnkey adds later (or one we add by mistake) is refused
 * until someone decides it keeps the person the only root.
 */
export function assertPersonOnlySubOrg(p: GuardianSubOrgParams): GuardianSubOrgParams {
  const fail = (why: string): never => {
    throw new Error(`guardian sub-org refused: ${why}`);
  };
  onlyKeys(p, ["subOrganizationName", "rootUsers", "rootQuorumThreshold", "wallet"], "top-level");
  if (!Array.isArray(p.rootUsers) || p.rootUsers.length !== 1) fail("exactly one root user, the person");
  if (p.rootQuorumThreshold !== 1) fail("root quorum must be 1");
  const [user] = p.rootUsers;
  onlyKeys(user, ["userName", "apiKeys", "authenticators", "oauthProviders"], "root user");
  if (!Array.isArray(user.apiKeys) || user.apiKeys.length !== 0) fail("no API key in a sub-org");
  if (!Array.isArray(user.authenticators) || user.authenticators.length !== 0) fail("no authenticator from us");
  if (!Array.isArray(user.oauthProviders) || user.oauthProviders.length !== 1) fail("exactly one login");
  const [login] = user.oauthProviders;
  onlyKeys(login, ["providerName", "oidcToken"], "login");
  if (typeof login.oidcToken !== "string" || !login.oidcToken) fail("the login needs the person's ID token");
  if (!p.wallet) fail("one wallet");
  onlyKeys(p.wallet!, ["walletName", "accounts"], "wallet");
  if (!Array.isArray(p.wallet!.accounts) || p.wallet!.accounts.length !== 1) fail("exactly one wallet account");
  const account = p.wallet!.accounts[0] as Record<string, unknown>;
  onlyKeys(account, Object.keys(GUARDIAN_ACCOUNT), "wallet account");
  for (const [k, v] of Object.entries(GUARDIAN_ACCOUNT)) if (account[k] !== v) fail(`wallet account ${k} must be ${v}`);
  return p;
}

// ---------------------------------------------------------------------------
// The login token

/** Turnkey binds an OIDC token to the browser's session key by its nonce:
 *  sha256 over the compressed public key's hex string. */
export const oidcNonceFor = (publicKey: string): string => createHash("sha256").update(publicKey).digest("hex");

/**
 * Checks the claims of a Google or Apple ID token before it goes to Turnkey.
 * Turnkey verifies the signature; this refuses early what Turnkey might
 * accept but we must not: an issuer we could run, another app's client id,
 * or a token not bound to the key in this browser (so neither we nor anyone
 * who sees the token in transit can use it with a key of their own).
 */
export function checkGuardianOidcToken(oidcToken: unknown, publicKey: unknown) {
  const bad = (why: string): never => {
    throw new TurnkeyGuardianError(`login token refused: ${why}`, 400, "BAD_OIDC_TOKEN");
  };
  if (typeof publicKey !== "string" || !/^0[23][0-9a-f]{64}$/.test(publicKey)) bad("publicKey must be a compressed P-256 key in lower-case hex");
  if (typeof oidcToken !== "string" || oidcToken.length > 8192) bad("not a JWT");
  const parts = (oidcToken as string).split(".");
  if (parts.length !== 3) bad("not a JWT");
  let claims: Record<string, unknown> = {};
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    bad("not a JWT");
  }
  const providerName = typeof claims.iss === "string" ? OIDC_ISSUERS[claims.iss] : undefined;
  if (!providerName) bad("only Google and Apple logins can be guardians");
  const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
  if (typeof aud !== "string" || !TURNKEY.oauthClientIds.includes(aud)) bad("issued for another app");
  if (claims.nonce !== oidcNonceFor(publicKey as string)) bad("not bound to this browser's key");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) bad("expired");
  if (typeof claims.sub !== "string" || !claims.sub) bad("no subject");
  return { providerName: providerName!, issuer: claims.iss as string, subject: claims.sub as string };
}

/** Where Google and Apple publish the keys their ID tokens are signed with. */
export const JWKS_URLS: Record<OidcProvider, string> = {
  Google: "https://www.googleapis.com/oauth2/v3/certs",
  Apple: "https://appleid.apple.com/auth/keys",
};
/** The provider's signing keys; `fresh` skips the cache (a new kid after a rotation). */
export type JwksSource = (provider: OidcProvider, fresh?: boolean) => Promise<JsonWebKey[]>;

const JWKS_TTL_MS = 60 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const jwksCache = new Map<OidcProvider, { keys: JsonWebKey[]; at: number }>();

export const fetchJwks: JwksSource = async (provider, fresh = false) => {
  const hit = jwksCache.get(provider);
  if (hit && !fresh && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  try {
    const r = await fetch(JWKS_URLS[provider], { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { keys } = (await r.json()) as { keys?: JsonWebKey[] };
    if (!Array.isArray(keys) || !keys.length) throw new Error("no keys");
    jwksCache.set(provider, { keys, at: Date.now() });
    return keys;
  } catch (e) {
    throw new TurnkeyGuardianError(`cannot read ${provider}'s signing keys (${redactedMessage(e)}); try again`, 503, "JWKS_UNAVAILABLE");
  }
};

/**
 * The claims checks above, plus the token's RS256 signature against the
 * provider's published keys. Every claim is public or computable, so without
 * this anyone could write a token naming someone else's Google account; with
 * it, nothing reaches Turnkey that Google or Apple did not sign. Fails closed:
 * keys that cannot be read refuse the login.
 */
export async function verifyGuardianOidcToken(oidcToken: unknown, publicKey: unknown, jwks: JwksSource = fetchJwks) {
  const login = checkGuardianOidcToken(oidcToken, publicKey);
  const bad = (why: string): never => {
    throw new TurnkeyGuardianError(`login token refused: ${why}`, 400, "BAD_OIDC_TOKEN");
  };
  const [h, p, s] = (oidcToken as string).split(".");
  let header: { alg?: unknown; kid?: unknown } = {};
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    bad("not a JWT");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") bad("must be RS256 with a key id");
  const find = (keys: JsonWebKey[]) => keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  const key = find(await jwks(login.providerName)) ?? find(await jwks(login.providerName, true));
  if (!key) bad("signed with a key the provider does not publish");
  let ok = false;
  try {
    ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: key!, format: "jwk" }), Buffer.from(s, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) bad("signature does not verify");
  return login;
}

// ---------------------------------------------------------------------------
// The guardian's signature

/**
 * Turnkey's sign_raw_payload answers r, s and v as hex, with v the recovery
 * id 0/1. The recovery module's ECDSA check wants 27/28, so v is normalised
 * here, as for the Zoldenburg guardian (recovery/zoldenburg-guardian.ts).
 */
export function turnkeySignatureHex(sig: { r: string; s: string; v: string }): Hex {
  const bad = (why: string): never => {
    throw new TurnkeyGuardianError(`guardian signature refused: ${why}`, 400, "BAD_SIGNATURE");
  };
  const strip = (h: unknown) => (typeof h === "string" ? h.replace(/^0x/i, "").toLowerCase() : "");
  const r = strip(sig?.r);
  const s = strip(sig?.s);
  if (!/^[0-9a-f]{64}$/.test(r) || !/^[0-9a-f]{64}$/.test(s)) bad("r and s must be 32 bytes of hex");
  const v = parseInt(strip(sig?.v) || "x", 16);
  const normalised = v === 0 || v === 1 ? v + 27 : v === 27 || v === 28 ? v : bad(`unexpected v=${sig?.v}`);
  return `0x${r}${s}${(normalised as number).toString(16)}`;
}

export async function recoverTurnkeySigner(digest: Hex, sig: { r: string; s: string; v: string }): Promise<`0x${string}`> {
  return recoverAddress({ hash: digest, signature: turnkeySignatureHex(sig) });
}

// ---------------------------------------------------------------------------
// Turnkey itself

/** What the routes need from Turnkey, so a test can stand in for it. */
export interface TurnkeyGuardianClient {
  /** Sub-orgs under our parent whose root logs in with this token's identity. */
  subOrgIdsForOidcToken(oidcToken: string): Promise<string[]>;
  createSubOrg(params: GuardianSubOrgParams): Promise<{ subOrgId: string; address: `0x${string}` }>;
  /** The sub-org's one guardian account, after checking the sub-org's shape. */
  walletAddress(subOrgId: string): Promise<`0x${string}`>;
  /** A session for the person's own sub-org, bound to their browser key. */
  oauthLogin(subOrgId: string, oidcToken: string, publicKey: string): Promise<string>;
}

/**
 * A sub-org found by login rather than created here gets the invariant
 * checked on what Turnkey reports: one user, who is the whole root quorum at
 * threshold 1, with no API key. The person's own passkeys are theirs to add.
 */
export function assertFoundSubOrg(org: { users?: { userId: string; apiKeys?: unknown[] }[]; rootQuorum?: { threshold: number; userIds: string[] } }) {
  const fail = (why: string): never => {
    throw new TurnkeyGuardianError(`guardian sub-org refused: ${why}`, 409, "SUB_ORG_SHAPE");
  };
  const users = org.users ?? [];
  if (users.length !== 1) fail(`it has ${users.length} users, expected the person alone`);
  if ((users[0].apiKeys ?? []).length !== 0) fail("it holds an API key");
  const q = org.rootQuorum;
  if (!q || q.threshold !== 1 || q.userIds.length !== 1 || q.userIds[0] !== users[0].userId) fail("its root quorum is not the person alone");
}

/** The parent API key's public half, derived from the private key so only
 *  one value is a secret. Compressed P-256, as Turnkey stores API keys. */
export function turnkeyApiPublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(process.env.TURNKEY_API_PRIVATE_KEY ?? "", "hex"));
  return ecdh.getPublicKey("hex", "compressed");
}

/** Session length for a guardian's login: long enough to approve one
 *  recovery, short enough that a forgotten tab does not keep it. */
const LOGIN_SECONDS = "900";

let client: TurnkeyGuardianClient | undefined;

export function turnkeyClient(): TurnkeyGuardianClient {
  if (!TURNKEY.enabled) throw new TurnkeyGuardianError("Turnkey guardians are off on this deployment", 404, "TURNKEY_OFF");
  if (client) return client;
  const http = new TurnkeyClient(
    { baseUrl: TURNKEY.baseUrl },
    new ApiKeyStamper({ apiPublicKey: turnkeyApiPublicKey(), apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY! }),
  );
  const organizationId = TURNKEY.organizationId;
  client = {
    async subOrgIdsForOidcToken(oidcToken) {
      const r = await http.getSubOrgIds({ organizationId, filterType: "OIDC_TOKEN", filterValue: oidcToken });
      return r.organizationIds ?? [];
    },
    async createSubOrg(params) {
      const activity = await createActivityPoller({ client: http, requestFn: http.createSubOrganization })({
        type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
        timestampMs: String(Date.now()),
        organizationId,
        parameters: assertPersonOnlySubOrg(params),
      });
      const result = activity.result.createSubOrganizationResultV8;
      const addresses = result?.wallet?.addresses ?? [];
      if (!result?.subOrganizationId || addresses.length !== 1 || !isAddress(addresses[0])) {
        throw new TurnkeyGuardianError("Turnkey created the sub-org without exactly one Ethereum address", 502, "TURNKEY_FAILED");
      }
      return { subOrgId: result.subOrganizationId, address: getAddress(addresses[0]) };
    },
    async walletAddress(subOrgId) {
      const { organizationData } = await http.getOrganization({ organizationId: subOrgId });
      assertFoundSubOrg(organizationData);
      const { wallets } = await http.getWallets({ organizationId: subOrgId });
      if (wallets.length !== 1) throw new TurnkeyGuardianError(`guardian sub-org has ${wallets.length} wallets, expected 1`, 502, "TURNKEY_FAILED");
      const { accounts } = await http.getWalletAccounts({ organizationId: subOrgId, walletId: wallets[0].walletId });
      const eth = accounts.filter((a) => a.addressFormat === GUARDIAN_ACCOUNT.addressFormat);
      if (eth.length !== 1 || !isAddress(eth[0].address)) {
        throw new TurnkeyGuardianError("guardian sub-org does not hold exactly one Ethereum account", 502, "TURNKEY_FAILED");
      }
      return getAddress(eth[0].address);
    },
    async oauthLogin(subOrgId, oidcToken, publicKey) {
      const activity = await createActivityPoller({ client: http, requestFn: http.oauthLogin })({
        type: "ACTIVITY_TYPE_OAUTH_LOGIN",
        timestampMs: String(Date.now()),
        organizationId: subOrgId,
        parameters: { oidcToken, publicKey, expirationSeconds: LOGIN_SECONDS, invalidateExisting: true },
      });
      const session = activity.result.oauthLoginResult?.session;
      if (!session) throw new TurnkeyGuardianError("Turnkey returned no session", 502, "TURNKEY_FAILED");
      return session;
    },
  };
  return client;
}
