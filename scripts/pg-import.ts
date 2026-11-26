/**
 * db.json → Postgres (docs/postgres-store-design.md §6).
 *
 *   npx tsx scripts/pg-import.ts report <db.json>
 *       Read-only, no database: what would break the import (duplicate keys,
 *       deposits without their key, amounts that are not numbers, rows the
 *       typed columns refuse) and the orphans. Exit 1 when anything blocks.
 *   DATABASE_URL=… npx tsx scripts/pg-import.ts import <db.json>
 *       The report, then every row in one transaction, read back and hashed
 *       before the COMMIT. Refuses a blocking finding, a schema that is not
 *       current, a running API (its start lock) and a target that holds
 *       anything but this snapshot; a second run on the same file changes
 *       nothing and says so. Any failure rolls back: the target stays empty.
 *   DATABASE_URL=… npx tsx scripts/pg-import.ts verify <db.json>
 *       Counts and hashes, the snapshot against Postgres. Exit 1 on a mismatch.
 *
 * The source is the snapshot initStore would serve (load-time migrations run
 * in memory, nothing written back); the file itself is never changed. Run the
 * migrations first, as the owner role. Prints collection names, counts,
 * hashes and row ids, never a row.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [mode, file] = process.argv.slice(2);
if (!["report", "import", "verify"].includes(mode ?? "") || !file) {
  console.error("usage: pg-import.ts report|import|verify <db.json>");
  process.exit(2);
}
// The report touches no chain and no database; pinned (and never contacted)
// so that config does not ask for a deployment's keys on a machine that has
// none.
if (mode === "report") {
  process.env.TRANSF_CHAIN_ID ??= "31337";
  process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:8545";
}

const { loadMigratedSnapshot } = await import("../services/api/src/store/db.js");
const { digest, formatReport, ImportRefused, importSnapshot, preImportReport, verifyAgainst } = await import("../services/api/src/store/pg/port.js");

const raw = readFileSync(file);
console.log(`source ${file}: sha256 ${createHash("sha256").update(raw).digest("hex")} (the file as read; not compared)`);
const { db: snapshot, migratedUsers } = (() => {
  try {
    return loadMigratedSnapshot(file);
  } catch (err) {
    // JSON.parse quotes the text around a syntax error: the name only.
    console.error(`the source does not load: ${err instanceof SyntaxError ? "not valid JSON" : (err as Error).message}`);
    process.exit(1);
  }
})();
const printDigest = (label: string, d: Record<string, { rows: number; sha256: string }>) => {
  console.log(label);
  for (const [c, { rows, sha256 }] of Object.entries(d)) console.log(`  ${c.padEnd(28)} ${String(rows).padStart(8)}  ${sha256}`);
};

// The migration that gives a user without one a personal organisation mints
// random ids, so each load of such a file is another snapshot: a verify or a
// second import would never match the first.
const unstable = migratedUsers
  ? `${migratedUsers} user(s) have no organisation yet; the load-time migration gives them one under random ids, so this file is not a stable source. Load it through the JSON store once (start the API on it, stopped again before the import), then import that file`
  : undefined;

if (mode === "report") {
  if (unstable) console.log(`note: ${unstable}`);
  const findings = preImportReport(snapshot);
  printDigest("snapshot (after the load-time migrations):", digest(snapshot));
  for (const line of formatReport(findings)) console.log(line);
  process.exit(findings.some((f) => f.blocks) ? 1 : 0);
}

if (unstable) {
  console.error(`REFUSED: ${unstable}`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const { openPool } = await import("../services/api/src/store/pg/sql.js");
// realMoney: a host other than this machine needs verify-full TLS and a CA,
// whatever chain the data is from.
const database = openPool(url, { ca: process.env.DATABASE_CA, realMoney: true });
let code = 0;
try {
  if (mode === "import") {
    const r = await importSnapshot(database, snapshot);
    printDigest(r.imported ? "imported, read back and verified before the commit:" : "the target already holds this snapshot; nothing changed:", r.digest);
  }
  const v = await verifyAgainst(database, snapshot);
  printDigest("Postgres:", v.target);
  console.log(`Postgres only (no place in db.json): ${Object.entries(v.postgresOnly).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (v.mismatches.length) {
    console.error(`VERIFY FAILED: ${v.mismatches.join(", ")} differ between the snapshot and Postgres`);
    code = 1;
  } else console.log("verify: every collection's count and hash match");
} catch (err) {
  if (err instanceof ImportRefused) {
    console.error(`REFUSED: ${err.message}`);
    for (const line of formatReport(err.findings)) console.error(line);
  } else {
    // A driver error's message or detail can quote a value: its code only.
    const e = err as { code?: string; severity?: string; message?: string };
    console.error(`FAILED: ${e.severity ? `SQLSTATE ${e.code}` : e.message}`);
  }
  code = 1;
} finally {
  await database.close();
}
process.exit(code);
