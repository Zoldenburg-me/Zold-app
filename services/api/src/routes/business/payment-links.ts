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
import { PaymentRequestError, availableMethods, ownerPaymentRequest, validateCreate } from "../../payment-requests.js";
import { baseUrlFor, createPaymentRequest } from "../payment-requests.js";
import type { OrgRoutes } from "./invoicing.js";
import { openLinkFor, payLinkOffer, payLinkPayee, withInvoiceLinkLock } from "./invoice-pay-link.js";

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
    res.json({ paymentRequests: links, payLink: payLinkOffer(ctx) });
  });

  r.post("/:orgId/payment-requests", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (req.body?.invoiceId && !requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const user = store.findUser(ctx.userId);
    if (!user) return res.status(401).json({ error: "no such user" });
    const found = payLinkPayee(ctx.org, user);
    if (!("payee" in found)) return res.status(found.code === "NOT_THE_PAYEE" ? 403 : 409).json({ error: found.reason, code: found.code });
    // The payee is the member whose Safe backs the account, which may not be the caller.
    const { payee } = found;
    // An invoice has one open link: the one its Pay button already opens.
    // Returned as is, with `reused: true`: the amount and methods asked for
    // now are not applied to it.
    const invoiceId = typeof req.body?.invoiceId === "string" ? req.body.invoiceId.trim() : "";
    const make = async () => {
      const open = invoiceId ? openLinkFor({ id: invoiceId, orgId: ctx.org.id }) : undefined;
      if (open) return { status: 200, body: { ...ownerPaymentRequest(open, baseUrlFor(req)), reused: true } };
      // No methods named: every way the payee's account can take it now. The
      // caller's own account is not the one being paid, so it does not decide.
      const body = Array.isArray(req.body?.methods) ? req.body : { ...req.body, methods: availableMethods(payee).filter((m) => m.available).map((m) => m.method) };
      const input = validateCreate(body, payee);
      const link = await createPaymentRequest(payee, input, { kind: "app" }, ctx.org.id, user.id);
      return { status: 201, body: { ...ownerPaymentRequest(link, baseUrlFor(req)), reused: false } };
    };
    try {
      const out = invoiceId ? await withInvoiceLinkLock({ id: invoiceId, orgId: ctx.org.id }, make) : await make();
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof PaymentRequestError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }));

  return r;
}
