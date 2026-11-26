/**
 * The one way out of MANUAL_REVIEW: an operator's recorded decision.
 *
 * MANUAL_REVIEW is final for every automatic path (store.updateTransfer
 * refuses to move it). An operator who has checked the chain or the partner
 * and acted there records the outcome through
 * POST /api/admin/transfers/:id/resolve-review. The route moves no money; it
 * records who decided what, when, and why, and audits it. A resolved
 * transfer is never compensated or moved again by an automatic path.
 *
 * Offline: in-process express and a throwaway db.  npm run review-resolution:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-review-")), "db.json");
// App credentials, so an unrecorded redeem order can be re-read from the
// Monerium stub below (globalThis.fetch).
process.env.MONERIUM_BASE_URL = "https://api.monerium.app";
process.env.MONERIUM_CLIENT_ID = "review-test-client";
process.env.MONERIUM_CLIENT_SECRET = "review-test-secret";
process.env.MONERIUM_CHAIN = "base";
/** Stands for the operator in `post`: the change goes through the kit. */
const OPERATOR = "operator";

const { initStore, store } = await import("../services/api/src/store.js");
const { createAdminRouter } = await import("../services/api/src/routes/admin.js");
const { createOperatorGate } = await import("../services/api/src/operators/gate.js");
const { createOperatorAuthRouter } = await import("../services/api/src/routes/operator-auth.js");
const { OPERATOR: OPERATOR_CONFIG, SECURITY } = await import("../services/api/src/config.js");
const { operatorKit } = await import("./_operator.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { strandedAction, compensateTransfer, DEBIT_STEP } = await import("../services/api/src/orchestrator.js");
const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
const { moneriumAmountString, paymentMemo } = await import("../services/api/src/sepa.js");

await initStore();
const now = new Date().toISOString();
await store.addUser({ id: "u_review", name: "Review User", country: "DE", address: `0x${"22".repeat(20)}`, createdAt: now } as any);
async function row(id: string, state: string) {
  await store.addTransfer({
    id, userId: "u_review", quoteId: `q-${id}`, rail: "sepa", recipientName: "Payee", state, sendEur: 10,
    receiveEur: 9, fundingSource: "safe", txs: [{ step: DEBIT_STEP.safeFee, hash: `0x${"11".repeat(32)}` }],
    error: "redeem order outcome unknown: socket hang up", createdAt: now, updatedAt: now,
  } as any);
}
await row("t_review", "MANUAL_REVIEW");
await row("t_review2", "MANUAL_REVIEW");
await row("t_failed", "FAILED");
await row("t_paid", "MANUAL_REVIEW");
await store.updateTransfer("t_paid", {
  txs: [...(await store.findTransfer("t_paid"))!.txs, { step: "monerium.redeem.pending", hash: "0x" }, { step: "monerium.redeem.placed", hash: "ord-abc-123" }],
  sepa: { mode: "sandbox", orderId: "ord-abc-123", state: "pending" },
});
await row("t_paid_none", "MANUAL_REVIEW");
// Hashes already on record somewhere the statement books from.
const DEPOSIT_TX = `0x${"d1".repeat(32)}`;
const DEPOSIT_CONVERSION_TX = `0x${"d2".repeat(32)}`;
const DEPOSIT_STEP_TX = `0x${"d3".repeat(32)}`;
const SWEEP_TX = `0x${"e1".repeat(32)}`;
const SWEEP_CONVERSION_TX = `0x${"e2".repeat(32)}`;
const OTHER_TRANSFER_TX = `0x${"f1".repeat(32)}`;
const FRESH_TX = `0x${"c0".repeat(32)}`;
await store.addCryptoDeposit({
  id: "dep_other", userId: "u_someone_else", chainId: 31337, token: "EURE", txHash: DEPOSIT_TX, logIndex: 0, amountEur: 5,
  from: `0x${"33".repeat(20)}`, holding: "none", settledAt: now, detectedAt: now,
  conversion: { txHash: DEPOSIT_CONVERSION_TX }, txs: [{ step: "swap", hash: DEPOSIT_STEP_TX }],
} as any);
await store.addConversionSweep({
  id: "sweep_other", userId: "u_someone_else", createdAt: now,
  conversion: { txHash: SWEEP_CONVERSION_TX }, txs: [{ step: "sweep", hash: SWEEP_TX }],
} as any);
await row("t_other", "PAID");
await store.updateTransfer("t_other", { txs: [{ step: "safe.refundTransfer", hash: OTHER_TRANSFER_TX }] });
for (const id of ["t_ref_1", "t_ref_2"]) await row(id, "MANUAL_REVIEW");
// The operator's refund, already seen by the deposit scanner as a plain EURe
// arrival into this user's Safe.
const ARRIVED_REFUND_TX = `0x${"a7".repeat(32)}`;
await row("t_ref_3", "MANUAL_REVIEW");
await store.addCryptoDeposit({
  id: "dep_refund", userId: "u_review", chainId: 31337, token: "EURE", txHash: ARRIVED_REFUND_TX, logIndex: 0, amountEur: 1,
  from: `0x${"44".repeat(20)}`, holding: "none", settledAt: now, detectedAt: now, txs: [],
} as any);
const DEST_TX = `0x${"de".repeat(32)}`;
await row("t_bridge_plan", "MANUAL_REVIEW");
await store.updateTransfer("t_bridge_plan", { pickup: { bridgeDestinationTxHash: DEST_TX } as any });
await row("t_bridge_done", "MANUAL_REVIEW");
await store.updateTransfer("t_bridge_done", {
  txs: [...(await store.findTransfer("t_bridge_done"))!.txs, { step: "bridge.xyz.destination_tx", hash: DEST_TX }],
});

// Transfers whose redeem order is at Monerium but not on the transfer: the
// order placement's answer was lost, so the transfer went to review.
const SAFE = `0x${"22".repeat(20)}`;
const IBAN = "DE89370400440532013000";
async function sepaRow(id: string, memo = paymentMemo(id, "Invoice 42")) {
  await row(id, "MANUAL_REVIEW");
  await store.updateTransfer(id, {
    recipientIban: IBAN, reference: "Invoice 42",
    moneriumRedeem: { amount: moneriumAmountString(9), iban: IBAN, issuedAt: now, message: "m", memo, signature: "0x01" },
    txs: [...(await store.findTransfer(id))!.txs, { step: "monerium.redeem.pending", hash: "0x" }],
  } as any);
}
await sepaRow("t_attach");
await sepaRow("t_attach_bad");
await sepaRow("t_attach_flaky");
// An older transfer: its signed memo carries the full transfer id.
await sepaRow("t_attach_legacy", "Powered by Zold t_attach_legacy");
await row("t_owns_order", "PAYOUT_SUBMITTED");
await store.updateTransfer("t_owns_order", { sepa: { mode: "sandbox", orderId: "ord-taken", state: "processed" } });
// The other two ways a transfer owns an order: an operator's PAID evidence,
// and a placed step without a recorded order.
await row("t_owns_evidence", "MANUAL_REVIEW");
await store.updateTransfer("t_owns_evidence", { reviewResolution: { state: "PAID", note: "n", by: "op", at: now, evidence: "ord-taken-evidence" } } as any);
await row("t_owns_placed", "MANUAL_REVIEW");
await store.updateTransfer("t_owns_placed", { txs: [...(await store.findTransfer("t_owns_placed"))!.txs, { step: "monerium.redeem.placed", hash: "ord-taken-placed" }] });
/** The redeem order Monerium holds for `transferId`, processed. */
function redeemOrder(id: string, transferId: string, patch: Record<string, unknown> = {}) {
  return {
    id, kind: "redeem", amount: "9", currency: "eur", address: SAFE, chain: "base", state: "processed",
    meta: { state: "processed" }, memo: paymentMemo(transferId, "Invoice 42"),
    counterpart: { identifier: { standard: "iban", iban: "DE89 3704 0044 0532 0130 00" }, details: { name: "Payee" } },
    ...patch,
  };
}
const ORDERS: Record<string, unknown> = {
  "ord-attach": redeemOrder("ord-attach", "t_attach"),
  "ord-pending": redeemOrder("ord-pending", "t_attach_bad", { state: "pending", meta: { state: "pending" } }),
  "ord-placed": redeemOrder("ord-placed", "t_attach_bad", { state: "placed", meta: { state: "placed" } }),
  "ord-memo": redeemOrder("ord-memo", "t_attach_bad", { memo: paymentMemo("t_other", "Invoice 42") }),
  "ord-no-memo": redeemOrder("ord-no-memo", "t_attach_bad", { memo: undefined }),
  "ord-legacy": redeemOrder("ord-legacy", "t_attach_legacy", { memo: "Powered by Zold t_attach_legacy" }),
  "ord-amount": redeemOrder("ord-amount", "t_attach_bad", { amount: "9.01" }),
  "ord-iban": redeemOrder("ord-iban", "t_attach_bad", { counterpart: { identifier: { standard: "iban", iban: "DE02120300000000202051" } } }),
  "ord-safe": redeemOrder("ord-safe", "t_attach_bad", { address: `0x${"33".repeat(20)}` }),
  "ord-chain": redeemOrder("ord-chain", "t_attach_bad", { chain: "gnosis" }),
  "ord-issue": redeemOrder("ord-issue", "t_attach_bad", { kind: "issue" }),
  "ord-currency": redeemOrder("ord-currency", "t_attach_bad", { currency: "usd" }),
  "ord-id": redeemOrder("ord-other-id", "t_attach_bad"),
  "ord-taken": redeemOrder("ord-taken", "t_attach_bad"),
  // Each matches t_attach_bad in full, so only the ownership check refuses it.
  "ord-taken-evidence": redeemOrder("ord-taken-evidence", "t_attach_bad"),
  "ord-taken-placed": redeemOrder("ord-taken-placed", "t_attach_bad"),
  "ord-auth": redeemOrder("ord-auth", "t_attach_bad"),
  "ord-forbidden": redeemOrder("ord-forbidden", "t_attach_bad"),
  "ord-flaky": redeemOrder("ord-flaky", "t_attach_flaky"),
};
/** Order reads still to fail, by id, with the status to answer. */
const FAULTS: Record<string, number[]> = { "ord-flaky": [503, 429], "ord-auth": [401], "ord-forbidden": [403] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input?.url ?? input));
  if (url.hostname !== "api.monerium.app") return realFetch(input, init);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/auth/token") return json({ access_token: "review-token", expires_in: 3600 });
  const m = /^\/orders\/([^/]+)$/.exec(url.pathname);
  if (!m || (init?.method ?? "GET") !== "GET") return json({}, 500);
  const id = decodeURIComponent(m[1]);
  const fault = FAULTS[id]?.shift();
  if (fault) return json({ errors: "unavailable" }, fault);
  return ORDERS[id] ? json(ORDERS[id]) : json({ errors: "not found" }, 404);
}) as typeof fetch;

const app = express();
app.use(express.json());
app.use("/api/admin", createOperatorGate());
app.use("/api", createOperatorAuthRouter());
app.use("/api", createAdminRouter());
// The session is not under test here: every request is the owner.
app.use("/api", createTransferRouter({ requireUserSession: async () => true }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const kit = await operatorKit({ base: API, origin: OPERATOR_CONFIG.adminOrigin, rpId: SECURITY.rpId, dataDir: path.dirname(process.env.TRANSF_DB_PATH!) });
const post = async (id: string, body: unknown, token: string | null = OPERATOR) => {
  // The operator's change goes through a passkey session and a fresh approval;
  // any other bearer is sent as given.
  if (token === OPERATOR) return kit.call("POST", `/api/admin/transfers/${id}/resolve-review`, body);
  const res = await fetch(`${API}/api/admin/transfers/${id}/resolve-review`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const NOTE = "Checked Monerium: order o-123 was never placed; fee returned by hand in tx 0xabc.";

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`FAIL  ${name}\n      ${(err as Error).message}`); }
}

try {
  await check("store.updateTransfer still refuses to move MANUAL_REVIEW", async () => {
    await store.updateTransfer("t_review", { state: "REFUNDED" });
    assert.equal((await store.findTransfer("t_review"))!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses without an operator session", async () => {
    assert.equal((await post("t_review", { state: "REFUNDED", note: NOTE }, null)).status, 401);
    assert.equal((await post("t_review", { state: "REFUNDED", note: NOTE }, "wrong-token-of-sufficient-length-000000")).status, 401);
    assert.equal((await store.findTransfer("t_review"))!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses without a note, or with a short one", async () => {
    assert.equal((await post("t_review", { state: "REFUNDED" })).status, 400);
    assert.equal((await post("t_review", { state: "REFUNDED", note: "done" })).status, 400);
    assert.equal((await store.findTransfer("t_review"))!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses a state outside REFUNDED, PAID, FAILED", async () => {
    for (const state of ["MANUAL_REVIEW", "CREATED", "DEBITED", "", undefined]) {
      assert.equal((await post("t_review", { state, note: NOTE })).status, 400, String(state));
    }
  });

  await check("the route refuses a transfer that is not in review, and an unknown one", async () => {
    assert.equal((await post("t_failed", { state: "REFUNDED", note: NOTE })).status, 409);
    assert.equal((await store.findTransfer("t_failed"))!.state, "FAILED");
    assert.equal((await post("t_nope", { state: "REFUNDED", note: NOTE })).status, 404);
  });

  const REFUND_TX = `0x${"ab".repeat(32)}`;
  await check("REFUNDED needs the refunded amount and evidence", async () => {
    for (const body of [
      { state: "REFUNDED", note: NOTE, evidence: REFUND_TX },
      { state: "REFUNDED", note: NOTE, evidence: REFUND_TX, amountEur: "1" },
      { state: "REFUNDED", note: NOTE, evidence: REFUND_TX, amountEur: -1 },
      { state: "REFUNDED", note: NOTE, evidence: REFUND_TX, amountEur: Number.NaN },
      { state: "REFUNDED", note: NOTE, evidence: REFUND_TX, amountEur: 1.01 },
      { state: "REFUNDED", note: NOTE, amountEur: 1 },
    ]) {
      const r = await post("t_review", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await store.findTransfer("t_review"))!.state, "MANUAL_REVIEW");
  });

  await check("MANUAL_REVIEW moves to the chosen state with the resolution and an audit entry", async () => {
    const r = await post("t_review", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: REFUND_TX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = (await store.findTransfer("t_review"))! as any;
    assert.equal(t.state, "REFUNDED");
    assert.equal(t.reviewResolution.state, "REFUNDED");
    assert.equal(t.reviewResolution.note, NOTE);
    assert.equal(t.reviewResolution.by, `operator:${kit.operator.id}`);
    assert.equal(t.reviewResolution.previousError, "redeem order outcome unknown: socket hang up");
    assert.ok(Date.parse(t.reviewResolution.at));
    const entry = (await store.auditFor("u_review")).find((e: any) => e.kind === "operator.transfer_review_resolved") as any;
    assert.ok(entry, "no audit entry");
    assert.equal(entry.data.transferId, "t_review");
    assert.equal(entry.data.from, "MANUAL_REVIEW");
    assert.equal(entry.data.to, "REFUNDED");
    assert.equal(entry.data.note, NOTE);
  });

  await check("no user-facing transfer route carries the operator's resolution", async () => {
    const get = async (p: string) => {
      const res = await fetch(`${API}/api${p}`);
      assert.equal(res.status, 200, p);
      return res.json();
    };
    const bodies = [
      await get("/transfers/t_review"),
      await get("/users/u_review/transfers"),
      await get("/users/u_review/activity"),
    ];
    for (const b of bodies) {
      const text = JSON.stringify(b);
      assert.ok(text.includes("t_review"), "the transfer is listed");
      assert.ok(!text.includes("reviewResolution"), `reviewResolution leaked: ${text.slice(0, 200)}`);
      assert.ok(!text.includes(NOTE), "the operator note leaked");
      assert.ok(!text.includes("operator:"), "the operator label leaked");
      assert.ok(!text.includes("previousError"), "previousError leaked");
    }
  });

  await check("an operator's REFUNDED records the refund and the statement books it", async () => {
    const t = (await store.findTransfer("t_review"))!;
    assert.deepEqual(
      { amountEur: t.refund?.amountEur, recoveredFrom: t.refund?.recoveredFrom, deductions: t.refund?.deductions },
      { amountEur: 1, recoveredFrom: "operator-resolved", deductions: "none" },
    );
    assert.ok(Date.parse(t.refund!.at));
    assert.equal((t as any).reviewResolution.evidence, REFUND_TX);
    const lines = projectStatementLines({
      orgId: "o_review", accountId: "a_review", userId: "u_review", safeAddress: `0x${"22".repeat(20)}`, timeZone: "UTC",
      transfers: [t], deposits: [], issueOrders: [], sweeps: [], invoices: [], paymentRequests: [], swapsHaveExecuted: false,
    });
    const refund = lines.find((l: any) => l.statementKey === "transfer:t_review:refund" || l.key === "transfer:t_review:refund" || JSON.stringify(l).includes("transfer:t_review:refund"));
    assert.ok(refund, `no refund line: ${JSON.stringify(lines).slice(0, 300)}`);
    assert.ok(JSON.stringify(refund).includes(REFUND_TX), "the refund line links the operator's refund tx");
  });

  await check("PAID needs the evidence the payout went out", async () => {
    const none = await post("t_paid", { state: "PAID", note: NOTE });
    assert.equal(none.status, 409, JSON.stringify(none.body));
    assert.match(String(none.body.error), /evidence/i);
    const wrong = await post("t_paid", { state: "PAID", note: NOTE, evidence: "ord-not-ours" });
    assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
    assert.equal((await store.findTransfer("t_paid"))!.state, "MANUAL_REVIEW");
    const unrecorded = await post("t_paid_none", { state: "PAID", note: NOTE, evidence: "ord-abc-123" });
    assert.equal(unrecorded.status, 409, "a transfer with no recorded payout cannot be marked PAID");
    assert.equal((await store.findTransfer("t_paid_none"))!.state, "MANUAL_REVIEW");
  });

  await check("a placed Monerium order that is not processed is no evidence of payout", async () => {
    const r = await post("t_paid", { state: "PAID", note: NOTE, evidence: "ord-abc-123" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(String(r.body.error), /processed/);
    assert.equal((await store.findTransfer("t_paid"))!.state, "MANUAL_REVIEW");
  });

  await check("a Bridge plan's destination hash is no evidence; the executed destination tx is", async () => {
    const plan = await post("t_bridge_plan", { state: "PAID", note: NOTE, evidence: DEST_TX });
    assert.equal(plan.status, 409, JSON.stringify(plan.body));
    assert.equal((await store.findTransfer("t_bridge_plan"))!.state, "MANUAL_REVIEW");
    const done = await post("t_bridge_done", { state: "PAID", note: NOTE, evidence: DEST_TX });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  });

  await check("PAID with the recorded order id resolves once Monerium processed it", async () => {
    await store.updateTransfer("t_paid", { sepa: { mode: "sandbox", orderId: "ord-abc-123", state: "processed" } });
    const r = await post("t_paid", { state: "PAID", note: NOTE, evidence: " ord-abc-123 " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = (await store.findTransfer("t_paid"))! as any;
    assert.equal(t.state, "PAID");
    assert.equal(t.reviewResolution.evidence, "ord-abc-123");
  });

  await check("PAID re-reads an unrecorded redeem order and refuses one that does not match this transfer", async () => {
    for (const [id, why] of [
      ["ord-pending", /not processed/], ["ord-placed", /not processed/], ["ord-memo", /memo/], ["ord-no-memo", /carries none/], ["ord-amount", /amount/],
      ["ord-iban", /IBAN/], ["ord-safe", /Safe address/], ["ord-chain", /chain/], ["ord-issue", /kind/],
      ["ord-currency", /currency/], ["ord-id", /order id/], ["ord-unknown", /no such order/], ["ord-taken", /another transfer/],
      ["ord-taken-evidence", /another transfer/], ["ord-taken-placed", /another transfer/],
      ["../orders", /not a Monerium order id/],
    ] as const) {
      const r = await post("t_attach_bad", { state: "PAID", note: NOTE, evidence: id });
      assert.equal(r.status, 409, `${id}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), why, id);
      const t = (await store.findTransfer("t_attach_bad"))! as any;
      assert.equal(t.state, "MANUAL_REVIEW", id);
      assert.ok(!t.reviewResolution, `${id}: resolved`);
      assert.ok(!t.sepa, `${id}: an order was attached`);
    }
    assert.equal((await store.findTransfer("t_owns_order"))!.sepa!.orderId, "ord-taken", "the owner keeps its order");
  });

  await check("a 403 on the order read says Monerium refused the read, not that the order is wrong; nothing changed", async () => {
    // A 403 can mean the account's token lacks the scope to read orders, so
    // it is not evidence that the cited order is someone else's.
    const r = await post("t_attach_bad", { state: "PAID", note: NOTE, evidence: "ord-forbidden" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(String(r.body.error), /Monerium refused this account's read of that order/);
    assert.equal(r.body.code, "MONERIUM_READ_REFUSED", "a tool tells it from the 409 for an order that is not this transfer's by code");
    assert.match(String(r.body.error), /check the connection or the order id/);
    assert.doesNotMatch(String(r.body.error), /not this transfer's/);
    const t = (await store.findTransfer("t_attach_bad"))! as any;
    assert.equal(t.state, "MANUAL_REVIEW");
    assert.ok(!t.reviewResolution && !t.sepa, "nothing was resolved or attached");
  });

  await check("no working Monerium connection is not answered Try again: 409 MONERIUM_NOT_CONNECTED, nothing changed", async () => {
    const u = (await store.findUser("u_review"))! as any;
    const own = u.monerium;
    const cases: Array<[string, string, () => Promise<unknown>]> = [
      // A connection that holds no credential: moneriumClientFor refuses before any request.
      ["no credential", "ord-unknown", () => store.updateUser(u.id, { monerium: { method: "oauth" } as any })],
      // Monerium refuses the account's token.
      ["a 401", "ord-auth", () => store.updateUser(u.id, { monerium: own })],
    ];
    try {
      for (const [label, id, arrange] of cases) {
        await arrange();
        const r = await post("t_attach_bad", { state: "PAID", note: NOTE, evidence: id });
        assert.equal(r.status, 409, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "MONERIUM_NOT_CONNECTED", label);
        assert.doesNotMatch(String(r.body.error), /try again/i, label);
        const t = (await store.findTransfer("t_attach_bad"))! as any;
        assert.equal(t.state, "MANUAL_REVIEW", label);
        assert.ok(!t.reviewResolution && !t.sepa, `${label}: the transfer changed`);
      }
    } finally {
      await store.updateUser(u.id, { monerium: own });
    }
  });

  await check("a failed order read is retryable and changes nothing; the retry attaches it", async () => {
    for (const status of [503, 429]) {
      const r = await post("t_attach_flaky", { state: "PAID", note: NOTE, evidence: "ord-flaky" });
      assert.equal(r.status, 503, `after ${status}: ${JSON.stringify(r.body)}`);
      const t = (await store.findTransfer("t_attach_flaky"))! as any;
      assert.equal(t.state, "MANUAL_REVIEW");
      assert.ok(!t.reviewResolution && !t.sepa, "a failed read changed the transfer");
    }
    const r = await post("t_attach_flaky", { state: "PAID", note: NOTE, evidence: "ord-flaky" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await store.findTransfer("t_attach_flaky"))!.state, "PAID");
  });

  await check("PAID attaches an older transfer's order that echoes the full-id memo it signed", async () => {
    const r = await post("t_attach_legacy", { state: "PAID", note: NOTE, evidence: "ord-legacy" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await store.findTransfer("t_attach_legacy"))!.state, "PAID");
  });

  await check("PAID attaches the processed redeem order Monerium holds for this transfer, then resolves", async () => {
    const r = await post("t_attach", { state: "PAID", note: NOTE, evidence: " ord-attach " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = (await store.findTransfer("t_attach"))! as any;
    assert.equal(t.state, "PAID");
    assert.equal(t.sepa.orderId, "ord-attach");
    assert.equal(t.sepa.state, "processed");
    assert.equal(t.reviewResolution.evidence, "ord-attach");
    const entry = (await store.auditFor("u_review")).find((e: any) => e.kind === "operator.transfer_review_resolved" && e.data.transferId === "t_attach");
    assert.ok(entry, "no audit entry");
    // Attached to one transfer, the order is no evidence for another.
    const again = await post("t_attach_bad", { state: "PAID", note: NOTE, evidence: "ord-attach" });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.match(String(again.body.error), /another transfer/);
    assert.equal((await store.findTransfer("t_attach_bad"))!.state, "MANUAL_REVIEW");
  });

  await check("a REFUNDED evidence hash already on record is refused", async () => {
    const own = (await store.findTransfer("t_ref_1"))!.txs[0].hash;
    for (const [label, hash] of [
      ["this transfer's own debit", own],
      ["another transfer's step", OTHER_TRANSFER_TX],
      ["another transfer's operator refund", `0x${"ab".repeat(32)}`],
      ["a deposit's tx", DEPOSIT_TX],
      ["a deposit's conversion tx", DEPOSIT_CONVERSION_TX],
      ["a deposit's step", DEPOSIT_STEP_TX],
      ["a sweep's step", SWEEP_TX],
      ["a sweep's conversion tx", SWEEP_CONVERSION_TX],
    ] as const) {
      const r = await post("t_ref_1", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: hash.toUpperCase().replace("0X", "0x") });
      assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), /already on record/, label);
      const t = (await store.findTransfer("t_ref_1"))!;
      assert.equal(t.state, "MANUAL_REVIEW", label);
      assert.ok(!t.refund, `${label}: a refund was written`);
    }
  });

  await check("a fresh REFUNDED hash is recorded as the operator's refund step; a reference is not", async () => {
    const fresh = await post("t_ref_1", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: FRESH_TX });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const t = (await store.findTransfer("t_ref_1"))!;
    assert.deepEqual(t.txs.filter((x) => x.step === "operator.refund").map((x) => x.hash), [FRESH_TX]);
    const reused = await post("t_ref_2", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: FRESH_TX });
    assert.equal(reused.status, 409, "the same hash on a second transfer");
    const ref = await post("t_ref_2", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: "Monerium ticket 4711" });
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    const t2 = (await store.findTransfer("t_ref_2"))! as any;
    assert.ok(!t2.txs.some((x: any) => x.step === "operator.refund"), "a reference became a tx step");
    assert.equal(t2.reviewResolution.evidence, "Monerium ticket 4711");
  });

  await check("the refund tx the deposit scanner already recorded for this user is accepted and booked once, as the reversal", async () => {
    const r = await post("t_ref_3", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: ARRIVED_REFUND_TX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = (await store.findTransfer("t_ref_3"))!;
    assert.deepEqual(t.txs.filter((x) => x.step === "operator.refund").map((x) => x.hash), [ARRIVED_REFUND_TX]);
    const dep = (await store.list("cryptoDeposits")).find((d: any) => d.id === "dep_refund");
    const lines = projectStatementLines({
      orgId: "o_review", accountId: "a_review", userId: "u_review", safeAddress: `0x${"22".repeat(20)}`, timeZone: "UTC",
      transfers: [t], deposits: [dep!], issueOrders: [], sweeps: [], invoices: [], paymentRequests: [], swapsHaveExecuted: false,
    });
    const citing = lines.filter((l: any) => JSON.stringify(l).includes(ARRIVED_REFUND_TX));
    assert.equal(citing.length, 1, `booked ${citing.length} times: ${JSON.stringify(citing).slice(0, 300)}`);
    assert.ok(JSON.stringify(citing[0]).includes("transfer:t_ref_3:refund"), "booked as the reversal, not as a deposit");
  });

  await check("a resolved transfer is resolved once", async () => {
    assert.equal((await post("t_review", { state: "PAID", note: NOTE })).status, 409);
    assert.equal((await store.findTransfer("t_review"))!.state, "REFUNDED");
  });

  await check("resolved FAILED is never compensated or moved by an automatic path", async () => {
    const r = await post("t_review2", { state: "FAILED", note: NOTE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = (await store.findTransfer("t_review2"))!;
    assert.equal(t.state, "FAILED");
    assert.equal(strandedAction(t, Date.now(), () => false), null, "the sweep would compensate it");
    const after = await compensateTransfer("t_review2");
    assert.equal(after.state, "FAILED");
    assert.ok(!after.refund, "compensation wrote a refund");
    await store.updateTransfer("t_review2", { state: "PAID" });
    assert.equal((await store.findTransfer("t_review2"))!.state, "FAILED");
  });
} finally {
  globalThis.fetch = realFetch;
  server.close();
}

if (failed) {
  console.error(`\nreview-resolution: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nreview-resolution: all checks passed");
