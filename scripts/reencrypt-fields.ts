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
 * DATA_ENCRYPTION_KEYS is sealed under it and opened again to check; the rows
 * that passed are written in one store write. A row that does not open is left
 * as it was; one that fails to re-encrypt stops the job, and the rows before it
 * are written and counted ("moved 2 of 7").
 *
 * Both modes read the store without migrating it, and refuse when there is no
 * store at TRANSF_DB_PATH. Only --apply writes, once, at the end.
 *
 * Stop the API first. The store is one JSON file and the API rewrites all of
 * it from memory, so a write from a running API after this job would put the
 * old ciphertext back (still readable, but not moved), and a write in between
 * would be lost. The job refuses to write if the file's content changed since
 * it read it; a write landing between that last check and the rename is not
 * seen (there is no lock shared with the API).
 *
 * If the store write itself fails, the file holds either every row of the
 * batch or none of them (it is replaced by rename): the dry run says which.
 *
 * Prints counts, row ids and key ids only, never a value or a key. A key may
 * leave DATA_ENCRYPTION_KEYS once the report says no row uses it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fieldKeyId } from "../services/api/src/crypto-at-rest.js";
import { dataKeyring } from "../services/api/src/config/data-keys.js";
import { STORED_SECRETS } from "../services/api/src/stored-secrets.js";
import { DB_PATH, loadStoreReadOnly } from "../services/api/src/store/db.js";
import { store } from "../services/api/src/store.js";

const apply = process.argv.includes("--apply");

async function main(): Promise<number> {
  const keyring = dataKeyring();
  if (apply && !keyring) {
    console.error("--apply needs DATA_ENCRYPTION_KEYS: there is no key to move rows to");
    return 1;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`no store at ${DB_PATH}: set TRANSF_DB_PATH to the store to check`);
    return 1;
  }
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const seen = digest(loadStoreReadOnly());
  console.log(`${apply ? "Applying" : "Dry run"}: ${DB_PATH}${keyring ? `, active key ${keyring.activeId}` : ", no DATA_ENCRYPTION_KEYS"}`);

  const ringIds = keyring ? [...keyring.roots.keys()] : [];
  const used = new Map<string, number>();
  const moves: { entry: (typeof STORED_SECRETS)[number]; rowId: string; plaintext: string }[] = [];
  const failures: string[] = [];

  for (const entry of STORED_SECRETS) {
    const { site } = entry;
    const counts = new Map<string, number>([["v1", 0], ...ringIds.map((id) => [id, 0] as [string, number])]);
    for (const { rowId, stored } of await entry.rows()) {
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
    // Seal and read back every row before the check, so the check sits right
    // before the one write. A row that fails stops here; those before it go.
    const sealed: { entry: (typeof moves)[number]["entry"]; rowId: string; stored: string }[] = [];
    let stopped = "";
    for (const { entry, rowId, plaintext } of moves) {
      try {
        const stored = entry.site.seal(rowId, plaintext);
        if (entry.site.open(rowId, stored) !== plaintext) throw new Error("re-encrypted value does not read back");
        sealed.push({ entry, rowId, stored });
      } catch (err) {
        stopped = `${entry.site.table}.${entry.site.field} ${rowId}: ${(err as Error).message}`;
        break;
      }
    }
    // The content, not mtime and size: two writes in one second of the same
    // length (a coarse-timestamp file system) keep both.
    let now: string | undefined;
    try { now = readFileSync(DB_PATH, "utf8"); } catch {}
    if (now === undefined || digest(now) !== seen) {
      console.error("the store changed while the job ran (is the API running?): nothing written");
      return 1;
    }
    if (sealed.length) {
      // persist() exits the process when the write fails; say what that leaves.
      const onExit = (code: number) => {
        if (code) console.error(`the store write did not complete: the file holds all ${sealed.length} re-encrypted row(s) or none of them; run the dry run (npm run reencrypt) to see which`);
      };
      process.on("exit", onExit);
      // One transaction: the JSON backend writes the file once, at its end.
      await store.tx(async () => {
        for (const { entry, rowId, stored } of sealed) await entry.write(rowId, stored);
      });
      process.off("exit", onExit);
    }
    if (stopped) {
      console.error(`moved ${sealed.length} of ${moves.length} row(s), then stopped: ${stopped}`);
      return 1;
    }
    console.log(`moved ${sealed.length} row(s)`);
  }

  for (const f of failures) console.error(`  FAILED ${f}`);
  return failures.length ? 1 : 0;
}

process.exitCode = await main();
