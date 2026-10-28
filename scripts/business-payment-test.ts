/**
 * Zold Business → one payment run's page (public/business/payment-model.js).
 *
 * Pins: a statement line opens the run that sent it, and only that one; the
 * IBAN and BIC come from the contact's bank account the line names, and are
 * left out when it is gone; a rejected run is never counted as approved and
 * keeps its reason; two approvals are needed once a run went to review; the
 * sender is read from the "executing" step; the id in the address wins over
 * the one a link picked.
 *
 * What this cannot show: the page in a browser. Offline.
 *
 *   npm run business:payment:test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/payment-model.js")).href);

// ── Which run a statement line came from ─────────────────────────────────────

const runs = [{ id: "d1", transferIds: ["t1", "t2"] }, { id: "d2" }, { id: "d3", transferIds: ["t3"] }];
assert.equal(m.runIdForLine(runs, { links: { transferId: "t2" } }), "d1");
assert.equal(m.runIdForLine(runs, { links: { transferId: "t9" } }), null, "a transfer no run sent: no run");
assert.equal(m.runIdForLine(runs, { links: {} }), null, "money in has no transfer: no run");
assert.equal(m.runIdForLine(null, { links: { transferId: "t1" } }), null, "runs unread: no link");

// ── Where a line pays ────────────────────────────────────────────────────────

const contacts = [{ id: "c1", bankAccounts: [{ id: "b0", iban: "DE00" }, { id: "b1", iban: "DE11", bic: "DEUTDEFF" }] }];
const bankLine = { contactId: "c1", destination: { kind: "bank", bankAccountId: "b1", displayName: "Weber" } };
assert.deepEqual(m.payee(bankLine, contacts), { name: "Weber", iban: "DE11", bic: "DEUTDEFF", wallet: null }, "the bank account the line names, not the contact's first");
assert.deepEqual(m.payee({ ...bankLine, destination: { ...bankLine.destination, bankAccountId: "gone" } }, contacts), { name: "Weber", iban: null, bic: null, wallet: null }, "a removed bank account: no IBAN, never another one");
assert.equal(m.payee(bankLine, null).iban, null, "contacts unread: no IBAN");
assert.deepEqual(m.payee({ destination: { kind: "wallet", address: "0xabc", displayName: "W" } }, contacts), { name: "W", iban: null, bic: null, wallet: "0xabc" });

// ── Approvals ────────────────────────────────────────────────────────────────

const base = { createdByMemberId: "m1", createdAt: "2026-10-20T09:00:00Z", activity: [] };
{
  const a = m.approvals({ ...base, state: "PENDING_REVIEW" }, true);
  assert.deepEqual([a.have, a.needed, a.steps[1].role, a.steps[1].done], [1, 2, "approved", false]);
}
{
  const a = m.approvals({ ...base, state: "REVIEWED", reviewedByMemberId: "m2", reviewedAt: "2026-10-21T09:00:00Z" }, false);
  assert.deepEqual([a.have, a.needed], [2, 2], "reviewed while review was on: two of two, even after it is turned off");
}
{
  const a = m.approvals({ ...base, state: "REJECTED", reviewedByMemberId: "m2", rejectedReason: "Wrong amount" }, true);
  assert.deepEqual([a.have, a.steps[1].role, a.steps[1].reason], [1, "rejected", "Wrong amount"], "rejected is never counted as approved");
}
{
  const a = m.approvals({ ...base, state: "DRAFT" }, false);
  assert.deepEqual([a.have, a.needed], [1, 1], "review off and never reviewed: one of one");
}
{
  const a = m.approvals({ ...base, state: "EXECUTED", activity: [{ action: "created", actorMemberId: "m1", at: "x" }, { action: "executing", actorMemberId: "m3", at: "2026-10-22T09:00:00Z" }] }, false);
  assert.deepEqual(a.sentBy, { memberId: "m3", at: "2026-10-22T09:00:00Z" });
}
assert.equal(m.approvals({ ...base, state: "PENDING_REVIEW" }, true).sentBy, null);
{
  const tries = [{ action: "executing", actorMemberId: "m3", at: "a" }, { action: "execution_failed", actorMemberId: "m3", at: "b" }, { action: "executing", actorMemberId: "m4", at: "c" }];
  assert.equal(m.approvals({ ...base, state: "EXECUTING", activity: tries }, false).sentBy, null, "transfers created, nothing signed yet: no sender");
  assert.deepEqual(m.approvals({ ...base, state: "EXECUTED", activity: tries }, false).sentBy, { memberId: "m4", at: "c" }, "the last attempt is the one that went");
}
{
  const a = m.approvals({ ...base, state: "EXECUTED" }, true);
  assert.deepEqual([a.have, a.needed], [1, 1], "sent while review was off: turning it on later asks for no approver");
}
{
  const a = m.approvals({ ...base, state: "INVALID_DATA", reviewedByMemberId: "m2" }, true);
  assert.deepEqual([a.have, a.steps[1].done], [1, false], "stopped because a contact changed: not approved");
}

// ── Next step and the id ─────────────────────────────────────────────────────

assert.match(m.nextStep({ state: "FAILED", failureReason: "Line 2 could not be prepared" }), /Line 2/);
assert.match(m.nextStep({ state: "DRAFT" }, true), /Not submitted/);
assert.match(m.nextStep({ state: "DRAFT" }, false), /Saved/);
assert.equal(m.runIdFrom("?view=payment&id=d9", "d1"), "d9", "the address wins");
assert.equal(m.runIdFrom("?view=payment", "d1"), "d1");
assert.equal(m.runIdFrom("", null), null);

console.log("business payment: ok");
