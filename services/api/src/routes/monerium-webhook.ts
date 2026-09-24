/**
 * The Monerium webhook.
 *
 * IT TRUSTS NOTHING IN THE BODY except an order id, which handleWebhookEvent
 * re-reads from Monerium — so a forged payload buys nothing even with no
 * secret configured. MONERIUM_WEBHOOK_SECRET adds Monerium's documented
 * webhook-id/timestamp/signature HMAC on top, with delivery-id dedupe and a
 * staleness window.
 */
import express from "express";
import { wrap } from "./util.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SECURITY, moneriumSandboxEnabled } from "../config.js";
import { handleWebhookEvent } from "../adapters/monerium-sandbox.js";
import { store } from "../store.js";

const sandbox = moneriumSandboxEnabled();

/**
 * The signed timestamp is what stops a captured delivery being replayed years
 * later. Delivery-id dedupe only rejects ids we have already seen, so it does
 * nothing for a capture we never received. Accepts both the ISO-8601 and the
 * unix-seconds forms, since we have not seen a real Monerium delivery yet.
 * MONERIUM_WEBHOOK_TOLERANCE_SEC=0 disables the check.
 */
function withinReplayWindow(
  timestamp: string,
  toleranceSec = SECURITY.webhookToleranceSec,
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

/**
 * Verify the shared-secret HMAC on a Monerium webhook.
 *
 * Returns true when no secret is configured — the endpoint is still safe in
 * that case because handleWebhookEvent re-reads the order from Monerium and
 * ignores everything else in the body. Set MONERIUM_WEBHOOK_SECRET to also
 * keep strangers from making us do the lookup.
 *
 * Monerium signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with the
 * base64-decoded `whsec_...` secret and sends `webhook-signature: v1,<base64>`.
 * The Standard Webhooks format allows several space-separated signatures
 * during a key rotation; any one matching is enough.
 */
function verifyWebhookSignature(req: express.Request): boolean {
  const secret = SECURITY.moneriumWebhookSecret;
  if (!secret) return true;
  const id = req.header("webhook-id") ?? "";
  const timestamp = req.header("webhook-timestamp") ?? "";
  const provided = req.header("webhook-signature") ?? "";
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!id || !timestamp || !raw || !provided) return false;
  if (!withinReplayWindow(timestamp)) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
  const expected = Buffer.from(`v1,${createHmac("sha256", key).update(signed).digest("base64")}`);
  return provided
    .split(" ")
    .filter(Boolean)
    .some((candidate) => {
      const b = Buffer.from(candidate);
      return expected.length === b.length && timingSafeEqual(expected, b);
    });
}

export function createMoneriumWebhookRouter() {
  const router = express.Router();

  router.post(
    "/webhooks/monerium",
    wrap(async (req, res) => {
      if (!sandbox) return res.status(400).json({ error: "Monerium app credentials are not configured, so webhook deliveries cannot be re-read" });
      if (!verifyWebhookSignature(req)) {
        return res.status(401).json({ error: "invalid webhook signature" });
      }
      const webhookId = req.header("webhook-id");
      if (webhookId && store.isWebhookProcessed(webhookId)) {
        return res.json({ handled: false, duplicate: true });
      }
      const result = await handleWebhookEvent(req.body);
      // Only spend the delivery id on a settled answer. `unavailable` means we
      // could not reach Monerium to check — marking it processed would make our
      // own outage look like a duplicate when Monerium retries the same id, and
      // the deposit would never arrive by this path. 503 asks for that retry.
      if (result.outcome === "unavailable") {
        return res.status(503).json({ ...result, retry: true });
      }
      if (webhookId) store.markWebhookProcessed(webhookId);
      res.json(result);
    }),
  );

  return router;
}
