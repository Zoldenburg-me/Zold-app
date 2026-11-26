/**
 * Postgres → db.json, the rollback path (docs/postgres-store-design.md §6).
 *
 *   DATABASE_URL=… npx tsx scripts/pg-export.ts <out/db.json> [--ledger-history <out.jsonl.age>]
 *
 * Reads every collection in the `Db` shape inside one transaction that holds
 * the deployment's start lock (so it refuses while an API runs, and no API
 * starts until it is done), writes `<out>` owner-only, then reads the file
 * back and checks every collection's count and hash against Postgres.
 * Refuses to overwrite a file.
 *
 * `ledger_history` has no place in db.json. When it has rows the export
 * refuses unless `--ledger-history` names a file for them, which is written
 * age-encrypted to the recipients of scripts/_age.sh (`.age-recipients`, or
 * AGE_RECIPIENTS_FILE), never in plain text. `cap_holds` and
 * `pending_executions` are not exported: holds expire, and an approval in
 * flight answers 410. Undelivered and dead outbox rows go into db.json's
 * `outbox` with the rest; the dead ones are listed for the lead.
 *
 * Prints collection names, counts, hashes and row ids, never a row.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const out = args[0];
const hi = args.indexOf("--ledger-history");
const historyOut = hi >= 0 ? args[hi + 1] : undefined;
if (!out || out.startsWith("--") || (hi >= 0 && !historyOut)) {
  console.error("usage: pg-export.ts <out/db.json> [--ledger-history <out.jsonl.age>]");
  process.exit(2);
}
for (const f of [out, historyOut]) {
  if (f && existsSync(f)) {
    console.error(`${f} exists: refusing to overwrite it`);
    process.exit(1);
  }
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const { openPool } = await import("../services/api/src/store/pg/sql.js");
const { digest, digestMismatches, exportDb, verifyAgainst } = await import("../services/api/src/store/pg/port.js");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** age, as scripts/_age.sh pins it, to its recipients. Throws when either is missing. */
function ageEncrypt(plain: string, to: string) {
  const age = path.join(ROOT, ".toolchain/age-v1.3.2/age/age");
  const recipients = process.env.AGE_RECIPIENTS_FILE || path.join(ROOT, ".age-recipients");
  if (!existsSync(age)) throw new Error("age is not installed: run scripts/fetch-age.sh");
  if (!existsSync(recipients)) throw new Error(`no recipients at ${recipients}: run scripts/secrets.sh init`);
  const r = spawnSync(age, ["-R", recipients, "-o", `${to}.tmp`], { input: plain });
  if (r.status !== 0) throw new Error(`age failed (exit ${r.status})`);
  renameSync(`${to}.tmp`, to);
}

function writeOwnerOnly(file: string, text: string) {
  const fd = openSync(`${file}.tmp`, "wx", 0o600);
  writeFileSync(fd, text);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(`${file}.tmp`, file);
}

const database = openPool(url, { ca: process.env.DATABASE_CA, realMoney: true });
let code = 0;
try {
  const { db, ledgerHistory, postgresOnly } = await exportDb(database);
  if (postgresOnly.ledger_history > 0 && !historyOut) {
    throw new Error(`ledger_history has ${postgresOnly.ledger_history} row(s) and db.json has no place for them: pass --ledger-history <file>`);
  }
  if (historyOut) ageEncrypt(ledgerHistory, historyOut);
  writeOwnerOnly(out, JSON.stringify(db));
  const written = JSON.parse(readFileSync(out, "utf8"));
  const sent = digest(db);
  const bad = digestMismatches(sent, digest(written));
  // And against Postgres again, after the file is on disk.
  const v = await verifyAgainst(database, written);
  for (const [c, { rows, sha256 }] of Object.entries(sent)) console.log(`  ${c.padEnd(28)} ${String(rows).padStart(8)}  ${sha256}`);
  console.log(`not exported: cap_holds ${postgresOnly.cap_holds}, pending_executions ${postgresOnly.pending_executions}; ledger_history ${postgresOnly.ledger_history}${historyOut ? ` → ${historyOut} (age)` : ""}`);
  const dead = db.outbox.filter((o) => o.deadAt).map((o) => o.id);
  const pending = db.outbox.filter((o) => !o.deadAt && !o.deliveredAt).length;
  console.log(`outbox: ${pending} undelivered (the JSON backend's worker delivers them), ${dead.length} dead${dead.length ? `: ${dead.join(", ")}` : ""}`);
  if (bad.length || v.mismatches.length) {
    console.error(`VERIFY FAILED: ${[...new Set([...bad, ...v.mismatches])].join(", ")}`);
    code = 1;
  } else console.log(`wrote ${out}; verify: every collection's count and hash match Postgres`);
} catch (err) {
  const e = err as { code?: string; name?: string; message?: string };
  console.error(`FAILED: ${e.code ? `error code ${e.code}` : (e.message ?? e.name)}`);
  code = 1;
} finally {
  await database.close();
}
process.exit(code);
