/**
 * Plain numbered SQL migrations (services/api/migrations/NNNN_name.sql), run
 * in order, one transaction per file. Each applied file is recorded with its
 * SHA-256; a recorded file whose content changed is refused, and so is a
 * recorded version with no file. We roll forward: there are no down files.
 *
 * Every transaction takes one advisory lock first, so two runners on one
 * database queue and a file is never applied twice.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, Sql } from "./sql.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

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
  await q.query("SELECT pg_advisory_xact_lock(hashtext('zold:migrations'))");
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
  const done: number[] = [];
  const before = await db.tx((q) => applied(q, migrations));
  for (const m of migrations) {
    if (before.has(m.version)) continue;
    const ran = await db.tx(async (q) => {
      // Another runner may have applied it while this one waited for the lock.
      if ((await applied(q, migrations)).has(m.version)) return false;
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)", [m.version, m.name, m.sha256]);
      return true;
    });
    if (ran) done.push(m.version);
  }
  return done;
}
