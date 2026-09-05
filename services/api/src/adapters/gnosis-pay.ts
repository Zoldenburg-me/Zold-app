/**
 * Gnosis Pay — permissionless integration.
 *
 * WHAT THIS IS, and the line not to blur: Gnosis Pay issues the card, owns the
 * KYC and owns the card Safe. Zold shows the user their own connected card
 * account. In permissionless mode there are NO webhooks and no attribution of
 * card activity back to Zold, so nothing here may be presented as "Zold's
 * card" — see docs/gnosis-pay-permissionless-integration.md, Non-Goals.
 *
 * THE CHAIN CONSTRAINT: Gnosis Pay's account and card Safe live on Gnosis
 * Chain (100), and the SIWE message must name that chain. Zold's app chain is
 * something else today, which is exactly why the user's own wallet signs
 * rather than their Zold passkey Safe: an EIP-1271 signature is only
 * verifiable where the contract is deployed, and the Zold Safe is not deployed
 * on 100. Verified separately that Gnosis Chain DOES have the RIP-7212 P256
 * precompile, so a passkey Safe there is possible later — that is a deliberate
 * next step, not a missing one.
 *
 * TWO THINGS THE INTEGRATION DOC GOT WRONG, both found by reading the live
 * OpenAPI spec and calling the endpoint, and both silently fatal:
 *  1. GET /auth/nonce returns `text/plain`, NOT JSON. Parsing it as JSON throws
 *     on a response that was perfectly fine.
 *  2. That same response sets a `siwe` cookie, and the challenge is verified
 *     against it. Fetch the nonce server-side without carrying the cookie
 *     forward and every signature is rejected as if the user signed wrong.
 *
 * NO JWT IS EVER PERSISTED. The token is a bearer credential for somebody
 * else's card account; it is returned to the browser and passed back per
 * request, and this process keeps nothing. Only non-sensitive derived status
 * (which address is connected, the Safe address, KYC state) is stored, so the
 * Card view can say where the user is without holding the credential.
 */
import { GNOSIS_PAY } from "../config.js";

export interface GnosisPayNonce {
  nonce: string;
  /** The `siwe` cookie the challenge must be verified against. Opaque to us. */
  cookie: string;
}

export interface GnosisPayUser {
  id?: string;
  email?: string;
  kycStatus?: string;
  status?: string;
  safeWallets?: Array<{ address?: string; chainId?: number } | string>;
  signInWallets?: Array<{ address?: string } | string>;
  isPhoneValidated?: boolean;
  isSourceOfFundsAnswered?: boolean;
  availableFeatures?: unknown;
  [k: string]: unknown;
}

export interface GnosisPayCard {
  id?: string;
  lastFourDigits?: string;
  virtual?: boolean;
  statusCode?: number;
  statusName?: string;
  activatedAt?: string;
}

/** Documented as decimal strings of minor units (`^[0-9]+$`), NOT numbers.
 *  Kept as strings the whole way through — parsing a balance into a float to
 *  render it is how a cent goes missing. */
export interface GnosisPayBalances {
  total: string;
  spendable: string;
  pending: string;
}

export class GnosisPayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function baseUrl(): string {
  return GNOSIS_PAY.baseUrl.replace(/\/+$/, "");
}

async function gpFetch(
  path: string,
  init: RequestInit & { jwt?: string; cookie?: string } = {},
): Promise<Response> {
  const { jwt, cookie, ...rest } = init;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
  };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  if (cookie) headers.cookie = cookie;
  if (rest.body) headers["content-type"] = "application/json";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GNOSIS_PAY.timeoutMs);
  try {
    return await fetch(`${baseUrl()}${path}`, { ...rest, headers, signal: ctrl.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new GnosisPayError(`Gnosis Pay did not answer within ${GNOSIS_PAY.timeoutMs}ms`, 504);
    }
    throw new GnosisPayError(`Gnosis Pay unreachable: ${err?.message ?? err}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response, preferring Gnosis Pay's own error text over a generic one.
 * Their errors are the useful half of a failed onboarding step, and replacing
 * them with "request failed" is how a user gets stuck with nothing to act on.
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail =
      body?.message ?? body?.error ?? (text ? text.slice(0, 200) : `${res.status} ${res.statusText}`);
    throw new GnosisPayError(`${what}: ${String(detail).slice(0, 300)}`, res.status);
  }
  return body as T;
}

/**
 * Step 1 of SIWE. Returns the nonce AND the cookie it is bound to — both are
 * needed at the challenge, and returning only the nonce is the bug described
 * at the top of this file.
 */
export async function getNonce(): Promise<GnosisPayNonce> {
  const res = await gpFetch("/api/v1/auth/nonce", { method: "GET" });
  const nonce = (await res.text()).trim();
  if (!res.ok) throw new GnosisPayError(`Gnosis Pay nonce failed: ${nonce.slice(0, 200)}`, res.status);
  if (!nonce) throw new GnosisPayError("Gnosis Pay returned an empty nonce", 502);
  // `set-cookie` may carry several cookies; the challenge only needs the pair,
  // not the attributes, so keep `name=value` and drop Path/Max-Age/SameSite.
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { nonce, cookie };
}

/**
 * Build the SIWE message the wallet will sign.
 *
 * chainId is pinned to Gnosis Pay's chain rather than Zold's: this message
 * authenticates against THEIR account, and a message naming our chain is
 * rejected by them with an error that reads like a signing bug.
 */
export function buildSiweMessage(params: {
  address: string;
  nonce: string;
  domain: string;
  uri: string;
  statement?: string;
  issuedAt?: string;
}): string {
  const { address, nonce, domain, uri } = params;
  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const statement = params.statement ?? "Sign in with Ethereum to Gnosis Pay.";
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${GNOSIS_PAY.siweChainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/** Step 2 of SIWE. The cookie from getNonce() must be passed back. */
export async function verifySiwe(
  message: string,
  signature: string,
  cookie: string,
  ttlInSeconds: number = GNOSIS_PAY.jwtTtlSeconds,
): Promise<{ token: string }> {
  const res = await gpFetch("/api/v1/auth/challenge", {
    method: "POST",
    cookie,
    body: JSON.stringify({ message, signature, ttlInSeconds }),
  });
  const body = await readJson<{ token?: string }>(res, "Gnosis Pay sign-in failed");
  if (!body?.token) throw new GnosisPayError("Gnosis Pay returned no session token", 502);
  return { token: body.token };
}

export async function getUser(jwt: string): Promise<GnosisPayUser> {
  return readJson<GnosisPayUser>(
    await gpFetch("/api/v1/user", { method: "GET", jwt }),
    "Gnosis Pay profile read failed",
  );
}

export async function listCards(jwt: string): Promise<GnosisPayCard[]> {
  const body = await readJson<GnosisPayCard[]>(
    await gpFetch("/api/v1/cards?exclude_voided=true", { method: "GET", jwt }),
    "Gnosis Pay card list failed",
  );
  return Array.isArray(body) ? body : [];
}

export async function getAccountBalances(jwt: string): Promise<GnosisPayBalances> {
  return readJson<GnosisPayBalances>(
    await gpFetch("/api/v1/account-balances", { method: "GET", jwt }),
    "Gnosis Pay balance read failed",
  );
}

/**
 * Card transactions. The spec's `Event` schema declares no properties, so the
 * shape is genuinely opaque — we pass it through as unknown rather than
 * inventing a type that a future field would silently violate.
 */
export async function listTransactions(jwt: string): Promise<unknown[]> {
  const body = await readJson<unknown[]>(
    await gpFetch("/api/v1/transactions", { method: "GET", jwt }),
    "Gnosis Pay transaction read failed",
  );
  return Array.isArray(body) ? body : [];
}

/** The Safe Gnosis Pay deployed for this user, if any, on their chain. */
export function safeAddressOf(user: GnosisPayUser): string | undefined {
  const wallets = user.safeWallets;
  if (!Array.isArray(wallets)) return undefined;
  for (const w of wallets) {
    const address = typeof w === "string" ? w : w?.address;
    const chainId = typeof w === "string" ? undefined : w?.chainId;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    if (chainId === undefined || Number(chainId) === GNOSIS_PAY.siweChainId) return address;
  }
  return undefined;
}
