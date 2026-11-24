/**
 * The receipt-share routes and expiry (board #129).
 *
 * A share is a 30-day window. Once it has passed, the composer must not be
 * handed the dead URL as if it were live (it would copy or share a link the
 * recipient gets 410 for), and Create must mint a fresh slug rather than edit
 * the expired one. The expired slug stays expired.
 *
 * Real router over a temp store, session stubbed by header. Offline.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-receipt-route-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { DEFAULT_SHARE_FIELDS } = await import("../services/api/src/receipt.js");
const { createReceiptShareRouter } = await import("../services/api/src/routes/receipt-shares.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
store.addUser({ id: "u1", name: "Erika Muster", country: "DE", kycStatus: "approved", createdAt: now } as any);
store.addTransfer({
  id: "t1", userId: "u1", state: "PAID", rail: "sepa", recipientName: "Max Muster", recipientIban: "DE89370400440532013000",
  sendEur: 100, receiveEur: 100, receiveKes: 0, fundingSource: "safe", txs: [], createdAt: now, updatedAt: now,
} as any);
const day = 86400000;
store.addReceiptShare({
  id: "rs_old", slug: "oldxx-oldxx-oldxx", transferId: "t1", userId: "u1",
  fields: { ...DEFAULT_SHARE_FIELDS, sender: "full", route: true },
  createdAt: new Date(Date.now() - 40 * day).toISOString(), updatedAt: now,
  expiresAt: new Date(Date.now() - 10 * day).toISOString(),
});

const app = express();
app.use(express.json());
app.use("/api", createReceiptShareRouter({
  requireUserSession: (req, res, userId) => {
    if (req.header("x-user") === userId) return { id: "s" };
    res.status(403).json({ error: "forbidden" });
    return undefined;
  },
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${API}/api${p}`, {
    method, headers: { "content-type": "application/json", "x-user": "u1" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
};

await check("an expired share is not returned as the live link; the sender's choices come back with it", async () => {
  const r = await call("GET", "/transfers/t1/share");
  assert.equal(r.status, 404);
  assert.equal(r.body.expired, true);
  assert.equal(r.body.url, undefined, "the dead URL is not handed to the composer");
  assert.equal(r.body.slug, undefined);
  assert.equal(r.body.fields.sender, "full");
});

let fresh = "";
await check("Create after expiry mints a fresh slug with a new 30-day window", async () => {
  const r = await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS, sender: "full", route: true });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.slug, "oldxx-oldxx-oldxx");
  assert.ok(Date.parse(r.body.expiresAt) > Date.now() + 29 * day);
  assert.equal(r.body.fields.sender, "full");
  fresh = r.body.slug;
});

await check("the old slug stays expired and the new one opens", async () => {
  const old = await call("GET", "/r/oldxx-oldxx-oldxx");
  assert.equal(old.status, 410);
  assert.equal(old.body.expired, true);
  const now = await call("GET", `/r/${fresh}`);
  assert.equal(now.status, 200);
});

await check("the composer now reads the fresh link, and editing it keeps that slug", async () => {
  const g = await call("GET", "/transfers/t1/share");
  assert.equal(g.status, 200);
  assert.equal(g.body.slug, fresh);
  const e = await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS, sender: "hidden" });
  assert.equal(e.status, 200);
  assert.equal(e.body.slug, fresh);
  assert.equal(store.findReceiptShareBySlug("oldxx-oldxx-oldxx")?.fields.sender, "full", "the expired share is not edited");
});

server.close();
if (process.exitCode) process.exit();
console.log(`\nRECEIPT SHARE ROUTE TEST PASSED — ${passed}/${passed}`);
