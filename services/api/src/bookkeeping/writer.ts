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
  type CryptoSend,
  type MoneriumIssueRecord,
  type PaymentRequest,
  type Transfer,
  type User,
} from "../store.js";
import { safeBooksStart } from "../domain/safe-books.js";
import { moneriumAmountEur } from "../domain/monerium-order.js";
import type { MoneriumOrderLike } from "../documents.js";
import { invoicePayments, mergeStatementLines, projectStatementLines, type InvoicePayments, type StatementInputs } from "./statement.js";
import { describeCause } from "../http/log-cause.js";
import { withoutConversionOutputs } from "../transfers/activity.js";
import type { MoneyInHolder } from "./money-in.js";
import type { Account, CompanyBankPayout } from "../domain/types.js";
import { liveCryptoSend } from "../wallet/org-debit.js";
import { filterSeq, findSeq, mapSeq } from "../seq.js";

/**
 * Rule 2. No dex, LI.FI, RFQ or CoW swap has executed with real money, so a
 * conversion figure is from an unexecuted path until one has. Read from the
 * store, not asserted: a converted deposit on a real-money chain with a
 * chain transaction hash is the evidence, and nothing else is.
 */
export async function swapsHaveExecuted(): Promise<boolean> {
  if (!IS_REAL_MONEY_CHAIN) return false;
  return (await store.list("cryptoDeposits")).some(
    (d) => d.holding === "converted" && /^0x[0-9a-fA-F]{64}$/.test(d.conversion?.txHash ?? ""),
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
export async function booksFor(userId: string): Promise<{ orgId: string; accountId: string; since?: string } | undefined> {
  const backed = (await store.list("accounts")).filter((a) => a.backingUserId === userId && a.currency === "EUR");
  const account = (await findSeq(backed, async (a) => (await store.findOrganisation(a.orgId))?.type === "business")) ?? backed[0];
  if (!account) return undefined;
  const user = await store.findUser(userId);
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
  transfersOf(userId: string): Transfer[] | Promise<Transfer[]>;
  depositsOf(userId: string): CryptoDeposit[] | Promise<CryptoDeposit[]>;
  /** What landed on a company's own Safe, recorded under its account. */
  depositsOfAccount(accountId: string): CryptoDeposit[] | Promise<CryptoDeposit[]>;
  cryptoSendsOf(userId: string): CryptoSend[] | Promise<CryptoSend[]>;
  issueOrdersOf(userId: string): MoneriumIssueRecord[] | Promise<MoneriumIssueRecord[]>;
  issueOrdersOfAccount(accountId: string): MoneriumIssueRecord[] | Promise<MoneriumIssueRecord[]>;
  /** A company's sends from this account's Safe, each in its op's state. */
  cryptoSendsOfAccount(account: Account): CryptoSend[] | Promise<CryptoSend[]>;
  sweepsOf(userId: string): ConversionSweep[] | Promise<ConversionSweep[]>;
  paymentRequestsOf(userId: string): PaymentRequest[] | Promise<PaymentRequest[]>;
  invoicesOf(orgId: string): Invoice[] | Promise<Invoice[]>;
  /** What every org's invoices pay: a mark on a line one of them pays is dropped. */
  invoicePayments(): InvoicePayments | Promise<InvoicePayments>;
  rulesOf(orgId: string): AccountRule[] | Promise<AccountRule[]>;
  ledgerOf(orgId: string): LedgerEntry[] | Promise<LedgerEntry[]>;
  swapsHaveExecuted(): boolean | Promise<boolean>;
  /** Lines just written, so the next user booked under the same org sees them. */
  added(orgId: string, entries: LedgerEntry[]): void;
}

const storeRows: Rows = {
  transfersOf: async (id) => (await store.list("transfers")).filter((t) => t.userId === id),
  depositsOf: async (id) => withoutConversionOutputs((await store.list("cryptoDeposits")).filter((d) => d.userId === id), (await store.list("transfers")).filter((t) => t.userId === id)),
  depositsOfAccount: async (id) => withoutConversionOutputs((await store.list("cryptoDeposits")).filter((d) => !d.userId && d.accountId === id), []),
  // A company send's userId is who queued it; it is the company's money.
  cryptoSendsOf: async (id) => (await store.list("cryptoSends")).filter((c) => c.userId === id && !c.safeOpId),
  issueOrdersOf: async (id) => (await store.list("moneriumIssueOrders")).filter((o) => o.userId === id),
  issueOrdersOfAccount: async (id) => (await store.list("moneriumIssueOrders")).filter((o) => o.accountId === id),
  cryptoSendsOfAccount: async (a) => await companySends(await store.list("cryptoSends"), a),
  sweepsOf: async (id) => (await store.list("conversionSweeps")).filter((s) => s.userId === id),
  paymentRequestsOf: async (id) => await store.paymentRequestsForUser(id),
  invoicesOf: async (orgId) => await store.invoicesOf(orgId),
  invoicePayments: async () => invoicePayments(await store.list("invoices")),
  rulesOf: async (orgId) => await store.rulesOf(orgId),
  ledgerOf: async (orgId) => await store.ledgerOf(orgId),
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

/** A company send is the account's when its op spends from the account's Safe. */
async function companySends(sends: readonly CryptoSend[], account: Account): Promise<CryptoSend[]> {
  const safe = account.address?.toLowerCase();
  return await mapSeq((await filterSeq(sends, async (c) => c.safeOpId && c.orgId === account.orgId && !!safe && (await store.findSafeOp(c.safeOpId))?.safeAddress.toLowerCase() === safe)), async (c) => await liveCryptoSend(c));
}

/** Valid for one synchronous sweep: nothing else writes these tables meanwhile. */
async function groupedRows(): Promise<Rows> {
  const transfers = groupBy(await store.list("transfers"), (t) => t.userId);
  // A conversion's EURe output is not income (transfers/activity.ts).
  const moneyIn = withoutConversionOutputs(await store.list("cryptoDeposits"), await store.list("transfers"));
  const deposits = groupBy(moneyIn, (d) => d.userId);
  const accountDeposits = groupBy(moneyIn, (d) => (d.userId ? undefined : d.accountId));
  const issueOrders = groupBy(await store.list("moneriumIssueOrders"), (o) => o.userId);
  const accountIssueOrders = groupBy(await store.list("moneriumIssueOrders"), (o) => o.accountId);
  const cryptoSends = groupBy((await store.list("cryptoSends")).filter((c) => !c.safeOpId), (c) => c.userId);
  const orgSends = groupBy((await store.list("cryptoSends")).filter((c) => c.safeOpId), (c) => c.orgId);
  const sweeps = groupBy(await store.list("conversionSweeps"), (s) => s.userId);
  const paymentRequests = groupBy(await store.list("paymentRequests"), (r) => r.userId);
  const invoices = groupBy(await store.list("invoices"), (i) => i.orgId);
  const paid = invoicePayments(await store.list("invoices"));
  const rules = groupBy(await store.list("accountRules"), (r) => r.orgId);
  const ledger = groupBy(await store.list("ledger"), (e) => e.orgId);
  const swaps = await swapsHaveExecuted();
  return {
    transfersOf: (id) => transfers.get(id) ?? [],
    depositsOf: (id) => deposits.get(id) ?? [],
    depositsOfAccount: (id) => accountDeposits.get(id) ?? [],
    cryptoSendsOf: (id) => cryptoSends.get(id) ?? [],
    issueOrdersOf: (id) => issueOrders.get(id) ?? [],
    issueOrdersOfAccount: (id) => accountIssueOrders.get(id) ?? [],
    cryptoSendsOfAccount: async (a) => await companySends(orgSends.get(a.orgId) ?? [], a),
    sweepsOf: (id) => sweeps.get(id) ?? [],
    paymentRequestsOf: (id) => paymentRequests.get(id) ?? [],
    invoicesOf: (orgId) => invoices.get(orgId) ?? [],
    invoicePayments: () => paid,
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

/** Books exist only under an org, and an org always has a reporting zone: a
 *  line is never dated in a zone guessed for it. */
async function zoneOf(orgId: string): Promise<string> {
  const timeZone = (await store.findOrganisation(orgId))?.reporting?.timeZone;
  if (!timeZone) throw new Error(`organisation ${orgId} has no reporting time zone`);
  return timeZone;
}

async function inputsFor(user: User, rows: Rows): Promise<StatementInputs | undefined> {
  const books = await booksFor(user.id);
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
    timeZone: await zoneOf(books.orgId),
    transfers: await rows.transfersOf(user.id),
    deposits: await rows.depositsOf(user.id),
    issueOrders: await rows.issueOrdersOf(user.id),
    sweeps: await rows.sweepsOf(user.id),
    invoices: await rows.invoicesOf(books.orgId),
    paymentRequests: await rows.paymentRequestsOf(user.id),
    cryptoSends: await rows.cryptoSendsOf(user.id),
    swapsHaveExecuted: await rows.swapsHaveExecuted(),
  };
}

/** Project and write one user's lines. Returns what changed. */
export async function writeStatementLinesFor(user: User, rows: Rows = storeRows): Promise<{ added: number; updated: number }> {
  return store.tx(async () => {
    const inp = await inputsFor(user, rows);
    if (!inp) return { added: 0, updated: 0 };
    return await writeProjected(inp, (await booksFor(user.id))?.since, rows);
  });
}

/**
 * A company account on its own Safe: no person's movements are its, so its
 * lines are the bank credits booked to the account itself, what landed on its
 * Safe from other wallets, and the sends its owners signed from it.
 */
export async function writeAccountStatementLines(account: Account, rows: Rows = storeRows): Promise<{ added: number; updated: number }> {
  return store.tx(async () => {
    const inp: StatementInputs = {
      orgId: account.orgId,
      accountId: account.id,
      safeAddress: account.address!,
      timeZone: await zoneOf(account.orgId),
      transfers: [],
      deposits: await rows.depositsOfAccount(account.id),
      issueOrders: await rows.issueOrdersOfAccount(account.id),
      sweeps: [],
      invoices: await rows.invoicesOf(account.orgId),
      paymentRequests: [],
      cryptoSends: await rows.cryptoSendsOfAccount(account),
      companyPayouts: account.moneriumPayouts ?? [],
      swapsHaveExecuted: await rows.swapsHaveExecuted(),
    };
    return await writeProjected(inp, undefined, rows);
  });
}

/**
 * The statement lines of these company payouts alone, now. For a payout row
 * about to leave the account's capped history: once its row is gone the
 * sweep cannot book it, so a payout Monerium carried out is booked first.
 * Lines are matched by key, so booking one the sweep already wrote is a no-op.
 */
export async function writeCompanyPayoutLines(account: Account, payouts: CompanyBankPayout[]): Promise<{ added: number; updated: number }> {
  return store.tx(async () => {
    const inp: StatementInputs = {
      orgId: account.orgId,
      accountId: account.id,
      safeAddress: account.address!,
      timeZone: await zoneOf(account.orgId),
      transfers: [],
      deposits: [],
      issueOrders: [],
      sweeps: [],
      invoices: [],
      paymentRequests: [],
      cryptoSends: [],
      companyPayouts: payouts,
      swapsHaveExecuted: false,
    };
    return await writeProjected(inp, undefined, storeRows);
  });
}

async function writeProjected(inp: StatementInputs, since: string | undefined, rows: Rows): Promise<{ added: number; updated: number }> {
  return store.tx(async () => {
    // Every ledger writer of the org takes this lock before it reads the rows it changes.
    await store.lockKey(`ledger:${inp.orgId}`);
    // Nothing from before the Safe's books start: an imported Safe's earlier life is not the account's.
    const projected = projectStatementLines(inp).filter((e) => !since || e.at >= since);
    // Merged against the sweep's snapshot first; with anything to write it is
    // merged again against the ledger read under the lock, so a
    // categorisation or a Beleg code committed since the snapshot is kept.
    const paid = await rows.invoicePayments();
    let { toAdd, toUpdate } = mergeStatementLines(await rows.ledgerOf(inp.orgId), projected, paid);
    if (toAdd.length || toUpdate.length) ({ toAdd, toUpdate } = mergeStatementLines(await store.ledgerOf(inp.orgId), projected, paid));
    if (toAdd.length) {
      const { entries } = applyRules(await rows.rulesOf(inp.orgId), toAdd);
      await store.addLedgerEntries(entries);
      rows.added(inp.orgId, entries);
    }
    for (const u of toUpdate) await store.updateLedgerEntry(u.id, u.patch);
    return { added: toAdd.length, updated: toUpdate.length };
  });
}

let running = false;

/** Every user, one at a time, landing as one file write at the end. */
export async function writeStatementLines(): Promise<{ added: number; updated: number }> {
  if (running) return { added: 0, updated: 0 };
  running = true;
  try {
    let added = 0;
    let updated = 0;
    // One file write per sweep: a write per user re-serialised the whole store
    // once for every user with a new line. Each user's and account's writer
    // opens its own nested store.tx, a savepoint on Postgres, so one that
    // throws undoes only its own lines and the sweep commits the rest.
    await store.tx(async () => {
      const rows = await groupedRows();
      for (const u of (await store.list("users"))) {
        try {
          const r = await writeStatementLinesFor(u, rows);
          added += r.added;
          updated += r.updated;
        } catch (err: any) {
          console.error(`bookkeeping: could not write statement lines for ${u.id}: ${describeCause(err)}`);
        }
      }
      for (const a of (await store.list("accounts"))) {
        const paidOut = (a.moneriumPayouts ?? []).some((p) => p.state === "sent");
        if (!a.address || (!(await rows.issueOrdersOfAccount(a.id)).length && !(await rows.depositsOfAccount(a.id)).length && !(await rows.cryptoSendsOfAccount(a)).length && !paidOut)) continue;
        try {
          const r = await writeAccountStatementLines(a, rows);
          added += r.added;
          updated += r.updated;
        } catch (err: any) {
          console.error(`bookkeeping: could not write statement lines for account ${a.id}: ${describeCause(err)}`);
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
export async function noteMoneriumIssue(order: MoneriumOrderLike, holder: MoneyInHolder): Promise<MoneriumIssueRecord | undefined> {
  const amountEur = moneriumAmountEur(order.amount);
  if (!amountEur) return undefined;
  const d = order.counterpart?.details ?? {};
  const name = d.name || d.companyName || [d.firstName, d.lastName].filter(Boolean).join(" ") || undefined;
  const processedAt = order.meta?.processedAt ?? order.meta?.placedAt ?? order.placedAt ?? order.createdAt ?? new Date().toISOString();
  return await store.recordMoneriumIssue({
    orderId: order.id,
    ...(holder.kind === "user" ? { userId: holder.user.id } : { accountId: holder.account.id }),
    amountEur,
    ...(name ? { counterpartyName: name } : {}),
    ...(order.counterpart?.identifier?.iban ? { counterpartyIban: order.counterpart.identifier.iban } : {}),
    ...(order.memo ? { memo: order.memo } : {}),
    processedAt: String(processedAt),
    recordedAt: new Date().toISOString(),
  });
}

/** The lines of one org, newest first, with the entry shape the routes serve. */
export async function statementLinesOf(orgId: string): Promise<LedgerEntry[]> {
  return (await store.ledgerOf(orgId)).filter((e) => e.statement);
}
