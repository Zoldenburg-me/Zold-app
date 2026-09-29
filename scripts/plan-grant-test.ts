/**
 * A paid plan cannot be self-granted.
 *
 * There is no billing, so an owner clicking "Choose Business" must not get
 * Business: that is a paywall which charges nothing. Downgrading and the one
 * trial stay self-serve; a paid plan is an operator grant.
 *
 * Offline: in-process express on an ephemeral port and a throwaway db.
 *
 *   npm run plan:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-plan-")), "db.json");
const OPERATOR = "operator-token-for-plan-test-0123456789";
process.env.KYC_OPERATOR_TOKEN = OPERATOR;

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createAdminRouter } = await import("../services/api/src/routes/admin.js");

initStore();
const now = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
store.addUser({ id: "u_owner", name: "Owner", country: "DE", kycStatus: "approved", address: `0x${"aa".repeat(20)}`, createdAt: now } as any);
store.addOrganisation({ id: "org_b", type: "business", name: "Starter GmbH", plan: "starter", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
store.addOrganisation({ id: "org_p", type: "personal", name: "Me", plan: "premium", reporting, verifications: {}, createdAt: now, updatedAt: now } as any);
store.addMember({ id: "m_b", orgId: "org_b", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
store.addMember({ id: "m_p", orgId: "org_p", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession));
app.use("/api", createAdminRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (p: string, body: unknown, headers: Record<string, string>) => {
  const res = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const asOwner = { "x-user": "u_owner" };

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`FAIL  ${name}\n      ${(err as Error).message}`); }
}

await check("an owner cannot switch a business org onto the paid plan", async () => {
  const r = await call("/api/orgs/org_b/plan", { plan: "business" }, asOwner);
  assert.equal(r.status, 402);
  assert.equal(r.data.code, "PAID_PLAN_NEEDS_GRANT");
  assert.equal(store.findOrganisation("org_b")!.plan, "starter");
});
await check("the trial is still self-serve", async () => {
  const r = await call("/api/orgs/org_b/plan/trial", {}, asOwner);
  assert.equal(r.status, 200);
  assert.equal(store.findOrganisation("org_b")!.plan, "starter", "a trial is a grant, not a plan change");
});
await check("downgrading to the free plan stays open", async () => {
  const r = await call("/api/orgs/org_p/plan", { plan: "starter" }, asOwner);
  assert.equal(r.status, 200);
  assert.equal(store.findOrganisation("org_p")!.plan, "starter");
});
await check("the operator route refuses without the operator token", async () => {
  assert.equal((await call("/api/admin/orgs/org_b/plan", { plan: "business" }, asOwner)).status, 401);
  assert.equal((await call("/api/admin/orgs/org_b/plan", { plan: "business" }, { authorization: "Bearer wrong-token-of-sufficient-length-00" })).status, 401);
  assert.equal(store.findOrganisation("org_b")!.plan, "starter");
});
await check("the operator can grant a paid plan, and it supersedes a running trial", async () => {
  const r = await call("/api/admin/orgs/org_b/plan", { plan: "business" }, { authorization: `Bearer ${OPERATOR}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const org = store.findOrganisation("org_b")!;
  assert.equal(org.plan, "business");
  assert.ok(org.trial?.endedAt, "the trial is ended, not stacked");
});
await check("the operator cannot grant a plan the org type cannot hold", async () => {
  const r = await call("/api/admin/orgs/org_b/plan", { plan: "premium" }, { authorization: `Bearer ${OPERATOR}` });
  assert.equal(r.status, 400);
});

server.close();
if (failed) { console.error(`\nPLAN GRANT TEST FAILED — ${failed} check(s)`); process.exit(1); }
console.log("\nPLAN GRANT TEST PASSED — 6/6: a paid plan is granted by the operator, never by a click");
