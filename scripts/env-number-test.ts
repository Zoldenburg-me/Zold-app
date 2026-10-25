import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envNumber } from "../services/api/src/config/env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "ENV_NUMBER_TEST_VALUE";
const read = (raw: string | undefined, opts?: Parameters<typeof envNumber>[2]) => {
  if (raw === undefined) delete process.env[NAME];
  else process.env[NAME] = raw;
  return envNumber(NAME, 15_000, opts);
};

assert.equal(read(undefined), 15_000, "missing uses the default");
assert.equal(read(""), 15_000, "empty uses the default");
assert.equal(read("250", { min: 250 }), 250, "the minimum itself is allowed");
assert.equal(read("0.005", { min: 0, max: 1 }), 0.005);
assert.throws(() => read("abc"), { message: `${NAME} must be a number` });
assert.throws(() => read("   "), { message: `${NAME} must be a number` }, "blank is not 0");
assert.throws(() => read("1", { min: 250 }), { message: `${NAME} must be at least 250, got 1` });
assert.throws(() => read("2", { max: 1 }), { message: `${NAME} must be at most 1, got 2` });
assert.throws(() => read("1.5", { integer: true }), { message: `${NAME} must be a whole number, got 1.5` });
// A non-number is never echoed: it may be a secret pasted into the wrong variable.
assert.throws(() => read("sk_live_secret"), (e: Error) => !e.message.includes("sk_live_secret"));
assert.throws(() => read("0xdeadbeefdeadbeefdeadbeef", { max: 1 }), { message: `${NAME} must be at most 1` }, "hex parses, never echoed");
delete process.env[NAME];

// A config module refuses to load with a bad value, naming the variable.
const tsx = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const boot = spawnSync(process.execPath, [tsx, "services/api/src/config/security.ts"], {
  cwd: ROOT,
  env: { ...process.env, SESSION_TTL_MS: "1d" },
  encoding: "utf8",
});
assert.notEqual(boot.status, 0, "config/security.ts loaded with SESSION_TTL_MS=1d");
assert.match(boot.stderr, /SESSION_TTL_MS must be a number/);

console.log("ENV NUMBER TEST PASSED");
