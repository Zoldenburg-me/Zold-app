/**
 * The store suite on a real Postgres 17, and the cases PGlite cannot show
 * because it has one connection: two migration runners at once, parallel
 * claims on one row, a second holder of an advisory lock. Then the API's own
 * store on Postgres: the §2 concurrency tests (pg-concurrency-test.ts) and
 * the suites that hold the S2 race tests, each in a database of its own.
 * Between them, the application role's grants (§5).
 *
 * Not part of the offline `npm run check`. Needs a server:
 *   TEST_DATABASE_URL=postgresql:///postgres?host=/tmp npm run check:pg
 * (the default; Homebrew's postgresql@17 listens there). The URL names a
 * database to connect to as a role that may CREATE DATABASE and CREATE ROLE.
 * Each run creates a uniquely named database and application role and drops
 * both at the end, pass or fail. The API suites run as that role, as the API
 * does (§7), with the grants of zold_grant_app (migrations/0006, 0007).
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { conditionalWriteSuite, keptRowsSuite, outboxSuite, storeSuite } from "./_store-suite.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-store-pg-")), "db.json");

const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { assertSchemaCurrent, migrate, readMigrations } = await import("../services/api/src/store/pg/migrate.js");
const { databaseUrlIsLocal, openPool } = await import("../services/api/src/store/pg/sql.js");

const adminUrl = process.env.TEST_DATABASE_URL || "postgresql:///postgres?host=/tmp";
// The sweep below drops databases on this server. Only a server on this
// machine, unless the operator says the remote one is disposable.
if (!databaseUrlIsLocal(adminUrl) && process.env.ZOLD_TEST_DB_REMOTE_OK !== "1") {
  console.error("TEST_DATABASE_URL is not a local socket or loopback; set ZOLD_TEST_DB_REMOTE_OK=1 if that server is disposable");
  process.exit(1);
}
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
admin.on("error", () => {}); // an idle admin client cut by the server: the pool drops it
// The creation time is in the name, so a later run can tell a database a
// killed run left behind (SIGKILL skips the drop below) from a live one.
const name = `zold_test_${Math.floor(Date.now() / 1000)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const urlFor = (db: string) => {
  // Swap the database name only; the socket, role and parameters stay.
  const [base, query = ""] = adminUrl.split("?");
  return `${base.replace(/\/[^/]*$/, `/${db}`)}${query ? `?${query}` : ""}`;
};

// Sweep test databases over an hour old with nobody connected: a run killed
// before its drop. One still in use, or of the old unnamed form, is left.
for (const { datname } of (
  await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database d WHERE datname ~ '^zold_test_[0-9]+_[0-9a-f]+(_s[0-9a-f]+)?$' AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)",
  )
).rows) {
  const born = Number(datname.split("_")[2]);
  if (Date.now() / 1000 - born > 3600) {
    await admin.query(`DROP DATABASE IF EXISTS ${datname}`);
    console.log(`swept a stale test database (${datname})`);
  }
}
// Roles are cluster-wide, not per database: the application role of this run
// has a name of its own, is dropped in the finally below, and one a killed
// run left behind (over an hour old, its databases swept above) goes here.
for (const { rolname } of (await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname ~ '^zold_test_app_[0-9]+_[0-9a-f]+$'")).rows) {
  if (Date.now() / 1000 - Number(rolname.split("_")[3]) > 3600) {
    await admin.query(`DROP ROLE IF EXISTS ${rolname}`).then(
      () => console.log(`swept a stale test role (${rolname})`),
      () => {},
    );
  }
}
await admin.query(`CREATE DATABASE ${name}`);
const appRole = `zold_test_app_${Math.floor(Date.now() / 1000)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const appPassword = randomUUID();
await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}'`);
/** `db` as the application role: what the API connects as (§7). The role
 *  goes in the query, which node-postgres reads, so a socket URL stays one
 *  that WHATWG's URL parses (the commit-cut proxy reads it). */
const urlAs = (db: string) => {
  const u = urlFor(db).replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, "$1");
  return `${u}${u.includes("?") ? "&" : "?"}user=${appRole}&password=${appPassword}`;
};
/** Migrate `db` as the owner (this run's admin role), then grant the application role. */
const migrateAndGrant = async (db: string) => {
  const target = openPool(urlFor(db), { realMoney: false });
  try {
    await migrate(target);
    await target.query("SELECT zold_grant_app($1)", [appRole]);
  } finally {
    await target.close();
  }
};
const opened: { close(): Promise<void> }[] = [];
const open = () => {
  const db = openPool(urlFor(name), { realMoney: false });
  opened.push(db);
  return db;
};
try {
  const version = (await admin.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v;
  assert.equal(version.slice(0, 2), "17", `the server is Postgres 17 (got ${version})`);

  // Two runners at once: each file is applied by exactly one of them.
  const a = open();
  const b = open();
  const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
  // Each runner takes the lock per file, so the two may share the files out.
  assert.deepEqual([...ra, ...rb].sort((x, y) => x - y), readMigrations().map((m) => m.version), "each file applied once, by one runner");
  console.log(`ok - two parallel migration runners apply each file once (server_version_num ${version})`);

  const s = createPgStore(a);
  await storeSuite(s);
  await conditionalWriteSuite(s);
  await outboxSuite(s);
  await keptRowsSuite(s, a);
  console.log("ok - store suite on the Postgres backend (Postgres 17)");

  // Parallel calls on one row, each on its own connection from the pool.
  const now = new Date().toISOString();
  await s.addUser({ id: "u_race", address: `0x${"99".repeat(20)}`, iban: "", createdAt: now } as any);
  await s.addTransfer({ id: "t_race", userId: "u_race", quoteId: "q_race", state: "CREATED", auth: { challenge: "c" }, txs: [], createdAt: now, updatedAt: now } as any);
  const claims = await Promise.all(Array.from({ length: 10 }, async () => await s.claimAuthorization("t_race")));
  assert.equal(claims.filter(Boolean).length, 1, "10 parallel claims: one wins");

  await s.addSafeOp({ id: "so_race", orgId: "org_race", state: "PENDING", signatures: [], dropped: [], createdAt: now, updatedAt: now } as any);
  const owners = Array.from({ length: 5 }, (_, i) => ({ memberId: `m${i}`, ownerAddress: `0x${String(i).repeat(40)}`, signature: "0x", signedAt: now }));
  const signed = await Promise.all(owners.map(async (o) => await s.addSafeOpSignature("so_race", o as any)));
  assert.ok(signed.every(Boolean));
  assert.equal((await s.findSafeOp("so_race"))?.signatures.length, 5, "5 owners signing at once: every signature lands");

  const dep = { userId: "u_race", chainId: 84532, token: "EURE", txHash: `0x${"5e".repeat(32)}`, logIndex: 0, amountUnits: "1", holding: "none", txs: [], createdAt: now, updatedAt: now };
  const deps = await Promise.all(Array.from({ length: 5 }, async (_, i) => await s.addCryptoDeposit({ ...dep, id: `dep_race_${i}` } as any)));
  assert.equal(new Set(deps.map((d) => d.id)).size, 1, "5 parallel records of one transfer: one row, returned to each");
  assert.equal((await a.query("SELECT 1 FROM crypto_deposits WHERE tx_hash_lc = $1", [dep.txHash])).rows.length, 1);

  // Every transaction is READ COMMITTED, whatever the database default says.
  await admin.query(`ALTER DATABASE ${name} SET default_transaction_isolation = 'repeatable read'`);
  const rr = open();
  // The baseline: a plain BEGIN on a new session really is REPEATABLE READ here.
  {
    const c = new pg.Client({ connectionString: urlFor(name) });
    await c.connect();
    try {
      await c.query("BEGIN");
      assert.equal((await c.query<{ transaction_isolation: string }>("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read", "the pinned default applies to a plain BEGIN");
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  }
  assert.equal((await rr.tx((q) => q.query<{ transaction_isolation: string }>("SHOW transaction_isolation"))).rows[0].transaction_isolation, "read committed");
  const srr = createPgStore(rr);

  // Two reviews of different transfers citing one fresh refund tx: one books it.
  for (const id of ["t_ref_a", "t_ref_b"]) {
    await s.addTransfer({ id, userId: "u_race", quoteId: `q-${id}`, state: "MANUAL_REVIEW", txs: [], createdAt: now, updatedAt: now } as any);
  }
  const refund = { state: "REFUNDED" as const, note: "Refunded by hand after checking the chain.", by: "op", evidence: `0x${"4f".repeat(32)}`, refund: { amountEur: 1, movedEur: 1 } };
  const results = await Promise.all(["t_ref_a", "t_ref_b"].map(async (id) => await srr.resolveTransferReview(id, refund)));
  assert.equal(results.filter((r) => r.ok).length, 1, "one refund tx, one transfer");
  assert.ok(results.some((r) => !r.ok && r.code === "EVIDENCE_ON_RECORD"));
  console.log("ok - parallel: one authorization claim, every Safe op signature, one deposit row, one refund tx per transfer");

  // Read-then-write in parallel transactions: without a lock the updates are
  // lost (the baseline), with lockUser, lockOrganisation or lockKey each
  // transaction waits for the last one's commit and reads what it wrote.
  {
    await s.addOrganisation({ id: "org_lk", type: "business", name: "0", createdAt: now, updatedAt: now } as any, false);
    const bump = (lock?: (t: any) => Promise<unknown>) =>
      Promise.all(
        Array.from({ length: 8 }, () =>
          s.tx(async (t) => {
            if (lock) await lock(t);
            const n = Number((await t.findOrganisation("org_lk"))!.name);
            await new Promise((r) => setTimeout(r, 15));
            await t.updateOrganisation("org_lk", { name: String(n + 1) });
          }),
        ),
      );
    const value = async () => Number((await s.findOrganisation("org_lk"))!.name);
    await bump();
    assert.ok((await value()) < 8, "the baseline: a plain read in a transaction locks nothing, updates are lost");
    for (const [label, lock] of [
      ["lockOrganisation", (t: any) => t.lockOrganisation("org_lk")],
      ["lockKey", (t: any) => t.lockKey("org_lk")],
    ] as const) {
      await s.updateOrganisation("org_lk", { name: "0" });
      await bump(lock);
      assert.equal(await value(), 8, `${label}: eight transactions, eight increments`);
    }
    await s.updateUser("u_race", { name: "0" } as any);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        s.tx(async (t) => {
          const n = Number((await t.lockUser("u_race"))!.name);
          await new Promise((r) => setTimeout(r, 15));
          await t.updateUser("u_race", { name: String(n + 1) } as any);
        }),
      ),
    );
    assert.equal((await s.findUser("u_race"))?.name, "8", "lockUser: eight transactions, eight increments");
    // A caught failure in a nested transaction undoes only itself.
    await s.tx(async (t) => {
      await t.updateOrganisation("org_lk", { name: "outer" });
      await assert.rejects(
        s.tx(async (n) => {
          await n.updateOrganisation("org_lk", { name: "inner" });
          await n.addSession({ id: "s_pg1", userId: "u_race", tokenHash: "th_pg", createdAt: now, lastUsedAt: now, expiresAt: now });
          await n.addSession({ id: "s_pg2", userId: "u_race", tokenHash: "th_pg", createdAt: now, lastUsedAt: now, expiresAt: now });
        }),
        /duplicate key/,
      );
    });
    assert.equal((await s.findOrganisation("org_lk"))?.name, "outer");
    await assert.rejects(
      s.tx(async (t) => {
        await t.updateOrganisation("org_lk", { name: "lost" });
        await t.addSession({ id: "s_pg3", userId: "u_race", tokenHash: "th_pg3", createdAt: now, lastUsedAt: now, expiresAt: now });
        await t.addSession({ id: "s_pg4", userId: "u_race", tokenHash: "th_pg3", createdAt: now, lastUsedAt: now, expiresAt: now }).catch(() => {});
      }),
      /a statement in this transaction failed/,
    );
    assert.equal((await s.findOrganisation("org_lk"))?.name, "outer", "an aborted transaction never commits in silence");
  }
  console.log("ok - parallel read-then-write: lost without a lock; lockUser, lockOrganisation, lockKey serialise it; nested savepoints; no silent COMMIT after a failed statement");

  // A session-level advisory lock is held against every other connection:
  // the start lock of §2 (S3) rests on this.
  const lockKey = `api:${name}`;
  const c1 = new pg.Client({ connectionString: urlFor(name) });
  const c2 = new pg.Client({ connectionString: urlFor(name) });
  await c1.connect();
  await c2.connect();
  try {
    const take = async (c: pg.Client) => (await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey])).rows[0].ok;
    assert.equal(await take(c1), true);
    assert.equal(await take(c2), false, "a second connection cannot take a held lock");
    await c1.end();
    assert.equal(await take(c2), true, "a closed connection releases it");
  } finally {
    await c2.end().catch(() => {});
    await c1.end().catch(() => {});
  }
  console.log("ok - an advisory lock is held against other connections and released with its own");

  // The one-process start lock (§2): a second API on one database exits
  // before it listens, and the first exits once its lock connection is cut.
  {
    const { spawn } = await import("node:child_process");
    const startApi = (pingMs = 5000) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/_start-lock-child.ts"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, START_LOCK_URL: urlFor(name), START_LOCK_PING_MS: String(pingMs) },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
      const listening = async () => {
        for (let i = 0; i < 400 && !out.includes("listening"); i++) {
          if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}: ${err}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.match(out, /listening/);
      };
      return { child, exited, listening, output: () => ({ out, err }) };
    };
    const lockHolder = async () =>
      (
        await admin.query<{ pid: number }>(
          "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.datname = $1 AND l.objid = (hashtext('api:' || $1)::bigint & 4294967295)",
          [name],
        )
      ).rows.map((r) => r.pid);

    const first = startApi();
    try {
      await first.listening();
      assert.equal((await lockHolder()).length, 1, "the first API holds the start lock");
      const second = startApi();
      assert.equal(await second.exited, 1, "the second API exits non-zero");
      assert.doesNotMatch(second.output().out, /listening/, "before it listens");
      assert.match(second.output().err, /holds this deployment's start lock/);

      const [pid] = await lockHolder();
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      assert.equal(await first.exited, 1, "the first API exits once its lock connection is cut");
      assert.match(first.output().err, /lost its start lock/);
    } finally {
      first.child.kill();
    }
    // A database restart or a silent loss is the same to the process: its
    // lock connection is gone. Once it has exited, a new process starts.
    // A connection that stops answering without closing (a half-open socket):
    // the backend is stopped, so the ping is never answered and no event
    // fires. The process exits on the unanswered ping all the same.
    const third = startApi(200);
    try {
      await third.listening();
      const [stuck] = await lockHolder();
      // Needs the server on this machine, run as this OS user (Homebrew's
      // postgresql@17 is); otherwise this case is skipped, said so. On macOS
      // the cluster is Homebrew's, so there a skip is a failure: this is the
      // one place the case runs.
      let signalable = true;
      try {
        process.kill(stuck, 0);
      } catch {
        signalable = false;
        if (process.platform === "darwin") throw new Error("unanswered ping: the server's backend cannot be signalled, so this case would be skipped on the Mac that runs it");
        console.log("skip - unanswered ping: the server's backend cannot be signalled from here");
      }
      if (signalable) {
        process.kill(stuck, "SIGSTOP");
        try {
          const exit = await Promise.race([third.exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 15_000))]);
          assert.equal(exit, 1, "an unanswered ping exits the API");
          assert.match(third.output().err, /lost its start lock \(ping (failed|unanswered)\)/);
        } finally {
          process.kill(stuck, "SIGCONT");
          await admin.query("SELECT pg_terminate_backend($1)", [stuck]);
        }
      }
    } finally {
      third.child.kill();
      await third.exited;
      // Its lock is released with its connection, which the server may close
      // a moment after the process exits.
      for (let i = 0; i < 100 && (await lockHolder()).length; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const fourth = startApi(200);
    try {
      await fourth.listening();
    } finally {
      fourth.child.kill();
      await fourth.exited;
    }
  }
  console.log("ok - start lock: a second API exits before it listens; a cut lock connection exits the first; so does one that stops answering; a new one then starts");

  // An idle pooled connection killed by the server (a restart, an OOM-killed
  // backend): the pool logs it without the URL, the process lives on, and the
  // next query opens a new connection.
  const idle = open();
  const pid = (await idle.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    assert.equal((await admin.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid])).rows[0].ok, true);
    for (let i = 0; i < 100 && !logged.length; i++) await new Promise((r) => setTimeout(r, 50));
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1, "the pool reports the lost idle connection once");
  assert.match(logged[0], /idle Postgres connection lost \(57P01\)/);
  assert.ok(!logged[0].includes(name) && !logged[0].includes("postgresql:"), "the log line carries no URL");
  const next = (await idle.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  assert.notEqual(next, pid, "the next query runs on a new connection");
  console.log("ok - an idle pooled connection terminated by the server is logged and replaced; the process survives");

  // §5, §7: the application role. Least privilege, checked as that role on a
  // database of its own: the whole store suite works with its grants, and
  // what it must not do is refused.
  {
    const db = `${name}_s${Math.random().toString(16).slice(2, 10)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const owner = openPool(urlFor(db), { realMoney: false });
    const app = openPool(urlAs(db), { realMoney: false });
    try {
      await migrate(owner);
      await owner.query("SELECT zold_grant_app($1)", [appRole]);
      assert.equal((await app.query<{ u: string }>("SELECT current_user AS u")).rows[0].u, appRole);
      await assertSchemaCurrent(app);
      const as = createPgStore(app);
      await storeSuite(as);
      await conditionalWriteSuite(as);
      await outboxSuite(as);
      const denied = /permission denied/;
      await assert.rejects(() => app.query("DELETE FROM ledger"), denied, "no DELETE grant on ledger");
      await assert.rejects(() => app.query("DELETE FROM transfers"), denied, "nor on transfers");
      for (const t of ["processed_monerium_orders", "processed_monerium_webhooks", "monerium_issue_orders", "crypto_deposits", "crypto_sends", "users", "payment_requests"]) {
        await assert.rejects(() => app.query(`DELETE FROM ${t}`), denied, `no DELETE on ${t}: no store method deletes from it`);
      }
      await assert.rejects(() => app.query("UPDATE audit SET doc = doc"), denied, "audit: no UPDATE grant");
      await assert.rejects(() => app.query("INSERT INTO ledger_history (entry_id, doc) VALUES ('x', '{}')"), denied, "history is written by the trigger only");
      await assert.rejects(() => app.query("DELETE FROM schema_migrations"), denied, "schema_migrations is read-only");
      await assert.rejects(() => app.query("TRUNCATE sessions"), denied, "no TRUNCATE anywhere");
      await assert.rejects(() => app.query("CREATE TABLE app_made (x int)"), denied, "no DDL: nothing created in the schema");
      await assert.rejects(() => app.query("DROP TABLE contacts"), /must be owner/, "nor dropped");
      await assert.rejects(() => app.query("ALTER TABLE ledger DISABLE TRIGGER ledger_no_delete"), /must be owner/, "nor a trigger turned off");
      await assert.rejects(() => app.query("SELECT zold_grant_app($1)", [appRole]), denied, "the role cannot grant itself more");
      // What it may do: delete where a store method deletes, and its ledger
      // writes leave history through the trigger.
      assert.ok((await app.query("DELETE FROM contacts WHERE FALSE")).rows);
      await as.addLedgerEntries([{ id: "le_app", orgId: "org_app", direction: "in", asset: "EURe", amount: "1", at: new Date().toISOString(), createdAt: new Date().toISOString() } as any]);
      await as.updateLedgerEntry("le_app", { note: "categorised" } as any);
      assert.equal((await app.query("SELECT 1 FROM ledger_history WHERE entry_id = 'le_app'")).rows.length, 1, "the app role's update leaves history");
      // A temporary table named ledger_history does not take the history row.
      // The role has no TEMP; granted back here, the trigger still writes the
      // real table.
      await assert.rejects(() => app.query("CREATE TEMP TABLE shadow (x int)"), denied, "no temporary tables");
      await owner.query(`GRANT TEMPORARY ON DATABASE ${db} TO ${appRole}`);
      const c = new pg.Client({ connectionString: urlAs(db) });
      await c.connect();
      try {
        await c.query("CREATE TEMP TABLE ledger_history (entry_id text, org_id text, doc json)");
        await c.query(`UPDATE ledger SET doc = json_build_object('id', 'le_app', 'note', 'shadowed') WHERE id = 'le_app'`);
        assert.equal((await c.query("SELECT 1 FROM pg_temp.ledger_history")).rows.length, 0, "the temporary table got nothing");
      } finally {
        await c.end();
      }
      assert.equal((await app.query("SELECT 1 FROM ledger_history WHERE entry_id = 'le_app'")).rows.length, 2, "the real table got the row");
    } finally {
      await app.close();
      await owner.close();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  }
  // zold_grant_app in a schema whose name needs quotes, owned by a role that
  // does not own the database: run by the database's owner it grants; run by
  // the schema's owner, whose REVOKE TEMPORARY is only a warning, it refuses.
  {
    const db = `${name}_s${Math.random().toString(16).slice(2, 10)}`;
    // Named like the application role, so a killed run's is swept the same way.
    const schemaOwner = `zold_test_app_${Math.floor(Date.now() / 1000)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const pw = randomUUID();
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.query(`CREATE ROLE ${schemaOwner} LOGIN PASSWORD '${pw}'`);
    try {
      const dbOwner = openPool(urlFor(db), { realMoney: false });
      try {
        await dbOwner.query(`CREATE SCHEMA "Zold Q" AUTHORIZATION ${schemaOwner}`);
        await admin.query(`ALTER DATABASE ${db} SET search_path = "Zold Q"`);
        const asSchemaOwner = (() => {
          const u = urlFor(db).replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, "$1");
          return `${u}${u.includes("?") ? "&" : "?"}user=${schemaOwner}&password=${pw}`;
        })();
        const so = openPool(asSchemaOwner, { realMoney: false });
        try {
          await migrate(so);
          await assert.rejects(() => so.query("SELECT zold_grant_app($1)", [appRole]), /can still create temporary tables/, "run by a role that cannot revoke TEMP, the grant fails loudly");
        } finally {
          await so.close();
        }
        const fresh = openPool(urlFor(db), { realMoney: false });
        try {
          await fresh.query("SELECT zold_grant_app($1)", [appRole]);
          const can = await fresh.query<{ ok: boolean; temp: boolean }>(
            `SELECT has_table_privilege($1, '"Zold Q".ledger', 'UPDATE') AS ok, has_database_privilege($1, current_database(), 'TEMPORARY') AS temp`,
            [appRole],
          );
          assert.deepEqual(can.rows[0], { ok: true, temp: false }, "run by the database owner: granted on the quoted schema's tables, no TEMP");
        } finally {
          await fresh.close();
        }
      } finally {
        await dbOwner.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${schemaOwner}`);
    }
  }
  console.log("ok - the application role: the store suite runs on its grants; no DELETE or TRUNCATE on kept rows, no UPDATE on audit, no write to history or schema_migrations, no DDL, no TEMP; a shadowing temporary ledger_history does not take the history row; granted in a schema whose name needs quotes; a grant run by a role that cannot revoke TEMP fails");

  // §6: the importer and the export through their CLIs, on a database of its
  // own migrated as a deploy would, over a store the store's code wrote.
  {
    const { spawnSync } = await import("node:child_process");
    const { existsSync, readFileSync } = await import("node:fs");
    const { digest, importSnapshot } = await import("../services/api/src/store/pg/port.js");
    const db = `${name}_s${Math.random().toString(16).slice(2, 10)}`;
    const dir = mkdtempSync(path.join(tmpdir(), "zold-pg-import-"));
    const fixture = path.join(dir, "fixture.json");
    const cwd = new URL("..", import.meta.url).pathname;
    // DATABASE_URL and nothing else of a deployment: no signing key, no chain.
    const cli = (args: string[], url = urlFor(db)) =>
      spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, USER: process.env.USER!, DATABASE_URL: url } });
    assert.equal(spawnSync(process.execPath, ["--import", "tsx", "scripts/_import-fixture.ts", fixture], { cwd, encoding: "utf8" }).status, 0);
    const source = JSON.parse(readFileSync(fixture, "utf8"));
    await admin.query(`CREATE DATABASE ${db}`);
    const owner = openPool(urlFor(db), { realMoney: false });
    const lock = new pg.Client({ connectionString: urlFor(db) });
    const count = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            "SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM ledger) + (SELECT count(*) FROM outbox) + (SELECT count(*) FROM payment_handles) AS n",
          )
        ).rows[0].n,
      );
    try {
      await migrateAndGrant(db);
      // An API holding the start lock: the import refuses, writing nothing.
      await lock.connect();
      await lock.query("SELECT pg_advisory_lock(hashtext('api:' || current_database()))");
      const locked = cli(["scripts/pg-import.ts", "import", fixture]);
      assert.equal(locked.status, 1);
      assert.match(locked.stderr, /an API holds this deployment's start lock/);
      assert.equal(await count(), 0);
      await lock.query("SELECT pg_advisory_unlock_all()");

      // The importer's connection killed mid-import: nothing committed.
      await assert.rejects(
        importSnapshot(owner, structuredClone(source), {
          async beforeRow(c, i) {
            if (c !== "ledger" || i !== 1) return;
            const { rows } = await admin.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname = $1 AND state LIKE 'idle in transaction%'", [db]);
            assert.equal(rows.length, 1, "the importer is between two inserts");
            await admin.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
          },
        }),
      );
      assert.equal(await count(), 0, "a connection killed mid-import leaves the target empty");

      const first = cli(["scripts/pg-import.ts", "import", fixture]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /imported, read back and verified before the commit/);
      assert.match(first.stdout, /verify: every collection's count and hash match/);
      assert.ok(!first.stdout.includes("Lindner"), "the import prints no row");
      const second = cli(["scripts/pg-import.ts", "import", fixture]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /already holds this snapshot; nothing changed/);
      assert.equal(cli(["scripts/pg-import.ts", "verify", fixture]).status, 0);

      // Export, the rollback path: the snapshot again, and refused under the start lock.
      const out = path.join(dir, "exported.json");
      await lock.query("SELECT pg_advisory_lock(hashtext('api:' || current_database()))");
      const refused = cli(["scripts/pg-export.ts", out]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /start lock/);
      assert.equal(existsSync(out), false);
      await lock.query("SELECT pg_advisory_unlock_all()");
      const exp = cli(["scripts/pg-export.ts", out]);
      assert.equal(exp.status, 0, exp.stderr);
      assert.match(exp.stdout, /verify: every collection's count and hash match Postgres/);
      const exported = JSON.parse(readFileSync(out, "utf8"));
      assert.deepEqual(exported, source, "export → the imported db.json, rows in order");
      assert.deepEqual(digest(exported), digest(source));
      assert.equal(cli(["scripts/pg-export.ts", out]).status, 1, "an existing file is not overwritten");
      assert.equal(cli(["scripts/pg-export.ts", "--verify", out]).status, 0, "the export verifies again later");

      // A signup on Postgres (no organisation: only the JSON load makes one)
      // and a session dead past retention, not yet pruned: the export
      // verifies as written; as an import source it is refused.
      await owner.query("INSERT INTO users (id, doc) VALUES ('u_signup', $1::json)", [JSON.stringify({ id: "u_signup", address: "0x5165", createdAt: new Date().toISOString() })]);
      await owner.query("INSERT INTO sessions (id, doc) VALUES ('s_dead', $1::json)", [
        JSON.stringify({ id: "s_dead", userId: "u_signup", tokenHash: "th-dead", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" }),
      ]);
      const outSignup = path.join(dir, "exported-signup.json");
      assert.equal(cli(["scripts/pg-export.ts", outSignup]).status, 0);
      const again = cli(["scripts/pg-export.ts", "--verify", outSignup]);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /as written, matches Postgres/);
      const asSource = cli(["scripts/pg-import.ts", "verify", outSignup]);
      assert.equal(asSource.status, 1);
      assert.match(asSource.stderr, /no organisation yet/);
      await owner.query("DELETE FROM sessions WHERE id = 's_dead'");
      await owner.query("DELETE FROM users WHERE id = 'u_signup'");

      // The API's store serves the imported rows on its grants.
      const app = openPool(urlAs(db), { realMoney: false });
      try {
        const as = createPgStore(app);
        const u = source.users[0];
        assert.deepEqual(await as.findUser(u.id), u);
        const le = source.ledger[0];
        await as.updateLedgerEntry(le.id, { note: "categorised after import" } as any);
        assert.equal((await as.list("ledger")).find((x) => x.id === le.id)?.note, "categorised after import");
      } finally {
        await app.close();
      }
      // That change left ledger_history, which db.json has no place for: the
      // export refuses to drop it, and writes it only through age.
      const out2 = path.join(dir, "exported-2.json");
      const noHistory = cli(["scripts/pg-export.ts", out2]);
      assert.equal(noHistory.status, 1);
      assert.match(noHistory.stderr, /ledger_history has 1 row\(s\)/);
      assert.equal(existsSync(out2), false);
      const noAge = cli(["scripts/pg-export.ts", out2, "--ledger-history", path.join(dir, "history.jsonl.age")], urlFor(db));
      if (noAge.status !== 0) assert.match(noAge.stderr, /age is not installed|no recipients/);
      // A changed target no longer verifies against the source.
      const stale = cli(["scripts/pg-import.ts", "verify", fixture]);
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /VERIFY FAILED: ledger differ/);
      assert.equal(cli(["scripts/pg-export.ts", "--verify", out]).status, 1, "and neither does the older export");
    } finally {
      await lock.end().catch(() => {});
      await owner.close();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  }
  console.log("ok - §6 on Postgres 17: import refused under the start lock and rolled back when its connection is killed; imported and verified, a second run changes nothing; export refused under the start lock, then equal to the source and verified again by --verify, also with a signup and a dead session in it; all with DATABASE_URL alone; the API's store serves the imported rows; ledger_history is never dropped or written in plain text");

  // The API's own store on Postgres (STORE_BACKEND=postgres): the §2
  // concurrency tests, and the suites that hold the S2 race tests, each in a
  // database of its own, migrated as a deploy would, with real parallel
  // connections. A suite that checks the JSON file itself skips that check.
  const suites: [string, Record<string, string>?][] = [
    ["scripts/pg-concurrency-test.ts"],
    ["scripts/deposit-invoice-link-test.ts"],
    // Postgres is refused on a real-money chain; this suite runs on the default one under check.
    ["scripts/email-verification-test.ts", { TRANSF_CHAIN_ID: "31337" }],
    ["scripts/zoldenburg-bank-check-test.ts"],
    ["scripts/candide-sweep-race-test.ts"],
    ["scripts/convert-race-test.ts"],
    ["scripts/security-hardening-test.ts"],
    ["scripts/invoicing-profile-test.ts"],
    ["scripts/free-features-test.ts"],
    ["scripts/payment-requests-test.ts"],
    ["scripts/monerium-profile-kind-test.ts"],
    ["scripts/monerium-money-in-test.ts"],
    ["scripts/merchant-links-test.ts"],
    ["scripts/shopify-orders-test.ts"],
    ["scripts/webhook-test.ts"],
    ["scripts/crypto-deposit-test.ts"],
    ["scripts/wallet-proof-test.ts"],
    ["scripts/outbox-test.ts"],
    ["scripts/checkout-service-test.ts"],
    ["scripts/identity-race-test.ts"],
    // One live receipt share per transfer under parallel posts (receipt_shares_live).
    ["scripts/receipt-share-route-test.ts", { TRANSF_CHAIN_ID: "31337" }],
    // A company payout's row and its statement line written under the account's lock.
    ["scripts/org-monerium-payouts-test.ts"],
    ["scripts/beleg-test.ts", { TRANSF_CHAIN_ID: "31337" }],
  ];
  const { spawn } = await import("node:child_process");
  const { freePort } = await import("./_free-port.js");
  const runSuite = async ([file, env = {}]: [string, Record<string, string>?]) => {
    const db = `${name}_s${Math.random().toString(16).slice(2, 10)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    try {
      await migrateAndGrant(db);
      const child = spawn(process.execPath, ["--import", "tsx", file], {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          STORE_BACKEND: "postgres",
          // As the API runs: the application role, not the owner.
          DATABASE_URL: urlAs(db),
          // As npm run check sets it: a local RPC nothing listens on.
          TRANSF_RPC_URL: process.env.TRANSF_RPC_URL ?? `http://127.0.0.1:${await freePort()}`,
          ...env,
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      return { file, code, out };
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  };
  const ran: Awaited<ReturnType<typeof runSuite>>[] = [];
  const queue = [...suites];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) ran.push(await runSuite(next));
    }),
  );
  const failedSuites = ran.filter((r) => r.code !== 0);
  for (const r of failedSuites) console.error(`FAIL ${r.file} on Postgres (exit ${r.code})\n${r.out.split("\n").slice(-40).join("\n")}`);
  assert.equal(failedSuites.length, 0, `${failedSuites.length} suite(s) failed on Postgres`);
  console.log(`ok - on the API's store over Postgres 17: ${suites.map(([f]) => f.replace(/^scripts\/|-test\.ts$/g, "")).join(", ")}`);
} finally {
  for (const db of opened) await db.close().catch(() => {});
  // pool.end() resolves before every socket has closed; a backend still
  // attached when DROP … WITH (FORCE) terminates it errors on its client.
  // Wait for the sessions to go, so the drop finds none.
  const left = async () =>
    (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name])).rows[0].n;
  for (let i = 0; i < 100 && (await left()) > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  // After every database it has grants in is gone.
  await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
  await admin.end();
}
