/**
 * Calls TO Shopify: the OAuth code exchange and the Payments Apps GraphQL API.
 *
 * Everything Shopify tells us about a payment arrives as a POST to our
 * endpoints; everything we tell Shopify goes through here. The Payments Apps
 * API lives at https://<shop>/payments_apps/api/<version>/graphql.json and is
 * authenticated with the store's offline access token for our app.
 *
 * `shopBase` is the one seam for tests: SHOPIFY_SHOP_BASE_URL points every
 * shop at a local stub as <base>/<shop>/…; unset, it is https://<shop>.
 */
import { SHOPIFY } from "../config.js";
import { isValidShopDomain } from "./hmac.js";

export class ShopifyApiError extends Error {
  constructor(message: string, public status = 502, public userErrors?: { field?: string[]; message: string }[]) {
    super(message);
  }
}

export function shopBase(shop: string): string {
  if (!isValidShopDomain(shop)) throw new ShopifyApiError(`not a myshopify.com domain: ${shop}`, 400);
  return SHOPIFY.shopBaseUrl ? `${SHOPIFY.shopBaseUrl.replace(/\/$/, "")}/${shop}` : `https://${shop}`;
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SHOPIFY.timeoutMs);
  try {
    return await p(ctl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** The merchant's install URL. `state` is our nonce, checked on the callback. */
export function authorizeUrl(shop: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: SHOPIFY.apiKey,
    scope: SHOPIFY.scopes,
    redirect_uri: redirectUri,
    state,
  });
  return `${shopBase(shop)}/admin/oauth/authorize?${q}`;
}

export async function exchangeCode(shop: string, code: string): Promise<{ accessToken: string; scope: string }> {
  const res = await withTimeout((signal) =>
    fetch(`${shopBase(shop)}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY.apiKey, client_secret: SHOPIFY.apiSecret, code }),
      signal,
    }),
  );
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    throw new ShopifyApiError(`Shopify refused the code exchange (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { accessToken: String(body.access_token), scope: String(body.scope ?? "") };
}

export async function graphql<T = any>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await withTimeout((signal) =>
    fetch(`${shopBase(shop)}/payments_apps/api/${SHOPIFY.apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-shopify-access-token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    }),
  );
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShopifyApiError(`Shopify GraphQL ${res.status}: ${JSON.stringify(body).slice(0, 300)}`, res.status === 401 ? 401 : 502);
  if (body?.errors?.length) {
    throw new ShopifyApiError(`Shopify GraphQL errors: ${body.errors.map((e: any) => e.message).join("; ")}`);
  }
  return body.data as T;
}

const SESSION_FIELDS = `
  id
  state { ... on PaymentSessionStateResolved { code } ... on PaymentSessionStateRejected { code reason merchantMessage } ... on PaymentSessionStatePending { code reason } }
  nextAction { action context { ... on PaymentSessionActionsRedirect { redirectUrl } } }
`;

export interface SessionResult {
  id: string;
  stateCode?: string;
  redirectUrl?: string;
}

function firstUserError(payload: any, op: string) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new ShopifyApiError(`${op}: ${errs.map((e: any) => e.message).join("; ")}`, 409, errs);
}

function sessionResult(session: any): SessionResult {
  return {
    id: String(session?.id ?? ""),
    stateCode: session?.state?.code,
    redirectUrl: session?.nextAction?.context?.redirectUrl,
  };
}

/** Tell Shopify the payment succeeded. Shopify answers with where to send the buyer. */
export async function paymentSessionResolve(shop: string, token: string, sessionGid: string): Promise<SessionResult> {
  const data = await graphql(shop, token, `
    mutation Resolve($id: ID!) {
      paymentSessionResolve(id: $id) { paymentSession { ${SESSION_FIELDS} } userErrors { field message } }
    }`, { id: sessionGid });
  firstUserError(data?.paymentSessionResolve, "paymentSessionResolve");
  return sessionResult(data?.paymentSessionResolve?.paymentSession);
}

export type RejectCode = "PROCESSING_ERROR" | "RISKY" | "INCORRECT_NUMBER" | "CARD_DECLINED" | "PAYMENT_METHOD_UNAVAILABLE";

export async function paymentSessionReject(
  shop: string,
  token: string,
  sessionGid: string,
  code: RejectCode,
  merchantMessage: string,
): Promise<SessionResult> {
  const data = await graphql(shop, token, `
    mutation Reject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
      paymentSessionReject(id: $id, reason: $reason) { paymentSession { ${SESSION_FIELDS} } userErrors { field message } }
    }`, { id: sessionGid, reason: { code, merchantMessage } });
  firstUserError(data?.paymentSessionReject, "paymentSessionReject");
  return sessionResult(data?.paymentSessionReject?.paymentSession);
}

/** Refund/capture/void sessions we do not perform. Each is REJECTED with a
 *  merchant-visible sentence, so the merchant learns why in their admin
 *  rather than from a customer. */
export async function refundSessionReject(shop: string, token: string, gid: string, merchantMessage: string) {
  const data = await graphql(shop, token, `
    mutation RejectRefund($id: ID!, $reason: RefundSessionRejectionReasonInput!) {
      refundSessionReject(id: $id, reason: $reason) { refundSession { id } userErrors { field message } }
    }`, { id: gid, reason: { code: "PROCESSING_ERROR", merchantMessage } });
  firstUserError(data?.refundSessionReject, "refundSessionReject");
}

export async function captureSessionReject(shop: string, token: string, gid: string, merchantMessage: string) {
  const data = await graphql(shop, token, `
    mutation RejectCapture($id: ID!, $reason: CaptureSessionRejectionReasonInput!) {
      captureSessionReject(id: $id, reason: $reason) { captureSession { id } userErrors { field message } }
    }`, { id: gid, reason: { code: "PROCESSING_ERROR", merchantMessage } });
  firstUserError(data?.captureSessionReject, "captureSessionReject");
}

export async function voidSessionReject(shop: string, token: string, gid: string, merchantMessage: string) {
  const data = await graphql(shop, token, `
    mutation RejectVoid($id: ID!, $reason: VoidSessionRejectionReasonInput!) {
      voidSessionReject(id: $id, reason: $reason) { voidSession { id } userErrors { field message } }
    }`, { id: gid, reason: { code: "PROCESSING_ERROR", merchantMessage } });
  firstUserError(data?.voidSessionReject, "voidSessionReject");
}

/** Mark the app ready (or not) for this store. Until `ready: true` is
 *  accepted, the store cannot offer the method at checkout. */
export async function paymentsAppConfigure(shop: string, token: string, externalHandle: string, ready: boolean) {
  const data = await graphql(shop, token, `
    mutation Configure($externalHandle: String, $ready: Boolean!) {
      paymentsAppConfigure(externalHandle: $externalHandle, ready: $ready) {
        paymentsAppConfiguration { externalHandle ready } userErrors { field message }
      }
    }`, { externalHandle, ready });
  firstUserError(data?.paymentsAppConfigure, "paymentsAppConfigure");
  return data?.paymentsAppConfigure?.paymentsAppConfiguration;
}
