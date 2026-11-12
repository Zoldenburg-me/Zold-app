/**
 * Valuing a wallet row that sync booked without a value.
 *
 * Sync books a listed token the price feed could not price as
 * `needs-valuation`, with no EUR value, and such a row can be on no invoice
 * and gives its disposal no gain. This is the one way it gains a value: the
 * same lookup sync makes (valuation.ts), for the row's own chain, token,
 * quantity and block time, asked again rather than answered from the cache.
 * What it answers is recorded with its source; a price is never typed in.
 *
 * Refused: a row that is not a wallet row, already has a value, is e-money or
 * on no token list, or that an issued invoice holds (its amounts are on a
 * document that has gone out).
 */
import { applyRules } from "../domain/coa.js";
import type { LedgerEntry } from "../domain/types.js";
import { store } from "../store.js";
import { valueTransfer, type ValuationQuery, type ValuationResult } from "./valuation.js";

export type RevalueOutcome =
  | { status: "valued"; entry: LedgerEntry }
  | { status: "refused"; reason: string }
  | { status: "no-price"; reason: string }
  | { status: "unreachable"; reason: string };

export interface RevalueOptions {
  value?: (q: ValuationQuery, opts: { fresh: boolean }) => Promise<ValuationResult>;
  memberId?: string;
  now?: () => string;
}

/** An invoice past DRAFT that bills or settles the row. */
function issuedInvoiceHolding(orgId: string, entryId: string): string | undefined {
  const holder = store.invoicesOf(orgId).find(
    (i) =>
      i.state !== "DRAFT" &&
      i.state !== "DELETED" &&
      ((i.settlements ?? []).some((s) => s.method === "wallet-receipt" && s.ledgerEntryId === entryId) ||
        i.lines.some((l) => l.receipt?.ledgerEntryId === entryId)),
  );
  return holder ? holder.issued?.number ?? holder.id : undefined;
}

/** Why this row cannot be revalued, or undefined when it can. */
export function revalueRefusal(entry: LedgerEntry): string | undefined {
  if (entry.source.kind !== "wallet") return "Only a row synced from an imported wallet is valued this way.";
  if (entry.tags.includes("unlisted") || entry.txType === "unlisted_token") return "The token is on no token list, so it is never priced.";
  if (entry.tags.includes("e-money")) return "EURe is booked at par and needs no price.";
  // Read beside the tags, which a person can edit: a row with a value keeps
  // it, and a row sync booked as on no list stays unpriced.
  if (entry.fiatValue !== undefined) return "The row already has a value.";
  if (!entry.tags.includes("needs-valuation") || entry.note?.startsWith("Not on a token list")) {
    return "Sync did not book this row as waiting for a price.";
  }
  if (!entry.token || entry.chainId === undefined || !Number.isFinite(Date.parse(entry.at))) {
    return "The row names no token, chain or time to look a price up for.";
  }
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "The row's quantity is not a positive number.";
  const held = issuedInvoiceHolding(entry.orgId, entry.id);
  if (held) return `Invoice ${held} has been issued with this row on it, so its value is not changed.`;
  return undefined;
}

export async function revalueEntry(orgId: string, entryId: string, opts: RevalueOptions = {}): Promise<RevalueOutcome | undefined> {
  const entry = store.ledgerOf(orgId).find((e) => e.id === entryId);
  if (!entry) return undefined;
  const refusal = revalueRefusal(entry);
  if (refusal) return { status: "refused", reason: refusal };

  const value = opts.value ?? valueTransfer;
  const result = await value(
    { chainId: entry.chainId!, token: entry.token!, amount: Number(entry.amount), blockTime: entry.at },
    { fresh: true },
  );
  if (!result.ok) {
    return result.transient ? { status: "unreachable", reason: result.reason } : { status: "no-price", reason: result.reason };
  }
  const { valuation } = result;
  const now = (opts.now ?? (() => new Date().toISOString()))();
  // Nothing awaited from here: the row is read and written as one.
  return store.batched((): RevalueOutcome => {
    const current = store.ledgerOf(orgId).find((e) => e.id === entryId);
    const again = current ? revalueRefusal(current) : "The row is gone.";
    if (!current || again) return { status: "refused", reason: again ?? "The row is gone." };
    const valued: LedgerEntry = {
      ...current,
      asset: valuation.symbol,
      fiatValue: valuation.eurValue.toFixed(2),
      fiatCurrency: "EUR",
      fiatRate: String(valuation.eurPerUnit),
      tags: [...current.tags.filter((t) => t !== "needs-valuation"), "revalued"],
      // Sync's "Not valued" note is replaced; a note a person wrote is kept.
      note: !current.note || current.note.startsWith("Not valued:")
        ? `Valued later, for the block time: ${valuation.source}.`
        : current.note,
      valuation: {
        source: valuation.source,
        asOf: valuation.asOf,
        revaluedAt: now,
        ...(opts.memberId ? { revaluedByMemberId: opts.memberId } : {}),
        previousAsset: current.asset,
      },
    };
    // A rule keyed on the asset now sees its real symbol.
    const [ruled] = applyRules(store.rulesOf(orgId), [valued]).entries;
    store.replaceLedgerEntries([ruled]);
    return { status: "valued", entry: ruled };
  });
}

/** Every row of the organisation that sync booked without a value and could
 *  be valued this way. */
export const revaluable = (orgId: string): LedgerEntry[] =>
  store
    .ledgerOf(orgId)
    .filter((e) => e.source.kind === "wallet" && e.tags.includes("needs-valuation") && !e.tags.includes("unlisted") && e.txType !== "unlisted_token")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
