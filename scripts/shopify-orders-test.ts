/**
 * Shopify CUSTOM-APP mode — the path that needs no Payments Apps approval:
 * install subscribes the orders webhook, an orders/create for a pending
 * order paid by the Zold manual method opens a payment request, the buyer's
 * thank-you page extension polls the order lookup, and the attributed deposit
 * presses "Mark as paid" on the order through the Admin API. Stub Shopify,
 * no chain, no network.
 *
 * WHAT THIS EXISTS TO CATCH: a webhook must be acknowledged even when we
 * ignore the order (Shopify drops a subscription that keeps failing); only
 * OUR pending EUR orders may open a request; a redelivery must open nothing;
 * the lookup must be CORS-open and carry no PII; the mark-as-paid must reach
 * the store exactly once, with a retry when the store refused; and a shop
 * name in the URL must not be able to show another store's order.
 *
 * Run: npm run shopify:orders:test
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
process.env.TRANSF_DB_PATH = path.join(os.tmpdir(), `zold-shopify-orders-test-${process.pid}.json`);
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
process.env.SHOPIFY_API_KEY = "zold-app-key";
process.env.SHOPIFY_API_SECRET = "shpss_test_secret";
process.env.SHOPIFY_MODE = "custom-app";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key";
process.env.TRANSF_PUBLIC_URL = "";

const SHOP = "keycard-demo.myshopify.com";
const TOKEN = "shpat_test_offline_token";
const calls: { op: string; vars: any; shop: string; endpoint: string }[] = [];
let failNextMarkPaid = false;

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
      return send(200, { access_token: TOKEN, scope: "read_orders,write_orders" });
    }
    if (p.startsWith("admin/api/") && p.endsWith("graphql.json")) {
      if (req.headers["x-shopify-access-token"] !== TOKEN) return send(401, { errors: "[API] Invalid API key or access token" });
      const b = JSON.parse(body || "{}");
      const op = /mutation \w+\(.*?\)\s*\{\s*(\w+)/s.exec(b.query)?.[1] ?? "?";
      calls.push({ op, vars: b.variables, shop, endpoint: "admin" });
      if (op === "webhookSubscriptionCreate") {
        const dup = calls.filter((c) => c.op === op && c.shop === shop && c.vars.topic === b.variables.topic).length > 1;
        if (dup) return send(200, { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["webhookSubscription", "callbackUrl"], message: "Address for this topic has already been taken" }] } } });
        return send(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${b.variables.topic}` }, userErrors: [] } } });
      }
      if (op === "webhookSubscriptionDelete") return send(200, { data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: b.variables.id, userErrors: [] } } });
      if (op === "orderMarkAsPaid") {
        if (failNextMarkPaid) { failNextMarkPaid = false; return send(200, { data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ["input", "id"], message: "Order cannot be marked as paid" } ] } } }); }
        return send(200, { data: { orderMarkAsPaid: { order: { id: b.variables.input.id, displayFinancialStatus: "PAID" }, userErrors: [] } } });
      }
      if (op === "metafieldsSet") return send(200, { data: { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] } } });
      return send(200, { data: {}, errors: [{ message: `stub: unknown op ${op}` }] });
    }
    if (p.startsWith("payments_apps/")) {
      calls.push({ op: "PAYMENTS_APPS_ENDPOINT", vars: {}, shop, endpoint: "payments_apps" });
      return send(404, { errors: "Not Found" });
    }
    send(404, { error: `stub: ${req.method} ${req.url}` });
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
process.env.SHOPIFY_SHOP_BASE_URL = `http://127.0.0.1:${(stub.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createShopifyRouter } = await import("../services/api/src/routes/shopify.js");
const { attributeDepositToRequest, onPaymentRequestPaid, sweepPaymentRequests } = await import("../services/api/src/routes/payment-requests.js");
const { resolveShopifyRequest } = await import("../services/api/src/routes/shopify.js");
const { signBody, signQuery } = await import("../services/api/src/shopify/hmac.js");
initStore();
onPaymentRequestPaid(resolveShopifyRequest);

const now = new Date().toISOString();
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const merchant: any = {
  id: randomUUID(), name: "Keycard Demo GmbH", email: "shop@example.com", country: "DE", address: owner, iban: "EE123456789012345678", kycStatus: "approved", createdAt: now,
  paymentPage: { handle: "keycard", displayName: "Keycard", depositAddress: owner, recipientAddress: owner, forwarder: { chainId: 31337, address: owner, activatedAt: now }, supportedTokens: [{ chainId: 31337, symbol: "USDC", address: `0x${"11".repeat(20)}`, decimals: 6 }], settlementAsset: "EURE", autoConvert: true, activatedAt: now, updatedAt: now },
};
store.addUser(merchant);
const org: any = { id: randomUUID(), type: "business", name: "Keycard Demo GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now };
store.addOrganisation(org, false);
store.addMember({ id: randomUUID(), orgId: org.id, userId: merchant.id, email: "shop@example.com", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);

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
    headers: { ...(opts.body !== undefined || opts.raw !== undefined ? { "content-type": "application/json" } : {}), ...(opts.user ? { "x-user": opts.user } : {}), ...(opts.headers ?? {}) },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: res.status, body, location: res.headers.get("location") ?? "", headers: res.headers };
};
const webhook = (topic: string, payload: unknown, shop = SHOP, secret = "shpss_test_secret") => {
  const raw = JSON.stringify(payload);
  return call("POST", "/api/shopify/webhooks/orders", { raw, headers: { "shopify-hmac-sha256": signBody(raw, secret), "shopify-shop-domain": shop, "x-shopify-topic": topic, "x-shopify-webhook-id": randomUUID() } });
};
const until = async (fn: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return fn(); };

let n = 0;
const failures: string[] = [];
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  n++;
  try { await fn(); console.log(`${n}. ${label}`); }
  catch (e: any) { failures.push(`${n}. ${label}: ${e?.stack ?? e}`); console.log(`${n}. FAIL ${label}\n   ${e?.message ?? e}`); }
};

console.log("Install (custom-app mode)");
let state = "";
await check("an owner starts an install; the OAuth page asks for ORDER scopes, not payment ones", async () => {
  const r = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: SHOP }, user: merchant.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const u = new URL(r.body.authorizeUrl);
  assert.equal(u.searchParams.get("scope"), "read_orders,write_orders");
  state = u.searchParams.get("state")!;
});
const oauthQuery = (st: string, code = "good-code", shop = SHOP) => {
  const q: Record<string, string> = { code, shop, state: st, timestamp: String(Math.floor(Date.now() / 1000)), host: "abc" };
  return new URLSearchParams({ ...q, hmac: signQuery(q, "shpss_test_secret") }).toString();
};
await check("the callback stores the connection in custom-app mode and subscribes orders/create + orders/cancelled — never touching the Payments Apps endpoint", async () => {
  const r = await call("GET", `/api/shopify/callback?${oauthQuery(state)}`);
  assert.equal(r.status, 302, JSON.stringify(r.body));
  const c = store.findShopifyConnectionByShop(SHOP)!;
  assert.ok(c, "no connection stored");
  assert.equal(c.mode, "custom-app");
  assert.ok(c.configuredAt, `webhook subscription did not run: ${c.configureError}`);
  assert.equal(c.webhookSubscriptionId, "gid://shopify/WebhookSubscription/ORDERS_CREATE");
  const subs = calls.filter((x) => x.op === "webhookSubscriptionCreate");
  assert.deepEqual(subs.map((x) => x.vars.topic).sort(), ["ORDERS_CANCELLED", "ORDERS_CREATE"]);
  assert.ok(subs.every((x) => x.vars.sub.callbackUrl === `${API}/api/shopify/webhooks/orders`), JSON.stringify(subs));
  assert.ok(!calls.some((x) => x.endpoint === "payments_apps"), "payments-app configure ran in custom-app mode");
});
await check("a reinstall whose subscription already exists is not a failure", async () => {
  const r0 = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: SHOP }, user: merchant.id });
  const st = new URL(r0.body.authorizeUrl).searchParams.get("state")!;
  await call("GET", `/api/shopify/callback?${oauthQuery(st)}`);
  const c = store.findShopifyConnectionByShop(SHOP)!;
  assert.ok(c.configuredAt, `reinstall failed: ${c.configureError}`);
  assert.equal(c.webhookSubscriptionId, "gid://shopify/WebhookSubscription/ORDERS_CREATE", "the live subscription id was lost on reinstall");
});

console.log("\nOrders webhook");
let orderNo = 3100;
const order = (over: Record<string, unknown> = {}) => {
  const id = 5_000_000_000 + ++orderNo;
  return {
    id, admin_graphql_api_id: `gid://shopify/Order/${id}`, name: `#${orderNo}`, currency: "EUR", total_price: "129.00",
    financial_status: "pending", payment_gateway_names: ["Zold — pay with crypto"], test: false,
    order_status_url: `https://${SHOP}/12345/orders/${randomUUID().replace(/-/g, "")}/authenticate?key=k`,
    customer: { email: "buyer@example.com", first_name: "Bea" }, shipping_address: { address1: "Somewhere 1" },
    ...over,
  };
};
const o1 = order();
await check("orders/create for a pending EUR order on the Zold method opens a crypto-only request sized from the order, with the order's name, status URL and a day-long window", async () => {
  const r = await webhook("orders/create", o1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const req = store.findPaymentRequestBySource("shopify", o1.admin_graphql_api_id)!;
  assert.ok(req, "no request opened");
  assert.equal(req.amountEur, 129);
  assert.deepEqual(req.methods, ["crypto"]);
  assert.equal(req.source.orderGid, o1.admin_graphql_api_id);
  assert.equal(req.source.orderName, "#3101");
  assert.equal(req.source.orderStatusUrl, o1.order_status_url);
  assert.equal(req.source.returnUrl, o1.order_status_url);
  assert.equal(req.orgId, org.id);
  const ttl = Date.parse(req.expiresAt) - Date.parse(req.createdAt);
  assert.ok(ttl > 23.9 * 3_600_000 && ttl <= 24 * 3_600_000, `ttl ${ttl}`);
  assert.ok(req.cryptoQuotes.length === 1 && req.cryptoQuotes[0].amountUsdc > 146, "quoted from the pinned mid");
  const text = JSON.stringify(req);
  assert.ok(!text.includes("buyer@example.com") && !text.includes("Bea") && !text.includes("Somewhere"), "the buyer's details are not ours to keep");
});
await check("Shopify's redelivery of the same order opens nothing new", async () => {
  const before = store.paymentRequests.length;
  const r = await webhook("orders/create", o1);
  assert.equal(r.status, 200);
  assert.equal(store.paymentRequests.length, before);
});
await check("an order paid another way is acknowledged and ignored", async () => {
  const o = order({ payment_gateway_names: ["shopify_payments"], financial_status: "paid" });
  const r = await webhook("orders/create", o);
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, "not a Zold order");
  assert.equal(store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id), undefined);
});
await check("a Zold order that is not pending (already marked paid by hand) is ignored", async () => {
  const o = order({ financial_status: "paid" });
  assert.equal((await webhook("orders/create", o)).status, 200);
  assert.equal(store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id), undefined);
});
await check("a non-EUR order is acknowledged (so the subscription survives) but opens nothing", async () => {
  const o = order({ currency: "USD" });
  const r = await webhook("orders/create", o);
  assert.equal(r.status, 200);
  assert.match(String(r.body.ignored), /currency USD/);
  assert.equal(store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id), undefined);
});
await check("a mis-signed webhook is a 401 and a stranger store a 404", async () => {
  assert.equal((await webhook("orders/create", order(), SHOP, "wrong-secret")).status, 401);
  assert.equal((await webhook("orders/create", order(), "stranger.myshopify.com")).status, 404);
});
await check("a test order carries the test flag", async () => {
  const o = order({ test: true });
  await webhook("orders/create", o);
  assert.equal(store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id)!.test, true);
});

console.log("\nThank-you page lookup");
await check("the order lookup answers CORS-open with the pay-page projection, the order name and the page URL, and nothing about the buyer or the merchant's bank", async () => {
  const r = await call("GET", `/api/shopify/orders/${SHOP}/${o1.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.body.orderName, "#3101");
  assert.equal(r.body.amountEur, 129);
  assert.equal(r.body.state, "OPEN");
  assert.ok(r.body.methods.crypto?.address, "no deposit address");
  assert.ok(r.body.methods.crypto?.amountUsdc > 146, "no USDC figure");
  assert.match(r.body.pageUrl, new RegExp(`^${API}/pay/keycard/[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$`));
  const text = JSON.stringify(r.body);
  for (const secret of ["EE123456789012345678", "shop@example.com", merchant.id, "buyer@example.com", TOKEN]) assert.ok(!text.includes(secret), `leaked ${secret}`);
});
await check("the lookup accepts the gid form too, and an order we do not know is a 404 marked pending", async () => {
  assert.equal((await call("GET", `/api/shopify/orders/${SHOP}/${encodeURIComponent(o1.admin_graphql_api_id)}`)).status, 200);
  const r = await call("GET", `/api/shopify/orders/${SHOP}/999`);
  assert.equal(r.status, 404);
  assert.equal(r.body.pending, true);
});
await check("an order id under another shop's name is a 404 — a page cannot be made to show one store's order as another's", async () => {
  assert.equal((await call("GET", `/api/shopify/orders/other-store.myshopify.com/${o1.id}`)).status, 404);
  assert.equal((await call("GET", `/api/shopify/orders/not-a-shop/${o1.id}`)).status, 404);
});
await check("the email-template pay link redirects to the order's pay page", async () => {
  const r = await call("GET", `/api/shopify/orders/${SHOP}/${o1.id}/pay`);
  assert.equal(r.status, 302);
  const req = store.findPaymentRequestBySource("shopify", o1.admin_graphql_api_id)!;
  assert.ok(r.location.endsWith(`/pay/keycard/${req.code.slice(0, 5)}-${req.code.slice(5, 10)}-${req.code.slice(10)}`), r.location);
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
await check("the buyer's USDC deposit marks the request PAID, the order is marked paid through the Admin API exactly once, and the facts land on a zold.payment metafield", async () => {
  const req = store.findPaymentRequestBySource("shopify", o1.admin_graphql_api_id)!;
  const paid = payRequest(req)!;
  assert.equal(paid.state, "PAID");
  assert.ok(await until(() => Boolean(store.findPaymentRequest(req.id)!.source.resolvedAt)), `not resolved: ${store.findPaymentRequest(req.id)!.source.resolveError}`);
  const marks = calls.filter((c) => c.op === "orderMarkAsPaid" && c.vars.input.id === o1.admin_graphql_api_id);
  assert.equal(marks.length, 1);
  assert.ok(await until(() => calls.some((c) => c.op === "metafieldsSet" && c.vars.metafields[0].ownerId === o1.admin_graphql_api_id)), "no metafield written");
  const mf = calls.find((c) => c.op === "metafieldsSet" && c.vars.metafields[0].ownerId === o1.admin_graphql_api_id)!.vars.metafields[0];
  assert.deepEqual({ ns: mf.namespace, key: mf.key, type: mf.type }, { ns: "zold", key: "payment", type: "json" });
  const facts = JSON.parse(mf.value);
  assert.equal(facts.amountEur, 129);
  assert.ok(facts.payments[0].txHash?.startsWith("0x"));
});
await check("the lookup now reports PAID and the return link sends the buyer to Shopify's order status page", async () => {
  const r = await call("GET", `/api/shopify/orders/${SHOP}/${o1.id}`);
  assert.equal(r.body.state, "PAID");
  const req = store.findPaymentRequestBySource("shopify", o1.admin_graphql_api_id)!;
  const back = await call("GET", `/api/shopify/return/${req.code}`);
  assert.equal(back.status, 302);
  assert.equal(back.location, o1.order_status_url);
});
await check("a mark-as-paid the store refused is recorded and retried by the sweep", async () => {
  const o = order();
  await webhook("orders/create", o);
  const req = store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id)!;
  failNextMarkPaid = true;
  payRequest(req);
  assert.ok(await until(() => Boolean(store.findPaymentRequest(req.id)!.source.resolveError)), "no error recorded");
  assert.match(store.findPaymentRequest(req.id)!.source.resolveError!, /cannot be marked as paid/);
  assert.equal(store.findPaymentRequest(req.id)!.source.resolvedAt, undefined);
  await sweepPaymentRequests();
  const after = store.findPaymentRequest(req.id)!;
  assert.ok(after.source.resolvedAt, `still unresolved: ${after.source.resolveError}`);
  assert.equal(calls.filter((c) => c.op === "orderMarkAsPaid" && c.vars.input.id === o.admin_graphql_api_id).length, 2);
});
await check("orders/cancelled closes an unpaid request but leaves a paid one alone", async () => {
  const o = order();
  await webhook("orders/create", o);
  const open = store.findPaymentRequestBySource("shopify", o.admin_graphql_api_id)!;
  assert.equal((await webhook("orders/cancelled", o)).status, 200);
  assert.equal(store.findPaymentRequest(open.id)!.state, "CANCELLED");
  assert.equal((await webhook("orders/cancelled", o1)).status, 200);
  assert.equal(store.findPaymentRequest(store.findPaymentRequestBySource("shopify", o1.admin_graphql_api_id)!.id)!.state, "PAID");
});

console.log("\nDashboard");
await check("the org view says custom-app mode, lists the webhook and email-link endpoints, the orders with their names, and never the token", async () => {
  const r = await call("GET", `/api/orgs/${org.id}/shopify`, { user: merchant.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "custom-app");
  assert.equal(r.body.manualGateway, "zold");
  assert.equal(r.body.orderTtlHours, 24);
  assert.equal(r.body.endpoints.webhook, `${API}/api/shopify/webhooks/orders`);
  assert.match(r.body.endpoints.payLinkTemplate, /\{\{ shop\.permanent_domain \}\}\/\{\{ order\.id \}\}\/pay$/);
  assert.equal(r.body.endpoints.payment, undefined, "payments-app endpoints shown in custom-app mode");
  assert.equal(r.body.connections[0].mode, "custom-app");
  assert.equal(r.body.connections[0].ready, true);
  assert.ok(r.body.requests.some((x: any) => x.orderName === "#3101" && x.state === "PAID" && x.resolvedAt));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(TOKEN) && !text.includes("accessTokenEnc"), "the store token crossed the API");
});
await check("disconnecting removes the webhook subscription and the connection, and a later webhook is a 404", async () => {
  const c = store.findShopifyConnectionByShop(SHOP)!;
  const r = await call("DELETE", `/api/orgs/${org.id}/shopify/${c.id}`, { user: merchant.id });
  assert.equal(r.status, 200);
  assert.ok(calls.some((x) => x.op === "webhookSubscriptionDelete" && x.vars.id === "gid://shopify/WebhookSubscription/ORDERS_CREATE"));
  assert.equal(store.findShopifyConnectionByShop(SHOP), undefined);
  assert.equal((await webhook("orders/create", order())).status, 404);
});

server.close();
stub.close();
rmSync(process.env.TRANSF_DB_PATH, { force: true });
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nSHOPIFY ORDERS TEST PASSED — ${n} checks`);
