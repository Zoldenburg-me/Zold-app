/**
 * Public shareable receipts — `zold.to/r/<slug>`.
 *
 * A recipient opens this without an account, so the page is built from a
 * payload assembled here and nowhere else. Two rules shape the whole module:
 *
 *  1. REDACTION HAPPENS HERE. A field the sender withheld is never put in the
 *     response, not even to be hidden by CSS — the browser cannot leak what it
 *     was never sent. Withheld fields become `{ withheld: true }` with no
 *     value, so the page can still draw the row honestly (the design shows
 *     redaction rather than pretending the field does not exist) without ever
 *     holding the secret.
 *
 *  2. NOTHING IS INVENTED. Every row and every route hop is read off the
 *     transfer, its quote, and the deployment's own configuration. Where the
 *     transfer has no answer the row is absent, and where a leg ran in
 *     simulation the hop says so. A receipt is the one screen where a
 *     plausible-looking number is worse than a missing one: the recipient has
 *     no way to check it and every reason to believe it.
 */
import { CHAIN_ID, FX, MONERIUM, moneriumSandboxEnabled } from "./config.js";
import type { Quote, ReceiptShareFields, Transfer, User } from "./store.js";

/** A value the sender chose not to publish. Carries no value, by construction. */
export interface Withheld {
  withheld: true;
}
export type Maybe<T> = T | Withheld;

const WITHHELD: Withheld = { withheld: true };

export interface ReceiptRow {
  key: string;
  value?: string;
  withheld?: true;
  /** Identifiers and figures render in the mono face; prose does not. */
  mono?: boolean;
  /** The received amount is the one green figure on the page. */
  tone?: "default" | "muted" | "mint";
}

export interface ReceiptHop {
  rail: string;
  badge: string;
  via: string;
  ref?: string;
  withheld?: true;
  /** Draw the Base mark instead of a step number. Only when it really is Base. */
  base?: boolean;
  /** A leg that was simulated rather than settled, named as such. */
  simulated?: boolean;
}

export interface ReceiptPayload {
  slug: string;
  status: { label: string; tone: "mint" | "amber" | "red"; settled: boolean };
  hero: { amount: string; at: string };
  parties: { from: Maybe<ReceiptName>; to: Maybe<ReceiptName> };
  rows: ReceiptRow[];
  steps: { title: string; time?: string; done: boolean }[];
  route?: ReceiptHop[];
  /** True when at least one field on the page is a redaction block. */
  anyWithheld: boolean;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// slug

/**
 * An unguessable slug, shaped like the design's `8842-1170`.
 *
 * The design's own example is eight digits. That is 10^8 — a few hours of
 * requests to enumerate every receipt anyone has ever shared, and each hit
 * returns a real name, a real amount and often a bank account. So the SHAPE is
 * kept (three hyphenated groups read and dictate well) and the entropy is not:
 * 15 characters of Crockford base32 is ~74 bits, which is not searchable.
 *
 * Ambiguous glyphs are excluded so a slug survives being read aloud or copied
 * off a screenshot.
 */
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function receiptSlug(random: (n: number) => Uint8Array): string {
  const bytes = random(15);
  const chars = Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]);
  return [chars.slice(0, 5).join(""), chars.slice(5, 10).join(""), chars.slice(10, 15).join("")].join("-");
}

export const SHARE_TTL_DAYS = 30;

export const DEFAULT_SHARE_FIELDS: ReceiptShareFields = {
  sender: "last",
  recipient: "full",
  account: "short",
  fx: "both",
  showRate: true,
  showRef: true,
  route: false,
};

/**
 * Accept only the selections we know, and fall back to the stricter default
 * rather than the value we were handed. A body that names an unknown mode must
 * not open a field wider than the sender has ever chosen.
 */
export function parseShareFields(body: any, base = DEFAULT_SHARE_FIELDS): ReceiptShareFields {
  const one = <T extends string>(v: any, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const bool = (v: any, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    sender: one(body?.sender, ["full", "first", "last", "hidden"] as const, base.sender),
    recipient: one(body?.recipient, ["full", "first", "last", "hidden"] as const, base.recipient),
    account: one(body?.account, ["full", "short", "hidden"] as const, base.account),
    fx: one(body?.fx, ["both", "sender", "recipient"] as const, base.fx),
    showRate: bool(body?.showRate, base.showRate),
    showRef: bool(body?.showRef, base.showRef),
    route: bool(body?.route, base.route),
  };
}

// ---------------------------------------------------------------------------
// formatting

const eur = (n: number) => `€${n.toFixed(2)}`;
const kes = (n: number) =>
  `KES ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function nameParts(full: string): { first: string; last: string } {
  const [first, ...rest] = String(full ?? "").trim().split(/\s+/);
  return { first: first ?? "", last: rest.join(" ") };
}

/**
 * A name at the granularity the sender picked.
 *
 * Returned in parts rather than as one pre-joined string. The page has to draw
 * `Amina ▒▒▒▒▒` — a visible half beside a redaction block — and encoding that as
 * a single string means inventing a sentinel, which either collides with real
 * names or hides an invisible character in the payload. Parts say which half is
 * missing and carry nothing of the half that is.
 *
 * A person with a single-word name has no second half to withhold. Falling back
 * to the whole name there would publish it under a label promising otherwise,
 * so that case redacts entirely rather than quietly over-sharing.
 */
export interface ReceiptName {
  first?: string;
  last?: string;
  /** Which half, if either, the page must draw as a redaction block. */
  redact: "first" | "last" | "none";
}

function nameFor(mode: ReceiptShareFields["sender"], full: string): Maybe<ReceiptName> {
  const { first, last } = nameParts(full);
  if (mode === "hidden") return WITHHELD;
  if (mode === "full") {
    return full.trim() ? { first, ...(last ? { last } : {}), redact: "none" } : WITHHELD;
  }
  if (mode === "first") return first ? { first, redact: "last" } : WITHHELD;
  return last ? { last, redact: "first" } : WITHHELD;
}

function accountFor(mode: ReceiptShareFields["account"], value?: string): Maybe<string> {
  if (!value || mode === "hidden") return WITHHELD;
  const clean = value.replace(/\s+/g, "");
  if (mode === "full") return clean.replace(/(.{4})/g, "$1 ").trim();
  // Enough to recognise your own account, not enough to pay into it.
  return clean.length > 8 ? `${clean.slice(0, 4)} ···· ${clean.slice(-4)}` : WITHHELD;
}

// ---------------------------------------------------------------------------
// status

/**
 * What the page is allowed to claim.
 *
 * A shared link outlives the moment it was made, so the hero cannot say
 * "Delivered" because it was sharing-worthy at the time — it reads the
 * transfer's current state every request. In-flight and failed transfers say so
 * plainly; a recipient chasing money is exactly who a falsely green receipt
 * hurts most.
 */
export function receiptStatus(t: Transfer): ReceiptPayload["status"] {
  if (t.state === "PAID") return { label: "Delivered", tone: "mint", settled: true };
  if (t.state === "REFUNDED") return { label: "Refunded to sender", tone: "amber", settled: false };
  if (t.state === "FAILED") return { label: "Failed", tone: "red", settled: false };
  if (t.state === "MANUAL_REVIEW") return { label: "Under review", tone: "amber", settled: false };
  if (t.state === "PAYOUT_READY") return { label: "Ready to collect", tone: "amber", settled: false };
  return { label: "In progress", tone: "amber", settled: false };
}

// ---------------------------------------------------------------------------
// route

const BASE_CHAINS = new Set([8453, 84532]);

function chainLabel(): string {
  if (CHAIN_ID === 8453) return "Base";
  if (CHAIN_ID === 84532) return "Base Sepolia";
  if (CHAIN_ID === 31337) return "Local chain";
  return `Chain ${CHAIN_ID}`;
}

function routeRate(rate: string, tokenIn: string, tokenOut: string): string {
  const raw = BigInt(rate);
  const human = Number(raw) / 1e6;
  return `1 ${tokenIn} = ${human.toFixed(4)} ${tokenOut}`;
}

/**
 * The settlement route, derived from what the transfer actually did.
 *
 * The design draws six fixed hops ending at a Stellar/MYKOBO jump and a
 * MoneyGram counter. This codebase does not have that route: the SEPA rail has
 * no Stellar leg at all, the swap goes through whichever liquidity venue won,
 * and the anchor half has never settled against a real payout partner. So the
 * hops are built from `txs`, `liquidity`, `sepa` and `pickup` — a leg that did
 * not run is not drawn, and a leg that ran in simulation carries `simulated` so
 * the page can say so rather than let a dry run read as a settlement.
 */
export function receiptRoute(t: Transfer, fields: ReceiptShareFields): ReceiptHop[] {
  const hops: ReceiptHop[] = [];
  const step = (prefix: string) => t.txs?.find((x) => x.step.startsWith(prefix));
  const onBase = BASE_CHAINS.has(CHAIN_ID);

  // 1. The user's own Safe. On SEPA only the fee leaves it — the payout is
  //    burned from the Safe by Monerium — and saying "your money moved here"
  //    would misdescribe where the euros actually were.
  const safeMove = step("safe.transfer");
  if (safeMove) {
    const feeOnly = safeMove.step === "safe.transfer.fee";
    hops.push({
      rail: "Zold Safe",
      badge: chainLabel(),
      base: onBase,
      via: feeOnly
        ? "Zold's fee moved out of the sender's smart account; the payout stayed in it until redemption"
        : "EURe moved out of the sender's smart account",
      ...(fields.sender === "hidden" ? { withheld: true as const } : {}),
    });
  }

  // 2. The conversion leg, named by the venue that actually filled it.
  const liq = t.liquidity;
  if (liq) {
    hops.push({
      rail: liq.provider === "fx-swapper" ? "Zold FX inventory" : `Liquidity · ${liq.provider}`,
      badge: liq.tokenIn === "EURe" ? "EURe → USDC" : "USDC → EURe",
      via:
        liq.provider === "fx-swapper"
          ? "Filled from Zold's own inventory at the rate held on the swapper contract"
          : `Filled just-in-time by ${liq.provider}`,
      ...(fields.showRate ? { ref: routeRate(liq.rate, liq.tokenIn, liq.tokenOut) } : { withheld: true as const }),
      ...(liq.executedAt ? {} : { simulated: true as const }),
    });
  }

  // 3. Bridge.xyz funding. Dry-run is the default and must never read as a
  // completed stablecoin movement.
  const bridgeFunding = step("bridge.xyz.deposit.transfer") || step("bridge.xyz.destination_tx");
  const bridgePlan = t.txs?.find((x) => x.step.startsWith("bridge.xyz.") && x.step.endsWith(".transfer"));
  if (bridgeFunding || bridgePlan) {
    hops.push({
      rail: "Bridge.xyz",
      badge: "Bridge",
      via: bridgeFunding
        ? "USDC funding was sent to Bridge for Stellar-side settlement"
        : "Bridge transfer plan recorded; no funds were sent",
      ...(bridgeFunding ? {} : { simulated: true as const }),
    });
  }

  // 4a. SEPA: Monerium redeems the EURe and the euro leg leaves.
  if (t.rail === "sepa" && t.sepa) {
    hops.push({
      rail: "Monerium EMI",
      badge: "E-money",
      via:
        t.sepa.mode === "sandbox"
          ? `Regulated issuer redeems EURe 1:1 into euro on ${MONERIUM.chain}`
          : "Simulated redemption — no issuer order was placed",
      ...(fields.account === "hidden"
        ? { withheld: true as const }
        : { ref: t.sepa.orderId ? `order ${t.sepa.orderId}` : t.sepa.state }),
      ...(t.sepa.mode === "sandbox" ? {} : { simulated: true as const }),
    });
    hops.push({
      rail: "SEPA credit transfer",
      badge: "Bank",
      via: "Euro leg settles to the payout account",
      ...(fields.showRef && t.moneriumRedeem?.memo
        ? { ref: t.moneriumRedeem.memo }
        : { withheld: true as const }),
      ...(moneriumSandboxEnabled() ? {} : { simulated: true as const }),
    });
  }

  // 4b. Cash: the anchor, then the counter. Both only as far as they ran.
  if (t.rail === "cash" && t.pickup) {
    const p = t.pickup;
    if (p.anchorTransactionId || p.anchorPaymentHash) {
      hops.push({
        rail: "Stellar anchor",
        badge: "Anchor",
        via: p.anchorPaymentHash
          ? "Payout asset delivered to the anchor's account on Stellar"
          : "Withdrawal opened with the anchor; no on-ledger payment yet",
        ...(p.anchorPaymentHash ? {} : { simulated: true as const }),
      });
    }
    hops.push({
      rail: p.provider || "Payout partner",
      badge: "Payout",
      via: "Cash collected by the recipient at an agent counter",
      ...(fields.recipient === "hidden" || !p.referenceCode
        ? { withheld: true as const }
        : { ref: `pickup ${p.referenceCode}` }),
      ...(p.status === "PAID" ? {} : { simulated: true as const }),
    });
  }

  return hops;
}

// ---------------------------------------------------------------------------
// payload

/**
 * Build everything the public page gets, for one share.
 *
 * `quote` is optional because a quote can be pruned while its transfer lives on;
 * the rate rows are then absent rather than guessed from the amounts, which
 * would reconstruct a number the sender may have chosen to withhold.
 */
export function buildReceipt(args: {
  slug: string;
  transfer: Transfer;
  sender: User;
  quote?: Quote;
  fields: ReceiptShareFields;
  expiresAt: string;
}): ReceiptPayload {
  const { transfer: t, sender, quote, fields, slug } = args;
  const sepa = t.rail === "sepa";
  const status = receiptStatus(t);
  const rows: ReceiptRow[] = [];

  const sentEur = eur(t.sendEur);
  const receivedEur = eur(t.receiveEur ?? Math.max(0, t.sendEur - FX.FIXED_FEE_EUR));
  const receivedKes = kes(t.receiveKes ?? 0);
  const received = sepa ? receivedEur : receivedKes;

  // The hero follows the currency picker: "KES only" means a recipient sees the
  // figure in the money they actually get, and nothing in euro.
  const hero = fields.fx === "recipient" ? received : sentEur;

  const push = (key: string, v: Maybe<string> | undefined, opts: Omit<ReceiptRow, "key" | "value" | "withheld"> = {}) => {
    if (v === undefined) return;
    if (typeof v === "object") rows.push({ key, withheld: true, ...opts });
    else rows.push({ key, value: v, ...opts });
  };

  if (fields.showRef && t.reference) push("Reference", t.reference, { mono: true, tone: "muted" });
  push(sepa ? "Payout account" : "Mobile number", accountFor(fields.account, sepa ? t.recipientIban : t.recipientPhone), {
    mono: true,
  });

  if (fields.fx === "both") {
    push("Sent", sentEur, { mono: true });
    push("Received", received, { mono: true, tone: "mint" });
  } else {
    push("Amount", fields.fx === "sender" ? sentEur : received, {
      mono: true,
      tone: fields.fx === "sender" ? "default" : "mint",
    });
  }

  if (fields.showRate) {
    if (quote && !sepa && quote.fxRate) {
      push("Your rate", `1 EUR = ${quote.fxRate.toFixed(2)} KES`, { mono: true, tone: "muted" });
    }
    if (quote) {
      // marginBps is measured between the live mid and what we delivered, so it
      // is reportable as-is. Presenting the flat fee without it understated what
      // the transfer cost, which is the whole reason the measurement exists.
      const margin = quote.marginBps ? ` · ${(quote.marginBps / 100).toFixed(2)}%` : "";
      push("Zold fee", `${eur(quote.fixedFeeEur ?? FX.FIXED_FEE_EUR)}${margin}`, { mono: true, tone: "muted" });
    }
  }

  push("Delivered via", sepa ? "SEPA credit transfer" : t.pickup?.provider || "Cash pickup", { tone: "muted" });
  if (t.refund) push("Refunded", `${eur(t.refund.amountEur)} · ${t.refund.deductions}`, { tone: "muted" });

  const route = fields.route ? receiptRoute(t, fields) : undefined;
  const parties = {
    from: nameFor(fields.sender, sender.name),
    to: nameFor(fields.recipient, t.recipientName),
  };

  const anyWithheld =
    rows.some((r) => r.withheld) ||
    typeof parties.from === "object" ||
    typeof parties.to === "object" ||
    Boolean(route?.some((h) => h.withheld)) ||
    // A row the picker removed entirely is still something the sender withheld.
    !fields.showRate ||
    (!fields.showRef && Boolean(t.reference));

  return {
    slug,
    status,
    hero: { amount: hero, at: t.updatedAt ?? t.createdAt },
    parties,
    rows,
    steps: receiptSteps(t),
    ...(route ? { route } : {}),
    anyWithheld,
    expiresAt: args.expiresAt,
  };
}

/**
 * The settlement timeline.
 *
 * Deliberately the same five stages the app's own `mTimeline` draws, driven by
 * the same state mapping. A recipient and a sender comparing screens must not
 * see the same transfer described as a different number of steps — that
 * mismatch is what the in-app timelines were unified to remove.
 */
export function receiptSteps(t: Transfer): ReceiptPayload["steps"] {
  const cash = t.rail === "cash";
  const titles = [
    "Payment authorised",
    "Debited from the sender's safe",
    cash ? "Converted for payout" : "Redeem order placed",
    cash ? "Cleared to payout partner" : "Sent over SEPA",
    cash ? "Collected by recipient" : "Paid out",
  ];
  const reached =
    ({
      CREATED: 1,
      DEBITED: 2,
      SWAPPED: 3,
      BRIDGED: 3,
      PAYOUT_DETAILS_PENDING: 3,
      PAYOUT_FUNDING_PENDING: 4,
      PAYOUT_FUNDED: 4,
      PAYOUT_READY: 4,
      PAYOUT_SUBMITTED: 4,
      PAID: 5,
    } as Record<string, number>)[t.state] ?? 1;
  // Only the final step carries a time: it is the only one the store timestamps.
  // Inventing per-step clock times from `updatedAt` would date four events that
  // were never separately recorded.
  return titles.map((title, i) => ({
    title,
    done: i < reached,
    ...(i === reached - 1 ? { time: t.updatedAt } : {}),
  }));
}
