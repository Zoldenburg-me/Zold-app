/**
 * The Beleg: one document per statement line, frozen when issued and
 * re-verified on every visit, holding every fact behind the one euro figure
 * on the line. For a USDC-paid invoice that is the invoice and payer, what
 * arrived and when the chain says so (the receipt date matters for
 * Ist-Versteuerung), the ECB rate it was valued at, the conversion's chain
 * transaction, venue, rate, amount in and EURe credited, the receivable
 * difference and the gain or loss, and the gas and who paid it.
 *
 * Same pattern as the account documents (documents.ts): a snapshot under a
 * verification code, signed by the document key. The verifier additionally
 * checks that the records the snapshot was built from still say the same,
 * so a Beleg cannot quietly outlive a corrected deposit.
 *
 * Rule 2: every conversion figure carries `unexecuted` until a swap has moved
 * real money, and the document says so in words.
 */
import { CHAIN_ID } from "../config.js";
import type { LedgerEntry, StatementFacts } from "../domain/types.js";
import type { HolderBlock } from "../documents.js";
import type { ConversionSweep, CryptoDeposit, MoneriumIssueRecord, Transfer } from "../store/types.js";
import type { PaymentRequest } from "../payment-requests.js";
import { usd } from "../chain.js";
import type { PdfLine } from "./pdf.js";
import { textPdf } from "./pdf.js";

export interface BelegSnapshot {
  kind: "beleg";
  holder: HolderBlock;
  /** The statement line as booked. */
  line: StatementFacts & { lineId: string; accountCode?: string };
  /** The invoice, when the line settles one. */
  invoice?: { number: string; payer?: string; invoiceId?: string; source: "zold" | "external" };
  /** SEPA facts, on a bank line. */
  bank?: {
    orderId?: string;
    counterpartyName?: string;
    counterpartyIban?: string;
    memo?: string;
    processedAt?: string;
    transferId?: string;
    feeEur?: number;
    refund?: { amountEur: number; at: string; deductions: string };
  };
  /** The receipt, on a crypto line. */
  receipt?: {
    asset: "USDC";
    amount: number;
    txHash: string;
    logIndex: number;
    blockTime?: string;
    from?: string;
    valueEur?: number;
    rate?: number;
    rateProvider?: string;
    /** The ECB fixing day the rate is for — a business day, not the block's minute. */
    rateAsOf?: string;
    ratedAt?: string;
  };
  /** The conversion, when the asset was disposed of. */
  conversion?: {
    txHash?: string;
    userOpHash?: string;
    blockNumber?: number;
    at?: string;
    venue?: string;
    rate?: number;
    midRate?: number;
    amountInUsdc?: number;
    creditedEur?: number;
    venueFeeUsdc?: number;
    leftoverUsdc?: number;
    /** Credited minus the invoice or quoted amount: what the receivable is
     *  short or over by. Absent when there is no receivable to compare to. */
    receivableDifferenceEur?: number;
    /** Credited minus the value at receipt. */
    gainEur?: number;
  };
  gas?: { costWei?: string; paidBy?: "sponsored" | "safe-native" | "safe-token" };
  sweep?: { month: string; depositIds: string[]; amountInUsdc: number };
  chainId: number;
  /** Rule 2, in words. */
  unexecutedNote?: string;
}

export interface BelegContext {
  holder: HolderBlock;
  deposit?: CryptoDeposit;
  transfer?: Transfer;
  issueOrder?: MoneriumIssueRecord;
  sweep?: ConversionSweep;
  paymentRequest?: PaymentRequest;
  invoicePayerName?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export const UNEXECUTED_NOTE =
  "No conversion has yet executed with real money on this deployment. The conversion figures on this " +
  "document come from a path that has not moved real funds; they are recorded, not proven.";

export function buildBeleg(entry: LedgerEntry, ctx: BelegContext): BelegSnapshot {
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  const snap: BelegSnapshot = {
    kind: "beleg",
    holder: ctx.holder,
    line: { ...s, lineId: entry.id, ...(entry.accountCode ? { accountCode: entry.accountCode } : {}) },
    chainId: CHAIN_ID,
  };
  const req = ctx.paymentRequest;
  if (s.links.invoiceNumber) {
    snap.invoice = {
      number: s.links.invoiceNumber,
      ...(ctx.invoicePayerName ?? req?.source.orderName ? { payer: ctx.invoicePayerName ?? `Order ${req!.source.orderName}` } : {}),
      ...(s.links.invoiceId ? { invoiceId: s.links.invoiceId } : {}),
      source: s.links.invoiceId ? "zold" : "external",
    };
  }
  const o = ctx.issueOrder;
  const t = ctx.transfer;
  if (o || t) {
    snap.bank = {
      ...(o ? { orderId: o.orderId, counterpartyName: o.counterpartyName, counterpartyIban: o.counterpartyIban, memo: o.memo, processedAt: o.processedAt } : {}),
      ...(t
        ? {
            transferId: t.id,
            orderId: t.sepa?.orderId ?? o?.orderId,
            counterpartyName: t.recipientName,
            counterpartyIban: t.recipientIban,
            memo: t.moneriumRedeem?.memo ?? t.reference,
            ...(t.receiveEur !== undefined && r2(t.sendEur - t.receiveEur) > 0 ? { feeEur: r2(t.sendEur - t.receiveEur) } : {}),
            ...(t.refund ? { refund: { amountEur: t.refund.amountEur, at: t.refund.at, deductions: t.refund.deductions } } : {}),
          }
        : {}),
    };
  }
  const d = ctx.deposit;
  if (d && d.token === "USDC") {
    snap.receipt = {
      asset: "USDC",
      amount: d.amountUsdc ?? usd.fromUnits(BigInt(d.amountUnits)),
      txHash: d.txHash,
      logIndex: d.logIndex,
      ...(d.receipt?.blockTimestamp ? { blockTime: d.receipt.blockTimestamp } : {}),
      ...(d.from ? { from: d.from } : {}),
      ...(d.receipt
        ? { valueEur: d.receipt.amountEur, rate: d.receipt.rate, rateProvider: d.receipt.rateProvider, rateAsOf: d.receipt.rateAsOf, ratedAt: d.receipt.ratedAt }
        : {}),
    };
    if (d.settlementAsset === "EURE" && d.creditedEur !== undefined) {
      const amountIn = d.conversion?.amountInUnits ? usd.fromUnits(BigInt(d.conversion.amountInUnits)) : d.amountUsdc;
      const expected = req?.amountEur ?? (req?.payments.find((p) => p.depositId === d.id)?.amountEur);
      snap.conversion = {
        ...(d.conversion?.txHash ? { txHash: d.conversion.txHash } : {}),
        ...(d.conversion?.userOpHash ? { userOpHash: d.conversion.userOpHash } : {}),
        ...(d.conversion?.blockNumber !== undefined ? { blockNumber: d.conversion.blockNumber } : {}),
        ...(d.conversion?.at ? { at: d.conversion.at } : {}),
        ...(d.provider ? { venue: d.provider } : {}),
        ...(d.rate ? { rate: d.rate } : {}),
        ...(d.midRate ? { midRate: d.midRate } : {}),
        ...(amountIn !== undefined ? { amountInUsdc: amountIn } : {}),
        creditedEur: d.creditedEur,
        ...(d.conversion?.venueFeeUnits ? { venueFeeUsdc: usd.fromUnits(BigInt(d.conversion.venueFeeUnits)) } : {}),
        ...(d.leftoverUnits ? { leftoverUsdc: usd.fromUnits(BigInt(d.leftoverUnits)) } : {}),
        ...(expected !== undefined ? { receivableDifferenceEur: r2(d.creditedEur - expected) } : {}),
        ...(d.realisedGainEur !== undefined ? { gainEur: d.realisedGainEur } : {}),
      };
      snap.gas = { ...(d.conversion?.gasCostWei ? { costWei: d.conversion.gasCostWei } : {}), ...(d.conversion?.gasPaidBy ? { paidBy: d.conversion.gasPaidBy } : {}) };
    }
  }
  const sw = ctx.sweep;
  if (sw) {
    snap.sweep = { month: sw.month, depositIds: sw.depositIds, amountInUsdc: usd.fromUnits(BigInt(sw.amountInUnits)) };
    snap.conversion = {
      ...(sw.conversion?.txHash ? { txHash: sw.conversion.txHash } : {}),
      ...(sw.conversion?.userOpHash ? { userOpHash: sw.conversion.userOpHash } : {}),
      ...(sw.conversion?.at ? { at: sw.conversion.at } : {}),
      ...(sw.provider ? { venue: sw.provider } : {}),
      ...(sw.rate ? { rate: sw.rate } : {}),
      ...(sw.midRate ? { midRate: sw.midRate } : {}),
      amountInUsdc: usd.fromUnits(BigInt(sw.amountInUnits)),
      creditedEur: sw.creditedEur,
    };
    snap.gas = { ...(sw.conversion?.gasCostWei ? { costWei: sw.conversion.gasCostWei } : {}), ...(sw.conversion?.gasPaidBy ? { paidBy: sw.conversion.gasPaidBy } : {}) };
  }
  if (s.unexecuted) snap.unexecutedNote = UNEXECUTED_NOTE;
  return snap;
}

/**
 * Does the store still say what the snapshot says? Compared on the figures
 * that decide the booking; a corrected deposit or a transfer that moved on
 * makes the document fail verification rather than vanish.
 */
export function belegStillAgrees(
  snap: BelegSnapshot,
  ctx: { entry?: LedgerEntry; deposit?: CryptoDeposit; transfer?: Transfer; issueOrder?: MoneriumIssueRecord; sweep?: ConversionSweep },
): { ok: boolean; detail: string } {
  const diffs: string[] = [];
  if (!ctx.entry) diffs.push("the statement line no longer exists");
  else if (ctx.entry.statement?.amountCents !== snap.line.amountCents) diffs.push(`the line now reads ${(ctx.entry.statement!.amountCents / 100).toFixed(2)}`);
  if (snap.receipt) {
    if (!ctx.deposit) diffs.push("the deposit record is gone");
    else {
      if (ctx.deposit.txHash.toLowerCase() !== snap.receipt.txHash.toLowerCase()) diffs.push("the receipt transaction differs");
      if (snap.conversion?.creditedEur !== undefined && ctx.deposit.creditedEur !== snap.conversion.creditedEur) diffs.push("the credited amount differs");
      if (ctx.deposit.state !== "CONVERTED") diffs.push(`the deposit is now ${ctx.deposit.state}`);
    }
  }
  if (snap.bank?.transferId) {
    if (!ctx.transfer) diffs.push("the transfer record is gone");
    else if (snap.line.event === "sepa_out" && !["PAID", "PAYOUT_SUBMITTED", "REFUNDED"].includes(ctx.transfer.state)) diffs.push(`the transfer is now ${ctx.transfer.state}`);
  }
  if (snap.bank?.orderId && !snap.bank.transferId) {
    if (!ctx.issueOrder) diffs.push("the Monerium order record is gone");
    else if (ctx.issueOrder.amountEur !== Math.abs(snap.line.amountCents) / 100) diffs.push("the order amount differs");
  }
  if (snap.sweep && !ctx.sweep) diffs.push("the sweep record is gone");
  return diffs.length ? { ok: false, detail: diffs.join("; ") } : { ok: true, detail: "the underlying records still say the same" };
}

const eur = (n: number | undefined) => (n === undefined ? "—" : `${n < 0 ? "-" : ""}€${Math.abs(n).toFixed(2)}`);
const when = (iso?: string) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—");
const EVENT_TITLES: Record<StatementFacts["event"], string> = {
  sepa_in: "SEPA credit received",
  sepa_out: "SEPA payment sent",
  sepa_out_reversal: "Reversal of a failed payment",
  crypto_converted: "USDC received and converted to EURe",
  crypto_held: "USDC received and held",
  sweep: "Monthly conversion of leftover USDC",
};

export const belegTitle = (s: BelegSnapshot) => EVENT_TITLES[s.line.event];

/** The document as lines of text — what the PDF and the tests read. */
export function belegLines(snap: BelegSnapshot, code: string, issuedAt: string): PdfLine[] {
  const L: PdfLine[] = [];
  const kv = (k: string, v: string | undefined, indent = 12) => {
    if (v !== undefined && v !== "" && v !== "—") L.push({ text: `${k}: ${v}`, indent });
  };
  L.push({ text: "Zold — Beleg", size: 16, bold: true });
  L.push({ text: belegTitle(snap), size: 12, bold: true, gap: 4 });
  L.push({ text: `Verification ${code} · issued ${when(issuedAt)} · verify at /v/${code}`, size: 8.5 });
  L.push({ text: "Account", bold: true, gap: 10 });
  kv("Holder", snap.holder.name);
  kv("IBAN", snap.holder.iban);
  kv("Account of record", `${snap.holder.safeAddress} (chain ${snap.chainId})`);
  L.push({ text: "Statement line", bold: true, gap: 10 });
  kv("Amount", eur(snap.line.amountCents / 100));
  kv("Booking date", snap.line.bookingDate);
  kv("Value date", snap.line.valueDate);
  kv("Counterparty", [snap.line.counterparty.name, snap.line.counterparty.iban, snap.line.counterparty.address].filter(Boolean).join(" · ") || undefined);
  kv("Reference", snap.line.reference);
  kv("Account code", snap.line.accountCode);
  kv("Line key", snap.line.key);
  if (snap.invoice) {
    L.push({ text: "Invoice", bold: true, gap: 10 });
    kv("Number", `${snap.invoice.number}${snap.invoice.source === "external" ? " (issued outside Zold)" : ""}`);
    kv("Payer", snap.invoice.payer);
  }
  if (snap.bank) {
    L.push({ text: "Bank", bold: true, gap: 10 });
    kv("Monerium order", snap.bank.orderId);
    kv("Counterparty", snap.bank.counterpartyName);
    kv("Counterparty IBAN", snap.bank.counterpartyIban);
    kv("Memo", snap.bank.memo);
    kv("Processed", when(snap.bank.processedAt));
    kv("Transfer", snap.bank.transferId);
    kv("Zold fee", snap.bank.feeEur !== undefined ? eur(snap.bank.feeEur) : undefined);
    if (snap.bank.refund) kv("Refund", `${eur(snap.bank.refund.amountEur)} at ${when(snap.bank.refund.at)} — ${snap.bank.refund.deductions}`);
  }
  if (snap.receipt) {
    L.push({ text: "Receipt (crypto)", bold: true, gap: 10 });
    kv("Received", `${snap.receipt.amount} ${snap.receipt.asset}`);
    kv("Transaction", `${snap.receipt.txHash} (log ${snap.receipt.logIndex})`);
    kv("Block time", when(snap.receipt.blockTime));
    kv("From", snap.receipt.from);
    if (snap.receipt.valueEur !== undefined) {
      kv("Value at receipt", `${eur(snap.receipt.valueEur)} at ${snap.receipt.rate} USD/EUR`);
      kv("Rate source", `${snap.receipt.rateProvider}, ECB reference rate for ${snap.receipt.rateAsOf} (fixed once per business day; not an intraday rate)`);
    } else {
      kv("Value at receipt", "not valued — no reference rate was available");
    }
  }
  if (snap.conversion) {
    L.push({ text: snap.sweep ? "Sweep conversion" : "Conversion", bold: true, gap: 10 });
    if (snap.sweep) kv("Leftovers from", `${snap.sweep.depositIds.length} conversion(s) in ${snap.sweep.month}`);
    kv("Transaction", snap.conversion.txHash);
    kv("UserOperation", snap.conversion.userOpHash);
    kv("Block", snap.conversion.blockNumber !== undefined ? String(snap.conversion.blockNumber) : undefined);
    kv("Time", when(snap.conversion.at));
    kv("Venue", snap.conversion.venue);
    kv("Rate", snap.conversion.rate !== undefined ? `${snap.conversion.rate} USD/EUR${snap.conversion.midRate ? ` (independent mid ${snap.conversion.midRate})` : ""}` : undefined);
    kv("Amount in", snap.conversion.amountInUsdc !== undefined ? `${snap.conversion.amountInUsdc} USDC` : undefined);
    kv("Venue fee", snap.conversion.venueFeeUsdc !== undefined ? `${snap.conversion.venueFeeUsdc} USDC` : undefined);
    kv("EURe credited", eur(snap.conversion.creditedEur));
    kv("Left in the account", snap.conversion.leftoverUsdc !== undefined ? `${snap.conversion.leftoverUsdc} USDC (swept monthly)` : undefined);
    kv("Receivable difference", snap.conversion.receivableDifferenceEur !== undefined ? eur(snap.conversion.receivableDifferenceEur) : undefined);
    kv("Gain / loss on conversion", snap.conversion.gainEur !== undefined ? eur(snap.conversion.gainEur) : undefined);
  }
  if (snap.gas && (snap.gas.costWei || snap.gas.paidBy)) {
    L.push({ text: "Gas", bold: true, gap: 10 });
    kv("Cost", snap.gas.costWei ? `${snap.gas.costWei} wei` : undefined);
    kv("Paid by", snap.gas.paidBy === "sponsored" ? "the paymaster (sponsored)" : snap.gas.paidBy === "safe-native" ? "the account, in ETH" : snap.gas.paidBy === "safe-token" ? "the account, in the gas token (USDC)" : undefined);
  }
  L.push({ text: "Records", bold: true, gap: 10 });
  kv("Transfer id", snap.line.links.transferId);
  kv("Deposit id", snap.line.links.depositId);
  kv("Order id", snap.line.links.orderId);
  kv("Payment link", snap.line.links.paymentRequestId);
  for (const h of snap.line.links.txHashes) kv("Transaction", h);
  if (snap.unexecutedNote) L.push({ text: snap.unexecutedNote, size: 9, gap: 10 });
  L.push({
    text:
      "Euros on this account are e-money (EURe) issued by Monerium ehf.; the IBAN and SEPA payments are provided by AS LHV Pank. Zold is software and holds no licence of its own.",
    size: 8,
    gap: 12,
  });
  return L;
}

export function belegPdf(snap: BelegSnapshot, code: string, issuedAt: string): Buffer {
  return textPdf(belegLines(snap, code, issuedAt), {
    title: `Beleg ${code} — ${belegTitle(snap)}`,
    author: "Zold",
    subject: snap.line.reference,
  });
}

/** A file name that maps the document to its line in the CSV. */
export function belegFileName(snap: BelegSnapshot, code: string): string {
  const ref = snap.line.reference.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `${snap.line.valueDate}_${code}${ref ? `_${ref}` : ""}.pdf`;
}
