/**
 * What a transfer's owner sees of it. `reviewResolution` is the operator's
 * record (note, operator label, the error it was resolved from) and stays
 * server-side: the owner sees the state it resolved into, which `state`
 * already carries. Every user-facing route returns a transfer through this.
 */
import type { Transfer } from "../store/types.js";

/** The operator's step on a Stellar payout that may already have been paid.
 *  It ends the stored `error`, which the admin view shows in full. */
export const OPERATOR_TREASURY_CHECK = "check the treasury account before paying again or refunding";

/** What the sender reads instead: never an invitation to send again. */
export const SENDER_PAYOUT_REVIEW = "This payout is under review. Don't send it again; we'll update this transfer.";

export type UserTransfer = Omit<Transfer, "reviewResolution">;

export function userTransfer(t: Transfer): UserTransfer {
  const { reviewResolution: _operatorOnly, ...visible } = t;
  if (visible.error?.includes(OPERATOR_TREASURY_CHECK)) visible.error = SENDER_PAYOUT_REVIEW;
  return visible;
}
