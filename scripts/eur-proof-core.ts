/**
 * The checks eur:proof makes, without the network: what the Safe should hold
 * after Monerium's processed orders, and whether each processed redeem carries
 * the memo its transfer signed. Pure, so eur-proof-core-test runs them offline.
 */
import { moneriumAmountEur, redeemMemoDiffers } from "../services/api/src/domain/monerium-order.js";

/** This Safe's orders on the configured chain. A Safe has the same address on
 *  every EVM chain and one Monerium profile spans them, so matching on the
 *  address alone would count another chain's mint or burn against this
 *  chain's balance. An order that names no chain is not counted. */
export function ordersOn(orders: any[], address: string, chain: string): any[] {
  const a = address.toLowerCase();
  return orders.filter((o) => typeof o?.address === "string" && o.address.toLowerCase() === a && o.chain === chain);
}

/** The proof's exit status: 1 when any leg failed, whatever else is still
 *  pending; 0 when nothing failed and a processed redeem was compared; 2
 *  (not done yet: a manual step or a wait) otherwise. */
export function proofExit(failures: number, processedRedeems: number): 0 | 1 | 2 {
  if (failures) return 1;
  return processedRedeems ? 0 : 2;
}

/** Half a cent: Monerium amounts have two decimals, balances have 18. */
export const EUR_TOLERANCE = 0.005;

/** Why the on-chain balance is not issued minus redeemed, or undefined when it
 *  is. Two-sided on purpose: less means EURe left without a Monerium burn (or a
 *  mint did not land), more means a redeem Monerium calls processed burned
 *  nothing, or EURe arrived from outside Monerium. Either way the balance no
 *  longer proves the mint and the burn. */
export function ledgerGap(issues: any[], redeems: any[], onChain: number): string | undefined {
  const sum = (orders: any[]) => {
    let s = 0;
    for (const o of orders) {
      const a = moneriumAmountEur(o.amount);
      if (a === undefined) return undefined;
      s += a;
    }
    return s;
  };
  const issued = sum(issues);
  const redeemed = sum(redeems);
  if (issued === undefined || redeemed === undefined) return "an order's amount is not a plain decimal; nothing is compared";
  const expected = issued - redeemed;
  const eur = (n: number) => `EUR ${n.toFixed(2)}`;
  if (onChain <= 0 && expected > EUR_TOLERANCE) {
    return `Monerium issued ${eur(issued)} and redeemed ${eur(redeemed)}, but the Safe holds nothing: the mint did not land`;
  }
  if (onChain + EUR_TOLERANCE < expected) {
    return `the Safe holds ${eur(onChain)}, less than the ${eur(expected)} Monerium issued (${eur(issued)}) minus redeemed (${eur(redeemed)})`;
  }
  if (onChain > expected + EUR_TOLERANCE) {
    return `the Safe holds ${eur(onChain)}, more than the ${eur(expected)} Monerium issued (${eur(issued)}) minus redeemed (${eur(redeemed)}): a redeem did not burn, or EURe came from outside Monerium`;
  }
  return undefined;
}

/** Every processed redeem, matched to the transfer that placed it by order id.
 *  A matched one carries `differs` (redeemMemoDiffers, as the poller judges it)
 *  or none; an order with no local transfer is listed, never compared. */
export function memoChecks(
  done: any[],
  signedFor: (orderId: string) => { memo: string | undefined } | undefined,
): { matched: { id: string; memo: string | undefined; differs: string | undefined }[]; unmatched: string[] } {
  const matched: { id: string; memo: string | undefined; differs: string | undefined }[] = [];
  const unmatched: string[] = [];
  for (const o of done) {
    const t = signedFor(o.id);
    if (!t) unmatched.push(o.id);
    else matched.push({ id: o.id, memo: t.memo, differs: redeemMemoDiffers(o, t.memo) });
  }
  return { matched, unmatched };
}
