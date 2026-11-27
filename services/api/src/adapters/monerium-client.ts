/**
 * Minimal REST client for the Monerium API (v2); production by default,
 * the sandbox when the base URL says so.
 * Docs: https://docs.monerium.com/api/
 *
 * Auth: OAuth2 client-credentials; the token is cached and refreshed on
 * expiry. All calls send the v2 Accept header.
 */
// Every call carries a timeout: a redeem that hangs past the sweep window
// is the double-payout case the orchestrator guards against.

import { partnerTimeout } from "../http.js";
import { moneriumFetch } from "./monerium-limit.js";
import { describeCause } from "../http/log-cause.js";
import { EncryptionUnavailableError } from "../crypto-at-rest.js";

/** The shape an order id must have before it may go into a request path. */
export function isMoneriumOrderId(orderId: string): boolean {
  return /^[A-Za-z0-9._~-]{1,128}$/.test(orderId);
}

/** A non-2xx response from Monerium, carrying the status so callers can tell
 *  "this order does not exist" from "Monerium is briefly unreachable". */
export class MoneriumApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MoneriumApiError";
  }
}

/**
 * Zold cannot act on this account at Monerium: nothing is connected, or
 * Monerium refused the credentials it holds (revoked, expired, a spent OAuth
 * code). The user can fix it by connecting again, so it answers 409
 * MONERIUM_NOT_CONNECTED (http/known-errors.ts), not a 500.
 */
export class MoneriumAccessError extends Error {
  constructor(message: string, readonly partnerStatus?: number) {
    super(message);
    this.name = "MoneriumAccessError";
  }
}

/**
 * The token grant failed for another reason than a refusal (a 5xx, a timeout,
 * an unreadable answer): no API request was sent on it. A caller placing an
 * order reads this as "no order exists", not as an unknown outcome.
 */
export class MoneriumTokenError extends Error {
  constructor(message: string, readonly partnerStatus?: number) {
    super(message);
    this.name = "MoneriumTokenError";
  }
}

/** Monerium's own refusal of a token request is an access error; its 5xx
 *  (or a proxy's) is a transient MoneriumTokenError. Both carry the status
 *  as `partnerStatus`, so a log line can name it without the body. */
const tokenError = (what: string, status: number, body: string) =>
  status >= 400 && status < 500
    ? new MoneriumAccessError(`${what} (${status}): ${body}`, status)
    : new MoneriumTokenError(`${what} (${status}): ${body}`, status);

/** The largest body read from Monerium. An order list is the big answer; a
 *  body past this is not one, and is not read into memory to find out. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The body as text, up to MAX_BODY_BYTES, under the request's own timeout.
 *  A leading byte-order mark is dropped, as Response.text() does. A refusal
 *  past the cap is returned as a placeholder, so the caller still throws on
 *  its status (a 401/403 stays a definite refusal). */
export async function moneriumText(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      if (!res.ok) return `(a body larger than ${MAX_BODY_BYTES} bytes, not read)`;
      throw new Error(`Monerium answered with a body larger than ${MAX_BODY_BYTES} bytes (HTTP ${res.status})`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Monerium's body, parsed. A body that is not JSON (a proxy's HTML page)
 *  throws a fixed message: Node's own parse error quotes the body's start. */
export function moneriumJson<T>(text: string, what: string, status: number): T {
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} answered with a body that is not JSON (HTTP ${status})`);
  }
}

/** A token endpoint's 200, parsed. One with no access token (an empty body)
 *  is a plain Error, so no request goes out as `Bearer undefined`. */
function moneriumToken<T extends { access_token: string }>(text: string, what: string, status: number): T {
  const data = moneriumJson<T>(text, what, status);
  if (typeof data?.access_token !== "string" || !data.access_token) {
    throw new Error(`${what} answered with no access token (HTTP ${status})`);
  }
  return data;
}

/**
 * What a log line may say about a failed Monerium call: the HTTP status, and
 * for a token request a fixed label, never Monerium's body. A failure with no
 * status (a timeout, DNS, a missing secret) is ours and described in full.
 */
export function moneriumFailureReason(err: unknown): string {
  if (err instanceof MoneriumApiError) return `HTTP ${err.status}`;
  const status = (err as { partnerStatus?: unknown } | null)?.partnerStatus;
  if (typeof status === "number") return `token request failed, HTTP ${status}`;
  return describeCause(err);
}

export interface MoneriumConfig {
  baseUrl: string; // https://api.monerium.dev (sandbox) | .app (production)
  clientId: string;
  clientSecret?: string;
  /**
   * Supply the bearer token from elsewhere (a user's OAuth token) instead of
   * the client-credentials grant. When set, clientSecret is never used.
   */
  tokenProvider?: () => Promise<string>;
}

export interface MoneriumOrder {
  id: string;
  kind: "issue" | "redeem";
  amount: string;
  currency: string;
  address: string;
  chain: string;
  state: string;
  meta?: { state?: string; placedAt?: string };
  [k: string]: any;
}

/** The body of a redeem order: burn EURe from `address` and pay `counterpart`
 *  over SEPA. `message` is the exact text the Safe signed. */
export interface MoneriumRedeemOrder {
  address: string;
  chain: string;
  kind: "redeem";
  amount: string;
  currency: string;
  counterpart: {
    identifier: { standard: "iban"; iban: string };
    details: { firstName: string; lastName: string; country: string };
  };
  message: string;
  signature: string;
  memo?: string;
}

export class MoneriumClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: MoneriumConfig) {}

  private async accessToken(): Promise<string> {
    if (this.cfg.tokenProvider) return this.cfg.tokenProvider();
    if (!this.cfg.clientSecret) {
      throw new Error("MONERIUM_CLIENT_SECRET is required for Monerium app-level API calls");
    }
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.value;
    }
    const res = await moneriumFetch(`${this.cfg.baseUrl}/auth/token`, {
      signal: partnerTimeout(),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw tokenError("Monerium auth failed", res.status, await moneriumText(res));
    }
    const data = moneriumToken<{ access_token: string; expires_in: number }>(await moneriumText(res), "Monerium auth", res.status);
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      // Nothing was sent to `path`: whatever failed, failed before it.
      // A missing encryption key is the deployment's fault, not Monerium's:
      // it keeps its own answer (http/known-errors.ts).
      if (err instanceof MoneriumAccessError || err instanceof MoneriumTokenError || err instanceof EncryptionUnavailableError) throw err;
      throw new MoneriumTokenError(`Monerium auth failed before ${method} ${path}: ${describeCause(err)}`);
    }
    const res = await moneriumFetch(`${this.cfg.baseUrl}${path}`, {
      signal: partnerTimeout(),
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.monerium.api-v2+json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await moneriumText(res);
    if (!res.ok) {
      throw new MoneriumApiError(
        `Monerium ${method} ${path} failed (${res.status}): ${text}`,
        res.status,
      );
    }
    return moneriumJson<T>(text, `Monerium ${method} ${path}`, res.status);
  }

  /** App-level (client-credentials) bearer token, for callers that talk to
   *  Monerium through moneriumBearerRequest rather than this client. */
  bearerToken(): Promise<string> {
    return this.accessToken();
  }

  authContext() {
    return this.request<any>("GET", "/auth/context");
  }

  profiles(filter: { kind?: "personal" | "corporate" } = {}) {
    const q = filter.kind ? `?kind=${filter.kind}` : "";
    return this.request<any>("GET", `/profiles${q}`);
  }

  /**
   * One profile. The sandbox answers `id`, `kind`, `state`, `details`, `form`
   * and `verifications` here and NO `name` (read 2026-09-30); `name` is on the
   * GET /profiles list items. An id this login cannot see is a 403, not 404.
   */
  profile(profileId: string) {
    // Stored ids came from Monerium, but one also arrives in request bodies,
    // so the shape is checked before it becomes a path segment.
    if (!/^[A-Za-z0-9-]{1,64}$/.test(profileId)) {
      throw new MoneriumApiError(`malformed Monerium profile id: ${profileId.slice(0, 40)}`, 400);
    }
    return this.request<any>("GET", `/profiles/${encodeURIComponent(profileId)}`);
  }


  /**
   * Link a wallet address. `signature` must be the user's signature over the
   * fixed declaration message.
   */
  linkAddress(params: {
    address: string;
    signature: string;
    chain: string;
    message: string;
    profile?: string;
  }) {
    return this.request<any>("POST", "/addresses", params);
  }

  addresses() {
    return this.request<any>("GET", "/addresses");
  }

  /** One linked address: `profile` is the profile it is linked under. The
   *  address becomes a path segment, so its shape is checked first. */
  address(address: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new MoneriumApiError("malformed address", 400);
    return this.request<any>("GET", `/addresses/${address}`);
  }

  requestIban(address: string, chain: string) {
    return this.request<any>("POST", "/ibans", { address, chain });
  }


  ibans() {
    return this.request<{ ibans: any[] }>("GET", "/ibans");
  }

  /**
   * Orders, optionally scoped to one profile.
   *
   * Without a profile this returns only the app's default profile's orders.
   * A user's deposit lands under their own profile, so an unscoped call
   * misses it: the euros arrive on-chain, Monerium marks the order processed,
   * and we credit nothing. Always pass the profile.
   */
  orders(profileId?: string) {
    const q = profileId ? `?profile=${encodeURIComponent(profileId)}` : "";
    return this.request<{ orders: MoneriumOrder[] } | MoneriumOrder[]>("GET", `/orders${q}`);
  }

  getOrder(orderId: string) {
    // This id reaches us from a webhook body and lands in a request path on an
    // authenticated connection, so its shape is checked rather than trusted:
    // `../`, `?` and `#` would retarget the call somewhere else in Monerium's
    // API. mirrorOrderById settles a malformed id before it gets here.
    if (!isMoneriumOrderId(orderId)) {
      throw new MoneriumApiError(`malformed Monerium order id: ${orderId.slice(0, 40)}`, 400);
    }
    return this.request<MoneriumOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Place a redeem (off-ramp) order: burns EURe from `address` and pays out
   * via SEPA to the counterpart IBAN. `message` must be the exact payment
   * message the wallet signed: "Send EUR <amount> to <iban> at <rfc3339>".
   */
  placeOrder(body: MoneriumRedeemOrder) {
    return this.request<MoneriumOrder>("POST", "/orders", body);
  }
}

function oauthTokenBody(values: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) body.set(key, value);
  }
  return body;
}

export interface MoneriumTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export async function exchangeAuthorizationCode(cfg: MoneriumConfig, params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<MoneriumTokenResponse> {
  const res = await moneriumFetch(`${cfg.baseUrl}/auth/token`, {
    signal: partnerTimeout(),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: oauthTokenBody({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!res.ok) {
    throw tokenError("Monerium OAuth code exchange failed", res.status, await moneriumText(res));
  }
  return moneriumToken<MoneriumTokenResponse>(await moneriumText(res), "Monerium OAuth token", res.status);
}

export async function refreshAuthorizationToken(
  cfg: MoneriumConfig,
  refreshToken: string,
): Promise<MoneriumTokenResponse> {
  const res = await moneriumFetch(`${cfg.baseUrl}/auth/token`, {
    signal: partnerTimeout(),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: oauthTokenBody({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw tokenError("Monerium OAuth refresh failed", res.status, await moneriumText(res));
  }
  return moneriumToken<MoneriumTokenResponse>(await moneriumText(res), "Monerium OAuth token", res.status);
}


export async function moneriumBearerRequest<T>(
  baseUrl: string,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await moneriumFetch(`${baseUrl}${path}`, {
    signal: partnerTimeout(),
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.monerium.api-v2+json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await moneriumText(res);
  if (!res.ok) {
    throw new MoneriumApiError(
      `Monerium ${method} ${path} failed (${res.status}): ${text}`,
      res.status,
    );
  }
  return moneriumJson<T>(text, `Monerium ${method} ${path}`, res.status);
}

export const LINK_MESSAGE = "I hereby declare that I am the address owner.";
