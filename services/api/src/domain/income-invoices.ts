/**
 * Draft invoices made from wallet receipts.
 *
 * A payer that decides its own amounts (a DAO paying a delegate) cannot be
 * invoiced up front, so the invoice follows the money: per contact with a
 * payer rule and per calendar month, one draft with one line per receipt at
 * the EUR value the ledger row recorded on arrival, settled against those
 * rows. The total is the sum of the receipts, so nothing is left over between
 * what was billed and what was paid.
 *
 * Pure: `planIncomeDrafts` reads rows and returns the drafts to write and an
 * account of every receipt it did not put on one. Every inbound wallet row of
 * the month ends in exactly one place: on a draft line; in that draft's
 * `excluded` list with the reason; counted under `withoutRule` or
 * `withoutContact` (valued, or `unvalued`); or counted under
 * `alreadyInvoiced` or `onOtherDrafts` because another invoice holds it.
 */
import { createHash } from "node:crypto";
import { fromCents } from "./invoicing.js";
import { contactFor } from "./wallet-transfers.js";
import type {
  Contact,
  ExcludedReceipt,
  Invoice,
  InvoiceLine,
  LedgerEntry,
  PayerRule,
  WalletReceiptSettlement,
} from "./types.js";

export class IncomeInvoiceError extends Error {}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `fiatValue` as wallet sync writes it: euros with at most two decimals. */
const EUR_VALUE_RE = /^(\d+)(?:\.(\d{1,2}))?$/;
/** What one invoice can carry (the issue path refuses more). */
export const MAX_RECEIPT_LINES = 200;
/** How far the net total may be moved to make net plus VAT meet the receipts. */
const NET_SEARCH_CENTS = 2;

/** One formatter per time zone: building one per ledger row is what makes a
 *  large ledger slow. */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  const known = zoneFormats.get(timeZone);
  if (known) return known;
  try {
    const made = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    zoneFormats.set(timeZone, made);
    return made;
  } catch {
    throw new IncomeInvoiceError(
      `"${timeZone}" is not a time zone. Set the organisation's reporting time zone (for example Europe/Berlin) first.`,
    );
  }
}

function zonedParts(at: string, timeZone: string): { year: string; month: string; day: string } {
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) throw new IncomeInvoiceError(`"${at}" is not a time.`);
  const parts = zoneFormat(timeZone).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** The calendar month an instant falls in, in the organisation's time zone. */
export function monthOf(at: string, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${p.month}`;
}

/** The calendar day an instant falls on, in the organisation's time zone. */
export function dayOf(at: string, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Refuses anything but a calendar month that has begun in that time zone.
 *  The running month may be collected: its draft takes later receipts on each
 *  run for as long as it is a draft. */
export function assertCollectableMonth(month: unknown, timeZone: string, now: string): asserts month is string {
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    throw new IncomeInvoiceError("month must be a calendar month, written YYYY-MM.");
  }
  if (month > monthOf(now, timeZone)) {
    throw new IncomeInvoiceError(`${month} has not begun yet, so nothing has been received in it.`);
  }
}

/** First and last day of a month, for the supply period. */
export function monthPeriod(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

export const receiptRef = (ledgerEntryId: string): string => `ledger:${ledgerEntryId}`;

/**
 * The draft's id. `sequence` counts the invoices already made for this payer
 * and month that are no longer drafts (issued or discarded), so a receipt
 * that arrives after the month was invoiced gets a further draft with an id
 * of its own, and two runs at the same state name the same one.
 */
export function incomeInvoiceId(orgId: string, contactId: string, month: string, sequence: number): string {
  const digest = createHash("sha256").update([orgId, contactId, month, String(sequence)].join("\n")).digest("hex");
  return `inv_rcpt_${digest.slice(0, 32)}`;
}

function eurCentsOf(fiatValue: string | undefined): number | undefined {
  const m = EUR_VALUE_RE.exec(fiatValue ?? "");
  if (!m) return undefined;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined;
}

export type ReceiptVerdict =
  | { kind: "not-a-receipt" }
  | { kind: "excluded"; reason: string }
  | { kind: "eligible"; eurCents: number; txHash: string };

/**
 * Whether a ledger row is a receipt an invoice line can be written for.
 *
 * A line needs a value: a row with none, or one whose value is not a euro
 * amount, is excluded with the reason. The transaction type is read beside
 * the tags because tags can be edited by hand.
 */
export function classifyReceipt(entry: LedgerEntry): ReceiptVerdict {
  if (entry.source.kind !== "wallet" || entry.direction !== "in") return { kind: "not-a-receipt" };
  const tagged = (tag: string) => entry.tags.includes(tag);
  if (tagged("internal") || entry.txType === "internal_transfer") {
    return { kind: "excluded", reason: "A transfer between your own addresses is not income." };
  }
  if (tagged("unlisted") || entry.txType === "unlisted_token") {
    return { kind: "excluded", reason: "The token is on no token list, so it has no value to invoice." };
  }
  if (tagged("needs-valuation") || entry.fiatValue === undefined) {
    return { kind: "excluded", reason: "The receipt has no EUR value yet." };
  }
  if (entry.fiatCurrency !== "EUR") {
    return { kind: "excluded", reason: `The receipt is valued in ${entry.fiatCurrency ?? "no currency"}, not EUR.` };
  }
  const eurCents = eurCentsOf(entry.fiatValue);
  if (eurCents === undefined) {
    return { kind: "excluded", reason: `The receipt's EUR value "${entry.fiatValue}" is not a positive amount.` };
  }
  if (!entry.txHash) return { kind: "excluded", reason: "The receipt names no transaction." };
  return { kind: "eligible", eurCents, txHash: entry.txHash };
}

/**
 * Who paid. The contact wallet sync named wins while it still lists the
 * sending address; otherwise, and for a row synced before its sender was in
 * the address book, the same rule is applied now: exactly one contact lists
 * the address on that chain, or nobody is named.
 */
export function payerOf(entry: LedgerEntry, contacts: Contact[]): Contact | undefined {
  const address = entry.counterparty?.address?.toLowerCase();
  if (!address || entry.chainId === undefined) return undefined;
  const { chainId } = entry;
  const named = entry.counterparty?.contactId;
  const known = named ? contacts.find((c) => c.id === named) : undefined;
  // Only while that contact still lists the address: one moved to another
  // contact since must not stay billed to the first.
  const stillLists = known?.wallets.some((w) => w.chainId === chainId && w.address.toLowerCase() === address);
  return known && stillLists ? known : contactFor(contacts, chainId, address);
}

/** Net plus VAT as the invoice arithmetic computes it: one rate, rounded once. */
const grossOf = (netCents: number, rate: number) => netCents + Math.round((netCents * rate) / 100);

/**
 * Net amounts for lines whose receipts are the gross.
 *
 * Exempt: net is the receipt. With a rate, each line's net is the receipt
 * less the VAT it contains, and the lines take, a cent at a time from the
 * largest down, the difference to a net total (within `NET_SEARCH_CENTS` of
 * the whole amount's net) whose net plus VAT equals what was received. VAT is rounded once on the total, so some gross amounts have
 * no such net; `mismatchCents` is then what the invoice would differ by.
 */
export function netLinesFor(
  grossCents: number[],
  vat: PayerRule["vat"],
): { netCents: number[]; mismatchCents: number } {
  if (vat.kind === "exempt" || grossCents.length === 0) return { netCents: [...grossCents], mismatchCents: 0 };
  const received = grossCents.reduce((sum, c) => sum + c, 0);
  const nets = grossCents.map((c) => Math.round((c * 100) / (100 + vat.rate)));
  const lineSum = nets.reduce((sum, c) => sum + c, 0);
  // The net total is sought around the net of the whole amount, not around
  // the sum of the lines' own nets: each line rounds on its own, and over
  // many lines that sum drifts further than the search reaches.
  const exact = Math.round((received * 100) / (100 + vat.rate));
  const tries = [0, ...Array.from({ length: NET_SEARCH_CENTS }, (_, i) => [i + 1, -(i + 1)]).flat()].map((d) => exact + d);
  const netTotal = tries.find((total) => total >= 0 && grossOf(total, vat.rate) === received);
  const spread = netTotal === undefined ? undefined : spreadOver(nets, netTotal - lineSum);
  if (!spread) return { netCents: nets, mismatchCents: received - grossOf(lineSum, vat.rate) };
  return { netCents: spread, mismatchCents: 0 };
}

/** Move `difference` cents onto the lines, a cent at a time from the largest
 *  down, never taking a line below zero. Undefined when they cannot take it. */
function spreadOver(nets: number[], difference: number): number[] | undefined {
  const order = nets.map((_, i) => i).sort((a, b) => nets[b] - nets[a]);
  const step = Math.sign(difference);
  const out = [...nets];
  let left = difference;
  while (left !== 0) {
    const takers = order.filter((i) => out[i] + step >= 0).slice(0, Math.abs(left));
    if (!takers.length) return undefined;
    for (const i of takers) out[i] += step;
    left -= step * takers.length;
  }
  return out;
}

/** The month a receipt falls in. A row whose time cannot be read is refused
 *  by id: left out, it would be in no month and on no invoice. */
function receiptMonth(entry: LedgerEntry, timeZone: string): string {
  const instant = new Date(entry.at);
  if (Number.isNaN(instant.getTime())) {
    throw new IncomeInvoiceError(`Ledger row ${entry.id} has no readable time ("${entry.at}"), so it belongs to no month. Nothing was collected.`);
  }
  return monthOf(entry.at, timeZone);
}

interface Receipt {
  entry: LedgerEntry;
  eurCents: number;
  txHash: string;
}

function lineFor(receipt: Receipt, netCents: number, rule: PayerRule, timeZone: string): InvoiceLine {
  const { entry } = receipt;
  const net = fromCents(netCents);
  return {
    description:
      `${rule.serviceDescription}: ${entry.amount} ${entry.asset} received ${dayOf(entry.at, timeZone)}, ` +
      `${fromCents(receipt.eurCents)} EUR at receipt, transaction ${receipt.txHash}`,
    quantity: "1",
    unitPrice: net,
    amount: net,
    receipt: {
      ledgerEntryId: entry.id,
      at: entry.at,
      ...(entry.chainId === undefined ? {} : { chainId: entry.chainId }),
      asset: entry.asset,
      ...(entry.token ? { token: entry.token } : {}),
      amount: entry.amount,
      txHash: receipt.txHash,
      eurCents: receipt.eurCents,
    },
  };
}

function settlementFor(receipt: Receipt): WalletReceiptSettlement {
  const { entry } = receipt;
  return {
    method: "wallet-receipt",
    ref: receiptRef(entry.id),
    ledgerEntryId: entry.id,
    ...(entry.chainId === undefined ? {} : { chainId: entry.chainId }),
    txHash: receipt.txHash,
    asset: entry.asset,
    receivedAmount: entry.amount,
    amountEur: receipt.eurCents / 100,
    at: entry.at,
  };
}

const excludedFor = (entry: LedgerEntry, reason: string): ExcludedReceipt => ({
  ledgerEntryId: entry.id,
  at: entry.at,
  asset: entry.asset,
  amount: entry.amount,
  ...(entry.txHash ? { txHash: entry.txHash } : {}),
  reason,
});

const isDraftFor = (invoice: Invoice, contactId: string, month: string) =>
  invoice.fromReceipts?.contactId === contactId && invoice.fromReceipts.month === month;

export interface IncomePlanInput {
  orgId: string;
  timeZone: string;
  month: string;
  contacts: Contact[];
  ledger: LedgerEntry[];
  invoices: Invoice[];
  now: string;
  memberId: string;
  /** Hash of a link token nobody holds; issuing replaces it. */
  newLinkTokenHash: () => string;
}

export interface ContactOutcome {
  contactId: string;
  name: string;
  /** Absent when the contact had nothing to invoice and has no draft. */
  invoiceId?: string;
  lines: number;
  eurCents: number;
  excluded: ExcludedReceipt[];
  mismatchCents?: number;
}

/** Receipts on no draft: how many could have been invoiced and what they
 *  were worth, and how many could not (no value, unlisted, internal). */
export interface Uninvoiced {
  receipts: number;
  eurCents: number;
  unvalued: number;
}

export interface IncomePlan {
  /** Drafts to add or replace, complete. */
  drafts: Invoice[];
  contacts: ContactOutcome[];
  /** Receipts from contacts that have no payer rule. */
  withoutRule: ({ contactId: string; name: string } & Uninvoiced)[];
  /** Receipts from senders no contact, or more than one, lists. */
  withoutContact: Uninvoiced;
  /** Receipts of the month that an issued invoice already bills. */
  alreadyInvoiced: { receipts: number };
  /** Drafts of the month this run did not rebuild (their contact has no
   *  payer rule any more, or is gone) and the receipts they still hold. */
  onOtherDrafts: { invoiceId: string; contactId: string; receipts: number }[];
}

/**
 * Work out the month's drafts.
 *
 * A row already on an issued invoice, or on a draft this run does not
 * rebuild, is left where it is: a row is invoiced at most once. A draft is
 * rebuilt from the rows as they stand now, so a row that has since gained a
 * value joins it and one that has since been marked internal leaves it.
 * Invoices past DRAFT are never touched.
 */
export function planIncomeDrafts(input: IncomePlanInput): IncomePlan {
  const { orgId, timeZone, month, now } = input;
  const contacts = input.contacts.filter((c) => c.orgId === orgId);
  const invoices = input.invoices.filter((i) => i.orgId === orgId && i.state !== "DELETED");
  const rebuilt = (invoice: Invoice) =>
    invoice.state === "DRAFT" &&
    contacts.some((c) => c.payerRule && isDraftFor(invoice, c.id, month));
  const heldBy = new Map<string, Invoice>(
    invoices
      .filter((i) => !rebuilt(i))
      .flatMap((i) => (i.settlements ?? []).flatMap((s) => (s.method === "wallet-receipt" ? [[s.ledgerEntryId, i] as const] : []))),
  );

  const receipts = new Map<string, Receipt[]>();
  const excluded = new Map<string, ExcludedReceipt[]>();
  const withoutRule = new Map<string, { contactId: string; name: string } & Uninvoiced>();
  const noContact: Uninvoiced = { receipts: 0, eurCents: 0, unvalued: 0 };
  const alreadyInvoiced = { receipts: 0 };
  const onOtherDrafts = new Map<string, { invoiceId: string; contactId: string; receipts: number }>();
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
  /** One more receipt on a count: valued, or one that cannot be invoiced. */
  const counted = (sofar: Uninvoiced, eurCents: number | undefined): Uninvoiced =>
    eurCents === undefined
      ? { ...sofar, unvalued: sofar.unvalued + 1 }
      : { ...sofar, receipts: sofar.receipts + 1, eurCents: sofar.eurCents + eurCents };

  // Only wallet receipts are bucketed by month: a row of another kind with a
  // time this cannot read is not this module's to refuse.
  const monthRows = input.ledger
    .filter((e) => e.orgId === orgId && classifyReceipt(e).kind !== "not-a-receipt" && receiptMonth(e, timeZone) === month)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let unassigned = noContact;
  for (const entry of monthRows) {
    const holder = heldBy.get(entry.id);
    if (holder) {
      if (holder.state !== "DRAFT") alreadyInvoiced.receipts += 1;
      else {
        const sofar = onOtherDrafts.get(holder.id) ?? { invoiceId: holder.id, contactId: holder.fromReceipts?.contactId ?? "", receipts: 0 };
        onOtherDrafts.set(holder.id, { ...sofar, receipts: sofar.receipts + 1 });
      }
      continue;
    }
    const verdict = classifyReceipt(entry);
    if (verdict.kind === "not-a-receipt") continue;
    const payer = payerOf(entry, contacts);
    const eurCents = verdict.kind === "eligible" ? verdict.eurCents : undefined;
    if (!payer) {
      unassigned = counted(unassigned, eurCents);
    } else if (!payer.payerRule) {
      const sofar = withoutRule.get(payer.id) ?? { contactId: payer.id, name: payer.name, receipts: 0, eurCents: 0, unvalued: 0 };
      withoutRule.set(payer.id, { ...sofar, ...counted(sofar, eurCents) });
    } else if (verdict.kind === "excluded") {
      push(excluded, payer.id, excludedFor(entry, verdict.reason));
    } else {
      push(receipts, payer.id, { entry, eurCents: verdict.eurCents, txHash: verdict.txHash });
    }
  }

  const drafts: Invoice[] = [];
  const outcomes: ContactOutcome[] = [];
  for (const contact of contacts) {
    const rule = contact.payerRule;
    if (!rule) continue;
    const all = receipts.get(contact.id) ?? [];
    const mine = all.slice(0, MAX_RECEIPT_LINES);
    // More than one invoice holds: the rest wait for the next draft, which a
    // run makes once this one is issued.
    const left = [
      ...(excluded.get(contact.id) ?? []),
      ...all.slice(MAX_RECEIPT_LINES).map((r) =>
        excludedFor(r.entry, `An invoice holds ${MAX_RECEIPT_LINES} lines. Issue this draft, then collect the month again for this receipt.`),
      ),
    ];
    const existing = invoices.find((i) => i.state === "DRAFT" && isDraftFor(i, contact.id, month));
    const eurCents = mine.reduce((sum, r) => sum + r.eurCents, 0);
    if (!existing && mine.length === 0) {
      if (left.length) outcomes.push({ contactId: contact.id, name: contact.name, lines: 0, eurCents: 0, excluded: left });
      continue;
    }
    const { netCents, mismatchCents } = netLinesFor(mine.map((r) => r.eurCents), rule.vat);
    const sequence = input.invoices.filter(
      (i) => i.orgId === orgId && i.state !== "DRAFT" && isDraftFor(i, contact.id, month),
    ).length;
    const draft: Invoice = {
      id: existing?.id ?? incomeInvoiceId(orgId, contact.id, month, sequence),
      direction: "outgoing",
      orgId,
      linkTokenHash: existing?.linkTokenHash ?? input.newLinkTokenHash(),
      state: "DRAFT",
      lines: mine.map((r, i) => lineFor(r, netCents[i], rule, timeZone)),
      currency: "EUR",
      total: fromCents(eurCents),
      createdByMemberId: existing?.createdByMemberId ?? input.memberId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      settlements: mine.map(settlementFor),
      fromReceipts: {
        contactId: contact.id,
        payerName: contact.name,
        recipientName: rule.recipient.name,
        vat: rule.vat,
        ruleUpdatedAt: rule.updatedAt,
        month,
        timeZone,
        excluded: left,
        ...(mismatchCents ? { mismatchCents } : {}),
        runAt: now,
      },
    };
    drafts.push(draft);
    outcomes.push({
      contactId: contact.id,
      name: contact.name,
      invoiceId: draft.id,
      lines: mine.length,
      eurCents,
      excluded: left,
      ...(mismatchCents ? { mismatchCents } : {}),
    });
  }

  return {
    drafts,
    contacts: outcomes,
    withoutRule: [...withoutRule.values()],
    withoutContact: unassigned,
    alreadyInvoiced,
    onOtherDrafts: [...onOtherDrafts.values()],
  };
}

/** The rows a draft bills and for how much: what must not move between the
 *  run a person looked at and the issue. */
const billed = (invoice: Invoice): Map<string, string> =>
  new Map(
    invoice.lines.flatMap((l) => (l.receipt ? [[l.receipt.ledgerEntryId, `${l.receipt.eurCents}/${l.amount}/${l.description}`] as const] : [])),
  );

/** Ledger rows on which two versions of a draft disagree. */
export function changedReceipts(before: Invoice, after: Invoice | undefined): string[] {
  const a = billed(before);
  const b = after ? billed(after) : new Map<string, string>();
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id)).sort();
}
