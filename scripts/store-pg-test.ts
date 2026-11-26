/**
 * The store suite on a real Postgres 17, and the cases PGlite cannot show
 * because it has one connection: two migration runners at once, parallel
 * claims on one row, a second holder of an advisory lock.
 *
 * Not part of the offline `npm run check`. Needs a server:
 *   TEST_DATABASE_URL=postgresql:///postgres?host=/tmp npm run check:pg
 * (the default; Homebrew's postgresql@17 listens there). The URL names a
 * database to connect to as a role that may CREATE DATABASE. Each run creates
 * a uniquely named database and drops it at the end, pass or fail.
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { conditionalWriteSuite, storeSuite } from "./_store-suite.js";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-store-pg-")), "db.json");

const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { migrate } = await import("../services/api/src/store/pg/migrate.js");
const { openPool } = await import("../services/api/src/store/pg/sql.js");

const adminUrl = process.env.TEST_DATABASE_URL || "postgresql:///postgres?host=/tmp";
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
    "SELECT datname FROM pg_database d WHERE datname ~ '^zold_test_[0-9]+_[0-9a-f]+$' AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)",
  )
).rows) {
  const born = Number(datname.split("_")[2]);
  if (Date.now() / 1000 - born > 3600) {
    await admin.query(`DROP DATABASE IF EXISTS ${datname}`);
    console.log(`swept a stale test database (${datname})`);
  }
}
await admin.query(`CREATE DATABASE ${name}`);
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
  assert.deepEqual([...ra, ...rb].sort((x, y) => x - y), [1, 2], "each file applied once, by one runner");
  console.log(`ok - two parallel migration runners apply each file once (server_version_num ${version})`);

  const s = createPgStore(a);
  await storeSuite(s);
  await conditionalWriteSuite(s);
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
    const third = startApi(200);
    try {
      await third.listening();
    } finally {
      third.child.kill();
      await third.exited;
    }
  }
  console.log("ok - start lock: a second API exits before it listens; a cut lock connection exits the first; a new one then starts");

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
} finally {
  for (const db of opened) await db.close().catch(() => {});
  // pool.end() resolves before every socket has closed; a backend still
  // attached when DROP … WITH (FORCE) terminates it errors on its client.
  // Wait for the sessions to go, so the drop finds none.
  const left = async () =>
    (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name])).rows[0].n;
  for (let i = 0; i < 100 && (await left()) > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
