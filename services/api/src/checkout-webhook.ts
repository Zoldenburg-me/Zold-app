/**
 * Tell the checkout service that one of its transfers changed state.
 *
 * The body is `{"transferId": "..."}` and nothing else: the service reads the
 * transfer back through GET /api/service/checkout/transfers/:id with its own
 * credential, so a forged or replayed delivery can make it do a read and no
 * more. Same shape as the Monerium webhook we receive.
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
import { store } from "./store.js";

/** One attempt may take this long before it counts as failed. */
const ATTEMPT_TIMEOUT_MS = 10_000;
/** Each retry waits this many times longer than the one before. */
const BACKOFF_FACTOR = 4;

let started = false;

/** Subscribe to transfer state changes. False when no webhook URL is set. */
export function startCheckoutWebhook(): boolean {
  if (!CHECKOUT_SERVICE.webhookUrl) return false;
  if (started) return true;
  started = true;
  store.onTransferStateChange((t) => {
    if (isCheckoutTransfer(t)) send(`msg_${randomUUID()}`, t.id, 1);
  });
  return true;
}

/** Never lets a failure escape as an unhandled rejection. */
function send(webhookId: string, transferId: string, n: number): void {
  attempt(webhookId, transferId, n).catch((err) =>
    console.error(`checkout webhook ${webhookId} for transfer ${transferId}: ${describeCause(err)}`),
  );
}

async function attempt(webhookId: string, transferId: string, n: number): Promise<void> {
  const raw = Buffer.from(JSON.stringify({ transferId }));
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
    console.error(`checkout webhook ${webhookId} for transfer ${transferId}: gave up after ${n} attempts (${outcome})`);
    return;
  }
  const delay = CHECKOUT_SERVICE.webhookRetryBaseMs * BACKOFF_FACTOR ** (n - 1);
  setTimeout(() => send(webhookId, transferId, n + 1), delay).unref();
}
