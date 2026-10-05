/**
 * Shopify request authentication — two HMACs, both keyed by the app secret.
 *
 *  - Requests Shopify sends to a payments app (payment/refund/capture/void
 *    sessions) carry `Shopify-Hmac-Sha256`: base64 of HMAC-SHA256 over the
 *    RAW request body. It must be computed over the bytes as sent, which is
 *    why server.ts keeps `rawBody`; a re-serialised JSON object would not
 *    match on whitespace alone.
 *  - The OAuth callback carries `hmac` in the QUERY: hex of HMAC-SHA256 over
 *    the other query parameters, sorted by key and joined as key=value&…
 *    (the documented "hmac is removed, the rest sorted lexicographically").
 *
 * Both comparisons are constant-time. A shop domain is validated against the
 * documented myshopify.com shape before it is ever used to build a URL, since
 * `shop` arrives in a query string and becomes the host we call.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_RE.test(String(shop ?? "").trim().toLowerCase());
}

export function normaliseShop(shop: string): string {
  return String(shop ?? "").trim().toLowerCase();
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** `Shopify-Hmac-Sha256` over the raw body. */
export function verifyBodyHmac(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, header.trim());
}

export function signBody(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/** The OAuth callback's `hmac` query parameter. */
export function verifyQueryHmac(query: Record<string, unknown>, secret: string): boolean {
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided || !secret) return false;
  return safeEqual(signQuery(query, secret), provided);
}

export function signQuery(query: Record<string, unknown>, secret: string): string {
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => {
      const v = query[k];
      const val = Array.isArray(v) ? v.join(",") : String(v ?? "");
      // Shopify's documented escaping for the OAuth message: & and % in
      // keys and values, = in keys.
      const esc = (s: string, key: boolean) =>
        s.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, key ? "%3D" : "=");
      return `${esc(k, true)}=${esc(val, false)}`;
    })
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}
