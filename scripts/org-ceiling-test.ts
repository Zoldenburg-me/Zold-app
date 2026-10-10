/**
 * One person may own at most CEILINGS.businessOrgsPerUser business orgs.
 *
 * Every per-org ceiling (ledger rows, contacts, drafts) bounds one org, and
 * every row lives in one shared file; without a cap on orgs, a user who opens
 * org after org multiplies each of them. Asserts:
 *   1. the orgs up to the ceiling are created, the next answers 409 LIMIT_REACHED
 *   2. only business orgs the user OWNS count: a personal org and an org they
 *      were only invited to do not
 *   3. another user is unaffected
 *
 * Run: npm run org-ceiling:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-org-ceiling-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// Config refuses hardhat's public key on a remote RPC; nothing here dials it.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";
process.env.WALLET_SYNC_ENABLED = "0";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { CEILINGS } = await import("../services/api/src/domain/ceilings.js");
initStore();

const NOW = new Date().toISOString();
for (const id of ["u_many", "u_other"]) {
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", accountType: "personal", createdAt: NOW } as any);
}

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user") as string | undefined;
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;

async function createOrg(asUser: string, type: "business" | "personal", n: number) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": asUser },
    body: JSON.stringify({ name: `${type} org ${n}`, type, country: "DE" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

const max = CEILINGS.businessOrgsPerUser;

await check("an org the user was only invited to does not count", async () => {
  const theirs = await createOrg("u_other", "business", 0);
  assert.ok(theirs.status < 300, `u_other could not create an org: ${theirs.status}`);
  store.addMember({
    id: "mem_invited",
    orgId: theirs.body.org?.id ?? theirs.body.id,
    userId: "u_many",
    email: "",
    role: "admin",
    status: "active",
    invitedAt: NOW,
    acceptedAt: NOW,
  } as any);
});

await check(`up to ${max} business orgs are created`, async () => {
  for (let i = 1; i <= max; i++) {
    const r = await createOrg("u_many", "business", i);
    assert.ok(r.status < 300, `org ${i} answered ${r.status}: ${JSON.stringify(r.body)}`);
  }
});

await check("the next business org is refused with LIMIT_REACHED", async () => {
  const r = await createOrg("u_many", "business", max + 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LIMIT_REACHED");
  assert.equal(r.body.limit, max);
  const owned = store.organisationsForUser("u_many").filter(({ org, member }) => org.type === "business" && member.role === "owner");
  assert.equal(owned.length, max);
});

await check("a personal org is not a business org and is still allowed", async () => {
  const r = await createOrg("u_many", "personal", 1);
  assert.ok(r.status < 300, `personal org answered ${r.status}: ${JSON.stringify(r.body)}`);
});

await check("another user is unaffected", async () => {
  const r = await createOrg("u_other", "business", 1);
  assert.ok(r.status < 300, `u_other answered ${r.status}`);
});

server.close();
if (failed) {
  console.error(`org-ceiling: ${failed} failed`);
  process.exit(1);
}
console.log("org-ceiling: all passed");
process.exit(0);
