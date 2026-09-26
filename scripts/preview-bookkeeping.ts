/**
 * The local stack with the books seeded: chain -> deploy -> a store holding
 * one business organisation, its EUR account and a month of fixture events
 * (a SEPA credit, a converted USDC payment against an external invoice, a
 * PAID SEPA payout) -> API on :3000.
 *
 * Harness only (chain 31337, its own db file, a fixed session token). The
 * fixtures are fixtures: every conversion figure carries the rule-2 label
 * exactly as it would on a deployment where no swap has run.
 *
 * Run: npm run preview:bookkeeping, then open /business with the token
 * printed below in localStorage["zold-session"].
 */
import "./_local-chain.js";
process.env.TRANSF_DB_PATH = "data/db.preview-bookkeeping.json";
process.env.TRANSF_RATES_FIXED ??= JSON.stringify({ USD: 1.1403, INR: 109.87, KES: 147.53 });
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY ??= "preview-bookkeeping-encryption-key-32";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const TOKEN = "preview-bookkeeping-session-token";

async function waitForChain(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`chain did not come up on :${RPC_PORT}`);
}

console.log(`starting local chain on :${RPC_PORT}…`);
const chain = spawn(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT], { cwd: ROOT, stdio: "ignore" });
process.on("exit", () => chain.kill());
await waitForChain();
console.log("deploying contracts…");
if (spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" }).status !== 0) process.exit(1);

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
console.log("seeding the books…");
{
  const { initStore, store } = await import("../services/api/src/store.js");
  initStore();
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const month = iso(now).slice(0, 7);
  const day = (n: number, h = 9) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n, h)));
  const SAFE = "0x1111111111111111111111111111111111111111" as const;
  const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  store.addUser({ id: "u_preview", name: "Zoldenburg UG", email: "books@example.com", country: "DE", kycStatus: "approved", iban: "EE382200221020145685", address: SAFE, passkey: { credentialId: "preview", createdAt: iso(now) }, passkeySafe: { address: SAFE, status: "active", threshold: 1, passkeyPublicKey: { x: "0x1", y: "0x2" }, createdAt: iso(now) }, paymentPage: { handle: "zold", depositAddress: SAFE, recipientAddress: SAFE, settlementAsset: "EURE", autoConvert: true, createdAt: iso(now), updatedAt: iso(now) }, createdAt: iso(now) } as any);
  store.addSession({ id: "s_preview", userId: "u_preview", tokenHash: createHash("sha256").update(TOKEN).digest("hex"), createdAt: iso(now), lastUsedAt: iso(now), expiresAt: iso(new Date(now.getTime() + 24 * 3600_000)) });
  store.addOrganisation({ id: "org_preview", type: "business", name: "Zoldenburg UG", legalName: "Zoldenburg UG (haftungsbeschränkt)", plan: "business", address: { country: "DE", city: "Regensburg" }, reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: iso(now), updatedAt: iso(now) });
  store.addMember({ id: "m_preview", orgId: "org_preview", userId: "u_preview", email: "books@example.com", role: "owner", status: "active", invitedAt: iso(now), acceptedAt: iso(now) });
  store.addAccount({ id: "acc_preview", orgId: "org_preview", currency: "EUR", label: "Operating EUR", status: "active", provider: "monerium", identifier: { iban: "EE382200221020145685" }, address: SAFE, backingUserId: "u_preview", createdAt: iso(now), updatedAt: iso(now) });
  store.addPaymentRequest({ id: "pr_preview", code: "ABCDEFGHJKMNPQR", userId: "u_preview", orgId: "org_preview", handle: "zold", amountEur: 119, currency: "EUR", methods: ["crypto", "bank"], state: "PAID", externalInvoiceNumber: "RE-2026-0042", cryptoQuotes: [], payments: [{ id: "p1", method: "crypto", ref: "deposit:d_preview", depositId: "d_preview", amountEur: 119, amountUsdc: 137, txHash: H(5), kind: "full", settledEur: 119.62, settledAsset: "EURE", at: day(10) }], source: { kind: "app" }, expiresAt: iso(new Date(now.getTime() + 7 * 24 * 3600_000)), paidAt: day(10), createdAt: day(8), updatedAt: day(10) });
  store.recordMoneriumIssue({ orderId: "ord-preview-1", userId: "u_preview", amountEur: 250, counterpartyName: "Kunde AG", counterpartyIban: "DE89370400440532013000", memo: "RE-2026-0041", processedAt: day(3), recordedAt: day(3, 10) });
  store.addCryptoDeposit({ id: "d_preview", userId: "u_preview", chainId: 31337, token: "USDC", txHash: H(5), logIndex: 2, amountUnits: "137000000", amountUsdc: 137, from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", receipt: { amountEur: 120.14, rate: 1.1403, rateProvider: "ecb via api.frankfurter.dev", rateAsOf: day(10).slice(0, 10), ratedAt: day(10, 10), blockTimestamp: day(10, 9) }, state: "CONVERTED", settlementAsset: "EURE", creditedEur: 119.62, provider: "dex", rate: 1.1452, midRate: 1.1403, realisedGainEur: -0.52, conversion: { userOpHash: H(6), txHash: H(7), blockNumber: 12, at: day(10, 10), amountInUnits: "137000000", gasCostWei: "1200000000000", gasPaidBy: "sponsored" }, paymentRequestId: "pr_preview", txs: [{ step: "safe.swap(usdc->eure)", hash: H(7) }, { step: "userOperation", hash: H(6) }], detectedAt: day(10, 10), updatedAt: day(10, 10) });
  store.addTransfer({ id: "t_preview", userId: "u_preview", quoteId: "q_preview", rail: "sepa", state: "PAID", sendEur: 80, receiveEur: 80, recipientName: "Vermieter GmbH", recipientIban: "DE02120300000000202051", reference: "Miete " + month, fundingSource: "safe", txs: [{ step: "monerium.redeem", hash: H(8) }], sepa: { mode: "sandbox", orderId: "ord-preview-redeem", state: "processed" }, createdAt: day(15, 8), updatedAt: day(15, 12) } as any);
  const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
  console.log("statement lines:", writeStatementLines());
}

console.log(`starting API on :${API_PORT}…`);
console.log(`\n  In the browser: localStorage.setItem("zold-session", "${TOKEN}"); then open /business\n`);
const api = spawn(process.execPath, [bin("tsx"), "services/api/src/server.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRANSF_API_PORT: String(API_PORT) } });
process.on("exit", () => api.kill());
api.on("exit", (code) => process.exit(code ?? 0));
