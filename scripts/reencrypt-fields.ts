/**
 * Report stored credentials by encryption version and key, and move them to
 * the active v2 key.
 *
 *   npm run reencrypt              # dry run: report only, writes nothing
 *   npm run reencrypt -- --apply   # re-encrypt every v1 row and every row under an old key
 *
 * Covers the sites in services/api/src/stored-secrets.ts. Every value is
 * opened under its own row binding, whatever its key, so a value copied from
 * another row or tampered with is reported; any such row makes the run exit
 * non-zero. With --apply, each value not under the first key of
 * DATA_ENCRYPTION_KEYS is sealed under it, opened again to check, then
 * written; a row that does not open is left as it was.
 *
 * The dry run reads the store without migrating or writing it, and refuses
 * when there is no store at TRANSF_DB_PATH.
 *
 * Stop the API first. The store is one JSON file and the API rewrites all of
 * it from memory, so a write from a running API after this job would put the
 * old ciphertext back (still readable, but not moved), and a write in between
 * would be lost. The job refuses to write if the file changed while it ran.
 *
 * Prints counts, row ids and key ids only, never a value or a key. A key may
 * leave DATA_ENCRYPTION_KEYS once the report says no row uses it.
 */
import { existsSync, statSync } from "node:fs";
import { fieldKeyId } from "../services/api/src/crypto-at-rest.js";
import { dataKeyring } from "../services/api/src/config/data-keys.js";
import { STORED_SECRETS } from "../services/api/src/stored-secrets.js";
import { batched, DB_PATH, initStore, loadStoreReadOnly } from "../services/api/src/store/db.js";

const apply = process.argv.includes("--apply");

function main(): number {
  const keyring = dataKeyring();
  if (apply && !keyring) {
    console.error("--apply needs DATA_ENCRYPTION_KEYS: there is no key to move rows to");
    return 1;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`no store at ${DB_PATH}: set TRANSF_DB_PATH to the store to check`);
    return 1;
  }
  if (apply) initStore();
  else loadStoreReadOnly();
  const seenAt = statSync(DB_PATH, { throwIfNoEntry: false });
  console.log(`${apply ? "Applying" : "Dry run"}: ${DB_PATH}${keyring ? `, active key ${keyring.activeId}` : ", no DATA_ENCRYPTION_KEYS"}`);

  const ringIds = keyring ? [...keyring.roots.keys()] : [];
  const used = new Map<string, number>();
  const moves: { entry: (typeof STORED_SECRETS)[number]; rowId: string; plaintext: string }[] = [];
  const failures: string[] = [];

  for (const entry of STORED_SECRETS) {
    const { site } = entry;
    const counts = new Map<string, number>([["v1", 0], ...ringIds.map((id) => [id, 0] as [string, number])]);
    for (const { rowId, stored } of entry.rows()) {
      let keyId: string;
      try { keyId = fieldKeyId(stored); } catch { failures.push(`${site.table}.${site.field} ${rowId}: not ciphertext`); continue; }
      counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
      used.set(keyId, (used.get(keyId) ?? 0) + 1);
      let plaintext: string;
      try {
        plaintext = site.open(rowId, stored);
      } catch (err) {
        failures.push(`${site.table}.${site.field} ${rowId}: does not decrypt (${(err as Error).message})`);
        continue;
      }
      if (keyring && keyId !== keyring.activeId) moves.push({ entry, rowId, plaintext });
    }
    const keyCols = [...counts.keys()].filter((k) => k !== "v1").sort();
    console.log(`  ${site.table}.${site.field}  ${["v1", ...keyCols].map((k) => `${k}=${counts.get(k)}`).join("  ")}`);
  }

  console.log(`${moves.length} to move${keyring ? ` to ${keyring.activeId}` : ""}`);
  for (const id of ringIds.filter((id) => id !== keyring!.activeId)) {
    const n = used.get(id) ?? 0;
    console.log(n ? `  ${id}: ${n} row(s) still use it` : `  ${id}: no row uses it; it can be removed from DATA_ENCRYPTION_KEYS`);
  }

  const v1Rows = used.get("v1") ?? 0;
  console.log(v1Rows
    ? `  v1: ${v1Rows} row(s) still need MONERIUM_TOKEN_ENCRYPTION_KEY to read`
    : "  v1: no v1 row in these sites; while the v1 secret stays set, a v1 value copied into a row still opens there");

  if (apply && moves.length) {
    const now = statSync(DB_PATH, { throwIfNoEntry: false });
    if (!seenAt || !now || now.mtimeMs !== seenAt.mtimeMs || now.size !== seenAt.size) {
      console.error("the store changed while the job ran (is the API running?): nothing written");
      return 1;
    }
    // batched() writes what changed even when it throws, so a failure part-way
    // keeps the rows moved before it; each of those reads back on its own.
    let moved = 0;
    try {
      batched(() => {
        for (const { entry, rowId, plaintext } of moves) {
          const sealed = entry.site.seal(rowId, plaintext);
          if (entry.site.open(rowId, sealed) !== plaintext) throw new Error(`${entry.site.table}.${entry.site.field} ${rowId}: re-encrypted value does not read back`);
          entry.write(rowId, sealed);
          moved++;
        }
      });
    } catch (err) {
      console.error(`moved ${moved} of ${moves.length} row(s), then stopped: ${(err as Error).message}`);
      return 1;
    }
    console.log(`moved ${moved} row(s)`);
  }

  for (const f of failures) console.error(`  FAILED ${f}`);
  return failures.length ? 1 : 0;
}

process.exitCode = main();
