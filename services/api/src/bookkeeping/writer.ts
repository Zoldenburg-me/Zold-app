/**
 * The ledger writer: projects the account's real activity into statement
 * lines and writes them, once each.
 *
 * Attached where money changes state — a Monerium issue order mirrored, a
 * deposit settled, a transfer PAID or REFUNDED, a sweep recorded — and also
 * run on an interval, so a crash between the event and the write costs
 * nothing: the projection is over the store, and the store is what survived.
 *
 * Which organisation a line belongs to: the one whose EUR account is backed
 * by the user's Safe. A user with no such account produces no lines (and a
 * log line saying so once), rather than lines under an account that does
 * not exist.
 *
 * Rules run on insert. A human's account code is never overwritten: the
 * merge (statement.ts) refreshes facts only, and applyRules skips rows whose
 * code a human set.
 */
import { IS_REAL_MONEY_CHAIN } from "../config.js";
import { applyRules } from "../domain/coa.js";
import type { AccountRule, Invoice, LedgerEntry } from "../domain/types.js";
import {
  store,
  type ConversionSweep,
  type CryptoDeposit,
  type MoneriumIssueRecord,
  type PaymentRequest,
  type Transfer,
  type User,
} from "../store.js";
import { safeBooksStart } from "../domain/safe-books.js";
import type { MoneriumOrderLike } from "../documents.js";
import { mergeStatementLines, projectStatementLines, type StatementInputs } from "./statement.js";

/**
 * Rule 2. No dex, LI.FI, RFQ or CoW swap has executed with real money, so a
 * conversion figure is from an unexecuted path until one has. Read from the
 * store, not asserted: a converted deposit on a real-money chain with a
 * chain transaction hash is the evidence, and nothing else is.
 */
export function swapsHaveExecuted(): boolean {
  if (!IS_REAL_MONEY_CHAIN) return false;
  return store.cryptoDeposits.some(
    (d) => d.state === "CONVERTED" && d.settlementAsset === "EURE" && /^0x[0-9a-fA-F]{64}$/.test(d.conversion?.txHash ?? ""),
  );
}

/**
 * The org and EUR account a user's movements are booked under, if any, and
 * from when.
 *
 * A Safe belongs to one organisation's books. Connected to a company's
 * account, that is the company's, from the day its books start
 * (`backedSince`, domain/safe-books.ts); otherwise the person's own.
 */
export function booksFor(userId: string): { orgId: string; accountId: string; since?: string } | undefined {
  const backed = store.accounts.filter((a) => a.backingUserId === userId && a.currency === "EUR");
  const account = backed.find((a) => store.findOrganisation(a.orgId)?.type === "business") ?? backed[0];
  if (!account) return undefined;
  const user = store.findUser(userId);
  const since = account.backedSince ?? (user ? safeBooksStart(user) : undefined);
  return { orgId: account.orgId, accountId: account.id, ...(since ? { since } : {}) };
}

const warned = new Set<string>();

/**
 * Where a projection reads its rows from. One user reads them straight from
 * the store. A sweep over every user groups each table once instead: a filter
 * per user made the sweep O(users × rows), and it runs after every Monerium
 * poll and every minute. A group keeps store order, as the filter did.
 */
interface Rows {
  transfersOf(userId: string): Transfer[];
  depositsOf(userId: string): CryptoDeposit[];
  issueOrdersOf(userId: string): MoneriumIssueRecord[];
  sweepsOf(userId: string): ConversionSweep[];
  paymentRequestsOf(userId: string): PaymentRequest[];
  invoicesOf(orgId: string): Invoice[];
  rulesOf(orgId: string): AccountRule[];
  ledgerOf(orgId: string): LedgerEntry[];
  swapsHaveExecuted(): boolean;
  /** Lines just written, so the next user booked under the same org sees them. */
  added(orgId: string, entries: LedgerEntry[]): void;
}

const storeRows: Rows = {
  transfersOf: (id) => store.transfers.filter((t) => t.userId === id),
  depositsOf: (id) => store.cryptoDeposits.filter((d) => d.userId === id),
  issueOrdersOf: (id) => store.moneriumIssueOrders.filter((o) => o.userId === id),
  sweepsOf: (id) => store.conversionSweeps.filter((s) => s.userId === id),
  paymentRequestsOf: (id) => store.paymentRequestsForUser(id),
  invoicesOf: (orgId) => store.invoicesOf(orgId),
  rulesOf: (orgId) => store.rulesOf(orgId),
  ledgerOf: (orgId) => store.ledgerOf(orgId),
  swapsHaveExecuted,
  added: () => {},
};

function groupBy<T>(rows: readonly T[], key: (row: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === undefined) continue;
    const group = out.get(k);
    if (group) group.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Valid for one synchronous sweep: nothing else writes these tables meanwhile. */
function groupedRows(): Rows {
  const transfers = groupBy(store.transfers, (t) => t.userId);
  const deposits = groupBy(store.cryptoDeposits, (d) => d.userId);
  const issueOrders = groupBy(store.moneriumIssueOrders, (o) => o.userId);
  const sweeps = groupBy(store.conversionSweeps, (s) => s.userId);
  const paymentRequests = groupBy(store.paymentRequests, (r) => r.userId);
  const invoices = groupBy(store.invoices, (i) => i.orgId);
  const rules = groupBy(store.accountRules, (r) => r.orgId);
  const ledger = groupBy(store.ledger, (e) => e.orgId);
  const swaps = swapsHaveExecuted();
  return {
    transfersOf: (id) => transfers.get(id) ?? [],
    depositsOf: (id) => deposits.get(id) ?? [],
    issueOrdersOf: (id) => issueOrders.get(id) ?? [],
    sweepsOf: (id) => sweeps.get(id) ?? [],
    paymentRequestsOf: (id) => paymentRequests.get(id) ?? [],
    invoicesOf: (orgId) => invoices.get(orgId) ?? [],
    rulesOf: (orgId) => rules.get(orgId) ?? [],
    ledgerOf: (orgId) => ledger.get(orgId) ?? [],
    swapsHaveExecuted: () => swaps,
    added: (orgId, entries) => {
      const group = ledger.get(orgId);
      if (group) group.push(...entries);
      else ledger.set(orgId, [...entries]);
    },
  };
}

function inputsFor(user: User, rows: Rows): StatementInputs | undefined {
  const books = booksFor(user.id);
  if (!books) {
    if (!warned.has(user.id)) {
      warned.add(user.id);
      console.log(`bookkeeping: ${user.id} has no EUR account backed by their Safe — no statement lines written`);
    }
    return undefined;
  }
  return {
    orgId: books.orgId,
    accountId: books.accountId,
    userId: user.id,
    safeAddress: user.address,
    transfers: rows.transfersOf(user.id),
    deposits: rows.depositsOf(user.id),
    issueOrders: rows.issueOrdersOf(user.id),
    sweeps: rows.sweepsOf(user.id),
    invoices: rows.invoicesOf(books.orgId),
    paymentRequests: rows.paymentRequestsOf(user.id),
    swapsHaveExecuted: rows.swapsHaveExecuted(),
  };
}

/** Project and write one user's lines. Returns what changed. */
export function writeStatementLinesFor(user: User, rows: Rows = storeRows): { added: number; updated: number } {
  const inp = inputsFor(user, rows);
  if (!inp) return { added: 0, updated: 0 };
  const since = booksFor(user.id)?.since;
  // Nothing from before the Safe's books start: an imported Safe's earlier life is not the account's.
  const projected = projectStatementLines(inp).filter((e) => !since || e.at >= since);
  const existing = rows.ledgerOf(inp.orgId);
  const { toAdd, toUpdate } = mergeStatementLines(existing, projected);
  if (toAdd.length) {
    const { entries } = applyRules(rows.rulesOf(inp.orgId), toAdd);
    store.addLedgerEntries(entries);
    rows.added(inp.orgId, entries);
  }
  for (const u of toUpdate) store.updateLedgerEntry(u.id, u.patch);
  return { added: toAdd.length, updated: toUpdate.length };
}

let running = false;

/** Every user, one at a time, landing as one file write at the end. */
export function writeStatementLines(): { added: number; updated: number } {
  if (running) return { added: 0, updated: 0 };
  running = true;
  try {
    let added = 0;
    let updated = 0;
    // One file write per sweep: a write per user re-serialised the whole store
    // once for every user with a new line. The sweep is synchronous, and
    // batched() writes on the way out even if a user's projection throws.
    store.batched(() => {
      const rows = groupedRows();
      for (const u of store.users) {
        try {
          const r = writeStatementLinesFor(u, rows);
          added += r.added;
          updated += r.updated;
        } catch (err: any) {
          console.error(`bookkeeping: could not write statement lines for ${u.id}: ${err?.message ?? err}`);
        }
      }
    });
    if (added || updated) console.log(`bookkeeping: ${added} statement line(s) added, ${updated} refreshed`);
    return { added, updated };
  } finally {
    running = false;
  }
}

/**
 * Keep the bank facts of a processed issue order. Called for every processed
 * issue order the poller sees on our chain, so an order mirrored before this
 * table existed still gets its line on the next poll. Idempotent on the id.
 */
export function noteMoneriumIssue(order: MoneriumOrderLike, user: User): MoneriumIssueRecord | undefined {
  const amountEur = Number(order.amount);
  if (!(amountEur > 0)) return undefined;
  const d = order.counterpart?.details ?? {};
  const name = d.name || d.companyName || [d.firstName, d.lastName].filter(Boolean).join(" ") || undefined;
  const processedAt = order.meta?.processedAt ?? order.meta?.placedAt ?? order.placedAt ?? order.createdAt ?? new Date().toISOString();
  return store.recordMoneriumIssue({
    orderId: order.id,
    userId: user.id,
    amountEur,
    ...(name ? { counterpartyName: name } : {}),
    ...(order.counterpart?.identifier?.iban ? { counterpartyIban: order.counterpart.identifier.iban } : {}),
    ...(order.memo ? { memo: order.memo } : {}),
    processedAt: String(processedAt),
    recordedAt: new Date().toISOString(),
  });
}

/** The lines of one org, newest first, with the entry shape the routes serve. */
export function statementLinesOf(orgId: string): LedgerEntry[] {
  return store.ledgerOf(orgId).filter((e) => e.statement);
}
