/**
 * Plain numbered SQL migrations (services/api/migrations/NNNN_name.sql), run
 * in order, one transaction per file. Each applied file is recorded with its
 * SHA-256; a recorded file whose content changed is refused, and so is a
 * recorded version with no file. We roll forward: there are no down files.
 *
 * Every transaction takes one advisory lock first, so two runners on one
 * database queue and a file is never applied twice. Advisory locks are per
 * database, so two databases on one server (parallel test runs) do not queue
 * behind each other.
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

/** A statement's first word, when it starts a transaction command. */
const TX_CONTROL = /^(begin|commit|rollback|abort|end|start\s+transaction|savepoint|release|prepare\s+transaction)\b/i;

/**
 * The first transaction command in the file, read the way Postgres reads it:
 * one scan from left to right, so a marker inside a string, a quoted name, a
 * dollar-quoted body or a comment (nested, as Postgres nests them) never
 * opens or closes anything else.
 */
export function transactionControl(sql: string): string | undefined {
  let stmt = "";
  let i = 0;
  const word = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);
  const quoted = (q: string, backslash: boolean) => {
    for (i++; i < sql.length; i++) {
      if (backslash && sql[i] === "\\") i++;
      else if (sql[i] === q && sql[i + 1] === q) i++;
      else if (sql[i] === q) return void i++;
    }
  };
  const command = () => {
    const m = TX_CONTROL.exec(stmt.trim());
    stmt = "";
    return m ? m[1].toUpperCase().replace(/\s+/g, " ") : undefined;
  };
  while (i < sql.length) {
    const c = sql[i];
    const tag = c === "$" && !word(sql[i - 1]) ? /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64)) : null;
    if (c === ";") {
      const hit = command();
      if (hit) return hit;
      i++;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      stmt += " ";
    } else if (sql.startsWith("/*", i)) {
      for (let depth = 0; i < sql.length; ) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          i += 2;
          if (--depth === 0) break;
        } else i++;
      }
      stmt += " ";
    } else if (c === "'") {
      // E'...' takes backslash escapes, so E'\'' is one string.
      quoted("'", /e/i.test(sql[i - 1] ?? "") && !word(sql[i - 2]));
      stmt += "''";
    } else if (c === '"') {
      quoted('"', false);
      stmt += '""';
    } else if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      i = end < 0 ? sql.length : end + tag[0].length;
      stmt += "''";
    } else {
      stmt += c;
      i++;
    }
  }
  return command();
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
