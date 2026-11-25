/**
 * The parts of store methods that decide something, as pure functions over
 * rows, so the JSON backend (store.ts) and the Postgres backend
 * (store/pg/backend.ts) run the same code. Each mutates the row it is given,
 * as the method body did; the backend reads and writes the row around it.
 */
import { nextProfileHistory } from "../domain/monerium-identity.js";
import { settlementRef } from "../domain/invoices.js";
import { orgEntity } from "../domain/org-entity.js";
import { copyOrgSafePlan, isOrgSafePlan } from "../domain/org-safe-plan.js";
import type { Account, DraftActivity, DraftPayment, Invoice, LedgerEntry, Member, Organisation, OrgSafePlan } from "../domain/types.js";
import { auditEntry, type AuditEntry } from "../audit.js";
import { matchesPayoutEvidence } from "../transfers/review-evidence.js";
import { OPERATOR_REFUND_STEP, REVIEW_RESOLUTION_STATES } from "./types.js";
import type { ConversionSweep, CryptoDeposit, PaymentRequest, ReviewResolutionState, Transfer, User } from "./types.js";

/** Bounds of an operator's review-resolution note. */
export const REVIEW_NOTE_MIN = 20;
export const REVIEW_NOTE_MAX = 2000;
/** Bound of the order id, tx hash or reference an operator cites. */
export const REVIEW_EVIDENCE_MAX = 200;

const bare = (v?: string) => (v ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Apply a user patch. Returns whether the IBAN was replaced (cleared counts),
 * in which case every EUR account this user backs follows it (`followIban`).
 */
export function applyUserPatch(u: User, patch: Partial<User>): boolean {
  // The one place an IBAN changes, so the one place its date is kept.
  const ibanChanged = typeof patch.iban === "string" && bare(patch.iban) !== "" && bare(patch.iban) !== bare(u.iban);
  // Cleared counts too: an org account backed by this user prints the IBAN.
  const ibanReplaced = "iban" in patch && bare(patch.iban) !== bare(u.iban);
  // The one place a Monerium profile is recorded, so the one place its
  // history is appended to. A patch cannot write the history itself.
  const { moneriumProfileHistory: _ignored, ...rest } = patch;
  const history = nextProfileHistory(u, rest, new Date().toISOString());
  Object.assign(
    u,
    rest,
    ibanChanged && !patch.ibanSince ? { ibanSince: new Date().toISOString() } : {},
    history ? { moneriumProfileHistory: history } : {},
  );
  return ibanReplaced;
}

/**
 * An org account backed by a user's Safe shows the IBAN that pays into that
 * Safe, so it follows the user's: a moved-away IBAN is taken off the account
 * (the row stays), and one attributed to the Safe again returns. True when
 * `a` was changed.
 */
export function followIban(a: Account, userId: string, userIban: string | undefined): boolean {
  if (a.backingUserId !== userId || a.currency !== "EUR") return false;
  // A wallet-connected row (gated, no IBAN) gets an IBAN only through
  // POST .../fund and its Monerium profile check, never by following.
  if (a.status === "gated" && !a.identifier?.iban) return false;
  const iban = bare(userIban) || undefined;
  Object.assign(a, { identifier: { ...a.identifier, iban }, updatedAt: new Date().toISOString() });
  return true;
}

/**
 * The patch that records a verified assertion's signCount, only while
 * `credentialId` is still the account's passkey: a recovery can replace the
 * passkey while an assertion is being verified. Undefined when it was
 * replaced; the caller refuses the assertion. The one signCount write.
 */
export function passkeyUsePatch(u: User | undefined, credentialId: string, signCount: number): Partial<User> | undefined {
  if (!u?.passkey || u.passkey.credentialId !== credentialId) return undefined;
  return { passkey: { ...u.passkey, signCount } };
}

/**
 * One guess at the email code, counted on the stored row before it is
 * compared: parallel guesses each see the ones before. Undefined when there
 * is no code for the account's address, it expired, or its guesses are
 * used up; the caller refuses the guess.
 */
export function emailCodeAttemptPatch(u: User | undefined, max: number, now: number): Partial<User> | undefined {
  const c = u?.emailCode;
  if (!c || !u.email || c.email.trim().toLowerCase() !== u.email.trim().toLowerCase()) return undefined;
  if (now > Date.parse(c.expiresAt) || c.attempts >= max) return undefined;
  return { emailCode: { ...c, attempts: c.attempts + 1 } };
}

/**
 * REFUNDED and PAID are final. A slow live leg finishing after the sweep
 * refunded the transfer must not move it back and complete a payout the
 * sender was already repaid for; the late write keeps its other fields.
 * MANUAL_REVIEW belongs to an operator: no automatic path moves it on, since
 * FAILED is what the sweep refunds. resolveTransferReview is the one way
 * out, and the state an operator resolved into is final too.
 */
export function guardTransferPatch(t: Transfer, patch: Partial<Transfer>): Partial<Transfer> {
  if (
    (t.state === "REFUNDED" || t.state === "PAID" || t.state === "MANUAL_REVIEW" || t.reviewResolution) &&
    patch.state &&
    patch.state !== t.state
  ) {
    console.error(`store: refusing to move transfer ${t.id} from ${t.state} to ${patch.state}`);
    // Omit state. Assigning `state: undefined` copies the key and erases the field.
    const { state: _dropped, ...rest } = patch;
    return rest;
  }
  return patch;
}

export type ReviewResolution = {
  state: ReviewResolutionState;
  note: string;
  by: string;
  evidence?: string;
  refund?: { amountEur: number; movedEur: number };
};
export type ReviewResult =
  | { ok: true; transfer: Transfer }
  | { ok: false; code: "NOT_FOUND" | "NOT_IN_REVIEW" | "NO_PAYOUT_EVIDENCE" }
  | { ok: false; code: "EVIDENCE_ON_RECORD"; recordedOn: string };

/** Refuse a malformed resolution before any row is read. */
export function checkReviewResolution(r: ReviewResolution): void {
  if (!(REVIEW_RESOLUTION_STATES as readonly string[]).includes(r.state)) {
    throw new Error(`a review resolves to ${REVIEW_RESOLUTION_STATES.join(", ")}, not ${r.state}`);
  }
  const note = r.note.trim();
  if (note.length < REVIEW_NOTE_MIN || note.length > REVIEW_NOTE_MAX) {
    throw new Error(`a review resolution needs a note of ${REVIEW_NOTE_MIN}-${REVIEW_NOTE_MAX} characters`);
  }
  if (!r.by) throw new Error("a review resolution names its operator");
  if (r.state === "REFUNDED") {
    const a = r.refund?.amountEur;
    if (typeof a !== "number" || !Number.isFinite(a) || a < 0 || a > (r.refund?.movedEur ?? 0) || !r.evidence?.trim()) {
      throw new Error("a review resolved as REFUNDED names the amount returned (0 up to what left the Safe) and its evidence");
    }
  }
}

/** The refund tx hash a resolution cites, which must be on no record yet. */
export function reviewRefundTx(r: ReviewResolution): string | undefined {
  const evidence = r.evidence?.trim() || undefined;
  return r.state === "REFUNDED" && evidence && /^0x[0-9a-fA-F]{64}$/.test(evidence) ? evidence : undefined;
}

/**
 * Resolve `t` out of MANUAL_REVIEW, mutating it. `recordedOn` is what
 * `hashOnRecord` says for the refund tx (`reviewRefundTx`), looked up by the
 * backend. Returns the result and, when it resolved, the audit row to append.
 */
export function applyReviewResolution(
  t: Transfer | undefined,
  r: ReviewResolution,
  recordedOn: string | undefined,
): { result: ReviewResult; audit?: AuditEntry } {
  if (!t) return { result: { ok: false, code: "NOT_FOUND" } };
  if (t.state !== "MANUAL_REVIEW" || t.reviewResolution) return { result: { ok: false, code: "NOT_IN_REVIEW" } };
  const note = r.note.trim();
  // PAID settles linked pay links, invoices and shop orders: the operator
  // cites a payout the transfer recorded as carried out (review-evidence.ts).
  const evidence = r.evidence?.trim() || undefined;
  if (r.state === "PAID" && !(evidence && matchesPayoutEvidence(t, evidence))) {
    return { result: { ok: false, code: "NO_PAYOUT_EVIDENCE" } };
  }
  // A refund tx hash is booked as the reversal and kept out of the EURe
  // arrivals, so it must be one no record holds yet: otherwise it would hide
  // a real arrival, take a debit line's link, or count for two transfers.
  const refundTx = reviewRefundTx(r);
  if (refundTx && recordedOn) return { result: { ok: false, code: "EVIDENCE_ON_RECORD", recordedOn } };
  const at = new Date().toISOString();
  t.reviewResolution = {
    state: r.state,
    note,
    by: r.by,
    at,
    ...(t.error ? { previousError: t.error } : {}),
    ...(evidence ? { evidence } : {}),
  };
  if (r.state === "REFUNDED" && r.refund) {
    const short = Math.round((r.refund.movedEur - r.refund.amountEur) * 100) / 100;
    t.refund = {
      amountEur: r.refund.amountEur,
      recoveredFrom: "operator-resolved",
      deductions: short > 0 ? `€${short.toFixed(2)} not returned` : "none",
      at,
    };
    // A fresh refund tx is booked as the reversal, not as a stray EURe
    // arrival. A partner reference stays in reviewResolution.evidence only.
    if (refundTx) t.txs.push({ step: OPERATOR_REFUND_STEP, hash: refundTx });
  }
  t.state = r.state;
  t.updatedAt = at;
  const audit = auditEntry(
    "operator.transfer_review_resolved",
    {
      transferId: t.id,
      from: "MANUAL_REVIEW",
      to: r.state,
      note,
      operator: r.by,
      ...(evidence ? { evidence } : {}),
      ...(t.refund && r.state === "REFUNDED" ? { refundedEur: t.refund.amountEur } : {}),
    },
    t.userId,
  );
  return { result: { ok: true, transfer: t }, audit };
}

/**
 * Which record already holds `hash`, among everything the bank statement
 * books hashes from (bookkeeping/statement.ts): every transfer's steps, every
 * crypto deposit's tx, conversion and steps, every sweep's conversion and
 * steps, and the ledger's own lines. Undefined when none does. Each list in
 * stored order; a backend may pass only the rows that can match.
 */
export function hashOnRecordIn(
  rows: { transfers: Transfer[]; cryptoDeposits: CryptoDeposit[]; conversionSweeps: ConversionSweep[]; ledger: LedgerEntry[] },
  hash: string,
  userId: string,
): string | undefined {
  const h = hash.toLowerCase();
  const is = (x: string | undefined) => typeof x === "string" && x.toLowerCase() === h;
  const t = rows.transfers.find((x) => x.txs.some((s) => is(s.hash)));
  if (t) return `transfer ${t.id}`;
  // The refund itself, sent to this user's Safe, is recorded by the deposit
  // scanner as a plain EURe arrival, usually before the operator resolves.
  // That one is the refund: citing it books it as the reversal instead of a
  // deposit. A deposit that is anyone else's, was converted, or pays an
  // invoice or a pay link is a different payment.
  const refundArrival = (x: CryptoDeposit) =>
    x.userId === userId && x.token === "EURE" && is(x.txHash) && !x.conversion && !x.invoiceId && !x.paymentRequestId &&
    !(x.txs ?? []).some((s) => is(s.hash));
  const d = rows.cryptoDeposits.find(
    (x) =>
      !refundArrival(x) &&
      (is(x.txHash) || is(x.conversion?.txHash) || is(x.conversion?.userOpHash) || (x.txs ?? []).some((s) => is(s.hash))),
  );
  if (d) return `deposit ${d.id}`;
  const sw = rows.conversionSweeps.find(
    (x) => is(x.conversion?.txHash) || is(x.conversion?.userOpHash) || x.txs.some((s) => is(s.hash)),
  );
  if (sw) return `sweep ${sw.id}`;
  const l = rows.ledger.find((x) => is(x.txHash));
  if (l) return `ledger line ${l.id}`;
  return undefined;
}

/**
 * Store a company org's own Safe on `o`. Refused for any other org, for a
 * plan of the wrong shape, and for a different address once one is stored:
 * the money is on that Safe, so re-pointing the org would leave it behind.
 * The owner list may change (membership drives it); the address never does.
 */
export function applyOrgSafePlan(o: Organisation | undefined, orgId: string, plan: OrgSafePlan): Organisation {
  if (!o) throw new Error(`unknown organisation ${orgId}`);
  if (orgEntity(o) !== "company") throw new Error(`organisation ${orgId} is not a company and has no Safe of its own`);
  if (!isOrgSafePlan(plan)) throw new Error("not a valid org Safe plan");
  if (o.safe && o.safe.address.toLowerCase() !== plan.address.toLowerCase()) {
    throw new Error(`organisation ${orgId} already has its Safe at ${o.safe.address}`);
  }
  if (o.safe?.status === "active" && plan.status !== "active") throw new Error(`organisation ${orgId}'s Safe is deployed; it cannot go back to planned`);
  o.safe = { ...copyOrgSafePlan(plan), createdAt: o.safe?.createdAt ?? plan.createdAt };
  o.updatedAt = new Date().toISOString();
  return o;
}

/**
 * Re-plan a company's Safe whose deploying owner has left, at a new address.
 * Only a `planned` plan at `oldAddress`, and only once the caller has read
 * the chain and found nothing there: no money can be at a Safe that does not
 * exist. A deployed Safe is never re-pointed.
 */
export function applyReplacedOrgSafePlan(o: Organisation | undefined, orgId: string, oldAddress: string, plan: OrgSafePlan): Organisation {
  if (!o) throw new Error(`unknown organisation ${orgId}`);
  if (!o.safe || o.safe.status !== "planned" || o.safe.address.toLowerCase() !== oldAddress.toLowerCase()) {
    throw new Error(`organisation ${orgId} has no planned Safe at ${oldAddress} to replace`);
  }
  if (!isOrgSafePlan(plan) || plan.status !== "planned") throw new Error("a replacement Safe plan is a valid, planned one");
  o.safe = copyOrgSafePlan(plan);
  o.updatedAt = new Date().toISOString();
  return o;
}

/** A session (user or operator) that can no longer authenticate anything,
 *  dead for longer than `retainMs`. */
export function sessionDead(s: { revokedAt?: string; expiresAt: string }, retainMs: number, now = Date.now()): boolean {
  const dead = s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
  return Number.isFinite(dead) && dead < now - retainMs;
}

/**
 * A transfer's step log only grows. A patch carrying `txs` is the caller's
 * view of it, read before an await: every stored step is kept, in order, and
 * the caller's steps the row does not hold yet (counted with multiplicity,
 * by step and hash) are appended. A step both hold keeps the fields either
 * gave it (the caller may have added `outputLogIndexes`; a stale copy without
 * them removes nothing). An executor's and a compensator's steps written from
 * two stale copies both survive (§2 rule 2).
 */
export function mergeTransferSteps(stored: Transfer["txs"], given: Transfer["txs"]): Transfer["txs"] {
  const key = (x: Transfer["txs"][number]) => `${x.step}\u0000${x.hash}`;
  const slots = new Map<string, number[]>();
  stored.forEach((x, i) => slots.set(key(x), [...(slots.get(key(x)) ?? []), i]));
  const out = [...stored];
  for (const x of given) {
    const i = slots.get(key(x))?.shift();
    if (i === undefined) out.push(x);
    else out[i] = { ...out[i], ...x };
  }
  return out;
}

/** What may be patched into a transfer, with `txs` merged into the row's. */
export function transferPatchOnRow(t: Transfer, patch: Partial<Transfer>): Partial<Transfer> {
  const guarded = guardTransferPatch(t, patch);
  return guarded.txs ? { ...guarded, txs: mergeTransferSteps(t.txs, guarded.txs) } : guarded;
}

/** The conditions a conditional draft write checks on the stored row. */
export type DraftCondition = {
  /** The states the draft may be in. */
  from: readonly DraftPayment["state"][];
  /** Refused when the draft was written at all since the caller read it. */
  expectedUpdatedAt?: string;
  /** Refused when someone else became the drafter (four eyes). */
  drafter?: string;
  /** Appended to the stored activity, never written over it. */
  activity?: DraftActivity;
};

/** The draft patch to write, or null when a condition no longer holds. */
export function draftPatchOnRow(d: DraftPayment, patch: Partial<DraftPayment>, c: DraftCondition): Partial<DraftPayment> | null {
  if (!c.from.includes(d.state)) return null;
  if (c.expectedUpdatedAt !== undefined && d.updatedAt !== c.expectedUpdatedAt) return null;
  if (c.drafter !== undefined && d.createdByMemberId !== c.drafter) return null;
  return c.activity ? { ...patch, activity: [...d.activity, c.activity] } : patch;
}

/** A draft's activity is appended to on the stored row, never replaced. */
export function refuseActivityPatch(patch: Partial<DraftPayment>) {
  if ("activity" in patch) throw new Error("a draft's activity is appended through appendDraftActivity or updateDraftFrom");
}

/**
 * Cancel an open request that nothing has paid; a payment recorded meanwhile
 * keeps it. A Shopify order cancel leaves a request past its expiry EXPIRED
 * (`evenIfExpired` false); the payee's own cancel takes a stored OPEN one.
 */
export function cancelUnpaidOnRow(r: PaymentRequest, now: Date, evenIfExpired = false): Partial<PaymentRequest> | null {
  if (r.state !== "OPEN" || r.payments.length > 0) return null;
  if (!evenIfExpired && Date.parse(r.expiresAt) <= now.getTime()) return null;
  return { state: "CANCELLED", cancelledAt: now.toISOString() };
}

/** An invite spent once, by one user, while it is still the row's invite. */
export function acceptInviteOnRow(m: Member, tokenHash: string, userId: string, others: Member[], at: string): Partial<Member> | null {
  if (m.status !== "invited" || m.invite?.tokenHash !== tokenHash) return null;
  if (others.some((x) => x.id !== m.id && x.userId === userId && x.status !== "deactivated")) return null;
  return { userId, status: "active", acceptedAt: at, invite: undefined };
}

/**
 * An invoice settlement, computed from the stored row: recorded once per ref,
 * or, with `replace`, rewritten under its ref (a converted deposit).
 */
export function settlementOnRow(i: Invoice, ref: string, update: (i: Invoice) => Partial<Invoice>, replace = false): Partial<Invoice> | null {
  if (!replace && (i.settlements ?? []).some((s) => settlementRef(s) === ref)) return null;
  return update(i);
}
