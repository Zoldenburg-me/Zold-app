/**
 * The feature matrix, derived from Gnosis Business's own table.
 *
 * Every built feature is free for every organisation: there are no plans to
 * buy and no trial. What still refuses is what a plan never decided — a
 * feature that is not built, or one that is part of the business product and
 * makes no sense on a personal account.
 *
 * Gating is a read-time filter, never a write-time delete: nothing in this
 * codebase removes an org's chart of accounts, tags or history.
 */

import type { OrgType, Organisation } from "./types.js";

export type CapabilityId =
  | "dashboard.balances"
  | "accounts.view"
  | "transfers.send"
  | "transfers.drafts"
  | "payments.history"
  | "contacts.manage"
  | "wallets.manage"
  | "settings.org"
  | "receipts.share"
  | "accounts.multiCurrency"
  | "dashboard.insights"
  | "wallets.detail"
  | "ledger.transactions"
  | "ledger.tags"
  | "ledger.historicalSync"
  | "assets.costBasis"
  | "reports.monthlyBalance"
  | "export.ledger"
  | "settings.reportingCurrency"
  | "invoices"
  // Business-shaped.
  | "members.manage"
  | "transfers.approvals"
  | "transfers.bulkCsv"
  | "coa.manage"
  | "coa.rules"
  | "integrations.accounting"
  // Not built. Modelled so the UI can say why rather than pretending.
  | "cards";

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  /**
   * Org types the capability makes sense for at all. A personal org has one
   * member by definition, so `members.manage` is simply not part of that
   * product.
   */
  orgTypes?: OrgType[];
  /** Set when the capability is not implemented at all. */
  unavailable?: string;
}

const BUSINESS: OrgType[] = ["business"];

const CAPS: CapabilityDefinition[] = [
  { id: "dashboard.balances", label: "Balances and portfolio overview" },
  { id: "accounts.view", label: "View local accounts" },
  { id: "transfers.send", label: "Send and receive" },
  { id: "transfers.drafts", label: "Draft payments" },
  { id: "payments.history", label: "Payment history and export" },
  { id: "contacts.manage", label: "Address book" },
  { id: "wallets.manage", label: "Import and manage wallets" },
  { id: "settings.org", label: "Organisation settings" },
  { id: "receipts.share", label: "Shareable receipts" },
  { id: "accounts.multiCurrency", label: "Local accounts in several currencies" },
  { id: "dashboard.insights", label: "Recent activity, profit and loss, top assets" },
  { id: "wallets.detail", label: "Detailed wallet views and historical sync" },
  { id: "ledger.transactions", label: "Financial transactions" },
  { id: "ledger.tags", label: "Tagging" },
  { id: "ledger.historicalSync", label: "Historical sync" },
  { id: "assets.costBasis", label: "Cost basis, gains and losses" },
  { id: "reports.monthlyBalance", label: "Monthly balance report" },
  { id: "export.ledger", label: "Export transactions" },
  { id: "settings.reportingCurrency", label: "Reporting currency" },
  { id: "invoices", label: "Invoices" },

  { id: "members.manage", label: "Members and roles", orgTypes: BUSINESS },
  { id: "transfers.approvals", label: "Payment review and approval", orgTypes: BUSINESS },
  { id: "transfers.bulkCsv", label: "Bulk payments via CSV", orgTypes: BUSINESS },
  { id: "coa.manage", label: "Chart of accounts", orgTypes: BUSINESS },
  { id: "coa.rules", label: "Account rules automation", orgTypes: BUSINESS },
  { id: "integrations.accounting", label: "Accounting connector (GetMyInvoices)", orgTypes: BUSINESS },

  {
    id: "cards",
    label: "Cards",
    unavailable:
      "Cards are not built. The card rail needs an issuer partner (Immersve is the candidate) and its own KYB, separate from account verification.",
  },
];

export const CAPABILITIES: Record<CapabilityId, CapabilityDefinition> =
  Object.fromEntries(CAPS.map((c) => [c.id, c])) as Record<
    CapabilityId,
    CapabilityDefinition
  >;

/** Ceilings that guard the service, the same for every org. A limit is not a
 *  gate: exceeding one refuses the *create*, it never hides or deletes rows. */
export const LIMITS = {
  accounts: 20,
  members: 50,
  importedWallets: 100,
  /** Rows accepted in one CSV import. Gnosis's own ceiling was 500. */
  bulkCsvRows: 500,
  /** How far back a report may reach, in months. */
  reportMonths: 120,
} as const;

export interface CapabilityVerdict {
  allowed: boolean;
  capability: CapabilityId;
  label: string;
  /** Present when refused: why, in words meant for the person reading them. */
  reason?: string;
  /** Set when the feature does not exist at all. */
  unavailable?: string;
}

/** Whether an org may use a capability. */
export function can(
  org: Pick<Organisation, "type">,
  capability: CapabilityId,
): CapabilityVerdict {
  const def = CAPABILITIES[capability];
  if (!def) {
    return {
      allowed: false,
      capability,
      label: capability,
      reason: `Unknown capability ${capability}.`,
    };
  }
  const base = { capability, label: def.label };

  if (def.unavailable) {
    return { ...base, allowed: false, reason: def.unavailable, unavailable: def.unavailable };
  }

  if (def.orgTypes && !def.orgTypes.includes(org.type)) {
    return {
      ...base,
      allowed: false,
      reason: `${def.label} is part of the business product, not a ${org.type} account.`,
    };
  }

  return { ...base, allowed: true };
}

/** The whole matrix for one org, for the UI. Refused capabilities carry their
 *  reasons so the client can say why in place. */
export function capabilityMatrix(
  org: Pick<Organisation, "type">,
): Record<CapabilityId, CapabilityVerdict> {
  const out: Partial<Record<CapabilityId, CapabilityVerdict>> = {};
  for (const def of CAPS) out[def.id] = can(org, def.id);
  return out as Record<CapabilityId, CapabilityVerdict>;
}
