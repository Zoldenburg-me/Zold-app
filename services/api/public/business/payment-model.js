/**
 * One payment run's detail page, without the DOM: which run a statement line
 * came from, where each line pays, who approved it and what happens next.
 * Only what GET /drafts/:id, the contacts and the accounts return; a field
 * they do not hold is left out, never filled in.
 *
 * No imports, so scripts/business-payment-test.ts loads it in node.
 */

/** The run a statement line was sent by: its transfer is one of the run's. */
export function runIdForLine(runs, line) {
  const t = line?.links?.transferId;
  return (t && (runs || []).find((d) => (d.transferIds || []).includes(t))?.id) || null;
}

/** Where a line pays, from its contact as the contact is NOW: the IBAN and
 *  BIC are null when the contact or its bank account is gone. */
export function payee(line, contacts) {
  const c = (contacts || []).find((x) => x.id === line.contactId);
  const b = line.destination.kind === "bank" ? (c?.bankAccounts || []).find((x) => x.id === line.destination.bankAccountId) : null;
  return { name: line.destination.displayName, iban: b?.iban || null, bic: b?.bic || null, wallet: line.destination.kind === "wallet" ? line.destination.address || null : null };
}

/**
 * The approvals a run has and needs. Approving here is a member's decision
 * recorded by Zold, not a signature on the chain: the signature comes when
 * the account's signer sends it. Two are needed once the run went to review,
 * or while review is on.
 */
export function approvals(run, reviewRequired) {
  // A rejected run, or one stopped because a contact changed, is not approved, whoever looked at it.
  const reviewed = !["REJECTED", "INVALID_DATA"].includes(run.state) && !!run.reviewedByMemberId;
  // Sent (or cancelled) while review was off: turning review on later asks nothing more of it.
  const pastReview = !run.reviewedByMemberId && ["EXECUTING", "EXECUTED", "FAILED", "CANCELLED"].includes(run.state);
  const twoEyes = !pastReview && (reviewRequired || !!run.reviewedByMemberId || ["PENDING_REVIEW", "REVIEWED", "REJECTED"].includes(run.state));
  const steps = [{ role: "drafted", memberId: run.createdByMemberId, at: run.createdAt, done: true }];
  if (twoEyes) {
    steps.push(run.state === "REJECTED"
      ? { role: "rejected", memberId: run.reviewedByMemberId || null, at: run.reviewedAt || null, done: false, reason: run.rejectedReason || null }
      : { role: "approved", memberId: run.reviewedByMemberId || null, at: run.reviewedAt || null, done: reviewed });
  }
  // "executing" is written when the transfers are created, before any passkey signs:
  // only a run that was sent names its sender, and the last attempt is the one that went.
  const sent = run.state === "EXECUTED" ? [...(run.activity || [])].reverse().find((a) => a.action === "executing") : null;
  return { needed: steps.length, have: steps.filter((s) => s.done).length, steps, sentBy: sent ? { memberId: sent.actorMemberId, at: sent.at } : null };
}

/** What happens next, by state. */
export function nextStep(run, reviewRequired) {
  return {
    DRAFT: reviewRequired ? "Not submitted for approval yet." : "Saved. It is sent when someone sends it from Payments.",
    PENDING_REVIEW: "Waits for a second approval, then the account’s signer sends it.",
    REVIEWED: "Approved. It is sent when the account’s signer sends it.",
    REJECTED: "Sent back to the drafter.",
    INVALID_DATA: "Stopped: a contact’s bank details changed after it was drafted. Confirm them and submit it again.",
    EXECUTING: "Sending. Each transfer waits for the signer’s passkey.",
    EXECUTED: "Sent. Its status turns to Paid when the bank confirms.",
    FAILED: run.failureReason ? `Failed: ${run.failureReason}` : "Failed. Create a new payment to try again.",
    CANCELLED: "Cancelled before anything was sent.",
  }[run.state] || "";
}

/** The run's id from the address bar, or the one a link picked. */
export const runIdFrom = (search, picked) => new URLSearchParams(search).get("id") || picked || null;
