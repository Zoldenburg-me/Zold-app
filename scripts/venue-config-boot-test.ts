/**
 * A bad liquidity venue config must not take the API down. The startup
 * custody log runs in the listen callback, where a throw reaches the
 * uncaught-exception handler and the process exits: payment pages, invoicing
 * and bookkeeping would go with it. The API boots, warns, and serves; the
 * cash quote still refuses (covered in best-execution-test).
 *
 * Boots the real API against a fresh hardhat node with the local contracts
 * deployed, once per bad config. Offline: the operator's Monerium app
 * credentials are blanked in the child, so the boot never calls Monerium, and
 * the deploy's EUR/USD seed is pinned, so it never fetches a live rate.
 *
 * Run: npm run venue-boot:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { freePort, hardhatNode } from "./_free-port.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// deploy.ts reads the contract artifacts: compile (a no-op when they are
// current), so a standalone run works on a fresh checkout too.
const compile = spawnSync(process.execPath, [path.resolve("node_modules/.bin/hardhat"), "compile"], { stdio: "inherit" });
if (compile.status !== 0) throw new Error("hardhat compile failed: the deploy needs the contract artifacts");

let n = 0;
const { child: chain, url: rpcUrl } = await hardhatNode(process.cwd());
try {
  // The API reads the dollar token at boot: deploy, so the suite runs alone
  // on a fresh checkout and not only after a suite that deployed.
  const dep = spawnSync(process.execPath, [path.resolve("node_modules/.bin/tsx"), "scripts/deploy.ts"], {
    stdio: "inherit",
    // An empty DEPLOY_EURUSD_RATE is unset to deploy.ts, so it takes the seed
    // too; the rate feeds are closed, so a seedless deploy fails, never fetches.
    env: {
      ...process.env,
      TRANSF_RPC_URL: rpcUrl,
      DEPLOY_EURUSD_RATE: process.env.DEPLOY_EURUSD_RATE || "1137900",
      TRANSF_RATES_URL: "http://127.0.0.1:9/latest/EUR",
      TRANSF_ECB_RATES_URL: "http://127.0.0.1:9/v1",
    },
  });
  assert.equal(dep.status, 0, "deploy failed");
  for (const bad of [{ LIQUIDITY_PROVIDER: "nope" }, { LIQUIDITY_PROVIDER: "best", LIQUIDITY_VENUES: "nope" }, { LIQUIDITY_PROVIDER: "best", LIQUIDITY_VENUES: "" }]) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "venue-boot-"));
    const apiPort = await freePort();
    let out = "";
    let exited: number | null = null;
    const api = spawn(process.execPath, [path.resolve("node_modules/.bin/tsx"), "services/api/src/server.ts"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRANSF_API_PORT: String(apiPort),
        PORT: String(apiPort),
        TRANSF_CHAIN_ID: "31337",
        LOCAL_HARNESS: "1",
        TRANSF_DB_PATH: path.join(dataDir, "db.json"),
        TRANSF_RPC_URL: rpcUrl,
        // Set, not deleted: the API loads .env, which fills anything unset.
        // With app credentials it checks its Monerium connection at boot.
        MONERIUM_CLIENT_ID: "",
        MONERIUM_CLIENT_SECRET: "",
        MONERIUM_OAUTH_CLIENT_ID: "",
        MONERIUM_BASE_URL: "http://127.0.0.1:9",
        MONERIUM_AUTH_URL: "http://127.0.0.1:9",
        ...bad,
      },
    });
    api.stdout.on("data", (d) => (out += d));
    api.stderr.on("data", (d) => (out += d));
    api.on("exit", (code) => (exited = code ?? -1));
    try {
      for (const s = Date.now(); !out.includes("CUSTODY:"); ) {
        if (exited !== null) throw new Error(`API exited (${exited}) with ${JSON.stringify(bad)}:\n${out}`);
        if (Date.now() - s > 60_000) throw new Error(`API did not log its custody posture:\n${out}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      // Let a throw from the rest of the listen callback reach the handler.
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(exited, null, `API exited with ${JSON.stringify(bad)}:\n${out}`);
      assert.match(out, /venue configuration is invalid/);
      assert.match(out, /cash quote will fail/);
      assert.match(out, /monerium: no app credentials/);
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      assert.equal(res.status, 200, await res.text());
      console.log(`${++n}. ${JSON.stringify(bad)}: the API boots, warns, and /api/health answers`);
    } finally {
      api.kill("SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
} finally {
  chain.kill("SIGTERM");
}
console.log(`\nVENUE CONFIG BOOT TEST PASSED — ${n}/${n}: a bad venue config warns at startup and the API keeps serving`);
