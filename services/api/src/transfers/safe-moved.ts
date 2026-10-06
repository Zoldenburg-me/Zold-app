/**
 * What a transfer took out of the user's Safe. Recovery refunds it and the
 * bank statement books it as the failed payout's debit, so both read it here.
 */
import { railFeeEur } from "../config.js";
import type { Transfer } from "../store/types.js";

/**
 * The step names for the input-funds leg, in one place.
 *
 * Recovery decides whether any money actually moved by matching these names,
 * so the producer and every consumer have to agree. A consumer looking for a
 * step the producer never writes records a €0 refund reading "nothing was
 * debited" while the EURe has already left the user's Safe — and the sweep
 * then skips it forever, because setting `refund` is what marks a transfer as
 * settled.
 *
 * Anything that adds a third funding source must add its step here.
 */
export const DEBIT_STEP = {
  safe: "safe.transfer(orchestrator)",
  /** SEPA, Safe-funded: only the fee moves, because the redeem burns the payout
   *  straight from the Safe. Recovery owes back the fee, not the whole send. */
  safeFee: "safe.transfer(fee)",
} as const;

/**
 * How much actually left the user's Safe, which is what a refund owes back.
 *
 * Not always `sendEur`: the Safe-funded SEPA rail moves only the fee and lets
 * Monerium burn the payout from the Safe directly, so refunding `sendEur` there
 * would hand back money that never moved — and would fail anyway, because the
 * orchestrator is only holding the fee.
 */
export function safeMovedEur(t: Transfer): number {
  const steps = new Set(t.txs.map((x) => x.step));
  if (steps.has(DEBIT_STEP.safe)) return t.sendEur;
  if (steps.has(DEBIT_STEP.safeFee)) {
    const payoutEur = t.receiveEur ?? t.sendEur - railFeeEur("sepa");
    return Math.max(0, Math.round((t.sendEur - payoutEur) * 100) / 100);
  }
  return 0;
}
