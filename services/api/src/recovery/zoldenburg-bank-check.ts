/**
 * Phase 1 of docs/recovery-guardians-plan.md, recovery: the second 1 €.
 *
 * Someone asking Zoldenburg to recover an account proves they hold the bank
 * account the owner enrolled (zoldenburg-enrolment.ts): they send at least
 * 1 € from it to the account's Zold IBAN, with a recovery code as the
 * reference. The operator cannot sign until this has passed
 * (routes/recovery-zoldenburg.ts).
 *
 * - The recovery code is a credential like the enrolment code: 40 random
 *   bits, shown once, stored as a hash, and its purpose is in the hash.
 * - The payer's IBAN must give the enrolled HMAC under the key in use, and
 *   the payer's name must match the name Monerium verified, read live.
 * - A pass is bound to the enrolment it matched: if the owner re-enrols
 *   afterwards, the pass no longer counts.
 * - Fail closed: an unreadable Monerium connection or profile name leaves the
 *   check open with a reason. It never passes on a failed read.
 */
import { timingSafeEqual } from "node:crypto";
import { store, type RecoveryRequest, type User } from "../store.js";
import type { MoneriumOrderLike } from "../domain/invoices.js";
import { describeCause } from "../http/log-cause.js";
import {
  ENROLMENT,
  inTime,
  judgeEnrolmentOrder,
  memoFor,
  moneriumReads,
  newEnrolmentCode,
  ordersCarrying,
  type EnrolmentReads,
  type OrderVerdict,
} from "./zoldenburg-enrolment.js";
import { bankAccountHmac, ibanKeyId, zoldenburgArmed } from "./enrolment-key.js";

type BankCheck = NonNullable<NonNullable<RecoveryRequest["zoldenburg"]>["bankCheck"]>;

/** Requests whose second 1 € is still looked for. */
const CHECKED_STATUS = "REVIEW_PENDING";

/** Each code costs the owner's Monerium connection a read, so a request
 *  gets a bounded number of them. */
export const RECOVERY_BANK = { maxCodes: 5 };

const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/**
 * Is this order the second 1 € from the enrolled account? The enrolment rules
 * apply first (amount, payer IBAN and name reported, not the Zold IBAN, name
 * matches), then the account must be the enrolled one.
 */
export function judgeRecoveryOrder(o: MoneriumOrderLike, user: User, profileName: string): OrderVerdict {
  const verdict = judgeEnrolmentOrder(o, user, profileName);
  if (!verdict.ok) return verdict;
  const e = user.zoldenburgEnrolment;
  if (!e?.bankAccountHmac || e.keyId !== ibanKeyId()) {
    return { ok: false, reason: "This account never confirmed a bank account for recovery, so no payment can prove it is yours." };
  }
  if (!sameHex(bankAccountHmac(verdict.iban), e.bankAccountHmac)) {
    // No digits of the enrolled account: whoever reads this may know no
    // more than the account's email.
    return { ok: false, reason: "The payment came from a different bank account. Send it from the account you confirmed when you set up recovery." };
  }
  return verdict;
}

/** Has this request's second 1 € passed, against the enrolment in force now? */
export function bankCheckPassed(r: RecoveryRequest, user: User | undefined): boolean {
  const b = r.zoldenburg?.bankCheck;
  return Boolean(user && zoldenburgArmed(user) && b?.passedAt && b.enrolledAt === user.zoldenburgEnrolment?.enrolledAt);
}

/** May this request be given another code? */
export const canIssueRecoveryBankCode = (r: RecoveryRequest) =>
  (r.zoldenburg?.bankCheck?.codesIssued ?? 0) < RECOVERY_BANK.maxCodes;

/** Issue a code for this request, replacing any open one. The plain code is
 *  returned once. The caller refuses a request whose check already passed,
 *  or that has had its codes. */
export function issueRecoveryBankCode(r: RecoveryRequest, now = new Date()): { code: string; memo: string } {
  const { code, hash } = newEnrolmentCode("recovery");
  const fresh = store.findRecoveryRequest(r.id)!;
  const before = fresh.zoldenburg?.bankCheck;
  store.updateRecoveryRequest(r.id, {
    zoldenburg: {
      ...fresh.zoldenburg,
      bankCheck: {
        code: { hash, issuedAt: now.toISOString() },
        ...(before?.code ? { earlierCodes: [...(before.earlierCodes ?? []), before.code] } : {}),
        codesIssued: (before?.codesIssued ?? 0) + 1,
        ...(before?.lastReadAt ? { lastReadAt: before.lastReadAt } : {}),
      },
    },
  });
  return { code, memo: memoFor(code) };
}

export type BankCheckOutcome = "passed" | "waiting" | "mismatch" | "unreadable" | "no_code";

const inFlight = new Set<string>();

/** Look for the payment of this request's open code and record what was found. */
export async function checkRecoveryBankPayment(
  requestId: string,
  reads: EnrolmentReads = moneriumReads,
  now = new Date(),
): Promise<BankCheckOutcome> {
  const r = store.findRecoveryRequest(requestId);
  const code = r?.zoldenburg?.bankCheck?.code;
  const user = r && store.findUser(r.userId);
  if (!r || !user || !code || r.mode !== "zoldenburg" || r.status !== CHECKED_STATUS || now.getTime() >= Date.parse(r.expiresAt)) {
    return "no_code";
  }
  if (inFlight.has(requestId)) return "waiting";
  inFlight.add(requestId);
  // Written only while this code still owns the request: a newer code, or a
  // request that moved on while the reads ran, is left as it is.
  const stillOpen = () => {
    const fresh = store.findRecoveryRequest(requestId)!;
    return fresh.status === CHECKED_STATUS && fresh.zoldenburg?.bankCheck?.code?.hash === code.hash ? fresh : undefined;
  };
  const record = (outcome: "waiting" | "mismatch" | "unreadable", reason: string) => {
    const fresh = stillOpen();
    if (!fresh) return outcome;
    store.updateRecoveryRequest(requestId, {
      zoldenburg: { ...fresh.zoldenburg, bankCheck: { ...fresh.zoldenburg!.bankCheck, lastCheck: { at: now.toISOString(), outcome, reason } } },
    });
    return outcome;
  };
  // The throttle's clock, set before Monerium is asked.
  store.updateRecoveryRequest(requestId, { zoldenburg: { ...r.zoldenburg, bankCheck: { ...r.zoldenburg!.bankCheck, lastReadAt: now.toISOString() } } });
  try {
    if (!zoldenburgArmed(user)) {
      return record("mismatch", "This account never confirmed a bank account for Zoldenburg recovery, so Zoldenburg cannot recover it.");
    }
    let orders: MoneriumOrderLike[];
    try {
      orders = await inTime(reads.orders(user));
    } catch (err) {
      console.warn(`recovery ${requestId}: could not read orders for ${user.id}: ${describeCause(err)}`);
      return record("unreadable", "We could not read the account's payments at Monerium. We will try again; if this stays, contact support.");
    }
    const codes = [code, ...(r.zoldenburg!.bankCheck!.earlierCodes ?? [])];
    const seen = new Set<string>();
    const found = codes
      .flatMap((c) => ordersCarrying(orders, user, c, "recovery"))
      .filter((o) => !seen.has(o.id) && Boolean(seen.add(o.id)));
    if (!found.length) return record("waiting", "No payment with your code has arrived yet. A bank transfer can take a working day.");
    let name: string | undefined;
    try {
      name = await inTime(reads.profileName(user));
    } catch (err) {
      console.warn(`recovery ${requestId}: could not read the Monerium profile for ${user.id}: ${describeCause(err)}`);
    }
    if (!name) return record("unreadable", "Your payment arrived, but we could not read the verified name at Monerium. We will try again.");
    let reason = "";
    for (const o of found) {
      const verdict = judgeRecoveryOrder(o, user, name);
      if (!verdict.ok) {
        reason = verdict.reason;
        continue;
      }
      const fresh = stillOpen();
      if (!fresh) return "no_code";
      // The code is spent: the pass replaces it.
      const { codesIssued, lastReadAt } = fresh.zoldenburg!.bankCheck!;
      const passed: BankCheck = { codesIssued, lastReadAt, passedAt: now.toISOString(), orderId: o.id, enrolledAt: user.zoldenburgEnrolment!.enrolledAt };
      store.updateRecoveryRequest(requestId, { zoldenburg: { ...fresh.zoldenburg, bankCheck: passed } });
      console.log(`RECOVERY: ${requestId} passed the 1 € check from the enrolled account (order ${o.id})`);
      return "passed";
    }
    return record("mismatch", reason);
  } finally {
    inFlight.delete(requestId);
  }
}

/** Check every open recovery code. Returns how many passed. */
export async function sweepRecoveryBankChecks(reads: EnrolmentReads = moneriumReads, sweepNow?: Date): Promise<number> {
  let passed = 0;
  for (const r of [...store.recoveryRequests]) {
    if (r.mode !== "zoldenburg" || r.status !== CHECKED_STATUS || !r.zoldenburg?.bankCheck?.code) continue;
    const now = sweepNow ?? new Date();
    if (now.getTime() >= Date.parse(r.expiresAt)) continue;
    try {
      if ((await checkRecoveryBankPayment(r.id, reads, now)) === "passed") passed++;
    } catch (err) {
      console.error(`recovery ${r.id}: 1 € check failed: ${describeCause(err)}`);
    }
  }
  return passed;
}

/**
 * What the person recovering sees. They hold the request's secret, which
 * anyone who knows the account's email can get, so nothing of either IBAN
 * appears: the real owner knows their bank account, sent the enrolment 1 €
 * to their Zold IBAN, and Monerium shows it to them.
 */
export function bankCheckView(r: RecoveryRequest, user: User | undefined) {
  const b = r.zoldenburg?.bankCheck;
  return {
    minimumEur: ENROLMENT.minimumEur,
    passed: bankCheckPassed(r, user),
    canIssueCode: !bankCheckPassed(r, user) && canIssueRecoveryBankCode(r),
    ...(b?.passedAt ? { passedAt: b.passedAt } : {}),
    ...(b?.code ? { codeIssuedAt: b.code.issuedAt } : {}),
    ...(b?.code && b.lastCheck ? { lastCheck: b.lastCheck } : {}),
  };
}
