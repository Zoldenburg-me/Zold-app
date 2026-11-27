/**
 * Login rate limits, invoice-link passwords, and what never carries a user IP.
 * Pre-auth bounds: the body cap runs before the rate limit, a blocked partner
 * sees no more calls than its bucket allows, the bucket map stays bounded
 * under a flood of distinct keys and a steady inflow, and the trusted-proxy
 * setting never turns a spoofed X-Forwarded-For into a fresh bucket.
 *
 * Offline: an in-process express app on an ephemeral port and a throwaway db.
 *
 *   npm run security:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.AUTH_RATE_LIMIT_PER_MIN = "20";
process.env.PARTNER_RATE_LIMIT_PER_MIN = "30";
process.env.DOCUMENT_RATE_LIMIT_PER_MIN = "10";
process.env.SHOPIFY_RATE_LIMIT_PER_MIN = "600";
process.env.OPERATOR_RATE_LIMIT_PER_MIN = "300";
rmSync(process.env.TRANSF_DB_PATH!, { force: true });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { passwordProblem, hashPassword, passwordMatches } = await import("../services/api/src/domain/passwords.js");
const { hashToken, ownerInvoiceView } = await import("../services/api/src/domain/invoices.js");
const { apiRateLimit, bucketCounts, clientKey, rateLimit, RATE_BUCKETS_MAX, recordFailure, securityHeaders, securityHeadersFor, setRateClock, sweepExpiredBuckets, tooManyFailures } = await import("../services/api/src/http/policy.js");
const { SECURITY } = await import("../services/api/src/config.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { persist } = await import("../services/api/src/store/db.js");
const { issueOperatorSession } = await import("../services/api/src/operators/sessions.js");

await initStore();
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
/** A check of the JSON file itself; npm run check:pg runs this suite on Postgres too. */
async function checkJsonFile(name: string, fn: () => void | Promise<void>) {
  if (process.env.STORE_BACKEND === "postgres") return console.log(`  skip ${name} (the JSON file; this run is on Postgres)`);
  await check(name, fn);
}

console.log("password policy");
await check("too short, common, low-variety, sequential and contextual passwords are refused", () => {
  assert.match(passwordProblem("short")!, /at least 12/);
  assert.match(passwordProblem("Password1234")!, /common/);
  assert.match(passwordProblem("abababababab")!, /too few/);
  assert.match(passwordProblem("abcdefghijklmn")!, /sequence|common/);
  assert.match(passwordProblem("AcmeGmbH-invoices", ["Acme GmbH", "Acme"])!, /organisation/);
  assert.equal(passwordProblem("x".repeat(129) + "abcde")?.includes("at most"), true);
});
await check("a long, varied passphrase is accepted", () => {
  assert.equal(passwordProblem("copper kettle harbour 42"), undefined);
});

console.log("password hashing");
await check("scrypt hash is salted, verifies, and rejects a wrong password", async () => {
  const a = await hashPassword("copper kettle harbour 42");
  const b = await hashPassword("copper kettle harbour 42");
  assert.ok(a.startsWith("scrypt$"));
  assert.notEqual(a, b, "same password must hash differently (salt)");
  assert.equal(await passwordMatches("copper kettle harbour 42", a), true);
  assert.equal(await passwordMatches("copper kettle harbour 43", a), false);
});
await check("a legacy unsalted SHA-256 row still verifies", async () => {
  assert.equal(await passwordMatches("old-link-password", hashToken("old-link-password")), true);
  assert.equal(await passwordMatches("nope", hashToken("old-link-password")), false);
});

console.log("client keys");
await check("IPv6 is keyed on its /64; mapped IPv4 as IPv4", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey(undefined), "?");
});

// ── HTTP ─────────────────────────────────────────────────────────────────────
const { sendAfterCommit } = await import("../services/api/src/http/send-after-commit.js");
const app = express().use(sendAfterCommit);
app.use(express.json());
app.use(securityHeaders);
app.use("/api", apiRateLimit);
app.post("/api/webauthn/challenge", (_req, res) => res.json({ challenge: "x" }));
app.post("/api/quotes", (_req, res) => res.json({}));
app.post("/api/users/:id/documents/statement", (_req, res) => res.json({}));
app.post("/api/shopify/payment", (_req, res) => res.json({}));
app.get("/api/admin/overview", (_req, res) => res.json({}));
app.use("/api/invoice-links", createInvoiceLinkRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log("rate limits");
await check("unauthenticated challenge minting sits on the tight bucket", async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await fetch(`${base}/api/webauthn/challenge`, { method: "POST" })).status;
  assert.equal(last, 429);
});
await check("changing case or adding a trailing slash does not escape the tight bucket", async () => {
  // Express routes ignore both, so these reach the same handler as above.
  for (const p of ["/api/WebAuthn/Challenge", "/api/webauthn/challenge/"]) {
    assert.equal((await fetch(`${base}${p}`, { method: "POST" })).status, 429, p);
  }
});
await check("routes that call a partner have their own bucket", async () => {
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await fetch(`${base}/api/quotes`, { method: "POST" })).status);
  assert.equal(statuses[29], 200);
  assert.equal(statuses[30], 429);
});
await check("statement documents sit on a tighter one", async () => {
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await fetch(`${base}/api/users/u1/documents/statement`, { method: "POST" })).status;
  assert.equal(last, 429);
});
await check("Shopify's signed calls are not on the 20/min credential bucket", async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await fetch(`${base}/api/shopify/payment`, { method: "POST" })).status;
  assert.equal(last, 200);
});
await check("a live operator session has its own bucket: the dashboard's refresh loop is not the 20/min one", async () => {
  // The challenge test above has already spent this IP's credential bucket.
  await store.addOperator({ id: "op_rate", name: "Rate Operator", email: "rate@example.com", createdAt: new Date().toISOString(), credentials: [] });
  const auth = { authorization: `Bearer ${await issueOperatorSession("op_rate")}` };
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await fetch(`${base}/api/admin/overview`, { headers: auth })).status);
  assert.deepEqual([...new Set(statuses)], [200]);
});
await check("an unknown operator bearer stays on the credential bucket", async () => {
  const r = await fetch(`${base}/api/admin/overview`, { headers: { authorization: "Bearer guess-guess-guess-guess-guess" } });
  assert.equal(r.status, 429);
});
await check("every response says no-referrer and nosniff", async () => {
  const r = await fetch(`${base}/api/invoice-links/nothing`);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
await check("every answer Zold writes is marked as Zold's, a refusal and a rate-limit 429 included", async () => {
  const notFound = await fetch(`${base}/api/invoice-links/nothing`);
  assert.ok(notFound.status >= 400 && notFound.status < 500, String(notFound.status));
  assert.equal(notFound.headers.get("x-zold-answer"), "1");
  const limited = await fetch(`${base}/api/webauthn/challenge`, { method: "POST" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("x-zold-answer"), "1");
});
await check("every response carries a same-origin CSP and refuses to be framed", async () => {
  const r = await fetch(`${base}/api/invoice-links/nothing`);
  const csp = r.headers.get("content-security-policy") ?? "";
  for (const d of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(d), `CSP lacks ${d}: ${csp}`);
  }
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});
await check("production pins HTTPS on every subdomain (five minutes while subdomains are confirmed); local dev does not", async () => {
  const headersFrom = async (production: boolean) => {
    const one = express().use(sendAfterCommit);
    one.use(securityHeadersFor(production));
    one.get("/", (_req, res) => res.end());
    const s = one.listen(0);
    try {
      return (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`)).headers;
    } finally {
      s.close();
    }
  };
  assert.equal((await headersFrom(true)).get("strict-transport-security"), "max-age=300; includeSubDomains");
  assert.equal((await headersFrom(false)).get("strict-transport-security"), null);
});

console.log("invoice-link password");
const now = new Date().toISOString();
const token = "tok-" + "a".repeat(40);
await store.addInvoice({
  id: "inv_sec", orgId: "org_sec", linkTokenHash: hashToken(token),
  linkPasswordHash: await hashPassword("copper kettle harbour 42"),
  state: "LINK_CREATED", lines: [], currency: "EUR", total: "0.00",
  createdByMemberId: "m1", createdAt: now, updatedAt: now,
} as any);
// Distinct source per request, so only the per-link counter can stop this.
let src = 0;
const open = (pw?: string) =>
  fetch(`${base}/api/invoice-links/${token}`, {
    headers: { ...(pw ? { "x-invoice-password": pw } : {}), "x-forwarded-for": `198.51.100.${++src}` },
  });
app.set("trust proxy", 1);
await check("no password asks for one; the right one opens the link", async () => {
  assert.equal((await open()).status, 401);
  assert.equal((await open("copper kettle harbour 42")).status, 200);
});
await check("ten wrong guesses from ten addresses lock the link, even for the right password", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await open(`wrong guess ${i}`)).status, 401);
  assert.equal((await open("copper kettle harbour 42")).status, 429);
});
await check("guesses sent all at once still stop at ten, though checking is asynchronous", async () => {
  const token2 = "tok-" + "b".repeat(40);
  await store.addInvoice({
    id: "inv_sec2", orgId: "org_sec", linkTokenHash: hashToken(token2),
    linkPasswordHash: await hashPassword("copper kettle harbour 42"),
    state: "LINK_CREATED", lines: [], currency: "EUR", total: "0.00",
    createdByMemberId: "m1", createdAt: now, updatedAt: now,
  } as any);
  const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    fetch(`${base}/api/invoice-links/${token2}`, {
      headers: { "x-invoice-password": `wrong ${i}`, "x-forwarded-for": `198.51.101.${i + 1}` },
    }).then((r) => r.status)));
  assert.equal(statuses.filter((x) => x === 401).length, 10, statuses.join(","));
  assert.equal(statuses.filter((x) => x === 429).length, 20);
});
server.close();

console.log("pre-auth bounds");
// server.ts's order, rebuilt: headers, the capped body parser, then the
// limiter. The first check pins that the real file still has it.
const pre = express();
pre.use(securityHeaders);
pre.use(express.json({ limit: SECURITY.jsonBodyLimit }));
pre.set("trust proxy", 1);
pre.use("/api", apiRateLimit);
let challenges = 0;
pre.post("/api/webauthn/challenge", (_req, res) => {
  challenges++;
  res.json({ challenge: "x" });
});
let upstreamCalls = 0;
const releaseUpstream: Array<() => void> = [];
// A partner that never answers until the test lets it.
pre.post("/api/quotes", async (_req, res) => {
  upstreamCalls++;
  await new Promise<void>((r) => releaseUpstream.push(r));
  res.json({});
});
const preServer = http.createServer({ requestTimeout: 400, connectionsCheckingInterval: 50 }, pre).listen(0, "127.0.0.1");
await new Promise((r) => preServer.once("listening", r));
const prePort = (preServer.address() as AddressInfo).port;
const preBase = `http://127.0.0.1:${prePort}`;
const from = (ip: string) => ({ "content-type": "application/json", "x-forwarded-for": ip });
const big = JSON.stringify({ pad: "x".repeat(64 * 1024) });
/** A raw request: headers now, the body chunk by chunk, the answer when it comes. */
function rawPost(path: string, headers: Record<string, string>) {
  const req = http.request({ host: "127.0.0.1", port: prePort, path, method: "POST", headers });
  const answer = new Promise<{ status: number; at: number }>((resolve, reject) => {
    req.on("response", (r) => { r.resume(); resolve({ status: r.statusCode!, at: Date.now() }); });
    req.on("error", reject);
  });
  answer.catch(() => {});
  return { req, answer };
}

await check("server.ts parses the capped body before the /api rate limit, and leaves Node's request timeouts on", () => {
  const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../services/api/src/server.ts"), "utf8");
  const headers = src.indexOf("app.use(securityHeaders);");
  const body = src.indexOf("app.use(express.json({");
  const limiter = src.indexOf('app.use("/api", apiRateLimit);');
  assert.ok(headers >= 0 && headers < body && body < limiter, `order: ${headers} ${body} ${limiter}`);
  assert.match(src.slice(body, limiter), /limit: SECURITY\.jsonBodyLimit/);
  assert.equal(SECURITY.jsonBodyLimit, "64kb");
  assert.doesNotMatch(src, /requestTimeout|headersTimeout|setTimeout\(0\)/);
  const plain = http.createServer();
  assert.ok(plain.requestTimeout > 0 && plain.headersTimeout > 0, `${plain.requestTimeout} ${plain.headersTimeout}`);
});
await check("a body over 64 KiB is a 413 before the limiter counts it, even for a caller already limited", async () => {
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from("198.18.0.1"), body: big });
    assert.equal(r.status, 413);
    assert.equal(r.headers.get("x-zold-answer"), "1");
  }
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from("198.18.0.1"), body: "{}" })).status);
  assert.equal(statuses.filter((x) => x === 200).length, 20, statuses.join(","));
  assert.equal(statuses[20], 429);
  assert.equal((await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from("198.18.0.1"), body: big })).status, 413);
});
// body-parser answers an oversized body only once the request has ended (it
// discards the rest, holding none of it), so the socket's lifetime is bounded
// by Node's request timeout, not by the cap.
await check("a declared Content-Length over the cap never reaches a handler; unsent, it ends at the request timeout", async () => {
  const before = challenges;
  const { req, answer } = rawPost("/api/webauthn/challenge", { ...from("198.18.0.2"), "content-length": String(10 * 1024 * 1024) });
  req.flushHeaders();
  const started = Date.now();
  const r = await answer.catch(() => ({ status: 0, at: Date.now() }));
  req.destroy();
  assert.ok(r.status === 408 || r.status === 0, String(r.status));
  assert.ok(r.at - started < 3000, `${r.at - started} ms`);
  assert.equal(challenges, before);
});
await check("a slow chunked body past the cap is discarded and answered 413 when it ends, never handled", async () => {
  const before = challenges;
  const { req, answer } = rawPost("/api/webauthn/challenge", { ...from("198.18.0.3"), "transfer-encoding": "chunked" });
  req.write("{\"pad\":\"");
  for (let i = 0; i < 100; i++) {
    req.write("x".repeat(1024));
    await new Promise((r) => setTimeout(r, 1));
  }
  req.end("\"}");
  const r = await answer;
  assert.equal(r.status, 413);
  assert.equal(challenges, before);
});
await check("a stalled body holds its socket only until the request timeout", async () => {
  const { req, answer } = rawPost("/api/webauthn/challenge", { ...from("198.18.0.4"), "content-length": "100" });
  req.write("{\"pad\":");
  const started = Date.now();
  const r = await answer.catch(() => ({ status: 0, at: Date.now() }));
  req.destroy();
  assert.ok(r.status === 408 || r.status === 0, String(r.status));
  assert.ok(r.at - started < 3000, `${r.at - started} ms`);
});
await check("a blocked partner sees no more calls than the partner bucket allows; the rest are refused at once", async () => {
  const limit = SECURITY.partnerRateLimitPerMin;
  const calls = Array.from({ length: limit + 15 }, () =>
    fetch(`${preBase}/api/quotes`, { method: "POST", headers: from("198.18.0.5"), body: "{}" }).then((r) => r.status));
  // Whichever requests the limiter takes first, the refused ones answer at
  // once and the admitted ones hang on the partner: count, don't index.
  const answered: number[] = [];
  for (const c of calls) void c.then((s) => answered.push(s));
  const deadline = Date.now() + 3000;
  while (answered.length < 15 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(answered, Array(15).fill(429));
  assert.equal(upstreamCalls, limit);
  for (const release of releaseUpstream.splice(0)) release();
  const all = await Promise.all(calls);
  assert.equal(all.filter((s) => s === 200).length, limit);
  assert.equal(all.filter((s) => s === 429).length, 15);
  assert.equal(upstreamCalls, limit);
});
await check("one trusted hop keys on the address the proxy appended; a spoofed left part mints no bucket", async () => {
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    statuses.push((await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from(`203.0.113.${i + 1}, 198.18.0.6`), body: "{}" })).status);
  }
  assert.equal(statuses[19], 200);
  assert.equal(statuses[20], 429);
  // The proxy's own address is not the key: another client is not locked out.
  assert.equal((await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from("198.18.0.7"), body: "{}" })).status, 200);
});
await wallJumpOnDefaultClock("startup");
// An injected rate clock, ten minutes on: every bucket so far has expired, so
// the socket peer's windows start fresh for the no-proxy check and the sweep
// starts empty.
let clock = performance.now() + 10 * 60_000;
setRateClock(() => clock);
try {
  await check("with no trusted hop (the default) the socket peer is the key; X-Forwarded-For is ignored", async () => {
    pre.set("trust proxy", 0);
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await fetch(`${preBase}/api/webauthn/challenge`, { method: "POST", headers: from(`203.0.114.${i + 1}`), body: "{}" })).status);
    }
    pre.set("trust proxy", 1);
    assert.equal(statuses[19], 200, statuses.join(","));
    assert.equal(statuses[20], 429);
  });
  await check("under a steady inflow of new keys the sweep holds the map to one window of them", () => {
    sweepExpiredBuckets();
    const base0 = bucketCounts().hits;
    let peak = 0;
    // Five simulated minutes, 200 new client keys a second, swept every 10 s as the timer does.
    for (let sec = 0; sec < 300; sec++) {
      for (let i = 0; i < 200; i++) rateLimit(`g:steady-${sec}-${i}`, 300);
      clock += 1000;
      if (sec % 10 === 9) sweepExpiredBuckets();
      peak = Math.max(peak, bucketCounts().hits - base0);
    }
    assert.ok(peak <= 200 * 71, `peak ${peak}`);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("a flood of fresh keys stops at the cap and locks out no one: a known caller past its window, a newcomer and a quote are served; limited keys stay limited", () => {
    // A regular caller's window ends during the flood; it must still be served after.
    for (let i = 0; i < 5; i++) rateLimit("g:regular", 300);
    clock += 61_000;
    for (let i = 0; i < 21; i++) rateLimit("c:limited-before-flood", 20);
    assert.equal(rateLimit("c:limited-before-flood", 20), false);
    for (let i = 0; i < RATE_BUCKETS_MAX + 20_000; i++) {
      rateLimit(`g:flood-${i}`, 300);
      // One flooding key goes past its limit early in the flood.
      if (i === 1000) for (let j = 0; j < 301; j++) rateLimit("g:flood-hot", 300);
    }
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX);
    // Limited keys are not reset by the flood, the flooder's own included.
    assert.equal(rateLimit("c:limited-before-flood", 20), false);
    assert.equal(rateLimit("g:flood-hot", 300), false);
    // Nobody is refused for want of a slot.
    assert.equal(rateLimit("g:regular", 300), true);
    assert.equal(rateLimit("g:newcomer", 300), true);
    assert.equal(rateLimit("p:newcomer", 30, "partner"), true);
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX + 1);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("a flood of two-request keys does not reset a limited key: limited windows are evicted last", () => {
    // A thousand limited credential keys, then idle while the flood runs.
    for (let k = 0; k < 1000; k++) for (let i = 0; i < 21; i++) rateLimit(`c:limited-idle-${k}`, 20);
    for (let i = 0; i < RATE_BUCKETS_MAX + 20_000; i++) {
      rateLimit(`g:pair-${i}`, 300);
      rateLimit(`g:pair-${i}`, 300);
    }
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX);
    let reset = 0;
    for (let k = 0; k < 1000; k++) if (rateLimit(`c:limited-idle-${k}`, 20)) reset++;
    assert.equal(reset, 0, `${reset} limited keys reset by the flood`);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("at the cap the per-IP and partner counters of one quote request do not evict each other: the partner limit still builds", () => {
    // Every other window counted two requests, so a new one-request window is
    // the first to go; a shared cap made g: and p: evict each other.
    for (let i = 0; i < RATE_BUCKETS_MAX - 1; i++) {
      rateLimit(`g:pair-full-${i}`, 300);
      rateLimit(`g:pair-full-${i}`, 300);
    }
    let partnerPassed = 0;
    for (let i = 0; i < 40; i++) {
      assert.equal(rateLimit("g:quoter", 300), true);
      if (rateLimit("p:quoter", 30, "partner")) partnerPassed++;
    }
    assert.equal(partnerPassed, 30);
    // A login counts the per-IP bucket, then the credential: same rule.
    let credentialPassed = 0;
    for (let i = 0; i < 25; i++) {
      rateLimit("a:login", 300);
      if (rateLimit("c:guessed", 20, "credential")) credentialPassed++;
    }
    assert.equal(credentialPassed, 20);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("at the cap ended windows go before live ones, whatever their tier: live counted and limited windows keep their counts", () => {
    // Half the cap: limited windows, then ended (not yet swept).
    for (let k = 0; k < RATE_BUCKETS_MAX / 2; k++) for (let i = 0; i < 3; i++) rateLimit(`c:ended-${k}`, 2);
    clock += 61_000;
    // The other half: live, a thousand limited, the rest at two requests.
    for (let k = 0; k < 1000; k++) for (let i = 0; i < 3; i++) rateLimit(`c:live-limited-${k}`, 2);
    for (let k = 0; k < RATE_BUCKETS_MAX / 2 - 1000; k++) for (let i = 0; i < 2; i++) rateLimit(`c:live-${k}`, 2);
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX);
    // A pair flood of 30k fresh keys: each takes the slot of an ended window.
    for (let i = 0; i < 30_000; i++) for (let j = 0; j < 2; j++) rateLimit(`c:mixed-flood-${i}`, 2);
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX);
    let reset = 0;
    for (let k = 0; k < 1000; k++) if (rateLimit(`c:live-limited-${k}`, 2)) reset++;
    for (let k = 0; k < RATE_BUCKETS_MAX / 2 - 1000; k++) if (rateLimit(`c:live-${k}`, 2)) reset++;
    assert.equal(reset, 0, `${reset} live windows evicted while ended ones waited`);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("at the cap a new key costs what it costs below the cap (300k keys past it)", () => {
    const timeKeys = (prefix: string, count: number) => {
      const t0 = performance.now();
      for (let i = 0; i < count; i++) rateLimit(`${prefix}-${i}`, 300);
      return performance.now() - t0;
    };
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
    // Below the cap, as the baseline: the same work less the eviction.
    const fill = timeKeys("g:fill", RATE_BUCKETS_MAX);
    assert.equal(bucketCounts().hits, RATE_BUCKETS_MAX);
    const past = timeKeys("g:past", 3 * RATE_BUCKETS_MAX);
    // A Map walked from its oldest entry took 30-120x the fill per 100k here.
    assert.ok(past / 3 < 5 * fill + 50, `fill ${fill.toFixed(0)} ms per 100k, past the cap ${(past / 3).toFixed(0)} ms per 100k`);
    clock += 61_000;
    sweepExpiredBuckets();
    assert.equal(bucketCounts().hits, 0);
  });
  await check("a wall-clock jump forward and its correction neither stretch nor cut a window", () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 30 * 60_000;
      for (let i = 0; i < 3; i++) rateLimit("c:wall-jump", 2);
      assert.equal(rateLimit("c:wall-jump", 2), false);
      Date.now = realNow;
      for (let i = 0; i < 10; i++) rateLimit(`g:after-jump-${i}`, 300);
      clock += 61_000;
      sweepExpiredBuckets();
      assert.equal(bucketCounts().hits, 0, "a window outlived its 60 s");
      assert.equal(rateLimit("c:wall-jump", 2), true);
    } finally { Date.now = realNow; }
    clock += 61_000;
    sweepExpiredBuckets();
  });
} finally {
  setRateClock();
}
// The default clock, with only the wall clock moved: were it Date.now, the
// 30-minute step would end both windows at once. Run on the clock the module
// starts with and again on the one setRateClock() puts back.
async function wallJumpOnDefaultClock(which: string) {
  await check(`on the ${which} clock a wall-clock jump ends neither a rate window nor a failure count`, () => {
    const realNow = Date.now;
    const k = `default-clock-${which}`;
    try {
      for (let i = 0; i < 3; i++) rateLimit(`c:${k}`, 2);
      recordFailure(`f:${k}`, 60_000);
      recordFailure(`f:${k}`, 60_000);
      assert.equal(tooManyFailures(`f:${k}`, 2), true);
      Date.now = () => realNow() + 30 * 60_000;
      assert.equal(rateLimit(`c:${k}`, 2), false, "a wall-clock jump cut a rate window");
      assert.equal(tooManyFailures(`f:${k}`, 2), true, "a wall-clock jump cut a failure count");
      recordFailure(`f:${k}`, 60_000);
      assert.equal(tooManyFailures(`f:${k}`, 3), true, "a wall-clock jump restarted a failure count");
    } finally { Date.now = realNow; }
  });
}
await wallJumpOnDefaultClock("restored");
// todo (owner decision, #107 8/8 Q1): the failure counters (operator login
// per IP, invoice-link passwords per link) are swept but not capped. Capping
// means evicting a lock early (a bypass) or refusing new keys when full (a
// lock for every new caller); that choice is not made here.
console.log("  todo failure-counter map: swept, not capped — evict or refuse at a cap is an owner decision");
for (const release of releaseUpstream.splice(0)) release();
preServer.close();

console.log("no hashes, no IPs");
await check("the owner view drops both link hashes", async () => {
  const v = ownerInvoiceView((await store.findInvoice("inv_sec"))!) as Record<string, unknown>;
  assert.equal("linkTokenHash" in v, false);
  assert.equal("linkPasswordHash" in v, false);
});
await check("a legacy consent row's IP is never projected", async () => {
  const u = await publicUser({
    id: "u1", name: "n", country: "DE", kycStatus: "pending", iban: "", address: "0x0", createdAt: now,
    consents: [{ kind: "zold_terms", version: "1", at: now, ip: "203.0.113.9" }],
  } as any);
  assert.equal(JSON.stringify(u).includes("203.0.113.9"), false);
  assert.equal(u.consents?.length, 1);
});

console.log("availability");
const { emailLooksValid } = await import("../services/api/src/domain/email.js");
await check("the email check answers a hostile 60,000-character address at once", () => {
  for (const ok of ["a@b.de", "first.last+tag@mail.example.co.uk"]) assert.equal(emailLooksValid(ok), true, ok);
  for (const bad of ["a@b", "a@@b.de", "a b@c.de", "a@b..de", `${"a".repeat(250)}@b.de`]) assert.equal(emailLooksValid(bad), false, bad);
  const t = Date.now();
  assert.equal(emailLooksValid("a@" + ".".repeat(60_000) + "@"), false);
  assert.equal(emailLooksValid("a@b" + ".c".repeat(30_000) + "@"), false);
  assert.ok(Date.now() - t < 50, `took ${Date.now() - t} ms`);
});
await checkJsonFile("writes inside store.tx reach the file once, at its end", async () => {
  const { readFileSync } = await import("node:fs");
  const onDisk = () => readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
  await store.tx(async () => {
    await store.audit({ id: "aud_batch_1", at: now, action: "test.batch", data: {}, actorId: "t" } as any);
    await store.audit({ id: "aud_batch_2", at: now, action: "test.batch", data: {}, actorId: "t" } as any);
    assert.equal(onDisk().includes("aud_batch_1"), false, "written before the batch ended");
  });
  assert.ok(onDisk().includes("aud_batch_1") && onDisk().includes("aud_batch_2"));
});
await check("a quote nobody took is dropped a day after it expired; a consumed one stays", async () => {
  const q = (id: string, status: string, hoursAgo: number) => ({
    id, userId: "u1", rail: "sepa", status, sendEur: 1, fixedFeeEur: 0, fxRate: 1, receiveKes: 0, receiveEur: 1,
    midRate: 1, marginBps: 0, effectiveRate: 1, createdAt: now,
    expiresAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  } as any);
  await store.addQuote(q("q_old_open", "OPEN", 30));
  await store.addQuote(q("q_old_used", "CONSUMED", 30));
  await store.addQuote(q("q_recent", "EXPIRED", 2));
  await store.addQuote(q("q_new", "OPEN", -1));
  assert.equal(await store.findQuote("q_old_open"), undefined);
  assert.ok((await store.findQuote("q_old_used")) && (await store.findQuote("q_recent")) && (await store.findQuote("q_new")));
});

console.log("a passkey replaced by recovery while an approval is being verified");
{
  const { createHash, randomBytes, webcrypto } = await import("node:crypto");
  const { checkOpAssertion } = await import("../services/api/src/http/passkey-assertion.js");
  const { createAuthRouter, verifyPasskeyStepUp } = await import("../services/api/src/routes/auth.js");
  const { bindRecoveredPasskey } = await import("../services/api/src/recovery/recovered-passkey.js");
  const { issueChallenge, stepUpBinding } = await import("../services/api/src/webauthn.js");
  const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
  const b64url = (b: Buffer) => b.toString("base64url");
  const rawToDer = (raw: Buffer) => {
    const int = (b: Buffer) => {
      let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
      if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return Buffer.concat([Buffer.from([0x02, v.length]), v]);
    };
    const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
    return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
  };
  // A software P-256 authenticator, user-verified (flags UP|UV).
  const softPasskey = async (label: string) => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const credentialId = b64url(Buffer.from(`${label}-${randomBytes(4).toString("hex")}`));
    let count = 0;
    return {
      credentialId,
      stored: () => ({ credentialId, publicKey: { alg: "ES256", jwk }, signCount: 0, rpId: "localhost", createdAt: now }),
      assert: async (challenge: string) => {
        const authData = Buffer.alloc(37);
        sha256(Buffer.from("localhost")).copy(authData, 0);
        authData[32] = 0x05;
        authData.writeUInt32BE(++count, 33);
        const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000" }));
        const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([authData, sha256(clientData)])));
        return { credentialId, authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(rawToDer(raw)) };
      },
    };
  };
  const oldKey = await softPasskey("old-device");
  const newKey = await softPasskey("recovered");
  const uid = "u_race";
  await store.addUser({
    id: uid, name: "Race", country: "DE", kycStatus: "approved", address: "0x5afe00000000000000000000000000000000ace1", createdAt: now,
    passkey: oldKey.stored(),
    passkeySafe: { address: "0x5afe00000000000000000000000000000000ace1", status: "active", threshold: 1 },
  } as any);
  const reset = async () => await store.updateUser(uid, { passkey: oldKey.stored() as any });

  // Hold WebCrypto's verify open until the test lets it go: the window in
  // which a recovery can finish.
  const subtle = webcrypto.subtle as any;
  const realVerify = subtle.verify.bind(subtle);
  let hold: { reached: () => void; release: Promise<void> } | undefined;
  subtle.verify = async (...args: any[]) => { if (hold) { hold.reached(); await hold.release; } return realVerify(...args); };
  /** Run `call`, and while its passkey verification is in flight, recover the account onto newKey. */
  const recoverDuring = async <T>(call: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    let reached!: () => void;
    const verifying = new Promise<void>((r) => (reached = r));
    hold = { reached, release: new Promise<void>((r) => (release = r)) };
    const result = call();
    await verifying;
    await bindRecoveredPasskey((await store.findUser(uid))!, { ...newKey.stored(), attestation: "none" } as any, new Date());
    release();
    try { return await result; } finally { hold = undefined; }
  };
  const fakeRes = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.status = (c: number) => ((r.statusCode = c), r);
    r.json = (b: unknown) => ((r.body = b), r);
    return r;
  };

  await check("a Safe-op approval by the old passkey does not put it back after recovery", async () => {
    await reset();
    const challenge = b64url(randomBytes(32));
    const res = fakeRes();
    const ok = await recoverDuring(async () => checkOpAssertion((await store.findUser(uid))!, await oldKey.assert(challenge), challenge, res));
    assert.equal((await store.findUser(uid))!.passkey!.credentialId, newKey.credentialId);
    assert.equal(await store.findUserByCredential(oldKey.credentialId), undefined);
    assert.equal(ok, undefined);
    assert.ok(res.statusCode >= 400);
  });

  await check("a step-up by the old passkey that finishes after recovery is refused", async () => {
    await reset();
    const step = await oldKey.assert(issueChallenge("step_up", stepUpBinding(uid, "passkey.replace")));
    const res = fakeRes();
    const ok = await recoverDuring(async () => verifyPasskeyStepUp((await store.findUser(uid))!, { stepUp: step }, res, "passkey.replace"));
    assert.equal(ok, false);
    assert.equal((await store.findUser(uid))!.passkey!.credentialId, newKey.credentialId);
  });

  await check("a login by the old passkey that finishes after recovery gets no session", async () => {
    await reset();
    const app = express().use(sendAfterCommit).use(express.json()).use("/api", createAuthRouter({ requireUserSession: async () => undefined }));
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passkey/login`;
      const body = await oldKey.assert(issueChallenge("login"));
      const r = await recoverDuring(() => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const json = (await r.json()) as any;
      assert.equal(json.sessionToken, undefined);
      assert.equal(r.status, 401);
      assert.equal((await store.list("sessions")).filter((s) => s.userId === uid && !s.revokedAt).length, 0);
      assert.equal((await store.findUser(uid))!.passkey!.credentialId, newKey.credentialId);
    } finally {
      server.close();
    }
  });

  await check("a recovery that lands after the login's passkey check and before its session is minted leaves no session of the old device", async () => {
    await reset();
    const app = express().use(sendAfterCommit).use(express.json()).use("/api", createAuthRouter({ requireUserSession: async () => undefined }));
    const server = app.listen(0);
    const s = store as any;
    const realUse = s.recordPasskeyUse;
    let reached!: () => void;
    const minting = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const go = new Promise<void>((r) => (release = r));
    // Held once the passkey check has passed: the window before the session.
    s.recordPasskeyUse = async (...args: unknown[]) => { const out = await realUse(...args); reached(); await go; return out; };
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passkey/login`;
      const body = await oldKey.assert(issueChallenge("login"));
      // Read before the login holds the store.
      const owner = (await store.findUser(uid))!;
      const login = fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await minting;
      // Started, not awaited: while the login holds the store it waits behind it.
      const recovered = bindRecoveredPasskey(owner, { ...newKey.stored(), attestation: "none" } as any, new Date());
      await new Promise((r) => setTimeout(r, 30));
      release();
      await Promise.all([login, recovered]);
      assert.equal((await store.list("sessions")).filter((x) => x.userId === uid && !x.revokedAt).length, 0, "no session of the old device outlives the recovery");
      assert.equal((await store.findUser(uid))!.passkey!.credentialId, newKey.credentialId);
    } finally {
      s.recordPasskeyUse = realUse;
      server.close();
    }
  });

  await check("sign-out revokes the session on the server: the old token is refused, other sessions live", async () => {
    await reset();
    const { issueSession } = await import("../services/api/src/http/sessions.js");
    const app = express().use(sendAfterCommit).use(express.json()).use("/api", createAuthRouter({ requireUserSession: async () => undefined }));
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session`;
      const signedOut = await issueSession((await store.findUser(uid))!);
      const other = await issueSession((await store.findUser(uid))!);
      const auth = (t: string) => ({ authorization: `Bearer ${t}` });
      assert.equal((await fetch(url, { method: "DELETE", headers: auth(signedOut) })).status, 204);
      assert.equal((await fetch(url, { headers: auth(signedOut) })).status, 401);
      assert.equal((await fetch(url, { method: "DELETE", headers: auth(signedOut) })).status, 401);
      assert.equal((await fetch(url, { method: "DELETE", headers: auth(other) })).status, 204);
    } finally {
      server.close();
    }
  });
  subtle.verify = realVerify;

  await check("every passkey signCount write goes through store.recordPasskeyUse (its patch is built in store/rules.ts)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const src = new URL("../services/api/src/", import.meta.url);
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && f !== "store.ts" && f !== path.join("store", "rules.ts"))
      .filter((f) => /passkey:\s*\{\s*\.\.\.[\w.]+,\s*signCount\s*\}/.test(readFileSync(new URL(f, src), "utf8")));
    assert.deepEqual(offenders, []);
  });
}

console.log("database file");
await checkJsonFile("the database file is readable by its owner only, even over a stale world-readable .tmp", () => {
  const dbPath = process.env.TRANSF_DB_PATH!;
  rmSync(dbPath, { force: true });
  writeFileSync(dbPath + ".tmp", "{}", { mode: 0o644 });
  chmodSync(dbPath + ".tmp", 0o644);
  persist();
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});
await checkJsonFile("a store write under umask 022 replaces the database file at mode 600, and a new store dir is 700", async () => {
  const dbPath = process.env.TRANSF_DB_PATH!;
  const { auditEntry } = await import("../services/api/src/audit.js");
  const oldUmask = process.umask(0o022);
  try {
    chmodSync(dbPath, 0o600);
    const inode = statSync(dbPath).ino;
    await store.audit(auditEntry("operator.request", { test: "file-mode" }));
    assert.notEqual(statSync(dbPath).ino, inode, "the write renamed a new file over the store");
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    // The child inherits umask 022, so a missing mkdir mode would show as 755.
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "zold-db-mode-")), "data");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", `import("./services/api/src/store/db.ts").then((m) => m.initStore())`],
      { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TRANSF_DB_PATH: path.join(dir, "db.json") }, encoding: "utf8" },
    );
    try {
      assert.equal(run.status, 0, run.stderr);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(dir, "db.json")).mode & 0o777, 0o600);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  } finally {
    process.umask(oldUmask);
  }
});

console.log("secret files");
await check("a new operator enrolment file, and one over a stale 0644 file, is mode 600 under umask 022", async () => {
  const { startEnrolment } = await import("../services/api/src/operators/enrolment.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-enrol-mode-"));
  const oldUmask = process.umask(0o022);
  try {
    const fresh = path.join(dir, "fresh.json");
    startEnrolment("Op", "op@example.com", Date.now(), fresh);
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
    const stale = path.join(dir, "stale.json");
    writeFileSync(stale, "{}");
    chmodSync(stale, 0o644);
    writeFileSync(stale + ".tmp", "{}");
    chmodSync(stale + ".tmp", 0o644);
    const inode = statSync(stale).ino;
    startEnrolment("Op", "op@example.com", Date.now(), stale);
    // A new file renamed over the old: the details never sit in the 0644 one.
    assert.notEqual(statSync(stale).ino, inode);
    assert.equal(statSync(stale).mode & 0o777, 0o600);
  } finally {
    process.umask(oldUmask);
    rmSync(dir, { recursive: true, force: true });
  }
});
await check("a provisioned testnet Stellar treasury file is mode 600 under umask 022, and a stale 0644 one is tightened on read", async () => {
  const { STELLAR, STELLAR_TESTNET_PASSPHRASE } = await import("../services/api/src/config.js");
  const { getTreasury } = await import("../services/api/src/stellar/anchor.js");
  const saved = { ...STELLAR };
  const realFetch = globalThis.fetch;
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-treasury-mode-"));
  const oldUmask = process.umask(0o022);
  try {
    Object.assign(STELLAR, { treasurySecret: "", networkPassphrase: STELLAR_TESTNET_PASSPHRASE, friendbot: "https://friendbot.invalid" });
    globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
    const file = path.join(dir, "data", "stellar-treasury.json");
    const kp = await getTreasury(file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A treasury file left at 0644 by an older write is tightened when read.
    chmodSync(file, 0o644);
    assert.equal((await getTreasury(file)).publicKey(), kp.publicKey());
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    process.umask(oldUmask);
    globalThis.fetch = realFetch;
    Object.assign(STELLAR, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("secrets runner (scripts/with-env-fd.mjs)");
const RUNNER = new URL("./with-env-fd.mjs", import.meta.url).pathname;
const runWithSecrets = (dotenv: string | null, command: string[], env: NodeJS.ProcessEnv = {}) => {
  const file = path.join(os.tmpdir(), `zold-runner-test-${process.pid}.env`);
  writeFileSync(file, dotenv ?? "");
  const fd = openSync(file, "r");
  try {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
    if (dotenv !== null) stdio.push(fd);
    return spawnSync(process.execPath, [RUNNER, ...command], { stdio, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  } finally {
    closeSync(fd);
    rmSync(file, { force: true });
  }
};
const node = (code: string) => [process.execPath, "-e", code];
await check("refuses to start the command when nothing was decrypted", () => {
  for (const empty of ["", "# only a comment\n\n"]) {
    const r = runWithSecrets(empty, node("process.stdout.write('started')"));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no secrets decrypted/);
  }
});
await check("refuses when there is no fd 3 at all", () => {
  const r = runWithSecrets(null, node("process.stdout.write('started')"));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /could not read secrets on fd 3/);
});
await check("decrypted values reach the command; a variable already set wins", () => {
  const r = runWithSecrets("A=from_fd\nB=from_fd\n", node("process.stdout.write(process.env.A + ',' + process.env.B)"), { B: "from_env" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "from_fd,from_env");
});
await check("the command's exit code and killing signal come back out", () => {
  assert.equal(runWithSecrets("A=1\n", node("process.exit(7)")).status, 7);
  const killed = runWithSecrets("A=1\n", node("process.kill(process.pid, 'SIGTERM')"));
  assert.equal(killed.signal ?? (killed.status === 143 ? "SIGTERM" : killed.status), "SIGTERM");
});
await check("a command that does not exist is a plain error, not a crash", () => {
  const r = runWithSecrets("A=1\n", ["zold-no-such-command"]);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /could not start zold-no-such-command/);
});

console.log("secrets set (scripts/env-set.mjs, scripts/secrets.sh set)");
const SETTER = new URL("./env-set.mjs", import.meta.url).pathname;
const SECRETS_SH = new URL("./secrets.sh", import.meta.url).pathname;
const { parseEnv } = await import("node:util");
/** Runs env-set.mjs with `dotenv` on fd 3 and `value` (if any) on fd 4. */
const setVar = (dotenv: string, args: string[], value: string | null = null) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zold-env-set-"));
  const f3 = path.join(dir, "current");
  const f4 = path.join(dir, "value");
  writeFileSync(f3, dotenv);
  writeFileSync(f4, value ?? "");
  const fd3 = openSync(f3, "r");
  const fd4 = openSync(f4, "r");
  try {
    return spawnSync(process.execPath, [SETTER, ...args], {
      stdio: ["ignore", "pipe", "pipe", fd3, ...(value === null ? [] : [fd4])],
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
  } finally {
    closeSync(fd3);
    closeSync(fd4);
    rmSync(dir, { recursive: true, force: true });
  }
};
const CURRENT = "# operator settings\nA=one\n\nB='two words'\nC=three # trailing note\n";
await check("set adds a new name and keeps every other line, comments included", () => {
  const r = setVar(CURRENT, ["NEW_NAME"], "fake-value-1");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(CURRENT), "the existing text is kept as it was");
  assert.deepEqual(parseEnv(r.stdout), { ...parseEnv(CURRENT), NEW_NAME: "fake-value-1" });
});
await check("set refuses a name that is already set, unless --replace, and never echoes a value", () => {
  const r = setVar(CURRENT, ["A"], "fake-value-2");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /A is already set.*--replace/);
  assert.ok(!r.stderr.includes("fake-value-2") && !r.stderr.includes("one"));
});
await check("set --replace changes that one value and nothing else", () => {
  const r = setVar(CURRENT, ["A", "--replace"], "fake-value-3");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseEnv(r.stdout), { ...parseEnv(CURRENT), A: "fake-value-3" });
  assert.ok(r.stdout.includes("# operator settings"));
  assert.equal(r.stdout.match(/^A=/gm)?.length, 1, "the old A line is gone");
});
await check("values with spaces, # or quotes round-trip through the same parser as `run`, or are refused", () => {
  for (const v of ["has space", "has#hash", "a=b+c/d", "it's", 'say "hi"']) {
    const r = setVar(CURRENT, ["V"], v);
    if (r.status === 0) assert.equal(parseEnv(r.stdout).V, v, `round trip of ${JSON.stringify(v)}`);
    else assert.match(r.stderr, /cannot be written/);
  }
});
await check("set refuses an empty value, a value over two lines, and a bad name", () => {
  assert.match(setVar(CURRENT, ["V"], "").stderr, /empty/);
  assert.match(setVar(CURRENT, ["V"], "line1\nline2").stderr, /one line/);
  for (const bad of ["lower", "1ST", "A-B", ""]) {
    const r = setVar(CURRENT, [bad], "x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a variable name|usage/);
    if (bad) assert.ok(!r.stderr.includes(bad), "a rejected name is not echoed");
  }
});
await check("set --random makes 32 random bytes as base64, with an optional prefix, and prints none of it", () => {
  const a = setVar(CURRENT, ["DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
  const b = setVar(CURRENT, ["DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
  assert.equal(a.status, 0, a.stderr);
  const va = parseEnv(a.stdout).DATA_ENCRYPTION_KEYS!;
  assert.match(va, /^k1:[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(va.slice(3), "base64").length, 32);
  assert.notEqual(va, parseEnv(b.stdout).DATA_ENCRYPTION_KEYS);
  assert.ok(!a.stderr.includes(va.slice(3)));
});

const AGE_DIR = path.join(path.dirname(SECRETS_SH), "..", ".toolchain", "age-v1.3.2", "age");
if (!existsSync(path.join(AGE_DIR, "age"))) {
  console.log("  NOT RUN secrets.sh set end to end: age is not installed here (scripts/fetch-age.sh)");
} else {
  await check("secrets.sh set re-encrypts the file with the new name, keeps the old one encrypted, and run sees it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zold-secrets-set-"));
    try {
      const identity = path.join(dir, "identity");
      const recipients = path.join(dir, "recipients");
      spawnSync(path.join(AGE_DIR, "age-keygen"), ["-o", identity], { encoding: "utf8" });
      writeFileSync(recipients, spawnSync(path.join(AGE_DIR, "age-keygen"), ["-y", identity], { encoding: "utf8" }).stdout);
      const plain = path.join(dir, "dotenv");
      writeFileSync(plain, "A=one\n");
      const env = { PATH: process.env.PATH, AGE_IDENTITY_FILE: identity, AGE_RECIPIENTS_FILE: recipients, SECRETS_ENV_FILE: `${plain}.age` };
      const sh = (args: string[], input?: string) => spawnSync("bash", [SECRETS_SH, ...args], { env, input, encoding: "utf8" });
      assert.equal(sh(["encrypt", plain]).status, 0);
      rmSync(plain);
      const set = sh(["set", "NEW_NAME"], "fake-value-4\n");
      assert.equal(set.status, 0, set.stderr);
      assert.ok(!`${set.stdout}${set.stderr}`.includes("fake-value-4"), "set printed the value");
      assert.ok(existsSync(path.join(dir, "dotenv.prev.age")), "the previous file is kept, encrypted");
      const read = sh(["run", "--", "sh", "-c", 'printf "%s,%s" "$A" "$NEW_NAME"']);
      assert.equal(read.stdout, "one,fake-value-4", read.stderr);
      assert.equal(sh(["set", "A"], "other\n").status, 1);
      assert.equal(sh(["run", "--", "printenv", "A"]).stdout.trim(), "one", "a refused set leaves the file as it was");
      const rnd = sh(["set", "DATA_ENCRYPTION_KEYS", "--random", "--prefix", "k1:"]);
      assert.equal(rnd.status, 0, rnd.stderr);
      assert.match(sh(["run", "--", "printenv", "DATA_ENCRYPTION_KEYS"]).stdout.trim(), /^k1:[A-Za-z0-9+/]{43}=$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("backup-db.sh and secrets.sh against fake age and tar (a throwaway copy of scripts/)");
// The scripts find age under their own ROOT/.toolchain, so each case runs a
// copy of them in a temp dir whose .toolchain holds a fake age: "ciphertext"
// is a header plus base64, so a plaintext marker never appears in it, and
// FAKE_AGE_ENC / FAKE_AGE_DEC break it on purpose. Real tar unless a case puts
// a fake one first on PATH.
const FAKE_AGE = `#!/usr/bin/env bash
set -u
dec=0; out=""; in=""
while [[ $# -gt 0 ]]; do
  case "$1" in -d) dec=1 ;; -R|-i) shift ;; -o) out="$2"; shift ;; *) in="$1" ;; esac
  shift
done
src() { if [[ -n "$in" ]]; then cat "$in"; else cat; fi; }
emit() { if [[ -n "$out" ]]; then cat >"$out"; else cat; fi; }
if [[ $dec = 1 ]]; then
  data="$(src | base64)"
  plain="$(printf '%s' "$data" | base64 -d | tail -n +2)"
  [[ "$(printf '%s' "$data" | base64 -d | head -n 1)" == "FAKE-AGE" ]] || { echo "age: error: no identity matched any of the recipients" >&2; exit 1; }
  case "\${FAKE_AGE_DEC:-}" in
    truncated) printf '%s' "$plain" | base64 -d | head -c "\${FAKE_AGE_KEEP:-200}" | emit; echo "age: error: stream damaged" >&2; exit 1 ;;
  esac
  printf '%s' "$plain" | base64 -d | emit
else
  case "\${FAKE_AGE_ENC:-}" in
    fail) echo "age: error: malformed recipient" >&2; exit 1 ;;
    enospc) { echo FAKE-AGE; src | base64 | head -c 8; } | emit; echo "age: error: write: no space left on device" >&2; exit 1 ;;
    plaintext-enospc) src | head -c 64 | emit; echo "age: error: write: no space left on device" >&2; exit 1 ;;
  esac
  { echo FAKE-AGE; src | base64; } | emit
fi
`;
const FAKE_TAR = `#!/usr/bin/env bash
# Lists with the real tar; writes a plaintext file where it is told to
# extract, or some bytes when it is told to create; then fails.
[[ "$1" == "-tzf" ]] && exec "$REAL_TAR" "$@"
dir=""
while [[ $# -gt 0 ]]; do [[ "$1" == "-C" ]] && dir="$2"; shift; done
if [[ -n "$dir" && -d "$dir" && "$dir" == *.unseal.* ]]; then printf 'PLAINTEXT-MARKER-tar\\n' >"$dir/partial"; else printf 'half an archive'; fi
echo "tar: Error exit delayed from previous errors." >&2
exit 2
`;
const MARK = "PLAINTEXT-MARKER";
const REAL_TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
function operatorCopy() {
  const root = mkdtempSync(path.join(os.tmpdir(), "zold-operator-"));
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts);
  for (const f of ["_age.sh", "backup-db.sh", "secrets.sh", "with-env-fd.mjs", "env-set.mjs", "unseal-check.mjs"]) copyFileSync(new URL(`./${f}`, import.meta.url), path.join(scripts, f));
  const ageDir = path.join(root, ".toolchain", "age-v1.3.2", "age");
  mkdirSync(ageDir, { recursive: true });
  writeFileSync(path.join(ageDir, "age"), FAKE_AGE, { mode: 0o755 });
  const bin = path.join(root, "fake-bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, ".age-recipients"), "age1fakerecipient\n");
  writeFileSync(path.join(root, "identity"), "AGE-SECRET-KEY-FAKE\n");
  const run = (script: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string) =>
    spawnSync("bash", [path.join(scripts, script), ...args], {
      encoding: "utf8", input,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, REAL_TAR, AGE_IDENTITY_FILE: path.join(root, "identity"), ...env },
    });
  const fake = (name: string, body: string) => writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  /** Every file under root (bar the fake tools) that holds `text`. */
  const holding = (text: string, under = root): string[] => readdirSync(under).flatMap((f) => {
    const p = path.join(under, f);
    if (p === bin || p === path.join(root, ".toolchain")) return [];
    const st = lstatSync(p); // never through a symlink: a hostile archive may leave one pointing out
    if (st.isDirectory()) return holding(text, p);
    return st.isFile() && readFileSync(p, "utf8").includes(text) ? [p] : [];
  });
  const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  return { root, run, fake, holding, ls, done: () => rmSync(root, { recursive: true, force: true }) };
}
/** "Ciphertext" the fake age reads back as `plain`. */
const fakeSealed = (plain: Buffer) => `FAKE-AGE\n${plain.toString("base64")}\n`;
/** A gzipped ustar archive built by hand, so a case can hold any name, link or type. */
function tarball(entries: { name: string; type?: "0" | "1" | "2" | "5"; link?: string; body?: string; mode?: number }[]) {
  const blocks: Buffer[] = [];
  const field = (h: Buffer, at: number, len: number, value: string) => h.write(value.slice(0, len), at, len, "latin1");
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const h = Buffer.alloc(512);
    field(h, 0, 100, e.name);
    field(h, 100, 8, octal(e.mode ?? (e.type === "5" ? 0o755 : 0o644), 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(e.type === "0" || !e.type ? body.length : 0, 12));
    field(h, 136, 12, octal(1_700_000_000, 12));
    field(h, 148, 8, "        ");
    field(h, 156, 1, e.type ?? "0");
    field(h, 157, 100, e.link ?? "");
    field(h, 257, 8, "ustar\u000000");
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h);
    if (!e.type || e.type === "0") blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

await check("backup-db.sh writes one owner-only encrypted file into an owner-only dir, whatever the caller's umask", () => {
  const t = operatorCopy();
  try {
    const store = path.join(t.root, "data", "db.json");
    mkdirSync(path.dirname(store));
    writeFileSync(store, `{"users":[{"name":"${MARK}"}]}`);
    mkdirSync(path.join(t.root, ".local-backups"), { mode: 0o755 });
    chmodSync(path.join(t.root, ".local-backups"), 0o755);
    const r = spawnSync("bash", ["-c", `umask 000; exec bash "$0"`, path.join(t.root, "scripts", "backup-db.sh")], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: t.root },
    });
    assert.equal(r.status, 0, r.stderr);
    const files = t.ls(path.join(t.root, ".local-backups"));
    assert.equal(files.length, 1, files.join(","));
    assert.match(files[0], /^db-\d{8}T\d{6}Z\.json\.age$/);
    assert.equal(statSync(path.join(t.root, ".local-backups")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(t.root, ".local-backups", files[0])).mode & 0o777, 0o600);
    assert.deepEqual(t.holding(MARK), [store], "the plaintext is anywhere but the store");
  } finally { t.done(); }
});
await check("backup-db.sh: a failing or full-disk age leaves no backup, no .tmp and no plaintext", () => {
  for (const mode of ["fail", "enospc", "plaintext-enospc"]) {
    const t = operatorCopy();
    try {
      const store = path.join(t.root, "db.json");
      writeFileSync(store, `{"users":[{"name":"${MARK}"}]}`);
      const r = t.run("backup-db.sh", [], { TRANSF_DB_PATH: store, FAKE_AGE_ENC: mode });
      assert.notEqual(r.status, 0, `${mode}: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /wrote/, mode);
      assert.deepEqual(t.ls(path.join(t.root, ".local-backups")), [], `${mode} left a file behind`);
      assert.deepEqual(t.holding(MARK), [store], `${mode} left plaintext behind`);
    } finally { t.done(); }
  }
});
await check("backup-db.sh twice in the same second refuses the second and keeps the first", () => {
  const t = operatorCopy();
  try {
    t.fake("date", "#!/bin/sh\necho 20261126T120000Z\n");
    const store = path.join(t.root, "db.json");
    writeFileSync(store, '{"users":[{"name":"first"}]}');
    assert.equal(t.run("backup-db.sh", [], { TRANSF_DB_PATH: store }).status, 0);
    const out = path.join(t.root, ".local-backups", "db-20261126T120000Z.json.age");
    const first = readFileSync(out, "utf8");
    writeFileSync(store, '{"users":[{"name":"second"}]}');
    const r = t.run("backup-db.sh", [], { TRANSF_DB_PATH: store });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /exists/);
    assert.equal(readFileSync(out, "utf8"), first, "the first backup was replaced");
    assert.deepEqual(t.ls(path.join(t.root, ".local-backups")), ["db-20261126T120000Z.json.age"]);
  } finally { t.done(); }
});
await check("backup-db.sh: an ln failure that is not a same-second clash prints the real error, and leaves no backup or .tmp", () => {
  const t = operatorCopy();
  try {
    t.fake("ln", "#!/bin/sh\necho \"ln: $2: Operation not supported\" >&2\nexit 1\n");
    const store = path.join(t.root, "db.json");
    writeFileSync(store, '{"users":[]}');
    const r = t.run("backup-db.sh", [], { TRANSF_DB_PATH: store });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /Operation not supported/);
    assert.doesNotMatch(r.stderr, /this second|run it again/);
    assert.deepEqual(t.ls(path.join(t.root, ".local-backups")), []);
  } finally { t.done(); }
});
await check("backup-db.sh refuses with no store, no recipients or no age, and writes nothing", () => {
  const t = operatorCopy();
  try {
    assert.match(t.run("backup-db.sh", [], { TRANSF_DB_PATH: path.join(t.root, "missing.json") }).stderr, /no database/);
    writeFileSync(path.join(t.root, "db.json"), "{}");
    assert.match(t.run("backup-db.sh", [], { TRANSF_DB_PATH: path.join(t.root, "db.json"), AGE_RECIPIENTS_FILE: path.join(t.root, "none") }).stderr, /no recipients/);
    rmSync(path.join(t.root, ".toolchain"), { recursive: true });
    assert.match(t.run("backup-db.sh", [], { TRANSF_DB_PATH: path.join(t.root, "db.json") }).stderr, /age is not installed/);
    assert.deepEqual(t.ls(path.join(t.root, ".local-backups")), []);
  } finally { t.done(); }
});
await check("secrets.sh encrypt and seal: a failing age or tar leaves no .tmp, no output file and no plaintext copy", () => {
  for (const [what, env, fakeTar] of [["encrypt/enospc", { FAKE_AGE_ENC: "enospc" }, false], ["encrypt/plaintext-enospc", { FAKE_AGE_ENC: "plaintext-enospc" }, false],
    ["seal/enospc", { FAKE_AGE_ENC: "enospc" }, false], ["seal/tar fails", {}, true]] as const) {
    const t = operatorCopy();
    try {
      if (fakeTar) t.fake("tar", FAKE_TAR);
      const dotenv = path.join(t.root, "dotenv");
      writeFileSync(dotenv, `A=${MARK}\n`);
      const priv = path.join(t.root, "private");
      mkdirSync(priv);
      writeFileSync(path.join(priv, "key"), MARK);
      const r = what.startsWith("encrypt") ? t.run("secrets.sh", ["encrypt", dotenv], env) : t.run("secrets.sh", ["seal", priv], env);
      assert.notEqual(r.status, 0, `${what}: ${r.stdout}`);
      assert.deepEqual(t.ls(t.root).filter((f) => /\.age$|\.tmp/.test(f)), [], `${what} left a file behind`);
      assert.deepEqual(t.holding(MARK).sort(), [dotenv, path.join(priv, "key")].sort(), `${what} left plaintext behind`);
    } finally { t.done(); }
  }
});
await check("secrets.sh set: a re-encryption that fails on a full disk leaves the old file in place and no temp file", () => {
  const t = operatorCopy();
  try {
    const enc = path.join(t.root, "dotenv.age");
    writeFileSync(enc, fakeSealed(Buffer.from("A=one\n")));
    const before = readFileSync(enc, "utf8");
    const r = t.run("secrets.sh", ["set", "NEW_NAME"], { SECRETS_ENV_FILE: enc, FAKE_AGE_ENC: "enospc" }, "fake-value-5\n");
    assert.notEqual(r.status, 0, r.stdout);
    assert.ok(!`${r.stdout}${r.stderr}`.includes("fake-value-5"));
    assert.equal(readFileSync(enc, "utf8"), before);
    assert.deepEqual(t.ls(t.root).filter((f) => f.startsWith("dotenv")), ["dotenv.age"]);
  } finally { t.done(); }
});
await check("secrets.sh run: a file that fails to decrypt part-way never starts the command", () => {
  const t = operatorCopy();
  try {
    const enc = path.join(t.root, "dotenv.age");
    writeFileSync(enc, fakeSealed(Buffer.from(`A=one\n${"B=two\n".repeat(100)}`)));
    const r = t.run("secrets.sh", ["run", "--", "sh", "-c", "echo started"], { SECRETS_ENV_FILE: enc, FAKE_AGE_DEC: "truncated", FAKE_AGE_KEEP: "20" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /could not decrypt/);
  } finally { t.done(); }
});
await check("secrets.sh unseal: a decrypt or tar failure part-way moves nothing into place and leaves no staging dir", () => {
  for (const what of ["truncated", "tar fails"]) {
    const t = operatorCopy();
    try {
      if (what === "tar fails") t.fake("tar", FAKE_TAR);
      const sealed = path.join(t.root, "private.tar.age");
      writeFileSync(sealed, fakeSealed(tarball([
        { name: "private/", type: "5" },
        { name: "private/first", body: `${MARK}-first\n` },
        { name: "private/second", body: `${MARK}-second\n`.repeat(4000) },
      ])));
      const dest = path.join(t.root, "out", "private");
      const r = t.run("secrets.sh", ["unseal", sealed, dest], what === "truncated" ? { FAKE_AGE_DEC: "truncated", FAKE_AGE_KEEP: "700" } : {});
      assert.notEqual(r.status, 0, `${what}: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /unsealed/);
      assert.equal(existsSync(dest), false, `${what}: a failed unseal was moved into place`);
      assert.deepEqual(t.ls(path.join(t.root, "out")), [], `${what} left the staging dir`);
      assert.deepEqual(t.holding(MARK), [], `${what} left plaintext behind`);
    } finally { t.done(); }
  }
});
await check("secrets.sh unseal: a good archive lands owner-only at DEST, and an existing DEST is refused", () => {
  const t = operatorCopy();
  try {
    const sealed = path.join(t.root, "private.tar.age");
    writeFileSync(sealed, fakeSealed(tarball([{ name: "private/", type: "5" }, { name: "private/key", body: "k\n", mode: 0o644 }])));
    const dest = path.join(t.root, "out");
    const r = t.run("secrets.sh", ["unseal", sealed, dest]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(dest, "private", "key"), "utf8"), "k\n");
    assert.equal(statSync(dest).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dest, "private", "key")).mode & 0o077, 0, "an unsealed secret is group or world readable");
    const again = t.run("secrets.sh", ["unseal", sealed, dest]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /refusing: .* exists/);
    assert.deepEqual(t.ls(t.root).filter((f) => f.startsWith(".unseal")), []);
  } finally { t.done(); }
});
await check("secrets.sh unseal: links that stay inside the tree, through other links or dangling, are kept", () => {
  const t = operatorCopy();
  try {
    const sealed = path.join(t.root, "private.tar.age");
    writeFileSync(sealed, fakeSealed(tarball([{ name: "private/", type: "5" }, { name: "private/key", body: "k\n" }, { name: "private/sub/", type: "5" },
      { name: "private/current", type: "2", link: "key" }, { name: "private/sub/up", type: "2", link: "../current" },
      { name: "private/sub/self", type: "2", link: "." }, { name: "private/via", type: "2", link: "sub/self/../key" },
      { name: "private/later", type: "2", link: "not-yet" }])));
    const dest = path.join(t.root, "out");
    const r = t.run("secrets.sh", ["unseal", sealed, dest]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(dest, "private", "via"), "utf8"), "k\n");
    assert.equal(readFileSync(path.join(dest, "private", "sub", "up"), "utf8"), "k\n");
  } finally { t.done(); }
});
await check("secrets.sh seal refuses a tree unseal would refuse (an absolute link, a link out, a link chain out) and writes no archive", () => {
  for (const [what, make] of [
    ["absolute link to a file inside", (priv: string) => symlinkSync(path.join(priv, "key"), path.join(priv, "current"))],
    ["../ link out", (priv: string) => symlinkSync("../..", path.join(priv, "up"))],
    ["chain out", (priv: string) => { symlinkSync(".", path.join(priv, "x")); symlinkSync("x/..", path.join(priv, "d")); }],
    ["a fifo", (priv: string) => spawnSync("mkfifo", [path.join(priv, "pipe")])],
  ] as [string, (priv: string) => void][]) {
    const t = operatorCopy();
    try {
      const priv = path.join(t.root, "private");
      mkdirSync(priv);
      writeFileSync(path.join(priv, "key"), MARK);
      make(priv);
      const r = t.run("secrets.sh", ["seal", priv]);
      assert.notEqual(r.status, 0, `${what}: sealed (${r.stdout.trim()})`);
      assert.match(r.stderr, /refusing to seal/, what);
      assert.deepEqual(t.ls(t.root).filter((f) => /\.age$|\.tmp/.test(f)), [], `${what}: wrote an archive`);
    } finally { t.done(); }
  }
});
await check("secrets.sh seal accepts what unseal accepts: a link back in through the sealed dir's own name round-trips", () => {
  const t = operatorCopy();
  try {
    const priv = path.join(t.root, "private");
    mkdirSync(path.join(priv, "sub"), { recursive: true });
    writeFileSync(path.join(priv, "key"), "k\n");
    symlinkSync("../private/key", path.join(priv, "current"));
    symlinkSync("../../private/current", path.join(priv, "sub", "up"));
    const r = t.run("secrets.sh", ["seal", priv]);
    assert.equal(r.status, 0, r.stderr);
    const dest = path.join(t.root, "out");
    const u = t.run("secrets.sh", ["unseal", `${priv}.tar.age`, dest]);
    assert.equal(u.status, 0, u.stderr);
    assert.equal(readFileSync(path.join(dest, "private", "current"), "utf8"), "k\n");
    assert.equal(readFileSync(path.join(dest, "private", "sub", "up"), "utf8"), "k\n");
  } finally { t.done(); }
});
await check("secrets.sh seal refuses a link to a sibling of the sealed dir, a symlinked dir and a hardlinked file, and writes no archive", () => {
  for (const [what, make] of [
    ["link to a sibling the archive does not hold", (priv: string) => { writeFileSync(path.join(path.dirname(priv), "other"), MARK); symlinkSync("../other", path.join(priv, "o")); }],
    ["link hopping through a sibling and back", (priv: string) => { mkdirSync(path.join(path.dirname(priv), "other")); symlinkSync("../other/../private/key", path.join(priv, "h")); }],
    ["link hopping through a sibling the tree does not hold", (priv: string) => symlinkSync("../gone/../private/key", path.join(priv, "g"))],
    ["link through a sibling link", (priv: string) => { symlinkSync("private", path.join(path.dirname(priv), "alias")); symlinkSync("../alias/key", path.join(priv, "a")); }],
    ["the sealed dir is a symlink", (priv: string) => { renameSync(priv, `${priv}.real`); symlinkSync(`${priv}.real`, priv); }],
    ["a hardlinked file", (priv: string) => linkSync(path.join(priv, "key"), path.join(priv, "key2"))],
    ["a file hardlinked from outside", (priv: string) => linkSync(path.join(priv, "key"), path.join(path.dirname(priv), "copy"))],
  ] as [string, (priv: string) => void][]) {
    const t = operatorCopy();
    try {
      const priv = path.join(t.root, "private");
      mkdirSync(priv);
      writeFileSync(path.join(priv, "key"), MARK);
      make(priv);
      const r = t.run("secrets.sh", ["seal", priv]);
      assert.notEqual(r.status, 0, `${what}: sealed (${r.stdout.trim()})`);
      assert.match(r.stderr, /refusing to seal/, what);
      assert.deepEqual(t.ls(t.root).filter((f) => /\.age$|\.tmp/.test(f)), [], `${what}: wrote an archive`);
    } finally { t.done(); }
  }
});
await check("secrets.sh unseal refuses an archive whose files are hardlinked to each other inside the tree", () => {
  const t = operatorCopy();
  try {
    const sealed = path.join(t.root, "private.tar.age");
    writeFileSync(sealed, fakeSealed(tarball([{ name: "private/", type: "5" }, { name: "private/key", body: "k\n" },
      { name: "private/key2", type: "1", link: "private/key" }])));
    const dest = path.join(t.root, "work", "dest");
    const r = t.run("secrets.sh", ["unseal", sealed, dest]);
    assert.notEqual(r.status, 0, `unsealed (${r.stdout.trim()})`);
    assert.match(r.stderr, /refusing to unseal: private\/key.* hard link/);
    assert.equal(existsSync(dest), false, "moved into place");
    assert.deepEqual(t.ls(path.join(t.root, "work")), [], "left the staging dir");
  } finally { t.done(); }
});
await check("secrets.sh unseal of a hostile archive (absolute, ../, symlink, hardlink entries) writes nothing outside and moves nothing into place", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "zold-unseal-outside-"));
  try {
    const victim = path.join(outside, "victim");
    for (const [what, entries] of [
      ["absolute", [{ name: `${outside}/abs` }]],
      ["../", [{ name: "private/" , type: "5" }, { name: "private/../../escape" }]],
      ["symlink out, then a file through it", [{ name: "link", type: "2", link: outside }, { name: "link/through" }]],
      ["symlink out, left in place", [{ name: "private/", type: "5" }, { name: "private/env", type: "2", link: victim }]],
      ["symlink with ../ target", [{ name: "private/", type: "5" }, { name: "private/up", type: "2", link: "../../../" }]],
      ["symlink chain: x -> . and d -> x/.. (lexically inside, on disk the parent)", [{ name: "x", type: "2", link: "." }, { name: "d", type: "2", link: "x/.." }]],
      ["symlink chain two levels up: x -> . and f -> x/x/../..", [{ name: "x", type: "2", link: "." }, { name: "f", type: "2", link: "x/x/../.." }]],
      ["symlink chain through a nested link: private/s -> .. and private/u -> s/..", [{ name: "private/", type: "5" }, { name: "private/s", type: "2", link: ".." }, { name: "private/u", type: "2", link: "s/.." }]],
      ["hardlink to an outside file, then a write to it", [{ name: "hl", type: "1", link: victim }, { name: "hl", body: "overwritten" }]],
      ["hardlink with ../ target", [{ name: "private/", type: "5" }, { name: "private/hl", type: "1", link: `private/../../${path.relative(os.tmpdir(), victim)}` }]],
    ] as [string, Parameters<typeof tarball>[0]][]) {
      writeFileSync(victim, "untouched");
      const t = operatorCopy();
      try {
        const sealed = path.join(t.root, "private.tar.age");
        writeFileSync(sealed, fakeSealed(tarball(entries.map((e) => ({ body: `${MARK}\n`, ...e })))));
        const dest = path.join(t.root, "work", "dest");
        const r = t.run("secrets.sh", ["unseal", sealed, dest]);
        assert.notEqual(r.status, 0, `${what}: unsealed (${r.stdout.trim()})`);
        assert.equal(existsSync(dest), false, `${what}: moved into place`);
        assert.deepEqual(t.ls(path.join(t.root, "work")), [], `${what}: left the staging dir`);
        assert.deepEqual(readdirSync(outside).sort(), ["victim"], `${what}: wrote outside`);
        assert.equal(readFileSync(victim, "utf8"), "untouched", `${what}: changed a file outside`);
        assert.deepEqual(t.ls(t.root).filter((f) => !["scripts", ".toolchain", "fake-bin", ".age-recipients", "identity", "private.tar.age", "work"].includes(f)), [], `${what}: wrote beside the staging dir`);
      } finally { t.done(); }
    }
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

console.log("log lines");
await check("a URL in a log line keeps scheme and host only: keys in the path or query never print", async () => {
  const { urlForLog } = await import("../services/api/src/http/log-safe.js");
  const key = "fake-key-" + "x".repeat(23);
  assert.equal(urlForLog(`https://api.candide.dev/api/v3/84532/${key}`), "https://api.candide.dev");
  assert.equal(urlForLog(`https://rpc.example/v1?apikey=${key}`), "https://rpc.example");
  assert.equal(urlForLog(`https://user:${key}@host.example/x`), "https://host.example");
  assert.equal(urlForLog(undefined), "(unset)");
  assert.ok(!urlForLog(`not a url ${key}`).includes(key));
});
await check("no startup or request log interpolates a raw URL or an email", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const src = new URL("../services/api/src/", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(src, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(f, src), "utf8");
    // Whole calls, so a template literal spread over several lines is read too.
    for (const call of text.matchAll(/console\.(?:log|warn|error|info)\(([\s\S]*?)\);/g)) {
      const body = call[1];
      if (/\$\{(?![^}]*urlForLog)[^}]*(Url|URL|\.url)\b[^}]*\}/.test(body) || /\$\{[^}]*\bemail\b[^}]*\}/.test(body)) {
        offenders.push(`${f}:${text.slice(0, call.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The API's source, or the operator scripts' (not their suites or the shared
// harness modules, which only ever talk to local stubs).
async function sourceFiles(dir: "api" | "scripts"): Promise<{ file: string; text: string }[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = new URL(dir === "api" ? "../services/api/src/" : "./", import.meta.url);
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => dir === "api" || (!f.endsWith("-test.ts") && !f.split("/").pop()!.startsWith("_")))
    .map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8") }));
}
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const RAW_URL = /\$\{(?![^}]*urlForLog)[^}]*(Url|URL|\.url)\b[^}]*\}/;
// A whole console call or Error construction: up to the `);` that ends its
// line, so an arrow body or a nested call inside it does not cut it short.
const CONSOLE_CALL = /console\.(?:log|warn|error|info|debug)\(([\s\S]*?)\);\s*$/gm;
const ERROR_TEMPLATE = /new \w*Error\(\s*`([^`]*)`/g;
// Names an error goes by in a catch or callback.
const ERR = String.raw`(?:e|err|error|cause|e2|err2|error2|ex)`;
// Reading an error's text without a log-cause helper: a `?.message ??`
// fallback (the shape of an untyped catch), a cast's `.message`, the error
// interpolated whole, or the error object handed to console as an argument.
const RAW_ERROR_TEXT = [
  new RegExp(String.raw`\b${ERR}\b\)?\??\.message\s*\?\?`, "g"),
  new RegExp(String.raw`\(\s*${ERR}\s+as\s+\w+\s*\)\??\.message\b`, "g"),
  new RegExp(String.raw`\$\{\s*${ERR}\s*\}`, "g"),
  new RegExp(String.raw`String\(\s*${ERR}\s*\)`, "g"),
];
const HELPER_BEFORE = /\b(?:redactedMessage|describeCause|describeError|errorText)\([^)]*$/;

await check("an error's message is redacted before it is logged, stored or returned: a keyed RPC or bundler URL in it never survives", async () => {
  const { redactedMessage } = await import("../services/api/src/http/log-cause.js");
  const key = "fake-key-" + "x".repeat(23);
  const viemLike = Object.assign(new Error(`HTTP request failed.\n\nURL: https://base-sepolia.example/v2/${key}\nRequest body: {}`), {
    shortMessage: `HTTP request failed at https://base-sepolia.example/v2/${key}`,
  });
  const fetchLike = new Error(`request to https://api.candide.dev/paymaster/v3/84532/${key} failed, reason: getaddrinfo ENOTFOUND api.candide.dev`);
  for (const err of [viemLike, fetchLike, new Error("connect ECONNREFUSED 10.0.0.7:8545")]) {
    const out = redactedMessage(err);
    assert.ok(!out.includes(key), out);
    assert.ok(!/https?:\/\/|10\.0\.0\.7|candide\.dev/.test(out), out);
  }
  assert.equal(redactedMessage(viemLike), "HTTP request failed at <url>", "shortMessage first, one line, no error name");
  assert.equal(redactedMessage(new Error("amount exceeds balance")), "amount exceeds balance", "a plain message keeps its words");
  assert.equal(redactedMessage("refused"), "refused");
  assert.equal(redactedMessage(new Error("counterpart.identifier.iban is invalid")), "counterpart.identifier.iban is invalid", "a field path is not a host");
  assert.equal(
    redactedMessage(new Error("webauthn: origin https://evil.example not allowed"), { keepHosts: true }),
    "webauthn: origin https://evil.example not allowed",
    "keepHosts names the origin",
  );
  assert.equal(redactedMessage(viemLike, { keepHosts: true }), "HTTP request failed at https://base-sepolia.example", "keepHosts still drops the keyed path");
  assert.equal(redactedMessage(undefined), "unknown error");
});
await check("an error's text reaches a log line, a row or a response only through a log-cause helper", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("api")) {
    if (file.endsWith("log-cause.ts")) continue;
    for (const re of RAW_ERROR_TEXT) {
      for (const m of text.matchAll(re)) {
        const lineStart = text.lastIndexOf("\n", m.index!) + 1;
        if (HELPER_BEFORE.test(text.slice(lineStart, m.index!))) continue;
        offenders.push(`${file}:${lineOf(text, m.index!)}`);
      }
    }
    for (const call of text.matchAll(CONSOLE_CALL)) {
      if (new RegExp(String.raw`(^|,)\s*${ERR}\s*,?\s*$`).test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});
await check("no thrown error names a raw URL: a boot error is printed, so a keyed RPC URL in it reaches the log", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("api")) {
    for (const call of text.matchAll(ERROR_TEMPLATE)) {
      if (RAW_URL.test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
await check("operator scripts print a configured URL by its origin only", async () => {
  const offenders: string[] = [];
  for (const { file, text } of await sourceFiles("scripts")) {
    for (const call of text.matchAll(CONSOLE_CALL)) {
      if (RAW_URL.test(call[1])) offenders.push(`${file}:${lineOf(text, call.index!)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

await check("capabilities.moneriumOAuth is false without a data encryption key: connect/start would refuse it", async () => {
  const caps = new URL("../services/api/src/capabilities.ts", import.meta.url).href;
  const oauthWith = (key: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MONERIUM_OAUTH_CLIENT_ID: "client-test" };
    delete env.MONERIUM_OAUTH;
    delete env.DATA_ENCRYPTION_KEYS;
    if (key) env.DATA_ENCRYPTION_KEYS = key;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const { capabilities } = await import(${JSON.stringify(caps)}); process.stdout.write(String((await capabilities()).moneriumOAuth));`],
      { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(oauthWith(undefined), "false");
  assert.equal(oauthWith(`k1:${randomBytes(32).toString("base64")}`), "true");
});

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nsecurity hardening: all checks passed");
