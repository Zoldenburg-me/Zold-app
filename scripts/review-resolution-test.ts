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
const OPERATOR = "operator-token-for-review-test-0123456789";
process.env.KYC_OPERATOR_TOKEN = OPERATOR;

const { initStore, store } = await import("../services/api/src/store.js");
const { createAdminRouter } = await import("../services/api/src/routes/admin.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { strandedAction, compensateTransfer, DEBIT_STEP } = await import("../services/api/src/orchestrator.js");
const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");

initStore();
const now = new Date().toISOString();
store.addUser({ id: "u_review", name: "Review User", country: "DE", address: `0x${"22".repeat(20)}`, createdAt: now } as any);
function row(id: string, state: string) {
  store.addTransfer({
    id, userId: "u_review", quoteId: `q-${id}`, rail: "sepa", recipientName: "Payee", state, sendEur: 10,
    receiveEur: 9, fundingSource: "safe", txs: [{ step: DEBIT_STEP.safeFee, hash: `0x${"11".repeat(32)}` }],
    error: "redeem order outcome unknown: socket hang up", createdAt: now, updatedAt: now,
  } as any);
}
row("t_review", "MANUAL_REVIEW");
row("t_review2", "MANUAL_REVIEW");
row("t_failed", "FAILED");
row("t_paid", "MANUAL_REVIEW");
store.updateTransfer("t_paid", {
  txs: [...store.findTransfer("t_paid")!.txs, { step: "monerium.redeem.pending", hash: "0x" }, { step: "monerium.redeem.placed", hash: "ord-abc-123" }],
  sepa: { mode: "sandbox", orderId: "ord-abc-123", state: "pending" },
});
row("t_paid_none", "MANUAL_REVIEW");

const app = express();
app.use(express.json());
app.use("/api", createAdminRouter());
// The session is not under test here: every request is the owner.
app.use("/api", createTransferRouter({ requireUserSession: () => true }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const post = async (id: string, body: unknown, token: string | null = OPERATOR) => {
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
  await check("store.updateTransfer still refuses to move MANUAL_REVIEW", () => {
    store.updateTransfer("t_review", { state: "REFUNDED" });
    assert.equal(store.findTransfer("t_review")!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses without the operator token", async () => {
    assert.equal((await post("t_review", { state: "REFUNDED", note: NOTE }, null)).status, 401);
    assert.equal((await post("t_review", { state: "REFUNDED", note: NOTE }, "wrong-token-of-sufficient-length-000000")).status, 401);
    assert.equal(store.findTransfer("t_review")!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses without a note, or with a short one", async () => {
    assert.equal((await post("t_review", { state: "REFUNDED" })).status, 400);
    assert.equal((await post("t_review", { state: "REFUNDED", note: "done" })).status, 400);
    assert.equal(store.findTransfer("t_review")!.state, "MANUAL_REVIEW");
  });

  await check("the route refuses a state outside REFUNDED, PAID, FAILED", async () => {
    for (const state of ["MANUAL_REVIEW", "CREATED", "DEBITED", "", undefined]) {
      assert.equal((await post("t_review", { state, note: NOTE })).status, 400, String(state));
    }
  });

  await check("the route refuses a transfer that is not in review, and an unknown one", async () => {
    assert.equal((await post("t_failed", { state: "REFUNDED", note: NOTE })).status, 409);
    assert.equal(store.findTransfer("t_failed")!.state, "FAILED");
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
    assert.equal(store.findTransfer("t_review")!.state, "MANUAL_REVIEW");
  });

  await check("MANUAL_REVIEW moves to the chosen state with the resolution and an audit entry", async () => {
    const r = await post("t_review", { state: "REFUNDED", note: NOTE, amountEur: 1, evidence: REFUND_TX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = store.findTransfer("t_review")! as any;
    assert.equal(t.state, "REFUNDED");
    assert.equal(t.reviewResolution.state, "REFUNDED");
    assert.equal(t.reviewResolution.note, NOTE);
    assert.match(t.reviewResolution.by, /^operator:[0-9a-f]{12}$/);
    assert.ok(!t.reviewResolution.by.includes(OPERATOR), "the token itself is never recorded");
    assert.equal(t.reviewResolution.previousError, "redeem order outcome unknown: socket hang up");
    assert.ok(Date.parse(t.reviewResolution.at));
    const entry = store.auditFor("u_review").find((e: any) => e.kind === "operator.transfer_review_resolved") as any;
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

  await check("an operator's REFUNDED records the refund and the statement books it", () => {
    const t = store.findTransfer("t_review")!;
    assert.deepEqual(
      { amountEur: t.refund?.amountEur, recoveredFrom: t.refund?.recoveredFrom, deductions: t.refund?.deductions },
      { amountEur: 1, recoveredFrom: "operator-resolved", deductions: "none" },
    );
    assert.ok(Date.parse(t.refund!.at));
    assert.equal((t as any).reviewResolution.evidence, REFUND_TX);
    const lines = projectStatementLines({
      orgId: "o_review", accountId: "a_review", userId: "u_review", safeAddress: `0x${"22".repeat(20)}`,
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
    assert.equal(store.findTransfer("t_paid")!.state, "MANUAL_REVIEW");
    const unrecorded = await post("t_paid_none", { state: "PAID", note: NOTE, evidence: "ord-abc-123" });
    assert.equal(unrecorded.status, 409, "a transfer with no recorded payout cannot be marked PAID");
    assert.equal(store.findTransfer("t_paid_none")!.state, "MANUAL_REVIEW");
  });

  await check("PAID with the recorded order id resolves and keeps the evidence", async () => {
    const r = await post("t_paid", { state: "PAID", note: NOTE, evidence: " ord-abc-123 " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = store.findTransfer("t_paid")! as any;
    assert.equal(t.state, "PAID");
    assert.equal(t.reviewResolution.evidence, "ord-abc-123");
  });

  await check("a resolved transfer is resolved once", async () => {
    assert.equal((await post("t_review", { state: "PAID", note: NOTE })).status, 409);
    assert.equal(store.findTransfer("t_review")!.state, "REFUNDED");
  });

  await check("resolved FAILED is never compensated or moved by an automatic path", async () => {
    const r = await post("t_review2", { state: "FAILED", note: NOTE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = store.findTransfer("t_review2")!;
    assert.equal(t.state, "FAILED");
    assert.equal(strandedAction(t, Date.now(), () => false), null, "the sweep would compensate it");
    const after = await compensateTransfer("t_review2");
    assert.equal(after.state, "FAILED");
    assert.ok(!after.refund, "compensation wrote a refund");
    store.updateTransfer("t_review2", { state: "PAID" });
    assert.equal(store.findTransfer("t_review2")!.state, "FAILED");
  });
} finally {
  server.close();
}

if (failed) {
  console.error(`\nreview-resolution: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nreview-resolution: all checks passed");
