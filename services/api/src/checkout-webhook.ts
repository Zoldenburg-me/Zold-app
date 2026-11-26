/**
 * Tell the checkout service that something it reads changed.
 *
 * Three bodies, each ids and nothing else:
 *  - `{"transferId"}`: one of its SEPA transfers changed state;
 *  - `{"paymentRequestId", "linkId"}`: a request it opened through a merchant
 *    link became PAID or CANCELLED (expiry is not announced; its poll sees it);
 *  - `{"linkId"}`: a merchant link was revoked.
 * The service reads the object back with its own credential
 * (/api/service/checkout/..., /api/service/merchant/...), so a forged or
 * replayed delivery can make it do a read and no more. Same shape as the
 * Monerium webhook we receive.
 *
 * Signed with Standard Webhooks (http/standard-webhooks.ts). Each hint is an
 * outbox row (outbox.ts), written in the transaction that made the change, and
 * its row id is the delivery's `webhook-id`, kept across retries, for the
 * receiver to dedupe on; each attempt has a fresh `webhook-timestamp` for its
 * replay window. A non-2xx or a network failure is retried with backoff up to
 * CHECKOUT_SERVICE.webhookMaxAttempts, then the row is dead (logged, kept).
 *
 * The service must not depend on the webhook for correctness; it is a hint
 * to read now rather than at the next poll.
 */
import { CHECKOUT_SERVICE } from "./config.js";
import { isCheckoutTransfer } from "./checkout-service.js";
import { signStandardWebhook } from "./http/standard-webhooks.js";
import { registerOutboxKind } from "./outbox.js";
import { store, type OutboxDraft, type OutboxRow, type PaymentRequest } from "./store.js";

/** One attempt may take this long before it counts as failed. */
const ATTEMPT_TIMEOUT_MS = 10_000;

export const CHECKOUT_HINT = "checkout.hint";

let started = false;

type Hint = { transferId: string } | { paymentRequestId: string; linkId: string } | { linkId: string };

/** The request states a merchant link's request is announced on. */
const ANNOUNCED: readonly PaymentRequest["state"][] = ["PAID", "CANCELLED"];

const hint = (h: Hint): OutboxDraft => ({ kind: CHECKOUT_HINT, payload: h });

/** Put a hint in the outbox with each transfer and payment request state
 *  change it reads, and deliver them. False when no webhook URL is set. */
export function startCheckoutWebhook(): boolean {
  if (!CHECKOUT_SERVICE.webhookUrl) return false;
  if (started) return true;
  started = true;
  registerOutboxKind(CHECKOUT_HINT, {
    deliver: attempt,
    maxAttempts: CHECKOUT_SERVICE.webhookMaxAttempts,
    retryBaseMs: CHECKOUT_SERVICE.webhookRetryBaseMs,
  });
  store.onTransferStateChange((t) => (isCheckoutTransfer(t) ? hint({ transferId: t.id }) : undefined));
  store.onPaymentRequestStateChange((r) =>
    r.source.linkId && ANNOUNCED.includes(r.state) ? hint({ paymentRequestId: r.id, linkId: r.source.linkId }) : undefined,
  );
  return true;
}

/** A merchant link was revoked: called in the transaction that revokes it.
 *  Nothing when the webhook is off. */
export async function announceMerchantLinkRevoked(linkId: string): Promise<void> {
  if (started) await store.enqueueOutbox(hint({ linkId }));
}

async function attempt(row: OutboxRow): Promise<void> {
  const raw = Buffer.from(JSON.stringify(row.payload));
  const webhookId = row.id;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(CHECKOUT_SERVICE.webhookUrl, {
    method: "POST",
    body: raw,
    redirect: "error",
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook(webhookId, timestamp, raw, CHECKOUT_SERVICE.webhookSecret),
    },
  });
  // Drain the body so the connection is released, not held until GC. A
  // failure here says nothing about the delivery, so it is ignored.
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
