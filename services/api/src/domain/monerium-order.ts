/**
 * The Monerium order state that means the order was carried out: for a
 * redeem, the SEPA payment left Monerium. Placed, pending and every other
 * state prove only that Monerium holds the order.
 */
export const MONERIUM_ORDER_PROCESSED = "processed";

export const moneriumOrderProcessed = (state: string | undefined): boolean => state === MONERIUM_ORDER_PROCESSED;
