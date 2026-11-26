/**
 * The concurrency tests of docs/postgres-store-design.md §2 (first table),
 * on the API's own `store` over Postgres 17, each racer on its own pooled
 * connection. Run by `npm run check:pg` (scripts/store-pg-test.ts), which
 * creates and migrates a throwaway database and starts this with
 * STORE_BACKEND=postgres and DATABASE_URL; it refuses to run on db.json.
 *
 * Store level, with the app's own functions where they need no chain: the
 * cap sum is orchestrator.ts's, the Monerium order path is the webhook's
 * against a stub Monerium, the payment-request path is the poller's.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

if (process.env.STORE_BACKEND !== "postgres" || !process.env.DATABASE_URL) {
  console.error("pg-concurrency-test runs on Postgres: npm run check:pg starts it with STORE_BACKEND=postgres and DATABASE_URL");
  process.exit(2);
}
process.env.TRANSF_CHAIN_ID = "84532";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:1"; // nothing here reads the chain
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-pg-concurrency";
process.env.MONERIUM_CLIENT_ID = "app-client";
process.env.MONERIUM_CLIENT_SECRET = "app-secret-0001";
process.env.MONERIUM_CHAIN = "base";

// A stub Monerium that knows one processed issue order per test.
const orders = new Map<string, any>();
const monerium = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  req.resume();
  if (url.pathname === "/auth/token") return req.on("end", () => send(200, { access_token: "tok-app", token_type: "Bearer", expires_in: 3600 }));
  if (url.pathname === "/tokens") {
    return send(200, [{ kind: "evm", currency: "eur", symbol: "EURe", chain: "base", chainId: 84532, decimals: 18, address: "0x00000000000000000000000000000000000000e0" }]);
  }
  if (url.pathname === "/orders") return send(200, { orders: [...orders.values()] });
  const m = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (m && orders.has(m[1])) return send(200, orders.get(m[1]));
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as { port: number }).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { FX } = await import("../services/api/src/config.js");
const { safeFundedEurToday } = await import("../services/api/src/orchestrator.js");
const { handleWebhookEvent, pollDepositsOnce } = await import("../services/api/src/adapters/monerium-sandbox.js");
const routes = await import("../services/api/src/routes/payment-requests.js");
const { applyPayment } = await import("../services/api/src/payment-requests.js");
const pg = (await import("pg")).default;

await initStore();
/** Direct connections to the test database, for what a test sets up around the store. */
const rowsOf = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).stack}`);
  }
}
const now = () => new Date().toISOString();
const n = <T>(count: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: count }, (_, i) => fn(i)));
const hex = (bytes: number) => `0x${randomUUID().replace(/-/g, "").repeat(4).slice(0, bytes * 2)}` as `0x${string}`;

async function user(over: Record<string, unknown> = {}) {
  const id = `u_${randomUUID()}`;
  await store.addUser({ id, name: id, country: "DE", kycStatus: "approved", address: hex(20), iban: "", createdAt: now(), ...over } as any);
  return id;
}
const transferRow = (userId: string, over: Record<string, unknown> = {}) =>
  ({ id: `t_${randomUUID()}`, userId, quoteId: `q_${randomUUID()}`, rail: "sepa", state: "CREATED", sendEur: 10, fundingSource: "safe", txs: [], createdAt: now(), updatedAt: now(), ...over }) as any;

console.log("pg concurrency (§2)");

await check("quote → transfer: 20 parallel builds on one quote make one transfer, the cap held and released", async () => {
  const u = await user();
  const quote = { id: `q_${randomUUID()}`, userId: u, rail: "sepa", sendEur: 50, status: "OPEN", expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now() } as any;
  await store.addQuote(quote);
  // transfers/build.ts in order: hold the cap, consume the quote, write the row under the hold, release.
  const build = async () => {
    const held = await store.holdDailyCap(u, quote.sendEur, FX.DAILY_CAP_EUR, async () => await safeFundedEurToday(u));
    if (!held.ok) return "cap";
    try {
      if (!(await store.consumeQuote(quote.id))) return "consumed";
      await store.addTransferUnderHold(transferRow(u, { quoteId: quote.id, sendEur: quote.sendEur }), held.holdId);
      return "created";
    } finally {
      await store.releaseCapHold(held.holdId);
    }
  };
  const out = await n(20, build);
  assert.equal(out.filter((x) => x === "created").length, 1, out.join(","));
  assert.equal(out.filter((x) => x === "consumed").length, 19);
  assert.equal((await store.list("transfers")).filter((t) => t.quoteId === quote.id).length, 1);
  assert.equal(await store.heldEurToday(u), 0, "no hold outlives its build");
  assert.equal(await safeFundedEurToday(u), quote.sendEur);
});

await check("UNIQUE(transfers.quote_id): two rows for one quote in parallel, one lands", async () => {
  const u = await user();
  const quoteId = `q_${randomUUID()}`;
  const out = await n(2, async () => store.addTransfer(transferRow(u, { quoteId })).then(() => "ok", (e: Error) => e.message));
  assert.equal(out.filter((x) => x === "ok").length, 1, out.join(" | "));
  assert.match(out.find((x) => x !== "ok")!, /duplicate key/);
});

await check("two transfers each at the full cap, in parallel: one passes", async () => {
  const u = await user();
  const race = async () => {
    const held = await store.holdDailyCap(u, FX.DAILY_CAP_EUR, FX.DAILY_CAP_EUR, async () => await safeFundedEurToday(u));
    if (!held.ok) return false;
    await new Promise((r) => setTimeout(r, 20)); // the partner calls between hold and row
    await store.addTransferUnderHold(transferRow(u, { sendEur: FX.DAILY_CAP_EUR }), held.holdId);
    return true;
  };
  assert.deepEqual((await n(2, race)).sort(), [false, true]);
  assert.equal(await safeFundedEurToday(u), FX.DAILY_CAP_EUR);
});

await check("a quote past expires_at but still OPEN is not consumed, and its expiry never overwrites a consumed one", async () => {
  const u = await user();
  const late = { id: `q_${randomUUID()}`, userId: u, rail: "sepa", sendEur: 5, status: "OPEN", expiresAt: new Date(Date.now() - 1).toISOString(), createdAt: now() } as any;
  await store.addQuote(late);
  assert.equal(await store.consumeQuote(late.id), false);
  const live = { ...late, id: `q_${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await store.addQuote(live);
  // A consume and the route's expiry write racing: CONSUMED or EXPIRED, never consumed-then-expired.
  const [consumed, expired] = await Promise.all([store.consumeQuote(live.id), store.expireQuote(live.id)]);
  assert.notEqual(consumed, expired, "exactly one of them wrote");
  assert.equal((await store.findQuote(live.id))?.status, consumed ? "CONSUMED" : "EXPIRED");
});

await check("an expired hold leaves the cap free", async () => {
  const u = await user();
  const held = await store.holdDailyCap(u, FX.DAILY_CAP_EUR, FX.DAILY_CAP_EUR, async () => await safeFundedEurToday(u));
  assert.ok(held.ok);
  assert.equal(await store.heldEurToday(u), FX.DAILY_CAP_EUR);
  await rowsOf.query("UPDATE cap_holds SET expires_at = now() - interval '1 second' WHERE id = $1", [held.holdId]);
  assert.equal(await store.heldEurToday(u), 0, "a hold past its expiry is not counted");
  assert.ok((await store.holdDailyCap(u, FX.DAILY_CAP_EUR, FX.DAILY_CAP_EUR, async () => await safeFundedEurToday(u))).ok);
});

await check("a late PAID racing a sweep REFUNDED: one final state, and the other write keeps its other fields", async () => {
  const u = await user();
  const t = transferRow(u, { state: "SUBMITTED" });
  await store.addTransfer(t);
  await Promise.all([
    store.updateTransfer(t.id, { state: "PAID", paidAt: now() } as any),
    store.updateTransfer(t.id, { state: "REFUNDED", refundedAt: now() } as any),
  ]);
  const after = (await store.findTransfer(t.id)) as any;
  assert.ok(["PAID", "REFUNDED"].includes(after.state));
  assert.ok(after.paidAt && after.refundedAt, "both writes' other fields are kept");
});

await check("an executor append and a compensator append on one transfer, in parallel: both steps survive", async () => {
  const u = await user();
  const t = transferRow(u, { state: "DEBITED", txs: [{ step: "safe.debit", hash: hex(32) }] });
  await store.addTransfer(t);
  const stale = (await store.findTransfer(t.id))!.txs;
  for (let i = 0; i < 5; i++) {
    const a = { step: `executor.intent.${i}`, at: now() } as any;
    const b = { step: `compensator.refund.${i}`, at: now() } as any;
    await Promise.all([store.appendTransferStep(t.id, a), store.updateTransfer(t.id, { txs: [...stale, b] })]);
  }
  const steps = (await store.findTransfer(t.id))!.txs.map((s) => s.step);
  assert.equal(steps[0], "safe.debit");
  for (let i = 0; i < 5; i++) {
    assert.equal(steps.filter((s) => s === `executor.intent.${i}`).length, 1, steps.join(","));
    assert.equal(steps.filter((s) => s === `compensator.refund.${i}`).length, 1, steps.join(","));
  }
  assert.equal(steps.length, 11);
});

await check("crypto send: parallel submits of one send, one claims; parallel sends at the cap from one org Safe, one holds", async () => {
  const u = await user();
  const send = { id: `cs_${randomUUID()}`, userId: u, state: "CREATED", deadline: Math.floor(Date.now() / 1000) + 600, createdAt: now(), updatedAt: now() } as any;
  const held = await store.holdDailyCap(u, 1, FX.DAILY_CAP_EUR, async () => 0);
  assert.ok(held.ok);
  await store.addCryptoSendUnderHold(send, held.holdId);
  assert.equal((await n(10, () => store.claimCryptoSend(send.id))).filter(Boolean).length, 1);
  assert.equal((await store.findCryptoSend(send.id))?.state, "SUBMITTED");
  const capKey = `orgsafe:${hex(20).toLowerCase()}`;
  const holds = await n(5, () => store.holdDailyCap(capKey, FX.DAILY_CAP_EUR, FX.DAILY_CAP_EUR, async () => await store.heldEurToday(capKey)));
  assert.equal(holds.filter((h) => h.ok).length, 1);
});

await check("org Safe op queue: two owners signing at once both land; one owner twice lands once; two relays, one claims", async () => {
  const op = { id: `so_${randomUUID()}`, orgId: "org_q", state: "PENDING", signatures: [], dropped: [], createdAt: now(), updatedAt: now() } as any;
  await store.addSafeOp(op);
  const sig = (memberId: string, ownerAddress: string) => ({ memberId, ownerAddress, signature: "0x", signedAt: now() }) as any;
  const [a, b] = await Promise.all([store.addSafeOpSignature(op.id, sig("m1", hex(20))), store.addSafeOpSignature(op.id, sig("m2", hex(20)))]);
  assert.ok(a && b);
  const owner = hex(20);
  assert.equal((await n(5, () => store.addSafeOpSignature(op.id, sig("m3", owner)))).filter(Boolean).length, 1);
  assert.equal((await store.findSafeOp(op.id))?.signatures.length, 3);
  assert.equal((await n(5, () => store.claimSafeOpRelay(op.id))).filter(Boolean).length, 1);
});

await check("draft payments: two parallel executes of one reviewed draft, one claims", async () => {
  const d = { id: `dr_${randomUUID()}`, orgId: "org_q", state: "REVIEWED", lines: [], activity: [], createdAt: now(), updatedAt: now() } as any;
  await store.addDraft(d);
  assert.equal((await n(5, () => store.claimDraftExecution(d.id, ["REVIEWED"], d.updatedAt))).filter(Boolean).length, 1);
});

await check("payment request paid: one Monerium order recorded by two pollers in parallel, one payment, the PAID hook once", async () => {
  const address = hex(20);
  const u = await user({ address, iban: "EE382200221020145685" });
  const code = "ABCDE12345FGHJK";
  const r = {
    id: `pr_${randomUUID()}`, userId: u, code, amountEur: 40, description: "x", methods: ["bank"], state: "OPEN", payments: [], quotes: [],
    source: { kind: "app" }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now(), updatedAt: now(),
  } as any;
  await store.addPaymentRequest(r);
  let fired = 0;
  routes.onPaymentRequestPaid(async (p) => {
    if (p.id === r.id) fired++;
  });
  const order = { id: `ord-${randomUUID()}`, kind: "issue", amount: "40", address, memo: `${code} thanks`, meta: { state: "processed", processedAt: now() } };
  await n(4, () => routes.attributeMoneriumOrder(order));
  await new Promise((res) => setTimeout(res, 50)); // hooks run after the commit
  const after = (await store.findPaymentRequest(r.id))!;
  assert.equal(after.state, "PAID");
  assert.equal(after.payments.length, 1, JSON.stringify(after.payments));
  assert.equal(fired, 1, "the PAID hook fires once");
  // A second payment kind for the same money merges on the locked row, whoever writes first.
  assert.equal(applyPayment(after, { method: "bank", ref: `monerium:${order.id}`, amountEur: 40, kind: "full", at: now() } as any).added, false);
});

await check("invoice paid: the poller and a webhook settle one order in parallel, one settlement", async () => {
  const inv = { id: `inv_${randomUUID()}`, orgId: "org_q", direction: "outgoing", state: "SUBMITTED", linkTokenHash: randomUUID(), lines: [], currency: "EUR", total: "10.00", createdByMemberId: "m", createdAt: now(), updatedAt: now() } as any;
  await store.addInvoice(inv);
  const settlement = { method: "bank", orderId: "ord-inv", amountEur: 10, at: now() } as any;
  const { settlementRef } = await import("../services/api/src/domain/invoices.js");
  const ref = settlementRef(settlement);
  await n(6, () => store.settleInvoice(inv.id, ref, (row: any) => ({ settlements: [...(row.settlements ?? []), settlement], state: "PAID" })));
  assert.equal((await store.findInvoice(inv.id))!.settlements?.length, 1);
});

await check("ledger: two writers adding one statement line in parallel, one row (UNIQUE(org_id, statement key))", async () => {
  const line = (id: string) => ({ id, orgId: "org_led", statement: { key: "k-same", valueDate: "2026-11-26", counterparty: { name: "n" } }, createdAt: now() }) as any;
  const out = await n(2, (i) => store.addLedgerEntries([line(`le_${i}_${randomUUID()}`)]).then(() => "ok", (e: Error) => e.message));
  assert.equal(out.filter((x) => x === "ok").length, 1, out.join(" | "));
  assert.equal((await store.ledgerOf("org_led")).length, 1);
});

await check("Monerium order dedupe: the poller and two webhook deliveries of one order in parallel, one recorded, one issue record", async () => {
  const address = hex(20);
  await user({ address, funding: { status: "active" } });
  const id = randomUUID();
  orders.set(id, { id, kind: "issue", chain: "base", currency: "eur", amount: "12.5", address, memo: "rent", meta: { state: "processed", processedAt: now() }, counterpart: { details: { name: "Payer" } } });
  const [hookA, hookB, polled] = await Promise.all([
    handleWebhookEvent({ data: { id } }).then((r) => r.outcome),
    handleWebhookEvent({ data: { id } }).then((r) => r.outcome),
    pollDepositsOnce(),
  ]);
  const recorded = [hookA, hookB].filter((o) => o === "recorded").length + polled;
  assert.equal(recorded, 1, `${hookA}, ${hookB}, poll recorded ${polled}`);
  assert.ok([hookA, hookB].every((o) => ["recorded", "duplicate", "unavailable"].includes(o)), `${hookA}, ${hookB}`);
  // A second process past `recording` (in memory) meets the order id's key:
  // the claim and the issue record are one transaction, refused whole.
  const second = await n(3, () =>
    store.tx(async () => {
      if (!(await store.markOrderProcessed(id))) return false;
      throw new Error("claimed twice");
    }),
  );
  assert.deepEqual(second, [false, false, false]);
  assert.equal((await store.list("moneriumIssueOrders")).filter((x) => x.orderId === id).length, 1, "one issue record");
  assert.equal((await store.list("processedMoneriumOrders")).filter((x) => x === id).length, 1);
  // A retry of a delivery answered `unavailable` finds it recorded.
  assert.equal((await handleWebhookEvent({ data: { id } })).outcome, "duplicate");
  orders.delete(id);
});

await check("Monerium webhook dedupe: two deliveries of one id marked in parallel, one marks it", async () => {
  const id = `wh-${randomUUID()}`;
  assert.equal((await n(5, () => store.markWebhookProcessed(id))).filter(Boolean).length, 1);
});

await check("Shopify delivery dedupe: one id twice in parallel, one row; the same order id from two shops, two requests", async () => {
  const id = `d-${randomUUID()}`;
  const seen = await Promise.all(["a.myshopify.com", "b.myshopify.com"].map((shop) => store.recordShopifyDelivery({ id, shop, at: now(), handled: false })));
  assert.equal(seen[0].shop, seen[1].shop, "both read the row recorded first, so the other shop is refused");
  const u = await user();
  const req = (shop: string) =>
    ({ id: `pr_${randomUUID()}`, userId: u, code: randomUUID().replace(/-/g, "").slice(0, 15).toUpperCase(), amountEur: 1, methods: ["bank"], state: "OPEN", payments: [], quotes: [], source: { kind: "shopify", shop, externalId: "gid://shopify/Order/1" }, expiresAt: now(), createdAt: now(), updatedAt: now() }) as any;
  const same = await n(2, () => store.addPaymentRequest(req("a.myshopify.com")).then(() => "ok", (e: Error) => e.message));
  assert.equal(same.filter((x) => x === "ok").length, 1, same.join(" | "));
  await store.addPaymentRequest(req("b.myshopify.com"));
  assert.ok(await store.findPaymentRequestBySource("shopify", "gid://shopify/Order/1", "b.myshopify.com"));
});

await check("crypto deposits: overlapping scans of one window, one row; the same log on another chain is its own", async () => {
  const u = await user();
  const d = { userId: u, chainId: 84532, token: "EURE", txHash: hex(32), logIndex: 1, amountUnits: "1", holding: "none", txs: [], createdAt: now(), updatedAt: now() };
  const rows = await n(6, (i) => store.addCryptoDeposit({ ...d, id: `dep_${i}_${randomUUID()}` } as any));
  assert.equal(new Set(rows.map((r) => r.id)).size, 1);
  assert.ok(await store.findCryptoDeposit(84532, d.txHash, 1));
  assert.equal(await store.findCryptoDeposit(8453, d.txHash, 1), undefined);
});

await check("passkey sign count: counts 5 and 6 recorded in parallel leave 6; a recovery's new passkey is never overwritten by an old assertion", async () => {
  const u = await user({ passkey: { credentialId: `cred-${randomUUID()}`, signCount: 1, createdAt: now() } });
  const cred = (await store.findUser(u))!.passkey!.credentialId;
  for (let i = 0; i < 5; i++) {
    const base = 10 * (i + 1);
    await Promise.all([store.recordPasskeyUse(u, cred, base + 6), store.recordPasskeyUse(u, cred, base + 5)]);
    assert.equal((await store.findUser(u))!.passkey!.signCount, base + 6, "the stored count never goes back");
  }
  const fresh = { credentialId: `cred-new-${randomUUID()}`, signCount: 0, createdAt: now() };
  const [recorded] = await Promise.all([store.recordPasskeyUse(u, cred, 99), store.updateUser(u, { passkey: fresh } as any)]);
  assert.equal((await store.findUser(u))!.passkey!.credentialId, fresh.credentialId, "the new passkey stays");
  if (recorded) assert.equal(recorded.passkey?.credentialId, cred, "an assertion that landed first was on the old passkey");
});

await check("one Safe, two accounts: three adds of one company Safe in parallel, one account", async () => {
  const address = hex(20);
  const acc = (orgId: string) => ({ id: `acc_${randomUUID()}`, orgId, currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: {}, address, createdAt: now(), updatedAt: now() }) as any;
  const out = await Promise.all([store.addAccount(acc("org_x1")), store.addAccount(acc("org_x2")), store.addAccount(acc("org_x3"))]);
  assert.equal(out.filter(Boolean).length, 1);
  assert.equal((await store.accountsAtAddress(address)).length, 1);
});

await check("one Zoldenburg grace period per user: two requests moved into it in parallel, one lands", async () => {
  const u = await user();
  const rr = (id: string) => ({ id, userId: u, mode: "zoldenburg", status: "REVIEW_PENDING", requestedAt: now(), expiresAt: now() }) as any;
  const ids = [`rr_${randomUUID()}`, `rr_${randomUUID()}`];
  for (const id of ids) await store.addRecoveryRequest(rr(id));
  const out = await Promise.all(ids.map((id) => store.updateRecoveryRequestFrom(id, ["REVIEW_PENDING"], { status: "GRACE_PERIOD" }).then(() => "ok", (e: Error) => e.message)));
  assert.equal(out.filter((x) => x === "ok").length, 1, out.join(" | "));
  assert.equal((await store.recoveryRequestsForUser(u)).filter((r) => r.status === "GRACE_PERIOD").length, 1);
});

await check("lock_timeout: a transaction waiting past it for a row fails instead of queueing behind it", async () => {
  const u = await user();
  const { LOCK_TIMEOUT } = await import("../services/api/src/store/pg/sql.js");
  assert.equal(LOCK_TIMEOUT, "10s");
  // A session that holds the user's row and never commits, as a stuck one would.
  const holder = await rowsOf.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SET LOCAL lock_timeout = 0");
    await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u]);
    const started = Date.now();
    await assert.rejects(store.updateUser(u, { name: "late" }), /lock timeout/);
    const waited = Date.now() - started;
    assert.ok(waited >= 9_000 && waited < 20_000, `waited ${waited} ms`);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.equal((await store.updateUser(u, { name: "after" })).name, "after");
});

await rowsOf.end();
await store.close();
monerium.close();
if (failed) {
  console.error(`\nPG CONCURRENCY TEST FAILED — ${failed}`);
  process.exit(1);
}
console.log("\nPG CONCURRENCY TEST PASSED");
