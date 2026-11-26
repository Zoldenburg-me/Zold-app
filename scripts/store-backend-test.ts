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
import { storeSuite } from "./_store-suite.js";

const tmp = mkdtempSync(path.join(tmpdir(), "zold-store-backend-"));
process.env.TRANSF_DB_PATH = path.join(tmp, "db.json");

const { initStore, store } = await import("../services/api/src/store.js");
const { jsonBackend } = await import("../services/api/src/store/backend.js");
const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { migrate, readMigrations, transactionControl } = await import("../services/api/src/store/pg/migrate.js");
const { pgliteDatabase, pgPoolConfig } = await import("../services/api/src/store/pg/sql.js");

const pglite = async () => pgliteDatabase((await PGlite.create()) as never);

// ── The suite, on both backends ────────────────────────────────────────────
initStore();
await storeSuite(jsonBackend(store));
console.log("ok - store suite on the JSON backend");

{
  const db = await pglite();
  const version = (await db.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v;
  assert.equal(version.slice(0, 2), "17", `PGlite runs Postgres 17, the production major (got ${version})`);
  assert.deepEqual(await migrate(db), [1]);
  await storeSuite(createPgStore(db));
  await db.close();
  console.log(`ok - store suite on the Postgres backend (PGlite, server_version_num ${version})`);
}

// ── Migration runner ───────────────────────────────────────────────────────
{
  const db = await pglite();
  const files = readMigrations();
  assert.deepEqual(await migrate(db, files), [1]);
  assert.deepEqual(await migrate(db, files), [], "an applied file is not run again");
  await assert.rejects(() => migrate(db, [{ ...files[0], sha256: "0".repeat(64) }]), /changed after it was applied/);
  await assert.rejects(() => migrate(db, []), /applied but its file is gone/);
  // A failing file leaves nothing behind, not even its first statement.
  const bad = { version: 2, name: "0002_bad.sql", sql: "CREATE TABLE half_done (id text); SELECT 1/0;", sha256: "b".repeat(64) };
  await assert.rejects(() => migrate(db, [...files, bad]), /division by zero/);
  assert.equal((await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'half_done'")).rows.length, 0, "the failed file rolled back");
  assert.deepEqual((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version), [1]);
  // A file that ends our transaction early is refused before anything runs.
  for (const sql of ["CREATE TABLE a (id text);\nCOMMIT;\nCREATE TABLE b (id text);", "begin;\nSELECT 1;", "SELECT 1; ROLLBACK", "START TRANSACTION; SELECT 1;", "/* a /* nested */ still a comment */ ROLLBACK;", "SELECT '/*'; ROLLBACK; -- */", "SELECT E'\\''; COMMIT;", "SELECT $1; ROLLBACK;"]) {
    const early = { version: 2, name: "0002_early.sql", sql, sha256: "c".repeat(64) };
    await assert.rejects(() => migrate(db, [...files, early]), /0002_early.sql contains (COMMIT|BEGIN|ROLLBACK|START TRANSACTION)/);
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
    version: 2,
    name: "0002_timed.sql",
    sql: `-- begin;\nSELECT 'commit;';\nDO $$ BEGIN\n  IF current_setting('lock_timeout') <> '5s' OR current_setting('statement_timeout') <> '2min' THEN RAISE EXCEPTION 'timeouts not set'; END IF;\nEND $$;`,
    sha256: "d".repeat(64),
  };
  assert.deepEqual(await migrate(db, [...files, timed]), [2]);
  assert.equal((await db.query<{ t: string }>("SELECT current_setting('lock_timeout') AS t")).rows[0].t, "0", "SET LOCAL: the timeouts end with the file's transaction");
  await db.close();

  const dir = mkdtempSync(path.join(tmp, "migrations-"));
  writeFileSync(path.join(dir, "0002_second.sql"), "SELECT 1;");
  assert.throws(() => readMigrations(dir), /out of sequence/);
  writeFileSync(path.join(dir, "0001_First.sql"), "SELECT 1;");
  assert.throws(() => readMigrations(dir), /not named NNNN_name.sql/);
  console.log("ok - migrations: once each, a changed or missing file refused, a failed file rolled back, BEGIN/COMMIT/ROLLBACK refused, lock and statement timeouts set");
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
    () => s.addOrganisation({ id: "org_1", type: "business", name: "O", createdAt: now, updatedAt: now, paymentPage: { handle: "SHARED" } } as any, false),
    /payment page handle is taken/,
  );
  assert.equal(await s.findOrganisation("org_1"), undefined, "the refused org was not written");
  await s.addOrganisation({ id: "org_1", type: "business", name: "O", createdAt: now, updatedAt: now } as any, false);
  await assert.rejects(() => s.updateOrganisation("org_1", { paymentPage: { handle: "shared" } } as any), /taken/);
  await s.updateUser("u_1", { paymentPage: { handle: "mine" } } as any);
  assert.equal((await s.updateOrganisation("org_1", { paymentPage: { handle: "shared" } } as any)).paymentPage?.handle, "shared", "a freed handle can be claimed");
  await assert.rejects(() => s.updateUser("u_1", { paymentPage: { handle: "Shared" } } as any), /taken/);
  assert.deepEqual(
    (await db.query("SELECT handle_lc, owner_kind, owner_id FROM payment_handles ORDER BY handle_lc")).rows,
    [{ handle_lc: "mine", owner_kind: "user", owner_id: "u_1" }, { handle_lc: "shared", owner_kind: "organisation", owner_id: "org_1" }],
  );

  // Credentials and idempotency keys are unique in the table, whatever the caller checked.
  await s.addSession({ id: "s_1", userId: "u_1", tokenHash: "th", createdAt: now, lastUsedAt: now, expiresAt: now });
  await assert.rejects(() => s.addSession({ id: "s_2", userId: "u_1", tokenHash: "th", createdAt: now, lastUsedAt: now, expiresAt: now }), /duplicate key/);
  await s.addUser({ id: "u_2", address: `0x${"22".repeat(20)}`, iban: "", createdAt: now, passkey: { credentialId: "cred" } } as any);
  await assert.rejects(() => s.addUser({ id: "u_3", address: `0x${"33".repeat(20)}`, iban: "", createdAt: now, passkey: { credentialId: "cred" } } as any), /duplicate key/);
  await s.addReceiptShare({ id: "rs_1", slug: "a", transferId: "t", userId: "u_1", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: now });
  await assert.rejects(
    () => s.addReceiptShare({ id: "rs_2", slug: "b", transferId: "t", userId: "u_1", fields: {} as any, createdAt: now, updatedAt: now, expiresAt: now }),
    /duplicate key/,
    "one live share per transfer",
  );
  await db.close();
  console.log("ok - Postgres keys: one payment-handle namespace, unique credentials, one live share per transfer");
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
  const run = (value: string | undefined) =>
    spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./services/api/src/config/env.ts')"], {
      env: { ...process.env, STORE_BACKEND: value },
      encoding: "utf8",
    });
  const refused = run("postgres");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /STORE_BACKEND must be json/);
  assert.equal(run("json").status, 0, refused.stderr);
  console.log("ok - STORE_BACKEND=postgres refuses to start until the cut-over");
}
