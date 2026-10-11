/**
 * The server's gas key is its own: `RELAY_KEY` pays for recovery relays,
 * finalisations and verifier deployments, and the deployer key (the
 * contracts' deployer and admin) is never held by the server off the local
 * chain. Offline: every config case loads in a child process.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Obviously fake keys, built at run time so no key-shaped literal is in source.
const fake = (byte: string) => `0x${byte.repeat(32)}`;
const RELAY = fake("a1");
const ORCHESTRATOR = fake("b2");
const RAMP = fake("c3");
const DEPLOYER = fake("d4");
const HARDHAT_DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").address;
const HARDHAT_RELAY = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a").address;

// Every key name the config reads, blank, so a developer's .env (which the
// config loads for anything unset) cannot fill one in.
const BLANK = Object.fromEntries(
  ["RELAY_KEY", "DEPLOYER_KEY", "DEPLOY_DEPLOYER_KEY", "ORCHESTRATOR_KEY", "DEPLOY_ORCHESTRATOR_KEY", "RAMP_KEY", "DEPLOY_RAMP_KEY",
    "FAUCET_KEY", "ENS_GATEWAY_KEY", "ENS_PARENT_NAME", "ENS_RESOLVER_ADDRESS", "ALLOW_DEV_KEYS_ON_EXTERNAL_RPC", "TRANSF_PRODUCTION"]
    .map((k) => [k, ""]),
);
const SEPOLIA = { ...BLANK, TRANSF_RPC_URL: "https://sepolia.base.org", TRANSF_CHAIN_ID: "84532", ORCHESTRATOR_KEY: ORCHESTRATOR, RAMP_KEY: RAMP };
const LOCAL = { ...BLANK, TRANSF_RPC_URL: "http://127.0.0.1:8545", TRANSF_CHAIN_ID: "31337" };

const SHOW_KEYS =
  'const { KEYS } = await import("./services/api/src/config/keys.js");' +
  'const { privateKeyToAccount } = await import("viem/accounts");' +
  'const { UNREAD_DEPLOYER_KEYS: unread } = await import("./services/api/src/config/keys.js");' +
  "console.log(JSON.stringify({ relay: privateKeyToAccount(KEYS.relay).address, deployer: KEYS.deployer ? privateKeyToAccount(KEYS.deployer).address : null, unread }));";

function load(env: Record<string, string>, script = SHOW_KEYS) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env },
  });
  const out = r.stdout.trim().split("\n").at(-1) ?? "";
  return { ...r, keys: r.status === 0 && script === SHOW_KEYS ? JSON.parse(out) as { relay: string; deployer: string | null; unread: string[] } : null };
}

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const secretsIn = (text: string) => [RELAY, ORCHESTRATOR, RAMP, DEPLOYER].filter((k) => text.toLowerCase().includes(k.slice(2)));

console.log("relay key");
await check("off the local chain the server refuses to start without RELAY_KEY", () => {
  const r = load(SEPOLIA);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RELAY_KEY/);
});
await check("with RELAY_KEY set it signs relays with that key and holds no deployer key", () => {
  const r = load({ ...SEPOLIA, RELAY_KEY: RELAY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.keys!.relay, privateKeyToAccount(RELAY as `0x${string}`).address);
  assert.equal(r.keys!.deployer, null);
});
await check("a deployer key in the environment is not read off the local chain; the server names it at start", () => {
  for (const name of ["DEPLOYER_KEY", "DEPLOY_DEPLOYER_KEY"]) {
    const r = load({ ...SEPOLIA, RELAY_KEY: RELAY, [name]: DEPLOYER });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.keys!.deployer, null, name);
    assert.deepEqual(r.keys!.unread, [name]);
    // Loading the config prints nothing about it: the deploy scripts load it
    // too, and there the key belongs.
    assert.doesNotMatch(r.stderr, /DEPLOYER_KEY/, name);
    assert.deepEqual(secretsIn(r.stdout + r.stderr), [], name);
  }
  assert.deepEqual(load({ ...SEPOLIA, RELAY_KEY: RELAY }).keys!.unread, []);
});
await check("RELAY_KEY must be its own key: not the orchestrator, ramp, deployer, faucet or ENS gateway key", () => {
  const cases: Record<string, string>[] = [
    { RELAY_KEY: ORCHESTRATOR },
    { RELAY_KEY: RAMP },
    { RELAY_KEY: DEPLOYER, DEPLOYER_KEY: DEPLOYER },
    { RELAY_KEY: DEPLOYER, DEPLOY_DEPLOYER_KEY: DEPLOYER },
    { RELAY_KEY: DEPLOYER, FAUCET_KEY: DEPLOYER },
    { RELAY_KEY: DEPLOYER, ENS_GATEWAY_KEY: DEPLOYER },
  ];
  for (const extra of cases) {
    const r = load({ ...SEPOLIA, ...extra });
    assert.notEqual(r.status, 0, JSON.stringify(Object.keys(extra)));
    assert.match(r.stderr, /RELAY_KEY must not be the same key as/);
    assert.deepEqual(secretsIn(r.stdout + r.stderr), [], "no key is printed");
  }
});
await check("a malformed RELAY_KEY is refused without printing it", () => {
  const r = load({ ...SEPOLIA, RELAY_KEY: "0xnot-a-key-relay-test" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RELAY_KEY is not a 32-byte hex private key/);
  assert.ok(!r.stderr.includes("not-a-key-relay-test"));
});
await check("on the local chain relay and deployer are distinct hardhat accounts", () => {
  const r = load(LOCAL);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.keys!.relay, HARDHAT_RELAY);
  assert.equal(r.keys!.deployer, HARDHAT_DEPLOYER);
});

console.log("production");
await check("production refuses to start with a deployer key in the environment", () => {
  const boot = (extra: Record<string, string>) =>
    load({ ...SEPOLIA, RELAY_KEY: RELAY, TRANSF_PRODUCTION: "1", ...extra }, 'await import("./services/api/src/config.js")');
  for (const name of ["DEPLOYER_KEY", "DEPLOY_DEPLOYER_KEY"]) {
    const r = boot({ [name]: DEPLOYER });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${name} must not be on the server`), name);
    assert.deepEqual(secretsIn(r.stderr), [], "the value is never printed");
  }
  // Empty is unset: the other production checks still refuse this test env,
  // but not over the deployer key.
  assert.doesNotMatch(boot({}).stderr, /DEPLOYER_KEY must not/);
});

console.log("the relay wallet");
await check("recovery relays and the dashboard's gas panel use the relay key, not the deployer", async () => {
  const { KEYS } = await import("../services/api/src/config.js");
  const { relayWallet } = await import("../services/api/src/recovery/recovered-passkey.js");
  const { operatorWallets } = await import("../services/api/src/routes/admin.js");
  assert.equal(relayWallet().account.address, privateKeyToAccount(KEYS.relay).address);
  assert.notEqual(relayWallet().account.address, HARDHAT_DEPLOYER);
  const addresses = operatorWallets().map((w) => w.address);
  assert.ok(addresses.includes(relayWallet().account.address), "the relay is on the gas panel");
  assert.ok(!addresses.includes(HARDHAT_DEPLOYER), "the deployer is not");
});

console.log(`relay key: ${passed} passed`);
