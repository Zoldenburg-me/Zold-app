/**
 * The operator dashboard's read routes.
 *
 * - every route answers only to the operator token, never a user session;
 * - no Monerium token, secret or ciphertext reaches the JSON;
 * - the live Monerium read uses the account's OWN connection, refuses an
 *   account without a stored token or keys (the app client would answer with
 *   every app account's data), stores nothing and is audited;
 * - the issues feed and onboarding stages say where an account is stuck.
 *
 * Offline: in-process express, a throwaway db, and Monerium answered by a
 * fetch stub.
 *
 *   npm run admin:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-admin-")), "db.json");
const OPERATOR = "operator-token-for-admin-test-0123456789";
process.env.KYC_OPERATOR_TOKEN = OPERATOR;
// No real partner credentials in a test, and a key so a token can be stored.
for (const k of ["MONERIUM_CLIENT_ID", "MONERIUM_CLIENT_SECRET", "MONERIUM_OAUTH_CLIENT_ID"]) process.env[k] = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "admin-test-encryption-key-0123456789abcdef";

const { initStore, store } = await import("../services/api/src/store.js");
const { createAdminRouter } = await import("../services/api/src/routes/admin.js");
const { encryptToken } = await import("../services/api/src/adapters/monerium-connection.js");
const { MONERIUM } = await import("../services/api/src/config.js");

initStore();
const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const safe = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const pk = { x: "1", y: "2" };

// Connected, IBAN active, Zoldenburg guardian on chain.
store.addUser({
  id: "u_live", name: "Live", email: "live@example.com", country: "DE", kycStatus: "approved", iban: "DE89370400440532013000",
  address: safe("a"), createdAt: now, passkey: { credentialId: "c1", rpId: "localhost", createdAt: now } as any,
  passkeySafe: { address: safe("a"), status: "active", threshold: 1, passkeyPublicKey: pk,
    recoveryChoice: { choice: "zoldenburg", at: now }, recovery: { moduleAddress: safe("9"), guardianAddress: safe("8"), threshold: 1, status: "active" } },
  monerium: { connectedAt: now, method: "oauth", profileId: "prof-live", accessTokenEnc: encryptToken("user-oauth-token"),
    refreshTokenEnc: encryptToken("user-refresh-token"), profiles: [{ id: "prof-live", kind: "personal", state: "approved" }] },
} as any);
// Names a method but holds no token: a live read must refuse, not fall back.
store.addUser({
  id: "u_hollow", name: "Hollow", email: "hollow@example.com", country: "DE", kycStatus: "pending", iban: "",
  address: safe("b"), createdAt: now, passkeySafe: { address: safe("b"), status: "active", threshold: 1, passkeyPublicKey: pk },
  monerium: { connectedAt: now, method: "oauth", profileId: "prof-hollow" },
  moneriumRefusal: { code: "NO_CORPORATE_PROFILE", error: "no company profile", at: now },
} as any);
store.addTransfer({
  id: "t_fail", userId: "u_live", quoteId: "q", rail: "sepa", state: "FAILED", sendEur: 10, receiveEur: 10, txs: [],
  error: "redeem refused", createdAt: hourAgo, updatedAt: hourAgo,
} as any);

// Monerium answers through this stub; anything else goes to the real fetch.
const realFetch = globalThis.fetch;
const moneriumCalls: { url: string; auth: string | null }[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(MONERIUM.baseUrl)) return realFetch(input, init);
  const auth = new Headers(init?.headers).get("authorization");
  moneriumCalls.push({ url, auth });
  const p = new URL(url).pathname;
  const body =
    p === "/auth/context" ? { userId: "m-user", email: "live@example.com" }
    : p === "/profiles" ? { profiles: [{ id: "prof-live", kind: "personal", name: "Live", state: "approved" }] }
    : p === "/profiles/prof-live" ? { id: "prof-live", kind: "personal", state: "approved" }
    : p === "/ibans" ? { ibans: [{ iban: "DE89370400440532013000", bic: "MONEDEB1", profile: "prof-live", address: safe("a"), chain: "base" }] }
    : p === "/addresses" ? { addresses: [{ address: safe("a"), profile: "prof-live", chains: ["base"] }] }
    : p === "/orders" ? { orders: [{ id: "o1", kind: "issue", amount: "5", currency: "eur", state: "processed" }] }
    : null;
  return new Response(JSON.stringify(body ?? { message: "not stubbed" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const app = express();
app.use(express.json());
app.use("/api", createAdminRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const get = async (p: string, token: string | null = OPERATOR) => {
  const res = await realFetch(`${API}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, text: await res.text() };
};

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`FAIL  ${name}\n      ${(err as Error).message}`); }
}

const ROUTES = ["/api/admin/overview", "/api/admin/issues", "/api/admin/users", "/api/admin/users/u_live", "/api/admin/users/u_live/monerium", "/api/admin/monerium"];

await check("every dashboard route refuses without the operator token", async () => {
  for (const r of ROUTES) {
    assert.equal((await get(r, null)).status, 401, r);
    assert.equal((await get(r, "wrong-token-of-sufficient-length-000000")).status, 401, r);
  }
});

await check("no Monerium token, secret or ciphertext reaches any dashboard JSON", async () => {
  for (const r of ROUTES) {
    const { status, text } = await get(r);
    assert.equal(status, 200, r);
    for (const bad of ["accessTokenEnc", "refreshTokenEnc", "clientSecretEnc", "user-oauth-token", store.findUser("u_live")!.monerium!.accessTokenEnc!]) {
      assert.ok(!text.includes(bad), `${r} leaks ${bad.slice(0, 20)}`);
    }
  }
});

await check("onboarding stage names the first step not done", async () => {
  const users = JSON.parse((await get("/api/admin/users")).text);
  const by = Object.fromEntries(users.map((u: any) => [u.id, u]));
  assert.equal(by.u_live.onboarding.stage, "active");
  assert.equal(by.u_live.recoveryEnrolment.zoldenburg, "active");
  assert.equal(by.u_hollow.onboarding.stage, "recovery", "no recovery choice yet");
});

await check("the issues feed carries the failed transfer and the Monerium refusal", async () => {
  const { issues } = JSON.parse((await get("/api/admin/issues")).text);
  assert.ok(issues.some((i: any) => i.id === "transfer:t_fail" && i.severity === "error"));
  assert.ok(issues.some((i: any) => i.id === "refusal:u_hollow" && i.source === "monerium"));
});

await check("stored Monerium data is returned without asking Monerium", async () => {
  moneriumCalls.length = 0;
  const body = JSON.parse((await get("/api/admin/users/u_live/monerium")).text);
  assert.equal(body.stored.row.profileState, "approved");
  assert.equal(body.live, undefined);
  assert.equal(moneriumCalls.length, 0);
});

await check("a live read refuses an account without a stored token and never asks Monerium", async () => {
  moneriumCalls.length = 0;
  const body = JSON.parse((await get("/api/admin/users/u_hollow/monerium?live=1")).text);
  assert.equal(body.live.available, false);
  assert.equal(moneriumCalls.length, 0, "no fallback to the app's credentials");
});

await check("a live read uses the account's own token, stores nothing and is audited", async () => {
  moneriumCalls.length = 0;
  const before = JSON.stringify(store.findUser("u_live"));
  const body = JSON.parse((await get("/api/admin/users/u_live/monerium?live=1")).text);
  assert.equal(body.live.available, true);
  assert.ok(body.live.profile.ok && body.live.orders.ok && body.live.ibans.ok);
  assert.ok(moneriumCalls.length >= 6);
  assert.ok(moneriumCalls.every((c) => c.auth === "Bearer user-oauth-token"), "every call on the account's own token");
  assert.equal(JSON.stringify(store.findUser("u_live")), before, "the live read wrote nothing to the account");
  const audit = store.auditFor("u_live", 10).find((e: any) => e.kind === "operator.monerium_read");
  assert.ok(audit && String(audit.data.operator).startsWith("operator:"));
});

server.close();
globalThis.fetch = realFetch;
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nadmin dashboard: all passed");
