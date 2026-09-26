/**
 * /api/users/:id/payment-requests (owner) and /api/pay/:handle/:code (payer).
 *
 * A router factory taking the session check, like the org routers, so
 * server.ts stays the single owner of authentication. The attribution hooks at
 * the bottom are what the crypto poller and the Monerium order poller call
 * when money shows up; they hold no network of their own.
 */
import { wrap } from "./util.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { CHAIN_ID, PAYMENT_REQUESTS, PUBLIC_URL } from "../config.js";
import { store, type CryptoDeposit, type User } from "../store.js";
import {
  buildBankSettlement,
  orderNamesInvoice,
  payableEur,
  withSettlement,
  type MoneriumOrderLike,
} from "../domain/invoices.js";
import { addrs } from "../chain.js";
import { midRates } from "../rates.js";
import {
  applyPayment,
  availableMethods,
  currentQuote,
  displayCode,
  effectiveState,
  isRequestCode,
  matchDepositToRequests,
  matchMoneriumOrder,
  matchTransfer,
  newRequestCode,
  normaliseCode,
  ownerPaymentRequest,
  PaymentRequestError,
  publicPaymentRequest,
  quoteCrypto,
  validateCreate,
  withQuote,
  type CryptoQuote,
  type PaymentRequest,
  type PaymentRequestSource,
} from "../payment-requests.js";

type SessionCheck = (req: express.Request, res: express.Response, userId: string) => unknown;


export function baseUrlFor(req: express.Request): string {
  return PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

function payToken() {
  return { symbol: "USDC", address: addrs().usdc, decimals: 6 };
}

/** LHV's BIC, only beside an Estonian IBAN it applies to (documents.ts holds
 *  the same rule; duplicated here to keep this module free of that import). */
/** What the payer-facing projection needs from this deployment. Exported so
 *  the Shopify order lookup renders the SAME projection the pay page does. */
export function payerContext(req: express.Request, quote?: CryptoQuote) {
  return { chainId: CHAIN_ID, token: payToken(), bicFor, baseUrl: baseUrlFor(req), quote };
}

const bicFor = (iban?: string) => (iban && /^EE/i.test(iban.replace(/\s/g, "")) ? "LHVBEE22" : undefined);

/** Amounts this payee has quoted on requests still open — the set a new quote
 *  must not collide with. */
function openQuotedAmounts(userId: string, exceptRequestId?: string): number[] {
  return store
    .paymentRequestsForUser(userId)
    .filter((r) => r.id !== exceptRequestId && effectiveState(r) === "OPEN")
    .flatMap((r) => r.cryptoQuotes.map((q) => q.amountUsdc));
}

async function liveMid() {
  const r = await midRates();
  return { usdPerEur: r.eur.USD, provider: r.provider, asOf: r.asOf };
}

/**
 * Make sure a fixed-amount request offering crypto has a fresh quote. Rates
 * unavailable is not fatal here: the request is still created and the page
 * says crypto cannot be quoted right now, which is the truth.
 */
export async function ensureQuote(r: PaymentRequest, amountEur: number | undefined): Promise<{ request: PaymentRequest; quote?: CryptoQuote }> {
  if (!r.methods.includes("crypto") || amountEur === undefined || effectiveState(r) !== "OPEN") return { request: r };
  const existing = currentQuote(r, amountEur);
  if (existing) return { request: r, quote: existing };
  let mid;
  try {
    mid = await liveMid();
  } catch {
    return { request: r };
  }
  const quote = quoteCrypto(amountEur, mid, [...openQuotedAmounts(r.userId, r.id), ...r.cryptoQuotes.map((q) => q.amountUsdc)]);
  const updated = store.updatePaymentRequest(r.id, { cryptoQuotes: withQuote(r, quote) });
  return { request: updated, quote };
}

/**
 * Create a request on behalf of a payee. Shared by the owner route and the
 * merchant integrations (Shopify), which is why it is exported: one code path
 * decides what a request looks like.
 */
/**
 * May this request collect for this invoice?
 *
 * Only an invoice the payee's own organisation issued. Another org's invoice
 * would attach a stranger's payment to their books, and an incoming invoice
 * is a bill to pay via a draft, not a payment link.
 *
 * A settled invoice is refused: two live ways to pay one invoice lets it be
 * paid twice.
 */
function assertInvoiceCollectable(invoiceId: string, orgId: string | undefined, payee: User) {
  const invoice = store.findInvoice(invoiceId);
  if (!invoice) throw new PaymentRequestError("no such invoice", 404);
  if (!orgId || invoice.orgId !== orgId) {
    throw new PaymentRequestError("that invoice belongs to another organisation", 403);
  }
  // The link pays into the PAYEE's Safe, so that Safe must be the one behind
  // the organisation's account — otherwise any member could raise a link that
  // routes a customer's payment for the company's invoice into their own
  // account and still close the invoice.
  if (!orgsBackedBy(payee.id).has(invoice.orgId)) {
    throw new PaymentRequestError(
      "that invoice's organisation is not paid into your account — only the person whose account backs it can collect it",
      403,
    );
  }
  if (invoice.direction !== "outgoing") {
    throw new PaymentRequestError(
      "that is an invoice from a supplier, not one you issued — pay it from a draft instead",
      409,
    );
  }
  if (invoice.state === "DELETED") throw new PaymentRequestError("that invoice was deleted", 409);
  if (invoice.state === "PAID" || invoice.state === "RECONCILED") {
    throw new PaymentRequestError("that invoice is already settled", 409);
  }
  return invoice;
}

/**
 * The organisations whose account is this user's own Safe.
 *
 * Membership is not enough to tie money to an organisation's books: a viewer or
 * a payer on a business org holds their own Safe, and money reaching it is
 * theirs, not the company's. `Account.backingUserId` records whose Safe an
 * account actually is.
 */
function orgsBackedBy(userId: string): Set<string> {
  return new Set(store.accounts.filter((a) => a.backingUserId === userId).map((a) => a.orgId));
}

export async function createPaymentRequest(
  user: User,
  input: {
    amountEur?: number;
    description?: string;
    methods: ("crypto" | "bank")[];
    expiresAt: string;
    test?: boolean;
    invoiceId?: string;
    externalInvoiceNumber?: string;
  },
  source: PaymentRequestSource,
  orgId?: string,
): Promise<PaymentRequest> {
  const handle = user.paymentPage?.handle;
  if (!handle) throw new PaymentRequestError("claim a payment page before creating a payment link", 409);
  /**
   * A link for an invoice collects THAT invoice's amount.
   *
   * Derived from the document rather than retyped, and a different figure is
   * refused: a €10 link against a €1,000 invoice would mark it paid in full for
   * a hundredth of the money. An invoice written in another currency is
   * collected as the euro amount frozen on it at issue — a short payment is
   * still recorded as partial by the ordinary matching, so nothing here
   * prevents paying in instalments.
   */
  let amountEur = input.amountEur;
  if (input.invoiceId) {
    const invoice = assertInvoiceCollectable(input.invoiceId, orgId, user);
    const due = payableEur(invoice);
    if (due === undefined) {
      throw new PaymentRequestError("that invoice has no issued amount to collect", 409);
    }
    if (amountEur !== undefined && Math.round(amountEur * 100) !== Math.round(due * 100)) {
      const face = invoice.issued?.currency ?? "EUR";
      throw new PaymentRequestError(
        `that invoice is for €${due.toFixed(2)}` +
          (face === "EUR" ? "" : ` (${face} ${(invoice.issued!.grossCents / 100).toFixed(2)} at the rate frozen when it was issued)`) +
          `, not €${amountEur.toFixed(2)}`,
        409,
      );
    }
    amountEur = due;
  }
  const now = new Date().toISOString();
  let code = newRequestCode();
  while (store.findPaymentRequestByCode(code)) code = newRequestCode();
  const r = store.addPaymentRequest({
    id: randomUUID(),
    code,
    userId: user.id,
    ...(orgId ? { orgId } : {}),
    handle,
    ...(amountEur !== undefined ? { amountEur } : {}),
    currency: "EUR",
    ...(input.description ? { description: input.description } : {}),
    methods: input.methods,
    state: "OPEN",
    ...(input.test ? { test: true } : {}),
    ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
    ...(input.externalInvoiceNumber ? { externalInvoiceNumber: input.externalInvoiceNumber } : {}),
    cryptoQuotes: [],
    payments: [],
    source,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return (await ensureQuote(r, r.amountEur)).request;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof PaymentRequestError) return res.status(err.status).json({ error: err.message });
  throw err;
}

/** The personal org a request is booked under by default. */
function defaultOrgId(userId: string): string | undefined {
  const orgs = store.organisationsForUser(userId);
  return (orgs.find((o) => o.org.type === "personal") ?? orgs[0])?.org.id;
}

export function createPaymentRequestRouter(requireUserSession: SessionCheck): express.Router {
  const router = express.Router();

  router.get(
    "/users/:id/payment-requests/methods",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      res.json({ methods: availableMethods(user), handle: user.paymentPage?.handle });
    }),
  );

  router.post(
    "/users/:id/payment-requests",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      try {
        const input = validateCreate(req.body, user);
        const r = await createPaymentRequest(user, input, { kind: "app" }, defaultOrgId(user.id));
        res.status(201).json(ownerPaymentRequest(r, baseUrlFor(req)));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.get(
    "/users/:id/payment-requests",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const base = baseUrlFor(req);
      const list = store
        .paymentRequestsForUser(user.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((r) => ownerPaymentRequest(r, base));
      res.json({ requests: list, methods: availableMethods(user) });
    }),
  );

  router.get(
    "/users/:id/payment-requests/:reqId",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const r = store.findPaymentRequest(req.params.reqId);
      if (!r || r.userId !== user.id) return res.status(404).json({ error: "payment request not found" });
      res.json(ownerPaymentRequest(r, baseUrlFor(req)));
    }),
  );

  /** Cancel. A request with money against it stays as it is: the payments are
   *  facts, and cancelling would hide them from the payer's page. */
  router.post(
    "/users/:id/payment-requests/:reqId/cancel",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      const r = store.findPaymentRequest(req.params.reqId);
      if (!r || r.userId !== user.id) return res.status(404).json({ error: "payment request not found" });
      if (r.state !== "OPEN") return res.status(409).json({ error: `this request is ${effectiveState(r).toLowerCase()}` });
      if (r.payments.length) {
        return res.status(409).json({ error: "a payment has already been recorded against this request — it cannot be cancelled" });
      }
      const now = new Date().toISOString();
      res.json(ownerPaymentRequest(store.updatePaymentRequest(r.id, { state: "CANCELLED", cancelledAt: now }), baseUrlFor(req)));
    }),
  );

  // ── Payer side, no session ──────────────────────────────────────────────

  const resolvePublic = (req: express.Request, res: express.Response) => {
    const code = normaliseCode(String(req.params.code ?? ""));
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-robots-tag", "noindex, nofollow");
    if (!isRequestCode(code)) {
      res.status(404).json({ error: "no such payment request" });
      return undefined;
    }
    const r = store.findPaymentRequestByCode(code);
    const user = r ? store.findUser(r.userId) : undefined;
    // The code resolves; the handle is for the reader. A link minted under an
    // old handle keeps working, but a code under someone else's handle is a
    // 404, so a page cannot impersonate another payee.
    if (!r || !user || (user.paymentPage?.handle !== req.params.handle && r.handle !== req.params.handle)) {
      res.status(404).json({ error: "no such payment request" });
      return undefined;
    }
    return { r, user };
  };

  const publicCtx = (req: express.Request, quote?: CryptoQuote) => payerContext(req, quote);

  router.get(
    "/pay/:handle/:code",
    // /pay/:handle/qr.svg belongs to the payment-page router, mounted after
    // this one; without this it read as an unknown code and every QR 404'd.
    (req, _res, next) => (req.params.code === "qr.svg" ? next("route") : next()),
    wrap(async (req, res) => {
      const hit = resolvePublic(req, res);
      if (!hit) return;
      const { request, quote } = await ensureQuote(hit.r, hit.r.amountEur);
      res.json(publicPaymentRequest(request, hit.user, publicCtx(req, quote)));
    }),
  );

  /**
   * An open-amount request: the payer names the amount, and the page needs a
   * USDC figure for it. The quote is recorded on the request so the deposit
   * can be attributed by amount like any other.
   */
  router.post(
    "/pay/:handle/:code/quote",
    wrap(async (req, res) => {
      const hit = resolvePublic(req, res);
      if (!hit) return;
      if (effectiveState(hit.r) !== "OPEN") return res.status(409).json({ error: `this request is ${effectiveState(hit.r).toLowerCase()}` });
      if (!hit.r.methods.includes("crypto")) return res.status(409).json({ error: "this request does not take crypto" });
      const n = Number(req.body?.amountEur);
      if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) {
        return res.status(400).json({ error: "amountEur must be a positive amount with at most two decimals" });
      }
      if (hit.r.amountEur !== undefined && n !== hit.r.amountEur) {
        return res.status(409).json({ error: `this request is for €${hit.r.amountEur.toFixed(2)}` });
      }
      if (hit.r.amountEur === undefined && hit.r.cryptoQuotes.filter((q) => Date.parse(q.validUntil) > Date.now()).length >= PAYMENT_REQUESTS.maxQuotes) {
        return res.status(429).json({ error: "too many amounts quoted on this link — try again in a few minutes" });
      }
      try {
        const { request, quote } = await ensureQuote(hit.r, n);
        if (!quote) return res.status(503).json({ error: "no live EUR/USD rate right now — try bank transfer, or try again shortly" });
        res.json(publicPaymentRequest(request, hit.user, publicCtx(req, quote)));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  return router;
}

// ── Attribution hooks ─────────────────────────────────────────────────────────

type PaidHook = (request: PaymentRequest) => Promise<void> | void;
const paidHooks: PaidHook[] = [];

/** Called with a request the moment it becomes PAID. Merchant integrations
 *  register here; errors are theirs to record and the sweep retries. */
export function onPaymentRequestPaid(hook: PaidHook) {
  paidHooks.push(hook);
}

function record(r: PaymentRequest, payment: Parameters<typeof applyPayment>[1]): PaymentRequest {
  // `r` is usually the live store row, which updatePaymentRequest mutates in
  // place — so remember whether it was already PAID before writing.
  const wasPaid = r.state === "PAID";
  const { request, added } = applyPayment(r, payment);
  if (!added) {
    // applyPayment may have enriched an existing row in place.
    return store.updatePaymentRequest(r.id, { payments: r.payments });
  }
  const saved = store.updatePaymentRequest(r.id, {
    payments: request.payments,
    ...(request.state !== r.state ? { state: request.state, paidAt: request.paidAt } : {}),
  });
  console.log(
    `pay-request: ${displayCode(saved.code)} received €${payment.amountEur} by ${payment.method} (${payment.kind})` +
      (saved.state === "PAID" ? " — PAID" : ""),
  );
  if (saved.state === "PAID" && !wasPaid) {
    for (const hook of paidHooks) {
      Promise.resolve()
        .then(() => hook(saved))
        .catch((e) => console.error(`pay-request: paid hook failed for ${displayCode(saved.code)}: ${e?.message ?? e}`));
    }
  }
  return saved;
}

/**
 * A USDC deposit landed at a page address: does it pay one of that payee's
 * open requests? Called by the crypto poller for every fresh deposit. Writes
 * `paymentRequestId` on the deposit so the two records point at each other.
 */
export function attributeDepositToRequest(deposit: CryptoDeposit): PaymentRequest | undefined {
  if (deposit.paymentRequestId) return store.findPaymentRequest(deposit.paymentRequestId);
  const user = store.findUser(deposit.userId);
  const page = user?.paymentPage;
  if (!user || !page?.depositAddress) return undefined;
  if ((deposit.paymentAddress ?? "").toLowerCase() !== page.depositAddress.toLowerCase()) return undefined;
  const match = matchDepositToRequests(deposit, store.paymentRequestsForUser(user.id));
  if (!match) return undefined;
  const settled = deposit.state === "CONVERTED";
  const saved = record(match.request, {
    method: "crypto",
    ref: `deposit:${deposit.id}`,
    depositId: deposit.id,
    amountEur: match.kind === "partial" && deposit.amountUsdc
      ? Math.round((match.quote.amountEur * deposit.amountUsdc / match.quote.amountUsdc) * 100) / 100
      : match.quote.amountEur,
    amountUsdc: deposit.amountUsdc,
    txHash: deposit.txHash,
    kind: match.kind,
    ...(settled && deposit.creditedEur !== undefined ? { settledEur: deposit.creditedEur, settledAsset: "EURE" } : {}),
    ...(settled && deposit.settlementAsset === "USDC" ? { settledEur: deposit.receipt?.amountEur, settledAsset: "USDC" } : {}),
    at: deposit.receipt?.blockTimestamp ?? deposit.detectedAt,
  });
  /**
   * Carry the invoice onto the deposit, so the settlement record is written by
   * the conversion itself rather than waiting for someone to link it by hand.
   * Never overwrite one the deposit already carries: a manual link is a
   * deliberate act and this attribution is a guess by amount.
   */
  store.updateCryptoDeposit(deposit.id, {
    paymentRequestId: saved.id,
    ...(saved.invoiceId && !deposit.invoiceId ? { invoiceId: saved.invoiceId } : {}),
  });
  return saved;
}

/** A matched deposit was converted (or settled as USDC): write what the payee
 *  actually holds onto the payment row. */
export function noteDepositSettled(deposit: CryptoDeposit): void {
  if (!deposit.paymentRequestId || deposit.state !== "CONVERTED") return;
  const r = store.findPaymentRequest(deposit.paymentRequestId);
  if (!r) return;
  const payments = r.payments.map((p) =>
    p.depositId === deposit.id
      ? {
          ...p,
          ...(deposit.settlementAsset === "USDC"
            ? { settledEur: deposit.receipt?.amountEur, settledAsset: "USDC" as const }
            : { settledEur: deposit.creditedEur, settledAsset: "EURE" as const }),
        }
      : p,
  );
  store.updatePaymentRequest(r.id, { payments });
}

/** A processed Monerium issue order was seen for an account: does its memo
 *  name one of that account's open requests? Called by the Monerium poller. */
/**
 * Put a SEPA credit onto an invoice.
 *
 * Idempotent on the order id, so re-seeing an order in a later poll records
 * nothing twice — the poller walks the same list repeatedly by design.
 */
function recordBankSettlement(
  invoiceId: string,
  order: MoneriumOrderLike,
  matchedOn: "payment-link" | "invoice-number",
): void {
  const invoice = store.invoices.find((i) => i.id === invoiceId);
  if (!invoice) return;
  store.updateInvoice(invoice.id, {
    settlements: withSettlement(invoice.settlements, buildBankSettlement(order, matchedOn)),
  });
}

/**
 * A SEPA credit whose reference names one of this account's own invoices.
 *
 * The everyday way an invoice gets paid: the bank details are printed on the
 * sheet and the payer writes the invoice number. Nothing else ties that money
 * to the document, so without this a direct transfer leaves the invoice looking
 * unpaid while the euro sits in the account.
 *
 * Only OUTGOING invoices of an org whose account is the credited Safe, only
 * ones not already settled, and only when exactly one invoice is named. See `orderNamesInvoice` for why a short number is
 * deliberately not matched at all.
 */
export function attributeMoneriumOrderToInvoice(order: MoneriumOrderLike): void {
  if ((order.kind ?? "issue") !== "issue") return;
  if ((order.meta?.state ?? order.state) !== "processed") return;
  const address = String(order.address ?? "").toLowerCase();
  if (!address) return;
  const user = store.users.find((u) => (u.address ?? "").toLowerCase() === address);
  if (!user) return;
  // Only organisations whose account IS the credited Safe. A member's personal
  // Safe receiving a payment that quotes the company's invoice number is the
  // member's money, and must not close the company's invoice.
  const orgIds = orgsBackedBy(user.id);
  const named = store.invoices.filter(
    (invoice) =>
      invoice.direction === "outgoing" &&
      orgIds.has(invoice.orgId) &&
      invoice.state !== "DELETED" &&
      invoice.state !== "PAID" &&
      invoice.state !== "RECONCILED" &&
      orderNamesInvoice(order, invoice),
  );
  if (named.length === 1) {
    recordBankSettlement(named[0].id, order, "invoice-number");
  } else if (named.length > 1) {
    // One credit quoting several numbers cannot be split by guessing; leave it
    // for a person rather than book all of it against whichever came first.
    console.warn(
      `invoice attribution: Monerium order ${order.id} names ${named.length} invoices — left unattributed`,
    );
  }
}

export function attributeMoneriumOrder(order: any): PaymentRequest | undefined {
  if (order?.kind !== "issue") return undefined;
  const user = store.findUserByAddress(String(order.address ?? ""));
  if (!user) return undefined;
  for (const r of store.paymentRequestsForUser(user.id)) {
    if (r.state !== "OPEN" && r.state !== "PAID") continue;
    const payment = matchMoneriumOrder(order, r, user.address);
    if (payment) {
      const saved = record(r, payment);
      // A link raised for an invoice puts its bank credit on the invoice too,
      // the same way an attributed crypto deposit does.
      if (saved.invoiceId) recordBankSettlement(saved.invoiceId, order, "payment-link");
      return saved;
    }
  }
  return undefined;
}

/**
 * Housekeeping: expire what is past its date, book our own PAID SEPA
 * transfers that reference a code, and retry merchant notifications.
 */
export async function sweepPaymentRequests(now = new Date()): Promise<{ expired: number; matched: number }> {
  let expired = 0;
  let matched = 0;
  const open = store.paymentRequests.filter((r) => r.state === "OPEN");
  for (const r of open) {
    if (Date.parse(r.expiresAt) <= now.getTime()) {
      store.updatePaymentRequest(r.id, { state: "EXPIRED" });
      expired++;
      continue;
    }
    if (!r.methods.includes("bank")) continue;
    const payee = store.findUser(r.userId);
    if (!payee?.iban) continue;
    for (const t of store.transfers) {
      if (!t.reference || t.state !== "PAID") continue;
      const payment = matchTransfer(t, r, payee.iban);
      if (payment && !r.payments.some((p) => p.ref === payment.ref)) {
        record(store.findPaymentRequest(r.id)!, payment);
        matched++;
      }
    }
  }
  for (const r of store.paymentRequests) {
    if (r.state === "PAID" && r.source.kind !== "app" && r.source.kind !== "api" && !r.source.resolvedAt) {
      for (const hook of paidHooks) {
        try {
          await hook(r);
        } catch (e: any) {
          console.error(`pay-request: paid hook retry failed for ${displayCode(r.code)}: ${e?.message ?? e}`);
        }
      }
    }
  }
  return { expired, matched };
}
