/**
 * The outbox worker (services/api/src/outbox.ts, docs/postgres-store-design.md
 * §5), on the API's store: db.json under `npm run check`, Postgres 17 under
 * `npm run check:pg` (STORE_BACKEND=postgres).
 *
 * Covered: a row written with its state change is delivered once, after the
 * commit, never for a dropped transaction; a failure is retried after its
 * backoff with the same row id; the kind's last attempt makes it dead
 * (logged, kept); a claim whose lease ran out on the last attempt ends dead
 * without another send; a failed save after an acknowledged send is saved
 * again, not counted as a failed send; a row with no handler waits, unclaimed; a row written before a
 * restart is delivered after it; the PAID hooks run once per request, and a
 * hook that fails is not retried by the outbox (the sweep owns that).
 *
 * Run: npm run outbox:test
 */
// Must be first: pins chain 31337 and keys, as the other store suites do.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const onPostgres = process.env.STORE_BACKEND === "postgres";
if (!onPostgres) process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-outbox-")), "db.json");

const { initStore, store } = await import("../services/api/src/store.js");
const { backoffMs, drainOutbox, outboxMetrics, registerOutboxKind } = await import("../services/api/src/outbox.js");
const routes = await import("../services/api/src/routes/payment-requests.js");
await initStore();

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).stack ?? err}`);
  }
}
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsOf = async (kind: string) => (await store.list("outbox")).filter((r) => r.kind === kind);

await check("a state change's row is delivered once, after the commit; a dropped transaction's never", async () => {
  const seen: string[] = [];
  registerOutboxKind("test.state", { deliver: async (r) => void seen.push(String(r.payload.transferId)), maxAttempts: 3, retryBaseMs: 10 });
  store.onTransferStateChange((t) => (t.id.startsWith("t_obw_") ? { kind: "test.state", payload: { transferId: t.id } } : undefined));
  for (const id of ["t_obw_a", "t_obw_b"]) {
    await store.addTransfer({ id, userId: "u", quoteId: `q_${id}`, state: "CREATED", txs: [], createdAt: now(), updatedAt: now() } as any);
  }
  await store.tx(async (t) => {
    await t.updateTransfer("t_obw_a", { state: "DEBITED" });
    await wait(30);
    assert.deepEqual(seen, [], "nothing goes out while the transaction is open");
  });
  if (onPostgres) {
    await assert.rejects(
      store.tx(async (t) => {
        await t.updateTransfer("t_obw_b", { state: "DEBITED" });
        throw new Error("drop it");
      }),
      /drop it/,
    );
  }
  await drainOutbox();
  assert.deepEqual(seen, ["t_obw_a"]);
  const [row] = await rowsOf("test.state");
  assert.ok(row?.deliveredAt);
  assert.equal(row?.attempts, 1);
  await drainOutbox();
  assert.deepEqual(seen, ["t_obw_a"], "delivered once");
});

await check("a failure is retried after its backoff with the same row id; the last attempt makes it dead, logged and kept", async () => {
  const ids: string[] = [];
  const at: number[] = [];
  registerOutboxKind("test.flaky", {
    deliver: async (r) => {
      ids.push(r.id);
      at.push(Date.now());
      throw new Error("HTTP 503");
    },
    maxAttempts: 3,
    retryBaseMs: 40,
  });
  const before = { ...outboxMetrics };
  const row = (await store.enqueueOutbox({ kind: "test.flaky", payload: {} }))!;
  for (const s = Date.now(); ids.length < 3 && Date.now() - s < 5_000; ) await wait(20);
  await drainOutbox();
  assert.deepEqual(ids, [row.id, row.id, row.id], "three attempts, one idempotency key");
  assert.ok(at[1]! - at[0]! >= 40 - 5, `the second waited its backoff (${at[1]! - at[0]!} ms)`);
  assert.ok(at[2]! - at[1]! >= 160 - 5, `the third waited four times longer (${at[2]! - at[1]!} ms)`);
  const dead = (await store.findOutboxRow(row.id))!;
  assert.ok(dead.deadAt, "dead after the last attempt");
  assert.equal(dead.attempts, 3);
  assert.match(dead.lastError ?? "", /HTTP 503/);
  assert.deepEqual([outboxMetrics.retried - before.retried, outboxMetrics.dead - before.dead], [2, 1]);
  assert.equal((await store.outboxCounts()).dead >= 1, true);
  await wait(200);
  assert.equal(ids.length, 3, "a dead row is not tried again");
  assert.equal(backoffMs({ retryBaseMs: 5_000 }, 1), 5_000);
  assert.equal(backoffMs({ retryBaseMs: 5_000 }, 10), 3_600_000, "capped at an hour");
});

await check("the last attempt's lease ran out unsettled (a crash): the row ends dead, outcome unknown, and is not sent again", async () => {
  const kind = `test.crash.${randomUUID().slice(0, 8)}`;
  const row = (await store.enqueueOutbox({ kind, payload: {} }))!;
  // The process that died: it claimed attempt 1 of 1, sent, and never settled.
  assert.equal((await store.claimOutbox(10, 1, [kind])).length, 1);
  await wait(20);
  let sends = 0;
  registerOutboxKind(kind, { deliver: async () => void sends++, maxAttempts: 1, retryBaseMs: 10 });
  await drainOutbox();
  assert.equal(sends, 0, "past the limit: not sent again");
  const dead = (await store.findOutboxRow(row.id))!;
  assert.ok(dead.deadAt && !dead.deliveredAt);
  assert.match(dead.lastError ?? "", /attempt 1 was not settled.*outcome unknown/);
});

await check("an acknowledged send whose save fails once is saved again: delivered, not a failed attempt, not dead", async () => {
  const kind = `test.save.${randomUUID().slice(0, 8)}`;
  let sends = 0;
  const settle = store.settleOutbox;
  let failNext = true;
  (store as any).settleOutbox = async (...args: Parameters<typeof settle>) => {
    if (failNext && args[2].ok) {
      failNext = false;
      throw new Error("connection lost");
    }
    return settle(...args);
  };
  try {
    registerOutboxKind(kind, { deliver: async () => void sends++, maxAttempts: 1, retryBaseMs: 10 });
    const row = (await store.enqueueOutbox({ kind, payload: {} }))!;
    await drainOutbox();
    assert.equal(sends, 1, "sent once");
    const done = (await store.findOutboxRow(row.id))!;
    assert.ok(done.deliveredAt && !done.deadAt, JSON.stringify(done));
    assert.equal(done.lastError, undefined);
  } finally {
    (store as any).settleOutbox = settle;
  }
});

await check("a row written before a restart is delivered after it, by the handler registered then", async () => {
  const kind = `test.later.${randomUUID().slice(0, 8)}`;
  const row = (await store.enqueueOutbox({ kind, payload: { n: 1 }, key: `later:${kind}` }))!;
  assert.equal(await store.enqueueOutbox({ kind, payload: { n: 2 }, key: `later:${kind}` }), null, "one row per key");
  if (!onPostgres) {
    const disk = JSON.parse(readFileSync(process.env.TRANSF_DB_PATH!, "utf8"));
    assert.ok(disk.outbox.some((r: any) => r.id === row.id), "on disk when the write resolves");
  }
  // No handler yet (the feature off in this process): the row is not claimed.
  await drainOutbox();
  const waiting = (await store.findOutboxRow(row.id))!;
  assert.ok(!waiting.deliveredAt && !waiting.deadAt && waiting.attempts === 0, JSON.stringify(waiting));
  // The restart: the store is loaded again (db.json read back from disk),
  // and the handler registered.
  await initStore();
  const got: unknown[] = [];
  registerOutboxKind(kind, { deliver: async (r) => void got.push(r.payload), maxAttempts: 3, retryBaseMs: 10 });
  await drainOutbox();
  assert.deepEqual(got, [{ n: 1 }]);
  assert.ok((await store.findOutboxRow(row.id))?.deliveredAt);
});

await check("PAID hooks: once per request, from the outbox; a hook that throws is logged, not retried here (the sweep owns it)", async () => {
  const calls: string[] = [];
  routes.onPaymentRequestPaid(async (r) => {
    calls.push(r.id);
    throw new Error("the shop is down");
  });
  const r = {
    id: `pr_${randomUUID()}`, userId: "u", code: randomUUID().slice(0, 8).toUpperCase(), amountEur: 5, description: "x", methods: ["bank"], state: "OPEN",
    payments: [], cryptoQuotes: [], source: { kind: "app" }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now(), updatedAt: now(),
  } as any;
  await store.addPaymentRequest(r);
  await store.updatePaymentRequest(r.id, { state: "PAID", paidAt: now() });
  await store.updatePaymentRequest(r.id, { description: "edited" } as any);
  await drainOutbox();
  assert.deepEqual(calls, [r.id], "the hook ran once");
  const rows = (await rowsOf(routes.PAYMENT_REQUEST_PAID)).filter((x) => x.payload.paymentRequestId === r.id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.deliveredAt, "delivered: the hook's failure is the sweep's to retry");
});

if (!onPostgres && existsSync(process.env.TRANSF_DB_PATH!)) {
  await check("db.json keeps the outbox", async () => {
    const disk = JSON.parse(readFileSync(process.env.TRANSF_DB_PATH!, "utf8"));
    assert.ok(Array.isArray(disk.outbox) && disk.outbox.length > 0);
  });
}

await store.close();
if (failed) {
  console.error(`\nOUTBOX TEST FAILED — ${failed}`);
  process.exit(1);
}
console.log(`\nOUTBOX TEST PASSED${onPostgres ? " (Postgres)" : ""}`);
