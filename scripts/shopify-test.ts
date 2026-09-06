/**
 * Shopify payments app — install, session, settlement, and the things we
 * refuse — against a stub Shopify. No chain, no network.
 *
 * WHAT THIS EXISTS TO CATCH: the two signatures (body HMAC on sessions, query
 * HMAC on the OAuth callback) are what stand between a stranger and "mark this
 * order paid"; the store's token must never cross the API; a session must be
 * idempotent because Shopify retries; and a paid request must reach
 * paymentSessionResolve exactly once, with a retry path when the store did not
 * answer. The stub records every mutation it is sent so each of those is
 * asserted, not assumed.
 *
 * Run: npm run shopify:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import express from "express";

process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_DB_PATH = path.join(os.tmpdir(), `zold-shopify-test-${process.pid}.json`);
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
process.env.SHOPIFY_API_KEY = "zold-app-key";
process.env.SHOPIFY_API_SECRET = "shpss_test_secret";
// This suite is the PAYMENTS-APP contract; the custom-app (orders webhook)
// path has its own, scripts/shopify-orders-test.ts.
process.env.SHOPIFY_MODE = "payments-app";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key";
process.env.TRANSF_PUBLIC_URL = "";

const SHOP = "demo-store.myshopify.com";
const TOKEN = "shpat_test_offline_token";
const calls: { op: string; vars: any; shop: string }[] = [];
let failNextResolve = false;

/** The stub answers as Shopify does: an OAuth code exchange under /admin, and
 *  the Payments Apps GraphQL endpoint under /payments_apps. */
const stub: Server = createServer((req, res) => {
  const [, shop, ...rest] = (req.url ?? "").split("?")[0].split("/");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code: number, payload: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const p = rest.join("/");
    if (p === "admin/oauth/access_token") {
      const b = JSON.parse(body || "{}");
      if (b.client_id !== "zold-app-key" || b.client_secret !== "shpss_test_secret" || b.code !== "good-code") return send(400, { error: "invalid_request" });
      return send(200, { access_token: TOKEN, scope: "write_payment_gateways,write_payment_sessions" });
    }
    if (p.startsWith("payments_apps/api/") && p.endsWith("graphql.json")) {
      if (req.headers["x-shopify-access-token"] !== TOKEN) return send(401, { errors: "[API] Invalid API key or access token" });
      const b = JSON.parse(body || "{}");
      const op = /mutation \w+\(.*?\)\s*\{\s*(\w+)/s.exec(b.query)?.[1] ?? "?";
      calls.push({ op, vars: b.variables, shop });
      if (op === "paymentSessionResolve") {
        if (failNextResolve) { failNextResolve = false; return send(200, { data: { paymentSessionResolve: { paymentSession: null, userErrors: [{ field: ["id"], message: "Payment session is in a state that cannot be resolved" }] } } }); }
        return send(200, { data: { paymentSessionResolve: { paymentSession: { id: b.variables.id, state: { code: "RESOLVED" }, nextAction: { action: "REDIRECT", context: { redirectUrl: `https://${shop}/checkouts/c/thank_you?session=${encodeURIComponent(b.variables.id)}` } } }, userErrors: [] } } });
      }
      if (op === "paymentsAppConfigure") return send(200, { data: { paymentsAppConfigure: { paymentsAppConfiguration: { externalHandle: b.variables.externalHandle, ready: b.variables.ready }, userErrors: [] } } });
      return send(200, { data: { [op]: { userErrors: [] } } });
    }
    send(404, { error: `stub: no route ${p}` });
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
process.env.SHOPIFY_SHOP_BASE_URL = `http://127.0.0.1:${(stub.address() as any).port}`;

rmSync(process.env.TRANSF_DB_PATH, { force: true });
const { initStore, store } = await import("../services/api/src/store.js");
const { createShopifyRouter, resolveShopifyRequest } = await import("../services/api/src/routes/shopify.js");
const { attributeDepositToRequest, onPaymentRequestPaid, sweepPaymentRequests } = await import("../services/api/src/routes/payment-requests.js");
const { signBody, signQuery } = await import("../services/api/src/shopify/hmac.js");
const { decryptField } = await import("../services/api/src/crypto-at-rest.js");
initStore();
onPaymentRequestPaid(resolveShopifyRequest);

const now = new Date().toISOString();
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const merchant: any = {
  id: randomUUID(), name: "Lena Händler", email: "lena@example.com", country: "DE", address: owner, iban: "EE382200221020145685", kycStatus: "approved",
  paymentPage: { handle: "lena-shop", depositAddress: owner, recipientAddress: owner, settlementAsset: "EURE", autoConvert: false, createdAt: now, updatedAt: now },
  createdAt: now,
};
const viewer: any = { id: randomUUID(), name: "Vic Viewer", country: "DE", address: `0x${"cd".repeat(20)}`, iban: "", kycStatus: "approved", createdAt: now };
const noPage: any = { id: randomUUID(), name: "No Page", country: "DE", address: `0x${"ef".repeat(20)}`, iban: "", kycStatus: "approved", createdAt: now };
for (const u of [merchant, viewer, noPage]) store.addUser(u);
const org: any = { id: randomUUID(), type: "business", name: "Lena GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now };
store.addOrganisation(org, false);
store.addMember({ id: randomUUID(), orgId: org.id, userId: merchant.id, email: "lena@example.com", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
store.addMember({ id: randomUUID(), orgId: org.id, userId: viewer.id, email: "vic@example.com", role: "viewer", status: "active", invitedAt: now, acceptedAt: now } as any);
const org2: any = { ...org, id: randomUUID(), name: "No Page Ltd" };
store.addOrganisation(org2, false);
store.addMember({ id: randomUUID(), orgId: org2.id, userId: noPage.id, email: "np@example.com", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use("/api", createShopifyRouter((req, res) => {
  const u = req.header("x-user");
  if (u) return { userId: u };
  res.status(401).json({ error: "authorization required" });
  return undefined;
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;

const call = async (method: string, p: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string>; user?: string } = {}) => {
  const res = await fetch(`${API}${p}`, {
    method, redirect: "manual",
    headers: { ...(opts.body || opts.raw ? { "content-type": "application/json" } : {}), ...(opts.user ? { "x-user": opts.user } : {}), ...(opts.headers ?? {}) },
    ...(opts.raw ? { body: opts.raw } : opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body, location: decodeURIComponent((res.headers.get("location") ?? "").replace(/\+/g, " ")) };
};
const fromShopify = (p: string, payload: unknown, shop = SHOP, secret = "shpss_test_secret") => {
  const raw = JSON.stringify(payload);
  return call("POST", p, { raw, headers: { "shopify-hmac-sha256": signBody(raw, secret), "shopify-shop-domain": shop, "shopify-request-id": randomUUID(), "shopify-api-version": "2026-07" } });
};
const until = async (fn: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return fn(); };

let n = 0;
const failures: string[] = [];
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  try { await fn(); console.log(`${++n}. ${label}`); }
  catch (err: any) { failures.push(`${label}: ${err?.message ?? err}`); console.log(`${++n}. FAILED — ${label}: ${err?.message ?? err}`); }
};

console.log("Install");
let authorizeUrl = "";
await check("an owner starts an install and is sent to the store's OAuth page with our state", async () => {
  const r = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: "Demo-Store.myshopify.com" }, user: merchant.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  authorizeUrl = r.body.authorizeUrl;
  const u = new URL(authorizeUrl);
  assert.ok(u.pathname.endsWith(`/${SHOP}/admin/oauth/authorize`), u.toString());
  assert.equal(u.searchParams.get("client_id"), "zold-app-key");
  assert.equal(u.searchParams.get("redirect_uri"), `${API}/api/shopify/callback`);
  assert.ok((u.searchParams.get("state") ?? "").length > 20);
  assert.equal(r.body.payeeHandle, "lena-shop");
});
await check("a viewer cannot connect a store", async () => {
  assert.equal((await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: SHOP }, user: viewer.id })).status, 403);
});
await check("a domain that is not myshopify.com is refused before it is ever called", async () => {
  const r = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: "evil.example.com" }, user: merchant.id });
  assert.equal(r.status, 400);
});
await check("an org whose payee has no payment page is told what to do first", async () => {
  const r = await call("POST", `/api/orgs/${org2.id}/shopify/install`, { body: { shop: "other.myshopify.com" }, user: noPage.id });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /payment page/);
});
const oauthQuery = (state: string, code = "good-code", shop = SHOP) => {
  const q: Record<string, string> = { code, shop, state, timestamp: String(Math.floor(Date.now() / 1000)), host: Buffer.from(`${shop}/admin`).toString("base64") };
  q.hmac = signQuery(q, "shpss_test_secret");
  return new URLSearchParams(q).toString();
};
await check("the callback with a forged hmac stores nothing", async () => {
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const q = oauthQuery(state); const tampered = q.replace(/hmac=[0-9a-f]+/, `hmac=${"0".repeat(64)}`);
  const r = await call("GET", `/api/shopify/callback?${tampered}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /did not verify/);
  assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
});
await check("a callback for a state we never issued is refused", async () => {
  const r = await call("GET", `/api/shopify/callback?${oauthQuery("not-our-state")}`);
  assert.match(r.location, /not started from Zold/);
  assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
});
await check("the genuine callback exchanges the code, stores the token ENCRYPTED and configures the app ready", async () => {
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const r = await call("GET", `/api/shopify/callback?${oauthQuery(state)}`);
  assert.equal(r.status, 302, JSON.stringify(r.body));
  assert.match(r.location, /\/business\?view=shopify&shop=demo-store\.myshopify\.com$/);
  const c = store.findShopifyConnectionByShop(SHOP)!;
  assert.ok(c, "no connection stored");
  assert.notEqual(c.accessTokenEnc, TOKEN);
  assert.equal(decryptField("shopify", "test-encryption-key", c.accessTokenEnc), TOKEN);
  assert.equal(c.payeeUserId, merchant.id);
  assert.ok(c.configuredAt, `configure did not run: ${c.configureError}`);
  const cfg = calls.find((x) => x.op === "paymentsAppConfigure");
  assert.deepEqual({ ready: cfg?.vars.ready, handle: cfg?.vars.externalHandle }, { ready: true, handle: "lena-shop" });
});
await check("a used state cannot be replayed", async () => {
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  assert.match((await call("GET", `/api/shopify/callback?${oauthQuery(state)}`)).location, /not started from Zold/);
});

console.log("\nPayment sessions");
const session = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(), gid: `gid://shopify/PaymentSession/${randomUUID()}`, group: randomUUID(), amount: "49.90", currency: "EUR", test: true,
  merchant_locale: "de", payment_method: { type: "offsite", data: { cancel_url: `https://${SHOP}/checkouts/c/cancel` } },
  proposed_at: now, kind: "sale", customer: { email: "buyer@example.com" }, ...over,
});
let s1 = session();
let redirect = "";
await check("a signed payment session becomes a EUR request payable in USDC only, with the buyer sent to its page", async () => {
  const r = await fromShopify("/api/shopify/payment", s1);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  redirect = r.body.redirect_url;
  assert.match(redirect, new RegExp(`^${API}/pay/lena-shop/[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$`));
  const req = store.findPaymentRequestBySource("shopify", s1.id)!;
  assert.equal(req.amountEur, 49.9);
  assert.deepEqual(req.methods, ["crypto"]);
  assert.equal(req.test, true);
  assert.equal(req.source.cancelUrl, `https://${SHOP}/checkouts/c/cancel`);
  assert.equal(req.orgId, org.id);
  const ttl = Date.parse(req.expiresAt) - Date.parse(req.createdAt);
  assert.ok(ttl > 55 * 60_000 && ttl <= 60 * 60_000, `ttl ${ttl}`);
  assert.ok(req.cryptoQuotes.length === 1 && req.cryptoQuotes[0].amountUsdc > 56, "quoted from the pinned mid");
  assert.ok(!JSON.stringify(req).includes("buyer@example.com"), "the buyer's email is not ours to keep");
});
await check("Shopify's retry of the same session gets the same page and creates nothing new", async () => {
  const before = store.paymentRequests.length;
  const r = await fromShopify("/api/shopify/payment", s1);
  assert.equal(r.body.redirect_url, redirect);
  assert.equal(store.paymentRequests.length, before);
});
await check("an unsigned or mis-signed session is a 401", async () => {
  assert.equal((await fromShopify("/api/shopify/payment", session(), SHOP, "wrong-secret")).status, 401);
  assert.equal((await call("POST", "/api/shopify/payment", { body: session(), headers: { "shopify-shop-domain": SHOP } })).status, 401);
});
await check("a store that never connected is a 404 even with a valid signature", async () => {
  assert.equal((await fromShopify("/api/shopify/payment", session(), "stranger.myshopify.com")).status, 404);
});
await check("a non-EUR session is refused with the fix named", async () => {
  const r = await fromShopify("/api/shopify/payment", session({ currency: "USD" }));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /EUR/);
});
await check("manual capture (kind=authorization) is refused and the merchant is told through Shopify", async () => {
  const s = session({ kind: "authorization" });
  const r = await fromShopify("/api/shopify/payment", s);
  assert.equal(r.status, 422);
  assert.ok(await until(() => calls.some((c) => c.op === "paymentSessionReject" && c.vars.id === s.gid)), "no paymentSessionReject reached the store");
  const rej = calls.find((c) => c.op === "paymentSessionReject" && c.vars.id === s.gid)!;
  assert.equal(rej.vars.reason.code, "PROCESSING_ERROR");
  assert.match(rej.vars.reason.merchantMessage, /automatic capture/);
});

console.log("\nSettlement");
const payRequest = (req: any) => {
  const q = req.cryptoQuotes[req.cryptoQuotes.length - 1];
  const d = store.addCryptoDeposit({
    id: randomUUID(), userId: merchant.id, chainId: 31337, token: "USDC", txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0")}`, logIndex: 0,
    amountUnits: String(Math.round(q.amountUsdc * 1e6)), amountUsdc: q.amountUsdc, settlementAsset: "EURE", paymentAddress: owner,
    state: "DETECTED", txs: [], detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return attributeDepositToRequest(d);
};
await check("the buyer's USDC deposit marks the request PAID and Shopify is told exactly once, with the buyer's onward URL recorded", async () => {
  const req = store.findPaymentRequestBySource("shopify", s1.id)!;
  const paid = payRequest(req)!;
  assert.equal(paid.state, "PAID");
  assert.ok(await until(() => Boolean(store.findPaymentRequest(req.id)!.source.resolvedAt)), `not resolved: ${store.findPaymentRequest(req.id)!.source.resolveError}`);
  const resolves = calls.filter((c) => c.op === "paymentSessionResolve" && c.vars.id === s1.gid);
  assert.equal(resolves.length, 1);
  assert.match(store.findPaymentRequest(req.id)!.source.returnUrl!, /thank_you/);
});
await check("the return link sends the buyer to the URL Shopify gave", async () => {
  const req = store.findPaymentRequestBySource("shopify", s1.id)!;
  const r = await call("GET", `/api/shopify/return/${req.code}`);
  assert.equal(r.status, 302);
  assert.equal(r.location, decodeURIComponent(req.source.returnUrl!));
});
await check("a paid request whose resolve failed keeps the error and the sweep retries it", async () => {
  const s = session();
  await fromShopify("/api/shopify/payment", s);
  const req = store.findPaymentRequestBySource("shopify", s.id)!;
  failNextResolve = true;
  payRequest(req);
  assert.ok(await until(() => Boolean(store.findPaymentRequest(req.id)!.source.resolveError)), "no error recorded");
  assert.equal(store.findPaymentRequest(req.id)!.source.resolvedAt, undefined);
  await sweepPaymentRequests();
  const after = store.findPaymentRequest(req.id)!;
  assert.ok(after.source.resolvedAt, `still unresolved: ${after.source.resolveError}`);
  assert.equal(after.source.resolveAttempts, 2);
  assert.equal(calls.filter((c) => c.op === "paymentSessionResolve" && c.vars.id === s.gid).length, 2);
});
await check("a buyer who cancels is sent back to the store and the request is closed", async () => {
  const s = session();
  await fromShopify("/api/shopify/payment", s);
  const req = store.findPaymentRequestBySource("shopify", s.id)!;
  const r = await call("GET", `/api/shopify/cancel/${req.code}`);
  assert.equal(r.location, `https://${SHOP}/checkouts/c/cancel`);
  assert.equal(store.findPaymentRequest(req.id)!.state, "CANCELLED");
});
await check("a paid request cannot be cancelled by visiting the cancel link", async () => {
  const req = store.findPaymentRequestBySource("shopify", s1.id)!;
  await call("GET", `/api/shopify/cancel/${req.code}`);
  assert.equal(store.findPaymentRequest(req.id)!.state, "PAID");
});
await check("a refund session is acknowledged, then REJECTED with a merchant message — refunds are manual", async () => {
  const gid = `gid://shopify/RefundSession/${randomUUID()}`;
  const r = await fromShopify("/api/shopify/refund", { id: randomUUID(), gid, payment_id: s1.id, amount: "49.90", currency: "EUR", test: true, proposed_at: now });
  assert.equal(r.status, 201);
  assert.ok(await until(() => calls.some((c) => c.op === "refundSessionReject" && c.vars.id === gid)));
  assert.match(calls.find((c) => c.op === "refundSessionReject" && c.vars.id === gid)!.vars.reason.merchantMessage, /Refund the buyer from your Zold account/);
});
await check("capture and void sessions are likewise acknowledged and rejected", async () => {
  const cg = `gid://shopify/CaptureSession/${randomUUID()}`;
  const vg = `gid://shopify/VoidSession/${randomUUID()}`;
  assert.equal((await fromShopify("/api/shopify/capture", { id: randomUUID(), gid: cg, payment_id: s1.id, amount: "1", currency: "EUR", proposed_at: now })).status, 201);
  assert.equal((await fromShopify("/api/shopify/void", { id: randomUUID(), gid: vg, payment_id: s1.id, proposed_at: now })).status, 201);
  assert.ok(await until(() => calls.some((c) => c.op === "captureSessionReject" && c.vars.id === cg) && calls.some((c) => c.op === "voidSessionReject" && c.vars.id === vg)));
});

console.log("\nDashboard");
await check("the org view lists the store and its checkouts and never the token", async () => {
  const r = await call("GET", `/api/orgs/${org.id}/shopify`, { user: merchant.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.equal(r.body.connections[0].shop, SHOP);
  assert.equal(r.body.connections[0].ready, true);
  assert.equal(r.body.requests.length, 3, "one request per accepted session: paid, failed-then-resolved, cancelled");
  assert.ok(r.body.requests.every((x: any) => x.shop === SHOP));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(TOKEN) && !text.includes("accessTokenEnc"), "the store token crossed the API");
  assert.equal(r.body.endpoints.payment, `${API}/api/shopify/payment`);
});
await check("a viewer sees the dashboard but a non-member does not", async () => {
  assert.equal((await call("GET", `/api/orgs/${org.id}/shopify`, { user: viewer.id })).status, 200);
  assert.equal((await call("GET", `/api/orgs/${org.id}/shopify`, { user: noPage.id })).status, 404);
});
await check("disconnecting tells the store the method is gone and removes the connection", async () => {
  const c = store.findShopifyConnectionByShop(SHOP)!;
  const r = await call("DELETE", `/api/orgs/${org.id}/shopify/${c.id}`, { user: merchant.id });
  assert.equal(r.status, 200);
  assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  assert.ok(calls.some((x) => x.op === "paymentsAppConfigure" && x.vars.ready === false));
  assert.equal((await fromShopify("/api/shopify/payment", session())).status, 404, "a disconnected store must not open checkouts");
});

server.close();
stub.close();
rmSync(process.env.TRANSF_DB_PATH, { force: true });
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nSHOPIFY TEST PASSED — ${n} checks`);
