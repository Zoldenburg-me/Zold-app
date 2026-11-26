/**
 * The store suite (_store-suite.ts) on the JSON backend and on the Postgres
 * backend over PGlite, plus what only Postgres has: the migration runner,
 * the keys of 0001_init.sql, the shared payment-handle namespace, the
 * DATABASE_URL rules, and the PGlite features §4 of
 * docs/postgres-store-design.md relies on.
 *
 * Offline: PGlite is Postgres compiled to WASM, in process. It serialises
 * every query, so nothing here shows a race; store-pg-test.ts runs the suite
 * and the parallel cases on a real Postgres 17.  npm run store-backend:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { conditionalWriteSuite, storeSuite } from "./_store-suite.js";

const tmp = mkdtempSync(path.join(tmpdir(), "zold-store-backend-"));
process.env.TRANSF_DB_PATH = path.join(tmp, "db.json");

const { initStore, store } = await import("../services/api/src/store.js");
const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { assertSchemaCurrent, migrate, readMigrations, transactionControl } = await import("../services/api/src/store/pg/migrate.js");
const { pgliteDatabase, pgPoolConfig } = await import("../services/api/src/store/pg/sql.js");
/** Every migration file, and the version and name prefix of the next one. */
const ALL_MIGRATIONS = readMigrations().map((m) => m.version);
const NEXT = ALL_MIGRATIONS.length + 1;
const NEXT_NAME = String(NEXT).padStart(4, "0");

const pglite = async () => pgliteDatabase((await PGlite.create()) as never);

// ── The suite, on both backends ────────────────────────────────────────────
await initStore();
await storeSuite(store);
await conditionalWriteSuite(store);
console.log("ok - store suite on the JSON backend");

// ── The JSON backend's mutex, transactions and copies (§3) ─────────────────
{
  const { readFileSync } = await import("node:fs");
  const onDisk = () => JSON.parse(readFileSync(process.env.TRANSF_DB_PATH!, "utf8"));
  const now = new Date().toISOString();
  await store.addOrganisation({ id: "org_mx", type: "business", name: "Before", createdAt: now, updatedAt: now } as any, false);
  assert.equal(onDisk().organisations.find((o: any) => o.id === "org_mx")?.name, "Before", "a write outside a transaction is on disk when it resolves");

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let readDone = false;
  const tx = store.tx(async (t) => {
    await t.updateOrganisation("org_mx", { name: "Half" });
    await gate;
    await t.updateOrganisation("org_mx", { name: "After" });
  });
  await new Promise((r) => setTimeout(r, 0));
  const read = store.findOrganisation("org_mx").then((o) => ((readDone = true), o));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(readDone, false, "a read waits while a transaction holds the mutex");
  assert.equal(onDisk().organisations.find((o: any) => o.id === "org_mx")?.name, "Before", "a transaction writes the file once, at its end");
  release();
  await tx;
  assert.equal((await read)?.name, "After", "and then reads the committed state, never the half-made one");
  assert.equal(onDisk().organisations.find((o: any) => o.id === "org_mx")?.name, "After");

  // Store calls made from inside the callback, through `store` too, join it.
  assert.equal(await store.tx(async () => (await store.findOrganisation("org_mx"))?.name), "After", "a nested call does not wait for its own transaction");

  // A callback that throws keeps the writes it made: no rollback on JSON.
  await assert.rejects(store.tx(async (t) => {
    await t.updateOrganisation("org_mx", { name: "Thrown" });
    throw new Error("boom");
  }), /boom/);
  assert.equal(onDisk().organisations.find((o: any) => o.id === "org_mx")?.name, "Thrown", "persisted: the JSON backend has no rollback");

  // Rows are copies, both ways.
  const a = (await store.findOrganisation("org_mx"))!;
  a.name = "mutated";
  assert.equal((await store.findOrganisation("org_mx"))?.name, "Thrown", "changing a row read changes nothing stored");
  const patch = { name: "Patched" };
  const written = await store.updateOrganisation("org_mx", patch);
  patch.name = "later";
  written.name = "later";
  assert.equal((await store.findOrganisation("org_mx"))?.name, "Patched", "nor does changing the patch or the row returned");
  assert.notEqual(await store.list("organisations"), await store.list("organisations"), "a list is a copy too");

  // Calls run one at a time, in the order they were made.
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => store.updateOrganisation("org_mx", { name: `N${n}` }).then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal((await store.findOrganisation("org_mx"))?.name, "N3");

  // A state-change listener runs only once its write is on disk: a call that
  // releases the mutex to a transaction never fires that transaction's
  // announcements before the transaction persisted.
  {
    await store.addTransfer({ id: "t_ann_a", userId: "u", quoteId: "q_ann_a", state: "CREATED", txs: [], createdAt: now, updatedAt: now } as any);
    await store.addTransfer({ id: "t_ann_b", userId: "u", quoteId: "q_ann_b", state: "CREATED", txs: [], createdAt: now, updatedAt: now } as any);
    const heard: string[] = [];
    store.onTransferStateChange((t) => {
      if (!t.id.startsWith("t_ann_")) return;
      const stored = onDisk().transfers.find((x: any) => x.id === t.id)?.state;
      heard.push(`${t.id}:${t.state}:${stored === t.state ? "on disk" : `disk says ${stored}`}`);
    });
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    const a = store.updateTransfer("t_ann_a", { state: "DEBITED" });
    const b = store.tx(async (t) => {
      await t.updateTransfer("t_ann_b", { state: "DEBITED" });
      await gate;
    });
    await a;
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(heard, ["t_ann_a:DEBITED:on disk"], "the transaction's change is not announced while it is open");
    letGo();
    await b;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(heard, ["t_ann_a:DEBITED:on disk", "t_ann_b:DEBITED:on disk"]);
  }

  // A response sent inside a transaction goes out after the file write; one
  // from a transaction that throws is dropped for the error handler's.
  {
    const express = (await import("express")).default;
    const { sendAfterCommit } = await import("../services/api/src/http/send-after-commit.js");
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    const app = express().use(sendAfterCommit);
    app.post("/ok", async (_req, res) => {
      await store.tx(async (t) => {
        await t.updateOrganisation("org_mx", { name: "Answered" });
        res.status(201).json({ name: "Answered" });
        await gate;
      });
    });
    app.post("/boom", async (_req, res, next) => {
      await store.tx(async () => {
        res.json({ ok: true });
        throw new Error("after the answer");
      }).catch(next);
    });
    app.use(((_err, _req, res, _next) => void res.status(500).json({ error: "internal" })) as import("express").ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    try {
      let answered = false;
      const ok = fetch(`${url}/ok`, { method: "POST" }).then((r) => ((answered = true), r));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(answered, false, "no answer while the transaction is open");
      letGo();
      const r = await ok;
      assert.equal(r.status, 201);
      assert.equal(onDisk().organisations.find((o: any) => o.id === "org_mx")?.name, "Answered");
      const boom = await fetch(`${url}/boom`, { method: "POST" });
      assert.equal(boom.status, 500, "the held 200 is dropped; the error handler answers");
    } finally {
      server.close();
    }
  }
  await assert.rejects(store.lockUser("u_x"), /lockUser outside a store\.tx holds nothing/);
  await assert.rejects(store.lockKey("k"), /lockKey outside a store\.tx holds nothing/);
  console.log("ok - JSON backend: every call behind one mutex, store.tx holds it, rows are copies, a write is on disk when it resolves");
}

{
  const db = await pglite();
  const version = (await db.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v;
  assert.equal(version.slice(0, 2), "17", `PGlite runs Postgres 17, the production major (got ${version})`);
  assert.deepEqual(await migrate(db), ALL_MIGRATIONS);
  const pg = createPgStore(db);
  await storeSuite(pg);
  await conditionalWriteSuite(pg);
  // A state change inside a store.tx is announced after its COMMIT, and
  // never for a transaction rolled back.
  const now = new Date().toISOString();
  for (const id of ["t_lis_ok", "t_lis_rb"]) {
    await pg.addTransfer({ id, userId: "u_a", quoteId: `q_${id}`, state: "CREATED", txs: [], createdAt: now, updatedAt: now } as any);
  }
  const heard: string[] = [];
  pg.onTransferStateChange((t) => void heard.push(`${t.id}:${t.state}`));
  await pg.tx(async (t) => {
    await t.updateTransfer("t_lis_ok", { state: "PAID" } as any);
    assert.deepEqual(heard, [], "not announced before the commit");
  });
  assert.deepEqual(heard, ["t_lis_ok:PAID"]);
  await assert.rejects(
    pg.tx(async (t) => {
      await t.updateTransfer("t_lis_rb", { state: "PAID" } as any);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.deepEqual(heard, ["t_lis_ok:PAID"], "a rolled-back change is never announced");
  assert.equal((await pg.findTransfer("t_lis_rb"))?.state, "CREATED");

  // A nested store.tx that fails and is caught undoes only itself (a
  // savepoint); the transaction goes on and commits the rest.
  await pg.tx(async (t) => {
    await t.updateTransfer("t_lis_rb", { reference: "outer" } as any);
    await assert.rejects(
      pg.tx(async (n) => {
        await n.updateTransfer("t_lis_rb", { reference: "inner" } as any);
        await n.addSession({ id: "s_dup", userId: "u_a", tokenHash: "th_dup", createdAt: now, lastUsedAt: now, expiresAt: now });
        await n.addSession({ id: "s_dup2", userId: "u_a", tokenHash: "th_dup", createdAt: now, lastUsedAt: now, expiresAt: now });
      }),
      /duplicate key/,
    );
    await t.updateTransfer("t_lis_rb", { purpose: "after" } as any);
  });
  const rb = await pg.findTransfer("t_lis_rb");
  assert.equal((rb as any)?.reference, "outer", "the nested part was undone, the outer write kept");
  assert.equal((rb as any)?.purpose, "after", "the transaction went on after the caught failure");
  assert.equal(await pg.findSessionByTokenHash("th_dup"), undefined);
  // A failed statement caught without a savepoint: Postgres aborted the
  // transaction, so it fails rather than COMMIT rolling back in silence.
  await assert.rejects(
    pg.tx(async (t) => {
      await t.updateTransfer("t_lis_rb", { reference: "lost" } as any);
      await t.addSession({ id: "s_dup3", userId: "u_a", tokenHash: "th_dup3", createdAt: now, lastUsedAt: now, expiresAt: now });
      await t.addSession({ id: "s_dup4", userId: "u_a", tokenHash: "th_dup3", createdAt: now, lastUsedAt: now, expiresAt: now }).catch(() => {});
    }),
    /a statement in this transaction failed/,
  );
  assert.equal((await pg.findTransfer("t_lis_rb") as any)?.reference, "outer", "nothing of it committed");
  // Nested transactions of one parent run one after another, so their
  // savepoints nest even when started together.
  const order: string[] = [];
  await pg.tx(async () => {
    await Promise.all(
      ["a", "b"].map((k) =>
        pg.tx(async (n) => {
          order.push(`${k}+`);
          await n.updateTransfer("t_lis_rb", { reference: k } as any);
          order.push(`${k}-`);
        }),
      ),
    );
  });
  assert.deepEqual(order, ["a+", "a-", "b+", "b-"]);
  for (const s of [pg]) await assert.rejects(s.lockUser("u_a"), /lockUser outside a store\.tx holds nothing/);
  await db.close();
  console.log(`ok - store suite on the Postgres backend (PGlite, server_version_num ${version}); listeners after COMMIT only; nested tx savepoints; no silent COMMIT after a failed statement`);
}

// ── Migration runner ───────────────────────────────────────────────────────
{
  const db = await pglite();
  const files = readMigrations();
  assert.deepEqual(await migrate(db, files), ALL_MIGRATIONS);
  assert.deepEqual(await migrate(db, files), [], "an applied file is not run again");
  await assert.rejects(() => migrate(db, [{ ...files[0], sha256: "0".repeat(64) }]), /changed after it was applied/);
  await assert.rejects(() => migrate(db, []), /applied but its file is gone/);
  // A failing file leaves nothing behind, not even its first statement.
  const bad = { version: NEXT, name: `${NEXT_NAME}_bad.sql`, sql: "CREATE TABLE half_done (id text); SELECT 1/0;", sha256: "b".repeat(64) };
  await assert.rejects(() => migrate(db, [...files, bad]), /division by zero/);
  assert.equal((await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'half_done'")).rows.length, 0, "the failed file rolled back");
  assert.deepEqual((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version), ALL_MIGRATIONS);
  // A file that ends our transaction early is refused before anything runs.
  for (const sql of ["CREATE TABLE a (id text);\nCOMMIT;\nCREATE TABLE b (id text);", "begin;\nSELECT 1;", "SELECT 1; ROLLBACK", "START TRANSACTION; SELECT 1;", "/* a /* nested */ still a comment */ ROLLBACK;", "SELECT '/*'; ROLLBACK; -- */", "SELECT E'\\''; COMMIT;", "SELECT $1; ROLLBACK;"]) {
    const early = { version: NEXT, name: `${NEXT_NAME}_early.sql`, sql, sha256: "c".repeat(64) };
    await assert.rejects(() => migrate(db, [...files, early]), new RegExp(`${NEXT_NAME}_early.sql contains (COMMIT|BEGIN|ROLLBACK|START TRANSACTION)`));
  }
  assert.equal((await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'a'")).rows.length, 0, "nothing of a refused file ran");
  // Markers inside strings, names, bodies and comments open or close nothing else.
  for (const sql of [
    "SELECT '/*'; -- */\nSELECT '; COMMIT;';",
    "SELECT E'\\'; COMMIT; --';",
    'CREATE TABLE "commit" (id text); SELECT \'it\'\'s; rollback;\';',
    "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END $fn$;",
    "/* a /* b */ COMMIT; */ SELECT 1;",
    "SELECT a$b$ FROM (SELECT 1 AS a$b$) t; -- $b$ commit;",
  ]) assert.equal(transactionControl(sql), undefined, sql);
  // BEGIN in a comment, a string or a function body is not transaction control,
  // and the file runs with its lock and statement timeouts set.
  const timed = {
    version: NEXT,
    name: `${NEXT_NAME}_timed.sql`,
    sql: `-- begin;\nSELECT 'commit;';\nDO $$ BEGIN\n  IF current_setting('lock_timeout') <> '5s' OR current_setting('statement_timeout') <> '2min' THEN RAISE EXCEPTION 'timeouts not set'; END IF;\nEND $$;`,
    sha256: "d".repeat(64),
  };
  assert.deepEqual(await migrate(db, [...files, timed]), [NEXT]);
  assert.equal((await db.query<{ t: string }>("SELECT current_setting('lock_timeout') AS t")).rows[0].t, "0", "SET LOCAL: the timeouts end with the file's transaction");
  // The API checks the schema and never migrates: behind, changed or ahead refuses.
  await assert.rejects(() => assertSchemaCurrent(db, files), /this code does not know/, "a version the code has no file for");
  assert.equal(await assertSchemaCurrent(db, [...files, timed]), NEXT);
  await assert.rejects(() => assertSchemaCurrent(db, [...files, { ...timed, sha256: "e".repeat(64) }]), /differs from the one applied/);
  await assert.rejects(() => assertSchemaCurrent(db, [...files, timed, { ...timed, version: NEXT + 1, name: "x" }]), new RegExp(`at version ${NEXT}, this code needs ${NEXT + 1}: run the migrations first`));
  const empty = await pglite();
  await assert.rejects(() => assertSchemaCurrent(empty, files), /at version 0/, "an empty database");
  await empty.close();
  await db.close();

  const dir = mkdtempSync(path.join(tmp, "migrations-"));
  writeFileSync(path.join(dir, "0002_second.sql"), "SELECT 1;");
  assert.throws(() => readMigrations(dir), /out of sequence/);
  writeFileSync(path.join(dir, "0001_First.sql"), "SELECT 1;");
  assert.throws(() => readMigrations(dir), /not named NNNN_name.sql/);
  console.log("ok - migrations: once each, a changed or missing file refused, a failed file rolled back, BEGIN/COMMIT/ROLLBACK refused, lock and statement timeouts set; the API's schema check refuses a database behind, ahead of or changed from its files");
}

// ── Keys only Postgres enforces ────────────────────────────────────────────
{
  const db = await pglite();
  await migrate(db);
  const s = createPgStore(db);
  const now = new Date().toISOString();
  // A user's and an organisation's pages share one namespace (§1.2).
  await s.addUser({ id: "u_1", address: `0x${"11".repeat(20)}`, iban: "", createdAt: now, paymentPage: { handle: "shared" } } as any);
  await assert.rejects(
    async () => await s.addOrganisation({ id: "org_1", type: "business", name: "O", createdAt: now, updatedAt: now, paymentPage: { handle: "SHARED" } } as any, false),
    /payment page handle is taken/,
  );
  assert.equal(await s.findOrganisation("org_1"), undefined, "the refused org was not written");
  await s.addOrganisation({ id: "org_1", type: "business", name: "O", createdAt: now, updatedAt: now } as any, false);
  await assert.rejects(async () => await s.updateOrganisation("org_1", { paymentPage: { handle: "shared" } } as any), /taken/);
  await s.updateUser("u_1", { paymentPage: { handle: "mine" } } as any);
  assert.equal((await s.updateOrganisation("org_1", { paymentPage: { handle: "shared" } } as any)).paymentPage?.handle, "shared", "a freed handle can be claimed");
  await assert.rejects(async () => await s.updateUser("u_1", { paymentPage: { handle: "Shared" } } as any), /taken/);
  assert.deepEqual(
    (await db.query("SELECT handle_lc, owner_kind, owner_id FROM payment_handles ORDER BY handle_lc")).rows,
    [{ handle_lc: "mine", owner_kind: "user", owner_id: "u_1" }, { handle_lc: "shared", owner_kind: "organisation", owner_id: "org_1" }],
  );

  // Credentials and idempotency keys are unique in the table, whatever the caller checked.
  await s.addSession({ id: "s_1", userId: "u_1", tokenHash: "th", createdAt: now, lastUsedAt: now, expiresAt: now });
  await assert.rejects(async () => await s.addSession({ id: "s_2", userId: "u_1", tokenHash: "th", createdAt: now, lastUsedAt: now, expiresAt: now }), /duplicate key/);
  await s.addUser({ id: "u_2", address: `0x${"22".repeat(20)}`, iban: "", createdAt: now, passkey: { credentialId: "cred" } } as any);
  await assert.rejects(async () => await s.addUser({ id: "u_3", address: `0x${"33".repeat(20)}`, iban: "", createdAt: now, passkey: { credentialId: "cred" } } as any), /duplicate key/);
  await s.addReceiptShare({ id: "rs_1", slug: "a", transferId: "t", userId: "u_1", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: now });
  await assert.rejects(
    async () => await s.addReceiptShare({ id: "rs_2", slug: "b", transferId: "t", userId: "u_1", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: now }),
    /duplicate key/,
    "one live share per transfer",
  );
  // One issued number per organisation, whatever the code does (0002).
  const issued = (id: string, orgId: string, number?: string) =>
    ({ id, orgId, direction: "outgoing", linkTokenHash: `lth-${id}`, state: number ? "SUBMITTED" : "DRAFT", lines: [], currency: "EUR", total: "1.00", ...(number ? { issued: { number } } : {}), createdByMemberId: "m", createdAt: now, updatedAt: now }) as any;
  await s.addInvoice(issued("inv_n1", "org_x", "RE-1"));
  await s.addInvoice(issued("inv_n1b", "org_y", "RE-1"));
  await assert.rejects(async () => await s.addInvoice(issued("inv_n2", "org_x", "RE-1")), /duplicate key/, "one number per organisation");
  await s.addInvoice(issued("inv_d1", "org_x"));
  await s.addInvoice(issued("inv_d2", "org_x"));
  await assert.rejects(async () => await s.updateInvoice("inv_d1", { issued: { number: "RE-1" } } as any), /duplicate key/);
  assert.equal((await s.updateInvoice("inv_d1", { issued: { number: "RE-2" } } as any)).issued?.number, "RE-2");
  // 0003: one transfer per quote, whatever the code does.
  const tr = (id: string, quoteId: string) => ({ id, userId: "u_1", quoteId, rail: "sepa", state: "CREATED", sendEur: 1, txs: [], createdAt: now, updatedAt: now }) as any;
  await s.addTransfer(tr("t_q1", "q_one"));
  await assert.rejects(async () => await s.addTransfer(tr("t_q2", "q_one")), /duplicate key/, "a second transfer for one quote");
  // One account per company Safe, case-blind: the add answers null, not an error.
  const acc = (id: string, orgId: string, address?: string, backingUserId?: string) =>
    ({ id, orgId, currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, ...(address ? { address } : {}), ...(backingUserId ? { backingUserId } : {}), createdAt: now, updatedAt: now }) as any;
  assert.ok(await s.addAccount(acc("acc_1", "org_x", `0x${"ab".repeat(20)}`)));
  assert.equal(await s.addAccount(acc("acc_2", "org_y", `0x${"AB".repeat(20)}`)), null, "a second account at one company Safe");
  assert.ok(await s.addAccount(acc("acc_3", "org_y")) && (await s.addAccount(acc("acc_4", "org_y"))), "accounts without an address do not collide");
  await assert.rejects(async () => await s.updateAccount("acc_3", { address: `0x${"ab".repeat(20)}` } as any), /duplicate key/);
  const personal = `0x${"cd".repeat(20)}`;
  assert.ok(await s.addAccount(acc("acc_p1", "org_p", personal, "u_1")) && (await s.addAccount(acc("acc_p2", "org_st", personal, "u_1"))), "a person's Safe backs several accounts");
  // One Zoldenburg grace period per user; other modes and statuses are not limited.
  const rr = (id: string, status: string, mode = "zoldenburg") => ({ id, userId: "u_1", mode, status, requestedAt: now, expiresAt: now }) as any;
  await s.addRecoveryRequest(rr("rr_1", "GRACE_PERIOD"));
  await s.addRecoveryRequest(rr("rr_2", "REVIEW_PENDING"));
  await s.addRecoveryRequest(rr("rr_3", "GRACE_PERIOD", "candide"));
  await assert.rejects(async () => await s.updateRecoveryRequest("rr_2", { status: "GRACE_PERIOD" }), /duplicate key/);
  await s.updateRecoveryRequest("rr_1", { status: "FINALIZED" });
  assert.equal((await s.updateRecoveryRequest("rr_2", { status: "GRACE_PERIOD" })).status, "GRACE_PERIOD", "once the first has left it");
  // The email key trims what String.prototype.trim() trims.
  const spaced = "\u00a0\u2003\ufeff Zoe@Example.de\u3000\n";
  await s.addUser({ id: "u_mail", address: `0x${"44".repeat(20)}`, iban: "", createdAt: now, email: spaced } as any);
  assert.equal(spaced.trim().toLowerCase(), "zoe@example.de");
  assert.deepEqual((await s.usersByEmail("zoe@example.de")).map((u) => u.id), ["u_mail"], "NBSP, em space, BOM and ideographic space are trimmed");
  await db.close();
  console.log("ok - Postgres keys: one payment-handle namespace, unique credentials, one live share per transfer, one issued invoice number per org, one transfer per quote, one account per company Safe, one Zoldenburg grace period per user, the email key trimmed as JavaScript trims");
}

// ── The PGlite features the design note relies on (§4) ─────────────────────
{
  const db = await pglite();
  await db.exec(`
    CREATE TABLE f (id text PRIMARY KEY, doc jsonb NOT NULL, k text GENERATED ALWAYS AS (lower(doc->>'k')) STORED, st text GENERATED ALWAYS AS (doc->>'st') STORED);
    CREATE UNIQUE INDEX f_live ON f (k) WHERE st <> 'gone';
    CREATE FUNCTION f_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no % on %', TG_OP, TG_TABLE_NAME; END $$;
    CREATE TRIGGER f_no_delete BEFORE DELETE ON f FOR EACH ROW EXECUTE FUNCTION f_refuse();
  `);
  await db.query("INSERT INTO f (id, doc) VALUES ('a', '{\"k\":\"X\",\"st\":\"live\"}')");
  assert.equal((await db.query<{ k: string }>("SELECT k FROM f")).rows[0].k, "x", "a generated column follows doc");
  await assert.rejects(() => db.query("INSERT INTO f (id, doc) VALUES ('b', '{\"k\":\"x\",\"st\":\"live\"}')"), /duplicate key/, "partial unique index");
  await db.query("INSERT INTO f (id, doc) VALUES ('c', '{\"k\":\"x\",\"st\":\"gone\"}')");
  await assert.rejects(() => db.query("DELETE FROM f WHERE id = 'a'"), /no DELETE on f/, "a trigger refuses");
  const locks = await db.query<{ a: boolean; b: boolean }>("SELECT pg_try_advisory_lock(hashtext('api:test')) AS a, pg_try_advisory_lock(hashtext('api:test')) AS b");
  // One session re-takes its own lock; PGlite has only one session, so a
  // second holder cannot be shown here (store-pg-test.ts shows it).
  assert.deepEqual(locks.rows[0], { a: true, b: true });
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(1)");
    await q.query("SELECT doc FROM f WHERE id = 'a' FOR UPDATE");
  });
  await db.close();
  console.log("ok - PGlite: generated columns, partial unique indexes, triggers, advisory locks, FOR UPDATE");
}

// ── DATABASE_URL ───────────────────────────────────────────────────────────
{
  const ca = path.join(tmp, "ca.pem");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const real = { realMoney: true };
  // The Oracle host: a unix socket, peer authentication, no password (§7).
  assert.deepEqual(pgPoolConfig("postgresql://zold_app@/zold?host=/run/postgresql-mainnet&port=5432", real), {
    connectionString: "postgresql://zold_app@/zold?host=/run/postgresql-mainnet&port=5432",
  });
  assert.ok(pgPoolConfig("postgresql:///zold?host=/tmp", real));
  assert.ok(pgPoolConfig("postgresql://u@localhost:5432/zold", real));
  assert.ok(pgPoolConfig("postgres://u@127.0.0.1/zold", real));
  assert.ok(pgPoolConfig("postgresql://u@[::1]/zold", real));
  assert.ok(pgPoolConfig("postgresql://u:pw@db.example.com/zold", { realMoney: false }), "a test chain may use another host without TLS");
  const secret = "s3cr3t-password";
  const refusals: [string, object, RegExp][] = [
    [`postgresql://u:${secret}@db.example.com/zold`, real, /sslmode=verify-full/],
    [`postgresql://u:${secret}@db.example.com/zold?sslmode=require`, real, /sslmode=verify-full/],
    [`postgresql://u:${secret}@db.example.com/zold?sslmode=verify-full`, real, /DATABASE_CA/],
    [`postgresql://u:${secret}@db.example.com/zold?host=db.example.com`, real, /sslmode=verify-full/],
    [`mysql://u:${secret}@localhost/zold`, real, /postgresql:\/\//],
    [`not a url ${secret}`, real, /not a valid URL/],
  ];
  for (const [url, opts, why] of refusals) {
    assert.throws(() => pgPoolConfig(url, opts as never), (e: Error) => why.test(e.message) && !e.message.includes(secret), url.replace(secret, "…"));
  }
  const tls = pgPoolConfig("postgresql://u@db.example.com/zold?sslmode=verify-full", { ca, realMoney: true });
  assert.deepEqual(tls.ssl, { ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n", rejectUnauthorized: true });
  assert.equal(tls.connectionString, "postgresql://u@db.example.com/zold", "our CA object is not replaced by the driver's sslmode parsing");
  assert.equal(
    pgPoolConfig("postgresql://u@/zold?host=/run/pg&sslmode=verify-full", { ca, realMoney: true }).connectionString,
    "postgresql://u@/zold?host=%2Frun%2Fpg",
    "the empty host survives",
  );
  console.log("ok - DATABASE_URL: socket and loopback plain; another host on real money needs verify-full and a CA; no URL echoed");
}

// ── STORE_BACKEND ──────────────────────────────────────────────────────────
{
  const run = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./services/api/src/config/env.ts')"], {
      env: { ...process.env, DATABASE_URL: undefined, TRANSF_CHAIN_ID: undefined, ...env },
      encoding: "utf8",
    });
  const url = "postgresql:///zold?host=/tmp";
  const typo = run({ STORE_BACKEND: "pg" });
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /STORE_BACKEND must be json or postgres/);
  for (const chain of [undefined, "8453", "100"]) {
    const real = run({ STORE_BACKEND: "postgres", DATABASE_URL: url, TRANSF_CHAIN_ID: chain });
    assert.notEqual(real.status, 0, `chain ${chain ?? "default"}`);
    assert.match(real.stderr, /refused on a real-money chain until the cut-over/);
  }
  const noUrl = run({ STORE_BACKEND: "postgres", TRANSF_CHAIN_ID: "84532" });
  assert.notEqual(noUrl.status, 0);
  assert.match(noUrl.stderr, /needs DATABASE_URL/);
  const testnet = run({ STORE_BACKEND: "postgres", DATABASE_URL: url, TRANSF_CHAIN_ID: "84532" });
  assert.equal(testnet.status, 0, testnet.stderr);
  assert.equal(run({ STORE_BACKEND: "json" }).status, 0);
  console.log("ok - STORE_BACKEND: json or postgres; postgres needs DATABASE_URL and is refused on a real-money chain until the cut-over");
}
