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
import type { LedgerEntry } from "../domain/types.js";
import { store, type MoneriumIssueRecord, type User } from "../store.js";
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

/** The org and EUR account a user's movements are booked under, if any. */
export function booksFor(userId: string): { orgId: string; accountId: string } | undefined {
  const account = store.accounts.find((a) => a.backingUserId === userId && a.currency === "EUR");
  if (account) return { orgId: account.orgId, accountId: account.id };
  return undefined;
}

const warned = new Set<string>();

function inputsFor(user: User): StatementInputs | undefined {
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
    transfers: store.transfers.filter((t) => t.userId === user.id),
    deposits: store.cryptoDeposits.filter((d) => d.userId === user.id),
    issueOrders: store.moneriumIssueOrders.filter((o) => o.userId === user.id),
    sweeps: store.conversionSweeps.filter((s) => s.userId === user.id),
    invoices: store.invoicesOf(books.orgId),
    paymentRequests: store.paymentRequestsForUser(user.id),
    swapsHaveExecuted: swapsHaveExecuted(),
  };
}

/** Project and write one user's lines. Returns what changed. */
export function writeStatementLinesFor(user: User): { added: number; updated: number } {
  const inp = inputsFor(user);
  if (!inp) return { added: 0, updated: 0 };
  const projected = projectStatementLines(inp);
  const existing = store.ledgerOf(inp.orgId);
  const { toAdd, toUpdate } = mergeStatementLines(existing, projected);
  if (toAdd.length) {
    const { entries } = applyRules(store.rulesOf(inp.orgId), toAdd);
    store.addLedgerEntries(entries);
  }
  for (const u of toUpdate) store.updateLedgerEntry(u.id, u.patch);
  return { added: toAdd.length, updated: toUpdate.length };
}

let running = false;

/** Every user. Cheap on the JSON store; one at a time. */
export function writeStatementLines(): { added: number; updated: number } {
  if (running) return { added: 0, updated: 0 };
  running = true;
  try {
    let added = 0;
    let updated = 0;
    for (const u of store.users) {
      try {
        const r = writeStatementLinesFor(u);
        added += r.added;
        updated += r.updated;
      } catch (err: any) {
        console.error(`bookkeeping: could not write statement lines for ${u.id}: ${err?.message ?? err}`);
      }
    }
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
