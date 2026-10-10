/**
 * The operator path: Cloudflare Access, passkey enrolment and sign-in, a
 * fresh approval for every change, the read-only shared token, and an audit
 * row naming the operator.
 *
 * Offline: in-process express with Access configured against a local stub
 * that serves its signing keys, a throwaway db, and a software passkey.
 *
 *   npm run operator:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";

const dataDir = mkdtempSync(path.join(tmpdir(), "zold-operator-"));
process.env.TRANSF_DB_PATH = path.join(dataDir, "db.json");
const TOKEN = "operator-token-for-operator-auth-test-0123";
process.env.KYC_OPERATOR_TOKEN = TOKEN;
const ADMIN = "http://admin.test";
process.env.ADMIN_ORIGIN = ADMIN;
const TEAM = "zold-test.cloudflareaccess.com";
const AUD = "aud-tag-for-the-admin-application";
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
process.env.CF_ACCESS_AUD = AUD;

// Access's signing keys, served the way Cloudflare serves them.
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;
const pair = await webcrypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
const KID = "kid-1";
const certs = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [{ kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }));
});
await new Promise<void>((r) => certs.listen(0, "127.0.0.1", r));
process.env.CF_ACCESS_CERTS_URL = `http://127.0.0.1:${(certs.address() as AddressInfo).port}/cdn-cgi/access/certs`;

const OWNER = "owner@example.com";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function accessJwt(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: opts.kid ?? KID, typ: "JWT" });
  const body = b64({ iss: `https://${TEAM}`, aud: [AUD], email: OWNER, iat: now, exp: now + 600, ...claims });
  const sig = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? pair.privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}
const goodJwt = await accessJwt();
const secondJwt = await accessJwt({ email: "second@example.com" });

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { createOperatorGate } = await import("../services/api/src/operators/gate.js");
const { createOperatorAuthRouter } = await import("../services/api/src/routes/operator-auth.js");
const { createAdminRouter } = await import("../services/api/src/routes/admin.js");
const { operatorLabel, requireOperator } = await import("../services/api/src/http/guards.js");
const { issueSession, requireUserSession } = await import("../services/api/src/http/sessions.js");
const { ENROLMENT_FILE } = await import("../services/api/src/operators/enrolment.js");
const { SoftPasskey, operatorKit, writeEnrolment } = await import("./_operator.js");

initStore();
const app = express();
app.use(express.json());
app.use("/api/admin", createOperatorGate());
app.use("/api", createOperatorAuthRouter());
app.post("/api/admin/test/echo", (req, res) => {
  if (!requireOperator(req, res)) return;
  res.json({ by: operatorLabel(req), body: req.body });
});
app.use("/api", createAdminRouter());
app.get("/api/users/:id/probe", (req, res) => {
  if (!requireUserSession(req, res, req.params.id)) return;
  res.json({ ok: true });
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": goodJwt, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}
const stepUpHeader = (a: unknown) => ({ "x-operator-step-up": Buffer.from(JSON.stringify(a)).toString("base64url") });

console.log("cloudflare access");
await check("without an Access token nothing under /api/admin answers, the ceremonies included", async () => {
  for (const [m, p] of [["GET", "/api/admin/users"], ["POST", "/api/admin/auth/login/challenge"], ["POST", "/api/admin/auth/enrol/challenge"]]) {
    const r = await req(m, p, m === "POST" ? {} : undefined, { "cf-access-jwt-assertion": "" });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.body.code, "ACCESS_REQUIRED");
  }
});
await check("the email header alone is not an identity", async () => {
  const r = await req("GET", "/api/admin/users", undefined, { "cf-access-jwt-assertion": "", "cf-access-authenticated-user-email": OWNER, authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 401);
});
await check("a token for another application, another team, expired, unsigned or naming no person is refused", async () => {
  const other = await webcrypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const bad = [
    await accessJwt({ aud: ["another-application"] }),
    await accessJwt({ iss: "https://another-team.cloudflareaccess.com" }),
    await accessJwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
    await accessJwt({ email: undefined, common_name: "service-token-id" }),
    await accessJwt({}, { key: other.privateKey }),
    await accessJwt({}, { kid: "unknown-kid" }),
    goodJwt.split(".").slice(0, 2).join(".") + ".",
    "not-a-jwt",
  ];
  for (const jwt of bad) {
    const r = await req("GET", "/api/admin/users", undefined, { "cf-access-jwt-assertion": jwt, authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 401, jwt.slice(0, 40));
  }
});

console.log("the shared operator token");
await check("reads still work with it, behind Access", async () => {
  const r = await req("GET", "/api/admin/users", undefined, { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
await check("it makes no change, whatever the spelling of the path", async () => {
  for (const p of ["/api/admin/test/echo", "/api/ADMIN/test/echo", "/api/admin/test/echo/"]) {
    const r = await req("POST", p, { x: 1 }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 403, p);
    assert.equal(r.body.code, "OPERATOR_TOKEN_READ_ONLY");
  }
});
await check("it asks no partner: a live Monerium read needs a passkey session", async () => {
  const r = await req("GET", "/api/admin/monerium?live=1", undefined, { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 403);
});
await check("each read with it is audited as the legacy token", async () => {
  assert.ok(store.auditFor(undefined, 50).some((e) => e.kind === "operator.request" && e.data.operator === "operator:legacy-token"));
});

console.log("enrolment");
await check("no open enrolment, a wrong token or an expired one opens nothing", async () => {
  assert.equal((await req("POST", "/api/admin/auth/enrol/challenge", { token: "nothing-open" })).status, 403);
  writeEnrolment(dataDir, "Owner", OWNER);
  assert.equal((await req("POST", "/api/admin/auth/enrol/challenge", { token: "not-the-open-one" })).status, 403);
  const expired = writeEnrolment(dataDir, "Owner", OWNER, -1000);
  assert.equal((await req("POST", "/api/admin/auth/enrol/challenge", { token: expired })).status, 403);
});
await check("the Access identity must be the person being enrolled", async () => {
  const token = writeEnrolment(dataDir, "Owner", OWNER);
  const r = await req("POST", "/api/admin/auth/enrol/challenge", { token }, { "cf-access-jwt-assertion": secondJwt });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "ACCESS_MISMATCH");
});
await check("a registration from the user app's origin is refused, and the link stays open", async () => {
  const token = writeEnrolment(dataDir, "Owner", OWNER);
  const options = await req("POST", "/api/admin/auth/enrol/challenge", { token });
  const pk = await SoftPasskey.create();
  const r = await req("POST", "/api/admin/auth/enrol", { token, ...pk.attest(options.body.challenge, "http://localhost:3000", "localhost") });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(existsSync(ENROLMENT_FILE));
});

const kit = await operatorKit({ base: BASE, origin: ADMIN, rpId: "localhost", dataDir, name: "Owner", email: OWNER, accessJwt: () => goodJwt });
await check("a good enrolment creates the operator, opens a session, and uses the link up", async () => {
  assert.match(kit.sessionToken, /^zop_/);
  assert.equal(kit.operator.email, OWNER);
  assert.ok(!existsSync(ENROLMENT_FILE), "the enrolment file is deleted");
  assert.ok(store.auditFor(undefined, 50).some((e) => e.kind === "operator.enrolled" && e.data.operator === `operator:${kit.operator.id}`));
  const me = await req("GET", "/api/admin/auth/me", undefined, kit.headers());
  assert.equal(me.body.operator.passkeys.length, 1);
});

console.log("sessions");
await check("a user session is not an operator session, and an operator session is not a user's", async () => {
  const user = { id: "u_plain", name: "Plain", email: "plain@example.com", country: "DE", kycStatus: "approved", iban: "", address: `0x${"1".repeat(40)}`, createdAt: new Date().toISOString() };
  store.addUser(user as any);
  const userToken = issueSession(user.id);
  assert.equal((await req("GET", "/api/admin/users", undefined, { authorization: `Bearer ${userToken}` })).status, 401);
  assert.equal((await req("GET", `/api/users/${user.id}/probe`, undefined, { authorization: `Bearer ${kit.sessionToken}` })).status, 401);
});
await check("an operator session behind someone else's Access login is refused", async () => {
  const r = await req("GET", "/api/admin/users", undefined, { ...kit.headers(), "cf-access-jwt-assertion": secondJwt });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "ACCESS_MISMATCH");
});

console.log("a fresh approval for every change");
await check("a change without an approval is refused", async () => {
  const r = await req("POST", "/api/admin/test/echo", { x: 1 }, kit.headers());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "STEP_UP_REQUIRED");
});
await check("an approved change goes through, and its audit row names the operator", async () => {
  const r = await kit.call("POST", "/api/admin/test/echo", { x: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.by, `operator:${kit.operator.id}`);
  const row = store.auditFor(undefined, 50).find((e) => e.kind === "operator.request" && e.data.method === "POST" && e.data.status === 200);
  assert.equal(row?.data.operatorName, "Owner");
});
await check("an approval for other values or another path is refused, and none is good twice", async () => {
  const forOne = await kit.stepUp("POST", "/api/admin/test/echo", { x: 1 });
  assert.equal((await req("POST", "/api/admin/test/echo", { x: 2 }, kit.headers(forOne))).status, 403, "other values");
  const forPath = await kit.stepUp("POST", "/api/admin/test/echo", { x: 1 });
  assert.equal((await req("POST", "/api/admin/orgs/org_x/plan", { x: 1 }, kit.headers(forPath))).status, 403, "another path");
  const good = await kit.stepUp("POST", "/api/admin/test/echo", { x: 3 });
  assert.equal((await req("POST", "/api/admin/test/echo", { x: 3 }, kit.headers(good))).status, 200);
  assert.equal((await req("POST", "/api/admin/test/echo", { x: 3 }, kit.headers(good))).status, 403, "replayed");
});
await check("no spelling of a path escapes the approval, and case is part of it", async () => {
  assert.equal((await req("POST", "/api/Admin/Test/Echo/", { x: 1 }, kit.headers())).status, 403, "unapproved under any spelling");
  const lower = await kit.stepUp("POST", "/api/admin/test/echo", { x: 4 });
  assert.equal((await req("POST", "/api/admin/TEST/echo", { x: 4 }, kit.headers(lower))).status, 403, "another case is another path");
  const slash = await kit.stepUp("POST", "/api/admin/test/echo", { x: 4 });
  assert.equal((await req("POST", "/api/admin/test/echo/", { x: 4 }, kit.headers(slash))).status, 200, "a trailing slash is the same path");
});
await check("a change carries no query string: it would ride outside the approval", async () => {
  const approved = await kit.stepUp("POST", "/api/admin/test/echo", { x: 7 });
  const r = await req("POST", "/api/admin/test/echo?revoke=1", { x: 7 }, kit.headers(approved));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "QUERY_ON_CHANGE");
});
await check("an approval from the user app's origin, or without user verification, is refused", async () => {
  const c = await req("POST", "/api/admin/auth/step-up/challenge", { method: "POST", path: "/api/admin/test/echo", body: { x: 5 } }, kit.headers());
  const a = await kit.passkey.assert(c.body.challenge, "http://localhost:3000", "localhost");
  assert.equal((await req("POST", "/api/admin/test/echo", { x: 5 }, kit.headers(stepUpHeader(a)))).status, 403);
  kit.passkey.flags = 0x01;
  try {
    const h = await kit.stepUp("POST", "/api/admin/test/echo", { x: 6 });
    assert.equal((await req("POST", "/api/admin/test/echo", { x: 6 }, kit.headers(h))).status, 403);
  } finally {
    kit.passkey.flags = 0x05;
  }
});
await check("a second passkey is added only with a fresh approval from the first", async () => {
  const backup = await SoftPasskey.create();
  const options = await req("POST", "/api/admin/auth/passkeys/challenge", {}, kit.headers());
  const body = { label: "Backup key", ...backup.attest(options.body.challenge, ADMIN, "localhost") };
  assert.equal((await req("POST", "/api/admin/auth/passkeys", body, kit.headers())).status, 403, "no approval");
  const r = await req("POST", "/api/admin/auth/passkeys", body, kit.headers(await kit.stepUp("POST", "/api/admin/auth/passkeys", body)));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.operator.passkeys.map((p: any) => p.label), ["Soft key", "Backup key"]);
});

await check("a refused approval is audited; ten end that session and no other", async () => {
  const c = await req("POST", "/api/admin/auth/login/challenge", {});
  const { sessionToken } = (await req("POST", "/api/admin/auth/login", await kit.passkey.assert(c.body.challenge, ADMIN, "localhost"))).body;
  const h = { authorization: `Bearer ${sessionToken}` };
  for (let i = 0; i < 9; i++) assert.equal((await req("POST", "/api/admin/test/echo", { i }, h)).status, 403);
  const tenth = await req("POST", "/api/admin/test/echo", { i: 9 }, h);
  assert.equal(tenth.status, 401, "the tenth ends the session");
  assert.equal((await req("GET", "/api/admin/users", undefined, h)).status, 401);
  assert.equal((await kit.call("POST", "/api/admin/test/echo", { x: 8 })).status, 200, "the operator's other session still works");
  const rows = store.auditFor(undefined, 200).filter((e) => e.kind === "operator.step_up_refused" && e.data.operator === `operator:${kit.operator.id}`);
  assert.ok(rows.length >= 10 && rows.some((e) => e.data.sessionRevoked === true));
  assert.ok(rows.every((e) => !JSON.stringify(e).includes("x-operator-step-up")), "no header in the row");
});

console.log("the admin host");
await check("serves the dashboard and nothing of the user app", async () => {
  const { adminHostPolicy, originPolicy } = await import("../services/api/src/http/policy.js");
  const run = (mw: any, reqLike: any) => new Promise<number>((resolve) => {
    const res: any = { statusCode: 200, setHeader() {}, status(c: number) { this.statusCode = c; return this; }, type() { return this; }, send() { resolve(this.statusCode); }, json() { resolve(this.statusCode); }, end() { resolve(this.statusCode); } };
    mw({ method: "GET", headers: {}, header(n: string) { return this.headers[n.toLowerCase()]; }, get(n: string) { return this.headers[n.toLowerCase()]; }, ...reqLike }, res, () => resolve(0));
  });
  const onAdmin = (p: string) => run(adminHostPolicy, { path: p, headers: { host: "admin.test" } });
  for (const p of ["/admin", "/admin/users", "/admin/core.js", "/admin.css", "/api/admin/users", "/tokens.css", "/vendor/fonts/text.css"]) assert.equal(await onAdmin(p), 0, p);
  for (const p of ["/app", "/business", "/pay/x/y", "/app/main.js", "/api/users/u1", "/"]) assert.equal(await onAdmin(p), 404, p);
  assert.equal(await run(adminHostPolicy, { path: "/app", headers: { host: "localhost:3000" } }), 0, "the user host is untouched");
  const fromAdmin = (method: string, p: string) => run(originPolicy, { method, path: p, headers: { origin: ADMIN } });
  assert.equal(await fromAdmin("POST", "/api/users/u1/email/code"), 403, "the admin origin is foreign to the user API");
  assert.equal(await fromAdmin("POST", "/api/admin/test/echo"), 0);
});

console.log("sign-in");
await check("the passkey signs in on the admin origin and nowhere else; a stranger's passkey never does", async () => {
  const c1 = await req("POST", "/api/admin/auth/login/challenge", {});
  assert.equal(c1.body.allowCredentials.length, 2, "the signed-in person's two passkeys are offered");
  const wrongOrigin = await kit.passkey.assert(c1.body.challenge, "http://localhost:3000", "localhost");
  assert.equal((await req("POST", "/api/admin/auth/login", wrongOrigin)).status, 401);
  const stranger = await SoftPasskey.create();
  const c2 = await req("POST", "/api/admin/auth/login/challenge", {});
  assert.equal((await req("POST", "/api/admin/auth/login", await stranger.assert(c2.body.challenge, ADMIN, "localhost"))).status, 401);
  const c3 = await req("POST", "/api/admin/auth/login/challenge", {});
  const ok = await req("POST", "/api/admin/auth/login", await kit.passkey.assert(c3.body.challenge, ADMIN, "localhost"));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.sessionToken, /^zop_/);
});
await check("logging out ends the session", async () => {
  const c = await req("POST", "/api/admin/auth/login/challenge", {});
  const { sessionToken } = (await req("POST", "/api/admin/auth/login", await kit.passkey.assert(c.body.challenge, ADMIN, "localhost"))).body;
  const h = { authorization: `Bearer ${sessionToken}` };
  assert.equal((await req("POST", "/api/admin/auth/logout", {}, h)).status, 200);
  assert.equal((await req("GET", "/api/admin/users", undefined, h)).status, 401);
});
await check("a disabled operator's session and passkey stop working", async () => {
  const other = await operatorKit({ base: BASE, origin: ADMIN, rpId: "localhost", dataDir, name: "Second", email: "second@example.com", accessJwt: () => secondJwt });
  store.disableOperator(other.operator.id);
  const access = { "cf-access-jwt-assertion": secondJwt };
  assert.equal((await req("GET", "/api/admin/users", undefined, other.headers())).status, 401);
  const c = await req("POST", "/api/admin/auth/login/challenge", {}, access);
  assert.equal((await req("POST", "/api/admin/auth/login", await other.passkey.assert(c.body.challenge, ADMIN, "localhost"), access)).status, 401);
});

console.log("where the gate sits");
await check("server.ts mounts the gate ahead of every router that declares an admin route", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../services/api/src/server.ts", import.meta.url), "utf8");
  const gate = src.indexOf('app.use("/api/admin", createOperatorGate())');
  assert.ok(gate > 0, "the gate is mounted");
  for (const r of ["createAdminRouter(", "createCandideRecoveryRouter(", "createZoldenburgRecoveryRouter(", "createCheckoutServiceRouter(", "createOperatorAuthRouter("]) {
    const at = src.indexOf(`app.use("/api", ${r}`);
    assert.ok(at > gate, `${r} is mounted after the gate`);
  }
});

server.close();
certs.close();
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\noperator auth: all checks passed");
