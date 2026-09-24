/**
 * FP1: origin policy + per-IP rate limiting (dependency-free).
 *
 * Two middlewares, kept together because they are the outermost thing every
 * request passes through and reading them in one place is how you tell what a
 * stranger can reach. Applied by server.ts before any route is mounted.
 */
import type express from "express";
import { SECURITY } from "../config.js";

/**
 * State-changing requests from foreign origins are refused outright; allowed
 * origins get explicit CORS headers, everyone else gets none.
 */
export const originPolicy: express.RequestHandler = (req, res, next) => {
  const origin = req.header("origin");
  if (origin && SECURITY.origins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE");
    if (req.method === "OPTIONS") return res.status(204).end();
  } else if (origin && req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(403).json({ error: "origin not allowed" });
  }
  next();
};

const hits = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, perMin: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return true;
  }
  return ++h.n <= perMin;
}

/**
 * Which paths sit on the tight bucket: everything where a request is a GUESS
 * AT A CREDENTIAL — a passkey ceremony, a recovery code, a receipt slug, a
 * document verification code, a payment-request code, an HMAC-signed Shopify
 * webhook, the operator bearer secret, an Invoice-Me link token, or a set of
 * Monerium API keys being checked against a third party.
 */
function isAuthRoute(req: express.Request): boolean {
  return (
    req.path.startsWith("/passkey") ||
    req.path.startsWith("/recovery") ||
    req.path.startsWith("/r/") ||
    req.path.startsWith("/v/") ||
    // The bare /pay/<handle> page is public by design and stays on the general
    // bucket; only /pay/<handle>/<code> is a credential.
    /^\/pay\/[^/]+\/[^/]+/.test(req.path) ||
    req.path.startsWith("/shopify/") ||
    req.path.startsWith("/admin") ||
    req.path.startsWith("/invoice-links/") ||
    (req.path.endsWith("/monerium/api-keys") && req.method === "POST") ||
    (req.path === "/users" && req.method === "POST")
  );
}

export const apiRateLimit: express.RequestHandler = (req, res, next) => {
  const ip = req.ip ?? "?";
  const ok = isAuthRoute(req)
    ? rateLimit(`a:${ip}`, SECURITY.authRateLimitPerMin)
    : rateLimit(`g:${ip}`, SECURITY.rateLimitPerMin);
  if (!ok) return res.status(429).json({ error: "rate limited — slow down" });
  next();
};
