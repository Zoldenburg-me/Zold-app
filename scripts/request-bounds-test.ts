/**
 * Bounds on what a caller chooses: the monthly-balance report's range, and
 * the origin absolute links are built on.
 *
 * The report walks every month from `from` to `to`, so an unchecked `to`
 * (year 99999) is a loop the caller sizes. Absolute links built from the Host
 * header point wherever the caller says; production builds them only from
 * TRANSF_PUBLIC_URL.
 *
 * Offline: an in-process express app and a throwaway db.
 *
 * Run: npm run bounds:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-request-bounds-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { baseUrlFrom } = await import("../services/api/src/routes/payment-requests.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

initStore();
const now = new Date().toISOString();
store.addUser({ id: "u_owner", name: "Olga Owner", country: "DE", kycStatus: "approved", createdAt: now } as any);
store.addOrganisation({
  id: "org_b", type: "business", name: "Acme", plan: "business",
  reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now,
} as any);
store.addMember({ id: "m_b", orgId: "org_b", userId: "u_owner", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now } as any);
const lastMonth = new Date();
lastMonth.setMonth(lastMonth.getMonth() - 1);
store.addLedgerEntries([{
  id: "le_1", orgId: "org_b", source: { kind: "wallet", walletId: "iw_a" }, chainId: 8453,
  txHash: `0x${"1".padStart(64, "0")}`, logIndex: 0, direction: "in", asset: "USDC", amount: "10",
  fiatValue: "9", fiatCurrency: "EUR", fiatRate: "0.9", counterparty: { address: `0x${"dd".repeat(20)}` },
  tags: ["wallet"], txType: "transfer_in", at: lastMonth.toISOString(), createdAt: now,
} as any]);

const app = express();
app.use(express.json());
app.use("/api/orgs", createBusinessRouter(((req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
}) as any, (async () => { throw new Error("no transfers here"); }) as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const report = async (query: string) => {
  const res = await fetch(`${API}/api/orgs/org_b/reports/monthly-balance?${query}`, { headers: { "x-user": "u_owner" } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const month = (d: Date) => d.toISOString().slice(0, 7);

console.log("monthly-balance range");
await check("a range inside the plan window answers rows", async () => {
  const r = await report(`from=${month(lastMonth)}&to=${month(new Date())}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.rows.length >= 1);
});
await check("no range at all still answers, from the plan window to the last activity", async () => {
  const r = await report("");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rows[0].month, month(lastMonth));
});
await check("a `to` far in the future is a 400, not a walk to it", async () => {
  const started = Date.now();
  const r = await report("to=99999-12");
  assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
  assert.ok(Date.now() - started < 2_000);
  const next = new Date();
  next.setMonth(next.getMonth() + 2);
  const later = await report(`to=${month(next)}`);
  assert.equal(later.status, 400, JSON.stringify(later.body).slice(0, 200));
  assert.equal(later.body.field, "to");
});
await check("a malformed month is a 400", async () => {
  for (const q of ["to=2026-13", "to=2026-1", "from=garbage", "to=2026-01-01", "from=0000-00"]) {
    const r = await report(q);
    assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
});
await check("`to` before the start of the report is a 400", async () => {
  const r = await report(`from=${month(new Date())}&to=${month(lastMonth)}`);
  assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
});

console.log("absolute link origin");
const fakeReq = { protocol: "https", get: (h: string) => (h === "host" ? "attacker.example" : undefined) } as any;
await check("a configured public URL is used whatever the Host header says", () => {
  assert.equal(baseUrlFrom("https://zoldhq.com", true, fakeReq), "https://zoldhq.com");
  assert.equal(baseUrlFrom("https://zoldhq.com", false, fakeReq), "https://zoldhq.com");
});
await check("in production without a public URL no link is built from the Host header", () => {
  assert.throws(() => baseUrlFrom("", true, fakeReq), /TRANSF_PUBLIC_URL/);
});
await check("locally the Host header stands in", () => {
  assert.equal(baseUrlFrom("", false, fakeReq), "https://attacker.example");
});

server.close();
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nrequest bounds: all checks passed");
