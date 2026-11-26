/**
 * Plain numbered SQL migrations (services/api/migrations/NNNN_name.sql), run
 * in order, one transaction per file. Each applied file is recorded with its
 * SHA-256; a recorded file whose content changed is refused, and so is a
 * recorded version with no file. We roll forward: there are no down files.
 *
 * Every transaction takes one advisory lock first, so two runners on one
 * database queue and a file is never applied twice. The key carries the
 * database name: advisory locks are cluster-wide, and two databases on one
 * server (parallel test runs) must not queue behind each other.
 *
 * A file runs inside our transaction, so it may not hold its own BEGIN,
 * COMMIT or ROLLBACK (refused: it would commit half the file), and anything
 * that cannot run in a transaction cannot go in one: no CREATE INDEX
 * CONCURRENTLY. A plain CREATE INDEX takes a SHARE lock on its table while it
 * builds. Each file waits at most LOCK_TIMEOUT for a lock and runs at most
 * STATEMENT_TIMEOUT per statement, so a deploy queued behind a long API
 * transaction fails instead of hanging and blocking every query behind it.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, Sql } from "./sql.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "2min";

/** Statements outside comments, quotes and dollar-quoted bodies that start a transaction command. */
const TX_CONTROL = /^(begin|commit|rollback|abort|end|start\s+transaction|savepoint|release|prepare\s+transaction)\b/i;

export function transactionControl(sql: string): string | undefined {
  const bare = sql
    .replace(/\$([a-z_][a-z0-9_]*)?\$[\s\S]*?\$\1\$/gi, "''")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  for (const stmt of bare.split(";")) {
    const m = TX_CONTROL.exec(stmt.trim());
    if (m) return m[1].toUpperCase().replace(/\s+/g, " ");
  }
  return undefined;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
  sha256: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) continue;
    const m = FILE.exec(name);
    if (!m) throw new Error(`migration ${name} is not named NNNN_name.sql`);
    const sql = readFileSync(path.join(dir, name), "utf8");
    out.push({ version: Number(m[1]), name, sql, sha256: createHash("sha256").update(sql).digest("hex") });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is out of sequence: expected ${String(i + 1).padStart(4, "0")}`);
  });
  return out;
}

/** Lock, then the applied rows, refusing any whose file is gone or changed. */
async function applied(q: Sql, migrations: Migration[]): Promise<Set<number>> {
  // A runner waits for another one's whole file, not the application's lock
  // or statement timeout (the pool sets both).
  await q.query("SET LOCAL lock_timeout = 0");
  await q.query("SET LOCAL statement_timeout = 0");
  await q.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':zold:migrations'))");
  await q.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await q.query<{ version: number; name: string; sha256: string }>(
    "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
  );
  for (const r of rows) {
    const m = migrations.find((x) => x.version === r.version);
    if (!m) throw new Error(`migration ${r.name} is applied but its file is gone`);
    if (m.sha256 !== r.sha256) throw new Error(`migration ${r.name} changed after it was applied; add a new migration instead`);
  }
  return new Set(rows.map((r) => r.version));
}

/** Apply what is not applied yet. Returns the versions this call applied. */
export async function migrate(db: Database, migrations = readMigrations()): Promise<number[]> {
  for (const m of migrations) {
    const control = transactionControl(m.sql);
    if (control) throw new Error(`migration ${m.name} contains ${control}: each file already runs in one transaction`);
  }
  const done: number[] = [];
  const before = await db.tx((q) => applied(q, migrations));
  for (const m of migrations) {
    if (before.has(m.version)) continue;
    const ran = await db.tx(async (q) => {
      // Another runner may have applied it while this one waited for the lock.
      if ((await applied(q, migrations)).has(m.version)) return false;
      // After the advisory lock: a runner queued behind another must not time out.
      await q.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await q.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)", [m.version, m.name, m.sha256]);
      return true;
    });
    if (ran) done.push(m.version);
  }
  return done;
}

/**
 * Refuse to serve on a schema other than the one these files make: every
 * file applied, unchanged, and nothing applied that has no file. The API runs
 * as the application role, which has no DDL; the owner role migrates at
 * deploy, before the API starts (§7), so the API only checks.
 */
export async function assertSchemaCurrent(db: Sql, migrations = readMigrations()): Promise<number> {
  const has = await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
  const { rows } = has.rows[0]?.t
    ? await db.query<{ version: number; name: string; sha256: string }>("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
    : { rows: [] };
  const want = migrations.at(-1)?.version ?? 0;
  for (const r of rows) {
    const m = migrations.find((x) => x.version === r.version);
    if (!m) throw new Error(`the database has migration ${r.name}, which this code does not know: refusing to start`);
    if (m.sha256 !== r.sha256) throw new Error(`migration ${r.name} differs from the one applied: refusing to start`);
  }
  if (rows.length !== migrations.length) {
    throw new Error(`the database schema is at version ${rows.at(-1)?.version ?? 0}, this code needs ${want}: run the migrations first`);
  }
  return want;
}
