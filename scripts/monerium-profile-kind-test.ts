/**
 * Which Monerium profile may back which organisation's account.
 *
 * A business org's account may only be backed by an approved `corporate`
 * profile, a personal org's by a `personal` one (Monerium Personal Terms §16:
 * no personal account for a third party's or clients' money). The profile is
 * read from Monerium on the backing user's own connection at adoption, at
 * re-check and again at execution before any quote; Monerium not answering
 * refuses and writes nothing.
 *
 * The fake Monerium answers like the sandbox did on 2026-09-30: GET
 * /profiles/:id carries id, kind and state but NO name, the name is on the
 * GET /profiles list, and an id the token cannot see is a 403. No network,
 * no chain: the routers run in-process.
 *
 * Also here: a stored connection that names a method but holds no secret is
 * refused, never served on the app's own credentials (which see every
 * app-provisioned profile).
 *
 * Run: npm run monerium:profile:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-profile-kind-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-profile-kind-32b";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";

type Profile = { id: string; kind: "personal" | "corporate"; state: string; name: string };
/** What each bearer token can see at the fake Monerium. */
const visible = new Map<string, Profile[]>();
/** The IBANs each bearer token sees at GET /ibans (none unless set). */
const ibansOf = new Map<string, any[]>();
const fake = { down: false, reads: 0, appGrants: 0 };
const APP_TOKEN = "tok-app";

const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (fake.down) return send(503, { code: 503, status: "Service Unavailable" });
  // The app's own credentials: a token that sees every app-provisioned
  // profile, like the sandbox's GET /profiles on MONERIUM_CLIENT_SECRET.
  if (url.pathname === "/auth/token") {
    fake.appGrants++;
    return send(200, { access_token: APP_TOKEN, token_type: "Bearer", expires_in: 3600 });
  }
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const mine = visible.get(token);
  if (!mine) return send(401, { code: 401, status: "Unauthorized" });
  fake.reads++;
  if (url.pathname === "/profiles") {
    const kind = url.searchParams.get("kind");
    const list = mine.filter((p) => !kind || p.kind === kind);
    return send(200, { profiles: list, total: list.length });
  }
  if (url.pathname === "/ibans") return send(200, { ibans: ibansOf.get(token) ?? [] });
  const m = /^\/profiles\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const p = mine.find((x) => x.id === decodeURIComponent(m[1]));
    if (!p) return send(403, { code: 403, status: "Forbidden" });
    // Like the sandbox: no `name` on the single-profile answer.
    return send(200, { id: p.id, kind: p.kind, state: p.state, details: { state: "approved" }, form: { state: "approved" }, verifications: [] });
  }
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createDraftRoutes } = await import("../services/api/src/routes/business/drafts.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { encryptToken, hasOwnMoneriumCredentials, connectionMethod, moneriumClientFor, moneriumLinkAccessToken } = await import("../services/api/src/adapters/monerium-connection.js");
const { readMoneriumProfile } = await import("../services/api/src/adapters/monerium-profile.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { MoneriumAccessError } = await import("../services/api/src/adapters/monerium-client.js");
const { normaliseLegalName, nameWarning, pickProfileForSignup } = await import("../services/api/src/domain/monerium-profile.js");
const { HARNESS, MONERIUM } = await import("../services/api/src/config.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
const CORP: Profile = { id: "11111111-aaaa-4bbb-8ccc-000000000001", kind: "corporate", state: "approved", name: "Acme Technik GmbH" };
const PERSONAL: Profile = { id: "11111111-aaaa-4bbb-8ccc-000000000002", kind: "personal", state: "approved", name: "Erika Mustermann" };
const CORP_PENDING: Profile = { id: "11111111-aaaa-4bbb-8ccc-000000000003", kind: "corporate", state: "pending", name: "Acme Technik GmbH" };

/** A funded user whose Monerium OAuth connection stands for `profile`. */
function addUser(id: string, profile: Profile, n: number) {
  const token = `tok-${id}`;
  visible.set(token, [profile]);
  store.addUser({
    id, name: id, country: "DE", kycStatus: "approved", createdAt: now,
    address: `0x${String(n).repeat(40).slice(0, 40)}`,
    iban: `DE8937040044053201300${n}`,
    funding: { mode: "sandbox", status: "active", moneriumProfileId: profile.id },
    monerium: { connectedAt: now, method: "oauth", profileId: profile.id, accessTokenEnc: encryptToken(token), profiles: [{ id: profile.id, kind: profile.kind, state: profile.state }] },
  } as any);
  return token;
}
function addOrg(id: string, type: "business" | "personal", ownerId: string, legalName?: string) {
  store.addOrganisation({ id, type, name: legalName ?? id, ...(legalName ? { legalName } : {}), plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
  store.addMember({ id: `m_${id}_${ownerId}`, orgId: id, userId: ownerId, email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
}
function addGatedEur(id: string, orgId: string) {
  store.addAccount({ id, orgId, currency: "EUR", label: "EUR", status: "gated", provider: "monerium", identifier: {}, gate: { reason: "no funding identity", needs: "a member's account" }, createdAt: now, updatedAt: now });
}
function addDraft(id: string, orgId: string, accountId: string, ownerId: string) {
  store.addDraft({ id, orgId, source: { kind: "account", accountId }, state: "REVIEWED", lines: [], createdByMemberId: `m_${orgId}_${ownerId}`, activity: [], createdAt: now, updatedAt: now } as any);
}

const corpToken = addUser("u_corp", CORP, 1);
addUser("u_personal", PERSONAL, 2);
addUser("u_pending", CORP_PENDING, 3);

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession));
const noTransfers = (async () => { throw new Error("the profile check must refuse before any transfer is built"); }) as any;
app.use("/api/orgs", createDraftRoutes({ ctxOf: (req: any, res: any) => resolveOrg(req, res, requireSession) }, noTransfers));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, asUser: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const audits = () => store.auditFor(undefined, 10_000).filter((e) => e.kind === "account.monerium_profile_checked").reverse();

console.log("\nRules");

await check("the local harness is off in this suite, so every check below reads the fake Monerium", () => {
  assert.equal(HARNESS.enabled, false);
});

await check("the signup kind picks the profile: personal for a person, corporate for a company, never the other", () => {
  const both = [CORP, PERSONAL];
  assert.equal((pickProfileForSignup("individual", both) as any).profile.id, PERSONAL.id);
  assert.equal((pickProfileForSignup(undefined, both) as any).profile.id, PERSONAL.id, "no stated type reads as a person");
  assert.equal((pickProfileForSignup("company", both) as any).profile.id, CORP.id);
  const onlyCorp = pickProfileForSignup("individual", [CORP, CORP_PENDING]);
  assert.equal(onlyCorp.ok, false);
  assert.equal((onlyCorp as any).code, "MONERIUM_PROFILE_KIND_MISSING");
  assert.match((onlyCorp as any).error, /has only a company profile.*choose Personal/);
  assert.equal(pickProfileForSignup("company", [PERSONAL]).ok, false);
});

await check("an approved profile of the kind wins; a pending one is used only when none is approved", () => {
  assert.equal((pickProfileForSignup("company", [CORP_PENDING, CORP]) as any).profile.id, CORP.id);
  assert.equal((pickProfileForSignup("company", [CORP_PENDING, PERSONAL]) as any).profile.id, CORP_PENDING.id);
});

await check("a profile whose kind Monerium did not state is not trusted to be either", () => {
  assert.equal(pickProfileForSignup("individual", [{ id: "p-x", state: "approved" }]).ok, false);
  assert.equal(pickProfileForSignup("company", [{ id: "p-x", state: "approved" }]).ok, false);
  assert.equal(pickProfileForSignup("individual", undefined).ok, false);
});

await check("legal-form suffixes, case and punctuation do not make a name mismatch", () => {
  assert.equal(normaliseLegalName("ACME Technik GmbH"), normaliseLegalName("Acme Technik"));
  assert.equal(normaliseLegalName("Zoldenburg UG (haftungsbeschränkt)"), normaliseLegalName("zoldenburg"));
  assert.equal(normaliseLegalName("Müller & Söhne e.K."), normaliseLegalName("Muller Sohne"));
  assert.equal(normaliseLegalName("AG Consulting GmbH"), "ag consulting", "a leading AG is part of the name");
  assert.equal(nameWarning({ type: "business", name: "Acme", legalName: "Acme Technik GmbH" }, "ACME TECHNIK GMBH"), null);
  assert.match(nameWarning({ type: "business", name: "Acme", legalName: "Acme Technik GmbH" }, "Other Holding AG")!, /Other Holding AG/);
});

console.log("\nAdoption");

await check("a corporate profile is adopted into a business org, and the account records whose IBAN it is", async () => {
  addOrg("org_biz", "business", "u_corp", "Acme Technik GmbH");
  addGatedEur("acc_biz", "org_biz");
  const r = await call("POST", "/api/orgs/org_biz/accounts/acc_biz/fund", "u_corp");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = store.findAccount("acc_biz")!;
  assert.equal(row.status, "active");
  assert.equal(row.backingUserId, "u_corp");
  assert.equal(row.moneriumProfile?.id, CORP.id);
  assert.equal(row.moneriumProfile?.kind, "corporate");
  assert.equal(row.moneriumProfile?.name, "Acme Technik GmbH", "the name comes from the list, not the single-profile answer");
  assert.ok(row.moneriumProfile?.checkedAt);
  assert.equal(r.data.account.profile.status, "verified");
  assert.equal(r.data.warning, undefined, "matching names raise no warning");
  assert.equal(audits().at(-1)!.data.outcome, "passed");
  assert.equal(audits().at(-1)!.data.viaIssuedIban, false);
});

await check("POST /accounts with useMyAccount adopts a corporate profile the same way", async () => {
  addOrg("org_biz_new", "business", "u_corp", "Acme Technik GmbH");
  const r = await call("POST", "/api/orgs/org_biz_new/accounts", "u_corp", { currency: "EUR", useMyAccount: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.account.moneriumProfile.kind, "corporate");
  assert.match(r.data.note, /company profile "Acme Technik GmbH"/);
});

await check("a different legal name is a visible warning, not a block", async () => {
  addOrg("org_biz_other", "business", "u_corp", "Beta Handel UG (haftungsbeschränkt)");
  addGatedEur("acc_biz_other", "org_biz_other");
  const r = await call("POST", "/api/orgs/org_biz_other/accounts/acc_biz_other/fund", "u_corp");
  assert.equal(r.status, 200);
  assert.match(r.data.warning, /Acme Technik GmbH.*Beta Handel/);
  const list = await call("GET", "/api/orgs/org_biz_other/accounts", "u_corp");
  assert.match(list.data.accounts[0].profile.warning, /still go through/);
});

await check("a personal profile is refused for a business org, in plain words, and the account stays gated", async () => {
  addOrg("org_biz_p", "business", "u_personal", "Gamma GmbH");
  addGatedEur("acc_biz_p", "org_biz_p");
  const r = await call("POST", "/api/orgs/org_biz_p/accounts/acc_biz_p/fund", "u_personal");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
  assert.equal(r.data.error, "Business accounts need a company profile at Monerium, and this login is connected to a personal one. To send for Gamma GmbH, email support@zoldhq.com: we set up a separate account for the company, with its own Safe.");
  const row = store.findAccount("acc_biz_p")!;
  assert.equal(row.status, "gated");
  assert.equal(row.backingUserId, undefined);
  assert.equal(row.moneriumProfile, undefined);
  assert.equal(audits().at(-1)!.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
});

await check("the account list does not offer adoption to a caller whose stored profile is personal", async () => {
  const list = await call("GET", "/api/orgs/org_biz_p/accounts", "u_personal");
  assert.equal(list.data.adoption.allowed, false);
  assert.match(list.data.adoption.reason, /company profile at Monerium/);
});

await check("useMyAccount with a personal profile on a business org opens nothing", async () => {
  const before = store.accountsOf("org_biz_p").length;
  addOrg("org_biz_p2", "business", "u_personal", "Delta GmbH");
  const r = await call("POST", "/api/orgs/org_biz_p2/accounts", "u_personal", { currency: "EUR", useMyAccount: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
  assert.equal(store.accountsOf("org_biz_p2").length, 0);
  assert.equal(store.accountsOf("org_biz_p").length, before);
});

await check("a corporate profile is refused for a personal org", async () => {
  addOrg("org_pers_c", "personal", "u_corp");
  addGatedEur("acc_pers_c", "org_pers_c");
  const r = await call("POST", "/api/orgs/org_pers_c/accounts/acc_pers_c/fund", "u_corp");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
  assert.equal(store.findAccount("acc_pers_c")!.status, "gated");
});

await check("a personal profile is adopted into a personal org", async () => {
  addOrg("org_pers", "personal", "u_personal");
  addGatedEur("acc_pers", "org_pers");
  const r = await call("POST", "/api/orgs/org_pers/accounts/acc_pers/fund", "u_personal");
  assert.equal(r.status, 200);
  assert.equal(store.findAccount("acc_pers")!.moneriumProfile?.kind, "personal");
});

await check("a corporate profile Monerium has not approved is refused", async () => {
  addOrg("org_biz_pend", "business", "u_pending", "Acme Technik GmbH");
  addGatedEur("acc_biz_pend", "org_biz_pend");
  const r = await call("POST", "/api/orgs/org_biz_pend/accounts/acc_biz_pend/fund", "u_pending");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_NOT_APPROVED");
  assert.match(r.data.error, /pending/);
  assert.equal(store.findAccount("acc_biz_pend")!.status, "gated");
});

const CORP_PENDING_IBAN: Profile = { id: "11111111-aaaa-4bbb-8ccc-000000000004", kind: "corporate", state: "pending", name: "Linder GmbH" };
const pendingIbanToken = addUser("u_pending_iban", CORP_PENDING_IBAN, 4);
const pendingIbanUser = () => store.findUser("u_pending_iban")!;
const issued = (over: Record<string, unknown> = {}) => ({
  profile: CORP_PENDING_IBAN.id, address: pendingIbanUser().address, iban: pendingIbanUser().iban, chain: "basesepolia", state: "approved", ...over,
});

await check("a pending company profile backs the account once Monerium has issued an IBAN on it to this Safe", async () => {
  ibansOf.set(pendingIbanToken, [issued()]);
  addOrg("org_lind", "business", "u_pending_iban", "Linder GmbH");
  addGatedEur("acc_lind", "org_lind");
  const r = await call("POST", "/api/orgs/org_lind/accounts/acc_lind/fund", "u_pending_iban");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.findAccount("acc_lind")!.status, "active");
  assert.equal(audits().at(-1)!.data.outcome, "passed");
  assert.equal(audits().at(-1)!.data.viaIssuedIban, true, "the audit says this pass rests on an issued IBAN, not an approved profile");
});

await check("a pending company profile with no issued IBAN is still refused", async () => {
  ibansOf.set(pendingIbanToken, []);
  addOrg("org_lind_none", "business", "u_pending_iban", "Linder GmbH");
  addGatedEur("acc_lind_none", "org_lind_none");
  const r = await call("POST", "/api/orgs/org_lind_none/accounts/acc_lind_none/fund", "u_pending_iban");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_NOT_APPROVED");
  assert.equal(store.findAccount("acc_lind_none")!.status, "gated");
});

await check("an IBAN on the pending profile that pays into another address, or is not approved, does not count", async () => {
  addOrg("org_lind_other", "business", "u_pending_iban", "Linder GmbH");
  const cases = [[issued({ address: `0x${"9".repeat(40)}` })], [issued({ state: "pending" })], [issued({ profile: CORP.id })]];
  for (const [i, ibans] of cases.entries()) {
    ibansOf.set(pendingIbanToken, ibans);
    addGatedEur(`acc_lind_other_${i}`, "org_lind_other");
    const r = await call("POST", `/api/orgs/org_lind_other/accounts/acc_lind_other_${i}/fund`, "u_pending_iban");
    assert.equal(r.status, 409, JSON.stringify(ibans));
    assert.equal(r.data.code, "MONERIUM_PROFILE_NOT_APPROVED");
  }
});

await check("a closed company profile is refused even with an IBAN issued to this Safe", async () => {
  ibansOf.set(pendingIbanToken, [issued()]);
  visible.set(pendingIbanToken, [{ ...CORP_PENDING_IBAN, state: "closed" }]);
  try {
    addOrg("org_lind_closed", "business", "u_pending_iban", "Linder GmbH");
    addGatedEur("acc_lind_closed", "org_lind_closed");
    const r = await call("POST", "/api/orgs/org_lind_closed/accounts/acc_lind_closed/fund", "u_pending_iban");
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "MONERIUM_PROFILE_NOT_APPROVED");
  } finally {
    visible.set(pendingIbanToken, [CORP_PENDING_IBAN]);
  }
});

await check("the client cannot claim a kind: a body saying corporate changes nothing", async () => {
  addGatedEur("acc_biz_p_claim", "org_biz_p");
  const r = await call("POST", "/api/orgs/org_biz_p/accounts/acc_biz_p_claim/fund", "u_personal", { kind: "corporate", profileId: CORP.id, name: "Gamma GmbH" });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
});

await check("Monerium unreachable: refused with 503 and nothing written", async () => {
  addOrg("org_biz_down", "business", "u_corp", "Acme Technik GmbH");
  addGatedEur("acc_biz_down", "org_biz_down");
  const snapshot = JSON.stringify(store.findAccount("acc_biz_down"));
  fake.down = true;
  try {
    const r = await call("POST", "/api/orgs/org_biz_down/accounts/acc_biz_down/fund", "u_corp");
    assert.equal(r.status, 503);
    assert.equal(r.data.code, "MONERIUM_UNREACHABLE");
    assert.equal(JSON.stringify(store.findAccount("acc_biz_down")), snapshot);
    addOrg("org_biz_down2", "business", "u_corp", "Acme Technik GmbH");
    const opened = await call("POST", "/api/orgs/org_biz_down2/accounts", "u_corp", { currency: "EUR", useMyAccount: true });
    assert.equal(opened.status, 503);
    assert.equal(store.accountsOf("org_biz_down2").length, 0);
  } finally {
    fake.down = false;
  }
});

console.log("\nExecution");

await check("execution passes the profile check for a still-corporate profile (and goes on to the balance read)", async () => {
  addDraft("dr_ok", "org_biz", "acc_biz", "u_corp");
  const r = await call("POST", "/api/orgs/org_biz/drafts/dr_ok/execute", "u_corp");
  assert.ok(!String(r.data.code ?? "").startsWith("MONERIUM_"), JSON.stringify(r.data));
  assert.equal(audits().at(-1)!.data.stage, "execute");
  assert.equal(audits().at(-1)!.data.outcome, "passed");
});

await check("execution is refused after the profile's kind changes at Monerium, before any quote", async () => {
  addDraft("dr_kind", "org_biz", "acc_biz", "u_corp");
  visible.set(corpToken, [{ ...CORP, kind: "personal" }]);
  try {
    const r = await call("POST", "/api/orgs/org_biz/drafts/dr_kind/execute", "u_corp");
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
    assert.equal(store.findDraft("dr_kind")!.state, "REVIEWED", "the draft was not claimed");
  } finally {
    visible.set(corpToken, [CORP]);
  }
});

await check("execution is refused when the profile is no longer approved", async () => {
  addDraft("dr_closed", "org_biz", "acc_biz", "u_corp");
  visible.set(corpToken, [{ ...CORP, state: "closed" }]);
  try {
    const r = await call("POST", "/api/orgs/org_biz/drafts/dr_closed/execute", "u_corp");
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "MONERIUM_PROFILE_NOT_APPROVED");
  } finally {
    visible.set(corpToken, [CORP]);
  }
});

await check("execution is refused when the connected profile id differs from the one on the account", async () => {
  addDraft("dr_swap", "org_biz", "acc_biz", "u_corp");
  const original = { ...store.findUser("u_corp")!.monerium! };
  const OTHER = { ...CORP, id: "11111111-aaaa-4bbb-8ccc-000000000009" };
  visible.set(corpToken, [CORP, OTHER]);
  store.updateUser("u_corp", { monerium: { ...original, profileId: OTHER.id } });
  try {
    const reads = fake.reads;
    const r = await call("POST", "/api/orgs/org_biz/drafts/dr_swap/execute", "u_corp");
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "MONERIUM_PROFILE_CHANGED");
    assert.equal(fake.reads, reads, "refused on the stored ids, before asking Monerium");
  } finally {
    store.updateUser("u_corp", { monerium: original });
    visible.set(corpToken, [CORP]);
  }
});

await check("execution with Monerium unreachable is refused (503) before anything is claimed", async () => {
  addDraft("dr_down", "org_biz", "acc_biz", "u_corp");
  fake.down = true;
  try {
    const r = await call("POST", "/api/orgs/org_biz/drafts/dr_down/execute", "u_corp");
    assert.equal(r.status, 503);
    assert.equal(r.data.code, "MONERIUM_UNREACHABLE");
    assert.equal(store.findDraft("dr_down")!.state, "REVIEWED");
  } finally {
    fake.down = false;
  }
});

console.log("\nAccounts adopted before the check");

await check("a legacy business account with no recorded profile reads as needing a check and cannot send", async () => {
  addOrg("org_legacy", "business", "u_corp", "Acme Technik GmbH");
  store.addAccount({ id: "acc_legacy", orgId: "org_legacy", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: { iban: "DE89370400440532013001" }, address: store.findUser("u_corp")!.address as any, backingUserId: "u_corp", createdAt: now, updatedAt: now });
  const list = await call("GET", "/api/orgs/org_legacy/accounts", "u_corp");
  assert.equal(list.data.accounts[0].profile.status, "needs_check");
  assert.equal(store.findAccount("acc_legacy")!.moneriumProfile, undefined, "reading the list rewrote nothing");
  addDraft("dr_legacy", "org_legacy", "acc_legacy", "u_corp");
  const reads = fake.reads;
  const r = await call("POST", "/api/orgs/org_legacy/drafts/dr_legacy/execute", "u_corp");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_UNVERIFIED");
  assert.equal(fake.reads, reads);
  assert.equal(store.findAccount("acc_legacy")!.status, "active", "not deleted, not rewritten");
});

await check("the re-check route records the profile, after which the legacy account passes", async () => {
  const r = await call("POST", "/api/orgs/org_legacy/accounts/acc_legacy/profile-check", "u_corp");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.account.profile.status, "verified");
  assert.equal(store.findAccount("acc_legacy")!.moneriumProfile?.id, CORP.id);
  const again = await call("POST", "/api/orgs/org_legacy/drafts/dr_legacy/execute", "u_corp");
  assert.ok(!String(again.data.code ?? "").startsWith("MONERIUM_"), JSON.stringify(again.data));
});

await check("a legacy business account backed by a personal profile fails its re-check and stays unrecorded", async () => {
  addOrg("org_legacy_p", "business", "u_personal", "Gamma GmbH");
  store.addAccount({ id: "acc_legacy_p", orgId: "org_legacy_p", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, backingUserId: "u_personal", createdAt: now, updatedAt: now });
  const r = await call("POST", "/api/orgs/org_legacy_p/accounts/acc_legacy_p/profile-check", "u_personal");
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISMATCH");
  assert.equal(store.findAccount("acc_legacy_p")!.moneriumProfile, undefined);
});

console.log("\nCompany signup");

await check("a stored 'pending' copy does not hide the button: the list offers it and the live check connects the IBAN", async () => {
  // Stored at activation, before Monerium approved; Monerium now says approved.
  addUser("u_stale", CORP, 4);
  store.updateUser("u_stale", { monerium: { ...store.findUser("u_stale")!.monerium!, profiles: [{ id: CORP.id, kind: "corporate", state: "pending" }] } } as any);
  addOrg("org_stale", "business", "u_stale", "Acme Technik GmbH");
  addGatedEur("acc_stale", "org_stale");
  const list = await call("GET", "/api/orgs/org_stale/accounts", "u_stale");
  assert.equal(list.data.adoption.allowed, true, JSON.stringify(list.data.adoption));
  const r = await call("POST", "/api/orgs/org_stale/accounts/acc_stale/fund", "u_stale");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.findAccount("acc_stale")!.status, "active");
});

await check("a stored copy of the other kind still refuses in the list", async () => {
  const list = await call("GET", "/api/orgs/org_biz_p/accounts", "u_personal");
  assert.equal(list.data.adoption.allowed, false);
  assert.equal(list.data.adoption.code, "MONERIUM_PROFILE_KIND_MISMATCH");
});

await check("a company signup's first business org gets a gated EUR account that names no API flag", async () => {
  addUser("u_signup", CORP_PENDING, 5);
  store.updateUser("u_signup", { accountType: "company" } as any);
  const r = await call("POST", "/api/orgs", "u_signup", { type: "business", name: "Acme Technik", legalName: "Acme Technik GmbH", country: "DE" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const accts = store.accountsOf(r.data.organisation.id);
  assert.equal(accts.length, 1);
  assert.equal(accts[0].currency, "EUR");
  assert.equal(accts[0].status, "gated");
  assert.equal(accts[0].backingUserId, undefined, "no IBAN is connected until the owner's live check passes");
  assert.doesNotMatch(JSON.stringify(accts[0].gate), /useMyAccount|provisioning/);
  assert.match(accts[0].gate!.needs, /company’s IBAN/);
});

await check("a second business org, or one made by a personal signup, opens no account by itself", async () => {
  const second = await call("POST", "/api/orgs", "u_signup", { type: "business", name: "Other Co", country: "DE" });
  assert.equal(store.accountsOf(second.data.organisation.id).length, 0);
  const personal = await call("POST", "/api/orgs", "u_personal", { type: "business", name: "Side Co", country: "DE" });
  assert.equal(store.accountsOf(personal.data.organisation.id).length, 0);
});

await check("opening an EUR account by hand without an IBAN says what it needs in plain words", async () => {
  addOrg("org_hand", "business", "u_signup", "Hand GmbH");
  const r = await call("POST", "/api/orgs/org_hand/accounts", "u_signup", { currency: "EUR" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.doesNotMatch(`${r.data.note} ${JSON.stringify(r.data.account.gate)}`, /useMyAccount|provisioning/);
});

await check("a row that names a method but stores no secret is not a connection, and never falls back to the app's credentials", async () => {
  // The app's credentials are present here, so a fallback would succeed and
  // GET /profiles would list every app-provisioned profile.
  visible.set(APP_TOKEN, [CORP, PERSONAL, CORP_PENDING]);
  MONERIUM.clientId = "app-client";
  MONERIUM.clientSecret = "app-secret";
  try {
    const empty = [
      { id: "u_empty_oauth", monerium: { connectedAt: now, method: "oauth", profileId: CORP.id } },
      { id: "u_empty_keys", monerium: { connectedAt: now, method: "api_keys", profileId: CORP.id } },
      { id: "u_keys_claim_oauth_token", monerium: { connectedAt: now, method: "api_keys", profileId: CORP.id, accessTokenEnc: encryptToken(corpToken) } },
    ];
    for (const row of empty) {
      store.addUser({ id: row.id, name: row.id, country: "DE", kycStatus: "approved", createdAt: now, address: "0x" + "e".repeat(40), monerium: row.monerium } as any);
      const user = store.findUser(row.id)!;
      assert.equal(connectionMethod(user), null, row.id);
      assert.equal(hasOwnMoneriumCredentials(user), false, row.id);
      assert.throws(() => moneriumClientFor(user), MoneriumAccessError, row.id);
      await assert.rejects(moneriumLinkAccessToken(user), MoneriumAccessError, row.id);
      await assert.rejects(readMoneriumProfile(user, CORP.id), (e: any) => e.code === "MONERIUM_NOT_CONNECTED", row.id);
      assert.equal(publicUser(user).monerium?.method, undefined, `${row.id}: the app must not show a method it cannot use`);
    }
    assert.equal(fake.appGrants, 0, "no app token was requested for a user who claims a connection");
    // A user with no connection at all still gets the app client.
    store.addUser({ id: "u_none", name: "u_none", country: "DE", kycStatus: "approved", createdAt: now, address: "0x" + "d".repeat(40) } as any);
    await moneriumClientFor(store.findUser("u_none")!).bearerToken();
    assert.equal(fake.appGrants, 1);
    // And a real OAuth row is unaffected.
    assert.equal(connectionMethod(store.findUser("u_corp")!), "oauth");
  } finally {
    MONERIUM.clientId = "";
    MONERIUM.clientSecret = "";
  }
});

server.close();
monerium.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
