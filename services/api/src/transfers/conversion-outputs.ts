import type { CryptoDeposit, Transfer } from "../store/types.js";

/** A compensation's reverse swap, any venue: USDC back to EURe into the Safe. */
export const isReverseSwapStep = (step: string) => step.startsWith("liquidity.") && step.endsWith(".usdc-eure");

/**
 * Is this EURe log, to this user, a conversion's output? Then it is not money
 * in. Settling a swap writes the log indexes it delivered onto the deposit's
 * swap step; any other EURe log in that transaction (another userOp in the
 * bundle) is money in. A swap step without them (still settling,
 * unconfirmed, or from before they were kept) covers every EURe log in its
 * transaction to that deposit's user, never anyone else's.
 *
 * A failed transfer's reverse swap is the same: its EURe output is the
 * refund, the user's own money changing form back, and its step carries the
 * log indexes once measured.
 */
export function conversionOutputs(
  deposits: CryptoDeposit[],
  transfers: Transfer[] = [],
): (txHash: string, logIndex: number, userId: string) => boolean {
  const exact = new Set<string>();
  const whole = new Set<string>();
  const mark = (t: { hash: string; outputLogIndexes?: number[] }, userId: string, indexed?: Set<string>) => {
    const tx = t.hash.toLowerCase();
    if (t.outputLogIndexes) {
      indexed?.add(tx);
      for (const i of t.outputLogIndexes) exact.add(`${tx}:${i}`);
    } else whole.add(`${tx}:${userId}`);
  };
  for (const d of deposits) {
    const indexed = new Set<string>();
    for (const t of d.txs ?? []) if (t.step === "safe.swap(usdc->eure)") mark(t, d.userId, indexed);
    for (const c of [d.conversion, ...(d.partials ?? []).map((p) => p.conversion)]) {
      const tx = c?.txHash?.toLowerCase();
      if (tx && !indexed.has(tx)) whole.add(`${tx}:${d.userId}`);
    }
  }
  for (const t of transfers) for (const x of t.txs ?? []) if (isReverseSwapStep(x.step)) mark(x, t.userId);
  return (txHash, logIndex, userId) => {
    const tx = txHash.toLowerCase();
    return exact.has(`${tx}:${logIndex}`) || whole.has(`${tx}:${userId}`);
  };
}
