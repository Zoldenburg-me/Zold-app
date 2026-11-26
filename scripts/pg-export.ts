/**
 * Postgres → db.json, the rollback path (docs/postgres-store-design.md §6).
 *
 *   DATABASE_URL=… npx tsx scripts/pg-export.ts <out/db.json> [--ledger-history <out.jsonl.age>]
 *   DATABASE_URL=… npx tsx scripts/pg-export.ts --verify <db.json>
 *
 * Needs DATABASE_URL (and DATABASE_CA for TLS) and nothing else of a
 * deployment's environment: no signing key, no chain.
 *
 * Reads every collection in the `Db` shape inside one transaction that holds
 * the deployment's start lock (so it refuses while an API runs, and no API
 * starts until it is done). Still under the lock it writes `<out>`
 * owner-only, reads the file back and checks every collection's count and
 * hash against Postgres; only then are the files put under their names, both
 * or neither. Refuses to overwrite a file, and leaves none behind when it
 * fails. The export is read in one REPEATABLE READ, READ ONLY transaction.
 *
 * `--verify <db.json>` is that same check run again later: the file as
 * written against Postgres, under the start lock. Use it for an export, not
 * `pg-import.ts verify`, which runs the load-time migrations on the file
 * first (an export can hold a user with no organisation yet, which they
 * would give one).
 *
 * db.json is plain JSON, as the JSON backend serves it: write it only where
 * the lease's own db.json lives, or straight into scripts/backup-db.sh.
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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify";
const out = verifyOnly ? args[1] : args[0];
const hi = args.indexOf("--ledger-history");
const historyOut = hi >= 0 ? args[hi + 1] : undefined;
if (!out || out.startsWith("--") || (hi >= 0 && (!historyOut || verifyOnly))) {
  console.error("usage: pg-export.ts <out/db.json> [--ledger-history <out.jsonl.age>] | --verify <db.json>");
  process.exit(2);
}
for (const f of verifyOnly ? [] : [out, historyOut]) {
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
const { digest, digestMismatches, exportDb, publishAll, verifyAgainst, verifyOn } = await import("../services/api/src/store/pg/port.js");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** age, as scripts/_age.sh pins it, to its recipients, into `to`. Throws when either is missing. */
function ageEncrypt(plain: string, to: string) {
  const age = path.join(ROOT, ".toolchain/age-v1.3.2/age/age");
  const recipients = process.env.AGE_RECIPIENTS_FILE || path.join(ROOT, ".age-recipients");
  if (!existsSync(age)) throw new Error("age is not installed: run scripts/fetch-age.sh");
  if (!existsSync(recipients)) throw new Error(`no recipients at ${recipients}: run scripts/secrets.sh init`);
  // Created owner-only and refused if it exists, before age writes into it.
  closeSync(openSync(to, "wx", 0o600));
  const r = spawnSync(age, ["-R", recipients, "-o", to], { input: plain });
  if (r.status !== 0) throw new Error(`age failed (exit ${r.status})`);
}

function writeOwnerOnly(file: string, text: string) {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Files to `.tmp` first, then linked to their names: a link refuses a name
 *  that appeared meanwhile, and a failure leaves no file under either name. */
const made: string[] = [];
const tmpFor = (f: string) => {
  const t = `${f}.${process.pid}.tmp`;
  made.push(t);
  return t;
};

const database = openPool(url, { ca: process.env.DATABASE_CA, realMoney: true });
let code = 0;
try {
  if (verifyOnly) {
    const v = await verifyAgainst(database, JSON.parse(readFileSync(out, "utf8")));
    for (const [c, { rows, sha256 }] of Object.entries(v.target)) console.log(`  ${c.padEnd(28)} ${String(rows).padStart(8)}  ${sha256}`);
    if (v.mismatches.length) throw new Error(`VERIFY FAILED: ${v.mismatches.join(", ")} differ between ${out} and Postgres`);
    console.log(`verify: ${out}, as written, matches Postgres in every collection's count and hash`);
  } else await exportDb(database, async ({ db, ledgerHistory, postgresOnly }, q) => {
    if (postgresOnly.ledger_history > 0 && !historyOut) {
      throw new Error(`ledger_history has ${postgresOnly.ledger_history} row(s) and db.json has no place for them: pass --ledger-history <file>`);
    }
    const dbTmp = tmpFor(out);
    const histTmp = historyOut ? tmpFor(historyOut) : undefined;
    if (histTmp) ageEncrypt(ledgerHistory, histTmp);
    writeOwnerOnly(dbTmp, JSON.stringify(db));
    // Read back from disk, and checked against Postgres again while the
    // start lock still holds: what is in the file is what Postgres holds.
    const written = JSON.parse(readFileSync(dbTmp, "utf8"));
    const sent = digest(db);
    const v = await verifyOn(q, written);
    const bad = [...new Set([...digestMismatches(sent, digest(written)), ...v.mismatches])];
    for (const [c, { rows, sha256 }] of Object.entries(sent)) console.log(`  ${c.padEnd(28)} ${String(rows).padStart(8)}  ${sha256}`);
    console.log(`not exported: cap_holds ${postgresOnly.cap_holds}, pending_executions ${postgresOnly.pending_executions}; ledger_history ${postgresOnly.ledger_history}${historyOut ? ` → ${historyOut} (age)` : ""}`);
    const dead = db.outbox.filter((o) => o.deadAt).map((o) => o.id);
    const pending = db.outbox.filter((o) => !o.deadAt && !o.deliveredAt).length;
    console.log(`outbox: ${pending} undelivered (the JSON backend's worker delivers them), ${dead.length} dead${dead.length ? `: ${dead.join(", ")}` : ""}`);
    if (bad.length) throw new Error(`VERIFY FAILED: ${bad.join(", ")}; no file written`);
    publishAll(histTmp && historyOut ? [[dbTmp, out], [histTmp, historyOut]] : [[dbTmp, out]]);
    console.log(`wrote ${out}; verify: every collection's count and hash match Postgres`);
  });
} catch (err) {
  // A driver error's message or detail can quote a value: its code only.
  const e = err as { code?: string; severity?: string; message?: string };
  console.error(`FAILED: ${e.severity ? `SQLSTATE ${e.code}` : e.message}`);
  code = 1;
} finally {
  for (const t of made) rmSync(t, { force: true });
  await database.close();
}
// Not process.exit(): piped stdout is written asynchronously, and exit()
// would drop what is still queued.
process.exitCode = code;
