/**
 * The organisation's side of merchant links (merchant-links.ts):
 *
 *   POST   /orgs/:orgId/merchant-links        org.update  issue a link code,
 *          body {integration: "shopify", shop} → {installUrl, shop, payeeHandle, expiresAt}
 *   GET    /orgs/:orgId/merchant-links        org.read    links and their requests
 *   DELETE /orgs/:orgId/merchant-links/:id    org.update  revoke (idempotent)
 *
 * The install URL is the checkout's: the merchant approves the app at
 * Shopify there, and the checkout exchanges the code with us
 * (routes/service-merchant.ts). Revoking stops new requests; open ones stay
 * open, money that arrives still lands in the org's account, and the checkout
 * may still read them to mark a paid order paid.
 */
import express from "express";
import { wrap } from "./util.js";
import { auditEntry } from "../audit.js";
import { store } from "../store.js";
import { roleCan } from "../domain/roles.js";
import { isValidShopDomain, normaliseShop } from "../shopify/hmac.js";
import { requirePermission, resolveOrg, type SessionResolver } from "./org-context.js";
import { baseUrlFor } from "./payment-requests.js";
import { newestShopifyRequests, payeeFor, shopifyRequestRow } from "./shopify.js";
import { announceMerchantLinkRevoked } from "../checkout-webhook.js";
import { issueLinkCode, linkRefusal, merchantLinksAvailable, payLinkTemplate, publicLink, voidLinkCodes } from "../merchant-links.js";

export function createMerchantLinkRouter(requireSession: SessionResolver): express.Router {
  const router = express.Router();

  router.post(
    "/orgs/:orgId/merchant-links",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.update")) return;
      const avail = merchantLinksAvailable();
      if (!avail.available) return res.status(503).json({ error: avail.reason, code: "MERCHANT_LINKS_UNAVAILABLE" });
      if ((req.body?.integration ?? "shopify") !== "shopify") {
        return res.status(400).json({ error: "integration must be shopify" });
      }
      const shop = normaliseShop(String(req.body?.shop ?? ""));
      if (!isValidShopDomain(shop)) {
        return res.status(400).json({ error: "shop must be the store's myshopify.com domain, e.g. my-store.myshopify.com" });
      }
      const refused = linkRefusal(ctx.org.id, shop, ctx.userId);
      if (refused) return res.status(409).json(refused);
      // linkRefusal asked payeeFor already; a payee is there.
      const payee = payeeFor(ctx.org.id, ctx.userId).user!;
      const { code, expiresAt } = issueLinkCode({ orgId: ctx.org.id, shop, payeeUserId: payee.id, installerId: ctx.userId });
      store.audit(auditEntry("merchant_link.code_issued", { orgId: ctx.org.id, shop, integration: "shopify" }, ctx.userId));
      const installUrl = `${avail.checkoutOrigin}/shopify/install?${new URLSearchParams({ shop, link: code })}`;
      res.setHeader("cache-control", "no-store");
      res.status(201).json({ installUrl, shop, payeeHandle: payee.paymentPage!.handle, expiresAt: new Date(expiresAt).toISOString() });
    }),
  );

  router.get(
    "/orgs/:orgId/merchant-links",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.read")) return;
      // Carries payment codes, and for a member who may change the org each
      // link's email-template key.
      res.setHeader("cache-control", "no-store");
      const avail = merchantLinksAvailable();
      const manage = roleCan(ctx.member.role, "org.update");
      const origin = avail.checkoutOrigin;
      const links = store.merchantLinksForOrg(ctx.org.id)
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((l) => ({
          ...publicLink(l),
          ...(manage && origin && !l.revokedAt ? { payLinkTemplate: payLinkTemplate(origin, l), extensionOrigin: origin } : {}),
        }));
      const ids = new Set(store.merchantLinksForOrg(ctx.org.id).map((l) => l.id));
      const base = baseUrlFor(req);
      const requests = newestShopifyRequests((r) => r.orgId === ctx.org.id && Boolean(r.source.linkId && ids.has(r.source.linkId)))
        .map((r) => ({ ...shopifyRequestRow(r, base), linkId: r.source.linkId }));
      res.json({
        available: avail.available,
        ...(origin ? { checkoutOrigin: origin } : {}),
        canManage: manage,
        links,
        requests,
      });
    }),
  );

  router.delete(
    "/orgs/:orgId/merchant-links/:id",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.update")) return;
      const link = store.merchantLinksForOrg(ctx.org.id).find((l) => l.id === req.params.id);
      if (!link) return res.status(404).json({ error: "no such link" });
      // A code issued before the revoke must not relink the store after it.
      voidLinkCodes(ctx.org.id, link.shop);
      if (link.revokedAt) return res.json({ link: publicLink(link) });
      const revoked = store.updateMerchantLink(link.id, { revokedAt: new Date().toISOString(), revokedBy: ctx.userId });
      store.audit(auditEntry("merchant_link.revoked", { orgId: ctx.org.id, linkId: link.id, shop: link.shop }, ctx.userId));
      announceMerchantLinkRevoked(link.id);
      res.json({ link: publicLink(revoked) });
    }),
  );

  return router;
}
