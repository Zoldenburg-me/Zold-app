/**
 * A bad liquidity venue config must not take the API down. The startup
 * custody log runs in the listen callback, where a throw reaches the
 * uncaught-exception handler and the process exits: payment pages, invoicing
 * and bookkeeping would go with it. The API boots, warns, and serves; the
 * cash quote still refuses (covered in best-execution-test).
 *
 * Boots the real API against a bare hardhat node, once per bad config.
 *
 * Run: npm run venue-boot:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { freePort, hardhatNode } from "./_free-port.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let n = 0;
const { child: chain, url: rpcUrl } = await hardhatNode(process.cwd());
try {
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
