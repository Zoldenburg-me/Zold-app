/**
 * An organisation's accounts screen, payment links and invoice IBAN.
 *
 * - An account's "why it cannot send" text is worked out when it is read,
 *   whatever wording its row stored.
 * - A business account waiting on Monerium says so, from the latest answer.
 * - A company makes its own payment links, for an issued invoice too; only
 *   the member whose Safe backs the account can, and the payer sees the
 *   company as the account holder.
 * - Any other member's link stays theirs: it is not booked under the
 *   company, and the payer sees the member's own name.
 * - Invoices print the account's own IBAN unless the profile names another.
 * - An account names the member whose Safe backs it.
 * - A company's own payment page shows its bank details under its name; its
 *   handle shares one namespace with members' pages.
 * - A company on its own Safe makes links into its own account: bank only,
 *   under its page, never a member's IBAN, page or matching.
 *
 *   npm run org-accounts:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { NOW, activeEurAccount, businessOrg, companyOrg, gatedEurAccount, member, personalOrg } from "./_org-fixtures.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-accounts-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// EUR is open only where a user can connect Monerium. Set it here rather than
// inherit it from the operator's .env, which CI and a clean checkout lack.
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-org-accounts-32";

const { initStore, store } = await import("../services/api/src/store.js");

// The live rows, for arranging state no store method writes (store/db.ts).

const dbm = await import("../services/api/src/store/db.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { createPaymentRequestRouter } = await import("../services/api/src/routes/payment-requests.js");
const { createPaymentPageRouter } = await import("../services/api/src/routes/payment-page.js");
const { linkMethods, linkPayee, openLinkPath } = await import("../services/api/src/routes/business/invoice-pay-link.js");
const { accountIsSpendable } = await import("../services/api/src/domain/accounts.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

await initStore();
const now = NOW;
const SAFE = `0x${"aa".repeat(20)}` as const;
const IBAN = "DE89370400440532013000";

// A company signup: their Safe holds the company's IBAN, and the snapshot
// taken at connect has the corporate profile pending.
await store.addUser({
  id: "u_co", name: "Sara Lindner", country: "DE", kycStatus: "approved", accountType: "company",
  address: SAFE, iban: IBAN, funding: { status: "active", moneriumProfileId: "prof_co" },
  paymentPage: { handle: "lindner", depositAddress: SAFE },
  monerium: { connectedAt: "2026-10-01T09:00:00.000Z", profileId: "prof_co", profiles: [{ id: "prof_co", kind: "corporate", state: "pending" }] },
  createdAt: now,
} as any);
await store.addUser({ id: "u_admin", name: "Jonas Weber", country: "DE", kycStatus: "approved", address: `0x${"bb".repeat(20)}`, createdAt: now } as any);

await store.addOrganisation(businessOrg("org_new", "Lindner Neu"));
await store.addOrganisation(businessOrg("org_co", "Lindner", { legalName: "Lindner Holzbau GmbH" }));
await store.addOrganisation(personalOrg("org_p", "Sara Lindner"));
await store.addMember(member("m1", "org_new", "u_co", "owner"));
await store.addMember(member("m2", "org_co", "u_co", "owner"));
await store.addMember(member("m3", "org_co", "u_admin", "admin"));
await store.addMember(member("m4", "org_p", "u_co", "owner"));
await store.addUser({ id: "u_view", name: "Birgit Falk", country: "DE", kycStatus: "approved", address: `0x${"cc".repeat(20)}`, createdAt: now } as any);
await store.addMember(member("m5", "org_co", "u_view", "viewer"));

// A row whose stored gate text is not the current wording.
await store.addAccount(gatedEurAccount("acc_old", "org_new", {
  gate: { reason: "This account has no funding identity, so nothing can be sent from it.", needs: "per-organisation account provisioning, which is not built." },
}));
await store.addAccount(activeEurAccount("acc_co", "org_co", { iban: IBAN, address: SAFE, backingUserId: "u_co" }));
await store.addInvoice({
  id: "inv_1", direction: "outgoing", orgId: "org_co", linkTokenHash: "x", state: "SUBMITTED", lines: [], currency: "EUR", total: "119.00",
  supplier: { orgName: "Lindner Holzbau GmbH", email: "", invoiceNumber: "RE-2026-0007" },
  issued: { number: "RE-2026-0007", issueDate: "2026-10-02", grossCents: 11900, netCents: 10000, vatCents: 1900, currency: "EUR" },
  createdAt: now, updatedAt: now,
} as any);

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user") as string | undefined;
const requireSession = async (req: any, res: any) => {
  const id = who(req);
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const requireUserSession = async (req: any, res: any, userId: string) => {
  if (who(req) === userId) return true;
  res.status(401).json({ error: "no session" });
  return false;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
app.use("/api", createPaymentRequestRouter(requireUserSession));
app.use("/api", createPaymentPageRouter({ requireUserSession }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(async (r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_co") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

console.log("accounts");
await check("an account whose row stored other wording shows the current reason", async () => {
  const r = await call("GET", "/api/orgs/org_new/accounts");
  const a = r.body.accounts.find((x: any) => x.id === "acc_old");
  assert.match(a.gate.reason, /No IBAN is connected/);
  assert.match(a.gate.needs, /company profile at Monerium/);
  assert.doesNotMatch(JSON.stringify(a), /not built|funding identity/);
  assert.match(accountIsSpendable(a).reason!, /No IBAN is connected/);
});
await check("a company's account reads as having no Safe yet, and is never funded from a member", async () => {
  await store.addOrganisation(companyOrg("org_gmbh", "Lindner Bau"));
  await store.addMember(member("m6", "org_gmbh", "u_co", "owner"));
  await store.addMember(member("m7", "org_gmbh", "u_admin", "admin"));
  await store.addAccount(gatedEurAccount("acc_gmbh", "org_gmbh"));
  const r = await call("GET", "/api/orgs/org_gmbh/accounts");
  const a = r.body.accounts.find((x: any) => x.id === "acc_gmbh");
  assert.match(a.gate.reason, /Safe is not set up/);
  assert.match(accountIsSpendable(a, (await store.findOrganisation("org_gmbh"))!).reason!, /Safe is not set up yet/);
  assert.equal(r.body.adoption.code, "COMPANY_OWN_SAFE");
  // The new code, for owner and admin alike: not OWNER_ONLY.
  for (const u of ["u_co", "u_admin"]) {
    const f = await call("POST", "/api/orgs/org_gmbh/accounts/acc_gmbh/fund", undefined, u);
    assert.equal(f.status, 409, u);
    assert.equal(f.body.code, "COMPANY_OWN_SAFE", u);
  }
  assert.equal((await store.findAccount("acc_gmbh"))!.backingUserId, undefined);
  assert.equal((await store.findAccount("acc_gmbh"))!.address, undefined);
});
await check("a company profile still pending at Monerium is on the screen, with when that was seen", async () => {
  const r = await call("GET", "/api/orgs/org_new/accounts");
  assert.deepEqual(r.body.profileWait, { state: "pending", at: "2026-10-01T09:00:00.000Z" });
});
await check("Monerium's newer answer wins over the snapshot from connect", async () => {
  const u = (await store.findUser("u_co"))!;
  await store.updateUser("u_co", { monerium: { ...u.monerium!, profileSeen: { id: "prof_co", kind: "corporate", state: "approved", at: now } } });
  const r = await call("GET", "/api/orgs/org_new/accounts");
  assert.equal(r.body.profileWait, undefined);
});

console.log("payment links");
await check("a company whose euro account is not open is told that, not that the account is someone else's", async () => {
  const r = await call("POST", "/api/orgs/org_new/payment-requests", { amountEur: 50, methods: ["bank"] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "ACCOUNT_NOT_OPEN");
  assert.doesNotMatch(r.body.error, /not yours/);
});
await check("an admin's link waits for the company page: never under the account holder's personal page", async () => {
  const list = await call("GET", "/api/orgs/org_co/payment-requests", undefined, "u_admin");
  assert.equal(list.body.payLink.allowed, false);
  assert.equal(list.body.payLink.code, "NO_COMPANY_PAGE");
  assert.match(list.body.payLink.reason, /opens under its company payment page, which isn’t set up yet/);
  const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["bank"] }, "u_admin");
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "NO_COMPANY_PAGE");
});
await check("a viewer still cannot make one, and nobody else's link reaches a personal account", async () => {
  const v = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["bank"] }, "u_view");
  assert.equal(v.status, 403);
  assert.equal(await linkPayee((await store.findOrganisation("org_p"))!, (await store.findUser("u_admin"))!), undefined, "a personal org pays only its own owner");
  assert.equal((await linkPayee((await store.findOrganisation("org_p"))!, (await store.findUser("u_co"))!))?.id, "u_co");
});
await check("with no company page and no page of the payee's own, Get paid offers no link and says to set up the page", async () => {
  const page = (await store.findUser("u_co"))!.paymentPage;
  await store.updateUser("u_co", { paymentPage: undefined } as any);
  try {
    const list = await call("GET", "/api/orgs/org_co/payment-requests");
    assert.equal(list.body.payLink.allowed, false, "the button is off, not a Create link that 409s");
    assert.equal(list.body.payLink.code, "NO_PAGE");
    assert.match(list.body.payLink.reason, /Set up a payment page first/);
    const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["bank"] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "NO_PAGE");
  } finally { await store.updateUser("u_co", { paymentPage: page } as any); }
});
let code = "";
await check("a link for an issued invoice is booked under the company, for the invoice's amount", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-requests", { invoiceId: "inv_1", methods: ["bank"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.orgId, "org_co");
  assert.equal(r.body.invoiceId, "inv_1");
  assert.equal(r.body.amountEur, 119);
  code = r.body.code;
  const list = await call("GET", "/api/orgs/org_co/payment-requests", undefined, "u_admin");
  assert.equal(list.body.paymentRequests.length, 1);
});
await check("the payer sees the company as the account holder", async () => {
  const r = await fetch(`${API}/api/pay/lindner/${code}`).then((x) => x.json());
  assert.equal(r.methods.bank.holder, "Lindner Holzbau GmbH");
  assert.equal(r.displayName, "Lindner Holzbau GmbH");
});
await check("a company signup's link from the app is booked under the company it backs", async () => {
  const r = await call("POST", "/api/users/u_co/payment-requests", { amountEur: 20, methods: ["bank"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.orgId, "org_co");
});

await check("a member whose Safe does not back the company keeps their links out of its books", async () => {
  await store.updateUser("u_admin", { iban: "DE44500105175407324931", paymentPage: { handle: "jonas", depositAddress: `0x${"bb".repeat(20)}` } } as any);
  const r = await call("POST", "/api/users/u_admin/payment-requests", { amountEur: 30, methods: ["bank"] }, "u_admin");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.orgId, undefined);
  const pub = await fetch(`${API}/api/pay/jonas/${r.body.code}`).then((x) => x.json());
  assert.equal(pub.methods.bank.holder, "Jonas Weber");
});
await check("a link under a company names it only when the payee's Safe backs it", async () => {
  const r = await call("POST", "/api/users/u_admin/payment-requests", { amountEur: 31, methods: ["bank"] }, "u_admin");
  await store.updatePaymentRequest(r.body.id, { orgId: "org_co" });
  const pub = await fetch(`${API}/api/pay/jonas/${r.body.code}`).then((x) => x.json());
  assert.equal(pub.methods.bank.holder, "Jonas Weber");
  assert.notEqual(pub.displayName, "Lindner Holzbau GmbH");
});


console.log("backing member");
await check("an account names the member whose Safe backs it, as Members shows them", async () => {
  const name = () => call("GET", "/api/orgs/org_co/accounts", undefined, "u_admin").then((r) => r.body.accounts.find((a: any) => a.id === "acc_co").backingMemberName);
  assert.equal(await name(), undefined, "no name and no email: nothing to show");
  await store.updateMember("m2", { email: "sara@lindner.example" } as any);
  assert.equal(await name(), "sara@lindner.example");
  await store.updateMember("m2", { name: "Sara Lindner" } as any);
  assert.equal(await name(), "Sara Lindner");
});

console.log("organisation payment page");
await check("a company whose euro account is not open cannot claim a page, and is told why", async () => {
  const r = await call("POST", "/api/orgs/org_new/payment-page", { handle: "lindner-neu" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ACCOUNT_NOT_OPEN");
  const g = await call("GET", "/api/orgs/org_new/payment-page");
  assert.equal(g.body.ready, false);
  assert.match(g.body.reason, /No euro account with an IBAN/);
});
await check("a handle a member's own page holds is taken for the company too", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindner" });
  assert.equal(r.status, 409);
});
await check("a viewer cannot claim the company's page", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindnerholzbau" }, "u_view");
  assert.equal(r.status, 403);
});
await check("a personal organisation cannot claim a company page", async () => {
  await store.addAccount(activeEurAccount("acc_p", "org_p", { iban: IBAN, address: SAFE, backingUserId: "u_co" }));
  const r = await call("POST", "/api/orgs/org_p/payment-page", { handle: "sara-lindner" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "PAGE_NOT_AVAILABLE");
});
await check("an IBAN Monerium has not confirmed as the company's is not published: no claim, and the reason says so", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindnerholzbau" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "PAGE_NOT_AVAILABLE");
  const g = await call("GET", "/api/orgs/org_co/payment-page");
  assert.equal(g.body.ready, false);
  assert.match(g.body.reason, /company profile at Monerium/);
});
await check("nor when the IBAN sits on a member's personal profile", async () => {
  await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_sara", kind: "personal", name: "Sara Lindner", checkedAt: now } } as any);
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindnerholzbau" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
});
await check("an owner claims it once the profile is the company's, and a payer sees the company's bank details and nothing else", async () => {
  await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_co", kind: "corporate", name: "Lindner Holzbau GmbH", checkedAt: now } } as any);
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "LindnerHolzbau" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payUrl, "/pay/lindnerholzbau");
  const p = await call("GET", "/api/pay/lindnerholzbau", undefined, "");
  assert.equal(p.status, 200);
  assert.deepEqual(p.body, { kind: "organisation", handle: "lindnerholzbau", displayName: "Lindner Holzbau GmbH", bank: { holder: "Lindner Holzbau GmbH", holderVerified: true, iban: IBAN } });
  for (const secret of ["u_co", "acc_co", SAFE, "Sara"]) assert.ok(!JSON.stringify(p.body).includes(secret), `leaked ${secret}`);
});
let pageCode = "";
await check("once the company has a page, a link made in the console carries its address", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 75, methods: ["bank"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.handle, "lindnerholzbau");
  assert.match(r.body.url, /\/pay\/lindnerholzbau\//);
  pageCode = r.body.code;
  const pub = await call("GET", `/api/pay/lindnerholzbau/${pageCode}`, undefined, "");
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.handle, "lindnerholzbau");
  assert.equal(pub.body.displayName, "Lindner Holzbau GmbH");
  assert.equal(pub.body.methods.bank.holder, "Lindner Holzbau GmbH");
});
await check("an admin's link then pays into the account's Safe under the company page, counted against the admin", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50 }, "u_admin");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const i = (await store.list("paymentRequests")).findIndex((p) => p.id === r.body.id);
  const link = (await store.list("paymentRequests"))[i];
  assert.equal(link.userId, "u_co", "the member whose Safe backs acc_co");
  assert.equal(link.createdBy, "u_admin");
  assert.equal(link.handle, "lindnerholzbau");
  assert.deepEqual(link.methods, ["bank"], "bank only, as the company page is; never the holder's personal crypto address");
  assert.equal(r.body.createdBy, undefined, "not in the owner projection");
  assert.equal((await call("GET", `/api/pay/lindnerholzbau/${link.code}`, undefined, "")).status, 200, "opens under the company page");
  assert.equal((await call("GET", `/api/pay/lindner/${link.code}`, undefined, "")).status, 404, "never under the holder's personal page");
  const crypto = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["crypto"] }, "u_admin");
  assert.equal(crypto.status, 409, JSON.stringify(crypto.body));
  assert.match(crypto.body.error, /bank transfer only/);
  assert.equal((await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: [1] }, "u_admin")).status, 400, "a malformed method is a bad request, not a refusal");
  assert.equal((await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["crypto", 1] }, "u_admin")).status, 400, "malformed beats refused");
  // Out again: the checks below count the company's links from here.
  dbm.db.paymentRequests.splice(i, 1);
});
await check("a company link is cancelled by anyone who may make one, not a viewer, and not once paid", async () => {
  const made = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 9 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal((await call("POST", `/api/orgs/org_co/payment-requests/${id}/cancel`, undefined, "u_view")).status, 403);
  assert.equal((await call("POST", `/api/orgs/org_new/payment-requests/${id}/cancel`)).status, 404, "another organisation's route does not reach it");
  await store.updatePaymentRequest(id, { payments: [{ at: now } as any] });
  assert.equal((await call("POST", `/api/orgs/org_co/payment-requests/${id}/cancel`, undefined, "u_admin")).status, 409);
  await store.updatePaymentRequest(id, { payments: [] });
  const done = await call("POST", `/api/orgs/org_co/payment-requests/${id}/cancel`, undefined, "u_admin");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await store.findPaymentRequest(id))!.state, "CANCELLED", "an admin cancels the holder's company link");
  dbm.db.paymentRequests.splice((await store.list("paymentRequests")).findIndex((p) => p.id === id), 1);
});
await check("open links count against whoever made them: an admin at the limit cannot use up the holder's", async () => {
  const { CEILINGS } = await import("../services/api/src/domain/ceilings.js");
  const far = new Date(Date.now() + 86_400_000).toISOString();
  const fill = Array.from({ length: CEILINGS.openPaymentRequestsPerUser }, (_, n) => ({
    id: `fill_${n}`, code: `FILL${n}`, userId: "u_co", orgId: "org_co", createdBy: "u_admin", handle: "lindnerholzbau",
    currency: "EUR", methods: ["bank"], state: "OPEN", cryptoQuotes: [], payments: [], source: { kind: "app" },
    expiresAt: far, createdAt: now, updatedAt: now,
  }));
  dbm.db.paymentRequests.push(...(fill as any));
  try {
    const admin = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 5, methods: ["bank"] }, "u_admin");
    assert.equal(admin.status, 409, JSON.stringify(admin.body));
    const holder = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 5, methods: ["bank"] });
    assert.equal(holder.status, 201, `the holder's own quota is untouched: ${JSON.stringify(holder.body)}`);
    dbm.db.paymentRequests.splice((await store.list("paymentRequests")).findIndex((p) => p.id === holder.body.id), 1);
  } finally {
    for (const f of fill) dbm.db.paymentRequests.splice((await store.list("paymentRequests")).findIndex((p) => p.id === f.id), 1);
  }
});
await check("a backer who has left the company is not paid by links others make", async () => {
  const m = (await store.membersOf("org_co")).find((x) => x.userId === "u_co")!;
  const was = m.status;
  await store.updateMember(m.id, { status: "deactivated" } as any);
  try {
    assert.equal(await linkPayee((await store.findOrganisation("org_co"))!, (await store.findUser("u_admin"))!), undefined);
  } finally { await store.updateMember(m.id, { status: was }); }
  assert.equal((await linkPayee((await store.findOrganisation("org_co"))!, (await store.findUser("u_admin"))!))?.id, "u_co");
});
await check("the company page alone is enough: no NO_PAGE once it exists", async () => {
  const page = (await store.findUser("u_co"))!.paymentPage;
  await store.updateUser("u_co", { paymentPage: undefined } as any);
  try {
    const list = await call("GET", "/api/orgs/org_co/payment-requests");
    assert.notEqual(list.body.payLink.code, "NO_PAGE", JSON.stringify(list.body.payLink));
  } finally { await store.updateUser("u_co", { paymentPage: page } as any); }
});
await check("a wallet-backed company account gets no bank link on behalf, even when its holder has a personal IBAN", async () => {
  const acc = { identifier: { ...(await store.accountsOf("org_co")).find((x) => x.id === "acc_co")!.identifier } };
  await store.updateAccount("acc_co", { identifier: {} } as any);
  try {
    const orgCo = (await store.findOrganisation("org_co"))!;
    assert.ok((await store.findUser("u_co"))!.iban, "the holder has a personal IBAN");
    assert.deepEqual(await linkMethods(orgCo, (await store.findUser("u_co"))!, (await store.findUser("u_admin"))!), []);
    assert.ok((await linkMethods(orgCo, (await store.findUser("u_co"))!, (await store.findUser("u_co"))!)).includes("bank"), "the holder's own link still takes their IBAN");
    const before = dbm.db.paymentRequests.length;
    const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["bank"] }, "u_admin");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(dbm.db.paymentRequests.length, before, "no link published");
  } finally { await store.updateAccount("acc_co", { identifier: acc.identifier } as any); }
  await store.updateAccount("acc_co", { identifier: { iban: "DE00000000000000000000" } } as any);
  try {
    assert.deepEqual(await linkMethods((await store.findOrganisation("org_co"))!, (await store.findUser("u_co"))!, (await store.findUser("u_admin"))!), [], "an account IBAN that is not the one published is not enough");
  } finally { await store.updateAccount("acc_co", { identifier: acc.identifier } as any); }
  assert.deepEqual(await linkMethods((await store.findOrganisation("org_co"))!, (await store.findUser("u_co"))!, (await store.findUser("u_admin"))!), ["bank"]);
});
await check("a link on behalf with no active IBAN behind the company says so", async () => {
  await store.updateUser("u_co", { iban: undefined } as any);
  try {
    const list = await call("GET", "/api/orgs/org_co/payment-requests", undefined, "u_admin");
    assert.equal(list.body.payLink.code, "NO_METHOD", JSON.stringify(list.body.payLink));
    assert.match(list.body.payLink.reason, /paid by bank transfer, and its account has no active IBAN yet/);
  } finally { await store.updateUser("u_co", { iban: IBAN } as any); }
});
await check("cancelling an invoice's link needs the invoices capability, as making it does", async () => {
  dbm.db.paymentRequests.push({
    id: "pr_inv_p", code: "INVP", userId: "u_co", orgId: "org_p", invoiceId: "inv_x", currency: "EUR", methods: ["bank"], state: "OPEN",
    cryptoQuotes: [], payments: [], source: { kind: "app" }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now, updatedAt: now,
  } as any);
  // Every org type has invoices today; switch it off to reach the refusal.
  const { CAPABILITIES } = await import("../services/api/src/domain/plans.js");
  (CAPABILITIES.invoices as any).unavailable = "Invoices are switched off here.";
  try {
    const r = await call("POST", "/api/orgs/org_p/payment-requests/pr_inv_p/cancel");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.capability, "invoices");
    assert.equal((await store.findPaymentRequest("pr_inv_p"))!.state, "OPEN");
  } finally {
    delete (CAPABILITIES.invoices as any).unavailable;
    dbm.db.paymentRequests.splice((await store.list("paymentRequests")).findIndex((p) => p.id === "pr_inv_p"), 1);
  }
});
await check("the same code resolves under the payee's own handle, never under another page", async () => {
  assert.equal((await call("GET", `/api/pay/lindner/${pageCode}`, undefined, "")).status, 200);
  assert.equal((await call("GET", `/api/pay/jonas/${pageCode}`, undefined, "")).status, 404);
});
await check("a link made before the page opens under the company's address too", async () => {
  assert.equal((await call("GET", `/api/pay/lindnerholzbau/${code}`, undefined, "")).status, 200);
});
await check("a link whose payee does not back the company does not open under its address", async () => {
  const own = (await store.list("paymentRequests")).find((p) => p.userId === "u_admin" && p.orgId === "org_co")!;
  assert.ok(own, "fixture: the re-booked member link above");
  assert.equal((await call("GET", `/api/pay/lindnerholzbau/${own.code}`, undefined, "")).status, 404);
});
await check("the holder shown is the name Monerium has for the profile", async () => {
  await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_co", kind: "corporate", name: "Lindner Holzbau GmbH & Co. KG", checkedAt: now } } as any);
  try {
    const p = await call("GET", "/api/pay/lindnerholzbau", undefined, "");
    assert.equal(p.body.bank.holder, "Lindner Holzbau GmbH & Co. KG");
  } finally { await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_co", kind: "corporate", name: "Lindner Holzbau GmbH", checkedAt: now } } as any); }
});
await check("a claimed page closes, without bank details, when the profile turns out personal", async () => {
  await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_sara", kind: "personal", name: "Sara Lindner", checkedAt: now } } as any);
  try {
    const p = await call("GET", "/api/pay/lindnerholzbau", undefined, "");
    assert.equal(p.status, 503);
    assert.ok(!JSON.stringify(p.body).includes(IBAN));
  } finally { await store.updateAccount("acc_co", { moneriumProfile: { id: "prof_co", kind: "corporate", name: "Lindner Holzbau GmbH", checkedAt: now } } as any); }
});
await check("a company link stops opening under the company's address once its payee no longer backs the company", async () => {
  await store.updateAccount("acc_co", { backingUserId: "u_admin" } as any);
  try {
    assert.equal((await call("GET", `/api/pay/lindnerholzbau/${pageCode}`, undefined, "")).status, 404);
    assert.equal((await call("GET", `/api/pay/lindner/${pageCode}`, undefined, "")).status, 200, "the payee's own address still opens it");
  } finally { await store.updateAccount("acc_co", { backingUserId: "u_co" } as any); }
});
await check("a member cannot then claim the company's handle for a personal page", async () => {
  const r = await call("POST", "/api/users/u_admin/handle", { handle: "lindnerholzbau" }, "u_admin");
  assert.equal(r.status, 409);
});
// The names the handle rules refuse: staff and partner names, an address, and
// bidi or other format and control characters.
const BORROWED_NAMES = ["Zold Support", "Monerium Refunds", "Z0LD Pay", `0x${"11".repeat(19)}`, "Anna\u202Eagerot\u202C", "Anna\u200BLee", "Anna\u0007Lee"];
await check("a display name the handle rules would refuse is refused on a company page", async () => {
  for (const displayName of BORROWED_NAMES) {
    const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindnerholzbau", displayName });
    assert.equal(r.status, 400, `${JSON.stringify(displayName)}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call("GET", "/api/pay/lindnerholzbau", undefined, "")).body.displayName, "Lindner Holzbau GmbH");
});
await check("and on a personal page", async () => {
  for (const displayName of BORROWED_NAMES) {
    const r = await call("POST", "/api/users/u_admin/handle", { handle: "jonas-weber", displayName }, "u_admin");
    assert.equal(r.status, 400, `${JSON.stringify(displayName)}: ${JSON.stringify(r.body)}`);
  }
});
await check("an ordinary company display name is still accepted", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-page", { handle: "lindnerholzbau", displayName: "Lindner Holzbau & Söhne" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call("GET", "/api/pay/lindnerholzbau", undefined, "")).body.displayName, "Lindner Holzbau & Söhne");
});
await check("a stored display name the rules refuse is not served, and is kept", async () => {
  const org = (await store.findOrganisation("org_co"))!;
  await store.updateOrganisation("org_co", { paymentPage: { ...org.paymentPage!, displayName: "Zold Support" } });
  await store.updateUser("u_admin", { paymentPage: { ...(await store.findUser("u_admin"))!.paymentPage!, displayName: "Monerium\u202E" } } as any);
  try {
    assert.equal((await call("GET", "/api/pay/lindnerholzbau", undefined, "")).body.displayName, "Lindner Holzbau GmbH");
    const own = (await store.list("paymentRequests")).find((p) => p.userId === "u_admin" && !p.orgId)!;
    const pub = await call("GET", `/api/pay/jonas/${own.code}`, undefined, "");
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.displayName, undefined);
    assert.equal((await store.findOrganisation("org_co"))!.paymentPage!.displayName, "Zold Support");
  } finally { await store.updateOrganisation("org_co", { paymentPage: { ...org.paymentPage! } }); }
});
await check("the page closes, without bank details, while the account is not active", async () => {
  await store.updateAccount("acc_co", { status: "gated" } as any);
  try {
    const p = await call("GET", "/api/pay/lindnerholzbau", undefined, "");
    assert.equal(p.status, 503);
    assert.ok(!JSON.stringify(p.body).includes(IBAN));
  } finally { await store.updateAccount("acc_co", { status: "active" } as any); }
});

console.log("invoice IBAN");
await check("an empty profile IBAN prints the account's own", async () => {
  const r = await call("GET", "/api/orgs/org_co/invoicing/profile");
  assert.equal(r.body.invoiceBank.iban, IBAN);
  assert.equal(r.body.invoiceBank.holder, "Lindner Holzbau GmbH");
  assert.equal(r.body.accountBank.iban, IBAN);
});
await check("an IBAN set in the profile is printed instead, and the account's is still reported", async () => {
  const other = "DE02120300000000202051";
  // Set in the store: changing it through the route takes a passkey
  // approval, which payment-review-test exercises.
  await store.updateOrganisation("org_co", { invoicing: { ...(await store.findOrganisation("org_co"))!.invoicing, bank: { iban: other } } });
  const r = await call("GET", "/api/orgs/org_co/invoicing/profile");
  assert.equal(r.body.invoiceBank.iban, other);
  assert.equal(r.body.accountBank.iban, IBAN);
});

console.log("a company's own account");
{
  const CO_SAFE = `0x${"dd".repeat(20)}` as const;
  const CO_IBAN = "DE02120300000000202051";
  await store.addOrganisation(companyOrg("org_own", "Weber Bau", "Weber Bau GmbH"));
  await store.addMember(member("m8", "org_own", "u_co", "owner"));
  await store.addMember(member("m9", "org_own", "u_admin", "admin"));
  await store.addMember(member("m10", "org_own", "u_view", "viewer"));
  await store.addAccount(activeEurAccount("acc_own", "org_own", { iban: CO_IBAN, address: CO_SAFE }));
  await store.addInvoice({
    id: "inv_own", direction: "outgoing", orgId: "org_own", linkTokenHash: "y", state: "SUBMITTED", lines: [], currency: "EUR", total: "238.00",
    supplier: { orgName: "Weber Bau GmbH", email: "", invoiceNumber: "WB-2026-0001" },
    issued: { number: "WB-2026-0001", issueDate: "2026-11-02", grossCents: 23800, netCents: 20000, vatCents: 3800, currency: "EUR" },
    createdAt: now, updatedAt: now,
  } as any);
  const offer = async (u = "u_admin") => (await call("GET", "/api/orgs/org_own/payment-requests", undefined, u)).body.payLink;

  await check("an IBAN not yet on the company's verified profile makes no link, and the reason names no wallet", async () => {
    const o = await offer();
    assert.equal(o.allowed, false);
    assert.equal(o.code, "ACCOUNT_NOT_OPEN");
    assert.doesNotMatch(o.reason, /wallet/);
    assert.equal((await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 40 }, "u_admin")).status, 409);
  });
  await check("verified but with no company page, the link waits for the page", async () => {
    await store.updateAccount("acc_own", { moneriumProfile: { id: "prof_wb", kind: "corporate", name: "Weber Bau GmbH", checkedAt: now } } as any);
    const o = await offer();
    assert.equal(o.allowed, false);
    assert.equal(o.code, "NO_COMPANY_PAGE");
    assert.equal((await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 40 }, "u_admin")).status, 409);
  });
  let ownCode = "";
  await check("with its page, any member who manages invoices makes a bank-only link into the company account", async () => {
    assert.equal((await call("POST", "/api/orgs/org_own/payment-page", { handle: "weber-bau" })).status, 200);
    assert.deepEqual(await offer(), { allowed: true });
    assert.equal((await call("GET", "/api/orgs/org_own/invoices", undefined, "u_admin")).body.payLink?.allowed, true, "the invoice list offers Payment link");
    const r = await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 40 }, "u_admin");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.url, /\/pay\/weber-bau\//);
    const link = (await store.findPaymentRequest(r.body.id))!;
    assert.equal(link.accountId, "acc_own");
    assert.equal(link.userId, "u_admin", "the member who made it");
    assert.equal(link.createdBy, undefined);
    assert.deepEqual(link.methods, ["bank"]);
    ownCode = r.body.code;
    const crypto = await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 40, methods: ["crypto"] }, "u_admin");
    assert.equal(crypto.status, 409, JSON.stringify(crypto.body));
    assert.equal((await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 40 }, "u_view")).status, 403);
  });
  await check("the payer sees the company's IBAN under its name, and nothing of the member who made it", async () => {
    const pub = await call("GET", `/api/pay/weber-bau/${ownCode}`, undefined, "");
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual(Object.keys(pub.body.methods), ["bank"]);
    assert.equal(pub.body.methods.bank.iban, CO_IBAN);
    assert.equal(pub.body.methods.bank.holder, "Weber Bau GmbH");
    assert.equal(pub.body.displayName, "Weber Bau GmbH");
    const json = JSON.stringify(pub.body);
    for (const secret of ["u_admin", "acc_own", "org_own", "accountId", (await store.findUser("u_admin"))!.iban, IBAN, CO_SAFE, `0x${"bb".repeat(20)}`, "Jonas", "jonas"]) {
      assert.ok(!json.includes(secret), `leaked ${secret}`);
    }
    assert.equal((await call("GET", `/api/pay/jonas/${ownCode}`, undefined, "")).status, 404, "never under the creator's personal page");
    assert.equal((await fetch(`${API}/api/pay/weber-bau/${ownCode}/sepa-qr.svg`)).status, 200);
    assert.equal((await fetch(`${API}/api/pay/weber-bau/${ownCode}/qr.svg`)).status, 404);
  });
  await check("a company link is not its creator's: not in their list, their routes or their matching", async () => {
    const id = (await store.findPaymentRequestByCode(ownCode))!.id;
    const mine = await call("GET", "/api/users/u_admin/payment-requests", undefined, "u_admin");
    assert.ok(!mine.body.requests.some((x: any) => x.id === id));
    assert.equal((await call("GET", `/api/users/u_admin/payment-requests/${id}`, undefined, "u_admin")).status, 404);
    assert.equal((await call("POST", `/api/users/u_admin/payment-requests/${id}/cancel`, undefined, "u_admin")).status, 404);
    assert.ok(!(await store.paymentRequestsForUser("u_admin")).some((x) => x.id === id));
  });
  await check("an issued invoice gets its link into the company account, for its amount", async () => {
    const r = await call("POST", "/api/orgs/org_own/payment-requests", { invoiceId: "inv_own" }, "u_co");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.amountEur, 238);
    assert.equal((await store.findPaymentRequest(r.body.id))!.accountId, "acc_own");
  });
  await check("an invoice paid through its link gets no second link before the bank credit settles it", async () => {
    const link = (await store.list("paymentRequests")).find((x) => x.invoiceId === "inv_own")!;
    await store.updatePaymentRequest(link.id, { state: "PAID" } as any);
    try {
      const again = await call("POST", "/api/orgs/org_own/payment-requests", { invoiceId: "inv_own" }, "u_co");
      assert.equal(again.status, 409, JSON.stringify(again.body));
      assert.match(again.body.error, /already been paid through its payment link/);
    } finally { await store.updatePaymentRequest(link.id, { state: "OPEN" } as any); }
  });
  await check("a price like €19.99 is whole cents; €19.991 is not", async () => {
    const ok = await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: "19.99" }, "u_admin");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.amountEur, 19.99);
    assert.equal((await call("POST", "/api/orgs/org_own/payment-requests", { amountEur: 19.991 }, "u_admin")).status, 400);
  });
  await check("the company's former handle, claimed by the creator, never opens a company link", async () => {
    const org = (await store.findOrganisation("org_own"))!;
    const u = (await store.findUser("u_admin"))!;
    await store.updateOrganisation("org_own", { paymentPage: { ...org.paymentPage!, handle: "weber-bau-gmbh" } });
    await store.updateUser("u_admin", { paymentPage: { ...u.paymentPage!, handle: "weber-bau" } } as any);
    try {
      assert.equal((await call("GET", `/api/pay/weber-bau/${ownCode}`, undefined, "")).status, 404);
      assert.equal((await call("GET", `/api/pay/weber-bau-gmbh/${ownCode}`, undefined, "")).status, 200);
      // Copy link and the invoice's Payment link hand out the address that opens now.
      const listed = (await call("GET", "/api/orgs/org_own/payment-requests", undefined, "u_admin")).body.paymentRequests.find((x: any) => x.code === ownCode);
      assert.match(listed.url, /\/pay\/weber-bau-gmbh\//);
      const reused = await call("POST", "/api/orgs/org_own/payment-requests", { invoiceId: "inv_own" }, "u_co");
      assert.equal(reused.body.reused, true, JSON.stringify(reused.body));
      assert.match(reused.body.url, /\/pay\/weber-bau-gmbh\//);
      const path = new URL(reused.body.url).pathname;
      assert.equal((await call("GET", `/api${path}`, undefined, "")).status, 200, "the reused URL resolves");
    } finally {
      await store.updateUser("u_admin", { paymentPage: u.paymentPage } as any);
      await store.updateOrganisation("org_own", { paymentPage: org.paymentPage });
    }
  });
  await check("once the IBAN is no longer the company's verified one, no link is offered and open ones stop resolving", async () => {
    assert.ok(await openLinkPath({ id: "inv_own", orgId: "org_own" }), "the Pay button while the account qualifies");
    await store.updateAccount("acc_own", { moneriumProfile: { id: "prof_x", kind: "personal", name: "Sara Lindner", checkedAt: now } } as any);
    assert.equal((await offer()).allowed, false);
    assert.equal((await call("GET", `/api/pay/weber-bau/${ownCode}`, undefined, "")).status, 404);
    assert.equal(await openLinkPath({ id: "inv_own", orgId: "org_own" }), undefined, "no Pay button that leads to a 404");
  });
  await check("a company link without its account's bank details shows none, never the creator's", async () => {
    const { publicPaymentRequest } = await import("../services/api/src/payment-requests.js");
    const r = (await store.findPaymentRequestByCode(ownCode))!;
    const u = (await store.findUser("u_admin"))!;
    const pub = publicPaymentRequest(r, u, { chainId: 31337, token: { symbol: "USDC", address: SAFE, decimals: 6 }, baseUrl: "http://x", cryptoLive: true });
    assert.deepEqual(pub.methods, {});
    assert.equal(pub.displayName, undefined);
  });
}

server.close();
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\norg accounts: all checks passed");
