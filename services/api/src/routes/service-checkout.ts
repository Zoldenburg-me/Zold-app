/**
 * The pay-with-zold checkout service's read path, and the operator's rotation
 * of its credential.
 *
 *   GET  /service/checkout/transfers/:id                 checkout credential
 *   POST /admin/service-credentials/checkout/rotate      operator token,
 *        body {revokePrevious?: boolean} — true for a leaked credential
 *
 * The read answers only for a checkout transfer (checkout-service.ts), as the
 * allowlist and nothing else; every other id, existing or not, is the same
 * 404. Every authenticated read is audited. Rate limits are in http/policy.ts:
 * a valid credential has its own bucket, a wrong one is on the auth bucket.
 */
import express from "express";
import { wrap } from "./util.js";
import { auditEntry } from "../audit.js";
import { bearerToken } from "../http/sessions.js";
import { operatorLabel, requireOperator } from "../http/guards.js";
import { store } from "../store.js";
import {
  checkoutCredentialFor,
  checkoutCredentialIssued,
  checkoutTransferView,
  isCheckoutTransfer,
  rotateCheckoutCredential,
} from "../checkout-service.js";

/** Longest id echoed into the audit log; ours are UUIDs. */
const MAX_AUDITED_ID = 64;

export function createCheckoutServiceRouter() {
  const router = express.Router();

  router.get(
    "/service/checkout/transfers/:id",
    wrap(async (req, res) => {
      if (!checkoutCredentialIssued()) {
        return res.status(503).json({ error: "no checkout service credential issued" });
      }
      const credential = checkoutCredentialFor(bearerToken(req));
      if (!credential) return res.status(401).json({ error: "checkout service authorization required" });

      const id = String(req.params.id);
      const t = store.findTransfer(id);
      const served = t && isCheckoutTransfer(t) ? t : undefined;
      store.audit(
        auditEntry(
          "service.checkout_transfer_read",
          {
            credentialId: credential.id,
            transferId: id.slice(0, MAX_AUDITED_ID),
            outcome: served ? "served" : "not_found",
          },
          served?.userId,
        ),
      );
      if (!served) return res.status(404).json({ error: "not found" });
      res.setHeader("cache-control", "no-store");
      res.json(checkoutTransferView(served));
    }),
  );

  router.post(
    "/admin/service-credentials/checkout/rotate",
    wrap(async (req, res) => {
      if (!requireOperator(req, res)) return;
      // Strict, because a revoke that silently became a plain rotation would
      // leave a leaked token working for the whole overlap.
      if (req.headers["content-length"] && req.headers["content-length"] !== "0" && !req.is("application/json")) {
        return res.status(415).json({ error: "send the body as application/json" });
      }
      const body = req.body ?? {};
      const revokePrevious = "revokePrevious" in body ? body.revokePrevious : false;
      if (typeof revokePrevious !== "boolean") {
        return res.status(400).json({ error: "revokePrevious must be true or false" });
      }
      const issued = rotateCheckoutCredential(operatorLabel(req), revokePrevious);
      res.setHeader("cache-control", "no-store");
      res.status(201).json(issued);
    }),
  );

  return router;
}
