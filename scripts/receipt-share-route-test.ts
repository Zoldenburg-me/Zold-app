/**
 * The receipt-share routes and expiry (board #129). Sharing again always
 * makes a new link and turns the previous one off; a link never changes.
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

await initStore();
const now = new Date().toISOString();
await store.addUser({ id: "u1", name: "Erika Muster", country: "DE", kycStatus: "approved", createdAt: now } as any);
await store.addTransfer({
  id: "t1", userId: "u1", state: "PAID", rail: "sepa", recipientName: "Max Muster", recipientIban: "DE89370400440532013000",
  sendEur: 100, receiveEur: 100, receiveKes: 0, fundingSource: "safe", txs: [], createdAt: now, updatedAt: now,
} as any);
const day = 86400000;
await store.addReceiptShare({
  id: "rs_old", slug: "oldxx-oldxx-oldxx", transferId: "t1", userId: "u1",
  fields: { ...DEFAULT_SHARE_FIELDS, sender: "full", route: true },
  createdAt: new Date(Date.now() - 40 * day).toISOString(), updatedAt: now,
  expiresAt: new Date(Date.now() - 10 * day).toISOString(),
});

/** Set by a race check: holds each POST until both have arrived. */
let barrier: undefined | (() => Promise<void>);

const app = express();
app.use(express.json());
app.use("/api", createReceiptShareRouter({
  requireUserSession: async (req, res, userId) => {
    if (barrier && req.method === "POST") await barrier();
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

await check("sharing again makes a new link: the first answers 410, the second shows only its own fields", async () => {
  const g = await call("GET", "/transfers/t1/share");
  assert.equal(g.status, 200);
  assert.equal(g.body.slug, fresh);
  const again = await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS, sender: "hidden", route: false });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.slug, fresh, "a new slug, not the old link edited");
  assert.equal((await store.findReceiptShareBySlug(fresh))?.fields.sender, "full", "the first link's fields never changed");
  const first = await call("GET", `/r/${fresh}`);
  assert.equal(first.status, 410, "the replaced link is off");
  const second = await call("GET", `/r/${again.body.slug}`);
  assert.equal(second.status, 200);
  const sender = JSON.stringify(second.body).includes("Erika");
  assert.equal(sender, false, "the new link withholds the sender, as chosen for it");
  assert.equal((await store.list("receiptShares")).filter((s: any) => s.transferId === "t1" && !s.revokedAt).length, 1, "one live share");
  fresh = again.body.slug;
});

await check("an edit cannot change a link: a stale composer's edit is refused and the newer link keeps its fields", async () => {
  const before = (await store.findReceiptShareBySlug(fresh))!;
  const r = await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS, sender: "full", route: true, edit: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LINK_NOT_EDITABLE");
  assert.equal(r.body.url, undefined);
  const after = (await store.findReceiptShareBySlug(fresh))!;
  assert.deepEqual(after.fields, before.fields, "the newer link shows what it showed");
  assert.equal(after.revokedAt, undefined, "and stays live");
  assert.equal((await call("GET", "/transfers/t1/share")).body.slug, fresh, "no other link was made");
  // Turned off, a new link is only made by Create link (no edit flag).
  await call("DELETE", "/transfers/t1/share");
  assert.equal((await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS, edit: true })).status, 409, "an edit after revoke makes nothing either");
  assert.equal((await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS })).status, 201);
});

await check("a composer showing a replaced link cannot turn off the newer one", async () => {
  const shown = (await call("GET", "/transfers/t1/share")).body.slug;
  const newer = (await call("POST", "/transfers/t1/share", { ...DEFAULT_SHARE_FIELDS })).body.slug;
  const stale = await call("DELETE", "/transfers/t1/share", { slug: shown });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "LINK_REPLACED");
  assert.equal((await call("GET", `/r/${newer}`)).status, 200, "the newer link is still on");
  assert.equal((await call("DELETE", "/transfers/t1/share", { slug: newer })).status, 200, "the link on screen is turned off");
  assert.equal((await call("GET", `/r/${newer}`)).status, 410);
});

await check("two shares at once leave one live link, and DELETE turns it off", async () => {
  await store.addTransfer({ ...(await store.findTransfer("t1"))!, id: "t2" } as any);
  await store.addReceiptShare({
    id: "rs_t2", slug: "t2old-t2old-t2old", transferId: "t2", userId: "u1", fields: { ...DEFAULT_SHARE_FIELDS },
    createdAt: new Date(Date.now() - 40 * day).toISOString(), updatedAt: now, expiresAt: new Date(Date.now() - 10 * day).toISOString(),
  });
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  barrier = async () => { if (++arrived === 2) release(); await both; };
  let a, b;
  try {
    [a, b] = await Promise.all([call("POST", "/transfers/t2/share", { ...DEFAULT_SHARE_FIELDS }), call("POST", "/transfers/t2/share", { ...DEFAULT_SHARE_FIELDS })]);
  } finally { barrier = undefined; }
  assert.deepEqual([a.status, b.status], [201, 201], `both make a link: ${JSON.stringify([a.body, b.body])}`);
  const live = (await store.list("receiptShares")).filter((s: any) => s.transferId === "t2" && !s.revokedAt);
  assert.equal(live.length, 1, "one unrevoked share per transfer: the later one turned the earlier off");
  assert.ok([a.body.slug, b.body.slug].includes(live[0].slug));
  assert.equal((await call("DELETE", "/transfers/t2/share")).status, 200);
  for (const slug of [a.body.slug, b.body.slug]) assert.equal((await call("GET", `/r/${slug}`)).status, 410, "after DELETE neither link opens");
});

server.close();
if (process.exitCode) process.exit();
console.log(`\nRECEIPT SHARE ROUTE TEST PASSED — ${passed}/${passed}`);
