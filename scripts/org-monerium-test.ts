/**
 * A company org's own Monerium API keys (routes/business/org-monerium.ts,
 * public/business/org-monerium-model.js).
 *
 * Covers:
 *   - status: approved profile is connected; created/incomplete/pending/review
 *     is pending; rejected, closed or keys refused later is invalid;
 *   - who: a viewer, payer or accountant gets 403, a non-member 404, a
 *     sole_trader and a personal org 409 NOT_A_COMPANY; an admin connects;
 *   - storing: keys are checked with Monerium before anything is stored; a
 *     refusal (400) and an outage (503) store nothing; keys with no corporate
 *     profile are refused (409); the secret is sealed under the org row,
 *     opens only there, and never appears in a response or on disk in the
 *     clear, not even as ciphertext in a response; re-encryption sees it;
 *   - check again: pending → connected; refused keys → invalid, row kept;
 *     a different profile is not adopted;
 *   - remove: the keys are gone and GET says not_connected;
 *   - Home's company set-up: the keys step, and an IBAN step that is never
 *     offered as done.
 *
 * Offline: Monerium is a stub verifier injected into the router.
 * Run: npm run org-monerium:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

const DB = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-monerium-")), "db.json");
process.env.TRANSF_DB_PATH = DB;
process.env.TRANSF_CHAIN_ID = "31337";
process.env.LOCAL_HARNESS = "";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:9";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createOrgMoneriumRoutes, orgMoneriumStatus } = await import("../services/api/src/routes/business/org-monerium.js");
const { MoneriumApiError } = await import("../services/api/src/adapters/monerium-client.js");
const { SECRETS, STORED_SECRETS } = await import("../services/api/src/stored-secrets.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/org-monerium-model.js")).href);
initStore();

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

const now = new Date().toISOString();
const org = (id: string, extra: Record<string, unknown>) =>
  store.addOrganisation({ id, name: id, plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now, ...extra } as any);
org("org_co", { type: "business", entity: "company", legalName: "Acme GmbH" });
org("org_st", { type: "business", entity: "sole_trader" });
org("org_pers", { type: "personal" });
for (const p of ["olga", "adam", "pia", "vera", "acco", "out"]) store.addUser({ id: `u_${p}`, country: "DE", kycStatus: "approved", createdAt: now } as any);
const member = (id: string, orgId: string, userId: string, role: string) =>
  store.addMember({ id, orgId, userId, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
member("m_olga", "org_co", "u_olga", "owner");
member("m_adam", "org_co", "u_adam", "admin");
member("m_pia", "org_co", "u_pia", "payer");
member("m_vera", "org_co", "u_vera", "viewer");
member("m_acco", "org_co", "u_acco", "accountant");
member("m_st", "org_st", "u_olga", "owner");
member("m_pers", "org_pers", "u_olga", "owner");

// Placeholder credentials, generated for this run only.
const CLIENT_ID = "test-client-id-0000-1111";
const SECRET = "test-secret-" + Math.random().toString(36).slice(2) + "-placeholder";
const CORP = { id: "prof-corp-1", kind: "corporate", name: "Acme GmbH", state: "pending" };
const stub = { mode: "ok" as "ok" | "refuse" | "down", profiles: [CORP] as any[], calls: [] as { clientId: string; secretOk: boolean }[] };
const verify = async (clientId: string, clientSecret: string) => {
  stub.calls.push({ clientId, secretOk: clientSecret === SECRET });
  if (stub.mode === "refuse") throw new MoneriumApiError("Monerium (sandbox) rejected these credentials", 400);
  if (stub.mode === "down") throw new Error("connect ECONNREFUSED");
  return { context: {}, profiles: stub.profiles.map((p) => ({ ...p })), ibans: [], addresses: [] };
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
app.use("/api/orgs", createOrgMoneriumRoutes({ ctxOf: (req, res) => resolveOrg(req, res, requireSession as any) }, verify));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, data: (text ? JSON.parse(text) : {}) as any };
};
const keys = { clientId: CLIENT_ID, clientSecret: SECRET };
const neverLeaks = (text: string) => {
  assert.ok(!text.includes(SECRET), "the secret is never in a response");
  const enc = store.findOrganisation("org_co")?.monerium?.clientSecretEnc;
  if (enc) assert.ok(!text.includes(enc), "nor its ciphertext");
  assert.ok(!text.includes(CLIENT_ID), "the client id is shown masked only");
};

await check("status: approved is connected, review states pending, rejected/closed/refused invalid", () => {
  const m = (state: string, extra = {}) => ({ clientId: "x", clientSecretEnc: "x", profile: { id: "p", state }, connectedAt: now, checkedAt: now, connectedByMemberId: "m", ...extra });
  assert.equal(orgMoneriumStatus(undefined), "not_connected");
  assert.equal(orgMoneriumStatus(m("approved")), "connected");
  for (const s of ["created", "incomplete", "pending", "review"]) assert.equal(orgMoneriumStatus(m(s)), "pending", s);
  for (const s of ["rejected", "closed"]) assert.equal(orgMoneriumStatus(m(s)), "invalid", s);
  assert.equal(orgMoneriumStatus(m("approved", { rejectedAt: now })), "invalid", "keys Monerium refused later");
});

await check("only owners and admins of a company org reach it", async () => {
  for (const u of ["u_vera", "u_pia", "u_acco"]) {
    assert.equal((await call("GET", "/org_co/monerium", u)).status, 403, u);
    assert.equal((await call("POST", "/org_co/monerium", u, keys)).status, 403, u);
  }
  assert.equal((await call("GET", "/org_co/monerium", "u_out")).status, 404, "a non-member");
  assert.equal((await call("GET", "/org_co/monerium", "")).status, 401);
  for (const o of ["org_st", "org_pers"]) {
    const r = await call("POST", `/${o}/monerium`, "u_olga", keys);
    assert.equal(r.status, 409, o);
    assert.equal(r.data.code, "NOT_A_COMPANY");
  }
  assert.equal(stub.calls.length, 0, "nobody refused reached Monerium");
  const r = await call("GET", "/org_co/monerium", "u_adam");
  assert.equal(r.status, 200);
  assert.equal(r.data.monerium.status, "not_connected");
  assert.equal(r.data.monerium.available, true);
});

await check("malformed keys are refused before Monerium is asked", async () => {
  assert.equal((await call("POST", "/org_co/monerium", "u_adam", { clientId: "short", clientSecret: SECRET })).status, 400);
  assert.equal((await call("POST", "/org_co/monerium", "u_adam", { clientId: CLIENT_ID, clientSecret: "has white space" })).status, 400);
  assert.equal(stub.calls.length, 0);
});

await check("keys Monerium refuses, or an outage, store nothing", async () => {
  stub.mode = "refuse";
  const no = await call("POST", "/org_co/monerium", "u_adam", keys);
  assert.equal(no.status, 400);
  assert.equal(no.data.code, "MONERIUM_KEYS_REFUSED");
  stub.mode = "down";
  const down = await call("POST", "/org_co/monerium", "u_adam", keys);
  assert.equal(down.status, 503);
  neverLeaks(no.text + down.text);
  assert.equal(store.findOrganisation("org_co")!.monerium, undefined);
  stub.mode = "ok";
});

await check("keys with no company profile are refused: a personal profile never backs a company", async () => {
  stub.profiles = [{ id: "prof-pers", kind: "personal", name: "Olga", state: "approved" }];
  const r = await call("POST", "/org_co/monerium", "u_adam", keys);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISSING");
  assert.equal(store.findOrganisation("org_co")!.monerium, undefined);
  stub.profiles = [{ id: "prof-pers", kind: "personal", name: "Olga", state: "approved" }, CORP];
});

await check("an admin connects: checked first, sealed under the org row, never returned", async () => {
  stub.calls = [];
  const r = await call("POST", "/org_co/monerium", "u_adam", keys);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(stub.calls, [{ clientId: CLIENT_ID, secretOk: true }]);
  assert.equal(r.data.monerium.status, "pending");
  assert.deepEqual(r.data.monerium.profile, { name: "Acme GmbH", state: "pending" });
  assert.equal(r.data.monerium.clientId, "test…1111");
  neverLeaks(r.text);
  const m = store.findOrganisation("org_co")!.monerium!;
  assert.equal(m.profile.id, "prof-corp-1", "the corporate profile, not the personal one");
  assert.equal(m.connectedByMemberId, "m_adam");
  assert.notEqual(m.clientSecretEnc, SECRET);
  assert.equal(SECRETS.orgMoneriumApiSecret.open("org_co", m.clientSecretEnc), SECRET);
  assert.throws(() => SECRETS.orgMoneriumApiSecret.open("org_st", m.clientSecretEnc), "bound to its own row");
  assert.throws(() => SECRETS.gmiApiKey.open("org_co", m.clientSecretEnc), "and its own purpose");
  const site = STORED_SECRETS.find((s) => s.site === SECRETS.orgMoneriumApiSecret)!;
  assert.deepEqual(site.rows(), [{ rowId: "org_co", stored: m.clientSecretEnc }], "re-encryption walks it");
  neverLeaks((await call("GET", "/org_co/monerium", "u_olga")).text);
  assert.ok(!readFileSync(DB, "utf8").includes(SECRET), "never in the clear on disk");
});

await check("check again: an approved profile is connected; the secret used is the stored one", async () => {
  CORP.state = "approved";
  stub.calls = [];
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.monerium.status, "connected");
  assert.deepEqual(stub.calls, [{ clientId: CLIENT_ID, secretOk: true }]);
  neverLeaks(r.text);
});

await check("check again: a different company profile is not adopted", async () => {
  stub.profiles = [{ id: "prof-corp-2", kind: "corporate", name: "Other GmbH", state: "approved" }];
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_CHANGED");
  assert.equal(store.findOrganisation("org_co")!.monerium!.profile.id, "prof-corp-1");
  stub.profiles = [CORP];
});

await check("check again: keys Monerium now refuses are invalid, and the row stays to be replaced", async () => {
  stub.mode = "refuse";
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(r.status, 200);
  assert.equal(r.data.monerium.status, "invalid");
  assert.ok(store.findOrganisation("org_co")!.monerium!.rejectedAt);
  stub.mode = "ok";
  const again = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(again.data.monerium.status, "connected", "accepted again clears it");
  assert.equal(store.findOrganisation("org_co")!.monerium!.rejectedAt, undefined);
});

await check("a payer cannot remove them; an owner can", async () => {
  assert.equal((await call("DELETE", "/org_co/monerium", "u_pia")).status, 403);
  const r = await call("DELETE", "/org_co/monerium", "u_olga");
  assert.equal(r.status, 200);
  assert.equal(r.data.monerium.status, "not_connected");
  assert.equal(store.findOrganisation("org_co")!.monerium, undefined);
  assert.equal((await call("DELETE", "/org_co/monerium", "u_olga")).status, 409);
});

await check("Home's company set-up: the keys step, and an IBAN step never done", () => {
  assert.equal(model.companyKeysHere({ type: "business", entity: "company" }, true), true);
  assert.equal(model.companyKeysHere({ type: "business", entity: "company" }, false), false, "not for a payer");
  assert.equal(model.companyKeysHere({ type: "business", entity: "sole_trader" }, true), false);
  assert.equal(model.companyKeysHere({ type: "personal" }, true), false);
  assert.deepEqual(model.companySteps({ status: "connected" }).map((s: any) => s.done), [true, false]);
  assert.deepEqual(model.companySteps({ status: "pending" }).map((s: any) => s.done), [false, false]);
  assert.deepEqual(model.companySteps(null).map((s: any) => s.done), [null, false], "unread is couldn't check, not not-done");
  assert.equal(model.companySteps({ status: "connected" })[1].notLive, true);
  assert.equal(model.keyHint({ status: "pending", profile: { state: "review" } }).includes("review"), true);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
