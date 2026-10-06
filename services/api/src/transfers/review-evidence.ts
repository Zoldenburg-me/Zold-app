/**
 * What an operator may cite to resolve a MANUAL_REVIEW transfer as PAID: an
 * identifier the transfer recorded for a payout that was carried out.
 *
 * - The Monerium redeem order id (`sepa.orderId`), only while the order
 *   state read back from Monerium (`sepa.state`) is `processed`. A placed
 *   order (`monerium.redeem.placed`) proves only that Monerium accepted it.
 * - The Bridge destination tx of the `bridge.xyz.destination_tx` step: the
 *   destination transaction Bridge reported on the transfer.
 *   `pickup.bridgeDestinationTxHash` is a plan field and is not accepted.
 * - The anchor payment hash (`pickup.anchorPaymentHash`).
 *
 * A transfer with none of these has no proven payout and cannot be marked PAID.
 */
import type { Transfer } from "../store/types.js";
import { moneriumOrderProcessed } from "../domain/monerium-order.js";

const norm = (s: string) => s.trim().toLowerCase();

export function payoutEvidence(t: Transfer): string[] {
  const recorded = [
    moneriumOrderProcessed(t.sepa?.state) ? t.sepa?.orderId : undefined,
    ...t.txs.filter((x) => x.step === "bridge.xyz.destination_tx").map((x) => x.hash),
    t.pickup?.anchorPaymentHash,
  ];
  return [...new Set(recorded.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x !== "0x"))];
}

/** Whether `evidence` names one of the payout identifiers the transfer recorded. */
export function matchesPayoutEvidence(t: Transfer, evidence: string): boolean {
  const e = norm(evidence);
  return e !== "" && payoutEvidence(t).some((x) => norm(x) === e);
}
