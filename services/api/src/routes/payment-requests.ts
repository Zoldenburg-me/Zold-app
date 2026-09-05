/**
 * /api/users/:id/payment-requests (owner) and /api/pay/:handle/:code (payer).
 *
 * A router factory taking the session check, like the org routers, so
 * server.ts stays the single owner of authentication. The attribution hooks at
 * the bottom are what the crypto poller and the Monerium order poller call
 * when money shows up; they hold no network of their own.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { CHAIN_ID, PAYMENT_REQUESTS, PUBLIC_URL } from "../config.js";
import { store, type CryptoDeposit, type User } from "../store.js";
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

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    fn(req, res).catch(next);

export function baseUrlFor(req: express.Request): string {
  return PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

function payToken() {
  return { symbol: "USDC", address: addrs().usdc, decimals: 6 };
}

/** LHV's BIC, only beside an Estonian IBAN it applies to (documents.ts holds
 *  the same rule; duplicated here to keep this module free of that import). */
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
async function ensureQuote(r: PaymentRequest, amountEur: number | undefined): Promise<{ request: PaymentRequest; quote?: CryptoQuote }> {
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
export async function createPaymentRequest(
  user: User,
  input: { amountEur?: number; description?: string; methods: ("crypto" | "bank")[]; expiresAt: string; test?: boolean },
  source: PaymentRequestSource,
  orgId?: string,
): Promise<PaymentRequest> {
  const handle = user.paymentPage?.handle;
  if (!handle) throw new PaymentRequestError("claim a payment page before creating a payment link", 409);
  const now = new Date().toISOString();
  let code = newRequestCode();
  while (store.findPaymentRequestByCode(code)) code = newRequestCode();
  const r = store.addPaymentRequest({
    id: randomUUID(),
    code,
    userId: user.id,
    ...(orgId ? { orgId } : {}),
    handle,
    ...(input.amountEur !== undefined ? { amountEur: input.amountEur } : {}),
    currency: "EUR",
    ...(input.description ? { description: input.description } : {}),
    methods: input.methods,
    state: "OPEN",
    ...(input.test ? { test: true } : {}),
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
    // The handle in the URL is for the reader; the code is what resolves. A
    // link minted under an old handle keeps working, but a code pasted under
    // SOMEONE ELSE's handle does not — that would let a page impersonate a
    // payee it does not belong to.
    if (!r || !user || (user.paymentPage?.handle !== req.params.handle && r.handle !== req.params.handle)) {
      res.status(404).json({ error: "no such payment request" });
      return undefined;
    }
    return { r, user };
  };

  const publicCtx = (req: express.Request, quote?: CryptoQuote) => ({
    chainId: CHAIN_ID,
    token: payToken(),
    bicFor,
    baseUrl: baseUrlFor(req),
    quote,
  });

  router.get(
    "/pay/:handle/:code",
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
  store.updateCryptoDeposit(deposit.id, { paymentRequestId: saved.id });
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
export function attributeMoneriumOrder(order: any): PaymentRequest | undefined {
  if (order?.kind !== "issue") return undefined;
  const user = store.findUserByAddress(String(order.address ?? ""));
  if (!user) return undefined;
  for (const r of store.paymentRequestsForUser(user.id)) {
    if (r.state !== "OPEN" && r.state !== "PAID") continue;
    const payment = matchMoneriumOrder(order, r, user.address);
    if (payment) return record(r, payment);
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
