/**
 * Payment requests — "pay me €40 for the invoice" as a link.
 *
 * A payment PAGE (pay.ts) is a standing address: a handle, a QR code, no
 * amount. A payment REQUEST is one specific ask against that page — an
 * amount, a description, a code the payer carries — and a record of what
 * arrived against it. The link is `/pay/<handle>/<code>`; the code is the
 * credential (75 bits, Crockford alphabet, look-alikes folded) and the handle
 * is there so the payer can read who is asking.
 *
 * THREE WAYS TO PAY, and how each is attributed back to the request:
 *
 *   crypto  USDC on the app chain to the payee's page address. The page has ONE
 *           address for every request, so attribution is BY AMOUNT: each open
 *           request quotes a USDC amount that is unique among the payee's open
 *           quotes (nudged by a micro-unit when two would collide), and an
 *           inbound deposit is matched to the closest quoted amount. What that
 *           buys, and what it does not, is in `matchDepositToRequests`.
 *   bank    a SEPA transfer to the payee's IBAN carrying the code as the
 *           remittance reference. Attributed from Monerium's issue order, whose
 *           memo is the reference the payer wrote.
 *   zold    another Zold account paying from its balance. Today that is a SEPA
 *           payout into the payee's IBAN with the code as reference — the same
 *           rail as `bank`, started from the app with everything prefilled.
 *           There is no on-chain Zold-to-Zold rail yet (see CLAUDE.md, Pay
 *           hub), so this does not pretend to be one.
 *
 * WHAT IS NOT HERE. No money moves in this file. Matching records that a
 * payment arrived; conversion of a USDC deposit to EURe is the user-signed
 * path in adapters/crypto-deposits.ts, and a request settles in EUR only once
 * that has happened (`settledEur`). Until then the request is PAID in the
 * sense a merchant needs — the funds are at the payee's own address — and the
 * record says which asset is actually held.
 */
import { randomBytes } from "node:crypto";
import { PAYMENT_REQUESTS } from "./config.js";
import type { CryptoDeposit, Transfer, User } from "./store.js";

export type PaymentMethod = "crypto" | "bank";
export type PaymentRequestState = "OPEN" | "PAID" | "EXPIRED" | "CANCELLED";

export class PaymentRequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** One quoted USDC amount. Every quote ever issued for a request remains a
 *  valid match: a payer who opened the page ten minutes ago pays what they saw. */
export interface CryptoQuote {
  amountEur: number;
  /** Exactly what the payer is asked to send, 6dp. */
  amountUsdc: number;
  /** USD per 1 EUR — the live mid the amount was derived from. */
  rate: number;
  rateProvider: string;
  rateAsOf: string;
  allowanceBps: number;
  quotedAt: string;
  validUntil: string;
}

export interface RequestPayment {
  id: string;
  method: PaymentMethod;
  /** Idempotency key: the deposit id, Monerium order id or transfer id. */
  ref: string;
  /** Euro value attributed. For crypto this is the quoted euro amount the
   *  deposit matched; `settledEur` is what the conversion later delivered. */
  amountEur: number;
  amountUsdc?: number;
  txHash?: string;
  depositId?: string;
  orderId?: string;
  transferId?: string;
  /** Who paid, when the rail tells us (a bank transfer's counterparty). */
  payerName?: string;
  /** full: covers a quote within tolerance. partial: a real but short payment.
   *  over: more than asked. */
  kind: "full" | "partial" | "over";
  /** What the payee actually holds after settlement, in EUR. Absent while a
   *  crypto deposit is still USDC or its conversion has not happened. */
  settledEur?: number;
  settledAsset?: "EURE" | "USDC";
  at: string;
}

export interface PaymentRequestSource {
  kind: "app" | "api" | "shopify";
  /** Merchant-side id (Shopify payment session id). Unique per kind. */
  externalId?: string;
  shop?: string;
  sessionGid?: string;
  sessionKind?: string;
  cancelUrl?: string;
  /** Where the payer goes once the merchant has been told. Set when the
   *  merchant's system answers the settlement call. */
  returnUrl?: string;
  resolvedAt?: string;
  resolveError?: string;
  resolveAttempts?: number;
}

export interface PaymentRequest {
  id: string;
  /** Normalised: 15 Crockford characters, upper-case, no separators. */
  code: string;
  userId: string;
  orgId?: string;
  /** The payee's handle when the link was minted. The link keeps working by
   *  code if the handle later changes. */
  handle: string;
  /** Fixed amount. Absent means the payer chooses. */
  amountEur?: number;
  currency: "EUR";
  description?: string;
  methods: PaymentMethod[];
  state: PaymentRequestState;
  /** A merchant test-mode session. Carried and shown; never settled by fiat. */
  test?: boolean;
  cryptoQuotes: CryptoQuote[];
  payments: RequestPayment[];
  source: PaymentRequestSource;
  expiresAt: string;
  paidAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Codes ────────────────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O or U, so a code read aloud or typed has one
 *  spelling. 32 divides 256, so indexing a random byte is unbiased. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 15;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function newRequestCode(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  return Array.from(random(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Upper-case, separators dropped, look-alikes folded onto the character they
 *  are mistaken for. Anything else is left in place and fails `isRequestCode`. */
export function normaliseCode(raw: string): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function isRequestCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** The shape a human copies: XXXXX-XXXXX-XXXXX. */
export function displayCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}`;
}

/** Does this free text (a bank memo, a transfer reference) carry the code? */
export function textCarriesCode(text: string | undefined, code: string): boolean {
  if (!text) return false;
  return normaliseCode(text).includes(code);
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface CreateInput {
  amountEur?: number;
  description?: string;
  methods: PaymentMethod[];
  expiresAt: string;
  test?: boolean;
}

/** Which methods this payee can actually offer, with the reason for each gap.
 *  Rendered to the owner so a missing option says what would add it. */
export function availableMethods(user: User): { method: PaymentMethod; available: boolean; needs?: string }[] {
  return [
    {
      method: "crypto",
      available: Boolean(user.paymentPage?.handle && user.paymentPage.depositAddress),
      ...(user.paymentPage?.handle ? {} : { needs: "claim a payment page (Profile → Payment page)" }),
    },
    {
      method: "bank",
      available: Boolean(user.iban),
      ...(user.iban ? {} : { needs: "activate your IBAN with Monerium" }),
    },
  ];
}

export function validateCreate(body: any, user: User, now = new Date()): CreateInput {
  const b = body ?? {};
  let amountEur: number | undefined;
  if (b.amountEur !== undefined && b.amountEur !== null && b.amountEur !== "") {
    const n = Number(b.amountEur);
    if (!Number.isFinite(n) || n <= 0) throw new PaymentRequestError("amountEur must be a positive number");
    if (Math.round(n * 100) !== n * 100) throw new PaymentRequestError("amountEur has at most two decimals");
    if (n > 1_000_000) throw new PaymentRequestError("amountEur is above the €1,000,000 ceiling");
    amountEur = n;
  }
  let description: string | undefined;
  if (b.description !== undefined && b.description !== null && b.description !== "") {
    if (typeof b.description !== "string") throw new PaymentRequestError("description must be a string");
    description = b.description.trim().replace(/\s+/g, " ").slice(0, 140) || undefined;
  }
  const requested: unknown[] = Array.isArray(b.methods) ? b.methods : ["crypto", "bank"];
  const methods: PaymentMethod[] = [];
  for (const m of requested) {
    if (m !== "crypto" && m !== "bank") throw new PaymentRequestError(`unknown payment method ${String(m)}`);
    if (!methods.includes(m)) methods.push(m);
  }
  if (!methods.length) throw new PaymentRequestError("at least one payment method is required");
  const avail = availableMethods(user);
  for (const m of methods) {
    const a = avail.find((x) => x.method === m)!;
    if (!a.available) {
      throw new PaymentRequestError(`${m} payments are not available on this account yet — ${a.needs}`, 409);
    }
  }
  let expiresAt: string;
  if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt !== "") {
    const t = Date.parse(String(b.expiresAt));
    if (!Number.isFinite(t)) throw new PaymentRequestError("expiresAt must be an ISO date");
    if (t <= now.getTime() + 60_000) throw new PaymentRequestError("expiresAt must be at least a minute away");
    if (t > now.getTime() + 365 * 24 * 60 * 60_000) throw new PaymentRequestError("expiresAt is more than a year away");
    expiresAt = new Date(t).toISOString();
  } else {
    expiresAt = new Date(now.getTime() + PAYMENT_REQUESTS.defaultTtlMs).toISOString();
  }
  return { amountEur, description, methods, expiresAt, ...(b.test === true ? { test: true } : {}) };
}

// ── Crypto quotes ────────────────────────────────────────────────────────────

const USDC_UNITS = 1_000_000;

export function usdcToUnits(amount: number): bigint {
  return BigInt(Math.round(amount * USDC_UNITS));
}

/**
 * Quote the USDC amount for a euro amount.
 *
 * Rounded UP to the micro-unit, then nudged up by one micro-unit per collision
 * with another amount the same payee has open, so the amounts on that payee's
 * page are distinct and a deposit can be attributed by amount alone. The
 * allowance covers venue spread on the later swap; it is recorded on the quote
 * and printed on the page rather than hidden in the number.
 */
export function quoteCrypto(
  amountEur: number,
  mid: { usdPerEur: number; provider: string; asOf: string },
  takenUsdcAmounts: Iterable<number>,
  now = new Date(),
  allowanceBps = PAYMENT_REQUESTS.cryptoAllowanceBps,
): CryptoQuote {
  if (!(mid.usdPerEur > 0)) throw new PaymentRequestError("no live EUR/USD rate to quote from", 503);
  const cents = Math.round(amountEur * 100);
  let units = BigInt(Math.ceil(cents * mid.usdPerEur * (1 + allowanceBps / 10_000) * 10_000));
  const taken = new Set(Array.from(takenUsdcAmounts, (a) => usdcToUnits(a).toString()));
  while (taken.has(units.toString())) units += 1n;
  return {
    amountEur,
    amountUsdc: Number(units) / USDC_UNITS,
    rate: mid.usdPerEur,
    rateProvider: mid.provider,
    rateAsOf: mid.asOf,
    allowanceBps,
    quotedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + PAYMENT_REQUESTS.quoteTtlMs).toISOString(),
  };
}

/** The quote the page should show now: the newest still-valid one for this
 *  euro amount, or nothing (then the caller re-quotes). */
export function currentQuote(r: PaymentRequest, amountEur: number | undefined, now = new Date()): CryptoQuote | undefined {
  const target = amountEur ?? r.amountEur;
  if (target === undefined) return undefined;
  return [...r.cryptoQuotes]
    .reverse()
    .find((q) => q.amountEur === target && Date.parse(q.validUntil) > now.getTime());
}

/** Append a quote, keeping the list bounded. Dropping the OLDEST quote means a
 *  payer who kept a page open for hours may pay an amount we no longer hold;
 *  the deposit still lands and is recorded as an ordinary deposit, so nothing
 *  is lost — it just has to be matched by hand. */
export function withQuote(r: PaymentRequest, q: CryptoQuote): CryptoQuote[] {
  const list = [...r.cryptoQuotes, q];
  return list.length > PAYMENT_REQUESTS.maxQuotes ? list.slice(list.length - PAYMENT_REQUESTS.maxQuotes) : list;
}

/** EIP-681 with the amount in base units. Kept out of the QR (see pay.ts). */
export function requestPaymentUri(
  token: { address: `0x${string}`; decimals: number },
  chainId: number,
  to: `0x${string}`,
  amountUsdc?: number,
): string {
  const base = `ethereum:${token.address}@${chainId}/transfer?address=${to}`;
  if (amountUsdc === undefined || !(amountUsdc > 0)) return base;
  return `${base}&uint256=${BigInt(Math.round(amountUsdc * 10 ** token.decimals))}`;
}

// ── Attribution ──────────────────────────────────────────────────────────────

export interface DepositMatch {
  request: PaymentRequest;
  quote: CryptoQuote;
  kind: RequestPayment["kind"];
}

/**
 * Which open request, if any, a USDC deposit at the payee's page address pays.
 *
 * Only quotes issued BEFORE the money arrived are candidates: a quote issued
 * after the deposit cannot be what the payer saw. Exact unit match wins; then
 * the closest quoted amount, provided the deposit is at least the partial
 * floor. Above tolerance-under it is a full payment; above the quote it is an
 * over-payment (still the payer's intent, recorded as such); below tolerance
 * but above the floor it is partial and the request stays open for the rest.
 *
 * WHAT THIS CANNOT DO: tell two requests apart when a payer types a rounded
 * amount that sits between their nudged quotes. Closest wins and ties go to
 * the older request. The owner sees which request a deposit was booked to and
 * can move it; a wrong guess is visible, not silent.
 */
export function matchDepositToRequests(
  deposit: Pick<CryptoDeposit, "amountUsdc" | "detectedAt" | "receipt" | "token">,
  requests: PaymentRequest[],
): DepositMatch | undefined {
  if (deposit.token !== "USDC" || !(deposit.amountUsdc && deposit.amountUsdc > 0)) return undefined;
  const arrivedAt = Date.parse(deposit.receipt?.blockTimestamp ?? deposit.detectedAt);
  const units = usdcToUnits(deposit.amountUsdc);
  const tol = BigInt(PAYMENT_REQUESTS.underpayToleranceBps);
  const floor = BigInt(PAYMENT_REQUESTS.partialFloorBps);
  const overCap = BigInt(PAYMENT_REQUESTS.overpayCapBps);
  // Full payments beat partial ones beat over-payments: a deposit that sits
  // between two quotes is far more likely the short payment of a larger
  // request than a generous over-payment of a smaller one. Within a tier the
  // closest quote wins; ties go to the older request.
  const TIER: Record<RequestPayment["kind"], number> = { full: 0, partial: 1, over: 2 };
  let best: (DepositMatch & { distance: bigint; createdAt: number }) | undefined;
  for (const r of [...requests].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (r.state !== "OPEN" || !r.methods.includes("crypto")) continue;
    for (const q of r.cryptoQuotes) {
      if (Date.parse(q.quotedAt) > arrivedAt + 5 * 60_000) continue; // quoted after the money arrived
      const quoted = usdcToUnits(q.amountUsdc);
      if (units * 10_000n < quoted * floor) continue; // too small to be this payment
      if (units > quoted && (units - quoted) * 10_000n > quoted * overCap) continue; // too large to be this payment
      const distance = units > quoted ? units - quoted : quoted - units;
      const kind: RequestPayment["kind"] =
        units >= quoted ? (units === quoted ? "full" : "over")
          : (quoted - units) * 10_000n <= quoted * tol ? "full"
            : "partial";
      const candidate = { request: r, quote: q, kind, distance, createdAt: Date.parse(r.createdAt) };
      const better =
        !best ||
        TIER[kind] < TIER[best.kind] ||
        (TIER[kind] === TIER[best.kind] && (distance < best.distance || (distance === best.distance && candidate.createdAt < best.createdAt)));
      if (better) best = candidate;
    }
  }
  return best ? { request: best.request, quote: best.quote, kind: best.kind } : undefined;
}

/** A Monerium issue order settles a request when it is processed, landed on
 *  the payee's account and its memo carries the code. Amount comes from the
 *  order, never from the request: the payer may have sent a different sum. */
export function matchMoneriumOrder(
  order: { id: string; kind: string; amount: string; address: string; memo?: string; meta?: { state?: string; processedAt?: string }; counterpart?: any; state?: string },
  request: PaymentRequest,
  payeeAddress: string,
): Omit<RequestPayment, "id"> | undefined {
  if (order.kind !== "issue") return undefined;
  const state = order.meta?.state ?? order.state;
  if (state !== "processed") return undefined;
  if (String(order.address).toLowerCase() !== payeeAddress.toLowerCase()) return undefined;
  if (!request.methods.includes("bank")) return undefined;
  if (!textCarriesCode(order.memo, request.code)) return undefined;
  const amountEur = Number(order.amount);
  if (!(amountEur > 0)) return undefined;
  const details = order.counterpart?.details ?? {};
  const payerName: string | undefined =
    details.name ?? ([details.firstName, details.lastName].filter(Boolean).join(" ") || undefined);
  return {
    method: "bank",
    ref: `monerium:${order.id}`,
    orderId: order.id,
    amountEur,
    settledEur: amountEur,
    settledAsset: "EURE",
    payerName,
    kind: paymentKind(request, amountEur),
    at: order.meta?.processedAt ?? new Date().toISOString(),
  };
}

/** One of OUR transfers paying this request: a PAID SEPA payout into the
 *  payee's IBAN whose reference carries the code. */
export function matchTransfer(
  transfer: Transfer,
  request: PaymentRequest,
  payeeIban: string,
): Omit<RequestPayment, "id"> | undefined {
  if (transfer.rail !== "sepa" || transfer.state !== "PAID") return undefined;
  if (!request.methods.includes("bank")) return undefined;
  const norm = (s?: string) => (s ?? "").replace(/\s/g, "").toUpperCase();
  if (!payeeIban || norm(transfer.recipientIban) !== norm(payeeIban)) return undefined;
  if (!textCarriesCode(transfer.reference, request.code)) return undefined;
  const amountEur = transfer.receiveEur ?? transfer.sendEur;
  if (!(amountEur > 0)) return undefined;
  return {
    method: "bank",
    ref: `transfer:${transfer.id}`,
    transferId: transfer.id,
    amountEur,
    settledEur: amountEur,
    settledAsset: "EURE",
    kind: paymentKind(request, amountEur),
    at: transfer.updatedAt,
  };
}

function paymentKind(r: PaymentRequest, amountEur: number): RequestPayment["kind"] {
  if (r.amountEur === undefined) return "full";
  const outstanding = Math.max(0, r.amountEur - paidEur(r));
  if (amountEur > outstanding + 0.005) return "over";
  if (amountEur + outstanding * (PAYMENT_REQUESTS.underpayToleranceBps / 10_000) >= outstanding) return "full";
  return "partial";
}

export function paidEur(r: PaymentRequest): number {
  return Math.round(r.payments.reduce((s, p) => s + p.amountEur, 0) * 100) / 100;
}

/**
 * Record a payment. Idempotent on `ref`. The same money seen through two
 * lenses — our own PAID transfer and the Monerium issue order it produced at
 * the payee — is merged when the amounts agree within a cent inside a day,
 * as documents.ts does for statements.
 */
export function applyPayment(
  r: PaymentRequest,
  payment: Omit<RequestPayment, "id">,
  now = new Date(),
): { request: PaymentRequest; added: boolean } {
  if (r.payments.some((p) => p.ref === payment.ref)) return { request: r, added: false };
  const twin = r.payments.find(
    (p) =>
      p.method === "bank" && payment.method === "bank" &&
      Math.abs(p.amountEur - payment.amountEur) < 0.011 &&
      Math.abs(Date.parse(p.at) - Date.parse(payment.at)) < 24 * 60 * 60_000,
  );
  if (twin) {
    // Enrich rather than duplicate: the order carries the payer's name; our
    // transfer carries the id. Keep both on one row.
    Object.assign(twin, {
      ...(payment.orderId && !twin.orderId ? { orderId: payment.orderId } : {}),
      ...(payment.transferId && !twin.transferId ? { transferId: payment.transferId } : {}),
      ...(payment.payerName && !twin.payerName ? { payerName: payment.payerName } : {}),
    });
    return { request: r, added: false };
  }
  const payments = [...r.payments, { id: randomBytes(8).toString("hex"), ...payment }];
  const next: PaymentRequest = { ...r, payments };
  const total = paidEur(next);
  const covered =
    r.amountEur !== undefined &&
    total + r.amountEur * (PAYMENT_REQUESTS.underpayToleranceBps / 10_000) >= r.amountEur;
  if (covered && r.state === "OPEN") {
    next.state = "PAID";
    next.paidAt = now.toISOString();
  }
  return { request: next, added: true };
}

/** Derived lifecycle: an OPEN request past its expiry is EXPIRED. Stored
 *  states never go backwards. */
export function effectiveState(r: PaymentRequest, now = new Date()): PaymentRequestState {
  if (r.state === "OPEN" && Date.parse(r.expiresAt) <= now.getTime()) return "EXPIRED";
  return r.state;
}

// ── Projections ──────────────────────────────────────────────────────────────

export interface PublicPaymentRequest {
  code: string;
  handle: string;
  displayName?: string;
  state: PaymentRequestState;
  amountEur?: number;
  paidEur: number;
  outstandingEur?: number;
  currency: "EUR";
  description?: string;
  test?: boolean;
  methods: {
    crypto?: {
      chainId: number;
      token: { symbol: string; address: `0x${string}`; decimals: number };
      address: `0x${string}`;
      /** Absent on an open-amount request until the payer names an amount. */
      amountUsdc?: number;
      rate?: number;
      allowanceBps?: number;
      validUntil?: string;
      uri: string;
      qrUrl: string;
    };
    bank?: {
      iban: string;
      bic?: string;
      /** The account holder, because a SEPA transfer needs a beneficiary name
       *  and Verification of Payee compares it. Present only when the payee
       *  offers bank payment on this request. */
      holder: string;
      reference: string;
      appUrl: string;
    };
  };
  payments: { method: PaymentMethod; amountEur: number; amountUsdc?: number; kind: RequestPayment["kind"]; at: string; txHash?: string }[];
  expiresAt: string;
  paidAt?: string;
  /** Set for a merchant checkout: where the payer goes when done. */
  returnUrl?: string;
  cancelUrl?: string;
  merchantNote?: string;
}

/**
 * What an unauthenticated visitor may see. An ALLOWLIST: every field here is
 * named on purpose, the same discipline as pay.ts. The payee's IBAN and legal
 * name go out only on a request that offers bank payment — a SEPA transfer
 * cannot be made without them — and never on a crypto-only link.
 */
export function publicPaymentRequest(
  r: PaymentRequest,
  user: User,
  ctx: {
    chainId: number;
    token: { symbol: string; address: `0x${string}`; decimals: number };
    bicFor: (iban?: string) => string | undefined;
    baseUrl: string;
    now?: Date;
    quote?: CryptoQuote;
  },
): PublicPaymentRequest {
  const now = ctx.now ?? new Date();
  const state = effectiveState(r, now);
  const paid = paidEur(r);
  const page = user.paymentPage;
  const methods: PublicPaymentRequest["methods"] = {};
  if (r.methods.includes("crypto") && page?.depositAddress) {
    const q = ctx.quote;
    methods.crypto = {
      chainId: ctx.chainId,
      token: ctx.token,
      address: page.depositAddress,
      ...(q ? { amountUsdc: q.amountUsdc, rate: q.rate, allowanceBps: q.allowanceBps, validUntil: q.validUntil } : {}),
      uri: requestPaymentUri(ctx.token, ctx.chainId, page.depositAddress, q?.amountUsdc),
      qrUrl: `${ctx.baseUrl}/api/pay/${encodeURIComponent(page.handle)}/qr.svg`,
    };
  }
  if (r.methods.includes("bank") && user.iban) {
    methods.bank = {
      iban: user.iban,
      bic: ctx.bicFor(user.iban),
      holder: user.name,
      reference: displayCode(r.code),
      appUrl: `${ctx.baseUrl}/app?pay=${encodeURIComponent(r.handle)}/${displayCode(r.code)}`,
    };
  }
  return {
    code: displayCode(r.code),
    handle: r.handle,
    ...(page?.displayName ? { displayName: page.displayName } : {}),
    state,
    ...(r.amountEur !== undefined ? { amountEur: r.amountEur, outstandingEur: Math.max(0, Math.round((r.amountEur - paid) * 100) / 100) } : {}),
    paidEur: paid,
    currency: "EUR",
    ...(r.description ? { description: r.description } : {}),
    ...(r.test ? { test: true } : {}),
    methods,
    payments: r.payments.map((p) => ({
      method: p.method, amountEur: p.amountEur, kind: p.kind, at: p.at,
      ...(p.amountUsdc !== undefined ? { amountUsdc: p.amountUsdc } : {}),
      ...(p.txHash ? { txHash: p.txHash } : {}),
    })),
    expiresAt: r.expiresAt,
    ...(r.paidAt ? { paidAt: r.paidAt } : {}),
    ...(r.source.kind === "shopify"
      ? {
          returnUrl: `${ctx.baseUrl}/api/shopify/return/${displayCode(r.code)}`,
          ...(r.source.cancelUrl ? { cancelUrl: `${ctx.baseUrl}/api/shopify/cancel/${displayCode(r.code)}` } : {}),
          merchantNote: `Checkout at ${r.source.shop ?? "a Shopify store"}. The store is told the moment your payment is seen.`,
        }
      : {}),
  };
}

/** The owner's view: everything public plus the record. */
export function ownerPaymentRequest(r: PaymentRequest, baseUrl: string) {
  return {
    id: r.id,
    code: displayCode(r.code),
    url: `${baseUrl}/pay/${encodeURIComponent(r.handle)}/${displayCode(r.code)}`,
    handle: r.handle,
    orgId: r.orgId,
    amountEur: r.amountEur,
    paidEur: paidEur(r),
    settledEur: Math.round(r.payments.reduce((s, p) => s + (p.settledEur ?? 0), 0) * 100) / 100,
    currency: r.currency,
    description: r.description,
    methods: r.methods,
    state: effectiveState(r),
    test: r.test,
    payments: r.payments,
    source: r.source,
    latestQuote: r.cryptoQuotes[r.cryptoQuotes.length - 1],
    expiresAt: r.expiresAt,
    paidAt: r.paidAt,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
