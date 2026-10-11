/**
 * Which Monerium credentials act for a given user.
 *
 * Three sources, resolved here so the rest of the code asks for "a client for
 * this user" and never picks a credential itself:
 *
 *  1. `api_keys`: the user's own Monerium app (client id + secret from their
 *     Monerium developer section). Client-credentials grant; the token acts as
 *     that account's owner (its profiles, IBANs, orders).
 *  2. `oauth`: the Authorization Code + PKCE connect flow. Per-user access and
 *     refresh tokens, refreshed here when they expire.
 *  3. The app's credentials from .env (MONERIUM_CLIENT_ID/SECRET), for
 *     accounts approved in-house with no connection of their own.
 *
 * For (1), the linked address and requested IBAN live under the user's
 * Monerium profile, which the app's credentials cannot see. Activation,
 * deposit polling and the SEPA redeem must run on the user's client, or the
 * IBAN issues and no deposit is credited (see `MoneriumClient.orders()` on
 * unscoped calls).
 *
 * The client secret is a bearer credential for a financial account. It and
 * the OAuth tokens are encrypted at rest through `stored-secrets.ts` (v2,
 * bound to the user row; the secret under a purpose of its own), stored only
 * after Monerium has accepted them, and never returned by any endpoint, not
 * even as ciphertext. Without DATA_ENCRYPTION_KEYS neither connector stores
 * anything and both say so; nothing is written in plaintext.
 */
import { MONERIUM, moneriumSandboxEnabled } from "../config.js";
import { dataEncryptionProblem } from "../config/data-keys.js";
import { EncryptionUnavailableError } from "../crypto-at-rest.js";
import { SECRETS } from "../stored-secrets.js";
import { store, type User } from "../store.js";
import {
  MoneriumAccessError,
  MoneriumApiError,
  MoneriumClient,
  refreshAuthorizationToken,
} from "./monerium-client.js";
import { errorText } from "../http/log-cause.js";

export type MoneriumConnectionMethod = "oauth" | "api_keys";

/** Is the per-user API-key connector available on this deployment? */
export const moneriumApiKeysAvailable = () => dataEncryptionProblem() === null;

/** Sandbox or production, read off the base URL Monerium calls go to. */
export function moneriumEnvironment(baseUrl = MONERIUM.baseUrl): "sandbox" | "production" | "custom" {
  let host = "";
  try { host = new URL(baseUrl).host; } catch { return "custom"; }
  if (host === "api.monerium.dev") return "sandbox";
  if (host === "api.monerium.app") return "production";
  return "custom";
}

/** How a stored connection authenticates, or null when the row holds no
 *  secret for it. A `method` is a claim, not a credential: `api_keys` counts
 *  only with an encrypted client secret stored, `oauth` only with an
 *  encrypted access token. Rows written before `method` existed are OAuth
 *  connections. */
export function connectionMethod(user: User): MoneriumConnectionMethod | null {
  const m = user.monerium;
  if (!m) return null;
  const method = m.method ?? (m.apiKeys ? "api_keys" : m.accessTokenEnc ? "oauth" : null);
  if (method === "api_keys") return m.apiKeys?.clientSecretEnc ? "api_keys" : null;
  if (method === "oauth") return m.accessTokenEnc ? "oauth" : null;
  return null;
}

/** Does this user carry Monerium credentials of their own? */
export function hasOwnMoneriumCredentials(user: User): boolean {
  return connectionMethod(user) !== null;
}

/** A row that says the user connected Monerium but holds no secret for it.
 *  Such a user is refused, never served on the app's credentials, which see
 *  every app-provisioned account's profiles, IBANs and orders. */
function claimsConnectionWithoutSecret(user: User): boolean {
  const m = user.monerium;
  return Boolean(m && (m.method || m.accessTokenEnc || m.apiKeys)) && !hasOwnMoneriumCredentials(user);
}

function refuseEmptyConnection(): never {
  throw new MoneriumAccessError(
    "this account's Monerium connection holds no credential — connect Monerium again (OAuth or your own API keys)",
  );
}

/** The refusal for a SEPA send from an account with no Monerium connection.
 *  One body, so the quote route and draft execution refuse identically. */
export const MONERIUM_NOT_CONNECTED = {
  error: "no Monerium connection for this account — sign in with Monerium or add your Monerium API keys before sending",
  code: "MONERIUM_NOT_CONNECTED",
} as const;

/**
 * Whether Monerium is live for this user: a SEPA redeem will be placed and
 * deposits polled. True when the deployment holds app credentials, or the user
 * connected their own account by either method.
 */
export function moneriumLiveFor(user: User): boolean {
  return moneriumSandboxEnabled() || hasOwnMoneriumCredentials(user);
}

const API_KEY_SHAPE = /^[A-Za-z0-9._~:-]{8,200}$/;

export function validateApiKeyInput(body: any): { clientId: string; clientSecret: string; label?: string } {
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body?.clientSecret === "string" ? body.clientSecret.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 60) : undefined;
  if (!API_KEY_SHAPE.test(clientId)) {
    throw new MoneriumApiError("clientId must be the client id of a Monerium app (8-200 characters)", 400);
  }
  if (clientSecret.length < 8 || clientSecret.length > 512 || /\s/.test(clientSecret)) {
    throw new MoneriumApiError("clientSecret must be the app's client secret, 8-512 characters, no whitespace", 400);
  }
  return { clientId, clientSecret, ...(label ? { label } : {}) };
}

export interface VerifiedApiKeys {
  context: any;
  profiles: any[];
  ibans: any[];
  addresses: any[];
}

/**
 * Prove a client id + secret pair against Monerium BEFORE storing it.
 *
 * A stored credential that was never checked is the worst kind: every later
 * failure looks like a bug in the code that uses it. Monerium's 400/401 on the
 * token grant is mapped to a 400 for the caller, everything else (5xx, DNS) is
 * left as the transient it is, so the browser can say "try again" rather than
 * "wrong secret".
 */
export async function verifyApiKeys(clientId: string, clientSecret: string): Promise<VerifiedApiKeys> {
  const client = new MoneriumClient({ baseUrl: MONERIUM.baseUrl, clientId, clientSecret });
  try {
    await client.bearerToken();
  } catch (err: any) {
    const msg = errorText(err);
    const m = msg.match(/Monerium auth failed \((\d{3})\)/);
    const status = m ? Number(m[1]) : 0;
    if (status === 400 || status === 401 || status === 403) {
      throw new MoneriumApiError(
        `Monerium (${moneriumEnvironment()}) rejected these credentials — check the client id and secret, and that they come from the ${moneriumEnvironment()} environment`,
        400,
      );
    }
    throw err;
  }
  const [context, profileRes, ibanRes, addressRes] = await Promise.all([
    client.authContext(),
    client.profiles(),
    client.ibans(),
    client.addresses(),
  ]);
  return {
    context,
    profiles: Array.isArray(profileRes) ? profileRes : (profileRes?.profiles ?? []),
    ibans: Array.isArray(ibanRes) ? ibanRes : (ibanRes?.ibans ?? []),
    addresses: Array.isArray(addressRes) ? addressRes : (addressRes?.addresses ?? []),
  };
}

/* Per-user clients, keyed on the ciphertext so a rotated secret is a new
 * client (and a new token) rather than a cached token for the old one. */
const userClients = new Map<string, { key: string; client: MoneriumClient }>();

function apiKeyClient(user: User): MoneriumClient | null {
  const keys = user.monerium?.apiKeys;
  if (!keys || connectionMethod(user) !== "api_keys") return null;
  const cacheKey = `${keys.clientId}:${keys.clientSecretEnc}`;
  const hit = userClients.get(user.id);
  if (hit && hit.key === cacheKey) return hit.client;
  const client = new MoneriumClient({
    baseUrl: MONERIUM.baseUrl,
    clientId: keys.clientId,
    clientSecret: SECRETS.moneriumApiSecret.open(user.id, keys.clientSecretEnc),
  });
  userClients.set(user.id, { key: cacheKey, client });
  return client;
}

export function forgetUserClient(userId: string) {
  userClients.delete(userId);
}

/**
 * Bearer token for a user's OWN connection — API keys or OAuth. Refreshes an
 * OAuth token when it is within a minute of expiry, persisting the new one.
 * Throws when the user has no connection; callers wanting the app fallback
 * use `moneriumClientFor` / `moneriumLinkAccessToken`.
 */
/** Refreshes in flight, per user: two requests inside the refresh window must
 *  not both spend a refresh token Monerium may rotate. */
const refreshing = new Map<string, Promise<string>>();

export async function moneriumAccessToken(user: User): Promise<string> {
  const keyed = apiKeyClient(user);
  if (keyed) return keyed.bearerToken();
  if (connectionMethod(user) !== "oauth" || !user.monerium?.accessTokenEnc) {
    throw new MoneriumAccessError("Monerium account is not connected");
  }
  if (
    user.monerium.refreshTokenEnc &&
    user.monerium.expiresAt &&
    Date.now() > Date.parse(user.monerium.expiresAt) - 60_000
  ) {
    const inFlight = refreshing.get(user.id);
    if (inFlight) return inFlight;
    const p = refreshOnce(user).finally(() => refreshing.delete(user.id));
    refreshing.set(user.id, p);
    return p;
  }
  return SECRETS.moneriumAccessToken.open(user.id, user.monerium.accessTokenEnc);
}

async function refreshOnce(user: User): Promise<string> {
  // Monerium may rotate the refresh token, so a refresh whose result cannot
  // be stored would cost the user their connection: refuse before spending it.
  const keyProblem = dataEncryptionProblem();
  if (keyProblem) throw new EncryptionUnavailableError(`${keyProblem}, so a refreshed Monerium token could not be stored`);
  const current = user.monerium!;
  const refreshed = await refreshAuthorizationToken(
    {
      baseUrl: MONERIUM.baseUrl,
      clientId: MONERIUM.oauthClientId,
      clientSecret: MONERIUM.clientSecret,
    },
    SECRETS.moneriumRefreshToken.open(user.id, current.refreshTokenEnc!),
  );
  // Re-read after the await: the user may have disconnected, or connected
  // again by another method, while Monerium answered. Only the connection
  // whose refresh token was spent takes the new tokens.
  const now = store.findUser(user.id)?.monerium;
  if (!now || now.method !== current.method || now.refreshTokenEnc !== current.refreshTokenEnc) {
    throw new MoneriumAccessError("the Monerium connection changed while its token was refreshed; nothing was written");
  }
  const next = store.updateUser(user.id, {
    monerium: {
      ...now,
      accessTokenEnc: SECRETS.moneriumAccessToken.seal(user.id, refreshed.access_token),
      refreshTokenEnc: refreshed.refresh_token
        ? SECRETS.moneriumRefreshToken.seal(user.id, refreshed.refresh_token)
        : now.refreshTokenEnc,
      expiresAt: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : now.expiresAt,
    },
  });
  return SECRETS.moneriumAccessToken.open(user.id, next.monerium!.accessTokenEnc!);
}

let appClientCache: MoneriumClient | null = null;

/** The deployment's own Monerium app (MONERIUM_CLIENT_ID/SECRET). */
export function moneriumAppClient(): MoneriumClient {
  appClientCache ??= new MoneriumClient({
    baseUrl: MONERIUM.baseUrl,
    clientId: MONERIUM.clientId,
    clientSecret: MONERIUM.clientSecret,
  });
  return appClientCache;
}

/**
 * The client that can see this user's Monerium objects.
 *
 * API keys and OAuth both return a client bound to the user's own account.
 * A row that claims a connection but holds no secret for it is refused (a
 * MoneriumAccessError, answered as 409 MONERIUM_NOT_CONNECTED). Only a user
 * with no connection at all gets the app client, which works only for
 * accounts the app itself provisioned, and throws a clear error rather than a
 * 401 when the app has no secret at all.
 */
export function moneriumClientFor(user: User): MoneriumClient {
  const keyed = apiKeyClient(user);
  if (keyed) return keyed;
  if (connectionMethod(user) === "oauth") {
    return new MoneriumClient({
      baseUrl: MONERIUM.baseUrl,
      clientId: MONERIUM.oauthClientId,
      tokenProvider: () => moneriumAccessToken(user),
    });
  }
  if (claimsConnectionWithoutSecret(user)) refuseEmptyConnection();
  if (!MONERIUM.clientSecret) {
    throw new MoneriumAccessError(
      "no Monerium access for this account — connect a Monerium account (API keys or OAuth), or set MONERIUM_CLIENT_SECRET for app-level calls",
    );
  }
  return moneriumAppClient();
}

/**
 * Token for address-linking and IBAN requests. `viaApp` tells the caller the
 * app's credentials are acting, which is when the app may need to create a
 * profile of its own for the user.
 */
export async function moneriumLinkAccessToken(user: User): Promise<{ accessToken: string; viaApp: boolean }> {
  if (hasOwnMoneriumCredentials(user)) {
    return { accessToken: await moneriumAccessToken(user), viaApp: false };
  }
  if (claimsConnectionWithoutSecret(user)) refuseEmptyConnection();
  if (!MONERIUM.clientSecret) {
    throw new MoneriumAccessError(
      "no Monerium access for this account — connect a Monerium account, or set MONERIUM_CLIENT_SECRET for app-level address linking",
    );
  }
  return { accessToken: await moneriumAppClient().bearerToken(), viaApp: true };
}

/** Users whose deposits and orders must be polled on their OWN credentials. */
export function usersWithOwnCredentials(): User[] {
  return store.users.filter((u) => hasOwnMoneriumCredentials(u));
}

/** What the browser may know about a stored API-key connection. No secret,
 *  no ciphertext. */
export function publicApiKeys(keys: NonNullable<User["monerium"]>["apiKeys"]) {
  if (!keys) return undefined;
  return {
    clientId: keys.clientId,
    label: keys.label,
    environment: moneriumEnvironment(keys.baseUrl),
    host: (() => { try { return new URL(keys.baseUrl).host; } catch { return keys.baseUrl; } })(),
    verifiedAt: keys.verifiedAt,
    accountEmail: keys.accountEmail,
  };
}
