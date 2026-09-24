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

/**
 * Headers every response carries.
 *
 * `no-referrer` because several of our URLs ARE credentials (/r/<slug>,
 * /invoice/<token>, /pay/<handle>/<code>) and any outbound request or link
 * click would otherwise carry at least our origin, and on a same-origin
 * navigation the full path, to wherever it lands.
 */
export const securityHeaders: express.RequestHandler = (_req, res, next) => {
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  next();
};

/**
 * The rate-limit key for a client address.
 *
 * An IPv6 end user is routinely handed a whole /64, so keying on the full
 * address gives one machine 2^64 fresh buckets. Key IPv6 on its /64 prefix;
 * an IPv4-mapped address is keyed as the IPv4 it is.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return "?";
  const addr = ip.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return mapped[1];
  if (!addr.includes(":")) return addr;
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

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
 * Failed guesses at one secret, across every source.
 *
 * The per-IP buckets do nothing against a guesser spread over many addresses,
 * so a secret a human chose (an invoice-link password) also counts its own
 * failures. Only failures count, so the rightful holder is not throttled by
 * the requests a normal session makes. The price: whoever holds the link can
 * lock its supplier out for one window by guessing wrong on purpose.
 */
const failures = new Map<string, { n: number; reset: number }>();

export function tooManyFailures(key: string, max: number): boolean {
  const f = failures.get(key);
  return !!f && f.reset >= Date.now() && f.n >= max;
}

export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.reset < now) {
    failures.set(key, { n: 1, reset: now + windowMs });
    if (failures.size > 10_000) for (const [k, v] of failures) if (v.reset < now) failures.delete(k);
  } else {
    f.n++;
  }
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
    // Unauthenticated, and every call stores a challenge server-side.
    req.path === "/webauthn/challenge" ||
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
  const ip = clientKey(req.ip);
  const ok = isAuthRoute(req)
    ? rateLimit(`a:${ip}`, SECURITY.authRateLimitPerMin)
    : rateLimit(`g:${ip}`, SECURITY.rateLimitPerMin);
  if (!ok) return res.status(429).json({ error: "rate limited — slow down" });
  next();
};
