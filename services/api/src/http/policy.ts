/**
 * Origin policy + per-IP rate limiting (dependency-free).
 *
 * Two middlewares, kept together because they are the outermost thing every
 * request passes through and reading them in one place is how you tell what a
 * stranger can reach. Applied by server.ts before any route is mounted.
 */
import type express from "express";
import { CHECKOUT_SERVICE, IS_PRODUCTION, OPERATOR, SECURITY } from "../config.js";
import { checkoutCredentialFor } from "../checkout-service.js";
import { operatorBucketId } from "./guards.js";
import { bearerToken } from "./sessions.js";

/**
 * State-changing requests from foreign origins are refused outright; allowed
 * origins get explicit CORS headers, everyone else gets none.
 */
export const originPolicy: express.RequestHandler = (req, res, next) => {
  const origin = req.header("origin");
  // The admin origin is allowed for the admin API only; to the rest of the
  // API it is as foreign as any other site.
  const adminCall = origin === OPERATOR.adminOrigin && /^\/api\/admin(\/|$)/i.test(req.path);
  if (origin && (SECURITY.origins.includes(origin) || adminCall)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE");
    if (req.method === "OPTIONS") return res.status(204).end();
  } else if (origin && req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(403).json({ error: "origin not allowed" });
  }
  next();
};

/** What the admin host serves: the dashboard page and its views, its scripts
 *  and styles, the fonts and icons it loads, and the admin API. */
const ADMIN_HOST_PATHS =
  /^\/(admin\/?|admin\/[a-z]+(\.js)?|admin\.css|tokens\.css|favicon\.(svg|ico)|vendor\/fonts\/[\w.-]+|icons\/[\w.-]+|api\/admin(\/.*)?)$/i;

const hostname = (host: string | undefined) => (host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/**
 * With ADMIN_ORIGIN set, its host serves the dashboard and nothing else. A
 * page of the user app served there would put any script injected into it on
 * the origin that holds the operator's session and may ask for the
 * operator's passkey.
 */
export const adminHostPolicy: express.RequestHandler = (req, res, next) => {
  if (!OPERATOR.adminOriginExplicit || hostname(req.get("host")) !== new URL(OPERATOR.adminOrigin).hostname) return next();
  // The static handler decodes and resolves a path after this check, so a
  // path that could change under decoding (an escape, a dot segment, a
  // backslash, an empty segment) is refused, not matched.
  if (!/[%\\]|\.\.|\/\//.test(req.path) && ADMIN_HOST_PATHS.test(req.path)) {
    // The site policy allows no inline script, so an injected <script>
    // cannot run where the operator's session lives.
    res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
    return next();
  }
  res.status(404).type("text/plain").send("not found");
};

/**
 * Headers every response carries.
 *
 * `no-referrer` because several of our URLs ARE credentials (/r/<slug>,
 * /invoice/<token>, /pay/<handle>/<code>) and any outbound request or link
 * click would otherwise carry at least our origin, and on a same-origin
 * navigation the full path, to wherever it lands.
 *
 * The CSP keeps every script, style, font, fetch and worker on our own
 * origin: the app holds a session and a device key in localStorage, so the
 * thing to deny an injected script is somewhere to send them, and no page
 * runs inline script. Every page shares that origin and that localStorage,
 * so one page allowing inline script would expose all of them. /app and
 * /business add one hash, APP_CONTENT_SECURITY_POLICY.
 * frame-ancestors 'none' because nothing embeds us (the Shopify app is not
 * embedded) and a framed pay or passkey page is a clickjacking surface.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The import map index.html and business.html carry inline (a browser will
 * not load one from a file). Its hash is the only inline script /app and
 * /business allow; editing the map means recomputing this, and
 * turnkey-guardian-page-test says the value.
 */
export const IMPORT_MAP_SHA256 = "sha256-+5Oy6AHENgQqMIceBeJtYIO+9+G1BYWRmAXrpuZEt24=";

/** /app and /business: the site's policy plus the import map. Every other
 *  script, and every handler, is in a file. */
export const APP_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' '${IMPORT_MAP_SHA256}'`);

/**
 * /guardian and /recovery: the site's policy. They drive a passkey approval,
 * a Google/Apple login and a Turnkey signature, and they alone may reach
 * Turnkey's API (the origin, when the switch is on); /app keeps
 * connect-src 'self'.
 */
export function guardianPageCsp(turnkeyOrigin?: string): string {
  return CONTENT_SECURITY_POLICY
    .replace("connect-src 'self'", turnkeyOrigin ? `connect-src 'self' ${turnkeyOrigin}` : "connect-src 'self'");
}

/**
 * HTTPS only, on every subdomain. Production only: a laptop on
 * http://localhost must not pin itself to HTTPS.
 *
 * Five minutes on purpose: a browser keeps this header for max-age and a
 * rollback cannot take it back, so it stays short until every subdomain of
 * the production host is confirmed to serve HTTPS.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=300; includeSubDomains";

export function securityHeadersFor(production: boolean): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (production) res.setHeader("strict-transport-security", STRICT_TRANSPORT_SECURITY);
    // Zold wrote this answer. A proxy's own 4xx can look like Zold's refusal
    // ({ error }), and only a refusal may offer a retry: the app checks this.
    res.setHeader("x-zold-answer", "1");
    next();
  };
}

export const securityHeaders = securityHeadersFor(IS_PRODUCTION);

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

/**
 * Most rate-limit windows held at once (about 15 MB). A caller rotating
 * through fresh addresses (an IPv6 /48 holds 65,536 /64s) or fresh credential
 * ids opens one window per request, so without a cap the map grows with the
 * flood's rate until the sweep catches up.
 */
export const RATE_BUCKETS_MAX = 100_000;

const hits = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, perMin: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    // Re-inserted, so the map stays in window order, oldest first.
    hits.delete(key);
    // At the cap, expired windows go first (they sit at the front). A window
    // still running is never evicted: that would hand its caller a fresh
    // count, and the flood filling the map could reset a passkey or partner
    // bucket at will. So a map full of running windows refuses the new key
    // (fail closed): a flood of 100k fresh keys a minute locks out new
    // callers until its oldest windows end, and callers already counted keep
    // their counts.
    while (hits.size >= RATE_BUCKETS_MAX) {
      const [oldest, w] = hits.entries().next().value!;
      if (w.reset >= now) return false;
      hits.delete(oldest);
    }
    hits.set(key, { n: 1, reset: now + 60_000 });
    return true;
  }
  return ++h.n <= perMin;
}

/**
 * Failed guesses at one secret, across every source.
 *
 * Per-IP buckets miss a guesser spread over many addresses, so a human-chosen
 * secret (an invoice-link password) also counts its own failures. Only
 * failures count, so normal use is not throttled. Trade-off: anyone with the
 * link can lock its supplier out for one window by guessing wrong.
 */
const failures = new Map<string, { n: number; reset: number }>();

export function tooManyFailures(key: string, max: number): boolean {
  const f = failures.get(key);
  return !!f && f.reset >= Date.now() && f.n >= max;
}

/** Take back one recorded failure: a guess is counted before an async check
 *  runs, so concurrent guesses cannot all pass the limit, and a right one
 *  returns its count. */
export function forgetFailure(key: string): void {
  const f = failures.get(key);
  if (f && f.n > 0) f.n--;
}

export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.reset < now) {
    failures.set(key, { n: 1, reset: now + windowMs });
  } else {
    f.n++;
  }
}

/* Expired buckets are dropped on a timer, not by a request: a scan on the
 * request path would run on every request once a caller rotating through
 * fresh IPv6 /64s keeps the map large. */
export function sweepExpiredBuckets(now = Date.now()): void {
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  for (const [k, v] of failures) if (v.reset < now) failures.delete(k);
}
setInterval(() => sweepExpiredBuckets(), 10_000).unref();

/** How many windows each map holds, for the bounds test. */
export const bucketCounts = () => ({ hits: hits.size, failures: failures.size });

/**
 * Which paths sit on the tight bucket: everything where a request is a GUESS
 * AT A CREDENTIAL — a passkey ceremony, a recovery code, a receipt slug, a
 * document verification code, a payment-request code, the operator bearer
 * secret, an Invoice-Me link token, or a set of
 * Monerium API keys being checked against a third party.
 */
function isAuthRoute(req: express.Request): boolean {
  // Express routes are case-insensitive and ignore a trailing slash, so match
  // the same way: "/api/Recovery/..." or "/webauthn/challenge/" reaches the
  // same handler and must land in the same bucket.
  const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  return (
    path.startsWith("/passkey") ||
    // Unauthenticated, and every call stores a challenge server-side.
    path === "/webauthn/challenge" ||
    path.startsWith("/recovery") ||
    path.startsWith("/r/") ||
    path.startsWith("/v/") ||
    // The bare /pay/<handle> page is public by design and stays on the general
    // bucket; only /pay/<handle>/<code> is a credential.
    /^\/pay\/[^/]+\/[^/]+/.test(path) ||
    path.startsWith("/admin") ||
    path.startsWith("/invoice-links/") ||
    (path.endsWith("/monerium/api-keys") && req.method === "POST") ||
    // A company's own Monerium keys, checked against Monerium on every POST.
    (/^\/orgs\/[^/]+\/monerium$/.test(path) && req.method === "POST") ||
    (path === "/users" && req.method === "POST") ||
    // A 6-digit code is a guessable credential; sending one spends mail.
    /^\/users\/[^/]+\/email\/(code|verify)$/.test(path) ||
    // Every call stores two challenges server-side.
    /^\/users\/[^/]+\/authorizer\/challenge$/.test(path) ||
    // The 1 € enrolment code is a credential, and a check spends a Monerium call.
    /^\/users\/[^/]+\/recovery\/zoldenburg\/enrolment(\/|$)/.test(path)
  );
}

/**
 * Paths where each call makes us call a partner or the chain: a quote, any
 * Monerium route, Gnosis Pay, an accounting integration, a VIES lookup, a
 * conversion quote, a payment run, a wallet ownership check, a price retry,
 * issuing a draft from receipts (a VIES lookup and a chain check). They also count on the general bucket; this one keeps a
 * caller from spending our partner quota (and getting our keys throttled)
 * at the general rate. Documents get their own, tighter one: a statement is
 * about fifty chain reads.
 */
function partnerBucket(req: express.Request): "p" | "d" | undefined {
  const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  if (req.method === "POST" && /^\/users\/[^/]+\/documents\/(statement|balance|ownership|receipt)$/.test(path)) return "d";
  if (
    (path === "/quotes" && req.method === "POST") ||
    /^\/users\/[^/]+\/monerium(\/|$)/.test(path) ||
    /^\/orgs\/[^/]+\/monerium(\/|$)/.test(path) ||
    path.startsWith("/gnosis-pay/") ||
    /^\/orgs\/[^/]+\/integrations(\/|$)/.test(path) ||
    /^\/orgs\/[^/]+\/invoicing\/vat-check$/.test(path) ||
    /^\/users\/[^/]+\/crypto-deposits\/[^/]+\/convert\/prepare$/.test(path) ||
    /^\/orgs\/[^/]+\/drafts\/[^/]+\/execute$/.test(path) ||
    /^\/orgs\/[^/]+\/wallets\/[^/]+\/ownership(\/recheck)?$/.test(path) ||
    /^\/orgs\/[^/]+\/ledger\/([^/]+\/)?revalue$/.test(path) ||
    /^\/orgs\/[^/]+\/income-invoices\/[^/]+\/issue$/.test(path)
  ) return "p";
  return undefined;
}

/** The one per-IP bucket every /api call counts against, and its limit. */
function primaryBucket(req: express.Request, path: string): [string, number] {
  if (path.startsWith("/shopify/")) return ["s", SECURITY.shopifyRateLimitPerMin];
  if (path.startsWith("/admin")) {
    // Keyed per operator: each operator counts apart.
    const operator = operatorBucketId(req);
    if (operator) return [`o:${operator}`, SECURITY.operatorRateLimitPerMin];
  }
  // A valid checkout-service credential polls at its own rate; a wrong one is
  // a guess and stays on the auth bucket. Covers the transfer read and every
  // /service/merchant/* route alike.
  if (path.startsWith("/service/")) {
    return checkoutCredentialFor(bearerToken(req))
      ? ["c", CHECKOUT_SERVICE.rateLimitPerMin]
      : ["a", SECURITY.authRateLimitPerMin];
  }
  if (isAuthRoute(req)) return ["a", SECURITY.authRateLimitPerMin];
  return ["g", SECURITY.rateLimitPerMin];
}

export const apiRateLimit: express.RequestHandler = (req, res, next) => {
  const ip = clientKey(req.ip);
  const path = req.path.toLowerCase();
  // Shopify's calls arrive from Shopify's shared addresses and each carries a
  // 256-bit HMAC, so it is not a guess; its own bucket keeps real merchant
  // volume off the 20/min one. A live operator session is not a guess either;
  // an unknown bearer stays on the credential bucket.
  const [primary, perMin] = primaryBucket(req, path);
  const ok = rateLimit(`${primary}:${ip}`, perMin);
  if (!ok) return res.status(429).json({ error: "rate limited — slow down" });
  const bucket = partnerBucket(req);
  if (bucket && !rateLimit(`${bucket}:${ip}`, bucket === "d" ? SECURITY.documentRateLimitPerMin : SECURITY.partnerRateLimitPerMin)) {
    return res.status(429).json({ error: "rate limited — slow down" });
  }
  next();
};
