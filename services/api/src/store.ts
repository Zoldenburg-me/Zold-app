/**
 * The store: every read and write of persisted state goes through here.
 *
 * Nothing outside this file touches the database object, so the JSON file
 * behind it can be replaced in one place. Every write persists before it
 * returns, so a crash cannot leave a change only in memory.
 *
 * Nothing deletes: there is no method to remove an organisation, account,
 * invoice or ledger row. Feature gating is a read-time filter, which holds
 * only while no delete path exists. Don't add one.
 *
 * The row shapes are in ./store/types.ts and the file-backed database in
 * ./store/db.ts; both are re-exported here.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { beginWrites, DATA_DIR, db, endWrites, initStore as initJsonStore, persist, pruneSessions, seedChartOfAccounts, type Db } from "./store/db.js";
import { jsonBackend, type StoreBackend } from "./store/backend.js";
import { createPgStore } from "./store/pg/backend.js";
import { assertSchemaCurrent } from "./store/pg/migrate.js";
import { openPool, pgPoolConfig, type Database } from "./store/pg/sql.js";
import { DATABASE_CA, DATABASE_URL, IS_REAL_MONEY_CHAIN, STORE_BACKEND } from "./config/env.js";
import { auditEntry } from "./audit.js";
import type {
  Account,
  AccountRule,
  DraftActivity,
  ChartAccount,
  Contact,
  DraftPayment,
  ImportedWallet,
  Invoice,
  LedgerEntry,
  Member,
  Organisation,
  OrgSafePlan,
} from "./domain/types.js";
import {
  applyOrgSafePlan,
  applyReplacedOrgSafePlan,
  applyReviewResolution,
  acceptInviteOnRow,
  applyUserPatch,
  cancelUnpaidOnRow,
  checkReviewResolution,
  draftPatchOnRow,
  refuseActivityPatch,
  settlementOnRow,
  transferPatchOnRow,
  type DraftCondition,
  announceOutbox,
  claimOutboxOn,
  newOutboxRow,
  outboxDraftsFor,
  settleOutboxOn,
  type StateListener,
  assertCapAmounts,
  assertDepositKey,
  followIban,
    hashOnRecordIn,
  passkeyUsePatch,
  quoteConsumable,
  emailCodeAttemptPatch,
  reviewRefundTx,
  sessionDead,
  type ReviewResolution,
  type ReviewResult,
} from "./store/rules.js";
import type {
  ConversionSweep,
  CryptoDeposit,
  OutboxDraft,
  OutboxOutcome,
  OutboxRow,
  CryptoSend,
  MerchantLink,
  MoneriumIssueRecord,
  Operator,
  OperatorCredential,
  OperatorSession,
  PaymentRequest,
  PendingExecution,
  PendingExecutionKind,
  PendingSafeOp,
  Quote,
  ReceiptShare,
  RecoveryRequest,
  SafeOpSignature,
  ServiceCredential,
  Session,
  ShopifyConnection,
  ShopifyDelivery,
  StoredDocument,
  Transfer,
  User,
} from "./store/types.js";
import { describeCause } from "./http/log-cause.js";

export * from "./store/types.js";

export { REVIEW_EVIDENCE_MAX, REVIEW_NOTE_MAX, REVIEW_NOTE_MIN } from "./store/rules.js";

/** Daily-cap holds for transfers being prepared — see store.holdDailyCap. */
const capHolds = new Map<string, { userId: string; eur: number; day: string }>();

/** Approvals waiting for a passkey, by `kind:id` — see store.putPendingExecution.
 *  In memory on db.json: a restart drops them and the approval answers 410. */
const pendingExecutions = new Map<string, PendingExecution>();

/**
 * Called inside the write that moved a transfer's state, on a copy of the
 * row: what it returns goes into the outbox in the same write (outbox.ts).
 */
type TransferStateListener = StateListener<Transfer>;
const transferStateListeners: TransferStateListener[] = [];
type PaymentRequestStateListener = StateListener<PaymentRequest>;
const paymentRequestStateListeners: PaymentRequestStateListener[] = [];
/** Told once an outbox row is on disk and the store is free again. */
const outboxListeners: (() => void)[] = [];

/** Announcements of written outbox rows not yet made: they run once the
 *  write is on disk and the store is free again (store/backend.ts). */
const announcements: (() => void)[] = [];

/** Put each draft in the outbox, in the write in progress, and announce it
 *  once that write is on disk. */
function enqueueAll(drafts: OutboxDraft[]): OutboxRow[] {
  const written: OutboxRow[] = [];
  for (const d of drafts) {
    if (d.key !== undefined && db.outbox.some((r) => r.key === d.key)) continue;
    const row = newOutboxRow(d);
    db.outbox.push(row);
    written.push(row);
  }
  if (written.length) announcements.push(() => announceOutbox(outboxListeners));
  return written;
}
function announceStateChange(t: Transfer, from: Transfer["state"]) {
  if (t.state !== from) enqueueAll(outboxDraftsFor(transferStateListeners, t, from, `transfer ${t.id}`));
}
function announcePaymentRequestState(r: PaymentRequest, from: PaymentRequest["state"]) {
  if (r.state !== from) enqueueAll(outboxDraftsFor(paymentRequestStateListeners, r, from, `payment request ${r.id}`));
}

/** Which record already holds `hash` (store/rules.ts hashOnRecordIn). */
function hashOnRecord(hash: string, userId: string): string | undefined {
  return hashOnRecordIn(db, hash, userId);
}

/**
 * The JSON backend's synchronous core. Nothing outside store.ts and
 * store/backend.ts calls it: everything else calls `store`, which runs these
 * methods one at a time behind the store's mutex and hands out copies.
 */
/** Every state a draft can be in: an activity append is refused by none. */
const DRAFT_STATES: DraftPayment["state"][] = ["DRAFT", "PENDING_REVIEW", "REVIEWED", "REJECTED", "INVALID_DATA", "EXECUTING", "EXECUTED", "FAILED", "CANCELLED"];

export const jsonCore = {
  /** A transaction's writes land as one file write, at endTx. */
  beginTx: beginWrites,
  endTx: endWrites,
  /** The announcements queued so far, taken out of the queue: the backend
   *  takes them while it still holds the store and runs them after. */
  takeAnnouncements(): (() => void)[] {
    return announcements.splice(0);
  },
  /** One whole collection, as stored (the `list` of store/backend.ts). */
  list<K extends keyof Db>(name: K): Db[K] {
    return db[name];
  },
  addUser(u: User) {
    db.users.push(u);
    persist();
  },
  /**
   * The user, held until the transaction this runs in ends (Postgres:
   * `FOR UPDATE`; JSON: the mutex already holds everything). For a rule over
   * other rows of the user (§2 rule 4).
   */
  lockUser(id: string) {
    return db.users.find((u) => u.id === id);
  },
  /**
   * Hold `key` until the transaction this runs in ends (Postgres: an
   * advisory transaction lock; JSON: the mutex already holds everything).
   * For a rule over rows no single row stands for, e.g. one org's ledger.
   */
  lockKey(_key: string) {},
  /** Change `passkeySafe` or `monerium` from the stored value (§2 rule 2), with `patch`. */
  patchUserSub<K extends "passkeySafe" | "monerium">(id: string, key: K, fn: (current: User[K]) => User[K], patch: Partial<User> = {}) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    return jsonCore.updateUser(id, { ...patch, [key]: structuredClone(fn(structuredClone(u[key]))) } as Partial<User>);
  },
  updateUser(id: string, patch: Partial<User>) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    if (applyUserPatch(u, patch)) {
      for (const a of db.accounts) followIban(a, id, u.iban);
    }
    persist();
    return u;
  },
  /**
   * Record a verified assertion's signCount, only while `credentialId` is
   * still the account's passkey: a recovery can replace the passkey while an
   * assertion is being verified. Undefined when it was replaced; the caller
   * refuses the assertion.
   */
  recordPasskeyUse(id: string, credentialId: string, signCount: number) {
    const patch = passkeyUsePatch(db.users.find((x) => x.id === id), credentialId, signCount);
    return patch ? jsonCore.updateUser(id, patch) : undefined;
  },
  /** Count one email-code guess on the stored row (rules.ts emailCodeAttemptPatch); undefined when refused. */
  countEmailCodeAttempt(id: string, max: number, now = Date.now()) {
    const patch = emailCodeAttemptPatch(db.users.find((x) => x.id === id), max, now);
    return patch ? jsonCore.updateUser(id, patch) : undefined;
  },
  serviceCredentials(service: ServiceCredential["service"]): readonly ServiceCredential[] {
    return db.serviceCredentials.filter((c) => c.service === service);
  },
  /**
   * Make `next` the service's current credential. Every other one of that
   * service stops working `overlapMs` from now, or earlier if a past rotation
   * already set that. One write, with its audit row. Returns when the
   * previous credential stops working.
   */
  rotateServiceCredential(next: ServiceCredential, overlapMs: number, by: string, revoked = false): string {
    const until = new Date(Date.now() + overlapMs).toISOString();
    for (const c of db.serviceCredentials) {
      if (c.service !== next.service) continue;
      if (!c.expiresAt || c.expiresAt > until) c.expiresAt = until;
    }
    db.serviceCredentials.push(next);
    db.audit.push(
      auditEntry("service.credential_rotated", {
        service: next.service,
        credentialId: next.id,
        previousValidUntil: until,
        revokedPrevious: revoked,
        operator: by,
      }),
    );
    persist();
    return until;
  },
  /**
   * Append one audit entry. There is deliberately no update and no delete —
   * a log a process can edit proves nothing.
   */
  audit(entry: import("./audit.js").AuditEntry) {
    db.audit.push(entry);
    persist();
  },
  auditFor(userId?: string, limit = 200) {
    const rows = userId ? db.audit.filter((r) => r.userId === userId) : db.audit;
    return rows.slice(-limit).reverse();
  },
  /**
   * Set the segment. The only writer. Once a segment is decided only an admin
   * action can change it, so a second signup-path call cannot re-segment an
   * existing account.
   */
  setSegment(
    id: string,
    segment: NonNullable<User["segment"]>,
    by: "system" | "admin" = "system",
  ) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    if (u.segment && by !== "admin") {
      throw new Error(
        `user ${id} already has segment ${u.segment.value}; only an admin action may change it`,
      );
    }
    u.segment = { ...segment, decidedBy: by };
    persist();
    return u;
  },
  /** Append-only: consents and US answers are never overwritten. */
  addConsent(id: string, consent: NonNullable<User["consents"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.consents ??= []).push(consent);
    persist();
    return u;
  },
  addUsAnswers(id: string, answers: NonNullable<User["usPersonAnswers"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.usPersonAnswers ??= []).push(answers);
    persist();
    return u;
  },
  addRecoveryRequest(r: RecoveryRequest) {
    db.recoveryRequests.push(r);
    persist();
  },
  updateRecoveryRequest(id: string, patch: Partial<RecoveryRequest>) {
    const r = db.recoveryRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown recovery request ${id}`);
    Object.assign(r, patch);
    persist();
    return r;
  },
  /** Write a request only from the statuses it may leave; null when it moved on. */
  updateRecoveryRequestFrom(id: string, from: readonly RecoveryRequest["status"][], patch: Partial<RecoveryRequest>) {
    const r = db.recoveryRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown recovery request ${id}`);
    if (!from.includes(r.status)) return null;
    return jsonCore.updateRecoveryRequest(id, patch);
  },
  /**
   * Count one OTP guess on the stored row, while it is OTP_PENDING. Past
   * `max` the request is canceled instead. Null when it is not OTP_PENDING.
   */
  countRecoveryOtpAttempt(id: string, max: number) {
    const r = db.recoveryRequests.find((x) => x.id === id);
    if (!r || r.status !== "OTP_PENDING" || !r.candide) return null;
    const attempts = (r.candide.otpAttempts ?? 0) + 1;
    if (attempts > max) {
      Object.assign(r, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "too many wrong codes" });
    } else r.candide = { ...r.candide, otpAttempts: attempts };
    persist();
    return { request: r, attempts, over: attempts > max };
  },
  findRecoveryRequest(id: string) {
    return db.recoveryRequests.find((r) => r.id === id);
  },
  recoveryRequestsForUser(userId: string) {
    return db.recoveryRequests.filter((r) => r.userId === userId);
  },

  addSafeOp(op: PendingSafeOp) {
    db.safeOps.push(op);
    persist();
    return op;
  },
  findSafeOp(id: string) {
    return db.safeOps.find((o) => o.id === id);
  },
  safeOpsOf(orgId: string) {
    return db.safeOps.filter((o) => o.orgId === orgId);
  },
  /**
   * End a PENDING op (expired, invalidated, cancelled). Only a PENDING op is
   * written: every other state is the op's last word or belongs to the relay
   * (finishSafeOp), so nothing moves a finished op backwards.
   */
  endPendingSafeOp(id: string, patch: { state: "EXPIRED" | "INVALIDATED" | "CANCELLED"; reason: string }) {
    const o = db.safeOps.find((x) => x.id === id);
    if (!o || o.state !== "PENDING") return null;
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    persist();
    return o;
  },
  /** Take the signatures of these owner addresses off a PENDING op, and say
   *  why. Filters the row as stored, so a signature added meanwhile stays. */
  dropSafeOpSignatures(id: string, ownerAddresses: string[], reason: string, at = new Date().toISOString()) {
    const o = db.safeOps.find((x) => x.id === id);
    if (!o || o.state !== "PENDING") return null;
    const gone = new Set(ownerAddresses.map((a) => a.toLowerCase()));
    const dropped = o.signatures.filter((s) => gone.has(s.ownerAddress.toLowerCase()));
    if (!dropped.length) return o;
    o.signatures = o.signatures.filter((s) => !gone.has(s.ownerAddress.toLowerCase()));
    o.dropped.push(...dropped.map((s) => ({ memberId: s.memberId, ownerAddress: s.ownerAddress, droppedAt: at, reason })));
    o.updatedAt = at;
    persist();
    return o;
  },
  /**
   * Add one owner's signature, synchronously: the state check, the duplicate
   * check and the write happen with no await between, so two parallel
   * submissions by one owner cannot both land. Null when the op is not
   * PENDING or that member or owner address has signed already.
   */
  addSafeOpSignature(id: string, sig: SafeOpSignature): PendingSafeOp | null {
    const o = db.safeOps.find((x) => x.id === id);
    if (!o || o.state !== "PENDING") return null;
    const owner = sig.ownerAddress.toLowerCase();
    if (o.signatures.some((s) => s.memberId === sig.memberId || s.ownerAddress.toLowerCase() === owner)) return null;
    o.signatures.push(sig);
    o.updatedAt = sig.signedAt;
    persist();
    return o;
  },
  /** Claim a PENDING op for its one relay, same shape as claimDraftExecution.
   *  Null when somebody else claimed it, or it is no longer pending. */
  claimSafeOpRelay(id: string): PendingSafeOp | null {
    const o = db.safeOps.find((x) => x.id === id);
    if (!o || o.state !== "PENDING") return null;
    o.state = "RELAYING";
    o.updatedAt = new Date().toISOString();
    persist();
    return o;
  },
  /** The relay's outcome. Only a RELAYING op is finished, and only once. */
  finishSafeOp(id: string, patch: Pick<PendingSafeOp, "state"> & Partial<Pick<PendingSafeOp, "reason" | "userOpHash" | "txHash">>) {
    const o = db.safeOps.find((x) => x.id === id);
    if (!o || o.state !== "RELAYING") throw new Error(`safe op ${id} is not relaying`);
    if (patch.state === "PENDING" || patch.state === "RELAYING") throw new Error("a relay ends in a final state");
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    persist();
    return o;
  },
  findUserByAddress(address: string) {
    return db.users.find((u) => u.address.toLowerCase() === address.toLowerCase());
  },
  findUserByCredential(credentialId: string) {
    return db.users.find((u) => u.passkey?.credentialId === credentialId);
  },
  /** Every account carrying this email, case-insensitively. Signup uses it to
   *  refuse a second account on an address that already has a passkey; rows
   *  without one are onboarding that stopped before a credential existed and
   *  may be started over. */
  usersByEmail(email: string) {
    const needle = email.trim().toLowerCase();
    if (!needle) return [];
    return db.users.filter((u) => (u.email ?? "").trim().toLowerCase() === needle);
  },
  /** Case-insensitive email match. Prefers the account that confirmed the
   *  address (routes/email-verification.ts), then one that can actually be
   *  recovered when the same address was used more than once. */
  findUserByEmail(email: string) {
    const matches = jsonCore.usersByEmail(email);
    return (
      matches.find((u) => !!u.emailVerifiedAt) ??
      matches.find((u) => u.passkeySafe?.candideRecovery?.guardianStatus === "active") ??
      matches.find((u) => u.passkeySafe?.status === "active") ??
      matches[0]
    );
  },
  findUserBySafeAddress(address: string) {
    const needle = address.trim().toLowerCase();
    return db.users.find(
      (u) => u.address?.toLowerCase() === needle || u.passkeySafe?.address?.toLowerCase() === needle,
    );
  },
  /** Every Monerium order id we have reflected in local receipt state. */
  mirroredOrderIds(): string[] {
    return [...db.processedMoneriumOrders];
  },
  isOrderProcessed(orderId: string) {
    return db.processedMoneriumOrders.includes(orderId);
  },
  /** Claim an order as recorded, once: false when it already was (§2,
   *  Monerium order dedupe; Postgres: the order id's primary key). */
  markOrderProcessed(orderId: string): boolean {
    if (db.processedMoneriumOrders.includes(orderId)) return false;
    db.processedMoneriumOrders.push(orderId);
    persist();
    return true;
  },
  isWebhookProcessed(webhookId: string) {
    return db.processedMoneriumWebhooks.includes(webhookId);
  },
  /** Mark a webhook delivery handled, once: false when it already was. */
  markWebhookProcessed(webhookId: string): boolean {
    if (db.processedMoneriumWebhooks.includes(webhookId)) return false;
    db.processedMoneriumWebhooks.push(webhookId);
    persist();
    return true;
  },
  addQuote(q: Quote) {
    // A quote nobody took is worth nothing a day after it expired, and every
    // POST /quotes adds one: drop those, so asking for prices cannot grow the
    // file without end. A CONSUMED quote is a transfer's terms and stays.
    const stale = Date.now() - 24 * 60 * 60_000;
    db.quotes = db.quotes.filter((x) => x.status === "CONSUMED" || Date.parse(x.expiresAt) > stale);
    db.quotes.push(q);
    persist();
  },
  updateQuote(id: string, patch: Partial<Quote>) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    Object.assign(q, patch);
    persist();
    return q;
  },
  /**
   * Consume an OPEN quote that has not expired, once (§2, quote → transfer).
   * The expiry is checked here, on the stored row, not only by the caller:
   * a quote read before an await can expire before it is consumed.
   */
  consumeQuote(id: string, now = Date.now()) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if (!quoteConsumable(q, now)) return false;
    q.status = "CONSUMED";
    persist();
    return true;
  },
  /** Mark an OPEN quote EXPIRED; never a consumed one. False when it was not OPEN. */
  expireQuote(id: string) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q || (q.status ?? "OPEN") !== "OPEN") return false;
    q.status = "EXPIRED";
    persist();
    return true;
  },
  addTransfer(t: Transfer) {
    db.transfers.push(t);
    persist();
  },
  /**
   * Hold part of the daily cap for a transfer that is still being prepared.
   *
   * Checking the cap in buildTransferFromQuote and writing the reserving row
   * several awaits later let two parallel requests each create a full-cap
   * transfer. Checking again at the write refuses too late: on the cash rail,
   * after a live Bridge transfer exists, leaving it unfunded. A hold taken
   * before any partner is called refuses the second request while nothing
   * outside this process has been touched, and counts the first from the
   * moment it starts preparing.
   *
   * Same idiom as claimAuthorization: nothing yields between the read and the
   * write. `used` is a function so it is recomputed inside that window, and it
   * must include `heldEurToday` (safeFundedEurToday does). Holds live in
   * memory like pendingTransferExecutions: a restart drops them along with the
   * requests that took them.
   */
  holdDailyCap(
    userId: string,
    eur: number,
    capEur: number,
    used: () => number,
  ): { ok: true; holdId: string } | { ok: false; usedEur: number; capEur: number } {
    const usedEur = used();
    assertCapAmounts(eur, usedEur, capEur);
    if (usedEur + eur > capEur) return { ok: false, usedEur, capEur };
    const holdId = randomUUID();
    capHolds.set(holdId, { userId, eur, day: new Date().toISOString().slice(0, 10) });
    return { ok: true, holdId };
  },
  /** Euros held for transfers still being prepared, for one user and UTC day. */
  heldEurToday(userId: string, day = new Date().toISOString().slice(0, 10)): number {
    let sum = 0;
    for (const h of capHolds.values()) if (h.userId === userId && h.day === day) sum += h.eur;
    return sum;
  },
  /**
   * Turn a hold into the transfer row that replaces it. Push and release
   * happen together so the amount is never uncounted in between.
   */
  addTransferUnderHold(t: Transfer, holdId: string) {
    if (!capHolds.delete(holdId)) throw new Error(`no cap hold ${holdId} — the transfer was not reserved`);
    db.transfers.push(t);
    persist();
  },
  /** Drop a hold whose transfer was refused or failed. A no-op once committed. */
  releaseCapHold(holdId: string) {
    capHolds.delete(holdId);
  },
  /**
   * Keep a prepared UserOperation until its passkey approves it (§2,
   * approvals waiting for a passkey). Expired entries go first. The claim
   * that submits it drops it in the same transaction, so a replayed
   * approval finds nothing to submit.
   */
  putPendingExecution(kind: PendingExecutionKind, id: string, entry: PendingExecution) {
    const now = Date.now();
    for (const [k, p] of pendingExecutions) if (p.expiresAt < now) pendingExecutions.delete(k);
    pendingExecutions.set(`${kind}:${id}`, entry);
  },
  /** The prepared operation, unless its window closed. */
  findPendingExecution(kind: PendingExecutionKind, id: string): PendingExecution | undefined {
    const p = pendingExecutions.get(`${kind}:${id}`);
    return p && p.expiresAt >= Date.now() ? p : undefined;
  },
  dropPendingExecution(kind: PendingExecutionKind, id: string) {
    pendingExecutions.delete(`${kind}:${id}`);
  },
  /**
   * Claim the one and only authorization submission for a transfer.
   *
   * Deliberately synchronous: an Express handler runs uninterrupted until its
   * first `await`, so claiming here — before any chain call — is what makes two
   * concurrent submissions of the same device signature impossible. Without it
   * both passed the `state === "CREATED"` check and both could have submitted
   * the same Safe spend. One claim must win before any chain call starts.
   *
   * Returns false when the transfer is not awaiting authorization, has no terms,
   * or has already been claimed.
   */
  claimAuthorization(id: string) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t || t.state !== "CREATED" || !t.auth || t.auth.authorizedAt) return false;
    const now = new Date().toISOString();
    t.auth.authorizedAt = now;
    t.updatedAt = now;
    persist();
    return true;
  },
  updateTransfer(id: string, patch: Partial<Transfer>) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    patch = transferPatchOnRow(t, patch);
    const from = t.state;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    announceStateChange(t, from);
    persist();
    return t;
  },
  /** Append one step to a transfer's log on the stored row, with `patch`. */
  appendTransferStep(id: string, step: Transfer["txs"][number], patch: Partial<Transfer> = {}) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    return jsonCore.updateTransfer(id, { ...patch, txs: [...t.txs, step] });
  },
  /**
   * Change one sub-object of a transfer (`sepa`, `refund`, …) from its
   * stored value: `fn` gets the value on the row and returns the new one.
   */
  patchTransferSub<K extends keyof Transfer>(id: string, key: K, fn: (current: Transfer[K]) => Transfer[K], patch: Partial<Transfer> = {}) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    return jsonCore.updateTransfer(id, { ...patch, [key]: structuredClone(fn(structuredClone(t[key]))) });
  },
  /** Subscribe to transfer state changes (checkout-webhook.ts). */
  onTransferStateChange(listener: TransferStateListener) {
    transferStateListeners.push(listener);
  },
  /**
   * The only way out of MANUAL_REVIEW: an operator records what they decided
   * after acting on chain or at the partner. Moves no money. Records the
   * resolution on the transfer and an audit entry, once per transfer.
   */
  resolveTransferReview(id: string, r: ReviewResolution): ReviewResult {
    checkReviewResolution(r);
    const t = db.transfers.find((x) => x.id === id);
    const refundTx = reviewRefundTx(r);
    const { result, audit } = applyReviewResolution(t, r, t && refundTx ? hashOnRecord(refundTx, t.userId) : undefined);
    if (!audit) return result;
    db.audit.push(audit);
    announceStateChange(t!, "MANUAL_REVIEW");
    persist();
    return result;
  },
  /**
   * One share per transfer, deliberately.
   *
   * Re-sharing a transfer edits the existing record instead of minting a second
   * slug, so tightening a selection actually tightens what is public. Two live
   * links to one transfer would mean the generous first link kept working after
   * the sender thought they had narrowed it.
   */
  findReceiptShareByTransfer(transferId: string) {
    const shares = db.receiptShares.filter((s) => s.transferId === transferId);
    return shares.find((s) => !s.revokedAt) ?? shares.at(-1);
  },
  findReceiptShareBySlug(slug: string) {
    return db.receiptShares.find((s) => s.slug === slug);
  },
  addDocument(d: StoredDocument) {
    db.documents.push(d);
    persist();
    return d;
  },
  updateDocument(id: string, patch: Partial<StoredDocument>) {
    const d = db.documents.find((x) => x.id === id);
    if (!d) throw new Error(`unknown document ${id}`);
    Object.assign(d, patch);
    persist();
    return d;
  },
  findDocumentByCode(code: string) {
    return db.documents.find((d) => d.code === code);
  },
  documentsForUser(userId: string) {
    return db.documents.filter((d) => d.userId === userId);
  },

  // ── Payment requests (pay links) ──────────────────────────────────────────
  //
  // No delete. A request somebody may have paid against is a record; the
  // owner cancels it (state CANCELLED) and a visitor is told so rather than
  // getting a 404 that reads like a typo.
  addPaymentRequest(r: PaymentRequest) {
    db.paymentRequests.push(r);
    persist();
    return r;
  },
  updatePaymentRequest(id: string, patch: Partial<PaymentRequest>) {
    const r = db.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown payment request ${id}`);
    const from = r.state;
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    announcePaymentRequestState(r, from);
    persist();
    return r;
  },
  /** Write a request only from the states it may leave; null when it moved on. */
  updatePaymentRequestFrom(id: string, from: readonly PaymentRequest["state"][], patch: Partial<PaymentRequest>) {
    const r = db.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown payment request ${id}`);
    if (!from.includes(r.state)) return null;
    return jsonCore.updatePaymentRequest(id, patch);
  },
  /** Cancel an open request nothing has paid (rules.ts cancelUnpaidOnRow); null otherwise. */
  cancelUnpaidPaymentRequest(id: string, now = new Date(), evenIfExpired = false) {
    const r = db.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown payment request ${id}`);
    const patch = cancelUnpaidOnRow(r, now, evenIfExpired);
    return patch ? jsonCore.updatePaymentRequest(id, patch) : null;
  },
  /**
   * Record a payment on the stored request: `apply` runs on the row as
   * stored (payment-requests.ts applyPayment) and returns the patch, or null
   * when there is nothing to write. Returns the row and its state before.
   */
  recordPaymentRequestPayment(id: string, apply: (r: PaymentRequest) => Partial<PaymentRequest> | null) {
    const r = db.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown payment request ${id}`);
    const from = r.state;
    // Cloned: the callback's own object must not be the stored one.
    const patch = structuredClone(apply(structuredClone(r)));
    return { request: patch ? jsonCore.updatePaymentRequest(id, patch) : r, from, written: !!patch };
  },
  /** Subscribe to payment request state changes (checkout-webhook.ts, the PAID hooks of routes/payment-requests.ts). */
  onPaymentRequestStateChange(listener: PaymentRequestStateListener) {
    paymentRequestStateListeners.push(listener);
  },

  // ── Outbox (outbox.ts; docs/postgres-store-design.md §5) ────────────────
  /** Put one row in the outbox, in the write in progress if there is one;
   *  null when a row with its key is there already. */
  enqueueOutbox(draft: OutboxDraft) {
    const [row] = enqueueAll([draft]);
    if (row) persist();
    return row ?? null;
  },
  /** Claim up to `limit` due rows of `kinds` for `leaseMs`, each attempt counted. */
  claimOutbox(limit: number, leaseMs: number, kinds: readonly string[]) {
    const claimed = claimOutboxOn(db.outbox, limit, leaseMs, new Date(), kinds);
    if (claimed.length) persist();
    return claimed;
  },
  /** End a claimed attempt; false when the row is not claimed. */
  settleOutbox(id: string, outcome: OutboxOutcome) {
    const row = db.outbox.find((r) => r.id === id);
    if (!row || !settleOutboxOn(row, outcome, new Date())) return false;
    persist();
    return true;
  },
  /** Drop rows delivered before `before` (ISO); dead rows stay. */
  pruneOutbox(before: string) {
    const kept = db.outbox.filter((r) => !r.deliveredAt || r.deliveredAt >= before);
    const n = db.outbox.length - kept.length;
    if (n) {
      db.outbox = kept;
      persist();
    }
    return n;
  },
  /** Rows not yet delivered, and rows given up on. */
  outboxCounts() {
    return {
      pending: db.outbox.filter((r) => !r.deliveredAt && !r.deadAt).length,
      dead: db.outbox.filter((r) => r.deadAt).length,
    };
  },
  findOutboxRow(id: string) {
    return db.outbox.find((r) => r.id === id);
  },
  /** Called once a written outbox row is on disk (outbox.ts kicks its worker). */
  onOutboxWritten(listener: () => void) {
    outboxListeners.push(listener);
  },
  findPaymentRequest(id: string) {
    return db.paymentRequests.find((r) => r.id === id);
  },
  /** Codes are stored normalised (upper-case, no hyphens); compare the same way. */
  findPaymentRequestByCode(code: string) {
    const norm = code.replace(/-/g, "").toUpperCase();
    return db.paymentRequests.find((r) => r.code === norm);
  },
  paymentRequestsForUser(userId: string) {
    return db.paymentRequests.filter((r) => r.userId === userId);
  },
  /** Shopify order and session ids are per-store sequences, so the shop is
   *  part of the key: without it one connected store's webhook finds, and can
   *  cancel or dedupe against, another store's request. */
  findPaymentRequestBySource(kind: string, externalId: string, shop: string) {
    return db.paymentRequests.find(
      (r) => r.source?.kind === kind && r.source.externalId === externalId && r.source.shop === shop,
    );
  },

  // ── Shopify connections ───────────────────────────────────────────────────
  addShopifyConnection(c: ShopifyConnection) {
    db.shopifyConnections.push(c);
    persist();
    return c;
  },
  updateShopifyConnection(id: string, patch: Partial<ShopifyConnection>) {
    const c = db.shopifyConnections.find((x) => x.id === id);
    if (!c) throw new Error(`unknown Shopify connection ${id}`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    persist();
    return c;
  },
  removeShopifyConnection(id: string) {
    const i = db.shopifyConnections.findIndex((x) => x.id === id);
    if (i >= 0) db.shopifyConnections.splice(i, 1);
    persist();
  },
  findShopifyConnectionByShop(shop: string) {
    const s = shop.trim().toLowerCase();
    return db.shopifyConnections.find((c) => c.shop === s);
  },
  shopifyConnectionsForOrg(orgId: string) {
    return db.shopifyConnections.filter((c) => c.orgId === orgId);
  },
  shopifyDelivery(id: string): ShopifyDelivery | undefined {
    return db.shopifyDeliveries.find((d) => d.id === id);
  },
  /** Record a delivery the first time it arrives, dropping those past 72
   *  hours. Returns the stored row: `d`, or the one recorded first under
   *  that id, whose shop the caller checks (§2, Shopify delivery dedupe). */
  recordShopifyDelivery(d: ShopifyDelivery) {
    const stale = Date.now() - 72 * 3_600_000;
    db.shopifyDeliveries = db.shopifyDeliveries.filter((x) => Date.parse(x.at) > stale);
    const existing = db.shopifyDeliveries.find((x) => x.id === d.id);
    if (existing) {
      persist();
      return existing;
    }
    db.shopifyDeliveries.push(d);
    persist();
    return d;
  },
  markShopifyDeliveryHandled(id: string) {
    const d = db.shopifyDeliveries.find((x) => x.id === id);
    if (!d || d.handled) return;
    d.handled = true;
    persist();
  },

  // ── Merchant links (merchant-links.ts) ────────────────────────────────────
  //
  // No delete: revoking is a field. A revoked link still names the org its
  // requests belong to.
  addMerchantLink(l: MerchantLink) {
    db.merchantLinks.push(l);
    persist();
    return l;
  },
  updateMerchantLink(id: string, patch: Partial<MerchantLink>) {
    const l = db.merchantLinks.find((x) => x.id === id);
    if (!l) throw new Error(`unknown merchant link ${id}`);
    Object.assign(l, patch, { updatedAt: new Date().toISOString() });
    persist();
    return l;
  },
  findMerchantLink(id: string) {
    return db.merchantLinks.find((l) => l.id === id);
  },
  /** The shop's one active link, whichever org holds it. */
  activeMerchantLinkForShop(shop: string) {
    const s = shop.trim().toLowerCase();
    return db.merchantLinks.find((l) => l.shop === s && !l.revokedAt);
  },
  merchantLinksForOrg(orgId: string): readonly MerchantLink[] {
    return db.merchantLinks.filter((l) => l.orgId === orgId);
  },
  addReceiptShare(s: ReceiptShare) {
    db.receiptShares.push(s);
    persist();
  },
  updateReceiptShare(id: string, patch: Partial<ReceiptShare>) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    persist();
    return s;
  },
  revokeReceiptShare(id: string) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    s.revokedAt = new Date().toISOString();
    s.updatedAt = s.revokedAt;
    persist();
    return s;
  },
  addSession(s: Session) {
    pruneSessions();
    db.sessions.push(s);
    persist();
  },
  findSessionByTokenHash(tokenHash: string) {
    return db.sessions.find((s) => s.tokenHash === tokenHash);
  },
  revokeSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.revokedAt = new Date().toISOString();
    persist();
    return s;
  },
  touchSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    // lastUsedAt is telemetry, not a security control. Writing it on every
    // authenticated request re-serialised the entire store per call, which grows
    // with the number of users and transfers — a self-amplifying cost. Minute
    // granularity is enough to see an idle session.
    const now = Date.now();
    if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
    s.lastUsedAt = new Date(now).toISOString();
    persist();
    return s;
  },
  findOperator(id: string) {
    return db.operators.find((o) => o.id === id);
  },
  /** Emails are compared case-insensitively; they are stored lowercase. */
  findOperatorByEmail(email: string) {
    const e = email.trim().toLowerCase();
    return db.operators.find((o) => o.email === e);
  },
  /** Operator credentials only: a user's passkey is never found here. */
  findOperatorCredential(credentialId: string): { operator: Operator; credential: OperatorCredential } | undefined {
    for (const operator of db.operators) {
      const credential = operator.credentials.find((c) => c.credentialId === credentialId);
      if (credential) return { operator, credential };
    }
    return undefined;
  },
  addOperator(o: Operator) {
    if (db.operators.some((x) => x.email === o.email)) throw new Error("an operator with that email exists");
    db.operators.push({ ...o, email: o.email.trim().toLowerCase() });
    persist();
    return db.operators[db.operators.length - 1];
  },
  addOperatorCredential(operatorId: string, credential: OperatorCredential) {
    const o = db.operators.find((x) => x.id === operatorId);
    if (!o) throw new Error(`unknown operator ${operatorId}`);
    // On the stored row: a disable that landed after the caller's check wins.
    if (o.disabledAt) throw new Error("this operator is disabled");
    if (db.operators.some((x) => x.credentials.some((c) => c.credentialId === credential.credentialId))) {
      throw new Error("that passkey is already registered");
    }
    o.credentials = [...o.credentials, credential];
    persist();
    return o;
  },
  /** The sign counter and last use, after a verified assertion. */
  recordOperatorCredentialUse(operatorId: string, credentialId: string, signCount: number) {
    const o = db.operators.find((x) => x.id === operatorId);
    const c = o?.credentials.find((x) => x.credentialId === credentialId);
    if (!o || !c) throw new Error(`unknown operator credential ${credentialId}`);
    o.credentials = o.credentials.map((x) =>
      x.credentialId === credentialId ? { ...x, signCount, lastUsedAt: new Date().toISOString() } : x,
    );
    persist();
  },
  disableOperator(id: string) {
    const o = db.operators.find((x) => x.id === id);
    if (!o) throw new Error(`unknown operator ${id}`);
    o.disabledAt ??= new Date().toISOString();
    for (const s of db.operatorSessions) if (s.operatorId === id && !s.revokedAt) s.revokedAt = o.disabledAt;
    persist();
    return o;
  },
  addOperatorSession(s: OperatorSession) {
    db.operatorSessions = db.operatorSessions.filter((x) => !sessionDead(x, 24 * 60 * 60 * 1000));
    db.operatorSessions.push(s);
    persist();
  },
  findOperatorSessionByTokenHash(tokenHash: string) {
    return db.operatorSessions.find((s) => s.tokenHash === tokenHash);
  },
  revokeOperatorSession(id: string) {
    const s = db.operatorSessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown operator session ${id}`);
    s.revokedAt ??= new Date().toISOString();
    persist();
    return s;
  },
  /** Minute granularity, as for user sessions: the idle limit is 30 minutes. */
  touchOperatorSession(id: string) {
    const s = db.operatorSessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown operator session ${id}`);
    const now = Date.now();
    if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
    s.lastUsedAt = new Date(now).toISOString();
    persist();
    return s;
  },
  /** Handles are compared case-insensitively; they are stored lowercase. */
  findUserByHandle(handle: string) {
    const h = handle.trim().toLowerCase();
    return db.users.find((u) => u.paymentPage?.handle === h);
  },
  findUser(id: string) {
    return db.users.find((u) => u.id === id);
  },
  /** An organisation's payment page handle, compared like a user's. */
  findOrgByHandle(handle: string) {
    const h = handle.trim().toLowerCase();
    return db.organisations.find((o) => o.paymentPage?.handle === h);
  },
  findUserByIban(iban: string) {
    const norm = iban.replace(/\s/g, "").toUpperCase();
    return db.users.find((u) => u.iban.replace(/\s/g, "").toUpperCase() === norm);
  },
  findQuote(id: string) {
    return db.quotes.find((q) => q.id === id);
  },
  findTransfer(id: string) {
    return db.transfers.find((t) => t.id === id);
  },

  findCryptoSend(id: string) {
    return db.cryptoSends.find((s) => s.id === id);
  },
  /** Turn a cap hold into the send row that replaces it, as addTransferUnderHold. */
  addCryptoSendUnderHold(s: CryptoSend, holdId: string) {
    if (!capHolds.delete(holdId)) throw new Error(`no cap hold ${holdId} — the send was not reserved`);
    db.cryptoSends.push(s);
    persist();
  },
  /**
   * Claim the one submission of a send. Synchronous, like claimAuthorization:
   * two requests carrying the same signature cannot both pass it.
   */
  claimCryptoSend(id: string) {
    const s = db.cryptoSends.find((x) => x.id === id);
    // Past its deadline the link it pays may already read it as never sent.
    if (!s || s.state !== "CREATED" || s.authorizedAt || Date.now() / 1000 > s.deadline) return false;
    const now = new Date().toISOString();
    Object.assign(s, { state: "SUBMITTED", authorizedAt: now, updatedAt: now });
    persist();
    return true;
  },
  /** Write a send only from the states it may leave (§2 rule 3); null when it moved on. */
  updateCryptoSendFrom(id: string, from: readonly CryptoSend["state"][], patch: Partial<Pick<CryptoSend, "state" | "userOpHash" | "txHash" | "error">>) {
    const s = db.cryptoSends.find((x) => x.id === id);
    if (!s) throw new Error(`unknown crypto send ${id}`);
    if (!from.includes(s.state)) return null;
    return jsonCore.updateCryptoSend(id, patch);
  },
  updateCryptoSend(id: string, patch: Partial<Pick<CryptoSend, "state" | "userOpHash" | "txHash" | "error">>) {
    const s = db.cryptoSends.find((x) => x.id === id);
    if (!s) throw new Error(`unknown crypto send ${id}`);
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    persist();
    return s;
  },

  /** An ERC-20 transfer is identified by its tx and position in it. */
  /** The deposit of one Transfer log on one chain (§2, crypto deposits). */
  findCryptoDeposit(chainId: number, txHash: string, logIndex: number) {
    return db.cryptoDeposits.find(
      (d) => d.chainId === chainId && d.txHash.toLowerCase() === txHash.toLowerCase() && d.logIndex === logIndex,
    );
  },
  /**
   * Record a deposit, once.
   *
   * Idempotent on (chainId, txHash, logIndex) — the chain's own identity for a
   * transfer — because the poller's dedupe check and this write are separated
   * by an await (the receipt's rate lookup), and the poll runs on a bare
   * setInterval that does not wait for the previous tick. Two overlapping
   * scans of one window both passed the check and both pushed, double-counting
   * one payment: twice on the payee's payment link, twice in creditedUsdc.
   * Returning the existing row makes the loser of that race a no-op.
   */
  addCryptoDeposit(d: CryptoDeposit) {
    assertDepositKey(d);
    const existing = jsonCore.findCryptoDeposit(d.chainId, d.txHash, d.logIndex);
    if (existing) return existing;
    db.cryptoDeposits.push(d);
    persist();
    return d;
  },
  updateCryptoDeposit(id: string, patch: Partial<CryptoDeposit>) {
    const d = db.cryptoDeposits.find((x) => x.id === id);
    if (!d) throw new Error(`unknown crypto deposit ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  /**
   * Change a deposit from its stored value (§2 rules 2 and 5): `make` gets
   * the stored row and returns the patch, or null to leave it. Null back when
   * it was left. An array on the row (`partials`) is extended here, on the
   * stored value, never written whole from a row read before an await.
   */
  patchCryptoDeposit(id: string, make: (d: CryptoDeposit) => Partial<CryptoDeposit> | null) {
    const d = db.cryptoDeposits.find((x) => x.id === id);
    if (!d) throw new Error(`unknown crypto deposit ${id}`);
    const patch = make(structuredClone(d));
    return patch ? jsonCore.updateCryptoDeposit(id, structuredClone(patch)) : null;
  },
  /** Settle a deposit once: `decide` runs on the stored row; null when it was settled already. */
  settleCryptoDeposit(id: string, decide: (d: CryptoDeposit) => Partial<CryptoDeposit>) {
    const d = db.cryptoDeposits.find((x) => x.id === id);
    if (!d) throw new Error(`unknown crypto deposit ${id}`);
    if (d.settledAt) return null;
    return jsonCore.updateCryptoDeposit(id, { ...structuredClone(decide(structuredClone(d))), settledAt: new Date().toISOString() });
  },
  cryptoDepositCursor(chainId: number | string): bigint | undefined {
    const v = db.cryptoDepositCursor[String(chainId)];
    return v === undefined ? undefined : BigInt(v);
  },
  setCryptoDepositCursor(chainId: number | string, block: bigint) {
    db.cryptoDepositCursor[String(chainId)] = block.toString();
    persist();
  },

  // ── Organisation domain ───────────────────────────────────────────────────
  //
  // Reads return live rows; every write goes through here so a single atomic
  // persist covers the whole file. Deliberately NO delete for organisations,
  // accounts, invoices or ledger entries: archival must not be reachable by a
  // code path that removes rows (see plans.ts).


  addOrganisation(org: Organisation, seedCoa = true) {
    db.organisations.push(org);
    if (seedCoa) seedChartOfAccounts(org.id, org.createdAt);
    persist();
    return org;
  },
  findOrganisation(id: string) {
    return db.organisations.find((o) => o.id === id);
  },
  /**
   * Write an organisation only while `ok` holds for it as stored; `patch`
   * is computed from that row. Null when `ok` fails.
   */
  updateOrganisationIf(id: string, ok: (o: Organisation) => boolean, patch: (o: Organisation) => Partial<Organisation>) {
    const o = db.organisations.find((x) => x.id === id);
    if (!o) throw new Error(`unknown organisation ${id}`);
    if (!ok(structuredClone(o))) return null;
    return jsonCore.updateOrganisation(id, patch(structuredClone(o)));
  },
  /**
   * The organisation, held until the transaction this runs in ends (Postgres:
   * `FOR UPDATE`; JSON: the mutex already holds everything). For a rule over
   * other rows of the org (§2 rule 4).
   */
  lockOrganisation(id: string) {
    return db.organisations.find((o) => o.id === id);
  },
  /** Change `invoicing` or `integrations` from the stored value (§2 rule 2), with `patch`. */
  patchOrgSub<K extends "invoicing" | "integrations">(id: string, key: K, fn: (current: Organisation[K]) => Organisation[K], patch: Partial<Organisation> = {}) {
    const o = db.organisations.find((x) => x.id === id);
    if (!o) throw new Error(`unknown organisation ${id}`);
    return jsonCore.updateOrganisation(id, { ...patch, [key]: structuredClone(fn(structuredClone(o[key]))) } as Partial<Organisation>);
  },
  updateOrganisation(id: string, patch: Partial<Organisation>) {
    if ("safe" in patch) throw new Error("an org Safe plan is written through setOrgSafePlan only");
    const o = db.organisations.find((x) => x.id === id);
    if (!o) throw new Error(`unknown organisation ${id}`);
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    persist();
    return o;
  },
  /**
   * Store a company org's own Safe. Refused for any other org, for a plan of
   * the wrong shape, and for a different address once one is stored: the money
   * is on that Safe, so re-pointing the org would leave it behind. The owner
   * list may change (membership drives it); the address never does.
   */
  setOrgSafePlan(orgId: string, plan: OrgSafePlan) {
    const o = applyOrgSafePlan(db.organisations.find((x) => x.id === orgId), orgId, plan);
    persist();
    return o;
  },
  /**
   * Re-plan a company's Safe whose deploying owner has left, at a new
   * address. Only a `planned` plan at `oldAddress`, and only once the caller
   * has read the chain and found nothing there: no money can be at a Safe
   * that does not exist. A deployed Safe is never re-pointed.
   */
  replaceUndeployedOrgSafePlan(orgId: string, oldAddress: string, plan: OrgSafePlan) {
    const o = applyReplacedOrgSafePlan(db.organisations.find((x) => x.id === orgId), orgId, oldAddress, plan);
    persist();
    return o;
  },
  /** Every org a user can reach, with the membership that grants it. */
  organisationsForUser(userId: string) {
    return db.members
      .filter((m) => m.userId === userId && m.status === "active")
      .map((m) => ({ member: m, org: db.organisations.find((o) => o.id === m.orgId) }))
      .filter((x): x is { member: Member; org: Organisation } => Boolean(x.org));
  },

  addMember(m: Member) {
    db.members.push(m);
    persist();
    return m;
  },
  findMember(id: string) {
    return db.members.find((m) => m.id === id);
  },
  /** The membership joining this user to this org, active or not. */
  /** A re-invited person can carry a deactivated row beside a live one; the
   *  live one is the membership. */
  memberFor(orgId: string, userId: string) {
    const rows = db.members.filter((m) => m.orgId === orgId && m.userId === userId);
    return rows.find((m) => m.status !== "deactivated") ?? rows[0];
  },
  findMemberByInviteHash(tokenHash: string) {
    return db.members.find((m) => m.invite?.tokenHash === tokenHash);
  },
  membersOf(orgId: string) {
    return db.members.filter((m) => m.orgId === orgId);
  },
  updateMember(id: string, patch: Partial<Member>) {
    const m = db.members.find((x) => x.id === id);
    if (!m) throw new Error(`unknown member ${id}`);
    Object.assign(m, patch);
    persist();
    return m;
  },

  /**
   * Change a member only if `allowed` still holds for the organisation's
   * members as stored (an org never loses its last owner, §2 rule 4).
   * Null when it does not.
   */
  updateMemberChecked(id: string, patch: Partial<Member>, allowed: (members: Member[], member: Member) => boolean) {
    const m = db.members.find((x) => x.id === id);
    if (!m) throw new Error(`unknown member ${id}`);
    if (!allowed(structuredClone(db.members.filter((x) => x.orgId === m.orgId)), structuredClone(m))) return null;
    return jsonCore.updateMember(id, patch);
  },
  /** Spend an invitation, once, for one user. Null when it is spent, replaced or the user is already on the org. */
  acceptInvite(id: string, tokenHash: string, userId: string, at = new Date().toISOString()) {
    const m = db.members.find((x) => x.id === id);
    if (!m) return null;
    const patch = acceptInviteOnRow(m, tokenHash, userId, db.members.filter((x) => x.orgId === m.orgId), at);
    return patch ? jsonCore.updateMember(id, patch) : null;
  },
  /**
   * Add an account, or null when it is a company Safe's (no backing user)
   * and another unbacked account is at that address: a company Safe is one
   * account (§2, one Safe two accounts; Postgres: the partial unique key).
   * A person's Safe may back several, their personal and their sole-trader
   * business's; routes/orgs.ts keeps it to one business, under a lock.
   */
  addAccount(a: Account): Account | null {
    const at = a.address?.toLowerCase();
    if (at && !a.backingUserId && db.accounts.some((x) => !x.backingUserId && x.address?.toLowerCase() === at)) return null;
    db.accounts.push(a);
    persist();
    return a;
  },
  findAccount(id: string) {
    return db.accounts.find((a) => a.id === id);
  },
  accountsOf(orgId: string) {
    return db.accounts.filter((a) => a.orgId === orgId);
  },
  accountsAtAddress(address: string) {
    const a = address.toLowerCase();
    return db.accounts.filter((x) => x.address?.toLowerCase() === a);
  },
  updateAccount(id: string, patch: Partial<Account>) {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    persist();
    return a;
  },

  addContact(c: Contact) {
    db.contacts.push(c);
    persist();
    return c;
  },
  findContact(id: string) {
    return db.contacts.find((c) => c.id === id);
  },
  contactsOf(orgId: string) {
    return db.contacts.filter((c) => c.orgId === orgId);
  },
  updateContact(id: string, patch: Partial<Contact>) {
    const c = db.contacts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown contact ${id}`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    persist();
    return c;
  },
  removeContact(id: string) {
    const before = db.contacts.length;
    db.contacts = db.contacts.filter((c) => c.id !== id);
    persist();
    return db.contacts.length < before;
  },

  addDraft(d: DraftPayment) {
    db.drafts.push(d);
    persist();
    return d;
  },
  findDraft(id: string) {
    return db.drafts.find((d) => d.id === id);
  },
  draftsOf(orgId: string) {
    return db.drafts.filter((d) => d.orgId === orgId);
  },
  updateDraft(id: string, patch: Partial<DraftPayment>) {
    refuseActivityPatch(patch);
    const d = db.drafts.find((x) => x.id === id);
    if (!d) throw new Error(`unknown draft ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  /** Append to a draft's activity on the stored row, with `patch`. */
  appendDraftActivity(id: string, entry: DraftActivity, patch: Partial<DraftPayment> = {}) {
    return jsonCore.updateDraftFrom(id, patch, { from: DRAFT_STATES, activity: entry })!;
  },
  /**
   * Write a draft only from the states it may leave (§2 rule 3), and only if
   * it is still the row the caller read (`expectedUpdatedAt`) or still has
   * the drafter four eyes was checked against. Null when it moved on; the
   * caller refuses.
   */
  updateDraftFrom(id: string, patch: Partial<DraftPayment>, c: DraftCondition): DraftPayment | null {
    refuseActivityPatch(patch);
    const d = db.drafts.find((x) => x.id === id);
    if (!d) throw new Error(`unknown draft ${id}`);
    const next = draftPatchOnRow(d, patch, c);
    if (!next) return null;
    Object.assign(d, next, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  /**
   * Claim a draft for execution, synchronously.
   *
   * Same shape as claimAuthorization above and for the same reason: everything
   * from the state check to the write happens with no await between, so two
   * parallel submissions of one draft cannot both pass. Returns null when
   * somebody else already claimed it.
   *
   * `from` is the set of states this caller may claim out of: ["REVIEWED"]
   * for an org whose review policy is on, ["DRAFT", "REVIEWED"] for one
   * without. Passed in so the policy decides, but still checked here, inside
   * the same synchronous window as the write. With `expectedUpdatedAt`, a
   * draft written at all since the caller read it is not claimed either.
   */
  claimDraftExecution(
    id: string,
    from: DraftPayment["state"][] = ["REVIEWED"],
    expectedUpdatedAt?: string,
  ): DraftPayment | null {
    const d = db.drafts.find((x) => x.id === id);
    if (!d || !from.includes(d.state)) return null;
    if (expectedUpdatedAt !== undefined && d.updatedAt !== expectedUpdatedAt) return null;
    d.state = "EXECUTING";
    d.updatedAt = new Date().toISOString();
    persist();
    return d;
  },

  addInvoice(i: Invoice) {
    db.invoices.push(i);
    persist();
    return i;
  },
  findInvoice(id: string) {
    return db.invoices.find((i) => i.id === id);
  },
  findInvoiceByLinkHash(hash: string) {
    return db.invoices.find((i) => i.linkTokenHash === hash);
  },
  invoicesOf(orgId: string) {
    return db.invoices.filter((i) => i.orgId === orgId);
  },
  updateInvoice(id: string, patch: Partial<Invoice>) {
    const i = db.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    Object.assign(i, patch, { updatedAt: new Date().toISOString() });
    persist();
    return i;
  },

  /** Write an invoice only from the states it may leave; null when it moved on. */
  updateInvoiceFrom(id: string, from: readonly Invoice["state"][], patch: Partial<Invoice>) {
    const i = db.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    if (!from.includes(i.state)) return null;
    return jsonCore.updateInvoice(id, patch);
  },
  /**
   * Put a settlement on an invoice once per ref: `update` runs on the stored
   * row (domain/invoices.ts settlementUpdate). Null when the ref is there,
   * unless `replace` (rules.ts settlementOnRow).
   */
  settleInvoice(id: string, ref: string, update: (i: Invoice) => Partial<Invoice>, replace = false) {
    const i = db.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    const patch = settlementOnRow(structuredClone(i), ref, update, replace);
    return patch ? jsonCore.updateInvoice(id, structuredClone(patch)) : null;
  },
  /**
   * Start paying an invoice: from `from` to PAYING, with the draft that pays
   * it, as one write. Null (and no draft) when the invoice moved on.
   */
  startInvoicePayment(invoiceId: string, from: readonly Invoice["state"][], draft: DraftPayment) {
    const i = db.invoices.find((x) => x.id === invoiceId);
    if (!i) throw new Error(`unknown invoice ${invoiceId}`);
    if (!from.includes(i.state)) return null;
    db.drafts.push(draft);
    i.state = "PAYING";
    i.payment = { ...i.payment, draftId: draft.id };
    i.updatedAt = new Date().toISOString();
    persist();
    return { invoice: i, draft };
  },
  addImportedWallet(w: ImportedWallet) {
    db.importedWallets.push(w);
    persist();
    return w;
  },
  findImportedWallet(id: string) {
    return db.importedWallets.find((w) => w.id === id);
  },
  importedWalletsOf(orgId: string) {
    return db.importedWallets.filter((w) => w.orgId === orgId);
  },
  updateImportedWallet(id: string, patch: Partial<ImportedWallet>) {
    const w = db.importedWallets.find((x) => x.id === id);
    if (!w) throw new Error(`unknown imported wallet ${id}`);
    Object.assign(w, patch);
    persist();
    return w;
  },
  removeImportedWallet(id: string) {
    const before = db.importedWallets.length;
    db.importedWallets = db.importedWallets.filter((w) => w.id !== id);
    persist();
    return db.importedWallets.length < before;
  },

  chartOf(orgId: string) {
    return db.chartAccounts.filter((c) => c.orgId === orgId);
  },
  addChartAccount(c: ChartAccount) {
    db.chartAccounts.push(c);
    persist();
    return c;
  },
  updateChartAccount(id: string, patch: Partial<ChartAccount>) {
    const c = db.chartAccounts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown chart account ${id}`);
    Object.assign(c, patch);
    persist();
    return c;
  },
  rulesOf(orgId: string) {
    return db.accountRules.filter((r) => r.orgId === orgId);
  },
  addAccountRule(r: AccountRule) {
    db.accountRules.push(r);
    persist();
    return r;
  },
  removeAccountRule(id: string) {
    const before = db.accountRules.length;
    db.accountRules = db.accountRules.filter((r) => r.id !== id);
    persist();
    return db.accountRules.length < before;
  },
  seedChartOfAccounts(orgId: string) {
    seedChartOfAccounts(orgId);
    persist();
  },

  ledgerOf(orgId: string) {
    return db.ledger.filter((e) => e.orgId === orgId);
  },
  addLedgerEntries(entries: LedgerEntry[]) {
    db.ledger.push(...entries);
    persist();
    return entries;
  },
  updateLedgerEntry(id: string, patch: Partial<LedgerEntry>) {
    const e = db.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`unknown ledger entry ${id}`);
    Object.assign(e, patch);
    persist();
    return e;
  },
  /** Bulk replace after a rule run. Takes whole rows so one persist covers it. */
  replaceLedgerEntries(entries: LedgerEntry[]) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    db.ledger = db.ledger.map((e) => byId.get(e.id) ?? e);
    persist();
  },

  // ── Bookkeeping inputs the statement writer needs ─────────────────────────

  /** The bank facts of a processed issue order, once per order id. */
  recordMoneriumIssue(r: MoneriumIssueRecord) {
    const existing = db.moneriumIssueOrders.find((x) => x.orderId === r.orderId);
    if (existing) return existing;
    db.moneriumIssueOrders.push(r);
    persist();
    return r;
  },
  addConversionSweep(s: ConversionSweep) {
    db.conversionSweeps.push(s);
    persist();
    return s;
  },
  documentsForOrg(orgId: string) {
    return db.documents.filter((d) => d.orgId === orgId);
  },
};

/** The Postgres database when STORE_BACKEND=postgres (config/env.ts). */
const pgDatabase: Database | undefined =
  STORE_BACKEND === "postgres" ? openPool(DATABASE_URL, { ca: DATABASE_CA, realMoney: IS_REAL_MONEY_CHAIN }) : undefined;

/**
 * The store (store/backend.ts): every method async. JSON: behind one mutex,
 * over db.json. Postgres: one transaction per write over DATABASE_URL.
 */
export const store: StoreBackend = pgDatabase ? createPgStore(pgDatabase) : jsonBackend(jsonCore);

/**
 * Open the store before anything reads it. JSON: load db.json and run its
 * load-time migrations. Postgres: refuse a schema other than the migration
 * files make (store/pg/migrate.ts); the API never migrates.
 */
export async function initStore(): Promise<void> {
  if (pgDatabase) {
    // The data dir holds more than db.json (operators/enrolment.ts's token file).
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    await assertSchemaCurrent(pgDatabase);
  } else await initJsonStore();
}

/** The settings of the start lock's own connection (store/pg/start-lock.ts),
 *  or undefined on JSON, which needs none. */
export function startLockConfig() {
  return pgDatabase ? pgPoolConfig(DATABASE_URL, { ca: DATABASE_CA, realMoney: IS_REAL_MONEY_CHAIN }) : undefined;
}
