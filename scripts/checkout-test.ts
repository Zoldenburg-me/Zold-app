/**
 * "Pay with Zold" checkout test — the full merchant OAuth handoff for an
 * existing user (Version 1):
 *   merchant authorize -> user signs in + authorizes a SEPA transfer into the
 *   merchant's IBAN (real device-key flow) -> attach -> merchant exchanges the
 *   PKCE code for PAID status. Also checks a wrong PKCE verifier is rejected.
 * Own ports. Run: npm run checkout:test
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice, sendTransfer } from "./device.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8549";
const API = "http://127.0.0.1:3012";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
let token = "";
const DEMO_IBAN = "DE89370400440532013000";
const ENV = {
  ...process.env,
  MONERIUM_CLIENT_ID: "", MONERIUM_CLIENT_SECRET: "", MG_ANCHOR_DOMAIN: "",
  TRANSF_RPC_URL: RPC, TRANSF_API_PORT: "3012", CHECKOUT_DEMO_IBAN: DEMO_IBAN,
};
const children: ChildProcess[] = [];
const bg = (c: string, a: string[]) => { const p = spawn(c, a, { cwd: ROOT, stdio: "ignore", env: ENV }); children.push(p); return p; };

async function api(p: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(API + p, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: h });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${data.error ?? res.statusText}`);
  return data;
}

try {
  console.log("1/6 chain + deploy + API…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8549"]);
  { const s = Date.now(); while (Date.now() - s < 30_000) { try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); } }
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: ENV }).status, 0);
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  { const s = Date.now(); while (Date.now() - s < 30_000) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); } }

  console.log("2/6 merchant authorize (PKCE)…");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const amount = 40;
  const authz = await api(
    `/api/checkout/authorize?client_id=demo-merchant&amount=${amount}&reference=mony-user-123` +
      `&redirect_uri=${encodeURIComponent("https://mony.example/callback")}&state=${state}` +
      `&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    undefined,
    { accept: "application/json" },
  );
  assert.ok(authz.intentId, "intent created");
  assert.equal(authz.amountEur, amount);
  const intentId = authz.intentId;

  console.log("3/6 user signs in, funds, registers device…");
  const user = await api("/api/users", { name: "Existing User", country: "DE" });
  token = user.sessionToken;
  await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 100 });
  const device = newDevice();
  await registerDevice(api, user.id, device);

  console.log("4/6 authorize a SEPA payment into the merchant IBAN…");
  // Merchant receives `amount`; sender pays amount + fee. Quote is sender-fixed.
  const quote = await api("/api/quotes", { userId: user.id, sendEur: amount + 0.99, rail: "sepa" });
  assert.ok(Math.abs(quote.receiveEur - amount) < 0.01, `merchant receives ~€${amount}, got ${quote.receiveEur}`);
  const transfer = await sendTransfer(api, device, {
    quoteId: quote.id,
    recipientName: "Mony (demo)",
    recipientIban: DEMO_IBAN,
  });
  assert.ok(["PAID", "PAYOUT_SUBMITTED"].includes(transfer.state), `transfer state ${transfer.state}`);

  console.log("5/6 attach transfer → redirect code…");
  const attach = await api(`/api/checkout/intents/${intentId}/attach`, { transferId: transfer.id });
  const redirect = new URL(attach.redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, "https://mony.example/callback");
  assert.equal(redirect.searchParams.get("state"), state, "state echoed back");
  const code = redirect.searchParams.get("code")!;
  assert.ok(code, "authorization code issued");

  console.log("6/6 merchant token exchange…");
  token = "";
  // Wrong PKCE verifier must fail.
  await assert.rejects(
    () => api("/api/checkout/token", { client_id: "demo-merchant", client_secret: "demo-secret", code, code_verifier: "wrong" }),
    /PKCE/,
    "bad PKCE verifier rejected",
  );
  const result = await api("/api/checkout/token", {
    client_id: "demo-merchant", client_secret: "demo-secret", code, code_verifier: codeVerifier,
  });
  assert.equal(result.status, "PAID", `expected PAID, got ${result.status}`);
  assert.equal(result.amountEur, amount);
  assert.equal(result.reference, "mony-user-123", "merchant reference preserved");
  // Poll with the issued bearer.
  const polled = await api(`/api/checkout/status/${intentId}`, undefined, { authorization: `Bearer ${result.statusToken}` });
  assert.equal(polled.status, "PAID");

  console.log("\nCHECKOUT TEST PASSED — Pay-with-Zold handoff: authorize → device-signed SEPA → code → PAID");
} finally {
  for (const c of children) c.kill();
}
