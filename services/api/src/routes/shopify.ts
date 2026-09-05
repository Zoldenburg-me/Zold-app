/**
 * /api/shopify/* and /api/orgs/:orgId/shopify — Zold as a Shopify payments app.
 *
 * THE SHAPE. Shopify's "offsite" payments-app flow: the buyer picks Zold at
 * checkout, Shopify POSTs a payment session to us, we answer with a redirect
 * to the pay page for a payment request sized from the session, the buyer
 * pays USDC there, and the moment the deposit is attributed we call
 * paymentSessionResolve on the store's Payments Apps API. Shopify then marks
 * the order paid and hands back the URL the buyer should land on.
 *
 * WHAT IS REAL AND WHAT IS NOT, stated here because the surface looks
 * finished:
 *  - The request/response contract, HMAC verification, session → request →
 *    resolve, and the refund/capture/void rejections are built to Shopify's
 *    documented shapes and proven against a stub (npm run shopify:test).
 *  - No real store has installed the app. A payments app must be approved
 *    into Shopify's Payments Apps program in the Partner Dashboard before a
 *    store can install it; that approval is a partner-side step nobody has
 *    started. Until then SHOPIFY_API_KEY is unset and this router reports
 *    `unavailable`.
 *  - Crypto only. A checkout needs an answer within the session's life, and
 *    a SEPA transfer does not arrive in an hour, so bank payment is not
 *    offered on a checkout request (it remains available on ordinary links).
 *  - Sale only. `kind: authorization` (manual capture) is refused with a
 *    merchant-readable reason; there is no hold-then-capture on a chain
 *    transfer the buyer makes from their own wallet.
 *  - Refunds are manual. A refund session is acknowledged and then REJECTED
 *    with a merchant message: the merchant pays the buyer back from Zold
 *    themselves (the buyer's address is on the deposit record). Auto-refunding
 *    to whichever address happened to send the funds is how exchange hot
 *    wallets get refunded instead of customers.
 */
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { MONERIUM, PAYMENT_REQUESTS, SHOPIFY } from "../config.js";
import { store, type User } from "../store.js";
import { decryptField, encryptField, EncryptionUnavailableError } from "../crypto-at-rest.js";
import { displayCode, effectiveState, normaliseCode, type PaymentRequest } from "../payment-requests.js";
import { baseUrlFor, createPaymentRequest } from "./payment-requests.js";
import { requirePermission, resolveOrg, type SessionResolver } from "./org-context.js";
import { isValidShopDomain, normaliseShop, verifyBodyHmac, verifyQueryHmac } from "../shopify/hmac.js";
import {
  authorizeUrl,
  captureSessionReject,
  exchangeCode,
  paymentSessionReject,
  paymentSessionResolve,
  paymentsAppConfigure,
  refundSessionReject,
  ShopifyApiError,
  voidSessionReject,
} from "../shopify/admin.js";
import type { ShopifyConnection } from "../shopify/types.js";

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    fn(req, res).catch(next);

/** Pending installs: our nonce → who started it. In memory on purpose; an
 *  install that outlives a restart simply starts again. */
const pendingInstalls = new Map<string, { orgId: string; shop: string; payeeUserId: string; installerId: string; expiresAt: number }>();

export function shopifyAvailable(): { available: boolean; reason?: string } {
  if (!SHOPIFY.enabled) return { available: false, reason: "SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set — no Shopify app is registered for this deployment" };
  if (!MONERIUM.tokenEncryptionKey) return { available: false, reason: "no encryption key (MONERIUM_TOKEN_ENCRYPTION_KEY) to store a store's access token" };
  return { available: true };
}

function tokenOf(c: ShopifyConnection): string {
  return decryptField("shopify", MONERIUM.tokenEncryptionKey, c.accessTokenEnc);
}

export function publicConnection(c: ShopifyConnection) {
  const payee = store.findUser(c.payeeUserId);
  return {
    id: c.id,
    shop: c.shop,
    payeeUserId: c.payeeUserId,
    payeeHandle: payee?.paymentPage?.handle,
    scope: c.scope,
    installedAt: c.installedAt,
    configuredAt: c.configuredAt,
    configureError: c.configureError,
    lastSessionAt: c.lastSessionAt,
    ready: Boolean(c.configuredAt),
  };
}

/** Whose payment page a store pays into: the org's EUR account's backing
 *  user when there is one, else the installer. Must have a payment page. */
function payeeFor(orgId: string, installerId: string): { user?: User; reason?: string } {
  const eurAccount = store.accountsOf(orgId).find((a) => a.currency === "EUR" && a.backingUserId);
  const user = store.findUser(eurAccount?.backingUserId ?? installerId);
  if (!user) return { reason: "no account to receive into" };
  if (!user.paymentPage?.handle || !user.paymentPage.depositAddress) {
    return { reason: `${user.id === installerId ? "you" : "the account backing this organisation's EUR account"} must claim a payment page first (Profile → Payment page)` };
  }
  return { user };
}

/** Tell Shopify a paid checkout request is paid. Idempotent; records the
 *  outcome on the request so the sweep can retry a failure. */
export async function resolveShopifyRequest(r: PaymentRequest): Promise<void> {
  if (r.source.kind !== "shopify" || r.source.resolvedAt || r.state !== "PAID") return;
  if (!r.source.shop || !r.source.sessionGid) return;
  const connection = store.findShopifyConnectionByShop(r.source.shop);
  const attempts = (r.source.resolveAttempts ?? 0) + 1;
  if (!connection) {
    store.updatePaymentRequest(r.id, { source: { ...r.source, resolveAttempts: attempts, resolveError: "the store is no longer connected" } });
    return;
  }
  try {
    const result = await paymentSessionResolve(connection.shop, tokenOf(connection), r.source.sessionGid);
    store.updatePaymentRequest(r.id, {
      source: { ...r.source, resolvedAt: new Date().toISOString(), resolveAttempts: attempts, resolveError: undefined, ...(result.redirectUrl ? { returnUrl: result.redirectUrl } : {}) },
    });
    console.log(`shopify: resolved session for ${displayCode(r.code)} at ${connection.shop}`);
  } catch (err: any) {
    store.updatePaymentRequest(r.id, { source: { ...r.source, resolveAttempts: attempts, resolveError: String(err?.message ?? err).slice(0, 300) } });
    throw err;
  }
}

export function createShopifyRouter(requireSession: SessionResolver): express.Router {
  const router = express.Router();

  // ── Merchant side: connect a store to an organisation ─────────────────

  router.get(
    "/orgs/:orgId/shopify",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.read")) return;
      const connections = store.shopifyConnectionsForOrg(ctx.org.id);
      const shops = new Set(connections.map((c) => c.shop));
      const base = baseUrlFor(req);
      const requests = store.paymentRequests
        .filter((r) => r.source.kind === "shopify" && r.source.shop && shops.has(r.source.shop))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 100)
        .map((r) => ({
          id: r.id,
          code: displayCode(r.code),
          url: `${base}/pay/${encodeURIComponent(r.handle)}/${displayCode(r.code)}`,
          shop: r.source.shop,
          sessionId: r.source.externalId,
          amountEur: r.amountEur,
          state: effectiveState(r),
          test: r.test,
          payments: r.payments,
          resolvedAt: r.source.resolvedAt,
          resolveError: r.source.resolveError,
          createdAt: r.createdAt,
          paidAt: r.paidAt,
        }));
      res.json({
        ...shopifyAvailable(),
        endpoints: {
          payment: `${base}/api/shopify/payment`,
          refund: `${base}/api/shopify/refund`,
          capture: `${base}/api/shopify/capture`,
          void: `${base}/api/shopify/void`,
          redirect: `${base}/api/shopify/callback`,
        },
        connections: connections.map(publicConnection),
        requests,
      });
    }),
  );

  router.post(
    "/orgs/:orgId/shopify/install",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.update")) return;
      const avail = shopifyAvailable();
      if (!avail.available) return res.status(503).json({ error: avail.reason, unavailable: true });
      const shop = normaliseShop(String(req.body?.shop ?? ""));
      if (!isValidShopDomain(shop)) {
        return res.status(400).json({ error: "shop must be the store's myshopify.com domain, e.g. my-store.myshopify.com" });
      }
      const existing = store.findShopifyConnectionByShop(shop);
      if (existing && existing.orgId !== ctx.org.id) {
        return res.status(409).json({ error: "this store is connected to a different organisation" });
      }
      const payee = payeeFor(ctx.org.id, ctx.userId);
      if (!payee.user) return res.status(409).json({ error: payee.reason });
      const state = randomBytes(24).toString("base64url");
      for (const [k, v] of pendingInstalls) if (v.expiresAt < Date.now()) pendingInstalls.delete(k);
      pendingInstalls.set(state, { orgId: ctx.org.id, shop, payeeUserId: payee.user.id, installerId: ctx.userId, expiresAt: Date.now() + 15 * 60_000 });
      const redirectUri = `${baseUrlFor(req)}/api/shopify/callback`;
      res.json({ shop, authorizeUrl: authorizeUrl(shop, redirectUri, state), payeeHandle: payee.user.paymentPage!.handle });
    }),
  );

  router.get(
    "/shopify/callback",
    wrap(async (req, res) => {
      const base = baseUrlFor(req);
      const back = (params: Record<string, string>) => res.redirect(`${base}/business?${new URLSearchParams({ view: "shopify", ...params })}`);
      const q = req.query as Record<string, unknown>;
      if (!SHOPIFY.enabled) return back({ error: "Shopify is not configured on this deployment" });
      if (!verifyQueryHmac(q, SHOPIFY.apiSecret)) return back({ error: "the install callback did not verify — try connecting again" });
      const shop = normaliseShop(String(q.shop ?? ""));
      const pending = pendingInstalls.get(String(q.state ?? ""));
      if (!pending || pending.expiresAt < Date.now() || pending.shop !== shop || !isValidShopDomain(shop)) {
        return back({ error: "this install was not started from Zold, or it has expired — start again from the dashboard" });
      }
      pendingInstalls.delete(String(q.state));
      let token: { accessToken: string; scope: string };
      try {
        token = await exchangeCode(shop, String(q.code ?? ""));
      } catch (err: any) {
        return back({ error: `Shopify refused the install: ${String(err?.message ?? err).slice(0, 160)}` });
      }
      let enc: string;
      try {
        enc = encryptField("shopify", MONERIUM.tokenEncryptionKey, token.accessToken);
      } catch (err) {
        if (err instanceof EncryptionUnavailableError) return back({ error: err.message });
        throw err;
      }
      const now = new Date().toISOString();
      const existing = store.findShopifyConnectionByShop(shop);
      const connection = existing
        ? store.updateShopifyConnection(existing.id, { accessTokenEnc: enc, scope: token.scope, payeeUserId: pending.payeeUserId, installedByUserId: pending.installerId, installedAt: now, configuredAt: undefined, configureError: undefined })
        : store.addShopifyConnection({
            id: randomUUID(),
            orgId: pending.orgId,
            shop,
            payeeUserId: pending.payeeUserId,
            accessTokenEnc: enc,
            scope: token.scope,
            installedByUserId: pending.installerId,
            installedAt: now,
            updatedAt: now,
          });
      const payee = store.findUser(pending.payeeUserId);
      try {
        await paymentsAppConfigure(shop, token.accessToken, payee?.paymentPage?.handle ?? pending.orgId, true);
        store.updateShopifyConnection(connection.id, { configuredAt: new Date().toISOString(), configureError: undefined });
      } catch (err: any) {
        store.updateShopifyConnection(connection.id, { configureError: String(err?.message ?? err).slice(0, 300) });
      }
      back({ shop });
    }),
  );

  router.delete(
    "/orgs/:orgId/shopify/:id",
    wrap(async (req, res) => {
      const ctx = resolveOrg(req, res, requireSession);
      if (!ctx) return;
      if (!requirePermission(ctx, res, "org.update")) return;
      const c = store.shopifyConnectionsForOrg(ctx.org.id).find((x) => x.id === req.params.id);
      if (!c) return res.status(404).json({ error: "no such connection" });
      // Best effort: tell the store the method is gone. A failure here does
      // not keep the connection — the merchant asked to disconnect.
      try {
        await paymentsAppConfigure(c.shop, tokenOf(c), undefined as unknown as string, false);
      } catch {
        /* the token may already be revoked; disconnecting is still right */
      }
      store.removeShopifyConnection(c.id);
      res.json({ ok: true });
    }),
  );

  // ── Shopify side: session webhooks, HMAC-signed ────────────────────────

  /** Authenticate a request from Shopify and find the store it is about. */
  const fromShopify = (req: express.Request, res: express.Response): ShopifyConnection | undefined => {
    if (!SHOPIFY.enabled) {
      res.status(503).json({ error: "Shopify is not configured on this deployment" });
      return undefined;
    }
    if (!verifyBodyHmac((req as any).rawBody, req.header("shopify-hmac-sha256"), SHOPIFY.apiSecret)) {
      res.status(401).json({ error: "signature did not verify" });
      return undefined;
    }
    const shop = normaliseShop(req.header("shopify-shop-domain") ?? "");
    const c = shop ? store.findShopifyConnectionByShop(shop) : undefined;
    if (!c) {
      res.status(404).json({ error: "this store is not connected to Zold" });
      return undefined;
    }
    return c;
  };

  router.post(
    "/shopify/payment",
    wrap(async (req, res) => {
      const c = fromShopify(req, res);
      if (!c) return;
      const b = req.body ?? {};
      const sessionId = String(b.id ?? "");
      const gid = String(b.gid ?? "");
      if (!sessionId || !gid) return res.status(400).json({ error: "id and gid are required" });
      const base = baseUrlFor(req);
      const pageUrl = (r: PaymentRequest) => `${base}/pay/${encodeURIComponent(r.handle)}/${displayCode(r.code)}`;
      // Shopify retries; the same session must get the same page.
      const existing = store.findPaymentRequestBySource("shopify", sessionId);
      if (existing) return res.status(201).json({ redirect_url: pageUrl(existing) });
      if (String(b.currency ?? "").toUpperCase() !== "EUR") {
        return res.status(422).json({ error: `Zold settles in EUR; this store presented ${b.currency}. Restrict the payment method to EUR in the store's payment settings.` });
      }
      const amount = Number(b.amount);
      if (!(amount > 0)) return res.status(400).json({ error: "amount must be positive" });
      if (String(b.kind ?? "sale") !== "sale") {
        // Manual capture asks for a hold we cannot place on a wallet transfer.
        // Tell the merchant in their admin, then decline the session.
        paymentSessionReject(c.shop, tokenOf(c), gid, "PROCESSING_ERROR",
          "Zold takes immediate payment only. Switch this payment method to automatic capture.").catch(() => {});
        return res.status(422).json({ error: "only kind=sale is supported" });
      }
      const payee = store.findUser(c.payeeUserId);
      if (!payee?.paymentPage?.handle) return res.status(409).json({ error: "the receiving account has no payment page" });
      const r = await createPaymentRequest(
        payee,
        {
          amountEur: Math.round(amount * 100) / 100,
          description: `Order at ${c.shop}`,
          methods: ["crypto"],
          expiresAt: new Date(Date.now() + PAYMENT_REQUESTS.checkoutTtlMs).toISOString(),
          ...(b.test === true ? { test: true } : {}),
        },
        {
          kind: "shopify",
          externalId: sessionId,
          shop: c.shop,
          sessionGid: gid,
          sessionKind: String(b.kind ?? "sale"),
          ...(typeof b.payment_method?.data?.cancel_url === "string" ? { cancelUrl: b.payment_method.data.cancel_url } : {}),
        },
        c.orgId,
      );
      store.updateShopifyConnection(c.id, { lastSessionAt: new Date().toISOString() });
      res.status(201).json({ redirect_url: pageUrl(r) });
    }),
  );

  const ackThenReject = (
    reject: (shop: string, token: string, gid: string, msg: string) => Promise<void>,
    message: string,
  ) =>
    wrap(async (req, res) => {
      const c = fromShopify(req, res);
      if (!c) return;
      const gid = String(req.body?.gid ?? "");
      if (!gid) return res.status(400).json({ error: "gid is required" });
      // Shopify wants a 201 first and the verdict by mutation afterwards.
      res.status(201).json({});
      reject(c.shop, tokenOf(c), gid, message).catch((err) =>
        console.error(`shopify: could not reject session ${gid} at ${c.shop}: ${err?.message ?? err}`),
      );
    });

  router.post("/shopify/refund", ackThenReject(refundSessionReject,
    "Zold does not refund automatically: crypto payments come from an address that may not be the buyer's own wallet. Refund the buyer from your Zold account and record it on the order."));
  router.post("/shopify/capture", ackThenReject(captureSessionReject,
    "Zold takes immediate payment only; there is nothing to capture. Switch this payment method to automatic capture."));
  router.post("/shopify/void", ackThenReject(voidSessionReject,
    "Zold takes immediate payment only; there is no authorization to void."));

  // ── Buyer side: back to the store ──────────────────────────────────────

  const requestFromCode = (raw: string) => {
    const code = normaliseCode(raw);
    const r = store.findPaymentRequestByCode(code);
    return r?.source.kind === "shopify" ? r : undefined;
  };

  router.get(
    "/shopify/return/:code",
    wrap(async (req, res) => {
      const r = requestFromCode(String(req.params.code ?? ""));
      const base = baseUrlFor(req);
      if (!r) return res.status(404).send("no such checkout");
      const page = `${base}/pay/${encodeURIComponent(r.handle)}/${displayCode(r.code)}`;
      if (r.state !== "PAID") return res.redirect(page);
      let fresh = store.findPaymentRequest(r.id)!;
      if (!fresh.source.resolvedAt) {
        try {
          await resolveShopifyRequest(fresh);
        } catch {
          /* recorded on the request; the page explains */
        }
        fresh = store.findPaymentRequest(r.id)!;
      }
      res.redirect(fresh.source.returnUrl ?? `${page}?notice=store-pending`);
    }),
  );

  router.get(
    "/shopify/cancel/:code",
    wrap(async (req, res) => {
      const r = requestFromCode(String(req.params.code ?? ""));
      const base = baseUrlFor(req);
      if (!r) return res.status(404).send("no such checkout");
      if (r.state === "OPEN" && r.payments.length === 0) {
        store.updatePaymentRequest(r.id, { state: "CANCELLED", cancelledAt: new Date().toISOString() });
      }
      res.redirect(r.source.cancelUrl ?? `${base}/pay/${encodeURIComponent(r.handle)}/${displayCode(r.code)}`);
    }),
  );

  return router;
}

export { ShopifyApiError };
