/**
 * Chart of accounts and the rules that map transactions onto it.
 *
 * Gnosis Business shipped a default chart plus three scopes of automation
 * (defaults by transaction type, per wallet/asset, per contact). We keep the
 * shape and pin down the one thing their docs leave implicit: precedence.
 * Without a stated order, two rules that both match make the mapping depend on
 * insertion order, and a bookkeeping system whose answer depends on row order
 * is not one an accountant can sign.
 */

import type { AccountRule, ChartAccount, ChartAccountType, LedgerEntry } from "./types.js";

export class CoaError extends Error {}

/** The starter chart, close to Gnosis's defaults. Codes follow the common
 *  4000 revenue / 5000-6000 expense / 1000 asset layout Xero users expect. */
export const DEFAULT_CHART: {
  code: string;
  name: string;
  type: ChartAccountType;
}[] = [
  { code: "1000", name: "Cash and cash equivalents", type: "asset" },
  { code: "1100", name: "Digital assets", type: "asset" },
  { code: "1200", name: "Accounts receivable", type: "asset" },
  { code: "2000", name: "Accounts payable", type: "liability" },
  { code: "3000", name: "Owner's equity", type: "equity" },
  { code: "4000", name: "Sales", type: "revenue" },
  { code: "4100", name: "Other income", type: "revenue" },
  { code: "4200", name: "Realised gains", type: "revenue" },
  { code: "5000", name: "Cost of sales", type: "expense" },
  { code: "6000", name: "Transaction fees", type: "expense" },
  { code: "6010", name: "Gas fees", type: "expense" },
  { code: "6020", name: "Realised losses", type: "expense" },
  { code: "6100", name: "Software and subscriptions", type: "expense" },
  { code: "6200", name: "Contractors and payroll", type: "expense" },
  { code: "6300", name: "Rounding differences", type: "expense" },
];

/** Transaction types the default rules can key on. */
export const TX_TYPES = [
  "transfer_in",
  "transfer_out",
  "payout",
  "invoice_payment",
  "gas_fee",
  "swap",
  "realised_gain",
  "realised_loss",
  "rounding",
] as const;
export type TxType = (typeof TX_TYPES)[number];

/** Mappings applied to a fresh org, so the smart-categorisation Gnosis
 *  advertised works on day one rather than after configuration. */
export const DEFAULT_RULES: { txType: TxType; direction: "in" | "out" | "both"; accountCode: string }[] = [
  { txType: "gas_fee", direction: "out", accountCode: "6010" },
  { txType: "realised_gain", direction: "in", accountCode: "4200" },
  { txType: "realised_loss", direction: "out", accountCode: "6020" },
  { txType: "rounding", direction: "both", accountCode: "6300" },
  { txType: "transfer_in", direction: "in", accountCode: "4100" },
  { txType: "transfer_out", direction: "out", accountCode: "6000" },
  { txType: "invoice_payment", direction: "in", accountCode: "4000" },
  { txType: "payout", direction: "out", accountCode: "6200" },
];

const CODE_RE = /^[A-Za-z0-9._-]{1,16}$/;

export function validateChartAccount(
  input: Partial<ChartAccount>,
): Pick<ChartAccount, "code" | "name" | "type"> {
  const code = String(input.code ?? "").trim();
  if (!CODE_RE.test(code)) {
    throw new CoaError(
      `"${code}" is not a usable account code — up to 16 letters, digits, dot, dash or underscore.`,
    );
  }
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw new CoaError("An account needs a name.");
  const type = input.type as ChartAccountType;
  if (!["revenue", "expense", "asset", "liability", "equity"].includes(type)) {
    throw new CoaError(
      `"${String(input.type)}" is not an account type. Use revenue, expense, asset, liability or equity.`,
    );
  }
  return { code, name, type };
}

/**
 * Precedence, most specific first. Stated here so it is one decision rather
 * than an emergent property of the rule table:
 *
 *   1. contact + direction        — "we always book Acme to 4000"
 *   2. wallet + asset             — "USDC in the payroll wallet is 6200"
 *   3. wallet                     — "everything in the payroll wallet is 6200"
 *   4. asset                      — "all EURe is 1000"
 *   5. transaction-type default   — "gas is 6010"
 *
 * A rule whose `direction` is `both` matches either side but loses to an
 * equally specific rule that names the actual direction.
 */
const SCOPE_RANK: Record<AccountRule["scope"], number> = {
  contact: 4,
  wallet: 2,
  asset: 1,
  default: 0,
};

function specificity(rule: AccountRule): number {
  let score = SCOPE_RANK[rule.scope] * 10;
  // wallet+asset together beat wallet alone.
  if (rule.scope === "asset" && rule.match.walletId) score = 3 * 10;
  if (rule.direction !== "both") score += 1;
  return score;
}

export interface MappableEntry {
  direction: "in" | "out";
  asset: string;
  txType?: string;
  walletId?: string;
  contactId?: string;
}

function ruleMatches(rule: AccountRule, entry: MappableEntry): boolean {
  if (rule.direction !== "both" && rule.direction !== entry.direction) return false;
  const m = rule.match;
  switch (rule.scope) {
    case "contact":
      return Boolean(m.contactId) && m.contactId === entry.contactId;
    case "wallet":
      return Boolean(m.walletId) && m.walletId === entry.walletId;
    case "asset":
      if (!m.asset || m.asset.toUpperCase() !== entry.asset.toUpperCase()) return false;
      return !m.walletId || m.walletId === entry.walletId;
    case "default":
      return Boolean(m.txType) && m.txType === entry.txType;
    default:
      return false;
  }
}

/** The account code a rule set would give this entry, or undefined. */
export function resolveAccountCode(
  rules: AccountRule[],
  entry: MappableEntry,
): { accountCode: string; ruleId: string } | undefined {
  const matched = rules
    .filter((r) => ruleMatches(r, entry))
    .sort((a, b) => specificity(b) - specificity(a));
  const winner = matched[0];
  return winner ? { accountCode: winner.accountCode, ruleId: winner.id } : undefined;
}

/**
 * Apply rules to entries.
 *
 * Only ever touches rows whose code was set automatically. A human's mapping is
 * the more reliable of the two and must survive a later rule change — Gnosis's
 * own flow has people fixing categorisations by hand, and silently reverting
 * that work is how the feature stops being trusted.
 */
export function applyRules(
  rules: AccountRule[],
  entries: LedgerEntry[],
): { changed: number; entries: LedgerEntry[] } {
  let changed = 0;
  const out = entries.map((e) => {
    if (e.accountCode && e.accountCodeAuto === false) return e;
    const hit = resolveAccountCode(rules, {
      direction: e.direction,
      asset: e.asset,
      txType: e.txType,
      walletId: e.source.kind === "wallet" ? e.source.walletId : undefined,
      contactId: e.counterparty?.contactId,
    });
    if (!hit || hit.accountCode === e.accountCode) return e;
    changed++;
    return { ...e, accountCode: hit.accountCode, accountCodeAuto: true };
  });
  return { changed, entries: out };
}
