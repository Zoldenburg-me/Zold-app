/**
 * End-to-end API smoke test: chain up -> deploy -> API up -> create user ->
 * SEPA deposit -> quote -> authorization guard.
 *
 * RemitVault has been abandoned, so hardhat-only local users can no longer
 * execute remittances through a fake ledger. Full remittance execution now
 * requires a deployed Safe/bundler path; local e2e verifies the API refuses to
 * pretend that path ran.
 * Self-contained: starts and stops its own chain and API. Resets data/db.json
 * (demo data only — the chain state it mirrors dies with the chain anyway).
 * Run: npm run e2e
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice, signTerms } from "./device.js";


/**
 * Pin FX for the run, before anything spawns — the deploy and the API inherit
 * this env.
 *
 * Quotes now come from a live rate feed, so an end-to-end test that asserts a
 * KES figure would otherwise be asserting today's market and would break every
 * morning for no reason (and fail entirely offline). Pinning keeps the test
 * about the corridor working, not about what the euro did overnight.
 *
 * These two must be pinned TOGETHER: RATES supplies the USD->fiat legs while
 * DEPLOY_EURUSD_RATE seeds the swapper's EUR->USD, which is the rate the quote
 * engine reads back off the chain.
 */
const PIN = { USD: 1.1379, INR: 109.87, KES: 147.53 };
process.env.TRANSF_RATES_FIXED ??= JSON.stringify(PIN);
process.env.DEPLOY_EURUSD_RATE ??= String(Math.round(PIN.USD * 1e6));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);
let sessionToken = "";

const children: ChildProcess[] = [];
function spawnBg(cmd: string, args: string[]) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "ignore",
    // Force mock mode even when .env holds sandbox credentials — the e2e
    // exercises the local corridor, not external sandboxes/anchors.
    env: {
      ...process.env,
      MONERIUM_CLIENT_ID: "",
      MONERIUM_CLIENT_SECRET: "",
      MG_ANCHOR_DOMAIN: "",
    },
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function waitForRpc(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function api(pathname: string, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${pathname}: ${data.error ?? res.statusText}`);
  return data;
}

async function expectApiStatus(pathname: string, status: number, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  assert.equal(res.status, status, `${pathname} should return ${status}`);
}

// FP4: the sender's device key. In the app this is generated in the browser
// and gated behind the passkey; here the script plays the device. The server
// never sees the private half.
const device = newDevice();

/** Create a transfer, sign the terms on the device, submit the signature. */
async function sendTransfer(body: any) {
  const created = await api("/api/transfers", body);
  assert.equal(created.state, "CREATED", "transfer waits for device authorization");
  assert.ok(created.authorization?.typedData, "creation returns terms to sign");
  assert.equal(
    created.authorization.authorizer.toLowerCase(),
    device.address.toLowerCase(),
    "terms are addressed to the registered device key",
  );
  const signature = await signTerms(device, created.authorization.typedData);
  return { created, result: await api(`/api/transfers/${created.id}/authorize`, { signature }) };
}

async function expectApiDeleteStatus(pathname: string, status: number) {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(API + pathname, { method: "DELETE", headers });
  assert.equal(res.status, status, `${pathname} should return ${status}`);
}

// Fail fast if another stack is already bound to our ports — otherwise the
// spawns fail silently and the test talks to the wrong server.
for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use (is 'npm run dev' running?) — stop it and re-run e2e.`);
    process.exit(1);
  }
}

try {
  console.log("1/8 starting local chain…");
  spawnBg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  await waitForRpc(RPC_URL);

  console.log("2/8 deploying contracts…");
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" });
  assert.equal(dep.status, 0, "deploy failed");

  console.log("3/8 starting API…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  spawnBg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  await waitFor(`${API}/api/health`);

  console.log("4/8 creating user + SEPA deposit of €250…");
  const user = await api("/api/users", { name: "E2E Tester", country: "DE" });
  assert.ok(user.sessionToken, "account creation returns a session token");
  sessionToken = user.sessionToken;
  assert.match(user.iban, /^IS14/);
  const userSession = sessionToken;
  sessionToken = "";
  await expectApiStatus(`/api/users/${user.id}`, 401);
  await expectApiStatus("/api/quotes", 401, { userId: user.id, sendEur: 25 });
  const other = await api("/api/users", { name: "Other User", country: "DE" });
  sessionToken = other.sessionToken;
  await expectApiStatus(`/api/users/${user.id}`, 403);
  await expectApiStatus("/api/quotes", 403, { userId: user.id, sendEur: 25 });
  sessionToken = userSession;
  const depRes = await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 250 });
  assert.equal(depRes.balanceEur, 250);

  console.log("      registering device key (FP4)…");
  const bound = await registerDevice(api, user.id, device);
  assert.equal(bound.authorizerAddress.toLowerCase(), device.address.toLowerCase());
  // A second device cannot take over an account that is already bound.
  await expectApiStatus(`/api/users/${user.id}/authorizer`, 409, {
    address: newDevice().address,
  });

  console.log("5/8 quoting €100 EUR->KES…");
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 100 });
  assert.ok(quote.receiveKes > 0, "quote has a KES amount");
  // Derived from the pinned rates above, not from hardcoded constants: the
  // EUR->USD leg is the swapper's rate and the USD->KES leg is the feed's.
  const expected = (100 - 0.99) * PIN.USD * (PIN.KES / PIN.USD) * (1 - 0.005);
  assert.ok(Math.abs(quote.receiveKes - expected) < 1, `quote ${quote.receiveKes} ≈ ${expected}`);
  // The receipt must quote the market mid, not our own all-in rate — that
  // conflation is what let a 14% stale rate sit behind a "0.50% margin" label.
  assert.ok(quote.midRate > quote.fxRate, "mid should sit above the all-in rate");
  assert.equal(quote.marginBps, 50, "margin is measured against the live mid");

  console.log("6/8 local remittance refuses accounts without passkey Safe allowance…");
  await assert.rejects(
    () =>
      sendTransfer({
        quoteId: quote.id,
        recipientName: "Joseph Otieno",
        recipientPhone: "+254700000000",
      }),
    /active passkey Safe with a production co-signer allowance/,
  );
  await expectApiStatus("/api/transfers", 409, {
    quoteId: quote.id,
    recipientName: "Replay Receiver",
    recipientPhone: "+254711111111",
  });
  const after = await api(`/api/users/${user.id}`);
  assert.equal(after.balanceEur, 250, "failed local remittance moved no money");

  console.log("7/8 refusing the retired UPI rail…");
  await expectApiStatus("/api/quotes", 400, { userId: user.id, sendEur: 20, rail: "upi" });

  console.log("8/8 Safe setup blocker still protects the SEPA rail…");
  const balanceBefore = after.balanceEur;
  const attackQuote = await api("/api/quotes", { userId: user.id, sendEur: 20, rail: "sepa" });
  await expectApiStatus("/api/transfers", 409, {
    quoteId: attackQuote.id,
    recipientName: "Mallory Attacker",
    recipientIban: "DE89 3704 0044 0532 0130 00",
  });
  const afterAttack = await api(`/api/users/${user.id}`);
  assert.equal(afterAttack.balanceEur, balanceBefore, "blocked SEPA setup moved no money");
  await expectApiDeleteStatus("/api/session", 204);
  await expectApiStatus(`/api/users/${user.id}`, 401);

  console.log("\nE2E PASSED — Safe-first API refuses fake local remittance execution");
} finally {
  for (const c of children) c.kill();
}
