/**
 * What an operator may cite to resolve a MANUAL_REVIEW transfer as PAID: an
 * identifier the transfer itself recorded when the payout went out. A
 * Monerium order id (`monerium.redeem.placed`, `sepa.orderId`), a Bridge
 * destination tx (`bridge.xyz.destination_tx`, `pickup.bridgeDestinationTxHash`)
 * or the anchor payment hash (`pickup.anchorPaymentHash`). A transfer with
 * none of these has no recorded payout and cannot be marked PAID.
 */
import type { Transfer } from "../store/types.js";

const PAYOUT_STEPS = new Set(["monerium.redeem.placed", "bridge.xyz.destination_tx"]);

const norm = (s: string) => s.trim().toLowerCase();

export function payoutEvidence(t: Transfer): string[] {
  const recorded = [
    ...t.txs.filter((x) => PAYOUT_STEPS.has(x.step)).map((x) => x.hash),
    t.sepa?.orderId,
    t.pickup?.bridgeDestinationTxHash,
    t.pickup?.anchorPaymentHash,
  ];
  return [...new Set(recorded.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x !== "0x"))];
}

/** Whether `evidence` names one of the payout identifiers the transfer recorded. */
export function matchesPayoutEvidence(t: Transfer, evidence: string): boolean {
  const e = norm(evidence);
  return e !== "" && payoutEvidence(t).some((x) => norm(x) === e);
}
