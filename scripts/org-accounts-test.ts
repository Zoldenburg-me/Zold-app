/**
 * An organisation's accounts screen, payment links and invoice IBAN.
 *
 * - An account's "why it cannot send" text is worked out when it is read, so
 *   a row opened under older wording shows today's.
 * - A business account waiting on Monerium says so, from the latest answer.
 * - A company makes its own payment links, for an issued invoice too; only
 *   the member whose Safe backs the account can, and the payer sees the
 *   company as the account holder.
 * - Invoices print the account's own IBAN unless the profile names another.
 *
 *   npm run org-accounts:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-accounts-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { createPaymentRequestRouter } = await import("../services/api/src/routes/payment-requests.js");
const { accountIsSpendable } = await import("../services/api/src/domain/accounts.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

initStore();
const now = new Date().toISOString();
const SAFE = `0x${"aa".repeat(20)}`;
const IBAN = "DE89370400440532013000";
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;

// A company signup: their Safe holds the company's IBAN, the corporate profile
// is still pending at Monerium as of connect.
store.addUser({
  id: "u_co", name: "Sara Lindner", country: "DE", kycStatus: "approved", accountType: "company",
  address: SAFE, iban: IBAN, funding: { status: "active", moneriumProfileId: "prof_co" },
  paymentPage: { handle: "lindner", depositAddress: SAFE },
  monerium: { connectedAt: "2026-10-01T09:00:00.000Z", profileId: "prof_co", profiles: [{ id: "prof_co", kind: "corporate", state: "pending" }] },
  createdAt: now,
} as any);
store.addUser({ id: "u_admin", name: "Jonas Weber", country: "DE", kycStatus: "approved", address: `0x${"bb".repeat(20)}`, createdAt: now } as any);

const addOrg = (id: string, type: "business" | "personal", name: string, legalName?: string) =>
  store.addOrganisation({ id, type, name, ...(legalName ? { legalName } : {}), plan: "business", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
addOrg("org_new", "business", "Lindner Neu");
addOrg("org_co", "business", "Lindner", "Lindner Holzbau GmbH");
addOrg("org_p", "personal", "Sara Lindner");
const member = (id: string, orgId: string, userId: string, role: string) =>
  store.addMember({ id, orgId, userId, email: "", role, status: "active", invitedAt: now, acceptedAt: now } as any);
member("m1", "org_new", "u_co", "owner");
member("m2", "org_co", "u_co", "owner");
member("m3", "org_co", "u_admin", "admin");
member("m4", "org_p", "u_co", "owner");

// Opened under older wording: the stored gate text is stale.
store.addAccount({
  id: "acc_old", orgId: "org_new", currency: "EUR", label: "main", status: "gated", provider: "monerium", identifier: {},
  gate: { reason: "This account has no funding identity, so nothing can be sent from it.", needs: "per-organisation account provisioning, which is not built." },
  createdAt: now, updatedAt: now,
} as any);
store.addAccount({
  id: "acc_co", orgId: "org_co", currency: "EUR", label: "main", status: "active", provider: "monerium",
  identifier: { iban: IBAN }, address: SAFE, backingUserId: "u_co", createdAt: now, updatedAt: now,
} as any);
store.addInvoice({
  id: "inv_1", direction: "outgoing", orgId: "org_co", linkTokenHash: "x", state: "SUBMITTED", lines: [], currency: "EUR", total: "119.00",
  supplier: { orgName: "Lindner Holzbau GmbH", email: "", invoiceNumber: "RE-2026-0007" },
  issued: { number: "RE-2026-0007", issueDate: "2026-10-02", grossCents: 11900, netCents: 10000, vatCents: 1900, currency: "EUR" },
  createdAt: now, updatedAt: now,
} as any);

const app = express();
app.use(express.json());
const who = (req: any) => req.header("x-user") as string | undefined;
const requireSession = (req: any, res: any) => {
  const id = who(req);
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const requireUserSession = (req: any, res: any, userId: string) => {
  if (who(req) === userId) return true;
  res.status(401).json({ error: "no session" });
  return false;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
app.use("/api", createPaymentRequestRouter(requireUserSession));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_co") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

console.log("accounts");
await check("an account opened under older wording shows today's reason", async () => {
  const r = await call("GET", "/api/orgs/org_new/accounts");
  const a = r.body.accounts.find((x: any) => x.id === "acc_old");
  assert.match(a.gate.reason, /No IBAN is connected/);
  assert.match(a.gate.needs, /company profile at Monerium/);
  assert.doesNotMatch(JSON.stringify(a), /not built|funding identity/);
  assert.match(accountIsSpendable(a).reason!, /No IBAN is connected/);
});
await check("a company profile still pending at Monerium is on the screen, with when that was seen", async () => {
  const r = await call("GET", "/api/orgs/org_new/accounts");
  assert.deepEqual(r.body.profileWait, { state: "pending", at: "2026-10-01T09:00:00.000Z" });
});
await check("Monerium's newer answer wins over the snapshot from connect", async () => {
  const u = store.findUser("u_co")!;
  store.updateUser("u_co", { monerium: { ...u.monerium!, profileSeen: { id: "prof_co", kind: "corporate", state: "approved", at: now } } });
  const r = await call("GET", "/api/orgs/org_new/accounts");
  assert.equal(r.body.profileWait, undefined);
});

console.log("payment links");
await check("only the member whose Safe backs the account can make a company's link", async () => {
  const r = await call("POST", "/api/orgs/org_co/payment-requests", { amountEur: 50, methods: ["bank"] }, "u_admin");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "NOT_THE_PAYEE");
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

console.log("invoice IBAN");
await check("an empty profile IBAN prints the account's own", async () => {
  const r = await call("GET", "/api/orgs/org_co/invoicing/profile");
  assert.equal(r.body.invoiceBank.iban, IBAN);
  assert.equal(r.body.invoiceBank.holder, "Lindner Holzbau GmbH");
  assert.equal(r.body.accountBank.iban, IBAN);
});
await check("an IBAN set in the profile is printed instead, and the account's is still reported", async () => {
  const other = "DE02120300000000202051";
  const put = await call("PATCH", "/api/orgs/org_co/invoicing/profile", { bank: { iban: other } });
  assert.ok(put.status < 300, JSON.stringify(put.body));
  const r = await call("GET", "/api/orgs/org_co/invoicing/profile");
  assert.equal(r.body.invoiceBank.iban, other);
  assert.equal(r.body.accountBank.iban, IBAN);
});

server.close();
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\norg accounts: all checks passed");
