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
for (const raw of ["0x10", "0b1", "1e3", "Infinity", ".5", "+5", "1_000"]) {
  assert.throws(() => read(raw), { message: `${NAME} must be a number` }, `${raw} is not a plain decimal`);
}
assert.equal(read(" -2.5 "), -2.5);
assert.throws(() => read("1", { min: 250 }), { message: `${NAME} must be at least 250, got 1` });
assert.throws(() => read("2", { max: 1 }), { message: `${NAME} must be at most 1, got 2` });
assert.throws(() => read("1.5", { integer: true }), { message: `${NAME} must be a whole number, got 1.5` });
// A non-number is never echoed: it may be a secret pasted into the wrong variable.
assert.throws(() => read("sk_live_secret"), (e: Error) => !e.message.includes("sk_live_secret"));
assert.throws(() => read("1234567890123456789012345", { max: 1 }), { message: `${NAME} must be at most 1` }, "a long number, never echoed");
delete process.env[NAME];

// Config modules load (or refuse) in a fresh process, since they read the env once at import.
const tsx = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const load = (module: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [tsx, "-e", `import(${JSON.stringify(path.join(ROOT, module))}).then((m) => console.log(m.API_PORT ?? "loaded"))`], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

const badTtl = load("services/api/src/config/security.ts", { SESSION_TTL_MS: "1d" });
assert.notEqual(badTtl.status, 0, "config/security.ts loaded with SESSION_TTL_MS=1d");
assert.match(badTtl.stderr, /SESSION_TTL_MS must be a number/);

// An explicit TRANSF_API_PORT wins; a junk PORT nobody reads must not stop boot.
const port = load("services/api/src/config/env.ts", { TRANSF_API_PORT: "4123", PORT: "abc" });
assert.equal(port.status, 0, port.stderr);
assert.equal(port.stdout.trim(), "4123");
const portOnly = load("services/api/src/config/env.ts", { TRANSF_API_PORT: "", PORT: "5123" });
assert.equal(portOnly.stdout.trim(), "5123", portOnly.stderr);
const badPort = load("services/api/src/config/env.ts", { TRANSF_API_PORT: "", PORT: "abc" });
assert.notEqual(badPort.status, 0, "a junk PORT with nothing else set must stop boot");

const badTier = load("services/api/src/config/liquidity.ts", { DEX_FEE_TIERS: "500,x" });
assert.notEqual(badTier.status, 0, "a bad fee tier was dropped silently");
assert.match(badTier.stderr, /DEX_FEE_TIERS must be whole numbers/);
assert.notEqual(load("services/api/src/config/liquidity.ts", { DEX_FEE_TIERS: "500,1000000" }).status, 0, "a tier past uint24 fees");

console.log("ENV NUMBER TEST PASSED");
