/**
 * Faults for an operator job run as a child against a throwaway store, loaded
 * with `node --import`. ZOLD_STORE_FAULT names one; the store is
 * TRANSF_DB_PATH. Test-only: nothing in services/ or the job imports this.
 *
 *   mutate-after-read     another writer changes the store right after the job's first read of it
 *   mutate-on-decrypt     ... at the job's first decrypt (between its read and its write)
 *   seal-fails-at:N       the Nth encryption throws (a row that does not re-encrypt)
 *   rename-enospc         the store's rename into place fails: a full disk
 *   kill-in-write         the process dies half-way through writing the store's .tmp
 *
 * Every write to the store gets the same whole-second mtime, as on a file
 * system with coarse timestamps, so a change keeps both size and mtime: the
 * mutation swaps two same-length markers the test planted in the store.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const fault = process.env.ZOLD_STORE_FAULT ?? "";
const DB = path.resolve(process.env.TRANSF_DB_PATH ?? "");
const MTIME = 1_700_000_000;
const orig = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  createCipheriv: crypto.createCipheriv,
  createDecipheriv: crypto.createDecipheriv,
};
const pin = () => fs.utimesSync(DB, MTIME, MTIME);
let mutated = false;
function mutate() {
  if (mutated) return;
  mutated = true;
  const text = orig.readFileSync.call(fs, DB, "utf8");
  if (!text.includes("canary-A")) throw new Error("store-faults: no canary-A marker in the store");
  orig.writeFileSync.call(fs, DB, text.replace("canary-A", "canary-B"));
  pin();
}

fs.renameSync = function (from, to, ...rest) {
  if (path.resolve(String(to)) === DB && fault === "rename-enospc") {
    throw Object.assign(new Error("ENOSPC: no space left on device, rename"), { code: "ENOSPC" });
  }
  const out = orig.renameSync.call(fs, from, to, ...rest);
  if (path.resolve(String(to)) === DB) pin();
  return out;
};
fs.readFileSync = function (file, ...rest) {
  const out = orig.readFileSync.call(fs, file, ...rest);
  if (fault === "mutate-after-read" && typeof file === "string" && path.resolve(file) === DB) mutate();
  return out;
};
if (fault === "kill-in-write") {
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof file === "number" && typeof data === "string") {
      orig.writeFileSync.call(fs, file, data.slice(0, Math.floor(data.length / 2)));
      process.kill(process.pid, "SIGKILL");
    }
    return orig.writeFileSync.call(fs, file, data, ...rest);
  };
}
crypto.createDecipheriv = function (...args) {
  if (fault === "mutate-on-decrypt") mutate();
  return orig.createDecipheriv.apply(crypto, args);
};
const sealAt = /^seal-fails-at:(\d+)$/.exec(fault);
let seals = 0;
crypto.createCipheriv = function (...args) {
  if (sealAt && ++seals === Number(sealAt[1])) throw new Error("injected: this row did not re-encrypt");
  return orig.createCipheriv.apply(crypto, args);
};
syncBuiltinESMExports();
