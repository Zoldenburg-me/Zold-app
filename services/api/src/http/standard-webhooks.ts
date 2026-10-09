/**
 * Standard Webhooks signing (standardwebhooks.com), both directions.
 *
 * The sender signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with the
 * base64-decoded `whsec_...` secret and sends `webhook-signature: v1,<base64>`.
 * Monerium signs what it sends us this way (routes/monerium-webhook.ts), and we
 * sign what we send the checkout service the same way (checkout-webhook.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The replay window a receiver applies when the caller names none. */
export const DEFAULT_TOLERANCE_SEC = 300;

/**
 * The signed timestamp is what stops a captured delivery being replayed years
 * later. Delivery-id dedupe only rejects ids already seen, so it does nothing
 * for a capture the receiver never got. Accepts both the ISO-8601 and the
 * unix-seconds forms. A tolerance of 0 disables the check.
 */
export function withinReplayWindow(
  timestamp: string,
  toleranceSec = DEFAULT_TOLERANCE_SEC,
  now = Date.now(),
): boolean {
  if (!toleranceSec) return true;
  const asNumber = Number(timestamp);
  const sentMs = Number.isFinite(asNumber) && timestamp.trim() !== ""
    ? asNumber * 1000
    : Date.parse(timestamp);
  if (!Number.isFinite(sentMs)) return false;
  return Math.abs(now - sentMs) <= toleranceSec * 1000;
}

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/** The `webhook-signature` value for one delivery attempt. */
export function signStandardWebhook(id: string, timestamp: string, raw: Buffer, secret: string): string {
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
  return `v1,${createHmac("sha256", secretKey(secret)).update(signed).digest("base64")}`;
}

/**
 * Check one delivery's signature and timestamp. The format allows several
 * space-separated signatures during a key rotation; any one matching is
 * enough. Delivery-id dedupe is the receiver's, since only it holds the ids.
 */
export function verifyStandardWebhook(input: {
  id: string;
  timestamp: string;
  signature: string;
  raw: Buffer | undefined;
  secret: string;
  toleranceSec?: number;
  now?: number;
}): boolean {
  const { id, timestamp, signature, raw, secret } = input;
  if (!id || !timestamp || !raw || !signature || !secret) return false;
  if (!withinReplayWindow(timestamp, input.toleranceSec ?? DEFAULT_TOLERANCE_SEC, input.now)) return false;
  const expected = Buffer.from(signStandardWebhook(id, timestamp, raw, secret));
  return signature
    .split(" ")
    .filter(Boolean)
    .some((candidate) => {
      const b = Buffer.from(candidate);
      return expected.length === b.length && timingSafeEqual(expected, b);
    });
}
