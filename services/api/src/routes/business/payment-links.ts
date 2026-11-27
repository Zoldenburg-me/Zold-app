/**
 * /api/orgs/:orgId/payment-requests: payment links booked under an
 * organisation, optionally for one of its issued invoices.
 *
 * A link pays into the payee's own Safe, so for an organisation the payee is
 * the member whose Safe backs its account (`backingUserId`) and nobody else.
 * A link raised by any other member would route the organisation's customer
 * into that member's own account. A company on its own Safe has no such
 * member: its links pay into its account (`accountId`), by bank transfer.
 */
import express from "express";
import { store } from "../../store.js";
import { wrap } from "../util.js";
import { requireCapability, requirePermission } from "../org-context.js";
import { PaymentRequestError, effectiveState, validateCreate } from "../../payment-requests.js";
import { baseUrlFor } from "../payment-requests.js";
import type { OrgRoutes } from "./invoicing.js";
import { createLink, linkMethodsFor, linkSubject, openLinkFor, ownerLink, payLinkOffer, payLinkPayee, withInvoiceLinkLock } from "./invoice-pay-link.js";

export function createPaymentLinkRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/payment-requests", async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    const base = baseUrlFor(req);
    const links = (await store.list("paymentRequests"))
      .filter((p) => p.orgId === ctx.org.id && p.source.kind === "app")
      .reverse();
    const shown = await Promise.all(links.map((p) => ownerLink(p, base)));
    res.json({ paymentRequests: shown, payLink: await payLinkOffer(ctx) });
  });

  r.post("/:orgId/payment-requests", wrap(async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (req.body?.invoiceId && !requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const user = await store.findUser(ctx.userId);
    if (!user) return res.status(401).json({ error: "no such user" });
    const found = await payLinkPayee(ctx.org, user);
    if ("code" in found) return res.status(found.code === "NOT_THE_PAYEE" ? 403 : 409).json({ error: found.reason, code: found.code });
    // The payee is the member whose Safe backs the account, which may not be
    // the caller, or the company's own account.
    const own = "payee" in found && found.payee.id === user.id;
    // An invoice has one open link: the one its Pay button already opens.
    // Returned as is, with `reused: true`: the amount and methods asked for
    // now are not applied to it.
    const invoiceId = typeof req.body?.invoiceId === "string" ? req.body.invoiceId.trim() : "";
    const make = async () => {
      const open = invoiceId ? (await openLinkFor({ id: invoiceId, orgId: ctx.org.id })) : undefined;
      if (open) return { status: 200, body: { ...(await ownerLink(open, baseUrlFor(req))), reused: true } };
      // No methods named: every way this link may be paid (linkMethods). The
      // caller's own account is not the one being paid, so it does not decide.
      const allowed = await linkMethodsFor(ctx.org, found, user);
      const named: unknown[] = Array.isArray(req.body?.methods) ? req.body.methods : allowed;
      // A malformed body is validateCreate's 400 first; a known method this link may not take is ours.
      const input = validateCreate({ ...req.body, methods: named }, linkSubject(found));
      if (!own && input.methods.some((m) => !allowed.includes(m))) {
        throw new PaymentRequestError(`a link you make for ${ctx.org.name} is paid by bank transfer only, as its payment page is`, 409);
      }
      const link = await createLink(found, user, input, ctx.org.id);
      return { status: 201, body: { ...(await ownerLink(link, baseUrlFor(req))), reused: false } };
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
  r.post("/:orgId/payment-requests/:reqId/cancel", async (req, res) => {
    return store.tx(async () => {
      const ctx = await ctxOf(req, res);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "invoices.manage")) return;
      const link = await store.findPaymentRequest(req.params.reqId);
      if (!link || link.orgId !== ctx.org.id || link.source.kind !== "app") return res.status(404).json({ error: "payment request not found" });
      if (link.invoiceId && !requireCapability(ctx, res, "invoices")) return;
      if (link.state !== "OPEN") return res.status(409).json({ error: `this link is ${effectiveState(link).toLowerCase()}` });
      if (link.payments.length) return res.status(409).json({ error: "a payment has already been recorded against this link — it cannot be cancelled" });
      // On the stored row: a payment recorded since the check keeps the link.
      const done = await store.cancelUnpaidPaymentRequest(link.id, new Date(), true);
      if (!done) return res.status(409).json({ error: "a payment has already been recorded against this link — it cannot be cancelled" });
      res.json(await ownerLink(done, baseUrlFor(req)));
    });
  });

  return r;
}
