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
  CryptoSend,
  MoneriumIssueRecord,
  Transfer,
} from "../store/types.js";
import { OPERATOR_REFUND_STEP } from "../store/types.js";
import { safeMovedEur } from "../transfers/safe-moved.js";
import { conversionOutputs } from "../transfers/conversion-outputs.js";
import type { PaymentRequest } from "../payment-requests.js";
import { textCarriesCode } from "../payment-requests.js";
import { paymentMemo } from "../sepa.js";
import { dayOf } from "../domain/income-invoices.js";

export interface StatementInputs {
  orgId: string;
  accountId: string;
  userId: string;
  /** The Safe whose movements these are. */
  safeAddress: string;
  /** The org's reporting time zone: a line's booking and value days are its days. */
  timeZone: string;
  transfers: Transfer[];
  deposits: CryptoDeposit[];
  issueOrders: MoneriumIssueRecord[];
  sweeps: ConversionSweep[];
  invoices: Invoice[];
  paymentRequests: PaymentRequest[];
  cryptoSends?: CryptoSend[];
  /** Rule 2: no swap has moved real money, so every conversion figure is
   *  labelled as coming from an unexecuted path until one has. */
  swapsHaveExecuted: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const r2 = (n: number) => Math.round(n * 100) / 100;
const cents = (eur: number) => Math.round(eur * 100);
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
      bookingDate: dayOf(d.bookingAt, inp.timeZone),
      valueDate: dayOf(d.valueAt, inp.timeZone),
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
/** Steps whose hash is the refund: ours, or one an operator recorded. */
const REFUND_STEPS = new Set<string>(["safe.refundTransfer", OPERATOR_REFUND_STEP]);

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
    const movedEur = safeMovedEur(t);
    if (t.state === "REFUNDED" && t.refund && movedEur > 0) {
      // Money left the Safe: the debit is booked whatever came back, so a
      // refund of €0 still shows the loss. What came back is the reversal,
      // and the gap between the two lines is the deduction.
      out.push({
        event: "sepa_out",
        key: `transfer:${t.id}:debit`,
        bookingAt: t.createdAt,
        valueAt: t.auth?.authorizedAt ?? t.createdAt,
        amountCents: -cents(movedEur),
        counterparty: { name: t.recipientName, iban: t.recipientIban },
        reference: referenceFor([t.reference], paymentMemo(t.id, t.reference)),
        links: { transferId: t.id, txHashes: hashes.filter((h) => !t.txs.find((x) => x.hash === h && REFUND_STEPS.has(x.step))) },
        txType: "payout",
        tags: ["sepa", "failed"],
        note: t.error ? `Failed: ${t.error.slice(0, 160)}` : "Failed before payout.",
      });
    }
    if (t.state === "REFUNDED" && t.refund && movedEur > 0 && t.refund.amountEur > 0) {
      out.push({
        event: "sepa_out_reversal",
        key: `transfer:${t.id}:refund`,
        bookingAt: t.refund.at,
        valueAt: t.refund.at,
        amountCents: cents(t.refund.amountEur),
        counterparty: { name: t.recipientName, iban: t.recipientIban },
        reference: `Reversal ${t.id.replace(/-/g, "").slice(0, 8)}`,
        links: { transferId: t.id, txHashes: t.txs.filter((x) => REFUND_STEPS.has(x.step)).map((x) => x.hash) },
        txType: "transfer_in",
        tags: ["reversal"],
        note: `Refund of a failed payout (${t.refund.recoveredFrom}). ${t.refund.deductions}`.slice(0, 240),
      });
    }
  }
  return out;
}

// ── EURe in from another wallet ──────────────────────────────────────────────

/**
 * EURe that reached the Safe as a plain transfer from another wallet. Every
 * other EURe arrival is already a line of its own and is left out here:
 * a mint (from the zero address) is a SEPA credit, booked from Monerium's
 * order; a refund is the reversal of a payout; a swap's output is the
 * conversion line of the deposit or sweep it belongs to.
 */
function eureInLines(inp: StatementInputs): LineDraft[] {
  const booked = new Set<string>();
  for (const t of inp.transfers) for (const x of t.txs) booked.add(x.hash.toLowerCase());
  for (const s of inp.sweeps) {
    if (s.conversion?.txHash) booked.add(s.conversion.txHash.toLowerCase());
    for (const x of s.txs) booked.add(x.hash.toLowerCase());
  }
  // A swap's output by log: another userOp's EURe in the same bundle is
  // money in.
  for (const d of inp.deposits) for (const x of d.txs) if (x.step !== "safe.swap(usdc->eure)") booked.add(x.hash.toLowerCase());
  const isConversionOutput = conversionOutputs(inp.deposits);
  const out: LineDraft[] = [];
  for (const d of inp.deposits) {
    if (d.userId !== inp.userId || d.token !== "EURE" || !((d.amountEur ?? 0) > 0)) continue;
    if ((d.from ?? ZERO) === ZERO || booked.has(d.txHash.toLowerCase()) || isConversionOutput(d.txHash, d.logIndex, d.userId)) continue;
    const at = d.arrivedAt ?? d.detectedAt;
    out.push({
      event: "eure_in",
      key: `deposit:${d.id}:eure`,
      bookingAt: at,
      valueAt: at,
      amountCents: cents(d.amountEur!),
      counterparty: { address: d.from },
      reference: `Deposit ${d.txHash.slice(0, 10)}`,
      links: { depositId: d.id, txHashes: [d.txHash] },
      txType: "transfer_in",
      tags: ["eure"],
    });
  }
  return out;
}

// ── Crypto in: the receipt, and later its disposal ──────────────────────────
//
// The account is one euro clearing account, and held USDC sits in it at its
// euro value on arrival. So a USDC payment is booked in up to two lines:
//
//   receipt   on arrival, whatever the settlement currency: + the ECB value of
//             the day, as the payment (invoice_payment). That is the income
//             and the cost basis.
//   disposal  when the held USDC is converted: + (EURe credited − receipt
//             value), the realised gain or loss (realised_gain / realised_loss).
//             The account's euro value moves by exactly that, so the income is
//             counted once.
//
// With no ECB rate at arrival there is no receipt line (rule 3); a later
// conversion then books its measured proceeds as the payment instead, once.

function cryptoLines(inp: StatementInputs): LineDraft[] {
  const out: LineDraft[] = [];
  for (const d of inp.deposits) {
    if (d.userId !== inp.userId || d.token !== "USDC" || !d.settledAt) continue;
    const req = requestFor(inp, d.paymentRequestId);
    const inv = d.invoiceId ? inp.invoices.find((i) => i.id === d.invoiceId) : undefined;
    const receivedAt = d.receipt?.blockTimestamp ?? d.detectedAt;
    const reference = referenceFor([req?.externalInvoiceNumber, invoiceNumber(inv), req ? `Pay link ${req.code}` : undefined], `Deposit ${d.txHash.slice(0, 10)}`);
    const baseLinks = {
      depositId: d.id,
      ...(req ? { paymentRequestId: req.id } : {}),
      ...(inv ? { invoiceId: inv.id } : {}),
      ...(invoiceNumber(inv) ? { invoiceNumber: invoiceNumber(inv) } : req?.externalInvoiceNumber ? { invoiceNumber: req.externalInvoiceNumber } : {}),
    };
    const partials = d.partials ?? [];
    const partialTx = new Set(partials.flatMap((p) => [p.conversion.txHash, p.conversion.userOpHash].filter((h): h is string => !!h)));
    // Each partial fill disposes of its share of the receipt value; the final
    // conversion disposes of what is left, so every share sums to the receipt.
    const portionCents = (p: (typeof partials)[number]) => cents(p.receiptPortionEur ?? 0);
    // Chain transactions only: the userOperation hash is the bundler's
    // identifier, kept beside them, never among them.
    const conversionLinks: StatementFacts["links"] = {
      ...baseLinks,
      txHashes: [
        ...(d.conversion?.txHash ? [d.conversion.txHash] : []),
        ...d.txs
          // A partial fill's swap belongs to its own line.
          .filter((x) => x.step !== "userOperation" && x.hash !== d.conversion?.userOpHash && !partialTx.has(x.hash))
          .map((x) => x.hash)
          .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h) && h !== d.conversion?.txHash),
      ],
      ...(d.conversion?.userOpHash ? { userOpHash: d.conversion.userOpHash } : {}),
    };
    const counterparty = { ...(req?.source.orderName ? { name: `Order ${req.source.orderName}` } : {}), ...(d.from ? { address: d.from } : {}) };
    const converted = d.holding === "converted" && (d.creditedEur ?? 0) > 0;
    const valued = !!d.receipt && d.receipt.amountEur > 0;

    if (valued) {
      out.push({
        event: "crypto_held",
        key: `deposit:${d.id}:held`,
        bookingAt: receivedAt,
        valueAt: receivedAt,
        amountCents: cents(d.receipt!.amountEur),
        counterparty,
        reference,
        links: { ...baseLinks, txHashes: [d.txHash] },
        txType: "invoice_payment",
        tags: ["usdc", "received"],
        note: `${d.amountUsdc ?? 0} USDC received, valued at the ECB reference rate of ${d.receipt!.rateAsOf} (1 EUR = ${d.receipt!.rate} USD).`,
      });
    }
    partials.forEach((p, i) => {
      const at = p.conversion.at ?? d.updatedAt;
      const units = p.conversion.amountInUnits ? Number(p.conversion.amountInUnits) / 1e6 : undefined;
      const pVia = [`via ${p.provider}`, `at ${p.rate}`, p.midRate ? `(independent mid ${p.midRate})` : ""].filter(Boolean).join(" ");
      const links: StatementFacts["links"] = {
        ...baseLinks,
        txHashes: p.conversion.txHash ? [p.conversion.txHash] : [],
        ...(p.conversion.userOpHash ? { userOpHash: p.conversion.userOpHash } : {}),
      };
      if (valued) {
        const gain = cents(p.creditedEur) - portionCents(p);
        out.push({
          event: "crypto_disposal",
          key: `deposit:${d.id}:disposal:p${i + 1}`,
          bookingAt: at,
          valueAt: at,
          amountCents: gain,
          counterparty: { name: `Conversion via ${p.provider}` },
          reference,
          links,
          txType: gain >= 0 ? "realised_gain" : "realised_loss",
          tags: ["usdc", "disposal", "partial"],
          note:
            `Part disposal of ${units ?? "?"} USDC (book value €${(portionCents(p) / 100).toFixed(2)} of the receipt) ` +
            `for €${p.creditedEur.toFixed(2)} EURe ${pVia}; realised €${(gain / 100).toFixed(2)}. The rest stays held.`,
          unexecuted: !inp.swapsHaveExecuted,
        });
      } else {
        out.push({
          event: "crypto_converted",
          key: `deposit:${d.id}:converted:p${i + 1}`,
          bookingAt: receivedAt,
          valueAt: at,
          amountCents: cents(p.creditedEur),
          counterparty,
          reference,
          links: { ...links, txHashes: [d.txHash, ...links.txHashes] },
          txType: "invoice_payment",
          tags: ["usdc", "converted", "partial"],
          note: `Part of ${d.amountUsdc ?? 0} USDC received on a day with no ECB reference rate, booked at the measured proceeds ${pVia}. The rest stays held.`,
          unexecuted: !inp.swapsHaveExecuted,
        });
      }
    });
    if (!converted) continue;
    const convertedAt = d.conversion?.at ?? d.updatedAt;
    const via = [d.provider ? `via ${d.provider}` : "", d.rate ? `at ${d.rate}` : "", d.midRate ? `(independent mid ${d.midRate})` : ""].filter(Boolean).join(" ");
    // This conversion alone: the total less what the partials delivered.
    const finalUsdc = d.conversion?.amountInUnits ? Number(d.conversion.amountInUnits) / 1e6 : d.amountUsdc ?? 0;
    const finalCents = cents(d.creditedEur!) - partials.reduce((n, p) => n + cents(p.creditedEur), 0);
    if (valued) {
      const gainCents = finalCents - (cents(d.receipt!.amountEur) - partials.reduce((n, p) => n + portionCents(p), 0));
      out.push({
        event: "crypto_disposal",
        key: `deposit:${d.id}:disposal`,
        bookingAt: convertedAt,
        valueAt: convertedAt,
        amountCents: gainCents,
        counterparty: { name: d.provider ? `Conversion via ${d.provider}` : "Conversion USDC to EURe" },
        reference,
        links: conversionLinks,
        // A loss is its own type so the default rules book it as an expense.
        txType: gainCents >= 0 ? "realised_gain" : "realised_loss",
        tags: ["usdc", "disposal"],
        note: partials.length
          ? `Disposal of the remaining ${finalUsdc} USDC (book value €${((finalCents - gainCents) / 100).toFixed(2)} of the receipt) ` +
            `for €${(finalCents / 100).toFixed(2)} EURe${via ? ` ${via}` : ""}; realised €${(gainCents / 100).toFixed(2)}.`
          : `Disposal of ${d.amountUsdc ?? 0} USDC (book value €${d.receipt!.amountEur.toFixed(2)} at receipt) ` +
            `for €${d.creditedEur!.toFixed(2)} EURe${via ? ` ${via}` : ""}; realised €${(gainCents / 100).toFixed(2)}.`,
        unexecuted: !inp.swapsHaveExecuted,
      });
      continue;
    }
    out.push({
      event: "crypto_converted",
      key: `deposit:${d.id}:converted`,
      bookingAt: receivedAt,
      valueAt: convertedAt,
      amountCents: finalCents,
      counterparty,
      reference,
      links: { ...conversionLinks, txHashes: [d.txHash, ...conversionLinks.txHashes] },
      txType: "invoice_payment",
      tags: ["usdc", "converted"],
      note: `${d.amountUsdc ?? 0} USDC received on a day with no ECB reference rate; booked at the measured conversion proceeds${via ? ` ${via}` : ""}.`,
      unexecuted: !inp.swapsHaveExecuted,
    });
  }
  return out;
}

// ── The monthly sweep ────────────────────────────────────────────────────────

/**
 * A crypto send the chain confirmed: the money left the Safe. EURe at face
 * value; USDC at the mid it was checked against when sent. A USDC send
 * is a disposal of held dollars, and its gain or loss against the receipt
 * value is not computed here; the note says so.
 */
function cryptoOutLines(inp: StatementInputs): LineDraft[] {
  return (inp.cryptoSends ?? [])
    // SENT only: lines are never deleted, and a SUBMITTED send may still fail.
    .filter((c) => c.userId === inp.userId && c.state === "SENT")
    .map((c) => ({
      event: "crypto_out" as const,
      key: `cryptosend:${c.id}`,
      bookingAt: c.createdAt,
      valueAt: c.authorizedAt ?? c.updatedAt,
      amountCents: -cents(c.capEur),
      counterparty: { ...(c.name ? { name: c.name } : {}), address: c.to },
      reference: c.name ?? `To ${c.to.slice(0, 10)}`,
      links: { txHashes: c.txHash ? [c.txHash] : [], ...(c.userOpHash ? { userOpHash: c.userOpHash } : {}) },
      txType: "payout",
      tags: [c.token === "USDC" ? "usdc" : "eure", "crypto_out"],
      ...(c.token === "USDC"
        ? { note: `${c.amount} USDC sent, valued at the mid when sent (€${c.capEur.toFixed(2)}). The disposal gain or loss against its receipt value is not computed.` }
        : {}),
    }));
}

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
  const drafts = [...sepaInLines(inp), ...sepaOutLines(inp), ...cryptoLines(inp), ...eureInLines(inp), ...sweepLines(inp), ...cryptoOutLines(inp)];
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
 * A deposit whose conversion was booked as one `:converted` line (the payment
 * at its conversion proceeds) must not also get a receipt and a disposal
 * line: that would count the income twice. Lines are never deleted, so the
 * existing one stands and the pair is not added.
 */
function bookedAsOneLine(byKey: Map<string, LedgerEntry>, key: string): boolean {
  const m = /^deposit:(.+?):(held|disposal(?::p\d+)?)$/.exec(key);
  return !!m && byKey.has(`deposit:${m[1]}:converted`);
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
      if (bookedAsOneLine(byKey, p.statement!.key)) continue;
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
