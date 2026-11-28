/**
 * scripts/mainnet-preflight.ts against a stubbed world: what it passes, what
 * it fails, and what it prints.
 *
 * A chain, EntryPoint, bundler or paymaster that does not match fails the run;
 * an endpoint's key (in its URL path) never reaches the output, even when an
 * error message carries the URL.
 *
 * Offline: the script runs as a child under scripts/fixtures/preflight-stub.mjs,
 * whose fetch answers for the stub endpoints and refuses every other URL, and
 * whose process.loadEnvFile loads nothing, so no .env is read. Every
 * endpoint is a *.invalid host. What this cannot show is how Candide's live
 * endpoints answer; that is `npm run preflight`, which is not run here.
 *
 *   npm run preflight:stub:test
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PRELOAD = pathToFileURL(path.join(HERE, "fixtures", "preflight-stub.mjs")).href;
const TMP = mkdtempSync(path.join(os.tmpdir(), "zold-preflight-stub-"));
const KEYS = { rpc: "fake-rpc-key-0a1b2c3d", bundler: "fake-bundler-key-4e5f6a7b", paymaster: "fake-pm-key-8c9d0e1f", recovery: "fake-recovery-key-2a3b4c" };
const RECOVERY_MODULE = "0x38275826E1933303E508433dD5f289315Da2541c";
const URLS = {
  rpcUrl: `https://rpc.stub.invalid/v2/${KEYS.rpc}`,
  bundlerUrl: `https://bundler.stub.invalid/api/v3/84532/${KEYS.bundler}`,
  paymasterUrl: `https://paymaster.stub.invalid/api/v3/84532/${KEYS.paymaster}`,
  recoveryUrl: `https://recovery.stub.invalid/${KEYS.recovery}`,
};

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

interface Stub {
  rpcChain?: number; bundlerChain?: number; paymasterChain?: number; entryPointCode?: boolean;
  bundlerEntryPoints?: string[]; paymasterEntryPoints?: string[]; sponsor?: boolean;
  recoveryServiceModule?: string; faults?: Record<string, string>; throwWithUrl?: keyof typeof KEYS; throwPrefix?: string;
}
function preflight(stub: Stub = {}, env: Record<string, string> = {}) {
  const log = path.join(TMP, `calls-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, path.join(HERE, "mainnet-preflight.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    // Built from nothing, not from process.env: only what is named here reaches the run.
    env: {
      PATH: process.env.PATH,
      HOME: TMP,
      TRANSF_DB_PATH: path.join(TMP, "db.json"),
      // The app on the local chain, as candide-matrix-test: config then accepts
      // the hardhat keys. Its RPC is never called (the stub refuses it).
      TRANSF_CHAIN_ID: "31337",
      TRANSF_RPC_URL: "http://127.0.0.1:9",
      LOCAL_HARNESS: "",
      CANDIDE_CHAIN_ID: "84532",
      CANDIDE_RPC_URL: URLS.rpcUrl,
      CANDIDE_BUNDLER_URL: URLS.bundlerUrl,
      CANDIDE_PAYMASTER_URL: URLS.paymasterUrl,
      CANDIDE_RECOVERY_MODULE_ADDRESS: RECOVERY_MODULE,
      RECOVERY_SERVICE_URL: URLS.recoveryUrl,
      SAFE_GAS_PAYMENT: "sponsored",
      PARTNER_HTTP_TIMEOUT_MS: "2000",
      PREFLIGHT_STUB: JSON.stringify({ rpcChain: 84532, bundlerChain: 84532, paymasterChain: 84532, recoveryModule: RECOVERY_MODULE, ...URLS, ...stub }),
      PREFLIGHT_STUB_LOG: log,
      ...env,
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  for (const [who, key] of Object.entries(KEYS)) assert.ok(!out.includes(key), `the ${who} key was printed:\n${out}`);
  let record: { calls: { who: string; method?: string }[]; envFileReads: string[] } = { calls: [], envFileReads: [] };
  try { record = JSON.parse(readFileSync(log, "utf8")); } catch {}
  return { status: r.status, out, ...record };
}
const lines = (out: string, kind: "PASS" | "FAIL" | "WARN") => out.split("\n").filter((l) => l.trim().startsWith(kind)).join("\n");

console.log("mainnet-preflight against stub endpoints");
await check("everything matching passes, every call went to a stub, and no .env was loaded", () => {
  const r = preflight();
  assert.equal(r.status, 0, r.out);
  assert.equal(lines(r.out, "FAIL"), "");
  assert.match(r.out, /PASS\s+RPC is chain 84532/);
  assert.match(r.out, /PASS\s+EntryPoint v0\.9 .* has code/);
  assert.match(r.out, /PASS\s+supports EntryPoint v0\.9/);
  assert.match(r.out, /PASS\s+the paymaster sponsored a deployment op/);
  assert.match(r.out, /PASS\s+recovery service answers and uses our module/);
  assert.ok(r.envFileReads.length >= 1, "the run never tried to load .env, so the stub did not cover that path");
  assert.ok(r.calls.some((c) => c.who === "paymaster" && c.method === "pm_getPaymasterStubData"), "the paymaster was never asked");
});
await check("a real-money deployment env runs the API's boot checks with its own env", () => {
  // Base mainnet app chain, Candide still on the Sepolia stubs, a harness flag
  // the probes drop, no document key, a local checkout origin.
  const r = preflight({}, { TRANSF_CHAIN_ID: "8453", LOCAL_HARNESS: "1", DOCUMENT_SIGNING_KEY: "", CHECKOUT_SERVICE_ORIGIN: "http://localhost:4000",
    MONERIUM_BASE_URL: "https://user:pw-secret@api.monerium.dev/path?key=q-secret" });
  assert.equal(r.status, 1, r.out);
  const failed = lines(r.out, "FAIL");
  assert.match(failed, /production would refuse to start: DOCUMENT_SIGNING_KEY is required in production/);
  assert.match(failed, /production would refuse to start: LOCAL_HARNESS=1 is forbidden in production/);
  assert.match(failed, /production would refuse to start: .*CANDIDE/);
  assert.match(failed, /MONERIUM_BASE_URL must be .* \(got https:\/\/api\.monerium\.dev\)/);
  assert.ok(!r.out.includes("pw-secret") && !r.out.includes("q-secret"), "a credential in a URL is never printed");
  assert.match(preflight().out, /PASS\s+not a real-money deployment env/);
});
await check("an RPC on another chain fails", () => {
  const r = preflight({ rpcChain: 8453 });
  assert.equal(r.status, 1);
  assert.match(lines(r.out, "FAIL"), /RPC is chain 8453, but CANDIDE_CHAIN_ID is 84532/);
});
await check("a bundler on another chain fails", () => {
  const r = preflight({ bundlerChain: 8453 });
  assert.equal(r.status, 1);
  assert.match(lines(r.out, "FAIL"), /answers for chain 8453, not 84532/);
});
await check("no EntryPoint code on the chain, or a bundler that does not list v0.9, fails", () => {
  const a = preflight({ entryPointCode: false });
  assert.equal(a.status, 1);
  assert.match(lines(a.out, "FAIL"), /EntryPoint v0\.9 .* has no code/);
  const b = preflight({ bundlerEntryPoints: ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"] });
  assert.equal(b.status, 1);
  assert.match(lines(b.out, "FAIL"), /does not list EntryPoint v0\.9/);
});
await check("a paymaster on another chain fails, though it would sponsor", () => {
  const r = preflight({ paymasterChain: 8453 });
  assert.equal(r.status, 1, r.out);
  assert.match(lines(r.out, "FAIL"), /paymaster answers for chain 8453, not 84532/);
});
await check("a paymaster that does not serve EntryPoint v0.9 fails", () => {
  const r = preflight({ paymasterEntryPoints: ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"] });
  assert.equal(r.status, 1, r.out);
  assert.match(lines(r.out, "FAIL"), /paymaster does not list EntryPoint v0\.9/);
});
await check("a paymaster that will not sponsor fails, with the fix named", () => {
  const r = preflight({ sponsor: false });
  assert.equal(r.status, 1);
  assert.match(lines(r.out, "FAIL"), /the paymaster would not sponsor/);
  assert.match(r.out, /SAFE_GAS_PAYMENT=native/);
});
await check("native gas never asks the paymaster", () => {
  const r = preflight({ paymasterChain: 1 }, { SAFE_GAS_PAYMENT: "native" });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.calls.some((c) => c.who === "paymaster"), "native gas called the paymaster");
});
await check("a recovery service on another module fails", () => {
  const r = preflight({ recoveryServiceModule: "0x949d01d424bE050D09C16025dd007CB59b3A8c66" });
  assert.equal(r.status, 1);
  assert.match(lines(r.out, "FAIL"), /recovery service uses module 0x949d/);
});
await check("an error that carries an endpoint's URL prints scheme and host only", () => {
  for (const who of ["rpc", "bundler", "paymaster", "recovery"] as const) {
    const r = preflight({ throwWithUrl: who });
    assert.equal(r.status, 1, `${who}: ${r.out}`);
    assert.match(r.out, new RegExp(`https://${who === "rpc" ? "rpc" : who}\\.stub\\.invalid`), who);
  }
  const echo = preflight({ faults: { "rpc.eth_chainId": "echo-url", "bundler.eth_chainId": "echo-url", "paymaster.pm_chainId": "echo-url" } });
  assert.equal(echo.status, 1);
  assert.equal(lines(echo.out, "FAIL").split("\n").length >= 3, true, echo.out);
});
await check("an error cut short inside an endpoint's key prints no part of the key", () => {
  // Whatever follows the host is the path holding the key; redacted, a URL ends at the host.
  const leak = /stub\.invalid\/(v2|api|fake)/;
  const body = preflight({ faults: { "rpc.eth_chainId": "echo-url-at-cut" } });
  assert.equal(body.status, 1);
  assert.match(lines(body.out, "FAIL"), /RPC unreachable/);
  assert.doesNotMatch(body.out, leak, body.out);
  // errMsg cuts at 300: a prefix puts that cut 6 characters before the rpc URL ends.
  const thrown = preflight({ throwWithUrl: "rpc", throwPrefix: "x".repeat(300 - "Failed to parse URL from ".length - URLS.rpcUrl.length + 6) });
  assert.equal(thrown.status, 1);
  assert.doesNotMatch(thrown.out, leak, thrown.out);
});

rmSync(TMP, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nmainnet-preflight stub: all checks passed");
