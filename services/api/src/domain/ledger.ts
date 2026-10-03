/**
 * Bookkeeping over the ledger: FIFO tax lots, realised gain/loss, the monthly
 * closing-balance report, and CSV export.
 *
 * Cost basis is FIFO only (as in Gnosis Business), so
 * `Organisation.reporting.costBasisMethod` is typed to that one value. Don't
 * offer a method picker until other methods are implemented. Whether a
 * disposal is taxable, the holding period and the method itself are the tax
 * adviser's; this computes, it does not classify.
 *
 * Quantities are exact: decimal strings read into integers at the token's
 * scale, never through a float. Money is integer euro cents.
 */

import { formatUnits } from "viem";
import { monthOf } from "./income-invoices.js";
import type { LedgerEntry } from "./types.js";

export interface TaxLot {
  id: string;
  /** The holding: `chainId:token` for a wallet row, the asset otherwise. */
  key: string;
  /** The symbol to show. */
  asset: string;
  chainId?: number;
  token?: `0x${string}`;
  /** Units acquired in this lot, and still unsold. */
  quantity: string;
  remaining: string;
  /** EUR cents paid for the whole lot, and for what is left. Absent when the
   *  row that opened it has no value: the cost is unknown, not zero. */
  costCents?: number;
  remainingCostCents?: number;
  acquiredAt: string;
  sourceEntryId: string;
  walletId?: string;
  txHash?: string;
}

export interface ConsumedLot {
  lotId: string;
  quantity: string;
  /** Absent when the lot's cost is unknown. */
  costCents?: number;
}

export interface Disposal {
  entryId: string;
  key: string;
  asset: string;
  chainId?: number;
  token?: `0x${string}`;
  at: string;
  quantity: string;
  /** EUR value of what left, at the time it left. Absent: the row has none. */
  proceedsCents?: number;
  /** FIFO cost of the lots it used. Absent when any of them has no known cost. */
  costBasisCents?: number;
  /** proceeds − cost; negative is a loss. Absent, never zero, when it cannot
   *  be measured, and `notMeasurable` says why. */
  realisedCents?: number;
  notMeasurable?: string;
  consumed: ConsumedLot[];
  /** Units sold beyond every booked lot. */
  shortfall?: string;
  walletId?: string;
  txHash?: string;
  /** Other wallet rows of the same transaction (a swap's other leg, a fee).
   *  Listed, not paired: see `computeCostBasis`. */
  sameTransaction: string[];
}

/** A token sent from an imported wallet to another address of the
 *  organisation that is not an imported wallet: its Zold account, or an
 *  address a person marked internal. It leaves the wallets' lots at cost and
 *  realises nothing. */
export interface MovedOut {
  entryId: string;
  to: "zold-account" | "own-address";
  key: string;
  asset: string;
  at: string;
  quantity: string;
  costBasisCents?: number;
  consumed: ConsumedLot[];
  shortfall?: string;
}

export interface Shortfall {
  entryId: string;
  /** A sale, or a move to the organisation's own address. */
  kind: "disposal" | "moved";
  key: string;
  asset: string;
  quantity: string;
  at: string;
}

/** A token on no list: counted, never valued. */
export interface QuantityOnly {
  key: string;
  asset: string;
  chainId?: number;
  token?: `0x${string}`;
  quantity: string;
  entryIds: string[];
}

export interface CostBasisResult {
  lots: TaxLot[];
  disposals: Disposal[];
  moved: MovedOut[];
  /** Disposals not fully covered by booked acquisitions. Reported, never
   *  assumed to cost nothing: it usually means history is missing. */
  shortfalls: Shortfall[];
  quantityOnly: QuantityOnly[];
  /** Rows whose amount is not a decimal number or whose time is not a time,
   *  left out and named. */
  unreadable: string[];
}

export interface CostBasisOptions {
  /** The organisation's imported wallets as they are now. A transfer between
   *  two of them moves nothing, because lots are pooled across them. Read
   *  now, not from the row's `internal` tag: that tag was set from the
   *  wallets imported when the row was synced. */
  ownWallets?: { chainId: number; address: string }[];
  /** The organisation's own Zold accounts. A transfer to or from one moves
   *  lots out of or into the wallets. */
  ownAccounts?: { chainId: number; address: string }[];
}

const DECIMAL_RE = /^\d+(?:\.(\d+))?$/;
const FIAT = new Set(Intl.supportedValuesOf("currency"));

/** Euro cents from a stored value, rounded half up; undefined if unreadable. */
export function eurCents(value: string | undefined): number | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value ?? "");
  if (!m) return undefined;
  const frac = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) return undefined;
  return m[1] ? -cents : cents;
}

const tagged = (e: LedgerEntry, tag: string) => e.tags.includes(tag);
const isMoney = (e: LedgerEntry) =>
  tagged(e, "e-money") || e.asset.toUpperCase() === "EURE" || (e.source.kind === "account" && FIAT.has(e.asset.toUpperCase()));
const isUnlisted = (e: LedgerEntry) => tagged(e, "unlisted") || e.txType === "unlisted_token";
const isInternal = (e: LedgerEntry) => tagged(e, "internal") || e.txType === "internal_transfer";
/** A value the books can use: EUR, and not marked as missing. */
const valueCents = (e: LedgerEntry): number | undefined =>
  tagged(e, "needs-valuation") || (e.fiatCurrency !== undefined && e.fiatCurrency !== "EUR") ? undefined : eurCents(e.fiatValue);

/** The holding a row belongs to: the token contract on its chain, so two
 *  tokens that share a symbol never share lots. */
export function holdingKey(e: LedgerEntry): string {
  return e.token && e.chainId !== undefined ? `${e.chainId}:${e.token.toLowerCase()}` : e.asset.toUpperCase();
}
const symbolOf = (asset: string) => asset.replace(/@\d+:0x[0-9a-fA-F]{40}$/, "");

/** a × b ÷ c, rounded half up, in integers. */
const mulDiv = (a: number, b: bigint, c: bigint): number => {
  const n = BigInt(a) * b * 2n + c;
  return Number(n / (2n * c));
};

/**
 * FIFO cost basis over a set of entries.
 *
 * Entries are walked in time order. An `in` opens a lot at its EUR value; an
 * `out` uses the oldest open lots of the same holding first, and its gain is
 * its own EUR value minus their cost. Not booked as lots:
 *
 * - Money: EURe (e-money, euro at par) and the euro account's own lines.
 * - A token on no list: a quantity in `quantityOnly`, no value, no gain.
 * - A transfer between the organisation's imported wallets: lots are pooled
 *   per token across them, so it moves nothing and realises nothing. One to
 *   its Zold account leaves the wallets at cost (`moved`); one from it opens
 *   a lot whose cost is unknown here.
 *
 * A swap is two rows of one transaction: the token that left is a disposal
 * at its own value, the token that arrived an acquisition at its own. They
 * are not paired: the two values come from the price feed separately and
 * differ by fees and slippage, and a transaction with two transfers is not
 * certainly a swap. The disposal lists the other rows as `sameTransaction`.
 */
export function computeCostBasis(entries: LedgerEntry[], opts: CostBasisOptions = {}): CostBasisResult {
  const set = (xs?: { chainId: number; address: string }[]) => new Set((xs ?? []).map((a) => `${a.chainId}:${a.address.toLowerCase()}`));
  const wallets = set(opts.ownWallets);
  const accounts = set(opts.ownAccounts);
  const other = (e: LedgerEntry) =>
    e.chainId !== undefined && e.counterparty?.address ? `${e.chainId}:${e.counterparty.address.toLowerCase()}` : undefined;
  /** Where a row's other side is, decided now. */
  const sideOf = (e: LedgerEntry): "pooled" | "zold-account" | "own-address" | "external" => {
    const o = other(e);
    if (e.source.kind === "wallet" && o && wallets.has(o)) return "pooled";
    if (o && accounts.has(o)) return "zold-account";
    return isInternal(e) ? "own-address" : "external";
  };

  const unreadable: string[] = [];
  const rows = entries.filter((e) => {
    if (isMoney(e)) return false;
    if (!DECIMAL_RE.test(e.amount) || !Number.isFinite(Date.parse(e.at))) {
      unreadable.push(e.id);
      return false;
    }
    return true;
  });

  // Each holding counts in integers at the finest scale any of its rows uses.
  const scale = new Map<string, number>();
  for (const e of rows) {
    const k = holdingKey(e);
    scale.set(k, Math.max(scale.get(k) ?? 0, DECIMAL_RE.exec(e.amount)![1]?.length ?? 0));
  }
  const units = (e: LedgerEntry): bigint => {
    const [whole, frac = ""] = e.amount.split(".");
    const d = scale.get(holdingKey(e))!;
    return BigInt(whole + frac.padEnd(d, "0"));
  };
  const fmt = (k: string, v: bigint) => formatUnits(v, scale.get(k)!);

  const byTx = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.source.kind !== "wallet" || !e.txHash) continue;
    const t = `${e.chainId}:${e.txHash.toLowerCase()}`;
    byTx.set(t, [...(byTx.get(t) ?? []), e]);
  }

  const sorted = [...rows].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.logIndex ?? 0) - (b.logIndex ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  type OpenLot = { lot: TaxLot; remaining: bigint; quantity: bigint; remainingCost?: number };
  const open = new Map<string, OpenLot[]>();
  const lots: { lot: TaxLot; state: OpenLot }[] = [];
  const disposals: Disposal[] = [];
  const moved: MovedOut[] = [];
  const shortfalls: Shortfall[] = [];
  const quantityOnly = new Map<string, QuantityOnly & { units: bigint }>();
  const labels = new Map<string, string>();
  const label = (k: string, e: LedgerEntry) => {
    const symbol = symbolOf(e.asset);
    if (!labels.has(k) || !e.asset.includes("@")) labels.set(k, symbol);
    return labels.get(k)!;
  };

  /** Take `qty` from the oldest lots of a holding. */
  const consume = (k: string, qty: bigint) => {
    const queue = open.get(k) ?? [];
    let left = qty;
    let cost: number | undefined = 0;
    const consumed: ConsumedLot[] = [];
    while (left > 0n && queue.length) {
      const lot = queue[0];
      const take = lot.remaining < left ? lot.remaining : left;
      let takeCost: number | undefined;
      if (lot.remainingCost !== undefined) {
        // The last piece takes what is left, so a lot's pieces sum to its cost.
        takeCost = take === lot.remaining ? lot.remainingCost : mulDiv(lot.remainingCost, take, lot.remaining);
        lot.remainingCost -= takeCost;
      }
      lot.remaining -= take;
      left -= take;
      cost = cost === undefined || takeCost === undefined ? undefined : cost + takeCost;
      consumed.push({ lotId: lot.lot.id, quantity: fmt(k, take), ...(takeCost === undefined ? {} : { costCents: takeCost }) });
      if (lot.remaining === 0n) queue.shift();
    }
    return { consumed, cost, shortfall: left };
  };

  for (const e of sorted) {
    const qty = units(e);
    if (qty <= 0n) continue;
    const k = holdingKey(e);
    const asset = label(k, e);

    if (isUnlisted(e)) {
      const q = quantityOnly.get(k) ?? { key: k, asset, chainId: e.chainId, token: e.token, quantity: "0", entryIds: [], units: 0n };
      q.units += e.direction === "in" ? qty : -qty;
      q.entryIds.push(e.id);
      quantityOnly.set(k, q);
      continue;
    }
    const side = sideOf(e);
    if (side === "pooled") continue;
    const moving = side === "zold-account" || side === "own-address";

    if (e.direction === "in") {
      // From the organisation's own account or address the cost is in those
      // books, not here.
      const cost = moving ? undefined : valueCents(e);
      const lot: TaxLot = {
        id: `lot_${e.id}`,
        key: k,
        asset,
        ...(e.chainId === undefined ? {} : { chainId: e.chainId }),
        ...(e.token ? { token: e.token } : {}),
        quantity: fmt(k, qty),
        remaining: fmt(k, qty),
        ...(cost === undefined ? {} : { costCents: cost }),
        acquiredAt: e.at,
        sourceEntryId: e.id,
        ...(e.source.kind === "wallet" ? { walletId: e.source.walletId } : {}),
        ...(e.txHash ? { txHash: e.txHash } : {}),
      };
      const state: OpenLot = { lot, remaining: qty, quantity: qty, remainingCost: cost };
      lots.push({ lot, state });
      open.set(k, [...(open.get(k) ?? []), state]);
      continue;
    }

    const { consumed, cost, shortfall } = consume(k, qty);
    if (shortfall > 0n) {
      shortfalls.push({ entryId: e.id, kind: moving ? "moved" : "disposal", key: k, asset, quantity: fmt(k, shortfall), at: e.at });
    }

    if (moving) {
      moved.push({
        entryId: e.id, to: side, key: k, asset, at: e.at, quantity: fmt(k, qty), consumed,
        ...(cost === undefined || shortfall > 0n ? {} : { costBasisCents: cost }),
        ...(shortfall > 0n ? { shortfall: fmt(k, shortfall) } : {}),
      });
      continue;
    }

    const proceeds = valueCents(e);
    const notMeasurable =
      shortfall > 0n ? `Sold more than was ever booked: ${fmt(k, shortfall)} ${asset} have no acquisition in the books.`
      : cost === undefined ? "A lot it was sold from has no known cost."
      : proceeds === undefined ? "The sale has no EUR value."
      : undefined;
    const t = e.txHash ? byTx.get(`${e.chainId}:${e.txHash.toLowerCase()}`) ?? [] : [];
    disposals.push({
      entryId: e.id,
      key: k,
      asset,
      ...(e.chainId === undefined ? {} : { chainId: e.chainId }),
      ...(e.token ? { token: e.token } : {}),
      at: e.at,
      quantity: fmt(k, qty),
      ...(proceeds === undefined ? {} : { proceedsCents: proceeds }),
      ...(cost === undefined || shortfall > 0n ? {} : { costBasisCents: cost }),
      ...(notMeasurable ? { notMeasurable } : { realisedCents: proceeds! - cost! }),
      consumed,
      ...(shortfall > 0n ? { shortfall: fmt(k, shortfall) } : {}),
      ...(e.source.kind === "wallet" ? { walletId: e.source.walletId } : {}),
      ...(e.txHash ? { txHash: e.txHash } : {}),
      sameTransaction: t.filter((x) => x.id !== e.id).map((x) => x.id).sort(),
    });
  }

  return {
    lots: lots.map(({ lot, state }) => ({
      ...lot,
      asset: labels.get(lot.key) ?? lot.asset,
      remaining: fmt(lot.key, state.remaining),
      ...(state.remainingCost === undefined ? {} : { remainingCostCents: state.remainingCost }),
    })),
    disposals: disposals.map((d) => ({ ...d, asset: labels.get(d.key) ?? d.asset })),
    moved,
    shortfalls,
    quantityOnly: [...quantityOnly.values()].map(({ units: u, ...q }) => ({ ...q, asset: labels.get(q.key) ?? q.asset, quantity: fmt(q.key, u) })),
    unreadable,
  };
}

export interface AssetPosition {
  key: string;
  asset: string;
  chainId?: number;
  token?: `0x${string}`;
  /** Units held, exact. */
  quantity: string;
  /** EUR cents paid for what is still held, over the lots whose cost is
   *  known. Absent when something is held and none of it has a known cost. */
  costBasisCents?: number;
  /** Units held whose cost is unknown. "0" when every open lot has a cost. */
  uncostedQuantity: string;
  /** Measured gain/loss to date over this holding's disposals. Absent when
   *  none of them could be measured. */
  realisedCents?: number;
  /** Disposals whose gain could not be measured. */
  unmeasured: number;
  /** Every lot of the holding, open or used up, for the audit trail. */
  lots: TaxLot[];
}

export function positions(result: CostBasisResult): AssetPosition[] {
  type Building = Omit<AssetPosition, "costBasisCents" | "realisedCents"> & {
    costBasisCents: number; realisedCents: number; measured: number; held: bigint; uncosted: bigint; scale: number;
  };
  const byKey = new Map<string, Building>();
  const get = (key: string, asset: string, chainId?: number, token?: `0x${string}`) => {
    const p = byKey.get(key) ?? {
      key, asset, ...(chainId === undefined ? {} : { chainId }), ...(token ? { token } : {}),
      quantity: "0", costBasisCents: 0, uncostedQuantity: "0", realisedCents: 0, unmeasured: 0, lots: [],
      measured: 0, held: 0n, uncosted: 0n, scale: 0,
    };
    byKey.set(key, p);
    return p;
  };
  for (const lot of result.lots) {
    const p = get(lot.key, lot.asset, lot.chainId, lot.token);
    const d = lot.quantity.split(".")[1]?.length ?? 0;
    const r = lot.remaining.split(".")[1]?.length ?? 0;
    p.scale = Math.max(p.scale, d, r);
    p.lots.push(lot);
  }
  for (const p of byKey.values()) {
    for (const lot of p.lots) {
      const [w, f = ""] = lot.remaining.split(".");
      const left = BigInt(w + f.padEnd(p.scale, "0"));
      p.held += left;
      if (lot.remainingCostCents === undefined) p.uncosted += left;
      else p.costBasisCents += lot.remainingCostCents;
    }
  }
  for (const d of result.disposals) {
    const p = get(d.key, d.asset, d.chainId, d.token);
    if (d.realisedCents === undefined) p.unmeasured += 1;
    else {
      p.realisedCents += d.realisedCents;
      p.measured += 1;
    }
  }
  return [...byKey.values()]
    .map(({ held, uncosted, scale, measured, costBasisCents, realisedCents, ...p }): AssetPosition => ({
      ...p,
      quantity: formatUnits(held, scale),
      uncostedQuantity: formatUnits(uncosted, scale),
      ...(held > 0n && uncosted === held ? {} : { costBasisCents }),
      ...(measured ? { realisedCents } : {}),
    }))
    .sort((a, b) => (b.costBasisCents ?? 0) - (a.costBasisCents ?? 0) || a.asset.localeCompare(b.asset));
}

export interface RealisedMonth {
  month: string;
  /** Sum of the measured gains and losses. The three sums are absent when
   *  no disposal of the month could be measured. */
  realisedCents?: number;
  gainsCents?: number;
  lossesCents?: number;
  measured: number;
  /** Disposals of the month whose gain could not be measured. */
  unmeasured: number;
  /** Every disposal of the month, by ledger row id. */
  disposals: string[];
}

/** Realised gain per calendar month in the organisation's time zone. */
export function realisedByMonth(disposals: Disposal[], timeZone: string): RealisedMonth[] {
  const months = new Map<string, RealisedMonth>();
  for (const d of disposals) {
    const month = monthOf(d.at, timeZone);
    const m = months.get(month) ?? { month, realisedCents: 0, gainsCents: 0, lossesCents: 0, measured: 0, unmeasured: 0, disposals: [] };
    m.disposals.push(d.entryId);
    if (d.realisedCents === undefined) m.unmeasured += 1;
    else {
      m.measured += 1;
      m.realisedCents! += d.realisedCents;
      if (d.realisedCents >= 0) m.gainsCents! += d.realisedCents;
      else m.lossesCents! += -d.realisedCents;
    }
    months.set(month, m);
  }
  return [...months.values()]
    .map((m) => (m.measured ? m : { month: m.month, measured: 0, unmeasured: m.unmeasured, disposals: m.disposals }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

const num = (v: string | undefined, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

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
