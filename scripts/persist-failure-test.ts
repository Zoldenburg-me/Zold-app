/**
 * A store write the disk refuses ends the process, and db.json keeps the last
 * good state, so a restart never serves a change the caller saw fail.
 *
 * Offline: a child process on a throwaway db, its rename stubbed to fail.
 *
 *   npm run persist-failure:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "zold-persist-fail-"));
const dbPath = path.join(dir, "db.json");
const MARKER = "persist-failure-marker";

// The child loads a good store, changes memory, then the rename fails: the
// worst case, a complete .tmp holding the change sits next to db.json.
const child = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const m = await import("./services/api/src/store/db.ts");
  m.initStore();
  m.db.quotes.push({ id: "${MARKER}" });
  fs.renameSync = () => { throw Object.assign(new Error("${MARKER} in the message"), { code: "EIO" }); };
  syncBuiltinESMExports();
  m.persist();
  console.log("still serving");
`;

try {
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, TRANSF_DB_PATH: dbPath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 1, `exit ${run.status}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /still serving/);
  assert.match(run.stderr, /FATAL store write failed \(EIO\)/);
  assert.doesNotMatch(run.stderr, new RegExp(MARKER), "the log carries the error code, not its message");
  const onDisk = JSON.parse(readFileSync(dbPath, "utf8"));
  assert.ok(Array.isArray(onDisk.quotes), "db.json is the last good store");
  assert.ok(!onDisk.quotes.some((q: { id: string }) => q.id === MARKER), "the refused change is not on disk");
  assert.ok(!existsSync(dbPath + ".tmp"), "no second copy of the store is left behind");
  console.log("  ok  a failed store write exits 1 and leaves the last good db.json");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
