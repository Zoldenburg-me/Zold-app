/**
 * /api/orgs/:orgId/payment-page: the organisation's public page at
 * /pay/:handle. It shows the bank details of the organisation's euro account
 * under the organisation's name, so a customer pays the company, not a
 * member's personal page.
 *
 * Bank transfer only. A USDC address belongs to one member's Safe (its
 * Candide forwarder), and offering it under the company's name is a separate
 * decision; the page leaves it out rather than borrow one.
 *
 * Only a business, and only an IBAN on the company's own profile at Monerium
 * (the check that lets the account send): otherwise the page would publish a
 * member's personal IBAN under the company's name. Judged on every read, so a
 * profile that turns out personal closes a page already claimed.
 */
import express from "express";
import { store } from "../../store.js";
import type { Account, Organisation } from "../../domain/types.js";
import { accountProfileStanding } from "../../domain/monerium-profile.js";
import { requirePermission } from "../org-context.js";
import { HandleError, normaliseDisplayName, normaliseHandle } from "../../pay.js";
import type { OrgRoutes } from "./invoicing.js";

const NO_ACCOUNT = "No euro account with an IBAN is open yet, so the page has no bank details to show.";

/**
 * The account a company page points payers at, and the holder name to show
 * (Monerium's name for the profile), or why there is none.
 */
export function orgPageAccount(org: Organisation): { account: Account; holder: string } | { reason: string; code: string } {
  if (org.type !== "business") {
    return { code: "PAGE_NOT_AVAILABLE", reason: "Only a business has a company payment page. Your own payment page is in the app." };
  }
  const account = store.accountsOf(org.id).find((a) => a.currency === "EUR" && a.status === "active" && !!a.identifier?.iban);
  if (!account) return { code: "ACCOUNT_NOT_OPEN", reason: NO_ACCOUNT };
  const standing = accountProfileStanding(org, account);
  if (standing.status !== "verified") {
    return { code: "PAGE_NOT_AVAILABLE", reason: "This IBAN isn’t confirmed as on the company profile at Monerium, so the page can’t show it as the company’s. Check it on Accounts." };
  }
  return { account, holder: standing.name || org.legalName || org.name };
}

function view(orgId: string) {
  const org = store.findOrganisation(orgId)!;
  const page = orgPageAccount(org);
  return {
    paymentPage: org.paymentPage ?? null,
    payUrl: org.paymentPage ? `/pay/${org.paymentPage.handle}` : null,
    // Why the page is closed, said before anyone shares a link that would 503.
    ready: "account" in page,
    ...("reason" in page ? { reason: page.reason } : {}),
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
    const page = orgPageAccount(ctx.org);
    if ("reason" in page) return res.status(409).json({ error: page.reason, code: page.code });
    const now = new Date().toISOString();
    const existing = ctx.org.paymentPage;
    store.updateOrganisation(ctx.org.id, {
      paymentPage: { handle, ...(displayName ? { displayName } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now },
    });
    res.json(view(ctx.org.id));
  });

  return r;
}
