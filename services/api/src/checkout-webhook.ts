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
 * Signed with Standard Webhooks (http/standard-webhooks.ts). Each delivery has
 * one `webhook-id`, kept across retries, for the receiver to dedupe on; each
 * attempt has a fresh `webhook-timestamp` for its replay window. A non-2xx or
 * a network failure is retried with backoff up to
 * CHECKOUT_SERVICE.webhookMaxAttempts.
 *
 * Retries are held in memory: a restart drops pending ones. The service must
 * not depend on the webhook for correctness; it is a hint to read now rather
 * than at the next poll.
 */
import { randomUUID } from "node:crypto";
import { CHECKOUT_SERVICE } from "./config.js";
import { isCheckoutTransfer } from "./checkout-service.js";
import { signStandardWebhook } from "./http/standard-webhooks.js";
import { describeCause } from "./http/log-cause.js";
import { store, type PaymentRequest } from "./store.js";

/** One attempt may take this long before it counts as failed. */
const ATTEMPT_TIMEOUT_MS = 10_000;
/** Each retry waits this many times longer than the one before. */
const BACKOFF_FACTOR = 4;

let started = false;

type Hint = { transferId: string } | { paymentRequestId: string; linkId: string } | { linkId: string };

/** The request states a merchant link's request is announced on. */
const ANNOUNCED: readonly PaymentRequest["state"][] = ["PAID", "CANCELLED"];

/** Subscribe to transfer and payment request state changes. False when no
 *  webhook URL is set. */
export function startCheckoutWebhook(): boolean {
  if (!CHECKOUT_SERVICE.webhookUrl) return false;
  if (started) return true;
  started = true;
  store.onTransferStateChange((t) => {
    if (isCheckoutTransfer(t)) announce({ transferId: t.id });
  });
  store.onPaymentRequestStateChange((r) => {
    if (r.source.linkId && ANNOUNCED.includes(r.state)) announce({ paymentRequestId: r.id, linkId: r.source.linkId });
  });
  return true;
}

/** A merchant link was revoked. Nothing when the webhook is off. */
export function announceMerchantLinkRevoked(linkId: string): void {
  if (started) announce({ linkId });
}

function announce(hint: Hint): void {
  send(`msg_${randomUUID()}`, hint, 1);
}

const label = (hint: Hint) => Object.entries(hint).map(([k, v]) => `${k} ${v}`).join(", ");

/** Never lets a failure escape as an unhandled rejection. */
function send(webhookId: string, hint: Hint, n: number): void {
  attempt(webhookId, hint, n).catch((err) =>
    console.error(`checkout webhook ${webhookId} for ${label(hint)}: ${describeCause(err)}`),
  );
}

async function attempt(webhookId: string, hint: Hint, n: number): Promise<void> {
  const raw = Buffer.from(JSON.stringify(hint));
  const timestamp = String(Math.floor(Date.now() / 1000));
  let outcome: string;
  try {
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
    if (res.ok) return;
    outcome = `HTTP ${res.status}`;
  } catch (err) {
    outcome = describeCause(err);
  }
  if (n >= CHECKOUT_SERVICE.webhookMaxAttempts) {
    console.error(`checkout webhook ${webhookId} for ${label(hint)}: gave up after ${n} attempts (${outcome})`);
    return;
  }
  const delay = CHECKOUT_SERVICE.webhookRetryBaseMs * BACKOFF_FACTOR ** (n - 1);
  setTimeout(() => send(webhookId, hint, n + 1), delay).unref();
}
