/**
 * Merchant links: an org's consent that the checkout service opens payment
 * requests for one Shopify store (services/api/src/merchant-links.ts).
 *
 *   POST/GET/DELETE /api/orgs/:orgId/merchant-links              member session
 *   POST /api/service/merchant/links/exchange                     checkout credential
 *   GET  /api/service/merchant/links/:linkId
 *   POST /api/service/merchant/links/:linkId/payment-requests
 *   GET  /api/service/merchant/links/:linkId/payment-requests/:id
 *   POST /api/service/merchant/links/:linkId/payment-requests/:id/cancel
 *
 * In process, against a disposable store, a stub webhook receiver and no
 * network. WHAT THIS EXISTS TO CATCH: a link code that works twice, after 15
 * minutes or for another shop; an exchange that trusts a 15-minute-old
 * consent; a shop taken from the request body instead of the link; one
 * store's order id answering for another org or link; a revoked link opening
 * requests (or no longer reading them); a service view carrying a field it
 * was not built with; core's own Shopify path marking, listing or connecting
 * a linked shop; and the dashboard being told the flow exists when it does not.
 *
 * Run: npm run merchant-links:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const ORIGIN = "https://checkout.example";
const HOOK_SECRET = "whsec_" + Buffer.from("merchant-links-webhook-secret-32").toString("base64");

/* ---- the checkout service's webhook receiver ---- */
const deliveries: unknown[] = [];
const receiver = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    deliveries.push(JSON.parse(raw || "{}"));
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));

process.env.TRANSF_CHAIN_ID = "31337";
// capabilities() loads the chain config; a local RPC that is never called.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";
process.env.TRANSF_DB_PATH = path.join(os.tmpdir(), `zold-merchant-links-test-${process.pid}.json`);
process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.1379, INR: 109.87, KES: 147.53 });
process.env.TRANSF_PUBLIC_URL = "";
process.env.SHOPIFY_API_KEY = "zold-app-key";
process.env.SHOPIFY_API_SECRET = "shpss_test_secret";
process.env.SHOPIFY_MODE = "custom-app";
process.env.CHECKOUT_SERVICE_ORIGIN = ORIGIN;
process.env.CHECKOUT_WEBHOOK_URL = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/zold-hook`;
process.env.CHECKOUT_WEBHOOK_SECRET = HOOK_SECRET;
process.env.CHECKOUT_WEBHOOK_RETRY_BASE_MS = "20";
rmSync(process.env.TRANSF_DB_PATH, { force: true });

const { initStore, store } = await import("../services/api/src/store.js");
const { capabilities } = await import("../services/api/src/capabilities.js");
const { rotateCheckoutCredential } = await import("../services/api/src/checkout-service.js");
const { startCheckoutWebhook } = await import("../services/api/src/checkout-webhook.js");
const { createMerchantLinkRouter } = await import("../services/api/src/routes/merchant-links.js");
const { createServiceMerchantRouter } = await import("../services/api/src/routes/service-merchant.js");
const { createShopifyRouter, resolveShopifyRequest } = await import("../services/api/src/routes/shopify.js");
const { attributeDepositToRequest, sweepPaymentRequests } = await import("../services/api/src/routes/payment-requests.js");
const { consumeLinkCode, LINK_CODE_TTL_MS } = await import("../services/api/src/merchant-links.js");
const { signQuery } = await import("../services/api/src/shopify/hmac.js");
const { apiRateLimit } = await import("../services/api/src/http/policy.js");
initStore();
startCheckoutWebhook();

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use("/api", apiRateLimit);
const session = (req: express.Request, res: express.Response) => {
  const u = req.header("x-user");
  if (u) return { userId: u };
  res.status(401).json({ error: "authorization required" });
  return undefined;
};
app.use("/api", createShopifyRouter(session));
app.use("/api", createMerchantLinkRouter(session));
app.use("/api", createServiceMerchantRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let n = 0;
const failures: string[] = [];
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  n++;
  try { await fn(); console.log(`  ok  ${label}`); }
  catch (e: any) { failures.push(`${n}. ${label}: ${e?.stack ?? e}`); console.log(`  FAIL ${label}\n       ${e?.message ?? e}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(20); return fn(); };

async function call(method: string, p: string, opts: { body?: unknown; user?: string; bearer?: string } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    redirect: "manual",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.user ? { "x-user": opts.user } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: res.status, body, location: res.headers.get("location") ?? "", cache: res.headers.get("cache-control") ?? "" };
}

/* ---- fixtures: two orgs, each with a payee that has a payment page ---- */
const now = new Date().toISOString();
const addr = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
function user(handle: string, name: string, address: `0x${string}`, page = true) {
  const u: any = {
    id: randomUUID(), name, email: `${handle}@example.com`, country: "DE", address, kycStatus: "approved", createdAt: now,
    ...(page ? { paymentPage: { handle, displayName: name, depositAddress: address, recipientAddress: address, supportedTokens: [], settlementAsset: "EURE", autoConvert: false, activatedAt: now, updatedAt: now } } : {}),
  };
  store.addUser(u);
  return u;
}
function orgOf(name: string) {
  const o: any = { id: randomUUID(), type: "business", name, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now };
  store.addOrganisation(o, false);
  return o;
}
function member(orgId: string, userId: string, role: string) {
  const m: any = { id: randomUUID(), orgId, userId, email: `${userId}@example.com`, role, status: "active", invitedAt: now, acceptedAt: now };
  store.addMember(m);
  return m;
}
const owner = user("keycard", "Ada Owner", addr("ab"));
const admin = user("keycard-admin", "Ben Admin", addr("ac"));
const viewer = user("keycard-viewer", "Cy Viewer", addr("ad"), false);
const noPage = user("nopage", "No Page", addr("ae"), false);
const org = orgOf("Keycard Demo GmbH");
member(org.id, owner.id, "owner");
const adminMember = member(org.id, admin.id, "admin");
member(org.id, viewer.id, "viewer");
const owner2 = user("other", "Other Owner", addr("af"));
const org2 = orgOf("Other Shop GmbH");
const owner2Member = member(org2.id, owner2.id, "owner");
const treasurer = user("other-treasury", "Tess Treasurer", addr("b1"));
const org3 = orgOf("No Page GmbH");
member(org3.id, noPage.id, "owner");

const SHOP = "keycard-demo.myshopify.com";
const ORDER = (id: number) => `gid://shopify/Order/${id}`;

const issue = (o: any, u: any, shop = SHOP) => call("POST", `/api/orgs/${o.id}/merchant-links`, { body: { integration: "shopify", shop }, user: u.id });
const codeOf = (installUrl: string) => new URL(installUrl).searchParams.get("link")!;
let token = "";
const preview = (code: string, shop = SHOP, bearer = token) => call("POST", "/api/service/merchant/links/preview", { body: { code, shop }, bearer });
/** Exchange without a preview first: what a checkout that skipped the
 *  confirmation screen would send. */
const rawExchange = (code: string, shop = SHOP, bearer = token) => call("POST", "/api/service/merchant/links/exchange", { body: { code, shop }, bearer });
/** The checkout's normal order: preview (the admin confirms), then exchange. */
const exchange = async (code: string, shop = SHOP, bearer = token) => { await preview(code, shop, bearer); return rawExchange(code, shop, bearer); };
const create = (linkId: string, body: unknown, bearer = token) => call("POST", `/api/service/merchant/links/${linkId}/payment-requests`, { body, bearer });

console.log("availability");
await check("no checkout credential: the capability is off and route 1 answers 503 MERCHANT_LINKS_UNAVAILABLE", async () => {
  assert.deepEqual(capabilities().merchantLinks, { available: false });
  const r = await issue(org, owner);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "MERCHANT_LINKS_UNAVAILABLE");
});
await check("no checkout credential: the service routes answer 503, not 401", async () => {
  assert.equal((await exchange("zlc_x", SHOP, "anything")).status, 503);
  assert.equal((await call("GET", "/api/service/merchant/links/x", { bearer: "anything" })).status, 503);
});
token = rotateCheckoutCredential("operator:test").token;
await check("with origin, credential and data key the capability is on and names the origin", () => {
  assert.deepEqual(capabilities().merchantLinks, { available: true, checkoutOrigin: ORIGIN });
});
const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const linksModule = new URL("../services/api/src/merchant-links.ts", import.meta.url).pathname;
/** A fresh process per origin, since config is read at import. Async on
 *  purpose: spawnSync froze the event loop past the API server's 5 s
 *  keep-alive, and the next request then reused a socket the server was
 *  closing ("fetch failed" on slow CI runners). */
const availabilityWith = (origin: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(tsx, ["-e",
    `import(${JSON.stringify(linksModule)}).then((m) => console.log(JSON.stringify(m.merchantLinksAvailable()))).catch((e) => { console.error(e.message); process.exit(1); })`], {
    env: { ...process.env, CHECKOUT_SERVICE_ORIGIN: origin },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
await check("CHECKOUT_SERVICE_ORIGIN unset: merchant links are off", async () => {
  const r = await availabilityWith("");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(out.available, false);
  assert.match(out.reason, /CHECKOUT_SERVICE_ORIGIN/);
});
for (const [label, origin] of [["plain http to a remote host", "http://checkout.example"], ["a path", "https://checkout.example/app"], ["credentials", "https://u:p@checkout.example"]] as const) {
  await check(`config refuses CHECKOUT_SERVICE_ORIGIN with ${label}`, async () => {
    const r = await availabilityWith(origin);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CHECKOUT_SERVICE_ORIGIN/);
  });
}

console.log("route 1: issuing a link code");
await check("a viewer may not issue a code (403)", async () => {
  assert.equal((await issue(org, viewer)).status, 403);
});
await check("a shop that is not a myshopify.com domain is 400", async () => {
  assert.equal((await issue(org, owner, "evil.example.com")).status, 400);
});
await check("an org whose payee has no payment page is 409 with the payee reason", async () => {
  const r = await issue(org3, noPage);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NO_PAYMENT_PAGE");
  assert.match(r.body.error, /payment page/);
});
let first: any;
await check("an owner gets 201 {installUrl, shop, payeeHandle, expiresAt}: the checkout's install route with a zlc_ code", async () => {
  first = await issue(org, owner, " Keycard-Demo.myshopify.com ");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.cache, "no-store");
  const u = new URL(first.body.installUrl);
  assert.equal(u.origin, ORIGIN);
  assert.equal(u.pathname, "/shopify/install");
  assert.equal(u.searchParams.get("shop"), SHOP);
  assert.match(codeOf(first.body.installUrl), /^zlc_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.body.shop, SHOP);
  assert.equal(first.body.payeeHandle, "keycard");
  const ttl = Date.parse(first.body.expiresAt) - Date.now();
  assert.ok(ttl > LINK_CODE_TTL_MS - 5_000 && ttl <= LINK_CODE_TTL_MS, `ttl ${ttl}`);
});

console.log("route 4: exchange");
await check("an exchange without a code, or with a shop that is not a myshopify.com domain, is 400 INVALID_REQUEST", async () => {
  for (const body of [{ shop: SHOP }, { code: 7, shop: SHOP }, { code: "zlc_x", shop: "evil.example.com" }]) {
    const r = await call("POST", "/api/service/merchant/links/exchange", { body, bearer: token });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "INVALID_REQUEST");
  }
});
await check("a wrong bearer is 401", async () => {
  assert.equal((await exchange(codeOf(first.body.installUrl), SHOP, "zsc_" + "A".repeat(43))).status, 401);
  assert.equal((await exchange(codeOf(first.body.installUrl), SHOP, "")).status, 401);
});
await check("a code exchanged for another shop is refused, and is spent by that try", async () => {
  const code = codeOf(first.body.installUrl);
  const wrong = await exchange(code, "other-store.myshopify.com");
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.code, "LINK_CODE_INVALID");
  const again = await exchange(code);
  assert.equal(again.status, 404, "the code survived a failed exchange");
});
let link: any;
await check("preview describes the code without spending it: shop, org name, payee handle and display name, expiry; no secret or id", async () => {
  const code = codeOf((await issue(org, owner)).body.installUrl);
  const a = await preview(code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.cache, "no-store");
  assert.deepEqual(Object.keys(a.body).sort(), ["expiresAt", "orgName", "payeeDisplayName", "payeeHandle", "shop"]);
  assert.equal(a.body.shop, SHOP);
  assert.equal(a.body.orgName, org.name);
  assert.equal(a.body.payeeHandle, "keycard");
  assert.equal(a.body.payeeDisplayName, "Ada Owner");
  const s = JSON.stringify(a.body);
  for (const leak of [org.id, owner.id, "linkSecret", "zlc_"]) assert.ok(!s.includes(leak), `leaked ${leak}`);
  const b = await preview(code);
  assert.equal(b.status, 200, "a second preview still finds the code");
  assert.equal((await rawExchange(code)).status, 200, "preview then exchange works");
});
await check("preview of an unknown code, or for another shop, is 404 LINK_CODE_INVALID; a wrong bearer 401", async () => {
  const code = codeOf((await issue(org, owner)).body.installUrl);
  const other = await preview(code, "other-store.myshopify.com");
  assert.equal(other.status, 404);
  assert.equal(other.body.code, "LINK_CODE_INVALID");
  assert.equal((await preview("zlc_" + "A".repeat(43))).body.code, "LINK_CODE_INVALID");
  assert.equal((await preview(code, SHOP, "zsc_wrong")).status, 401);
  assert.equal((await preview(code)).status, 200, "a mismatched preview does not spend the code");
});
await check("exchange of a code never previewed is 409 LINK_NOT_CONFIRMED, and the code is spent", async () => {
  const code = codeOf((await issue(org, owner)).body.installUrl);
  const r = await rawExchange(code);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LINK_NOT_CONFIRMED");
  assert.equal((await preview(code)).status, 404, "spent");
  assert.equal((await exchange(code)).status, 404);
});
await check("a fresh code exchanges once: {linkId, shop, orgName, payeeHandle, linkSecret}; the second use is LINK_CODE_INVALID", async () => {
  const code = codeOf((await issue(org, owner)).body.installUrl);
  const r = await exchange(code);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.cache, "no-store");
  assert.deepEqual(Object.keys(r.body).sort(), ["linkId", "linkSecret", "orgName", "payeeHandle", "shop"]);
  assert.equal(r.body.shop, SHOP);
  assert.equal(r.body.orgName, org.name);
  assert.equal(r.body.payeeHandle, "keycard");
  assert.match(r.body.linkSecret, /^[0-9a-f]{64}$/);
  link = r.body;
  const again = await exchange(code);
  assert.equal(again.status, 404);
  assert.equal(again.body.code, "LINK_CODE_INVALID");
});
await check("the link secret is sealed at rest, never in the db file in the clear", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
  assert.ok(!raw.includes(link.linkSecret));
  assert.ok(store.findMerchantLink(link.linkId)!.linkSecretEnc);
});
await check("a code older than 15 minutes is refused, and the refusal spends it", async () => {
  const code = codeOf((await issue(org, owner)).body.installUrl);
  assert.equal(consumeLinkCode(code, SHOP, Date.now() + LINK_CODE_TTL_MS + 1), undefined);
  assert.equal((await exchange(code)).status, 404);
});
await check("a second consent for the same org and shop reuses the link and keeps its secret", async () => {
  const r = await exchange(codeOf((await issue(org, owner)).body.installUrl));
  assert.equal(r.status, 200);
  assert.equal(r.body.linkId, link.linkId);
  assert.equal(r.body.linkSecret, link.linkSecret);
});
await check("an installer demoted after the code was issued is refused at exchange (409 INSTALLER_NOT_ALLOWED)", async () => {
  const code = codeOf((await issue(org, admin)).body.installUrl);
  assert.equal((await preview(code)).status, 200);
  store.updateMember(adminMember.id, { role: "viewer" } as any);
  try {
    const p = await preview(code);
    assert.equal(p.status, 409, "preview asks the same re-checks");
    assert.equal(p.body.code, "INSTALLER_NOT_ALLOWED");
    const r = await rawExchange(code);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "INSTALLER_NOT_ALLOWED");
  } finally {
    store.updateMember(adminMember.id, { role: "admin" } as any);
  }
});
await check("another org may not link a shop that is actively linked (409 SHOP_LINKED_ELSEWHERE), at issue and at exchange", async () => {
  const r = await issue(org2, owner2);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SHOP_LINKED_ELSEWHERE");
});
const SHOP2 = "race-store.myshopify.com";
await check("a shop linked elsewhere between issue and exchange is refused at exchange", async () => {
  const mine = codeOf((await issue(org, owner, SHOP2)).body.installUrl);
  const theirs = codeOf((await issue(org2, owner2, SHOP2)).body.installUrl);
  assert.equal((await preview(mine, SHOP2)).status, 200);
  assert.equal((await exchange(theirs, SHOP2)).status, 200);
  const r = await rawExchange(mine, SHOP2);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SHOP_LINKED_ELSEWHERE");
});
const SHOP3 = "core-store.myshopify.com";
await check("a shop connected in core is refused at issue and at exchange (409 SHOP_CONNECTED_IN_CORE)", async () => {
  const code = codeOf((await issue(org, owner, SHOP3)).body.installUrl);
  assert.equal((await preview(code, SHOP3)).status, 200);
  store.addShopifyConnection({ id: randomUUID(), orgId: org.id, shop: SHOP3, payeeUserId: owner.id, accessTokenEnc: "x", scope: "read_orders", mode: "custom-app", installedByUserId: owner.id, installedAt: now, updatedAt: now });
  const atExchange = await rawExchange(code, SHOP3);
  assert.equal(atExchange.status, 409);
  assert.equal(atExchange.body.code, "SHOP_CONNECTED_IN_CORE");
  const atIssue = await issue(org, owner, SHOP3);
  assert.equal(atIssue.status, 409);
  assert.equal(atIssue.body.code, "SHOP_CONNECTED_IN_CORE");
});
await check("core's install route refuses a linked shop (409 SHOP_LINKED_THROUGH_CHECKOUT)", async () => {
  const r = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: SHOP }, user: owner.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SHOP_LINKED_THROUGH_CHECKOUT");
});
await check("core's install callback refuses a shop linked after the install started", async () => {
  const SHOP4 = "late-link.myshopify.com";
  const started = await call("POST", `/api/orgs/${org.id}/shopify/install`, { body: { shop: SHOP4 }, user: owner.id });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
  assert.equal((await exchange(codeOf((await issue(org, owner, SHOP4)).body.installUrl), SHOP4)).status, 200);
  const q: Record<string, string> = { code: "good-code", shop: SHOP4, state, timestamp: String(Math.floor(Date.now() / 1000)), host: "abc" };
  const r = await call("GET", `/api/shopify/callback?${new URLSearchParams({ ...q, hmac: signQuery(q, "shpss_test_secret") })}`);
  assert.equal(r.status, 302);
  const back = new URL(r.location);
  assert.equal(back.searchParams.get("code"), "SHOP_LINKED_THROUGH_CHECKOUT");
  assert.equal(store.findShopifyConnectionByShop(SHOP4), undefined);
});

console.log("routes 5-6: link read and payment requests");
await check("GET link answers {linkId, shop, active, payeeHandle}; an unknown id is 404", async () => {
  const r = await call("GET", `/api/service/merchant/links/${link.linkId}`, { bearer: token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { linkId: link.linkId, shop: SHOP, active: true, payeeHandle: "keycard" });
  const missing = await call("GET", "/api/service/merchant/links/nope", { bearer: token });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
});
const SERVICE_VIEW_KEYS = ["amountEur", "code", "createdAt", "currency", "expiresAt", "handle", "id", "order", "pageUrl", "payments", "publicPath", "shop", "state"];
let req1: any;
await check("create opens a crypto request for the LINK's shop, whatever shop the body names, as the service view (201)", async () => {
  const r = await create(link.linkId, {
    amountEur: 129, shop: "attacker.myshopify.com",
    order: { gid: ORDER(5001), name: "#5001", statusUrl: `https://${SHOP}/1/orders/abc/authenticate?key=k` },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.cache, "no-store");
  req1 = r.body;
  assert.deepEqual(Object.keys(r.body).sort(), SERVICE_VIEW_KEYS);
  assert.equal(r.body.shop, SHOP);
  assert.equal(r.body.state, "OPEN");
  assert.equal(r.body.currency, "EUR");
  assert.deepEqual(r.body.order, { gid: ORDER(5001), name: "#5001" });
  assert.equal(r.body.pageUrl, `${API}/pay/keycard/${r.body.code}`);
  assert.equal(r.body.publicPath, `/api/pay/keycard/${r.body.code}`);
  const stored = store.findPaymentRequest(r.body.id)!;
  assert.deepEqual(stored.methods, ["crypto"]);
  assert.equal(stored.orgId, org.id);
  assert.equal(stored.source.linkId, link.linkId);
  assert.equal(stored.source.shop, SHOP);
  assert.equal(stored.source.orderStatusUrl, `https://${SHOP}/1/orders/abc/authenticate?key=k`);
  assert.equal(store.findPaymentRequestBySource("shopify", ORDER(5001), "attacker.myshopify.com"), undefined);
  assert.ok(store.findMerchantLink(link.linkId)!.lastRequestAt);
});
await check("the same order again answers 200 with the same request", async () => {
  const r = await create(link.linkId, { amountEur: 129, order: { gid: ORDER(5001) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, req1.id);
});
await check("concurrent creates for one order share one request", async () => {
  const [a, b] = await Promise.all([
    create(link.linkId, { amountEur: 20, order: { gid: ORDER(5002) } }),
    create(link.linkId, { amountEur: 20, order: { gid: ORDER(5002) } }),
  ]);
  assert.equal(a.body.id, b.body.id);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(store.paymentRequests.filter((r) => r.source.orderGid === ORDER(5002)).length, 1);
});
const link2 = (await call("GET", `/api/service/merchant/links/${store.activeMerchantLinkForShop(SHOP2)!.id}`, { bearer: token })).body;
await check("an order id taken under another link (another org) is 409 ORDER_TAKEN; the same id at another shop is a different order", async () => {
  // Same numeric order id at another store: its own request, no conflict.
  const other = await create(link2.linkId, { amountEur: 10, order: { gid: ORDER(5001) } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.notEqual(other.body.id, req1.id);
  // A core-sourced request (no link) for the link's shop and order is not the link's.
  const core = store.addPaymentRequest({ ...store.findPaymentRequest(req1.id)!, id: randomUUID(), code: "AAAAAAAAAAAAAAA", source: { kind: "shopify", externalId: ORDER(5003), shop: SHOP, orderGid: ORDER(5003) } });
  const r = await create(link.linkId, { amountEur: 10, order: { gid: ORDER(5003) } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ORDER_TAKEN");
  assert.ok(!JSON.stringify(r.body).includes(core.id));
});
for (const [label, body] of [
  ["a zero amount", { amountEur: 0, order: { gid: ORDER(6001) } }],
  ["three decimals", { amountEur: 1.234, order: { gid: ORDER(6001) } }],
  ["a fraction of a cent", { amountEur: 10.005, order: { gid: ORDER(6001) } }],
  ["over the maximum", { amountEur: 1_000_001, order: { gid: ORDER(6001) } }],
  ["a string amount", { amountEur: "10", order: { gid: ORDER(6001) } }],
  ["a non-order gid", { amountEur: 10, order: { gid: "gid://shopify/Customer/1" } }],
  ["an http status URL", { amountEur: 10, order: { gid: ORDER(6001), statusUrl: "http://x.example/s" } }],
  ["a javascript: status URL", { amountEur: 10, order: { gid: ORDER(6001), statusUrl: "javascript:alert(1)" } }],
  ["a status URL over 2048 characters", { amountEur: 10, order: { gid: ORDER(6001), statusUrl: `https://${SHOP}/${"a".repeat(2048)}` } }],
  ["a 41-character order name", { amountEur: 10, order: { gid: ORDER(6001), name: "x".repeat(41) } }],
  ["a 141-character description", { amountEur: 10, description: "x".repeat(141), order: { gid: ORDER(6001) } }],
  ["an expiry over 7 days", { amountEur: 10, expiresInSec: 7 * 86400 + 1, order: { gid: ORDER(6001) } }],
] as const) {
  await check(`create refuses ${label} (400 INVALID_REQUEST)`, async () => {
    const r = await create(link.linkId, body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "INVALID_REQUEST");
  });
}
await check("create on an unknown link is 404, with a wrong bearer 401", async () => {
  const missing = await create("nope", { amountEur: 10, order: { gid: ORDER(6002) } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
  assert.equal((await create(link.linkId, { amountEur: 10, order: { gid: ORDER(6002) } }, "zsc_wrong")).status, 401);
});

console.log("stale payee (fail closed)");
await check("the installer whose own page the store pays into has left: create is 409 NO_PAYMENT_PAGE, nothing opened", async () => {
  store.updateMember(owner2Member.id, { status: "deactivated" });
  try {
    const r = await create(link2.linkId, { amountEur: 10, order: { gid: ORDER(9001) } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "NO_PAYMENT_PAGE");
    assert.match(r.body.error, /link the store again/);
    assert.equal(store.findPaymentRequestBySource("shopify", ORDER(9001), SHOP2), undefined);
  } finally {
    store.updateMember(owner2Member.id, { status: "active" } as any);
  }
});
await check("the org gained a EUR account backed by someone else after linking: create is 409 NO_PAYMENT_PAGE", async () => {
  const account = store.addAccount({ id: randomUUID(), orgId: org2.id, currency: "EUR", label: "EUR account", status: "active", provider: null, identifier: {} as any, backingUserId: treasurer.id } as any);
  try {
    const r = await create(link2.linkId, { amountEur: 10, order: { gid: ORDER(9002) } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "NO_PAYMENT_PAGE");
    assert.match(r.body.error, /link the store again/);
    assert.equal(store.findPaymentRequestBySource("shopify", ORDER(9002), SHOP2), undefined);
  } finally {
    store.updateAccount(account.id, { backingUserId: undefined });
  }
  assert.equal((await create(link2.linkId, { amountEur: 10, order: { gid: ORDER(9003) } })).status, 201, "restored payee opens again");
});

console.log("routes 7-8: read and cancel");
await check("GET request answers the service view; another link's request id is 404", async () => {
  const r = await call("GET", `/api/service/merchant/links/${link.linkId}/payment-requests/${req1.id}`, { bearer: token });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), SERVICE_VIEW_KEYS);
  const other = store.findPaymentRequestBySource("shopify", ORDER(5001), SHOP2)!;
  const foreign = await call("GET", `/api/service/merchant/links/${link.linkId}/payment-requests/${other.id}`, { bearer: token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, "NOT_FOUND");
  const unknown = await call("POST", `/api/service/merchant/links/${link.linkId}/payment-requests/nope/cancel`, { bearer: token });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "NOT_FOUND");
});
await check("the service view carries nothing outside the allowlist, even with a payer name and a payment", async () => {
  const r = store.findPaymentRequest(req1.id)!;
  const view = (await import("../services/api/src/merchant-links.js")).serviceRequestView(
    { ...r, test: true, paidAt: now, description: "secret note", invoiceId: "inv-1", externalInvoiceNumber: "X-1",
      payments: [{ id: "p1", method: "crypto", ref: "deposit:1", amountEur: 129, amountUsdc: 146.79, txHash: "0xabc", depositId: "d1", payerName: "Bea Buyer", kind: "full", settledEur: 129, settledAsset: "USDC", at: now }],
      source: { ...r.source, checkoutTokenHash: "h", resolveError: "e" } },
    API,
  );
  assert.deepEqual(Object.keys(view).sort(), [...SERVICE_VIEW_KEYS, "paidAt", "test"].sort());
  assert.deepEqual(Object.keys(view.payments[0]).sort(), ["amountEur", "amountUsdc", "at", "method", "txHash"]);
  const s = JSON.stringify(view);
  for (const leak of ["Bea Buyer", "secret note", "inv-1", "X-1", "deposit:1", "checkoutTokenHash", "orderStatusUrl", "cryptoQuotes", owner.id]) {
    assert.ok(!s.includes(leak), `leaked ${leak}`);
  }
});
let toCancel: any;
await check("cancel closes an open, unpaid request and announces {paymentRequestId, linkId}", async () => {
  toCancel = (await create(link.linkId, { amountEur: 15, order: { gid: ORDER(7001) } })).body;
  deliveries.length = 0;
  const r = await call("POST", `/api/service/merchant/links/${link.linkId}/payment-requests/${toCancel.id}/cancel`, { bearer: token });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "CANCELLED");
  assert.ok(await until(() => deliveries.length >= 1));
  assert.deepEqual(deliveries[0], { paymentRequestId: toCancel.id, linkId: link.linkId });
});
await check("cancelling it again is 409 NOT_CANCELLABLE with the view unchanged", async () => {
  const r = await call("POST", `/api/service/merchant/links/${link.linkId}/payment-requests/${toCancel.id}/cancel`, { bearer: token });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NOT_CANCELLABLE");
  assert.equal(r.body.request.state, "CANCELLED");
});

console.log("payment, settlement and the core Shopify path");
const pay = (id: string) => {
  const r = store.findPaymentRequest(id)!;
  const q = r.cryptoQuotes[r.cryptoQuotes.length - 1];
  assert.ok(q, "no quote on the request");
  const d = store.addCryptoDeposit({
    id: randomUUID(), userId: owner.id, chainId: 31337, token: "USDC", txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0")}`, logIndex: 0,
    amountUnits: String(Math.round(q.amountUsdc * 1e6)), amountUsdc: q.amountUsdc, settlementAsset: "USDC", paymentAddress: owner.paymentPage.depositAddress,
    holding: "awaiting_approval", txs: [], detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any);
  return attributeDepositToRequest(d);
};
await check("a paid link request announces {paymentRequestId, linkId} exactly once, sweep or not", async () => {
  deliveries.length = 0;
  const paid = pay(req1.id)!;
  assert.equal(paid.state, "PAID");
  assert.ok(await until(() => deliveries.length >= 1));
  assert.deepEqual(deliveries[0], { paymentRequestId: req1.id, linkId: link.linkId });
  await sweepPaymentRequests();
  await sleep(100);
  assert.equal(deliveries.length, 1);
});
await check("resolveShopifyRequest leaves a link request alone: no attempt, no error recorded", async () => {
  await resolveShopifyRequest(store.findPaymentRequest(req1.id)!);
  const s = store.findPaymentRequest(req1.id)!.source;
  assert.equal(s.resolveAttempts, undefined);
  assert.equal(s.resolveError, undefined);
  assert.equal(s.resolvedAt, undefined);
});
await check("/shopify/return for a PAID link request goes to the order's status page; an open one to the pay page", async () => {
  const paid = await call("GET", `/api/shopify/return/${req1.code}`);
  assert.equal(paid.status, 302);
  assert.equal(paid.location, `https://${SHOP}/1/orders/abc/authenticate?key=k`);
  const open = store.findPaymentRequestBySource("shopify", ORDER(5002), SHOP)!;
  const r = await call("GET", `/api/shopify/return/${open.code}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /\/pay\/keycard\//);
});
await check("core's Shopify listing leaves link requests out; the merchant-links listing has them, newest first", async () => {
  const core = await call("GET", `/api/orgs/${org.id}/shopify`, { user: owner.id });
  assert.equal(core.status, 200);
  assert.ok(core.body.requests.every((r: any) => r.shop !== SHOP), JSON.stringify(core.body.requests));
  const mine = await call("GET", `/api/orgs/${org.id}/merchant-links`, { user: owner.id });
  assert.equal(mine.status, 200);
  assert.equal(mine.cache, "no-store");
  const ids = mine.body.requests.map((r: any) => r.id);
  assert.ok(ids.includes(req1.id));
  assert.ok(mine.body.requests.every((r: any) => r.linkId && store.findMerchantLink(r.linkId)!.orgId === org.id));
  const times = mine.body.requests.map((r: any) => Date.parse(r.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

console.log("route 2: what members see");
await check("an owner sees each active link's email template (signed with the link secret) and the extension origin", async () => {
  const r = await call("GET", `/api/orgs/${org.id}/merchant-links`, { user: owner.id });
  assert.equal(r.body.available, true);
  assert.equal(r.body.checkoutOrigin, ORIGIN);
  assert.equal(r.body.canManage, true);
  const l = r.body.links.find((x: any) => x.id === link.linkId);
  assert.equal(l.shop, SHOP);
  assert.equal(l.payeeHandle, "keycard");
  assert.equal(l.createdBy, "Ada Owner");
  assert.equal(l.extensionOrigin, ORIGIN);
  assert.equal(l.payLinkTemplate, `${ORIGIN}/shopify/orders/${SHOP}/{{ id }}/pay?b={{ id | hmac_sha256: "${link.linkSecret}" }}`);
  assert.ok(!("payeeUserId" in l) && !("linkSecretEnc" in l));
});
await check("a viewer sees the links but no template, no origin and no secret", async () => {
  const r = await call("GET", `/api/orgs/${org.id}/merchant-links`, { user: viewer.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.canManage, false);
  assert.ok(r.body.links.length >= 1);
  assert.ok(r.body.links.every((l: any) => !l.payLinkTemplate && !l.extensionOrigin));
  assert.ok(!JSON.stringify(r.body).includes(link.linkSecret));
});
await check("a non-member gets 404; another org's links are not listed", async () => {
  assert.equal((await call("GET", `/api/orgs/${org.id}/merchant-links`, { user: owner2.id })).status, 404);
  const theirs = await call("GET", `/api/orgs/${org2.id}/merchant-links`, { user: owner2.id });
  assert.ok(theirs.body.links.every((l: any) => l.id !== link.linkId));
});

console.log("route 3: revoke");
const open = store.findPaymentRequestBySource("shopify", ORDER(5002), SHOP)!;
await check("a viewer may not revoke (403); another org's link id is 404", async () => {
  assert.equal((await call("DELETE", `/api/orgs/${org.id}/merchant-links/${link.linkId}`, { user: viewer.id })).status, 403);
  assert.equal((await call("DELETE", `/api/orgs/${org2.id}/merchant-links/${link.linkId}`, { user: owner2.id })).status, 404);
});
let preRevokeCode = "";
await check("an owner revokes: revokedAt and revokedBy set, {linkId} announced, the second call idempotent and silent", async () => {
  preRevokeCode = codeOf((await issue(org, owner)).body.installUrl);
  deliveries.length = 0;
  const r = await call("DELETE", `/api/orgs/${org.id}/merchant-links/${link.linkId}`, { user: owner.id });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["link"]);
  assert.equal(r.body.link.id, link.linkId);
  assert.ok(r.body.link.revokedAt);
  const l = store.findMerchantLink(link.linkId)!;
  assert.ok(l.revokedAt);
  assert.equal(l.revokedBy, owner.id);
  assert.ok(await until(() => deliveries.length >= 1));
  assert.deepEqual(deliveries[0], { linkId: link.linkId });
  const again = await call("DELETE", `/api/orgs/${org.id}/merchant-links/${link.linkId}`, { user: owner.id });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, r.body, "a repeat answers the same");
  await sleep(100);
  assert.equal(deliveries.length, 1);
  assert.ok(store.findMerchantLink(link.linkId), "a revoked link is kept");
});
await check("a link code issued before the revoke cannot be exchanged after it", async () => {
  const r = await rawExchange(preRevokeCode);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "LINK_CODE_INVALID");
  assert.equal(store.activeMerchantLinkForShop(SHOP), undefined);
});
await check("a revoked link opens nothing (403 LINK_REVOKED), not even a repeat of a known order", async () => {
  const r = await create(link.linkId, { amountEur: 10, order: { gid: ORDER(8001) } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "LINK_REVOKED");
  assert.equal((await create(link.linkId, { amountEur: 129, order: { gid: ORDER(5001) } })).status, 403);
});
await check("a revoked link still reads, and cancels, its requests", async () => {
  const read = await call("GET", `/api/service/merchant/links/${link.linkId}`, { bearer: token });
  assert.equal(read.body.active, false);
  assert.ok(read.body.revokedAt);
  assert.equal((await call("GET", `/api/service/merchant/links/${link.linkId}/payment-requests/${req1.id}`, { bearer: token })).body.state, "PAID");
  const c = await call("POST", `/api/service/merchant/links/${link.linkId}/payment-requests/${open.id}/cancel`, { bearer: token });
  assert.equal(c.status, 200);
  assert.equal(c.body.state, "CANCELLED");
});
await check("a revoked link's template is no longer shown, and the shop may be linked again (a new link, a new secret)", async () => {
  const r = await call("GET", `/api/orgs/${org.id}/merchant-links`, { user: owner.id });
  const l = r.body.links.find((x: any) => x.id === link.linkId);
  assert.ok(l.revokedAt);
  assert.equal(l.payLinkTemplate, undefined);
  const again = await exchange(codeOf((await issue(org, owner)).body.installUrl));
  assert.equal(again.status, 200);
  assert.notEqual(again.body.linkId, link.linkId);
  assert.notEqual(again.body.linkSecret, link.linkSecret);
});

console.log("audit");
await check("every service call is audited with its credential and outcome, never a code, secret or token", () => {
  const rows = store.auditFor(undefined, 5000).filter((a) => a.kind.startsWith("service.merchant_"));
  const kinds = new Set(rows.map((a) => a.kind));
  for (const k of ["service.merchant_link_preview", "service.merchant_link_exchange", "service.merchant_link_read", "service.merchant_request_create", "service.merchant_request_read", "service.merchant_request_cancel"]) {
    assert.ok(kinds.has(k as any), `no ${k}`);
  }
  assert.ok(rows.every((a) => a.data.credentialId && a.data.outcome));
  const s = JSON.stringify(rows);
  assert.ok(!s.includes(link.linkSecret) && !s.includes(token) && !s.includes("zlc_"));
  const linked = rows.filter((a) => a.data.outcome === "linked");
  assert.ok(linked.length > 0 && linked.every((a) => a.data.payeeUserId), "linked rows name the payee");
});

server.close();
receiver.close();
rmSync(process.env.TRANSF_DB_PATH!, { force: true });
if (failures.length) {
  console.error(`\nmerchant-links: ${failures.length} failed\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nmerchant-links: all ${n} passed`);
process.exit(0);
