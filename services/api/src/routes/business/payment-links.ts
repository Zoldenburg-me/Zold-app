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
import { PaymentRequestError, effectiveState, ownerPaymentRequest, validateCreate } from "../../payment-requests.js";
import { baseUrlFor, createPaymentRequest } from "../payment-requests.js";
import type { OrgRoutes } from "./invoicing.js";
import { linkMethods, openLinkFor, payLinkOffer, payLinkPayee, withInvoiceLinkLock } from "./invoice-pay-link.js";

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
      // No methods named: every way this link may be paid (linkMethods). The
      // caller's own account is not the one being paid, so it does not decide.
      const allowed = linkMethods(payee, user);
      const named: unknown[] = Array.isArray(req.body?.methods) ? req.body.methods : allowed;
      const refused = named.find((m) => !allowed.includes(m as never));
      if (refused !== undefined && payee.id !== user.id) {
        throw new PaymentRequestError(`a link you make for ${ctx.org.name} is paid by bank transfer only, as its payment page is`, 409);
      }
      const body = { ...req.body, methods: named };
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

  /** Cancel a company link: anyone who may make one, for any of the company's
   *  links. A link with money against it stays: the payments are facts. */
  r.post("/:orgId/payment-requests/:reqId/cancel", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const link = store.findPaymentRequest(req.params.reqId);
    if (!link || link.orgId !== ctx.org.id || link.source.kind !== "app") return res.status(404).json({ error: "payment request not found" });
    if (link.state !== "OPEN") return res.status(409).json({ error: `this link is ${effectiveState(link).toLowerCase()}` });
    if (link.payments.length) return res.status(409).json({ error: "a payment has already been recorded against this link — it cannot be cancelled" });
    const done = store.updatePaymentRequest(link.id, { state: "CANCELLED", cancelledAt: new Date().toISOString() });
    res.json(ownerPaymentRequest(done, baseUrlFor(req)));
  });

  return r;
}
