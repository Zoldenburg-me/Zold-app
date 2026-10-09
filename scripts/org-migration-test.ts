/**
 * The boot-time migration that gives a user with no organisation a personal
 * space follows the rule POST /api/orgs follows: a company login has no
 * personal space. Its Safe and IBAN are the company's, so a personal org
 * backed by them would put one Safe behind a personal and a business org.
 *
 * Seeds an existing store file, then loads it with initStore() as a process
 * start does. No chain, no network.
 *
 * Run: npm run org-migration:test
 */
// Must be first: pins the local chain before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-migration-")), "db.json");

const now = new Date().toISOString();
const funded = (id: string, extra: Record<string, unknown>) => ({
  id, name: id, country: "DE", kycStatus: "approved", createdAt: now,
  email: `${id}@example.com`, iban: "DE89370400440532013000",
  address: `0x${id.padEnd(40, "0").slice(0, 40)}`,
  funding: { status: "active" },
  ...extra,
});
// Both logins finished onboarding (Safe, IBAN active) but have no
// organisation yet: the company login's business org was never created.
writeFileSync(process.env.TRANSF_DB_PATH, JSON.stringify({
  users: [funded("u_company", { accountType: "company" }), funded("u_person", {})],
  quotes: [],
  transfers: [],
  sessions: [],
}));

const { initStore, store } = await import("../services/api/src/store.js");
initStore();

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${label}`);
};

console.log("boot migration and company logins");
{
  const orgs = store.organisationsForUser("u_company").map((x) => x.org);
  check("a company login gets no personal space", !orgs.some((o) => o.type === "personal"), JSON.stringify(orgs.map((o) => o.type)));
  const backed = store.accounts.filter((a: any) => a.backingUserId === "u_company");
  check("and no account is backed by its Safe", backed.length === 0, `${backed.length} account(s)`);
}
{
  const orgs = store.organisationsForUser("u_person").map((x) => x.org);
  check("a person still gets their personal space", orgs.length === 1 && orgs[0].type === "personal");
  const acc = store.accounts.find((a: any) => a.orgId === orgs[0].id);
  check("backed by their own Safe, open since their funding is", acc?.backingUserId === "u_person" && acc?.status === "active");
}
console.log(`\norg migration: ${passed}/${passed} checks passed`);
