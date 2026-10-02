/**
 * /api/orgs/:orgId/payment-requests: payment links booked under an
 * organisation, optionally for one of its issued invoices.
 *
 * A link pays into the payee's own Safe, so for an organisation the payee is
 * the member whose Safe backs its account (`backingUserId`) and nobody else.
 * A link raised by any other member would route the organisation's customer
 * into that member's own account.
 */
import express from "express";
import { store } from "../../store.js";
import { wrap } from "../util.js";
import { requireCapability, requirePermission } from "../org-context.js";
import { PaymentRequestError, ownerPaymentRequest, validateCreate } from "../../payment-requests.js";
import { baseUrlFor, createPaymentRequest, orgsBackedBy } from "../payment-requests.js";
import type { OrgRoutes } from "./invoicing.js";

export function createPaymentLinkRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/payment-requests", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    const base = baseUrlFor(req);
    const links = store.paymentRequests
      .filter((p) => p.orgId === ctx.org.id && p.source.kind === "app")
      .map((p) => ownerPaymentRequest(p, base))
      .reverse();
    res.json({ paymentRequests: links });
  });

  r.post("/:orgId/payment-requests", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (req.body?.invoiceId && !requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const user = store.findUser(ctx.userId);
    if (!user) return res.status(401).json({ error: "no such user" });
    if (!orgsBackedBy(user.id).has(ctx.org.id)) {
      return res.status(403).json({
        error: "A payment link pays into the account behind this organisation's EUR account, and that is not yours. The member whose account it is can make the link.",
        code: "NOT_THE_PAYEE",
      });
    }
    try {
      const input = validateCreate(req.body, user);
      const link = await createPaymentRequest(user, input, { kind: "app" }, ctx.org.id);
      res.status(201).json(ownerPaymentRequest(link, baseUrlFor(req)));
    } catch (err) {
      if (err instanceof PaymentRequestError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }));

  return r;
}
