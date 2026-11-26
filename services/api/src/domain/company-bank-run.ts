/**
 * A company bank run (routes/business/org-monerium-bank-runs.ts), read from
 * the draft row alone.
 *
 * Q9 asks that a draft pay all its lines or none. A bank run cannot promise
 * that: each line is its own Monerium redeem order, and a SEPA order Monerium
 * accepted cannot be called back by Zold. The rule is therefore:
 *  - everything is checked for every line before any order is asked for
 *    (keys, IBAN, Safe and threshold, role, review, payees and their
 *    fingerprints, the balance across all lines), and the owner's passkey
 *    signs every line before the first one is sent;
 *  - the lines are sent one at a time, in order, and the run stops at the
 *    first line Monerium does not accept (`failed` or `unknown`): no later
 *    line is sent, ever;
 *  - lines already accepted stay accepted, and the run then reads FAILED with
 *    each line's state, so a new payment pays only the lines not sent;
 *  - an `unknown` line is never retried: Monerium may hold the order.
 */
import type { BankRunLineState, CompanyBankPayout, CompanyBankRun, DraftState } from "./types.js";
import { redeemMessageStale } from "../sepa.js";

/** At most this many lines in one company bank run. Each line is its own
 *  passkey prompt, and every prompt must be signed inside Monerium's window
 *  for one redeem message, counted from when the run was started. */
export const COMPANY_BANK_RUN_MAX_LINES = 10;

/** A line as it stands now. Past the approval window, the process that held
 *  the run may have stopped: a `signed` line can never be sent, and a
 *  `sending` line may have reached Monerium, so it is unclear. */
export function bankRunLineState(run: CompanyBankRun, line: CompanyBankRun["lines"][number], nowMs = Date.now()): BankRunLineState {
  if (!redeemMessageStale(run.issuedAt, nowMs)) return line.state;
  return line.state === "signed" ? "not_sent" : line.state === "sending" ? "unknown" : line.state;
}

/** The run's draft state: EXECUTED once Monerium processed every line,
 *  FAILED once any line cannot be paid (or may not have been), EXECUTING
 *  otherwise. */
export function bankRunDraftState(run: CompanyBankRun, nowMs = Date.now()): DraftState {
  const states = run.lines.map((l) => bankRunLineState(run, l, nowMs));
  if (states.some((s) => s === "failed" || s === "unknown" || s === "not_sent")) return "FAILED";
  if (states.every((s) => s === "sent")) return "EXECUTED";
  return "EXECUTING";
}

/** The run with a line's state as its payout row now says. */
export function withPayoutState(run: CompanyBankRun, payout: CompanyBankPayout): CompanyBankRun {
  return {
    ...run,
    lines: run.lines.map((l) =>
      l.payoutId === payout.id
        ? {
          ...l,
          state: payout.state,
          ...(payout.orderId ? { orderId: payout.orderId } : {}),
          ...(payout.processedAt ? { processedAt: payout.processedAt } : {}),
          ...(payout.error ? { error: payout.error } : { error: undefined }),
        }
        : l),
  };
}

/** The run with one line marked `sending`, before its order is asked for. */
export function markSending(run: CompanyBankRun, payoutId: string): CompanyBankRun {
  return { ...run, lines: run.lines.map((l) => (l.payoutId === payoutId ? { ...l, state: "sending" } : l)) };
}

/** Every line still `signed` marked `not_sent`: the run stopped before them. */
export function stopRun(run: CompanyBankRun, why: string): CompanyBankRun {
  return { ...run, lines: run.lines.map((l) => (l.state === "signed" ? { ...l, state: "not_sent", error: why } : l)) };
}

const WORD: Record<BankRunLineState, string> = {
  signed: "waiting to be sent",
  sending: "being sent",
  sent: "sent",
  pending: "accepted by Monerium, not yet sent",
  failed: "not sent",
  unknown: "unclear: check Monerium before paying it again",
  not_sent: "not sent",
};

/** What each line did, by payee, for a run that did not pay every line. */
export function bankRunReport(run: CompanyBankRun, nowMs = Date.now()): string {
  // A holder name comes from suppliers: it must not write a heading of its own.
  const name = (l: CompanyBankRun["lines"][number]) => `${l.recipientName.replace(/[.:,()€]/g, "").slice(0, 70)} €${l.amountEur.toFixed(2)}`;
  const groups = new Map<string, string[]>();
  for (const l of run.lines) {
    const w = WORD[bankRunLineState(run, l, nowMs)];
    groups.set(w, [...(groups.get(w) ?? []), name(l)]);
  }
  const parts = [...groups].map(([w, names]) => `${w[0].toUpperCase()}${w.slice(1)}: ${names.join(", ")}.`);
  if (run.lines.some((l) => ["failed", "not_sent"].includes(bankRunLineState(run, l, nowMs)))) {
    parts.push("Create a new payment for the not sent lines only.");
  }
  return parts.join(" ");
}

/** The run as a member sees it: no signed message, no memo. */
export function publicBankRun(run: CompanyBankRun, nowMs = Date.now()) {
  return {
    issuedAt: run.issuedAt,
    signedByMemberId: run.signedByMemberId,
    lines: run.lines.map((l) => ({
      lineId: l.lineId,
      payoutId: l.payoutId,
      amountEur: l.amountEur,
      recipientName: l.recipientName,
      recipientIban: l.recipientIban,
      state: bankRunLineState(run, l, nowMs),
      ...(l.orderId ? { orderId: l.orderId } : {}),
      ...(l.error ? { error: l.error } : {}),
    })),
  };
}
