/**
 * Merchant links: an organisation's consent that the checkout service may
 * open payment requests for it, for one Shopify shop.
 *
 * The checkout service (a separate deployment) owns everything Shopify-facing
 * for a linked shop: the OAuth install, the shop's access token, Shopify's
 * webhooks, "Mark as paid". We keep the money engine: the request, the
 * attribution of the deposit, the pay page. The routes are
 * routes/merchant-links.ts (the org's side) and routes/service-merchant.ts
 * (the checkout's side, behind its `zsc_` credential).
 *
 * The consent travels as a link code: `zlc_` + 256 random bits, one use,
 * 15 minutes, held in memory as its SHA-256 and bound to the org, the shop,
 * the payee and the member who asked. The checkout exchanges it once the
 * merchant has approved the app at Shopify, and every check the code was
 * issued under is asked again then.
 *
 * A shop is either linked here or connected in routes/shopify.ts, never both:
 * each side refuses a shop the other holds.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CHECKOUT_SERVICE } from "./config.js";
import { dataEncryptionProblem } from "./config/data-keys.js";
import { checkoutCredentialIssued } from "./checkout-service.js";
import { displayCode, effectiveState, type PaymentRequest } from "./payment-requests.js";
import { roleCan } from "./domain/roles.js";
import { SECRETS } from "./stored-secrets.js";
import { store, type MerchantLink } from "./store.js";
import { payeeFor } from "./routes/shopify.js";

/** How long a link code may wait for the merchant to approve at Shopify. */
export const LINK_CODE_TTL_MS = 15 * 60_000;
/** Longest a request the checkout opens may stay open. */
export const MAX_REQUEST_TTL_MS = 7 * 24 * 3_600_000;

export type MerchantLinkRefusalCode =
  | "SHOP_LINKED_ELSEWHERE"
  | "SHOP_CONNECTED_IN_CORE"
  | "INSTALLER_NOT_ALLOWED"
  | "NO_PAYMENT_PAGE";

export interface MerchantLinkRefusal {
  code: MerchantLinkRefusalCode;
  error: string;
}

/** Whether this deployment can link a shop: the checkout's origin is known,
 *  a checkout credential exists, and the link secret can be sealed. */
export function merchantLinksAvailable(): { available: boolean; checkoutOrigin?: string; reason?: string } {
  if (!CHECKOUT_SERVICE.origin) return { available: false, reason: "CHECKOUT_SERVICE_ORIGIN is not set" };
  if (!checkoutCredentialIssued()) return { available: false, reason: "no checkout service credential has been issued" };
  const keyProblem = dataEncryptionProblem();
  if (keyProblem) return { available: false, reason: `${keyProblem}, so a link's secret cannot be stored` };
  return { available: true, checkoutOrigin: CHECKOUT_SERVICE.origin };
}

/**
 * Why this org may not link this shop now, or undefined when it may.
 * Asked when the code is issued and again at exchange. `installerId` is the
 * member whose consent it is; a missing org refuses like a missing member.
 */
export function linkRefusal(orgId: string, shop: string, installerId: string): MerchantLinkRefusal | undefined {
  const member = store.findOrganisation(orgId) ? store.memberFor(orgId, installerId) : undefined;
  if (!member || member.status !== "active" || !roleCan(member.role, "org.update")) {
    return { code: "INSTALLER_NOT_ALLOWED", error: "whoever started this link can no longer connect stores for the organisation — start again from the dashboard" };
  }
  const active = store.activeMerchantLinkForShop(shop);
  if (active && active.orgId !== orgId) {
    return { code: "SHOP_LINKED_ELSEWHERE", error: "this store is linked to a different organisation" };
  }
  if (store.findShopifyConnectionByShop(shop)) {
    return { code: "SHOP_CONNECTED_IN_CORE", error: "this store is connected to Zold directly — disconnect it under Connected stores first" };
  }
  const payee = payeeFor(orgId, installerId);
  if (!payee.user) return { code: "NO_PAYMENT_PAGE", error: payee.reason ?? "no account to receive into" };
  return undefined;
}

// ── Link codes ───────────────────────────────────────────────────────────

interface PendingLink {
  orgId: string;
  shop: string;
  payeeUserId: string;
  installerId: string;
  expiresAt: number;
}

/** sha256(code) → the consent it carries. In memory on purpose: a code that
 *  outlives a restart is simply issued again. */
const pendingLinks = new Map<string, PendingLink>();

const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Void every code waiting for this org and shop: a revoke must not be
 *  undone by a consent given before it. */
export function voidLinkCodes(orgId: string, shop: string): number {
  let n = 0;
  for (const [k, v] of pendingLinks) {
    if (v.orgId === orgId && v.shop === shop) { pendingLinks.delete(k); n++; }
  }
  return n;
}

export function issueLinkCode(p: Omit<PendingLink, "expiresAt">, now = Date.now()): { code: string; expiresAt: number } {
  for (const [k, v] of pendingLinks) if (v.expiresAt <= now) pendingLinks.delete(k);
  const code = `zlc_${randomBytes(32).toString("base64url")}`;
  const expiresAt = now + LINK_CODE_TTL_MS;
  pendingLinks.set(codeHash(code), { ...p, expiresAt });
  return { code, expiresAt };
}

/**
 * Take a code: removed on the first call whatever the outcome, so a code is
 * worth one exchange. Undefined when unknown, expired, or issued for another
 * shop.
 */
export function consumeLinkCode(code: unknown, shop: string, now = Date.now()): PendingLink | undefined {
  if (typeof code !== "string" || !/^zlc_[A-Za-z0-9_-]{43}$/.test(code)) return undefined;
  const key = codeHash(code);
  const p = pendingLinks.get(key);
  pendingLinks.delete(key);
  if (!p || p.expiresAt <= now || p.shop !== shop) return undefined;
  return p;
}

// ── The link ─────────────────────────────────────────────────────────────

export function linkSecretOf(l: MerchantLink): string {
  return SECRETS.merchantLinkSecret.open(l.id, l.linkSecretEnc);
}

/**
 * Make or reuse the org's active link for the shop. A reused link keeps its
 * secret (the store's email template carries it) and takes the payee the
 * fresh consent names. The secret is sealed before the row is written; no
 * await between the caller's last check and this write.
 */
export function establishLink(p: PendingLink): { link: MerchantLink; previousPayeeUserId?: string } {
  const existing = store.activeMerchantLinkForShop(p.shop);
  if (existing && existing.orgId === p.orgId) {
    if (existing.payeeUserId === p.payeeUserId && existing.createdBy === p.installerId) return { link: existing };
    const previousPayeeUserId = existing.payeeUserId !== p.payeeUserId ? existing.payeeUserId : undefined;
    // The fresh consent is the one in force: its member and its payee.
    const link = store.updateMerchantLink(existing.id, { payeeUserId: p.payeeUserId, createdBy: p.installerId });
    return { link, ...(previousPayeeUserId ? { previousPayeeUserId } : {}) };
  }
  const id = randomUUID();
  const linkSecretEnc = SECRETS.merchantLinkSecret.seal(id, randomBytes(32).toString("hex"));
  const now = new Date().toISOString();
  const link = store.addMerchantLink({
    id,
    orgId: p.orgId,
    integration: "shopify",
    shop: p.shop,
    payeeUserId: p.payeeUserId,
    linkSecretEnc,
    createdBy: p.installerId,
    createdAt: now,
    updatedAt: now,
  });
  return { link };
}

/**
 * Why the link may not open a request for its payee now, or undefined.
 * The payee was chosen when the store was linked; the org may since have
 * gained a EUR account backed by someone else, or lost the member whose own
 * page it was. Either way the money would land somewhere the org did not
 * choose, so nothing opens until an admin links the store again.
 */
export function linkPayeeProblem(l: MerchantLink): string | undefined {
  const relink = "an organisation admin must link the store again from the dashboard";
  const eurBacked = store.accountsOf(l.orgId).some((a) => a.currency === "EUR" && a.backingUserId);
  if (!eurBacked) {
    const m = store.memberFor(l.orgId, l.createdBy);
    if (!m || m.status !== "active") return `the member whose payment page this store pays into has left the organisation; ${relink}`;
  }
  const payee = payeeFor(l.orgId, l.createdBy);
  if (!payee.user) return `${payee.reason ?? "no account to receive into"}; ${relink}`;
  if (payee.user.id !== l.payeeUserId) return `the organisation's receiving account has changed since this store was linked; ${relink}`;
  return undefined;
}

/** The Liquid for the store's order-confirmation email: a link to the
 *  checkout's pay route, the order id signed with the link's secret. */
export function payLinkTemplate(origin: string, l: MerchantLink): string {
  return `${origin}/shopify/orders/${encodeURIComponent(l.shop)}/{{ id }}/pay?b={{ id | hmac_sha256: "${linkSecretOf(l)}" }}`;
}

/** What the org sees of a link. The creator by display name only. */
export function publicLink(l: MerchantLink) {
  return {
    id: l.id,
    integration: l.integration,
    shop: l.shop,
    payeeHandle: store.findUser(l.payeeUserId)?.paymentPage?.handle,
    createdAt: l.createdAt,
    createdBy: store.findUser(l.createdBy)?.name,
    ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}),
    ...(l.lastRequestAt ? { lastRequestAt: l.lastRequestAt } : {}),
  };
}

/** What the checkout reads of a link. */
export function serviceLinkView(l: MerchantLink) {
  return {
    linkId: l.id,
    shop: l.shop,
    active: !l.revokedAt,
    ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}),
    payeeHandle: store.findUser(l.payeeUserId)?.paymentPage?.handle,
  };
}

/**
 * The allowlist the checkout receives for a request. Built field by field,
 * so a field added to PaymentRequest never reaches it by accident. No payer
 * name, no IBAN, no quote: the buyer-facing projection is core's public
 * `publicPath`.
 */
export function serviceRequestView(r: PaymentRequest, base: string) {
  const code = displayCode(r.code);
  const handle = encodeURIComponent(r.handle);
  return {
    id: r.id,
    code,
    handle: r.handle,
    state: effectiveState(r),
    amountEur: r.amountEur,
    currency: "EUR" as const,
    ...(r.test ? { test: true } : {}),
    createdAt: r.createdAt,
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
    ...(r.paidAt ? { paidAt: r.paidAt } : {}),
    order: {
      gid: r.source.orderGid ?? r.source.externalId,
      ...(r.source.orderName ? { name: r.source.orderName } : {}),
    },
    shop: r.source.shop,
    payments: r.payments.map((p) => ({
      method: p.method,
      amountEur: p.amountEur,
      ...(p.amountUsdc !== undefined ? { amountUsdc: p.amountUsdc } : {}),
      ...(p.txHash ? { txHash: p.txHash } : {}),
      at: p.at,
    })),
    pageUrl: `${base}/pay/${handle}/${code}`,
    publicPath: `/api/pay/${handle}/${code}`,
  };
}
