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
 *     the stored profile is looked up by id; keys that no longer open it are
 *     invalid until it is back, and a different one is not adopted;
 *   - races: keys removed or replaced while a check waits on Monerium are
 *     not written over; a member demoted or removed while a save waits stores nothing;
 *   - errors: only a refused token grant is "keys refused"; Monerium's own
 *     response body never reaches the browser or the server log; an answer
 *     without a profile list is a failed read, not "no profiles";
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
const { MoneriumKeysRefusedError, profileListOf } = await import("../services/api/src/adapters/monerium-connection.js");
const { SECRETS, STORED_SECRETS } = await import("../services/api/src/stored-secrets.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/org-monerium-model.js")).href);
const settingsModel: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/settings-model.js")).href);
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
const PROVIDER_BODY = "provider-body-marker-must-not-reach-the-browser";
const stub = {
  mode: "ok" as "ok" | "refuse" | "down" | "readfail" | "nolist",
  profiles: [CORP] as any[],
  calls: [] as { clientId: string; secretOk: boolean }[],
  /** While set, Monerium "answers" only once it resolves: a request in flight. */
  hold: undefined as Promise<void> | undefined,
  /** Called as Monerium is asked, so a test acts while the request waits. */
  entered: undefined as (() => void) | undefined,
};
const verify = async (clientId: string, clientSecret: string) => {
  stub.calls.push({ clientId, secretOk: clientSecret === SECRET });
  const mode = stub.mode;
  stub.entered?.();
  if (stub.hold) await stub.hold;
  if (mode === "refuse") throw new MoneriumKeysRefusedError("Monerium (sandbox) rejected these credentials");
  if (mode === "down") throw new Error("connect ECONNREFUSED");
  // A read after the token grant failing with a 400 is not "the keys are refused".
  if (mode === "readfail") throw new MoneriumApiError(`Monerium GET /profiles failed (400): ${PROVIDER_BODY}`, 400);
  // Monerium answers the profile read without a list: the real parser decides.
  if (mode === "nolist") return { profiles: profileListOf({ items: stub.profiles }) };
  return { profiles: stub.profiles.map((p) => ({ ...p })) };
};
/** Starts a request and holds Monerium's answer: `asked` resolves once
 *  Monerium is asked, `release` lets it answer and returns the response. */
const inFlight = <T,>(start: () => Promise<T>) => {
  let release!: () => void;
  stub.hold = new Promise<void>((r) => { release = r; });
  const asked = new Promise<void>((r) => { stub.entered = r; });
  const pending = start();
  return { asked, release: () => { stub.hold = undefined; stub.entered = undefined; release(); return pending; } };
};

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user");
const requireSession = (req: any, res: any) => (who(req) ? { userId: who(req) } : (res.status(401).json({ error: "no session" }), undefined));
/** The passkey approval, stubbed: `stepUp: "approved"` in the body passes. */
const stepUps: string[] = [];
const stepUp = async (userId: string, body: any, res: any) => {
  stepUps.push(userId);
  if (body?.stepUp === "approved") return true;
  res.status(401).json({ error: "a fresh passkey approval is required for this change", code: "STEP_UP_REQUIRED" });
  return false;
};
const OK = { stepUp: "approved" };
app.use("/api/orgs", createOrgMoneriumRoutes({ ctxOf: (req, res) => resolveOrg(req, res, requireSession as any) }, verify, stepUp));
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
  stub.mode = "readfail";
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  let read;
  try { read = await call("POST", "/org_co/monerium", "u_adam", keys); } finally { console.warn = warn; }
  assert.ok(logged.some((l) => l.includes("Monerium answered 400")), `the status is logged: ${logged.join(" | ")}`);
  assert.ok(!logged.join("\n").includes(PROVIDER_BODY), "Monerium's response body is not logged either");
  assert.equal(read.status, 503, "a failed read after the grant is not a refusal of the keys");
  assert.equal(read.data.code, "MONERIUM_UNREACHABLE");
  assert.ok(!read.text.includes(PROVIDER_BODY), "Monerium's own response body never reaches the browser");
  neverLeaks(no.text + down.text + read.text);
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

await check("check again: the stored profile is found by its id, even when another ranks first", async () => {
  CORP.state = "pending";
  stub.profiles = [{ id: "prof-corp-2", kind: "corporate", name: "Other GmbH", state: "approved" }, CORP];
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.monerium.status, "pending", "still the stored, pending profile");
  assert.equal(store.findOrganisation("org_co")!.monerium!.profile.id, "prof-corp-1");
  CORP.state = "approved";
  stub.profiles = [CORP];
});

await check("check again: keys that no longer open the stored profile are invalid until it is back; another is not adopted", async () => {
  stub.profiles = [{ id: "prof-corp-2", kind: "corporate", name: "Other GmbH", state: "approved" }];
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_CHANGED");
  assert.equal(r.data.monerium.status, "invalid");
  const m = store.findOrganisation("org_co")!.monerium!;
  assert.equal(m.profile.id, "prof-corp-1", "kept for reference");
  assert.ok(m.profileMissingAt);
  assert.equal((await call("GET", "/org_co/monerium", "u_olga")).data.monerium.status, "invalid", "and stays invalid on the next read");
  assert.deepEqual(model.companySteps({ status: "invalid" }).map((s: any) => s.done), [false, false], "Home does not count it as done");
  assert.match(model.keyHint(r.data.monerium), /no longer open the company profile/);
  stub.profiles = [CORP];
  const back = await call("POST", "/org_co/monerium/check", "u_olga");
  assert.equal(back.data.monerium.status, "connected", "visible again clears it");
  assert.equal(store.findOrganisation("org_co")!.monerium!.profileMissingAt, undefined);
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

await check("check again: keys removed or replaced while Monerium answers are not written back", async () => {
  for (const mode of ["ok", "refuse"] as const) {
    stub.mode = mode;
    const before = store.findOrganisation("org_co")!.monerium!;
    const check = inFlight(() => call("POST", "/org_co/monerium/check", "u_olga"));
    await check.asked;
    assert.equal((await call("DELETE", "/org_co/monerium", "u_olga", OK)).status, 200, "removed meanwhile");
    const r = await check.release();
    assert.equal(r.status, 409, `${mode}: ${r.text}`);
    assert.equal(r.data.code, "MONERIUM_KEYS_CHANGED");
    assert.equal(store.findOrganisation("org_co")!.monerium, undefined, `${mode}: the removal stands`);
    store.updateOrganisation("org_co", { monerium: before });

    // Replaced meanwhile by other keys: the replacement stands, untouched.
    const replacement = { ...before, clientId: "test-client-id-2222-3333", clientSecretEnc: SECRETS.orgMoneriumApiSecret.seal("org_co", SECRET + "-other"), checkedAt: "2000-01-01T00:00:00.000Z" };
    const again = inFlight(() => call("POST", "/org_co/monerium/check", "u_olga"));
    await again.asked;
    store.updateOrganisation("org_co", { monerium: replacement });
    const r2 = await again.release();
    assert.equal(r2.status, 409, `${mode} replaced: ${r2.text}`);
    assert.equal(r2.data.code, "MONERIUM_KEYS_CHANGED");
    assert.deepEqual(store.findOrganisation("org_co")!.monerium, replacement, `${mode}: the replacement is not written over`);
    store.updateOrganisation("org_co", { monerium: before });
  }
  stub.mode = "ok";
});

await check("a member demoted or removed while Monerium answers stores nothing", async () => {
  const saved = store.findOrganisation("org_co")!.monerium;
  store.updateOrganisation("org_co", { monerium: undefined });
  for (const change of [{ role: "viewer" }, { status: "removed" }] as const) {
    const post = inFlight(() => call("POST", "/org_co/monerium", "u_adam", keys));
    await post.asked;
    store.updateMember("m_adam", change as any);
    const r = await post.release();
    assert.ok([403, 404].includes(r.status), `${JSON.stringify(change)}: ${r.status} ${r.text}`);
    assert.equal(store.findOrganisation("org_co")!.monerium, undefined, "nothing stored");
    store.updateMember("m_adam", { role: "admin", status: "active" } as any);
  }
  store.updateOrganisation("org_co", { monerium: saved });
});

await check("a re-check whose answer has no profile list is a 503 and changes nothing", async () => {
  const before = structuredClone(store.findOrganisation("org_co")!.monerium);
  assert.ok(before, "keys are stored for this check");
  stub.mode = "nolist";
  const r = await call("POST", "/org_co/monerium/check", "u_olga");
  stub.mode = "ok";
  assert.equal(r.status, 503, r.text);
  assert.equal(r.data.code, "MONERIUM_UNREACHABLE");
  assert.deepEqual(store.findOrganisation("org_co")!.monerium, before, "the saved connection is untouched: not missing, not invalid");
});

await check("replacing or removing stored keys needs a fresh passkey approval; the first connection does not", async () => {
  const before = structuredClone(store.findOrganisation("org_co")!.monerium);
  assert.ok(before, "keys are stored for this check");
  stub.calls = [];
  const replace = await call("POST", "/org_co/monerium", "u_adam", keys);
  assert.equal(replace.status, 401, replace.text);
  assert.equal(replace.data.code, "STEP_UP_REQUIRED");
  assert.deepEqual(stub.calls, [], "Monerium is not asked before the approval");
  const remove = await call("DELETE", "/org_co/monerium", "u_olga");
  assert.equal(remove.status, 401);
  assert.deepEqual(store.findOrganisation("org_co")!.monerium, before, "nothing changed");
  const replaced = await call("POST", "/org_co/monerium", "u_adam", { ...keys, ...OK });
  assert.equal(replaced.status, 201, replaced.text);
  stepUps.length = 0;
  store.updateOrganisation("org_co", { monerium: undefined });
  assert.equal((await call("POST", "/org_co/monerium", "u_adam", keys)).status, 201, "a first connection replaces nothing");
  assert.deepEqual(stepUps, [], "and asks for no approval");
  store.updateOrganisation("org_co", { monerium: before });
});

await check("a payer cannot remove them; an owner can", async () => {
  assert.equal((await call("DELETE", "/org_co/monerium", "u_pia", OK)).status, 403);
  const r = await call("DELETE", "/org_co/monerium", "u_olga", OK);
  assert.equal(r.status, 200);
  assert.equal(r.data.monerium.status, "not_connected");
  assert.equal(store.findOrganisation("org_co")!.monerium, undefined);
  assert.equal((await call("DELETE", "/org_co/monerium", "u_olga", OK)).status, 409);
});

await check("Home's company set-up: the keys step, then the IBAN step, done only once issued", () => {
  assert.equal(model.companyKeysHere({ type: "business", entity: "company" }, true), true);
  assert.equal(model.companyKeysHere({ type: "business", entity: "company" }, false), false, "not for a payer");
  assert.equal(model.companyKeysHere({ type: "business", entity: "sole_trader" }, true), false);
  assert.equal(model.companyKeysHere({ type: "personal" }, true), false);
  assert.deepEqual(model.companySteps({ status: "connected" }).map((s: any) => s.done), [true, false]);
  assert.deepEqual(model.companySteps({ status: "pending" }).map((s: any) => s.done), [false, false]);
  assert.deepEqual(model.companySteps(null).map((s: any) => s.done), [null, null], "unread is couldn't check, not not-done");
  assert.equal(model.companySteps({ status: "connected", companyIban: { state: "ready" } })[1].state, "ready");
  assert.deepEqual(model.companySteps({ status: "connected", companyIban: { state: "iban_requested" } }).map((s: any) => s.done), [true, false], "requested is not issued");
  assert.deepEqual(model.companySteps({ status: "not_connected", companyIban: { state: "issued", iban: "DE00" } }).map((s: any) => s.done), [true, true], "issued stays done with the keys removed");
  assert.equal(model.keyHint({ status: "pending", profile: { state: "review" } }).includes("review"), true);
});

await check("a Monerium answer without a profile list is a failed read, not \"no profiles\"", () => {
  assert.deepEqual(profileListOf([CORP]), [CORP]);
  assert.deepEqual(profileListOf({ profiles: [] }), [], "an explicit empty list is no profiles");
  for (const bad of [{}, null, undefined, { profiles: null }, { items: [CORP] }, "x"]) {
    assert.throws(() => profileListOf(bad), /without a profiles array/, JSON.stringify(bad));
    assert.ok(!((() => { try { profileListOf(bad); } catch (e) { return e; } })() instanceof MoneriumKeysRefusedError), "never read as refused keys");
  }
});

await check("the set-up link names its Settings section in the URL, so a new tab lands there", () => {
  assert.equal(settingsModel.settingsSecFrom("?view=settings&sec=monerium"), "monerium");
  assert.equal(settingsModel.settingsSecFrom("?view=settings&sec=org"), "org");
  assert.equal(settingsModel.settingsSecFrom("?view=settings"), null);
  assert.equal(settingsModel.settingsSecFrom("?view=settings&sec=members"), null, "unknown sections are ignored");
  const home = readFileSync(path.join(ROOT, "services/api/public/business/home.js"), "utf8");
  assert.match(home, /href="\?view=\$\{esc\(view\)\}&amp;sec=\$\{esc\(sec\)\}"/, "Home's Open link carries sec in its href");
  const settings = readFileSync(path.join(ROOT, "services/api/public/business/settings.js"), "utf8");
  assert.match(settings, /settingsSecFrom\(location\.search\)/, "Settings reads it on render");
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
