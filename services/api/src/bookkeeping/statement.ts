/**
 * Statement lines: the account's real activity as ONE euro line per economic
 * event, the way a PayPal or Stripe clearing account appears in German books.
 *
 * Every event on the account has two or three on-chain steps behind it (a
 * USDC receipt, a swap and an EURe credit; an EURe debit, a Monerium burn and
 * a SEPA payment). The accountant is charged per line and must see one, with
 * one Beleg holding the detail. This module projects the store's rows into
 * `LedgerEntry` rows carrying a `statement` block; it is pure, so the same
 * inputs always give the same lines and a re-run changes nothing.
 *
 * Each line has a stable key. Idempotency is the key, not the row id: the
 * writer (writer.ts) looks a projected line up by key and leaves anything a
 * human touched — the account code above all — alone.
 *
 * Rule 3 applies to values: a USDC receipt with no ECB rate produces NO line,
 * never a line at a guessed rate.
 */
import { createHash } from "node:crypto";
import type { Invoice, LedgerEntry, StatementEvent, StatementFacts } from "../domain/types.js";
import type {
  ConversionSweep,
  CryptoDeposit,
  MoneriumIssueRecord,
  Transfer,
} from "../store/types.js";
import type { PaymentRequest } from "../payment-requests.js";
import { textCarriesCode } from "../payment-requests.js";
import { paymentMemo } from "../sepa.js";

export interface StatementInputs {
  orgId: string;
  accountId: string;
  userId: string;
  /** The Safe whose movements these are. */
  safeAddress: string;
  transfers: Transfer[];
  deposits: CryptoDeposit[];
  issueOrders: MoneriumIssueRecord[];
  sweeps: ConversionSweep[];
  invoices: Invoice[];
  paymentRequests: PaymentRequest[];
  /** Rule 2: no swap has moved real money, so every conversion figure is
   *  labelled as coming from an unexecuted path until one has. */
  swapsHaveExecuted: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const r2 = (n: number) => Math.round(n * 100) / 100;
const cents = (eur: number) => Math.round(eur * 100);
const day = (iso: string) => iso.slice(0, 10);
const eurString = (c: number) => (Math.abs(c) / 100).toFixed(2);

/** A row id derived from the org and the key, so the same event never gets
 *  two rows even across processes. */
export function lineId(orgId: string, key: string): string {
  return `led_${createHash("sha256").update(`${orgId}\n${key}`).digest("hex").slice(0, 32)}`;
}

interface LineDraft {
  event: StatementEvent;
  key: string;
  bookingAt: string;
  valueAt: string;
  amountCents: number;
  counterparty: StatementFacts["counterparty"];
  reference: string;
  links: StatementFacts["links"];
  txType: string;
  tags: string[];
  note?: string;
  unexecuted?: boolean;
}

function toEntry(inp: StatementInputs, d: LineDraft, now: string): LedgerEntry {
  return {
    id: lineId(inp.orgId, d.key),
    orgId: inp.orgId,
    source: { kind: "account", accountId: inp.accountId },
    direction: d.amountCents >= 0 ? "in" : "out",
    asset: "EUR",
    amount: eurString(d.amountCents),
    fiatValue: eurString(d.amountCents),
    fiatCurrency: "EUR",
    fiatRate: "1",
    counterparty: {
      ...(d.counterparty.name ? { name: d.counterparty.name } : {}),
      ...(d.counterparty.address ? { address: d.counterparty.address } : {}),
    },
    tags: d.tags,
    ...(d.note ? { note: d.note } : {}),
    txType: d.txType,
    ...(d.links.txHashes[0] ? { txHash: d.links.txHashes[0] } : {}),
    at: d.valueAt,
    createdAt: now,
    statement: {
      key: d.key,
      event: d.event,
      bookingDate: day(d.bookingAt),
      valueDate: day(d.valueAt),
      amountCents: d.amountCents,
      counterparty: d.counterparty,
      reference: d.reference,
      links: d.links,
      ...(d.unexecuted ? { unexecuted: true } : {}),
    },
  };
}

/** The invoice a record settles, by settlement ref or by payment link. */
function invoiceByRef(invoices: Invoice[], ref: string): Invoice | undefined {
  return invoices.find((i) => (i.settlements ?? []).some((s) => (s.ref ?? "") === ref));
}
const invoiceNumber = (i?: Invoice) => i?.issued?.number ?? i?.supplier?.invoiceNumber;

/** What the accountant should match on, in order of how directly it names
 *  the invoice: the external number, the invoice number, the memo. */
function referenceFor(parts: (string | undefined)[], fallback: string): string {
  const found = parts.map((p) => (p ?? "").trim()).filter(Boolean);
  return (found[0] ?? fallback).slice(0, 140);
}

function requestFor(inp: StatementInputs, id?: string, memo?: string): PaymentRequest | undefined {
  if (id) return inp.paymentRequests.find((r) => r.id === id);
  if (!memo) return undefined;
  return inp.paymentRequests.find((r) => textCarriesCode(memo, r.code));
}

// ── SEPA in ──────────────────────────────────────────────────────────────────

function sepaInLines(inp: StatementInputs): LineDraft[] {
  const out: LineDraft[] = [];
  for (const o of inp.issueOrders) {
    if (o.userId !== inp.userId || !(o.amountEur > 0)) continue;
    const req = requestFor(inp, undefined, o.memo);
    const inv = invoiceByRef(inp.invoices, `monerium:${o.orderId}`) ?? (req?.invoiceId ? inp.invoices.find((i) => i.id === req.invoiceId) : undefined);
    // The chain's view of the same money: the mint into the Safe.
    const mint = inp.deposits.find(
      (d) => d.token === "EURE" && (d.from ?? ZERO) === ZERO && d.userId === inp.userId &&
        Math.abs((d.amountEur ?? 0) - o.amountEur) < 0.005 &&
        Math.abs(Date.parse(d.receipt?.blockTimestamp ?? d.detectedAt) - Date.parse(o.processedAt)) < 3 * 24 * 3600_000,
    );
    out.push({
      event: "sepa_in",
      key: `monerium:issue:${o.orderId}`,
      bookingAt: o.recordedAt,
      valueAt: o.processedAt,
      amountCents: cents(o.amountEur),
      counterparty: { name: o.counterpartyName, iban: o.counterpartyIban },
      reference: referenceFor([req?.externalInvoiceNumber, invoiceNumber(inv), o.memo], o.orderId),
      links: {
        orderId: o.orderId,
        ...(req ? { paymentRequestId: req.id } : {}),
        ...(inv ? { invoiceId: inv.id } : {}),
        ...(invoiceNumber(inv) ? { invoiceNumber: invoiceNumber(inv) } : req?.externalInvoiceNumber ? { invoiceNumber: req.externalInvoiceNumber } : {}),
        ...(mint ? { depositId: mint.id } : {}),
        txHashes: mint ? [mint.txHash] : [],
      },
      txType: "transfer_in",
      tags: ["sepa"],
    });
  }
  return out;
}

// ── SEPA out, and its reversal ───────────────────────────────────────────────

const SEPA_LEFT = new Set(["PAYOUT_SUBMITTED", "PAID"]);

function sepaOutLines(inp: StatementInputs): LineDraft[] {
  const out: LineDraft[] = [];
  for (const t of inp.transfers) {
    if (t.userId !== inp.userId || t.rail !== "sepa") continue;
    const hashes = t.txs.map((x) => x.hash).filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h));
    const paidInvoice = inp.invoices.find((i) => i.payment?.transferId === t.id);
    const req = inp.paymentRequests.find((r) => r.payments.some((p) => p.transferId === t.id));
    if (t.state === "PAID" || t.state === "PAYOUT_SUBMITTED") {
      if (!SEPA_LEFT.has(t.state)) continue;
      const payout = t.receiveEur ?? t.sendEur;
      out.push({
        event: "sepa_out",
        key: `transfer:${t.id}:payout`,
        bookingAt: t.createdAt,
        valueAt: t.updatedAt,
        amountCents: -cents(payout),
        counterparty: { name: t.recipientName, iban: t.recipientIban },
        reference: referenceFor([invoiceNumber(paidInvoice), req?.externalInvoiceNumber, t.reference, t.moneriumRedeem?.memo], paymentMemo(t.id, t.reference)),
        links: {
          transferId: t.id,
          ...(t.sepa?.orderId ? { orderId: t.sepa.orderId } : {}),
          ...(paidInvoice ? { invoiceId: paidInvoice.id, invoiceNumber: invoiceNumber(paidInvoice) } : {}),
          ...(req ? { paymentRequestId: req.id } : {}),
          txHashes: hashes,
        },
        txType: "payout",
        tags: ["sepa", ...(t.state === "PAYOUT_SUBMITTED" ? ["submitted"] : [])],
        ...(t.state === "PAYOUT_SUBMITTED" ? { note: "Redeem placed with Monerium; not yet confirmed processed." } : {}),
      });
      const fee = r2(t.sendEur - payout);
      if (fee > 0) {
        out.push({
          event: "sepa_out",
          key: `transfer:${t.id}:fee`,
          bookingAt: t.createdAt,
          valueAt: t.updatedAt,
          amountCents: -cents(fee),
          counterparty: { name: "Zold" },
          reference: `Zold fee ${t.id.replace(/-/g, "").slice(0, 8)}`,
          links: { transferId: t.id, txHashes: hashes },
          txType: "gas_fee",
          tags: ["fee"],
        });
      }
    }
    if (t.state === "REFUNDED" && t.refund && t.refund.amountEur > 0) {
      // Money left the Safe and came back: two lines, so the books show both
      // movements and any deduction between them, rather than nothing.
      out.push({
        event: "sepa_out",
        key: `transfer:${t.id}:debit`,
        bookingAt: t.createdAt,
        valueAt: t.auth?.authorizedAt ?? t.createdAt,
        amountCents: -cents(t.sendEur),
        counterparty: { name: t.recipientName, iban: t.recipientIban },
        reference: referenceFor([t.reference], paymentMemo(t.id, t.reference)),
        links: { transferId: t.id, txHashes: hashes.filter((h) => !t.txs.find((x) => x.hash === h && x.step === "safe.refundTransfer")) },
        txType: "payout",
        tags: ["sepa", "failed"],
        note: t.error ? `Failed: ${t.error.slice(0, 160)}` : "Failed before payout.",
      });
      out.push({
        event: "sepa_out_reversal",
        key: `transfer:${t.id}:refund`,
        bookingAt: t.refund.at,
        valueAt: t.refund.at,
        amountCents: cents(t.refund.amountEur),
        counterparty: { name: t.recipientName, iban: t.recipientIban },
        reference: `Reversal ${t.id.replace(/-/g, "").slice(0, 8)}`,
        links: { transferId: t.id, txHashes: t.txs.filter((x) => x.step === "safe.refundTransfer").map((x) => x.hash) },
        txType: "transfer_in",
        tags: ["reversal"],
        note: `Refund of a failed payout (${t.refund.recoveredFrom}). ${t.refund.deductions}`.slice(0, 240),
      });
    }
  }
  return out;
}

// ── Crypto in: converted, or held ────────────────────────────────────────────

function cryptoLines(inp: StatementInputs): LineDraft[] {
  const out: LineDraft[] = [];
  for (const d of inp.deposits) {
    if (d.userId !== inp.userId || d.token !== "USDC" || d.state !== "CONVERTED") continue;
    const req = requestFor(inp, d.paymentRequestId);
    const inv = d.invoiceId ? inp.invoices.find((i) => i.id === d.invoiceId) : undefined;
    const receivedAt = d.receipt?.blockTimestamp ?? d.detectedAt;
    const reference = referenceFor([req?.externalInvoiceNumber, invoiceNumber(inv), req ? `Pay link ${req.code}` : undefined], `Deposit ${d.txHash.slice(0, 10)}`);
    const links: StatementFacts["links"] = {
      depositId: d.id,
      ...(req ? { paymentRequestId: req.id } : {}),
      ...(inv ? { invoiceId: inv.id } : {}),
      ...(invoiceNumber(inv) ? { invoiceNumber: invoiceNumber(inv) } : req?.externalInvoiceNumber ? { invoiceNumber: req.externalInvoiceNumber } : {}),
      // Chain transactions only: the userOperation hash is the bundler's
      // identifier, kept beside them, never among them.
      txHashes: [
        d.txHash,
        ...(d.conversion?.txHash ? [d.conversion.txHash] : []),
        ...d.txs
          .filter((x) => x.step !== "userOperation" && x.hash !== d.conversion?.userOpHash)
          .map((x) => x.hash)
          .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h) && h !== d.conversion?.txHash),
      ],
      ...(d.conversion?.userOpHash ? { userOpHash: d.conversion.userOpHash } : {}),
    };
    const counterparty = { ...(req?.source.orderName ? { name: `Order ${req.source.orderName}` } : {}), ...(d.from ? { address: d.from } : {}) };
    if (d.settlementAsset === "EURE" && (d.creditedEur ?? 0) > 0) {
      out.push({
        event: "crypto_converted",
        key: `deposit:${d.id}:converted`,
        bookingAt: receivedAt,
        valueAt: d.conversion?.at ?? d.updatedAt,
        amountCents: cents(d.creditedEur!),
        counterparty,
        reference,
        links,
        txType: "invoice_payment",
        tags: ["usdc", "converted"],
        unexecuted: !inp.swapsHaveExecuted,
      });
      continue;
    }
    if (d.settlementAsset === "USDC") {
      // Held as USDC: the receivable is discharged and an asset acquired at
      // its euro value on the day. No ECB rate, no value, no line.
      if (!d.receipt || !(d.receipt.amountEur > 0)) continue;
      out.push({
        event: "crypto_held",
        key: `deposit:${d.id}:held`,
        bookingAt: receivedAt,
        valueAt: receivedAt,
        amountCents: cents(d.receipt.amountEur),
        counterparty,
        reference,
        links,
        txType: "invoice_payment",
        tags: ["usdc", "held"],
        note: `${d.amountUsdc ?? 0} USDC held, not converted. Valued at the ECB reference rate of ${d.receipt.rateAsOf}.`,
      });
    }
  }
  return out;
}

// ── The monthly sweep ────────────────────────────────────────────────────────

function sweepLines(inp: StatementInputs): LineDraft[] {
  return inp.sweeps
    .filter((s) => s.userId === inp.userId && s.creditedEur > 0)
    .map((s) => ({
      event: "sweep" as const,
      key: `sweep:${s.id}`,
      bookingAt: s.at,
      valueAt: s.conversion?.at ?? s.at,
      amountCents: cents(s.creditedEur),
      counterparty: { name: "Kursdifferenz / Restbeträge" },
      reference: `Kursdifferenz / Restbeträge ${s.month}`,
      links: {
        txHashes: [...(s.conversion?.txHash ? [s.conversion.txHash] : []), ...s.txs.map((x) => x.hash).filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h) && h !== s.conversion?.txHash)],
        ...(s.conversion?.userOpHash ? { userOpHash: s.conversion.userOpHash } : {}),
      },
      txType: "realised_gain",
      tags: ["usdc", "sweep"],
      note: `Leftover USDC from ${s.depositIds.length} exact-output conversion(s), converted in one swap.`,
      unexecuted: !inp.swapsHaveExecuted,
    }));
}

/** Every line the inputs support, sorted by value date. */
export function projectStatementLines(inp: StatementInputs, now = new Date().toISOString()): LedgerEntry[] {
  const drafts = [...sepaInLines(inp), ...sepaOutLines(inp), ...cryptoLines(inp), ...sweepLines(inp)];
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const d of drafts) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(toEntry(inp, d, now));
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What to write. Rows are matched by statement key. A new row is added; an
 * existing one has only its statement facts refreshed (a conversion that
 * gained a tx hash, an order that gained a counterparty), and keeps its id,
 * created time, tags, note, document code and — above all — any account
 * code, because a human may have set it.
 */
export function mergeStatementLines(
  existing: LedgerEntry[],
  projected: LedgerEntry[],
): { toAdd: LedgerEntry[]; toUpdate: { id: string; patch: Partial<LedgerEntry> }[] } {
  const byKey = new Map(existing.filter((e) => e.statement).map((e) => [e.statement!.key, e]));
  const toAdd: LedgerEntry[] = [];
  const toUpdate: { id: string; patch: Partial<LedgerEntry> }[] = [];
  for (const p of projected) {
    const cur = byKey.get(p.statement!.key);
    if (!cur) {
      toAdd.push(p);
      continue;
    }
    const nextFacts: StatementFacts = { ...p.statement!, ...(cur.statement?.documentCode ? { documentCode: cur.statement.documentCode } : {}) };
    const facts = { ...cur.statement, ...nextFacts };
    const changed =
      JSON.stringify(facts) !== JSON.stringify(cur.statement) ||
      cur.amount !== p.amount ||
      cur.direction !== p.direction ||
      cur.at !== p.at ||
      (cur.txHash ?? "") !== (p.txHash ?? "") ||
      JSON.stringify(cur.counterparty ?? {}) !== JSON.stringify(p.counterparty ?? {});
    if (changed) {
      toUpdate.push({
        id: cur.id,
        patch: {
          amount: p.amount,
          fiatValue: p.fiatValue,
          direction: p.direction,
          at: p.at,
          ...(p.txHash ? { txHash: p.txHash } : {}),
          counterparty: { ...(cur.counterparty ?? {}), ...(p.counterparty ?? {}) },
          statement: facts,
        },
      });
    }
  }
  return { toAdd, toUpdate };
}

/** Lines in a calendar month, by value date. */
export function linesInMonth(entries: LedgerEntry[], month: string): LedgerEntry[] {
  return entries
    .filter((e) => e.statement && e.statement.valueDate.slice(0, 7) === month)
    .sort((a, b) => a.statement!.valueDate.localeCompare(b.statement!.valueDate) || a.statement!.key.localeCompare(b.statement!.key));
}

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
