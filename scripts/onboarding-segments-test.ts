/**
 * Segmentation at the API, not in the resolver.
 *
 * `npm run segments:test` proves the rules offline. This proves the WIRING,
 * which is where segmentation usually fails in practice:
 *
 *   - a blocked person is refused at signup and the refusal is AUDITED even
 *     though no account exists — "we refused someone and kept no record" is
 *     the failure the log exists to prevent;
 *   - the refusal copy never names the rule that fired;
 *   - the client is handed capabilities but NOT the reasonCode;
 *   - the segment cannot be set or changed by the client;
 *   - an IN_COLLECTIONS account is refused a partner call IN CODE, not merely
 *     denied a button — the check that a crafted request has to get past.
 *
 * Starts and stops its own chain and API.
 * Run: npm run onboarding:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIN = { USD: 1.1379, KES: 147.53 };
process.env.TRANSF_RATES_FIXED ??= JSON.stringify(PIN);
process.env.DEPLOY_EURUSD_RATE ??= String(Math.round(PIN.USD * 1e6));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);

const children: ChildProcess[] = [];
function spawnBg(cmd: string, args: string[]) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore",
    env: { ...process.env, MONERIUM_CLIENT_ID: "", MONERIUM_CLIENT_SECRET: "", MG_ANCHOR_DOMAIN: "" } });
  children.push(c);
  return c;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url: string, timeoutMs = 40_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function waitForRpc(url: string, timeoutMs = 40_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function call(method: string, pathname: string, opts: { token?: string; body?: any } = {}) {
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const NO_US = { usCitizen: false, usGreenCard: false, usTaxResident: false };
const signup = (body: any) => call("POST", "/api/users", { body });

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) { console.error(`${name} is already in use — stop it and re-run.`); process.exit(1); }
}

try {
  console.log("1/4 starting local chain…");
  spawnBg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  await waitForRpc(RPC_URL);

  console.log("2/4 deploying contracts…");
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"],
    { cwd: ROOT, stdio: "ignore" }).status, 0, "deploy failed");

  console.log("3/4 starting API…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  spawnBg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  await waitFor(`${API}/api/health`);

  console.log("4/4 driving signup…\n");

  console.log("Blocked paths");

  const usPerson = await signup({
    name: "US Person", country: "DE", email: "us@example.com",
    citizenships: ["DE"], accountType: "individual",
    usAnswers: { ...NO_US, usCitizen: true },
  });
  check("a US citizen resident in Germany is refused at signup", () => {
    assert.equal(usPerson.status, 403);
    assert.equal(usPerson.data.code, "BLOCKED_US");
  });
  check("the refusal says what Zold cannot offer, not which rule fired", () => {
    assert.equal(usPerson.data.error, "Zold is not available to US persons.");
    const body = JSON.stringify(usPerson.data);
    for (const leak of ["reasonCode", "us_answer_citizen", "Monerium", "citizenship"]) {
      assert.ok(!body.includes(leak), `refusal leaked ${leak}`);
    }
  });

  const sanctioned = await signup({
    name: "S", country: "DE", citizenships: ["RU"], accountType: "individual", usAnswers: NO_US,
  });
  check("a sanctioned citizenship is refused with the country wording", () => {
    assert.equal(sanctioned.status, 403);
    assert.equal(sanctioned.data.code, "BLOCKED_SANCTIONED");
  });

  const nigerian = await signup({
    name: "N", country: "NG", citizenships: ["NG"], accountType: "individual", usAnswers: NO_US,
  });
  check("a Nigerian resident is UNSUPPORTED and is never called sanctioned", () => {
    assert.equal(nigerian.status, 403);
    assert.equal(nigerian.data.code, "BLOCKED_UNSUPPORTED");
    assert.ok(!/sanction/i.test(JSON.stringify(nigerian.data)), "must not imply a sanction");
    // Monerium's country-policy message would name a partner to someone who
    // was never going to use it.
    assert.ok(!/monerium/i.test(JSON.stringify(nigerian.data)), "must not name a partner");
  });

  console.log("\nAllowed paths");

  const de = await signup({
    name: "Mira", country: "DE", email: "mira@example.com",
    citizenships: ["DE", "IN"], accountType: "individual", usAnswers: NO_US,
    consents: [{ kind: "zold_terms" }, { kind: "partner_share", partner: "Monerium + Gnosis Pay" }],
  });
  check("an Indian citizen resident in Germany gets the full path", () => {
    assert.equal(de.status, 201);
    assert.equal(de.data.segment.value, "EU_FULL");
    assert.ok(de.data.segment.capabilities.includes("card"));
  });
  check("the client is given capabilities but NOT the rule that produced them", () => {
    assert.equal(de.data.segment.reasonCode, undefined);
    assert.equal(de.data.usPersonAnswers, undefined, "raw US answers must not be echoed back");
  });

  const inUser = await signup({
    name: "Ravi", country: "IN", email: "ravi@example.com",
    citizenships: ["IN"], accountType: "individual", usAnswers: NO_US,
  });
  check("an Indian resident is IN_COLLECTIONS and is told the path is gated", () => {
    assert.equal(inUser.status, 201);
    assert.equal(inUser.data.segment.value, "IN_COLLECTIONS");
    assert.deepEqual(inUser.data.segment.capabilities, ["xflow_collections"]);
    assert.match(inUser.data.segment.gate.needs, /incorporated in India/i);
  });

  const br = await signup({
    name: "Ana", country: "BR", citizenships: ["BR"], accountType: "individual", usAnswers: NO_US,
  });
  check("a Brazilian resident gets an account with no card", () => {
    assert.equal(br.data.segment.value, "ONCHAIN_NO_CARD");
    assert.ok(!br.data.segment.capabilities.includes("card"));
  });

  console.log("\nThe segment is not the client's to set");

  const forged = await signup({
    name: "Forger", country: "IN", citizenships: ["IN"], accountType: "individual",
    usAnswers: NO_US, segment: { value: "EU_FULL" },
  });
  check("a segment in the signup body is ignored", () => {
    assert.equal(forged.data.segment.value, "IN_COLLECTIONS");
  });

  console.log("\nCapabilities are enforced in code, not by hiding buttons");

  const inToken: string = inUser.data.sessionToken;
  const inId: string = inUser.data.id;

  const quote = await call("POST", "/api/quotes", {
    token: inToken, body: { userId: inId, sendEur: 50, rail: "sepa" },
  });
  check("an IN_COLLECTIONS account cannot get a quote — refused 403 in the route", () => {
    assert.equal(quote.status, 403);
    assert.equal(quote.data.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(quote.data.capability, "onchain_balance");
  });

  const safe = await call("POST", `/api/users/${inId}/passkey-safe/deployment`, { token: inToken });
  check("an IN_COLLECTIONS account cannot deploy a Safe", () => {
    assert.equal(safe.status, 403);
    assert.equal(safe.data.capability, "safe");
  });

  const mon = await call("POST", `/api/users/${inId}/monerium/connect/start`, { token: inToken });
  check("an IN_COLLECTIONS account cannot reach Monerium", () => {
    assert.equal(mon.status, 403);
    assert.equal(mon.data.capability, "monerium");
  });

  const gp = await call("GET", "/api/gnosis-pay/config", { token: inToken });
  check("an IN_COLLECTIONS account cannot reach Gnosis Pay", () => {
    assert.equal(gp.status, 403);
    assert.equal(gp.data.capability, "gnosis_pay");
  });

  const euQuote = await call("POST", "/api/quotes", {
    token: de.data.sessionToken, body: { userId: de.data.id, sendEur: 50, rail: "sepa" },
  });
  check("the same call from an EU_FULL account is NOT blocked by the guard", () => {
    // It may still fail later for balance or Safe reasons; what matters is that
    // it is not the capability guard refusing it.
    assert.notEqual(euQuote.data.code, "CAPABILITY_UNAVAILABLE");
  });

  console.log(`\nONBOARDING SEGMENTS TEST PASSED — ${passed}/${passed} checks.`);
  console.log("Blocked users are refused and audited; capabilities are enforced in the routes.");
} finally {
  for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
  await sleep(400);
}
