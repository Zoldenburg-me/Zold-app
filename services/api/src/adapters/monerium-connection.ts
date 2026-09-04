/**
 * Which Monerium credentials act for a given user.
 *
 * Three sources, resolved in one place so the rest of the code asks "give me
 * a client for this user" and never picks a credential itself:
 *
 *  1. `api_keys` — the user's OWN Monerium app (client id + secret created in
 *     their Monerium account's developer section). Client-credentials grant.
 *     The token acts as that account's owner: its profiles, its IBANs, its
 *     orders. This is the "test with my own account" connector.
 *  2. `oauth` — the Authorization Code + PKCE connect flow. Per-user access and
 *     refresh tokens, refreshed here when they expire.
 *  3. The APP's credentials from .env — MONERIUM_CLIENT_ID/SECRET — for
 *     accounts approved in-house that have no connection of their own.
 *
 * WHY THIS MATTERS FOR (1): the address the app links and the IBAN it requests
 * live under the USER's Monerium profile, which the app's own credentials
 * cannot see. So activation, deposit polling and the SEPA redeem must all run
 * on the user's client, or the IBAN issues and no deposit is ever credited —
 * the same blind spot `MoneriumClient.orders()` documents for unscoped calls.
 *
 * SECRETS. The client secret is a bearer credential for a financial account.
 * It is encrypted at rest with the same AES-256-GCM scheme the OAuth tokens
 * use (`crypto-at-rest.ts`, purpose `monerium`), stored only after Monerium
 * has accepted it once, and never returned by any endpoint — not even its
 * ciphertext. Without MONERIUM_TOKEN_ENCRYPTION_KEY the connector is off and
 * says so, rather than writing a secret to db.json in plaintext.
 */
import { MONERIUM, moneriumSandboxEnabled } from "../config.js";
import { decryptField, encryptField } from "../crypto-at-rest.js";
import { store, type User } from "../store.js";
import {
  MoneriumApiError,
  MoneriumClient,
  refreshAuthorizationToken,
} from "./monerium-client.js";

export type MoneriumConnectionMethod = "oauth" | "api_keys";

/** Is the per-user API-key connector available on this deployment? */
export const moneriumApiKeysAvailable = () => Boolean(MONERIUM.tokenEncryptionKey);

/** Sandbox or production, read off the base URL Monerium calls go to. */
export function moneriumEnvironment(baseUrl = MONERIUM.baseUrl): "sandbox" | "production" | "custom" {
  let host = "";
  try { host = new URL(baseUrl).host; } catch { return "custom"; }
  if (host === "api.monerium.dev") return "sandbox";
  if (host === "api.monerium.app") return "production";
  return "custom";
}

export function encryptToken(value: string): string {
  return encryptField("monerium", MONERIUM.tokenEncryptionKey, value);
}

export function decryptToken(value: string): string {
  return decryptField("monerium", MONERIUM.tokenEncryptionKey, value);
}

/** How a stored connection authenticates. Rows written before `method`
 *  existed are OAuth connections. */
export function connectionMethod(user: User): MoneriumConnectionMethod | null {
  const m = user.monerium;
  if (!m) return null;
  if (m.method) return m.method;
  return m.accessTokenEnc ? "oauth" : null;
}

/** Does this user carry Monerium credentials of their own? */
export function hasOwnMoneriumCredentials(user: User): boolean {
  return connectionMethod(user) !== null;
}

/**
 * Is Monerium REAL for this user — will a SEPA redeem be placed and deposits
 * polled — as opposed to the local mock? True when the deployment holds app
 * credentials, or when the user connected their own account either way. A
 * connected account is a real account; mock-PAYING a payout from it would be
 * the fake this project does not keep.
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
    const msg = String(err?.message ?? err);
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
  if (!keys) return null;
  const cacheKey = `${keys.clientId}:${keys.clientSecretEnc}`;
  const hit = userClients.get(user.id);
  if (hit && hit.key === cacheKey) return hit.client;
  const client = new MoneriumClient({
    baseUrl: MONERIUM.baseUrl,
    clientId: keys.clientId,
    clientSecret: decryptToken(keys.clientSecretEnc),
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
export async function moneriumAccessToken(user: User): Promise<string> {
  const keyed = apiKeyClient(user);
  if (keyed) return keyed.bearerToken();
  if (!user.monerium?.accessTokenEnc) throw new Error("Monerium account is not connected");
  if (
    user.monerium.refreshTokenEnc &&
    user.monerium.expiresAt &&
    Date.now() > Date.parse(user.monerium.expiresAt) - 60_000
  ) {
    const refreshed = await refreshAuthorizationToken(
      {
        baseUrl: MONERIUM.baseUrl,
        clientId: MONERIUM.oauthClientId,
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
 * Otherwise the app client — which only works for accounts the app itself
 * provisioned, and throws a clear error rather than a 401 when the app has no
 * secret at all.
 */
export function moneriumClientFor(user: User): MoneriumClient {
  const keyed = apiKeyClient(user);
  if (keyed) return keyed;
  if (user.monerium?.accessTokenEnc) {
    return new MoneriumClient({
      baseUrl: MONERIUM.baseUrl,
      clientId: MONERIUM.oauthClientId,
      tokenProvider: () => moneriumAccessToken(user),
    });
  }
  if (!MONERIUM.clientSecret) {
    throw new Error(
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
  if (!MONERIUM.clientSecret) {
    throw new Error(
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
