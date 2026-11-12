/**
 * The Monerium webhook.
 *
 * Only the order id is taken from the body; handleWebhookEvent re-reads the
 * order from Monerium, so a forged payload achieves nothing even without a
 * secret. MONERIUM_WEBHOOK_SECRET adds Monerium's documented
 * webhook-id/timestamp/signature HMAC, delivery-id dedupe and a staleness
 * window.
 */
import express from "express";
import { wrap } from "./util.js";
import { verifyStandardWebhook } from "../http/standard-webhooks.js";
import { SECURITY, moneriumSandboxEnabled } from "../config.js";
import { handleWebhookEvent } from "../adapters/monerium-sandbox.js";
import { store } from "../store.js";

const sandbox = moneriumSandboxEnabled();

/**
 * Verify the shared-secret HMAC on a Monerium webhook.
 *
 * Returns true when no secret is configured — the endpoint is still safe in
 * that case because handleWebhookEvent re-reads the order from Monerium and
 * ignores everything else in the body. Set MONERIUM_WEBHOOK_SECRET to also
 * keep strangers from making us do the lookup. The scheme, and the replay
 * window MONERIUM_WEBHOOK_TOLERANCE_SEC sets, are in http/standard-webhooks.ts.
 */
function verifyWebhookSignature(req: express.Request): boolean {
  const secret = SECURITY.moneriumWebhookSecret;
  if (!secret) return true;
  return verifyStandardWebhook({
    id: req.header("webhook-id") ?? "",
    timestamp: req.header("webhook-timestamp") ?? "",
    signature: req.header("webhook-signature") ?? "",
    raw: (req as any).rawBody as Buffer | undefined,
    secret,
    toleranceSec: SECURITY.webhookToleranceSec,
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
