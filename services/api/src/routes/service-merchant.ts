/**
 * The checkout service's side of merchant links (merchant-links.ts), behind
 * the same `zsc_` credential as routes/service-checkout.ts:
 *
 *   POST /service/merchant/links/exchange                     {code, shop}
 *   GET  /service/merchant/links/:linkId
 *   POST /service/merchant/links/:linkId/payment-requests     open (idempotent per order)
 *   GET  /service/merchant/links/:linkId/payment-requests/:id
 *   POST /service/merchant/links/:linkId/payment-requests/:id/cancel
 *
 * 503 when no checkout credential was ever issued, 401 on a wrong one. Every
 * authenticated call is audited. An unknown link, or a request of another
 * link, is the same 404. A revoked link opens nothing (403 LINK_REVOKED) but
 * still reads and cancels its requests, so a paid order can be marked paid.
 * Rate limits are in http/policy.ts: the whole /service/ prefix is on the
 * checkout credential's bucket.
 */
import express from "express";
import { wrap } from "./util.js";
import { auditEntry, type AuditKind } from "../audit.js";
import { bearerToken } from "../http/sessions.js";
import { CHECKOUT_SERVICE, SHOPIFY } from "../config.js";
import { EncryptionUnavailableError } from "../crypto-at-rest.js";
import { store, type MerchantLink, type ServiceCredential } from "../store.js";
import { shownDisplayName } from "../pay.js";
import { MAX_REQUEST_EUR, effectiveState, type PaymentRequest } from "../payment-requests.js";
import { normaliseShop, isValidShopDomain } from "../shopify/hmac.js";
import { checkoutCredentialFor, checkoutCredentialIssued } from "../checkout-service.js";
import { baseUrlFor, createPaymentRequest } from "./payment-requests.js";
import { externalHttpUrl, openOnce } from "./shopify.js";
import {
  MAX_REQUEST_TTL_MS,
  consumeLinkCode,
  establishLink,
  markLinkCodePreviewed,
  peekLinkCode,
  type PendingLink,
  linkPayeeProblem,
  linkRefusal,
  linkSecretOf,
  merchantLinksAvailable,
  serviceLinkView,
  serviceRequestView,
} from "../merchant-links.js";

/** Longest id echoed into the audit log; ours are UUIDs. */
const MAX_AUDITED_ID = 64;
const MAX_DESCRIPTION = 140;
const MAX_ORDER_NAME = 40;
const MAX_STATUS_URL = 2048;
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d{1,20}$/;

type Caller = { credential: ServiceCredential };

/** The credential check every route starts with; answers and returns
 *  undefined when the caller is not the checkout service. */
async function checkoutCaller(req: express.Request, res: express.Response): Promise<Caller | undefined> {
  if (!(await checkoutCredentialIssued())) {
    res.status(503).json({ error: "no checkout service credential issued" });
    return undefined;
  }
  const credential = await checkoutCredentialFor(bearerToken(req));
  if (!credential) {
    res.status(401).json({ error: "checkout service authorization required" });
    return undefined;
  }
  res.setHeader("cache-control", "no-store");
  return { credential };
}

async function audit(kind: AuditKind, caller: Caller, linkId: string, outcome: string, extra: Record<string, unknown> = {}, userId?: string) {
  await store.audit(auditEntry(kind, { credentialId: caller.credential.id, linkId: linkId.slice(0, MAX_AUDITED_ID), outcome, ...extra }, userId));
}

/** The request belongs to this link, or it does not exist for the caller. */
async function requestOfLink(link: MerchantLink | undefined, id: string): Promise<PaymentRequest | undefined> {
  const r = await store.findPaymentRequest(id);
  return link && r && r.source.linkId === link.id ? r : undefined;
}

type CreateBody = {
  amountEur: number;
  description?: string;
  expiresInMs: number;
  test: boolean;
  gid: string;
  name?: string;
  statusUrl?: string;
};

/** The create body, validated, or the reason it is refused. */
function parseCreate(b: any): CreateBody | { error: string } {
  if (!b || typeof b !== "object") return { error: "send a JSON body" };
  const amount = b.amountEur;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_REQUEST_EUR) {
    return { error: `amountEur must be a number above 0 and at most ${MAX_REQUEST_EUR}` };
  }
  // Whole cents: the adapter rounds Shopify's total before sending.
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { error: "amountEur must be whole cents (at most 2 decimals)" };
  if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > MAX_DESCRIPTION)) {
    return { error: `description must be text of at most ${MAX_DESCRIPTION} characters` };
  }
  let expiresInMs = SHOPIFY.orderTtlMs;
  if (b.expiresInSec !== undefined) {
    const sec = b.expiresInSec;
    if (typeof sec !== "number" || !Number.isInteger(sec) || sec <= 0 || sec * 1000 > MAX_REQUEST_TTL_MS) {
      return { error: `expiresInSec must be a whole number of seconds, at most ${MAX_REQUEST_TTL_MS / 1000}` };
    }
    expiresInMs = sec * 1000;
  }
  if (b.test !== undefined && typeof b.test !== "boolean") return { error: "test must be true or false" };
  const o = b.order;
  if (!o || typeof o !== "object" || typeof o.gid !== "string" || !ORDER_GID.test(o.gid)) {
    return { error: "order.gid must be gid://shopify/Order/<digits>" };
  }
  if (o.name !== undefined && (typeof o.name !== "string" || !o.name.trim() || o.name.length > MAX_ORDER_NAME)) {
    return { error: `order.name must be text of at most ${MAX_ORDER_NAME} characters` };
  }
  let statusUrl: string | undefined;
  if (o.statusUrl !== undefined) {
    if (typeof o.statusUrl !== "string" || o.statusUrl.length > MAX_STATUS_URL) return { error: `order.statusUrl must be an https URL of at most ${MAX_STATUS_URL} characters` };
    statusUrl = externalHttpUrl(o.statusUrl);
    if (!statusUrl) return { error: "order.statusUrl must be an https URL" };
  }
  return {
    amountEur: Math.round(amount * 100) / 100,
    ...(typeof b.description === "string" && b.description.trim() ? { description: b.description.trim() } : {}),
    expiresInMs,
    test: b.test === true,
    gid: o.gid,
    ...(typeof o.name === "string" ? { name: o.name.trim() } : {}),
    ...(statusUrl ? { statusUrl } : {}),
  };
}

export function createServiceMerchantRouter() {
  const router = express.Router();

  /** The body both code routes take, or undefined once refused. */
  const codeBody = async (req: express.Request, res: express.Response, caller: Caller, kind: AuditKind) => {
    const shop = normaliseShop(String(req.body?.shop ?? ""));
    if (typeof req.body?.code !== "string" || !isValidShopDomain(shop)) {
      await audit(kind, caller, "", "invalid");
      res.status(400).json({ error: "send {code, shop}: code the zlc_ link code, shop the store's myshopify.com domain", code: "INVALID_REQUEST" });
      return undefined;
    }
    return { code: req.body.code as string, shop };
  };
  const codeInvalid = async (res: express.Response, caller: Caller, kind: AuditKind) => {
    await audit(kind, caller, "", "code_invalid");
    return res.status(404).json({ error: "this link code is unknown, expired, used, or for another store", code: "LINK_CODE_INVALID" });
  };

  /**
   * The checks a code is held to at preview and at exchange. The consent is
   * up to 15 minutes old: everything is asked again. Answers and returns
   * true when refused.
   */
  const refusePending = async (res: express.Response, caller: Caller, kind: AuditKind, pending: PendingLink): Promise<boolean> => {
    return store.tx(async () => {
      const where = { orgId: pending.orgId, shop: pending.shop };
      const refused = await linkRefusal(pending.orgId, pending.shop, pending.installerId);
      if (refused) {
        await audit(kind, caller, "", `refused:${refused.code}`, where);
        res.status(409).json(refused);
        return true;
      }
      const avail = await merchantLinksAvailable();
      if (!avail.available) {
        await audit(kind, caller, "", "unavailable", where);
        res.status(503).json({ error: avail.reason, code: "MERCHANT_LINKS_UNAVAILABLE" });
        return true;
      }
      const payee = await store.findUser(pending.payeeUserId);
      if (!payee?.paymentPage?.handle || !payee.paymentPage.depositAddress) {
        await audit(kind, caller, "", "refused:NO_PAYMENT_PAGE", where);
        res.status(409).json({ code: "NO_PAYMENT_PAGE", error: "the receiving account no longer has a payment page" });
        return true;
      }
      return false;
    });
  };

  /**
   * What the shop's admin is shown before confirming: which organisation and
   * which payment page the store's orders would pay. Does not spend the code;
   * it marks it previewed, which exchange requires. No ids, no secret.
   */
  router.post(
    "/service/merchant/links/preview",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const kind: AuditKind = "service.merchant_link_preview";
      const body = await codeBody(req, res, caller, kind);
      if (!body) return;
      const pending = peekLinkCode(body.code, body.shop);
      if (!pending) return await codeInvalid(res, caller, kind);
      if ((await refusePending(res, caller, kind, pending))) return;
      markLinkCodePreviewed(body.code);
      const page = (await store.findUser(pending.payeeUserId))!.paymentPage!;
      const payeeDisplayName = shownDisplayName(page.displayName);
      await audit(kind, caller, "", "previewed", { orgId: pending.orgId, shop: body.shop, payeeUserId: pending.payeeUserId }, pending.installerId);
      res.json({
        shop: pending.shop,
        orgName: (await store.findOrganisation(pending.orgId))?.name,
        payeeHandle: page.handle,
        ...(payeeDisplayName ? { payeeDisplayName } : {}),
        expiresAt: new Date(pending.expiresAt).toISOString(),
      });
    }),
  );

  router.post(
    "/service/merchant/links/exchange",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const kind: AuditKind = "service.merchant_link_exchange";
      const body = await codeBody(req, res, caller, kind);
      if (!body) return;
      const { shop } = body;
      // Consumed first: whatever happens next, the code is spent.
      const pending = consumeLinkCode(body.code, shop);
      if (!pending) return await codeInvalid(res, caller, kind);
      // The shop's admin must have been shown whose store this becomes.
      if (!pending.previewedAt) {
        await audit(kind, caller, "", "refused:LINK_NOT_CONFIRMED", { orgId: pending.orgId, shop });
        return res.status(409).json({ error: "this link code was never previewed: show the store's admin the organisation and payee, then exchange a fresh code", code: "LINK_NOT_CONFIRMED" });
      }
      // These checks and the write are one transaction.
      const established = await store.tx(async () => {
        if ((await refusePending(res, caller, kind, pending))) return undefined;
        try {
          return await establishLink(pending);
        } catch (err) {
          if (err instanceof EncryptionUnavailableError) {
            await audit("service.merchant_link_exchange", caller, "", "unavailable:encryption", { orgId: pending.orgId, shop });
            res.status(503).json({ error: err.message, code: "MERCHANT_LINKS_UNAVAILABLE" });
            return undefined;
          }
          throw err;
        }
      });
      if (!established) return;
      const payee = (await store.findUser(pending.payeeUserId))!;
      const { link, previousPayeeUserId } = established;
      await audit("service.merchant_link_exchange", caller, link.id, "linked", {
        orgId: link.orgId, shop, payeeUserId: link.payeeUserId, ...(previousPayeeUserId ? { previousPayeeUserId } : {}),
      }, pending.installerId);
      res.json({
        linkId: link.id,
        shop: link.shop,
        orgName: (await store.findOrganisation(link.orgId))?.name,
        payeeHandle: payee.paymentPage!.handle,
        linkSecret: linkSecretOf(link),
      });
    }),
  );

  router.get(
    "/service/merchant/links/:linkId",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const id = String(req.params.linkId);
      const link = await store.findMerchantLink(id);
      await audit("service.merchant_link_read", caller, id, link ? "served" : "not_found");
      if (!link) return res.status(404).json({ error: "not found", code: "NOT_FOUND" });
      res.json(await serviceLinkView(link));
    }),
  );

  router.post(
    "/service/merchant/links/:linkId/payment-requests",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const id = String(req.params.linkId);
      const link = await store.findMerchantLink(id);
      const refuse = async (status: number, outcome: string, body: Record<string, unknown>) => {
        await audit("service.merchant_request_create", caller, id, outcome);
        return res.status(status).json(body);
      };
      if (!link) return await refuse(404, "not_found", { error: "not found", code: "NOT_FOUND" });
      if (link.revokedAt) return await refuse(403, "revoked", { error: "this merchant link was revoked", code: "LINK_REVOKED" });
      if (!(await merchantLinksAvailable()).available) {
        return await refuse(503, "unavailable", { error: "merchant links are not available on this deployment", code: "MERCHANT_LINKS_UNAVAILABLE" });
      }
      const body = parseCreate(req.body);
      if ("error" in body) return await refuse(400, "invalid", { ...body, code: "INVALID_REQUEST" });
      const base = baseUrlFor(req);
      // Answer with an existing request for the order when it is this
      // link's; another link's or org's is not ours to hand out.
      const answer = async (r: PaymentRequest, status: number, outcome: string) => {
        return store.tx(async () => {
          if (r.source.linkId !== link.id || r.orgId !== link.orgId) {
            await audit("service.merchant_request_create", caller, id, "order_taken");
            return res.status(409).json({ error: "this order already has a payment request elsewhere", code: "ORDER_TAKEN" });
          }
          await audit("service.merchant_request_create", caller, id, outcome, { paymentRequestId: r.id }, r.userId);
          return res.status(status).json(serviceRequestView(r, base));
        });
      };
      // The shop is the link's, never the body's.
      const existing = await store.findPaymentRequestBySource("shopify", body.gid, link.shop);
      if (existing) return await answer(existing, 200, "existing");
      // Fail closed on a payee that is no longer the one the org would choose.
      const payeeProblem = await linkPayeeProblem(link);
      if (payeeProblem) return await refuse(409, "stale_payee", { error: payeeProblem, code: "NO_PAYMENT_PAGE" });
      const payee = await store.findUser(link.payeeUserId);
      if (!payee?.paymentPage?.handle || !payee.paymentPage.depositAddress) {
        return await refuse(409, "no_payment_page", { error: "the receiving account has no payment page; an organisation admin must link the store again from the dashboard", code: "NO_PAYMENT_PAGE" });
      }
      let created = false;
      const r = await openOnce(`${link.shop}|${body.gid}`, async () => {
        created = true;
        return createPaymentRequest(
          payee,
          {
            amountEur: body.amountEur,
            description: body.description ?? `Order ${body.name ?? ""} at ${link.shop}`.replace(/\s+/g, " "),
            methods: CHECKOUT_SERVICE.bankPayments && payee.iban ? ["crypto", "bank"] : ["crypto"],
            expiresAt: new Date(Date.now() + body.expiresInMs).toISOString(),
            ...(body.test ? { test: true } : {}),
          },
          {
            kind: "shopify",
            externalId: body.gid,
            shop: link.shop,
            orderGid: body.gid,
            ...(body.name ? { orderName: body.name } : {}),
            ...(body.statusUrl ? { orderStatusUrl: body.statusUrl, returnUrl: body.statusUrl } : {}),
            linkId: link.id,
          },
          link.orgId,
        );
      });
      if (created) await store.updateMerchantLink(link.id, { lastRequestAt: new Date().toISOString() });
      return await answer(r, created ? 201 : 200, created ? "created" : "existing");
    }),
  );

  router.get(
    "/service/merchant/links/:linkId/payment-requests/:id",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const linkId = String(req.params.linkId);
      const r = await requestOfLink(await store.findMerchantLink(linkId), String(req.params.id));
      await audit("service.merchant_request_read", caller, linkId, r ? "served" : "not_found", { paymentRequestId: String(req.params.id).slice(0, MAX_AUDITED_ID) }, r?.userId);
      if (!r) return res.status(404).json({ error: "not found", code: "NOT_FOUND" });
      res.json(serviceRequestView(r, baseUrlFor(req)));
    }),
  );

  router.post(
    "/service/merchant/links/:linkId/payment-requests/:id/cancel",
    wrap(async (req, res) => {
      const caller = await checkoutCaller(req, res);
      if (!caller) return;
      const linkId = String(req.params.linkId);
      const r = await requestOfLink(await store.findMerchantLink(linkId), String(req.params.id));
      const extra = { paymentRequestId: String(req.params.id).slice(0, MAX_AUDITED_ID) };
      if (!r) {
        await audit("service.merchant_request_cancel", caller, linkId, "not_found", extra);
        return res.status(404).json({ error: "not found", code: "NOT_FOUND" });
      }
      const base = baseUrlFor(req);
      if (effectiveState(r) !== "OPEN" || r.payments.length > 0) {
        await audit("service.merchant_request_cancel", caller, linkId, "not_cancellable", extra, r.userId);
        return res.status(409).json({ error: "this request is not open, or a payment has arrived against it", code: "NOT_CANCELLABLE", request: serviceRequestView(r, base) });
      }
      // Checked again on the stored row: a payment recorded since the read keeps it.
      const cancelled = await store.cancelUnpaidPaymentRequest(r.id);
      if (!cancelled) {
        await audit("service.merchant_request_cancel", caller, linkId, "not_cancellable", extra, r.userId);
        const now = await store.findPaymentRequest(r.id);
        return res.status(409).json({ error: "this request is not open, or a payment has arrived against it", code: "NOT_CANCELLABLE", request: serviceRequestView(now!, base) });
      }
      await audit("service.merchant_request_cancel", caller, linkId, "cancelled", extra, r.userId);
      res.json(serviceRequestView(cancelled, base));
    }),
  );

  return router;
}
