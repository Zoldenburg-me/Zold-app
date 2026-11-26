/**
 * Attach a Monerium redeem order the transfer never recorded, so an operator
 * can resolve it as PAID (review-evidence.ts).
 *
 * This happens when the answer to POST /orders was lost: the transfer went to
 * MANUAL_REVIEW with no order id while Monerium holds, and may have paid, the
 * order. The operator names the order id; that id alone proves nothing. The
 * order is read back from Monerium on the account's own authenticated client
 * and must be the one this transfer signed for: a processed redeem in EUR of
 * the signed amount, from this Safe on our chain, to the signed IBAN, with
 * this transfer's payment memo. An order already on another transfer is
 * refused. Only then is it recorded on the transfer. Moves no money.
 */
import { MONERIUM } from "../config.js";
import { store, type Transfer, type User } from "../store.js";
import { isMoneriumOrderId, MoneriumAccessError, MoneriumApiError, moneriumFailureReason, type MoneriumOrder } from "../adapters/monerium-client.js";
import { readOrder } from "../adapters/monerium-sandbox.js";
import { moneriumOrderProcessed, redeemOrderDiffers } from "../domain/monerium-order.js";
import { paymentMemo } from "../sepa.js";

export type AttachOutcome =
  | { ok: true }
  /** Not this transfer's processed redeem order, or no such order. */
  | { ok: false; code: "NOT_THIS_ORDER"; reason: string }
  /** The account has no working Monerium connection (none, or its token was
   *  refused); nothing changed, and a retry fails the same way until the user
   *  connects again. */
  | { ok: false; code: "NOT_CONNECTED" }
  /** Monerium answered 403 to the order read: the account's token may lack
   *  the scope, or the order is not this account's. Nothing changed. */
  | { ok: false; code: "READ_REFUSED" }
  /** Monerium could not be read; nothing changed, the operator may retry. */
  | { ok: false; code: "UNAVAILABLE" };

/** Whether `t` may have an order attached at all: a SEPA transfer in
 *  unresolved review that signed a redeem and recorded no order. */
export function mayAttachRedeemOrder(t: Transfer): boolean {
  return t.rail === "sepa" && t.state === "MANUAL_REVIEW" && !t.reviewResolution && !t.sepa?.orderId && Boolean(t.moneriumRedeem);
}

/** Which transfer, other than `t`, already records order `orderId`. */
function orderOwner(orderId: string, t: Transfer): Transfer | undefined {
  return store.transfers.find(
    (x) =>
      x.id !== t.id &&
      (x.sepa?.orderId === orderId ||
        x.reviewResolution?.evidence === orderId ||
        x.txs.some((s) => s.step === "monerium.redeem.placed" && s.hash === orderId)),
  );
}

/** Why `order` is not the redeem `t` signed, or undefined when it is. Names
 *  the field only: the values are Monerium's and the payee's. */
export function redeemOrderMismatch(t: Transfer, user: User, orderId: string, order: MoneriumOrder): string | undefined {
  const signed = t.moneriumRedeem;
  if (!signed) return "the transfer signed no redeem";
  if (order?.id !== orderId) return "order id";
  const differs = redeemOrderDiffers(order, signed, user.address);
  if (differs) return differs;
  if (!moneriumOrderProcessed(order.meta?.state ?? order.state)) return "state (not processed)";
  if (order.chain !== MONERIUM.chain) return "chain";
  if (order.memo !== paymentMemo(t.id, t.reference)) return "payment memo";
  return undefined;
}

export async function attachRedeemOrder(transferId: string, orderId: string): Promise<AttachOutcome> {
  const before = store.findTransfer(transferId);
  const user = before && store.findUser(before.userId);
  if (!before || !user || !mayAttachRedeemOrder(before)) {
    return { ok: false, code: "NOT_THIS_ORDER", reason: "the transfer has no unrecorded redeem order" };
  }
  if (!isMoneriumOrderId(orderId)) return { ok: false, code: "NOT_THIS_ORDER", reason: "not a Monerium order id" };
  if (orderOwner(orderId, before)) return { ok: false, code: "NOT_THIS_ORDER", reason: "the order is on another transfer" };
  let order: MoneriumOrder;
  try {
    order = await readOrder(orderId, user);
  } catch (err) {
    // The status alone is logged: a refusal's body is Monerium's, not ours.
    // Only a transient (5xx, 429, a timeout) is worth retrying.
    const status = err instanceof MoneriumApiError ? err.status : 0;
    if (status === 404) return { ok: false, code: "NOT_THIS_ORDER", reason: "Monerium has no such order" };
    console.warn(`monerium: could not read order ${orderId} for transfer ${transferId}: ${moneriumFailureReason(err)}`);
    if (status === 403) return { ok: false, code: "READ_REFUSED" };
    if (err instanceof MoneriumAccessError || status === 401) return { ok: false, code: "NOT_CONNECTED" };
    return { ok: false, code: "UNAVAILABLE" };
  }
  // Re-checked after the read: the transfer or the order may have moved
  // while Monerium answered.
  const t = store.findTransfer(transferId);
  if (!t || !mayAttachRedeemOrder(t)) {
    return { ok: false, code: "NOT_THIS_ORDER", reason: "the transfer has no unrecorded redeem order" };
  }
  if (orderOwner(orderId, t)) return { ok: false, code: "NOT_THIS_ORDER", reason: "the order is on another transfer" };
  const mismatch = redeemOrderMismatch(t, user, orderId, order);
  if (mismatch) return { ok: false, code: "NOT_THIS_ORDER", reason: `the order does not match this transfer: ${mismatch}` };
  store.updateTransfer(t.id, {
    sepa: { mode: "sandbox", orderId, state: order.meta?.state ?? order.state, detail: "attached at review" },
  });
  return { ok: true };
}
