/**
 * The importer, export and verify of docs/postgres-store-design.md §6
 * (services/api/src/store/pg/port.ts, scripts/pg-import.ts), offline: the
 * pre-import report's rules on hand-made stores, each with a case that finds
 * and one that does not; the round trip import → export → verify on PGlite
 * over a store the store's own code wrote (_import-fixture.ts); a dirty
 * source refused; a failure mid-import leaving the target empty; the report
 * CLI on a db.json alone, printing ids and no values. The same import on a
 * real Postgres 17, with the start lock and a killed connection, is in
 * store-pg-test.ts (check:pg).   npm run pg-import:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const tmp = mkdtempSync(path.join(tmpdir(), "zold-pg-import-"));
process.env.TRANSF_DB_PATH = path.join(tmp, "unused.json");
const ROOT = new URL("..", import.meta.url).pathname;

const { emptyDb, loadMigratedSnapshot } = await import("../services/api/src/store/db.js");
const { migrate } = await import("../services/api/src/store/pg/migrate.js");
const { pgliteDatabase } = await import("../services/api/src/store/pg/sql.js");
const { digest, exportDb, ImportRefused, importSnapshot, preImportReport, readLedgerHistory, verifyAgainst } = await import("../services/api/src/store/pg/port.js");
type Db = ReturnType<typeof emptyDb>;

const pglite = async () => pgliteDatabase((await PGlite.create()) as never);
const now = "2026-11-26T10:00:00.000Z";

// ── The report, on a small clean store and one dirty row at a time ─────────
const base = (): Db =>
  ({
    ...emptyDb(),
    users: [
      { id: "u1", address: "0xAa", passkey: { credentialId: "cred-1" }, paymentPage: { handle: "ada" }, email: "ada@example.org", createdAt: now },
      { id: "u2", address: "0xBb", createdAt: now },
    ],
    organisations: [
      { id: "o1", type: "business", name: "A", paymentPage: { handle: "shop" }, createdAt: now, updatedAt: now },
      { id: "o2", type: "business", name: "B", createdAt: now, updatedAt: now },
    ],
    quotes: [{ id: "q1", userId: "u1", status: "CONSUMED" }],
    transfers: [{ id: "t1", userId: "u1", quoteId: "q1", sendEur: 10, state: "PAID", txs: [], createdAt: now }],
    sessions: [{ id: "s1", userId: "u1", tokenHash: "th-1", createdAt: now, lastUsedAt: now, expiresAt: "2999-01-01T00:00:00.000Z" }],
    cryptoDeposits: [{ id: "d1", userId: "u1", chainId: 84532, token: "EURE", txHash: "0xAB", logIndex: 0, amountUnits: "1", holding: "none", txs: [], createdAt: now, updatedAt: now }],
    cryptoSends: [{ id: "c1", userId: "u1", capEur: 5, state: "SENT", createdAt: now }],
    accounts: [
      { id: "a1", orgId: "o1", address: "0xCc", createdAt: now },
      { id: "a2", orgId: "o2", address: "0xAa", backingUserId: "u1", createdAt: now },
    ],
    recoveryRequests: [{ id: "r1", userId: "u1", mode: "zoldenburg", status: "GRACE_PERIOD" }],
    invoices: [{ id: "i1", orgId: "o1", state: "ISSUED", issued: { number: "RE-1" } }],
    members: [{ id: "m1", orgId: "o1", userId: "u1", status: "active" }],
    ledger: [{ id: "l1", orgId: "o1", statement: { key: "k1" } }],
    operators: [{ id: "op1", email: "Op@example.org", credentials: [{ credentialId: "oc-1" }] }],
    outbox: [{ id: "ob1", kind: "checkout.hint", payload: {}, createdAt: now, attempts: 0, nextAttemptAt: now }],
    cryptoDepositCursor: { "84532": "123" },
    processedMoneriumOrders: ["mo1"],
  }) as unknown as Db;
const report = (db: Db) => preImportReport(db);
/** The finding of `rule` in `collection`, or undefined. */
const find = (db: Db, rule: string, collection: string) => report(db).find((f) => f.rule === rule && f.collection === collection);
const dirty = (edit: (db: any) => void): Db => {
  const db = base() as any;
  edit(db);
  return db;
};

assert.deepEqual(report(base()), [], "the clean store has no finding");

// Each rule: a store that has it, and a near miss that does not.
const cases: { rule: string; collection: string; ids: string[]; blocks: boolean; hit: (db: any) => void; miss: (db: any) => void }[] = [
  {
    rule: "duplicate:transfers_quote_id",
    collection: "transfers",
    ids: ["t1", "t2"],
    blocks: true,
    hit: (db) => db.transfers.push({ ...db.transfers[0], id: "t2" }),
    miss: (db) => db.transfers.push({ ...db.transfers[0], id: "t2", quoteId: "q2" }, { ...db.transfers[0], id: "t3", quoteId: undefined }, { ...db.transfers[0], id: "t4", quoteId: undefined }),
  },
  {
    rule: "duplicate:accounts_address_unbacked",
    collection: "accounts",
    ids: ["a1", "a3"],
    blocks: true,
    hit: (db) => db.accounts.push({ id: "a3", orgId: "o2", address: "0xcC", createdAt: now }),
    // A person's Safe behind their personal and their sole-trader account.
    miss: (db) => db.accounts.push({ id: "a3", orgId: "o1", address: "0xaa", backingUserId: "u1", createdAt: now }),
  },
  {
    rule: "duplicate:recovery_requests_one_grace",
    collection: "recoveryRequests",
    ids: ["r1", "r2"],
    blocks: true,
    hit: (db) => db.recoveryRequests.push({ id: "r2", userId: "u1", mode: "zoldenburg", status: "GRACE_PERIOD" }),
    miss: (db) =>
      db.recoveryRequests.push(
        { id: "r2", userId: "u1", mode: "zoldenburg", status: "REVIEW_PENDING" },
        { id: "r3", userId: "u1", mode: "candide", status: "GRACE_PERIOD" },
        { id: "r4", userId: "u2", mode: "zoldenburg", status: "GRACE_PERIOD" },
      ),
  },
  {
    rule: "duplicate:invoices_org_number",
    collection: "invoices",
    ids: ["i1", "i2"],
    blocks: true,
    hit: (db) => db.invoices.push({ id: "i2", orgId: "o1", state: "ISSUED", issued: { number: "RE-1" } }),
    miss: (db) => db.invoices.push({ id: "i2", orgId: "o2", state: "ISSUED", issued: { number: "RE-1" } }, { id: "i3", orgId: "o1", state: "DRAFT" }, { id: "i4", orgId: "o1", state: "DRAFT" }),
  },
  {
    rule: "duplicate:payment_handles",
    collection: "users+organisations",
    ids: ["user:u2", "organisation:o1"],
    blocks: true,
    hit: (db) => (db.users[1].paymentPage = { handle: "Shop" }),
    miss: (db) => (db.users[1].paymentPage = { handle: "shop2" }),
  },
  {
    rule: "duplicate:members_live",
    collection: "members",
    ids: ["m1", "m2"],
    blocks: true,
    hit: (db) => db.members.push({ id: "m2", orgId: "o1", userId: "u1", status: "invited" }),
    miss: (db) => db.members.push({ id: "m2", orgId: "o1", userId: "u1", status: "deactivated" }),
  },
  {
    rule: "duplicate:sessions_token_hash",
    collection: "sessions",
    ids: ["s1", "s2"],
    blocks: true,
    hit: (db) => db.sessions.push({ ...db.sessions[0], id: "s2" }),
    miss: (db) => db.sessions.push({ ...db.sessions[0], id: "s2", tokenHash: "th-2" }),
  },
  {
    rule: "duplicate:operator_credentials",
    collection: "operators",
    ids: ["op1", "op2"],
    blocks: true,
    hit: (db) => db.operators.push({ id: "op2", email: "two@example.org", credentials: [{ credentialId: "oc-1" }] }),
    miss: (db) => db.operators.push({ id: "op2", email: "two@example.org", credentials: [{ credentialId: "oc-2" }] }),
  },
  {
    rule: "duplicate:operators_email_lc",
    collection: "operators",
    ids: ["op1", "op2"],
    blocks: true,
    hit: (db) => db.operators.push({ id: "op2", email: "op@EXAMPLE.org", credentials: [] }),
    miss: (db) => db.operators.push({ id: "op2", email: "op2@example.org", credentials: [] }),
  },
  {
    rule: "duplicate:crypto_deposits_chain_tx_log",
    collection: "cryptoDeposits",
    ids: ["d1", "d2"],
    blocks: true,
    hit: (db) => db.cryptoDeposits.push({ ...db.cryptoDeposits[0], id: "d2", txHash: "0xab" }),
    miss: (db) => db.cryptoDeposits.push({ ...db.cryptoDeposits[0], id: "d2", logIndex: 1 }, { ...db.cryptoDeposits[0], id: "d3", chainId: 8453 }),
  },
  {
    rule: "duplicate:primary-key",
    collection: "ledger",
    ids: ["l1", "l1"],
    blocks: true,
    hit: (db) => db.ledger.push({ id: "l1", orgId: "o1" }),
    miss: (db) => db.ledger.push({ id: "l2", orgId: "o1" }),
  },
  {
    rule: "duplicate:primary-key",
    collection: "processedMoneriumOrders",
    ids: ["mo1", "mo1"],
    blocks: true,
    hit: (db) => db.processedMoneriumOrders.push("mo1"),
    miss: (db) => db.processedMoneriumOrders.push("mo2"),
  },
  {
    rule: "bad-id",
    collection: "contacts",
    ids: ["#0"],
    blocks: true,
    hit: (db) => db.contacts.push({ orgId: "o1", name: "x" }),
    miss: (db) => db.contacts.push({ id: "ct1", orgId: "o1", name: "x" }),
  },
  { rule: "deposit-key:logIndex-missing", collection: "cryptoDeposits", ids: ["d1"], blocks: true, hit: (db) => delete db.cryptoDeposits[0].logIndex, miss: (db) => (db.cryptoDeposits[0].logIndex = 7) },
  { rule: "deposit-key:logIndex-not-integer", collection: "cryptoDeposits", ids: ["d1"], blocks: true, hit: (db) => (db.cryptoDeposits[0].logIndex = 1.5), miss: (db) => (db.cryptoDeposits[0].logIndex = 0) },
  { rule: "deposit-key:chainId-missing", collection: "cryptoDeposits", ids: ["d1"], blocks: true, hit: (db) => (db.cryptoDeposits[0].chainId = null), miss: (db) => (db.cryptoDeposits[0].chainId = 8453) },
  { rule: "deposit-key:txHash-missing", collection: "cryptoDeposits", ids: ["d1"], blocks: true, hit: (db) => (db.cryptoDeposits[0].txHash = ""), miss: (db) => (db.cryptoDeposits[0].txHash = "0xCD") },
  // JSON writes NaN and Infinity as null.
  { rule: "cap-amount:not-finite", collection: "transfers", ids: ["t1"], blocks: true, hit: (db) => (db.transfers[0].sendEur = null), miss: (db) => (db.transfers[0].sendEur = 0) },
  { rule: "cap-amount:not-finite", collection: "cryptoSends", ids: ["c1"], blocks: true, hit: (db) => (db.cryptoSends[0].capEur = "Infinity"), miss: (db) => (db.cryptoSends[0].capEur = 0.01) },
  { rule: "cursor-block-not-numeric", collection: "cryptoDepositCursor", ids: ["84532"], blocks: true, hit: (db) => (db.cryptoDepositCursor["84532"] = "12e3"), miss: (db) => (db.cryptoDepositCursor["84532"] = "12000") },
  { rule: "outbox-row-shape", collection: "outbox", ids: ["ob1"], blocks: true, hit: (db) => (db.outbox[0].attempts = -1), miss: (db) => (db.outbox[0].deliveredAt = now) },
  { rule: "unknown-collection", collection: "capHolds", ids: ["capHolds"], blocks: true, hit: (db) => (db.capHolds = []), miss: () => {} },
  { rule: "orphan:userId->users", collection: "transfers", ids: ["t1"], blocks: false, hit: (db) => (db.transfers[0].userId = "u_gone"), miss: (db) => (db.transfers[0].userId = "u2") },
  { rule: "orphan:quoteId->quotes", collection: "transfers", ids: ["t1"], blocks: false, hit: (db) => (db.quotes = []), miss: () => {} },
  { rule: "orphan:orgId->organisations", collection: "ledger", ids: ["l1"], blocks: false, hit: (db) => (db.ledger[0].orgId = "o_gone"), miss: (db) => (db.ledger[0].orgId = "o2") },
  { rule: "orphan:backingUserId->users", collection: "accounts", ids: ["a2"], blocks: false, hit: (db) => (db.accounts[1].backingUserId = "u_gone"), miss: (db) => (db.accounts[1].backingUserId = "u2") },
];
for (const c of cases) {
  const f = find(dirty(c.hit), c.rule, c.collection);
  assert.ok(f, `${c.rule} (${c.collection}): found`);
  assert.deepEqual(f.ids, c.ids, `${c.rule} (${c.collection}): names the rows`);
  assert.equal(f.blocks, c.blocks, `${c.rule} (${c.collection}): ${c.blocks ? "blocks" : "does not block"} the import`);
  assert.equal(find(dirty(c.miss), c.rule, c.collection), undefined, `${c.rule} (${c.collection}): the near miss is not a finding`);
}
console.log(`ok - the pre-import report: ${cases.length} rules, each found with its row ids and not on a near miss; orphans do not block`);

// ── The report CLI on a db.json alone: no database, no deployment env ──────
{
  const clean = path.join(tmp, "clean.json");
  const bad = path.join(tmp, "dirty.json");
  writeFileSync(clean, JSON.stringify(base()));
  writeFileSync(
    bad,
    JSON.stringify(
      dirty((db) => {
        db.sessions.push({ ...db.sessions[0], id: "s2", tokenHash: "th-1" });
        db.users[1].passkey = { credentialId: "cred-1" };
        db.users[1].email = "ada@example.org";
      }),
    ),
  );
  const run = (file: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/pg-import.ts", "report", file], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });
  const ok = run(clean);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /summary: 0 blocking, 0 other/);
  const no = run(bad);
  assert.equal(no.status, 1, "a blocking finding exits 1");
  assert.match(no.stdout, /BLOCKS +duplicate:sessions_token_hash {2}sessions {2}2 row\(s\): s1, s2/);
  assert.match(no.stdout, /duplicate:users_credential_id {2}users {2}2 row\(s\): u1, u2/);
  for (const value of ["th-1", "cred-1", "ada@example.org", "Op@example.org", "0xAB"]) assert.ok(!(no.stdout + no.stderr).includes(value), `the report does not print ${value}`);
}
console.log("ok - the report CLI runs on a db.json alone, exits 1 on a blocking finding, and prints ids, never a key's value");

// ── Round trip on PGlite, over a store the store's code wrote ──────────────
const fixture = path.join(tmp, "fixture.json");
{
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/_import-fixture.ts", fixture], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
const snapshot = loadMigratedSnapshot(fixture);
for (const [c, d] of Object.entries(digest(snapshot))) assert.ok(d.rows > 0, `the fixture has rows in ${c}`);
assert.equal(report(snapshot).filter((f) => f.blocks).length, 0, "the fixture has no blocking finding");
/** Rows in every table of the store's schema. */
const rowsIn = async (q: { query: (t: string) => Promise<{ rows: any[] }> }) => {
  const tables = (await q.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'")).rows.map((r) => r.table_name);
  let n = 0;
  for (const t of tables) n += Number((await q.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return n;
};
{
  const pg = await pglite();
  await assert.rejects(importSnapshot(pg, snapshot), /run the migrations first/, "a schema that is not current is refused");
  await migrate(pg);
  const r = await importSnapshot(pg, snapshot);
  assert.equal(r.imported, true);
  assert.deepEqual(r.digest, digest(snapshot));
  const v = await verifyAgainst(pg, snapshot);
  assert.deepEqual(v.mismatches, [], "verify: every collection matches");
  // Export: the same rows in the same order, field for field.
  const out = await exportDb(pg);
  assert.deepEqual(out.db, JSON.parse(JSON.stringify(snapshot)), "export → the snapshot, rows in stored order");
  assert.deepEqual(digest(out.db), digest(snapshot));
  assert.deepEqual(out.postgresOnly, { ledger_history: 0, cap_holds: 0, pending_executions: 0 });
  // `doc` is the text JSON.stringify wrote, key order and all (§1.1).
  for (const u of snapshot.users) {
    assert.equal((await pg.query<{ t: string }>("SELECT doc::text AS t FROM users WHERE id = $1", [u.id])).rows[0].t, JSON.stringify(u));
  }
  // The keys the importer fills besides the rows.
  assert.equal(
    Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM payment_handles")).rows[0].n),
    [...snapshot.users, ...snapshot.organisations].filter((x: any) => x.paymentPage?.handle).length,
  );
  assert.equal(Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM operator_credentials")).rows[0].n), snapshot.operators.flatMap((o) => o.credentials).length);

  // A second run on the same file changes nothing and says so.
  const before = await rowsIn(pg);
  const again = await importSnapshot(pg, loadMigratedSnapshot(fixture));
  assert.equal(again.imported, false);
  assert.equal(await rowsIn(pg), before, "nothing written");
  // A different source on a non-empty target is refused.
  const changed = loadMigratedSnapshot(fixture);
  (changed.ledger[0] as any).note = "edited";
  await assert.rejects(importSnapshot(pg, changed), (e: Error) => e instanceof ImportRefused && /not empty and differs from the source in: ledger/.test(e.message));
  // ledger_history is Postgres's own: the export reads it for its own file.
  await pg.query("UPDATE ledger SET doc = $2::json WHERE id = $1", [snapshot.ledger[0].id, JSON.stringify({ ...snapshot.ledger[0], note: "categorised" })]);
  assert.equal((await exportDb(pg)).postgresOnly.ledger_history, 1);
  const history = (await readLedgerHistory(pg)).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(history.length, 1);
  assert.equal(history[0].entryId, snapshot.ledger[0].id);
  assert.deepEqual(history[0].doc, snapshot.ledger[0], "the row as it was before the change");
  assert.deepEqual((await verifyAgainst(pg, snapshot)).mismatches, ["ledger"], "verify sees the change");

  // 0008: what 0005 left through.
  await assert.rejects(pg.query("INSERT INTO cap_holds (id, cap_key, day, eur, expires_at) VALUES ('h', 'k', '2026-11-26', 'Infinity', now())"), /cap_holds_eur_not_infinite/);
  await assert.rejects(pg.query("INSERT INTO crypto_deposits (id, doc) VALUES ('dx', '{\"txHash\":\"0x1\",\"logIndex\":0}')"), /chain_id/);
  await assert.rejects(pg.query("INSERT INTO crypto_deposits (id, doc) VALUES ('dx', '{\"chainId\":1,\"logIndex\":0}')"), /tx_hash_lc/);
  await pg.close();
}
console.log("ok - round trip import → export → verify on PGlite: every collection, rows in order, doc text unchanged; a second run changes nothing; a different source is refused; ledger_history exported on its own; 0008 refuses an Infinity hold and a deposit without chain or hash");

// ── Refusals: a dirty source, and a failure mid-import ─────────────────────
{
  const pg = await pglite();
  await migrate(pg);
  const bad = loadMigratedSnapshot(fixture);
  bad.transfers.push({ ...bad.transfers[0], id: "t_dup" });
  await assert.rejects(importSnapshot(pg, bad), (e: Error) => e instanceof ImportRefused && e.findings.some((f) => f.rule === "duplicate:transfers_quote_id" && f.ids.includes("t_dup")));
  assert.equal(await rowsIn(pg), 0, "a dirty source writes nothing");

  // Failed after the first tables are in: rolled back as one.
  let inserted = 0;
  await assert.rejects(
    importSnapshot(pg, snapshot, {
      beforeRow(c, i) {
        inserted++;
        if (c === "ledger" && i === 1) throw new Error("cut mid-import");
      },
    }),
    /cut mid-import/,
  );
  assert.ok(inserted > 50, `the failure came after ${inserted} rows`);
  assert.equal(await rowsIn(pg), 0, "a failure mid-import leaves the target empty");
  // An insert the database refuses names the collection, the row and the
  // constraint, never the value: a row the report has no rule for.
  await pg.query("ALTER TABLE contacts ADD CONSTRAINT contacts_test_no_lindner CHECK (doc->>'name' <> 'Lindner Holzbau GmbH')");
  await assert.rejects(importSnapshot(pg, snapshot), (e: Error) => {
    assert.ok(e instanceof ImportRefused);
    assert.match(e.message, /insert failed at contacts row ct_fx \(SQLSTATE 23514, constraint contacts_test_no_lindner\); rolled back, the target is empty/);
    assert.ok(!e.message.includes("Lindner"), "no value in the message");
    return true;
  });
  assert.equal(await rowsIn(pg), 0);
  // Then the same import goes through once the target is fit for it.
  await pg.query("ALTER TABLE contacts DROP CONSTRAINT contacts_test_no_lindner");
  assert.equal((await importSnapshot(pg, snapshot)).imported, true);
  await pg.close();
}
console.log("ok - a dirty source is refused with its findings, and a failure mid-import (thrown, or a constraint refusing a row) leaves the target empty, naming the row and constraint only");
