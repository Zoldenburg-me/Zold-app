/**
 * The pay-with-zold checkout service's read endpoint and state-change webhook.
 *
 *   GET /api/service/checkout/transfers/:id
 *
 * Asserts, in process against a disposable store:
 *   1. no credential issued → 503; missing or wrong bearer → 401
 *   2. only the operator can rotate; the token is returned once and only its
 *      hash is stored
 *   3. only a SEPA transfer whose reference carries ZP + 12 hex is served, as
 *      exactly the allowlisted fields; everything else is the same 404
 *   4. rotation keeps the previous credential valid for the overlap, not after
 *   5. every authenticated read is audited, without the token
 *   6. the service bucket rate-limits a valid credential
 *   7. a state change on a checkout transfer POSTs {transferId}, Standard
 *      Webhooks signed, retried under one webhook-id; nothing else is sent
 *   8. a wrong credential counts on the auth bucket, not the service one
 *   9. config refuses a webhook URL or secret it could not use safely
 *
 * Run: npm run checkout-service:test
 */
// Must be first: pins the chain and the db path before config.js reads them.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

const OPERATOR = "operator-token-for-the-checkout-test-0123";
const HOOK_SECRET = "whsec_" + Buffer.from("checkout-webhook-test-secret-32b").toString("base64");
const SERVICE_LIMIT = 40;
const AUTH_LIMIT = 30;

/* ---- the checkout service's receiving end ---- */
const deliveries: { headers: IncomingHttpHeaders; raw: string }[] = [];
let failNext = 0;
const receiver = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    deliveries.push({ headers: req.headers, raw });
    if (failNext > 0) {
      failNext--;
      res.writeHead(500).end();
      return;
    }
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/zold-hook`;

process.env.KYC_OPERATOR_TOKEN = OPERATOR;
process.env.SERVICE_RATE_LIMIT_PER_MIN = String(SERVICE_LIMIT);
process.env.AUTH_RATE_LIMIT_PER_MIN = String(AUTH_LIMIT);
process.env.CHECKOUT_SERVICE_ROTATION_OVERLAP_SEC = "3600";
process.env.CHECKOUT_WEBHOOK_URL = receiverUrl;
process.env.CHECKOUT_WEBHOOK_SECRET = HOOK_SECRET;
process.env.CHECKOUT_WEBHOOK_RETRY_BASE_MS = "20";
process.env.CHECKOUT_WEBHOOK_MAX_ATTEMPTS = "3";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { apiRateLimit } = await import("../services/api/src/http/policy.js");
const { createCheckoutServiceRouter } = await import("../services/api/src/routes/service-checkout.js");
const { checkoutCredentialFor, isCheckoutTransfer } = await import("../services/api/src/checkout-service.js");
const { startCheckoutWebhook } = await import("../services/api/src/checkout-webhook.js");
const { verifyStandardWebhook } = await import("../services/api/src/http/standard-webhooks.js");

initStore();
startCheckoutWebhook();

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

const app = express();
app.use(express.json());
app.use("/api", apiRateLimit);
app.use("/api", createCheckoutServiceRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

async function get(id: string, bearer?: string) {
  const res = await fetch(`${base}/service/checkout/transfers/${encodeURIComponent(id)}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function rotate(bearer?: string, body?: Record<string, unknown>) {
  const res = await fetch(`${base}/admin/service-credentials/checkout/rotate`, {
    method: "POST",
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const now = new Date().toISOString();
function transfer(id: string, over: Record<string, unknown>) {
  store.addTransfer({
    id,
    userId: "user-checkout",
    quoteId: "q-" + id,
    rail: "sepa",
    recipientName: "Merchant GmbH",
    recipientIban: "DE89370400440532013000",
    state: "CREATED",
    sendEur: 25,
    receiveKes: 0,
    receiveEur: 25,
    txs: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  } as any);
}

transfer("t-ok", { reference: "Order 4711 ZP0123456789ab" });
transfer("t-ok-upper", { reference: "ZPABCDEF012345" });
transfer("t-cash", { rail: "cash", recipientIban: undefined, recipientPhone: "+254700000000", reference: "ZP0123456789ab" });
transfer("t-noref", {});
transfer("t-plain", { reference: "invoice 2026-17" });
transfer("t-short", { reference: "ZP0123456789a" });
transfer("t-long", { reference: "ZP0123456789abc" });
transfer("t-glued", { reference: "XZP0123456789ab" });
transfer("t-nonhex", { reference: "ZP0123456789zz" });
transfer("t-review", { reference: "ZP00000000beef", state: "MANUAL_REVIEW" });

console.log("credential");
await check("no credential issued answers 503", async () => {
  const r = await get("t-ok", "anything");
  assert.equal(r.status, 503);
});
await check("rotation without the operator token is refused", async () => {
  assert.equal((await rotate()).status, 401);
  assert.equal((await rotate("not-the-operator-token-xxxxxxxx")).status, 401);
});

const first = await rotate(OPERATOR);
const token1: string = first.body.token;
await check("rotation returns a fresh token once", () => {
  assert.equal(first.status, 201);
  assert.match(token1, /^zsc_[A-Za-z0-9_-]{43}$/);
  assert.ok(first.body.id);
});
await check("the store holds the hash, never the token", () => {
  const raw = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
  assert.ok(!raw.includes(token1), "token found in the db file");
  assert.ok(raw.includes("serviceCredentials"));
});
await check("no bearer and a wrong bearer answer 401", async () => {
  assert.equal((await get("t-ok")).status, 401);
  assert.equal((await get("t-ok", token1 + "x")).status, 401);
  assert.equal((await get("t-ok", "zsc_" + "A".repeat(43))).status, 401);
});

console.log("scope and allowlist");
await check("a SEPA transfer with a ZP checkout reference is served as the allowlist", async () => {
  const r = await get("t-ok", token1);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["id", "rail", "receiveEur", "recipientIban", "reference", "state", "updatedAt"]);
  assert.equal(r.body.id, "t-ok");
  assert.equal(r.body.rail, "sepa");
  assert.equal(r.body.state, "CREATED");
  assert.equal(r.body.receiveEur, 25);
  assert.equal(r.body.recipientIban, "DE89370400440532013000");
  assert.equal(r.body.reference, "Order 4711 ZP0123456789ab");
  assert.equal(r.body.updatedAt, now);
});
await check("upper-case hex is a checkout reference too", async () => {
  assert.equal((await get("t-ok-upper", token1)).status, 200);
});
const notFound = await get("does-not-exist", token1);
for (const id of ["t-cash", "t-noref", "t-plain", "t-short", "t-long", "t-glued", "t-nonhex", "does-not-exist"]) {
  await check(`${id} is the same 404`, async () => {
    const r = await get(id, token1);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, notFound.body);
  });
}
await check("isCheckoutTransfer agrees with the route", () => {
  assert.equal(isCheckoutTransfer(store.findTransfer("t-ok")!), true);
  assert.equal(isCheckoutTransfer(store.findTransfer("t-cash")!), false);
});

console.log("audit");
await check("every authenticated read is audited, served or not, without the token", () => {
  const rows = store.auditFor(undefined, 1000).filter((a) => a.kind === "service.checkout_transfer_read");
  const served = rows.filter((a) => a.data.outcome === "served");
  const missing = rows.filter((a) => a.data.outcome === "not_found");
  assert.equal(served.length, 2);
  assert.equal(missing.length, 9);
  assert.ok(rows.every((a) => a.data.credentialId === first.body.id));
  assert.ok(served.every((a) => a.userId === "user-checkout"));
  assert.ok(missing.every((a) => !a.userId), "a 404 names no account");
  assert.ok(!JSON.stringify(rows).includes(token1));
});
await check("rotation is audited", () => {
  const rows = store.auditFor(undefined, 1000).filter((a) => a.kind === "service.credential_rotated");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.credentialId, first.body.id);
});

console.log("rotation overlap");
const second = await rotate(OPERATOR);
const token2: string = second.body.token;
await check("after rotation both the new and the previous credential work", async () => {
  assert.notEqual(token2, token1);
  assert.equal((await get("t-ok", token2)).status, 200);
  assert.equal((await get("t-ok", token1)).status, 200);
});
await check("the previous credential stops at the end of the overlap", () => {
  const later = Date.now() + 3601_000;
  assert.equal(checkoutCredentialFor(token1, later), undefined);
  assert.ok(checkoutCredentialFor(token2, later));
  assert.ok(checkoutCredentialFor(token1, Date.now() + 3500_000));
});
const third = await rotate(OPERATOR);
await check("a second rotation does not extend an already-expiring credential", () => {
  const soon = Date.now() + 3601_000;
  assert.equal(checkoutCredentialFor(token1, soon), undefined);
  assert.ok(checkoutCredentialFor(token2, soon - 2000));
  assert.ok(checkoutCredentialFor(third.body.token, soon));
});

const fourth = await rotate(OPERATOR, { revokePrevious: true });
await check("revokePrevious ends every earlier credential at once", async () => {
  assert.equal(fourth.status, 201);
  assert.equal((await get("t-ok", third.body.token)).status, 401);
  assert.equal((await get("t-ok", token2)).status, 401);
  assert.equal((await get("t-ok", fourth.body.token)).status, 200);
});
await check("revokePrevious must be a boolean", async () => {
  assert.equal((await rotate(OPERATOR, { revokePrevious: "yes" })).status, 400);
  assert.equal((await rotate(OPERATOR, { revokePrevious: null })).status, 400);
});
await check("a revoke sent as a form is refused, not read as a plain rotation", async () => {
  const res = await fetch(`${base}/admin/service-credentials/checkout/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/x-www-form-urlencoded" },
    body: "revokePrevious=true",
  });
  assert.equal(res.status, 415);
});
await check("the rotation audit row records a revoke", () => {
  const row = store.auditFor(undefined, 1000).find((a) => a.kind === "service.credential_rotated" && a.data.credentialId === fourth.body.id);
  assert.equal(row?.data.revokedPrevious, true);
  assert.match(String(row?.data.operator), /^operator:[0-9a-f]{12}$/);
});
const token4: string = fourth.body.token;

console.log("webhook");
await check("signing matches an independent Standard Webhooks HMAC", async () => {
  deliveries.length = 0;
  store.updateTransfer("t-ok", { state: "DEBITED" });
  await waitFor(() => deliveries.length >= 1);
  const d = deliveries[0];
  assert.deepEqual(JSON.parse(d.raw), { transferId: "t-ok" });
  const id = String(d.headers["webhook-id"]);
  const ts = String(d.headers["webhook-timestamp"]);
  assert.match(ts, /^\d+$/, "unix seconds");
  const key = Buffer.from(HOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const expected = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${d.raw}`).digest("base64")}`;
  assert.equal(d.headers["webhook-signature"], expected);
  assert.equal(verifyStandardWebhook({ id, timestamp: ts, signature: expected, raw: Buffer.from(d.raw), secret: HOOK_SECRET }), true);
});
await check("the verifier refuses a stale timestamp and a wrong secret", () => {
  const d = deliveries[0];
  const args = {
    id: String(d.headers["webhook-id"]),
    timestamp: String(d.headers["webhook-timestamp"]),
    signature: String(d.headers["webhook-signature"]),
    raw: Buffer.from(d.raw),
    secret: HOOK_SECRET,
  };
  assert.equal(verifyStandardWebhook({ ...args, now: Date.now() + 301_000 }), false);
  assert.equal(verifyStandardWebhook({ ...args, secret: "whsec_" + Buffer.from("another-secret-of-32-bytes-long!").toString("base64") }), false);
});
await check("a failed delivery is retried under the same webhook-id", async () => {
  deliveries.length = 0;
  failNext = 1;
  store.updateTransfer("t-ok", { state: "PAID" });
  await waitFor(() => deliveries.length >= 2);
  assert.equal(deliveries[0].headers["webhook-id"], deliveries[1].headers["webhook-id"]);
  await sleep(150);
  assert.equal(deliveries.length, 2, "a 2xx ends the retries");
});
await check("delivery stops after the attempt limit", async () => {
  deliveries.length = 0;
  failNext = 10;
  store.updateTransfer("t-ok-upper", { state: "FAILED" });
  await waitFor(() => deliveries.length >= 3);
  await sleep(300);
  assert.equal(deliveries.length, 3);
  failNext = 0;
});
await check("resolving a checkout transfer's review announces it", async () => {
  deliveries.length = 0;
  store.resolveTransferReview("t-review", { state: "FAILED", note: "operator checked Monerium: the redeem never left", by: "operator:test" });
  await waitFor(() => deliveries.length >= 1);
  assert.deepEqual(JSON.parse(deliveries[0].raw), { transferId: "t-review" });
});
await check("the verifier accepts any one good signature in a list, and nothing tampered", () => {
  const id = "msg_test";
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = Buffer.from(JSON.stringify({ transferId: "t-ok" }));
  const key = Buffer.from(HOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const good = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  const bad = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const v = (signature: string, over: Record<string, unknown> = {}) =>
    verifyStandardWebhook({ id, timestamp: ts, signature, raw, secret: HOOK_SECRET, ...over });
  assert.equal(v(`${bad} ${good}`), true);
  assert.equal(v(`${good} ${bad}`), true);
  assert.equal(v(`${bad} v1,short`), false);
  assert.equal(v(""), false);
  assert.equal(v(good, { raw: Buffer.from(JSON.stringify({ transferId: "t-other" })) }), false);
  assert.equal(v(good, { now: Date.now() - 301_000 }), false, "a timestamp from the future");
});
await check("no delivery for a non-checkout transfer or a patch without a state change", async () => {
  deliveries.length = 0;
  store.updateTransfer("t-cash", { state: "DEBITED" });
  store.updateTransfer("t-plain", { state: "DEBITED" });
  store.updateTransfer("t-ok", { recipientName: "Merchant AG" });
  await sleep(150);
  assert.equal(deliveries.length, 0);
});

await check("a listener that throws neither fails the write nor stops the next listener", async () => {
  let reached = false;
  store.onTransferStateChange(() => { throw new Error("listener blew up"); });
  store.onTransferStateChange(() => { reached = true; });
  assert.doesNotThrow(() => store.updateTransfer("t-noref", { state: "DEBITED" }));
  assert.equal(store.findTransfer("t-noref")?.state, "DEBITED");
  assert.equal(reached, true);
});
console.log("rate limit");
await check("a wrong credential is limited on the auth bucket and spares the service one", async () => {
  let limitedAt = 0;
  for (let i = 1; i <= AUTH_LIMIT + 1; i++) {
    const r = await get("t-ok", "zsc_" + "B".repeat(43));
    if (r.status === 429) { limitedAt = i; break; }
  }
  assert.ok(limitedAt > 0 && limitedAt <= AUTH_LIMIT + 1, "wrong tokens were never limited");
  assert.equal((await get("t-ok", token4)).status, 200);
});
await check("a valid credential is limited on the service bucket", async () => {
  let limitedAt = 0;
  for (let i = 1; i <= SERVICE_LIMIT + 2; i++) {
    const r = await get("t-ok", token4);
    if (r.status === 429) { limitedAt = i; break; }
  }
  assert.ok(limitedAt > 0, "never rate limited");
  assert.ok(limitedAt <= SERVICE_LIMIT + 1);
});

console.log("config");
const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const configModule = new URL("../services/api/src/config/checkout-service.ts", import.meta.url).pathname;
for (const [label, url, secret] of [
  ["a URL carrying credentials", "https://user:pw@hooks.example", HOOK_SECRET],
  ["plain http to a remote host", "http://hooks.example/zold", HOOK_SECRET],
  ["a secret without the whsec_ prefix", "https://hooks.example/zold", "not-a-secret"],
  ["a secret under 24 bytes", "https://hooks.example/zold", "whsec_" + Buffer.from("short").toString("base64")],
] as const) {
  await check(`config refuses ${label}`, () => {
    const r = spawnSync(tsx, ["-e", `import(${JSON.stringify(configModule)}).catch((e) => { console.error(e.message); process.exit(1); })`], {
      env: { ...process.env, CHECKOUT_WEBHOOK_URL: url, CHECKOUT_WEBHOOK_SECRET: secret },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CHECKOUT_WEBHOOK_(URL|SECRET)/);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}

server.close();
receiver.close();
if (failed) {
  console.error(`checkout-service: ${failed} failed`);
  process.exit(1);
}
console.log("checkout-service: all passed");
process.exit(0);
