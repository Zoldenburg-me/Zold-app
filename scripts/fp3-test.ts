/**
 * FP3 local API guard.
 *
 * After RemitVault removal, a hardhat-only user has a counterfactual Safe but
 * no Candide bundler/paymaster to deploy or execute it. The API must fail
 * before pretending a local remittance moved funds. The detailed Safe refund
 * compensation path is pinned by `safe-funded-recovery-test.ts`, which seeds
 * the post-Safe-spend state directly.
 * Runs its own chain/API on shifted ports. Run: npm run fp3:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice, sendTransfer } from "./device.js";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8547";
const API = "http://127.0.0.1:3010";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
let token = "";

const ENV = {
  ...process.env,
  MONERIUM_CLIENT_ID: "",
  MONERIUM_CLIENT_SECRET: "",
  MG_ANCHOR_DOMAIN: "",
  TRANSF_RPC_URL: RPC,
  TRANSF_API_PORT: "3010",
  FORCE_FAIL_STEP: "bridge.lockForPayout",
};

const children: ChildProcess[] = [];
const bg = (cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: ENV });
  children.push(c);
  return c;
};

async function waitRpc(timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

async function api(p: string, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + p, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${data.error ?? res.statusText}`);
  return data;
}

try {
  console.log("1/5 chain + deploy + API (FORCE_FAIL_STEP=bridge.lockForPayout)…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8547"]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT, stdio: "inherit", env: ENV,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("2/5 user + €250 deposit…");
  const user = await api("/api/users", { name: "Refund Tester", country: "DE" });
  token = user.sessionToken;
  await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 250 });
  const device = newDevice();
  await registerDevice(api, user.id, device);

  console.log("3/5 €100 cash transfer — refuses undeployed local Safe…");
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 100, rail: "cash" });
  await assert.rejects(
    () => sendTransfer(api, device, { quoteId: quote.id, recipientName: "X", recipientPhone: "+254700000000" }),
    /Safe .* is not deployed/,
  );
  const after = await api(`/api/users/${user.id}`);
  assert.ok(Math.abs(after.balanceEur - 250) < 0.02, `balance untouched, got €${after.balanceEur}`);
  console.log(`      refused before movement; balance still €${after.balanceEur}`);

  console.log("5/5 pre-debit failure needs no refund…");
  // Force-fail earliest step via a fresh quote against a user with no funds:
  const broke = await api("/api/users", { name: "No Funds", country: "DE" });
  token = broke.sessionToken;
  const q2 = await api("/api/quotes", { userId: broke.id, sendEur: 50, rail: "cash" });
  const r2 = await fetch(`${API}/api/transfers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ quoteId: q2.id, recipientName: "X", recipientPhone: "+254700000000" }),
  });
  assert.equal(r2.status, 400, "insufficient balance rejected before any debit");

  console.log("\nFP3 TEST PASSED — local undeployed Safe does not fake a remittance");
} finally {
  for (const c of children) c.kill();
}
