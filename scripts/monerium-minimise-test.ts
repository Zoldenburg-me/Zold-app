/**
 * The one-off Monerium minimisation (services/api/src/users/minimise-monerium.ts)
 * on the JSON store and on Postgres over PGlite: a row stored with the whole
 * login's lists keeps only this Safe's entries, every other field and row
 * stays, and a second run changes nothing.  npm run monerium:minimise:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-minimise-")), "db.json");
const { initStore, store } = await import("../services/api/src/store.js");
const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { migrate } = await import("../services/api/src/store/pg/migrate.js");
const { pgliteDatabase } = await import("../services/api/src/store/pg/sql.js");
const { MONERIUM } = await import("../services/api/src/config.js");
const { auditEntry } = await import("../services/api/src/audit.js");
const { minimiseStoredMonerium } = await import("../services/api/src/users/minimise-monerium.js");
type Backend = typeof store;

const SAFE = `0x${"aa".repeat(20)}`;
const OTHER = `0x${"7e".repeat(20)}`;
const now = new Date().toISOString();
const chain = MONERIUM.chain;

async function run(name: string, s: Backend) {
  await s.addUser({
    id: "u_m", name: "Ada", email: "ada@example.com", country: "DE", address: SAFE, iban: "DE89370400440532013000", kycStatus: "approved", createdAt: now,
    monerium: {
      connectedAt: now, method: "oauth", profileId: "p1", accessTokenEnc: "v2.t1.sealed", accountEmail: "ada@example.com",
      context: { userId: "m1", email: "ada@example.com", roles: [{ profile: "p1" }, { profile: "p2" }] },
      profiles: [{ id: "p1", kind: "personal", name: "Ada L", state: "approved", perms: ["read"] }, { id: "p2", kind: "corporate", name: "Ada Co", state: "approved" }],
      ibans: [
        { iban: "DE89370400440532013000", bic: "MONEDEB1", profile: "p1", address: SAFE, chain, name: "Ada L", state: "approved" },
        { iban: "DE12500105170648489890", profile: "p1", address: OTHER, chain },
        { iban: "DE02120300000000202051", profile: "p1", address: SAFE, chain: "other-chain" },
      ],
      addresses: [{ address: SAFE, profile: "p1", chains: [chain] }, { address: OTHER, profile: "p1", chains: ["gnosis"] }],
    },
  } as any);
  await s.addUser({ id: "u_plain", name: "Bo", email: "bo@example.com", address: `0x${"bb".repeat(20)}`, iban: "", createdAt: now } as any);
  await s.audit(auditEntry("partner.credentials_connected", { partner: "monerium", profileId: "p1" }, "u_m"));
  const auditBefore = JSON.stringify(await s.auditFor("u_m", 10));
  const plainBefore = JSON.stringify(await s.findUser("u_plain"));

  assert.deepEqual(await minimiseStoredMonerium(s), { checked: 1, changed: 1 }, `${name}: one row rewritten`);
  const m: any = (await s.findUser("u_m"))!.monerium;
  const text = JSON.stringify(m).toLowerCase();
  for (const gone of [OTHER, "de12500105170648489890", "de02120300000000202051", "ada co", "perms", "roles"]) {
    assert.ok(!text.includes(gone), `${name}: ${gone} left on the row`);
  }
  assert.equal("context" in m, false, `${name}: the auth context is dropped`);
  assert.deepEqual(m.profiles, [{ id: "p1", kind: "personal", name: "Ada L", state: "approved" }, { id: "p2", kind: "corporate" }]);
  assert.deepEqual(m.ibans, [{ iban: "DE89370400440532013000", bic: "MONEDEB1", profile: "p1", address: SAFE, chain, name: "Ada L", state: "approved" }]);
  assert.deepEqual(m.addresses, [{ address: SAFE, profile: "p1", chains: [chain] }]);
  assert.equal(m.accessTokenEnc, "v2.t1.sealed", `${name}: the token stays`);
  assert.equal(m.accountEmail, "ada@example.com");
  const u = (await s.findUser("u_m"))!;
  assert.equal(u.iban, "DE89370400440532013000", `${name}: the account's IBAN stays`);
  assert.equal(u.kycStatus, "approved");
  assert.equal(JSON.stringify(await s.findUser("u_plain")), plainBefore, `${name}: a row without Monerium is untouched`);
  assert.equal(JSON.stringify(await s.auditFor("u_m", 10)), auditBefore, `${name}: no audit row changes`);
  assert.equal((await s.list("users")).length, 2, `${name}: no row deleted`);

  assert.deepEqual(await minimiseStoredMonerium(s), { checked: 1, changed: 0 }, `${name}: a second run changes nothing`);
  console.log(`ok - ${name}: only the Safe's entries are left, nothing else changed`);
}

await initStore();
await run("JSON store", store);
const db = pgliteDatabase((await PGlite.create()) as never);
await migrate(db);
await run("Postgres (PGlite)", createPgStore(db));
console.log("MONERIUM MINIMISE TEST PASSED");
process.exit(0);
