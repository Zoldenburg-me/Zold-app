/**
 * Minimal REST client for the Monerium API (v2), targeting the sandbox.
 * Docs: https://docs.monerium.com/api/
 *
 * Auth: OAuth2 client-credentials; the token is cached and refreshed on
 * expiry. All calls send the v2 Accept header.
 */

/** A non-2xx response from Monerium, carrying the status so callers can tell
 *  "this order does not exist" from "Monerium is briefly unreachable". */
export class MoneriumApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MoneriumApiError";
  }
}

export interface MoneriumConfig {
  baseUrl: string; // https://api.monerium.dev (sandbox) | .app (production)
  clientId: string;
  clientSecret: string;
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

export class MoneriumClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: MoneriumConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.value;
    }
    const res = await fetch(`${this.cfg.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw new Error(`Monerium auth failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.monerium.api-v2+json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MoneriumApiError(
        `Monerium ${method} ${path} failed (${res.status}): ${text}`,
        res.status,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  authContext() {
    return this.request<any>("GET", "/auth/context");
  }

  profiles() {
    return this.request<any>("GET", "/profiles");
  }

  /** Whitelabel plans: create a per-customer profile. */
  createProfile(kind: "personal" | "corporate", name: string) {
    return this.request<any>("POST", "/profiles", { kind, name });
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

  requestIban(address: string, chain: string) {
    return this.request<any>("POST", "/ibans", { address, chain });
  }

  shareKyc(profileId: string, sumsubApplicantToken: string) {
    return this.request<any>("POST", `/profiles/${encodeURIComponent(profileId)}/share`, {
      provider: "sumsub",
      personal: { token: sumsubApplicantToken },
    });
  }

  ibans() {
    return this.request<{ ibans: any[] }>("GET", "/ibans");
  }

  /**
   * Orders, optionally scoped to one profile.
   *
   * WITHOUT a profile this returns only the app's DEFAULT profile's orders —
   * not every order the app can see. Since we create a profile per user, an
   * unscoped call cannot see a single customer deposit: the euros arrive
   * on-chain, Monerium marks the order processed, and we credit nothing.
   * Always pass the profile you care about.
   */
  orders(profileId?: string) {
    const q = profileId ? `?profile=${encodeURIComponent(profileId)}` : "";
    return this.request<{ orders: MoneriumOrder[] } | MoneriumOrder[]>("GET", `/orders${q}`);
  }

  getOrder(orderId: string) {
    // This id reaches us from a webhook body and lands in a request path on an
    // authenticated connection, so its shape is checked rather than trusted:
    // `../`, `?` and `#` would retarget the call somewhere else in Monerium's
    // API. Rejected as a 4xx so the caller treats it as a settled "no such
    // order" rather than a transient failure to retry.
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(orderId)) {
      throw new MoneriumApiError(`malformed Monerium order id: ${orderId.slice(0, 40)}`, 400);
    }
    return this.request<MoneriumOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Place a redeem (off-ramp) order: burns EURe from `address` and pays out
   * via SEPA to the counterpart IBAN. `message` must be the exact payment
   * message the wallet signed: "Send EUR <amount> to <iban> at <rfc3339>".
   */
  placeOrder(body: {
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
  }) {
    return this.request<MoneriumOrder>("POST", "/orders", body);
  }
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
  const res = await fetch(`${cfg.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Monerium OAuth code exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as MoneriumTokenResponse;
}

export async function refreshAuthorizationToken(
  cfg: MoneriumConfig,
  refreshToken: string,
): Promise<MoneriumTokenResponse> {
  const res = await fetch(`${cfg.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Monerium OAuth refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as MoneriumTokenResponse;
}


export async function moneriumBearerRequest<T>(
  baseUrl: string,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.monerium.api-v2+json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new MoneriumApiError(
      `Monerium ${method} ${path} failed (${res.status}): ${text}`,
      res.status,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const LINK_MESSAGE = "I hereby declare that I am the address owner.";
