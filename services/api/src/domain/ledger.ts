/**
 * Bookkeeping over the ledger: FIFO tax lots, realised gain/loss, the monthly
 * closing-balance report, and CSV export.
 *
 * Gnosis Business computed cost basis FIFO and said more methods were coming.
 * We implement FIFO only and say so — `Organisation.reporting.costBasisMethod`
 * is typed to one value rather than offering a dropdown that silently computes
 * FIFO whatever you pick.
 *
 * Everything here works in decimal strings converted through Number only at the
 * arithmetic boundary. Balances are money; the moment one round-trips through a
 * float and back it stops being reconcilable, which is the whole reason the
 * reconciler exists.
 */

import type { LedgerEntry } from "./types.js";

export interface TaxLot {
  id: string;
  asset: string;
  /** Units acquired in this lot. */
  quantity: number;
  /** Units still unsold. */
  remaining: number;
  /** Reporting-currency cost of the whole lot at acquisition. */
  cost: number;
  unitCost: number;
  acquiredAt: string;
  sourceEntryId: string;
}

export interface Disposal {
  entryId: string;
  asset: string;
  at: string;
  quantity: number;
  proceeds: number;
  costBasis: number;
  /** proceeds - costBasis. Negative is a loss. */
  realised: number;
  /** Which lots it consumed, for the audit trail. */
  consumed: { lotId: string; quantity: number; cost: number }[];
}

export interface CostBasisResult {
  lots: TaxLot[];
  disposals: Disposal[];
  /** Disposals that could not be fully covered by known acquisitions. Reported
   *  rather than assumed-zero-cost: an unmatched disposal usually means history
   *  is missing, and booking it as pure profit would overstate income. */
  shortfalls: { entryId: string; asset: string; quantity: number; at: string }[];
}

const num = (v: string | undefined, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * FIFO cost basis over a set of entries.
 *
 * Entries are sorted by time; an `in` opens a lot, an `out` consumes the oldest
 * open lots first. An entry with no fiat value cannot price a lot, so it opens
 * one at zero cost AND is recorded as a shortfall when later disposed against.
 */
export function computeCostBasis(entries: LedgerEntry[]): CostBasisResult {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );

  const open = new Map<string, TaxLot[]>();
  const lots: TaxLot[] = [];
  const disposals: Disposal[] = [];
  const shortfalls: CostBasisResult["shortfalls"] = [];

  for (const e of sorted) {
    const qty = num(e.amount);
    if (qty <= 0) continue;
    const asset = e.asset.toUpperCase();
    const value = num(e.fiatValue);

    if (e.direction === "in") {
      const lot: TaxLot = {
        id: `lot_${e.id}`,
        asset,
        quantity: qty,
        remaining: qty,
        cost: value,
        unitCost: qty ? value / qty : 0,
        acquiredAt: e.at,
        sourceEntryId: e.id,
      };
      lots.push(lot);
      if (!open.has(asset)) open.set(asset, []);
      open.get(asset)!.push(lot);
      continue;
    }

    // Disposal: eat the oldest lots first.
    let toSell = qty;
    let costBasis = 0;
    const consumed: Disposal["consumed"] = [];
    const queue = open.get(asset) ?? [];
    while (toSell > 1e-18 && queue.length) {
      const lot = queue[0];
      const take = Math.min(lot.remaining, toSell);
      const takeCost = take * lot.unitCost;
      lot.remaining -= take;
      toSell -= take;
      costBasis += takeCost;
      consumed.push({ lotId: lot.id, quantity: take, cost: takeCost });
      if (lot.remaining <= 1e-18) queue.shift();
    }
    if (toSell > 1e-12) {
      shortfalls.push({ entryId: e.id, asset, quantity: toSell, at: e.at });
    }

    disposals.push({
      entryId: e.id,
      asset,
      at: e.at,
      quantity: qty,
      proceeds: value,
      costBasis,
      realised: value - costBasis,
      consumed,
    });
  }

  return { lots, disposals, shortfalls };
}

export interface AssetPosition {
  asset: string;
  /** Units held. */
  quantity: number;
  /** Reporting-currency cost of what is still held. */
  costBasis: number;
  /** Realised gain/loss to date across all disposals of this asset. */
  realised: number;
  lots: TaxLot[];
}

export function positions(result: CostBasisResult): AssetPosition[] {
  const byAsset = new Map<string, AssetPosition>();
  for (const lot of result.lots) {
    const p =
      byAsset.get(lot.asset) ??
      { asset: lot.asset, quantity: 0, costBasis: 0, realised: 0, lots: [] };
    p.quantity += lot.remaining;
    p.costBasis += lot.remaining * lot.unitCost;
    p.lots.push(lot);
    byAsset.set(lot.asset, p);
  }
  for (const d of result.disposals) {
    const p =
      byAsset.get(d.asset) ??
      { asset: d.asset, quantity: 0, costBasis: 0, realised: 0, lots: [] };
    p.realised += d.realised;
    byAsset.set(d.asset, p);
  }
  return [...byAsset.values()].sort((a, b) => b.costBasis - a.costBasis);
}

// ── Monthly closing balance report ──────────────────────────────────────────

export interface MonthlyBalanceRow {
  month: string; // YYYY-MM
  source: string; // account or wallet id
  chainId?: number;
  asset: string;
  /** Units at the close of the month. */
  closingQuantity: number;
  /** Movement within the month. */
  inQuantity: number;
  outQuantity: number;
  /** Reporting-currency value at close, where entries carried one. */
  closingValue?: number;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Closing balances grouped by month + source + asset, per Gnosis's "Grouped
 * balances by Date + Wallet + Blockchain + Token".
 *
 * Months with no activity still emit a row carrying the previous close — a
 * report that omits quiet months looks like the balance vanished.
 */
export function monthlyBalances(
  entries: LedgerEntry[],
  opts: { from?: string; to?: string } = {},
): MonthlyBalanceRow[] {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  if (!sorted.length) return [];

  const sourceId = (e: LedgerEntry) =>
    e.source.kind === "account" ? e.source.accountId : e.source.walletId;

  // running[series] = { qty, value }
  const running = new Map<string, { qty: number; value: number }>();
  const movement = new Map<string, { in: number; out: number }>();
  const meta = new Map<string, { source: string; asset: string; chainId?: number }>();
  const months = new Set<string>();

  for (const e of sorted) {
    const key = `${sourceId(e)}|${e.chainId ?? ""}|${e.asset.toUpperCase()}`;
    meta.set(key, {
      source: sourceId(e),
      asset: e.asset.toUpperCase(),
      chainId: e.chainId,
    });
    months.add(monthKey(e.at));
  }

  const allMonths = [...months].sort();
  const from = opts.from ?? allMonths[0];
  const to = opts.to ?? allMonths[allMonths.length - 1];

  // Walk every month in range so quiet months carry the balance forward.
  const span: string[] = [];
  {
    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((y++), (m = 1)) : m++) {
      span.push(`${y}-${String(m).padStart(2, "0")}`);
    }
  }

  const rows: MonthlyBalanceRow[] = [];
  let cursor = 0;
  for (const month of span) {
    for (const k of movement.keys()) movement.set(k, { in: 0, out: 0 });

    while (cursor < sorted.length && monthKey(sorted[cursor].at) <= month) {
      const e = sorted[cursor++];
      if (monthKey(e.at) < month) {
        // Pre-range activity: fold into the opening balance, emit nothing.
      }
      const key = `${sourceId(e)}|${e.chainId ?? ""}|${e.asset.toUpperCase()}`;
      const cur = running.get(key) ?? { qty: 0, value: 0 };
      const qty = num(e.amount);
      const val = num(e.fiatValue);
      if (e.direction === "in") {
        cur.qty += qty;
        cur.value += val;
      } else {
        cur.qty -= qty;
        cur.value -= val;
      }
      running.set(key, cur);
      if (monthKey(e.at) === month) {
        const mv = movement.get(key) ?? { in: 0, out: 0 };
        if (e.direction === "in") mv.in += qty;
        else mv.out += qty;
        movement.set(key, mv);
      }
    }

    if (month < from) continue;
    for (const [key, bal] of running) {
      const m = meta.get(key)!;
      const mv = movement.get(key) ?? { in: 0, out: 0 };
      rows.push({
        month,
        source: m.source,
        chainId: m.chainId,
        asset: m.asset,
        closingQuantity: bal.qty,
        inQuantity: mv.in,
        outQuantity: mv.out,
        closingValue: bal.value || undefined,
      });
    }
  }
  return rows;
}

// ── Export ──────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Prefixing with ' keeps an exported memo from executing in someone's Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export const LEDGER_EXPORT_COLUMNS = [
  "date",
  "direction",
  "asset",
  "amount",
  "fiatCurrency",
  "fiatValue",
  "fiatRate",
  "counterparty",
  "accountCode",
  "tags",
  "note",
  "txHash",
  "chainId",
] as const;

export function ledgerExportRows(entries: LedgerEntry[]): Record<string, unknown>[] {
  return entries.map((e) => ({
    date: e.at,
    direction: e.direction,
    asset: e.asset,
    amount: e.amount,
    fiatCurrency: e.fiatCurrency ?? "",
    fiatValue: e.fiatValue ?? "",
    fiatRate: e.fiatRate ?? "",
    counterparty: e.counterparty?.name ?? e.counterparty?.address ?? "",
    accountCode: e.accountCode ?? "",
    tags: e.tags.join(";"),
    note: e.note ?? "",
    txHash: e.txHash ?? "",
    chainId: e.chainId ?? "",
  }));
}
