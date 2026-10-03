/**
 * /api/orgs/:orgId/payment-page: the organisation's public page at
 * /pay/:handle. It shows the bank details of the organisation's euro account
 * under the organisation's name, so a customer pays the company, not a
 * member's personal page.
 *
 * Bank transfer only. A USDC address belongs to one member's Safe (its
 * Candide forwarder), and offering it under the company's name is a separate
 * decision; the page leaves it out rather than borrow one.
 */
import express from "express";
import { store } from "../../store.js";
import { requirePermission } from "../org-context.js";
import { HandleError, normaliseDisplayName, normaliseHandle } from "../../pay.js";
import type { OrgRoutes } from "./invoicing.js";

/** The account a page points payers at: an active euro account with an IBAN. */
export function payableEurAccount(orgId: string) {
  return store.accountsOf(orgId).find((a) => a.currency === "EUR" && a.status === "active" && !!a.identifier?.iban);
}

function view(orgId: string) {
  const org = store.findOrganisation(orgId)!;
  const ready = !!payableEurAccount(orgId);
  return {
    paymentPage: org.paymentPage ?? null,
    payUrl: org.paymentPage ? `/pay/${org.paymentPage.handle}` : null,
    // Why the page is closed, said before anyone shares a link that would 503.
    ready,
    ...(ready ? {} : { reason: "No euro account with an IBAN is open yet, so the page has no bank details to show." }),
  };
}

export function createOrgPaymentPageRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/payment-page", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.read")) return;
    res.json(view(ctx.org.id));
  });

  r.post("/:orgId/payment-page", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.update")) return;
    let handle: string;
    let displayName: string | undefined;
    try {
      handle = normaliseHandle(req.body?.handle);
      displayName = normaliseDisplayName(req.body?.displayName);
    } catch (e) {
      if (e instanceof HandleError) return res.status(400).json({ error: e.message });
      throw e;
    }
    // One namespace with users' pages; checked and written in one synchronous
    // step, so two claims cannot both pass.
    const otherOrg = store.findOrgByHandle(handle);
    if (store.findUserByHandle(handle) || (otherOrg && otherOrg.id !== ctx.org.id)) {
      return res.status(409).json({ error: `"${handle}" is already taken` });
    }
    if (!payableEurAccount(ctx.org.id)) {
      return res.status(409).json({ error: view(ctx.org.id).reason, code: "ACCOUNT_NOT_OPEN" });
    }
    const now = new Date().toISOString();
    const existing = ctx.org.paymentPage;
    store.updateOrganisation(ctx.org.id, {
      paymentPage: { handle, ...(displayName ? { displayName } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now },
    });
    res.json(view(ctx.org.id));
  });

  return r;
}
