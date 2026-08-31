/**
 * Plans and the feature matrix, derived from Gnosis Business's own table.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG, and that the rest of this file exists
 * to enforce:
 *
 *  1. Gating is a READ-TIME FILTER, never a write-time delete. A downgraded org
 *     keeps its chart of accounts, its tags and its history; the API refuses to
 *     serve them and the UI offers an upgrade. Gnosis promised exactly this
 *     ("your information isn't lost… all your previous data and settings will
 *     come back automatically") and it is only true if nothing deletes on
 *     downgrade. Nothing in this codebase may delete on downgrade.
 *
 *  2. A trial is a GRANT WITH AN END DATE, not a plan change. `org.plan` is
 *     untouched for the whole trial, so when it lapses the org is back where it
 *     was with no migration and no data touched. One per org, ever.
 *
 * Grants are listed as an explicit set of plans rather than a rank, because
 * `premium` and `business` are siblings, not steps: premium is the paid
 * personal plan and business is the paid organisational one. A numeric rank
 * would force one to imply the other and quietly grant members to a personal
 * account or deny cost-basis to a business.
 */

import type { OrgType, Organisation, PlanId } from "./types.js";

export const PLAN_IDS: PlanId[] = ["starter", "premium", "business"];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Which org types may hold it. `premium` is the personal paid plan. */
  orgTypes: OrgType[];
  price: string;
  blurb: string;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  starter: {
    id: "starter",
    name: "Starter",
    orgTypes: ["personal", "business"],
    price: "Free",
    blurb:
      "One local account, core send and receive, contacts and payment history.",
  },
  premium: {
    id: "premium",
    name: "Premium",
    orgTypes: ["personal"],
    price: "Paid",
    blurb:
      "Local accounts in several currencies, full transaction history with tags and export, cost basis and invoices.",
  },
  business: {
    id: "business",
    name: "Business",
    orgTypes: ["business"],
    price: "Paid",
    blurb:
      "Everything in Premium, plus members and roles, payment approvals, chart of accounts and accounting integrations.",
  },
};

export type CapabilityId =
  // Starter floor — the payouts-only product.
  | "dashboard.balances"
  | "accounts.view"
  | "transfers.send"
  | "transfers.drafts"
  | "payments.history"
  | "contacts.manage"
  | "wallets.manage"
  | "settings.org"
  | "receipts.share"
  // Paid.
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
  /** Plans that grant it. Explicit set, not a rank — see the header. */
  grantedTo: PlanId[];
  /**
   * Org types the capability makes sense for at all. A personal org has one
   * member by definition, so `members.manage` is not something premium should
   * "unlock" — it is simply not part of that product.
   */
  orgTypes?: OrgType[];
  /** Shown on the upgrade prompt. Says what you get, not "upgrade to unlock". */
  upgradeHint?: string;
  /**
   * Set when the capability is not implemented at all. Gating on plan would
   * imply paying makes it appear; this says plainly that it does not exist yet.
   */
  unavailable?: string;
}

const CAPS: CapabilityDefinition[] = [
  // ── Starter floor ────────────────────────────────────────────────────────
  {
    id: "dashboard.balances",
    label: "Balances and portfolio overview",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "accounts.view",
    label: "View local accounts",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "transfers.send",
    label: "Send and receive",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "transfers.drafts",
    label: "Draft payments",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "payments.history",
    label: "Payment history and export",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "contacts.manage",
    label: "Address book",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "wallets.manage",
    label: "Import and manage wallets",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "settings.org",
    label: "Organisation settings",
    grantedTo: ["starter", "premium", "business"],
  },
  {
    id: "receipts.share",
    label: "Shareable receipts",
    grantedTo: ["starter", "premium", "business"],
  },

  // ── Paid ─────────────────────────────────────────────────────────────────
  {
    id: "accounts.multiCurrency",
    label: "Local accounts in several currencies",
    grantedTo: ["premium", "business"],
    upgradeHint:
      "Hold accounts in more than one currency and pay out on each local rail.",
  },
  {
    id: "dashboard.insights",
    label: "Recent activity, profit and loss, top assets",
    grantedTo: ["premium", "business"],
    upgradeHint: "See recent transactions, profit and loss, and your top assets.",
  },
  {
    id: "wallets.detail",
    label: "Detailed wallet views and historical sync",
    grantedTo: ["premium", "business"],
    upgradeHint: "Open a wallet to its full history rather than a balance.",
  },
  {
    id: "ledger.transactions",
    label: "Financial transactions",
    grantedTo: ["premium", "business"],
    upgradeHint: "Every transaction across your accounts and imported wallets.",
  },
  {
    id: "ledger.tags",
    label: "Tagging",
    grantedTo: ["premium", "business"],
    upgradeHint: "Tag transactions and filter by them.",
  },
  {
    id: "ledger.historicalSync",
    label: "Historical sync",
    grantedTo: ["premium", "business"],
    upgradeHint: "Backfill transaction history from before you joined.",
  },
  {
    id: "assets.costBasis",
    label: "Cost basis, gains and losses",
    grantedTo: ["premium", "business"],
    upgradeHint: "FIFO cost basis and realised gain/loss per tax lot.",
  },
  {
    id: "reports.monthlyBalance",
    label: "Monthly balance report",
    grantedTo: ["premium", "business"],
    upgradeHint: "Monthly closing balances by wallet, chain and token.",
  },
  {
    id: "export.ledger",
    label: "Export transactions",
    grantedTo: ["premium", "business"],
    upgradeHint: "Export the full ledger to CSV for your accountant.",
  },
  {
    id: "settings.reportingCurrency",
    label: "Reporting currency",
    grantedTo: ["premium", "business"],
    upgradeHint: "Report in a currency of your choosing.",
  },
  {
    id: "invoices",
    label: "Invoices",
    grantedTo: ["premium", "business"],
    upgradeHint: "Send an invoice link and get paid into your account.",
  },

  // ── Business-shaped ──────────────────────────────────────────────────────
  {
    id: "members.manage",
    label: "Members and roles",
    grantedTo: ["starter", "business"],
    orgTypes: ["business"],
  },
  {
    id: "transfers.approvals",
    label: "Payment review and approval",
    grantedTo: ["business"],
    orgTypes: ["business"],
    upgradeHint:
      "Require a second person to review a payment before it can be sent.",
  },
  {
    id: "transfers.bulkCsv",
    label: "Bulk payments via CSV",
    grantedTo: ["business"],
    orgTypes: ["business"],
    upgradeHint: "Pay up to 500 recipients from one file.",
  },
  {
    id: "coa.manage",
    label: "Chart of accounts",
    grantedTo: ["business"],
    orgTypes: ["business"],
    upgradeHint: "Categorise every transaction against your own accounts.",
  },
  {
    id: "coa.rules",
    label: "Account rules automation",
    grantedTo: ["business"],
    orgTypes: ["business"],
    upgradeHint:
      "Map transactions to accounts automatically by wallet, asset or contact.",
  },
  {
    id: "integrations.accounting",
    label: "Xero and QuickBooks",
    grantedTo: ["business"],
    orgTypes: ["business"],
    upgradeHint: "Sync your transactions into your main ledger.",
  },

  // ── Not built ────────────────────────────────────────────────────────────
  {
    id: "cards",
    label: "Cards",
    grantedTo: [],
    unavailable:
      "Cards are not built. The card rail needs an issuer partner (Immersve is the candidate) and its own KYB, separate from account verification.",
  },
];

export const CAPABILITIES: Record<CapabilityId, CapabilityDefinition> =
  Object.fromEntries(CAPS.map((c) => [c.id, c])) as Record<
    CapabilityId,
    CapabilityDefinition
  >;

/** Per-plan ceilings. A limit is not a gate: exceeding one refuses the *create*,
 *  it never hides or deletes rows already there (see rule 1). */
export interface PlanLimits {
  accounts: number;
  members: number;
  importedWallets: number;
  /** Rows accepted in one CSV import. Gnosis's own ceiling was 500. */
  bulkCsvRows: number;
  /** How far back a report may reach, in months. Gnosis gave trials 3 months
   *  and paid plans everything. */
  reportMonths: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  starter: {
    accounts: 1,
    members: 3,
    importedWallets: 3,
    bulkCsvRows: 0,
    reportMonths: 3,
  },
  premium: {
    accounts: 5,
    members: 1,
    importedWallets: 10,
    bulkCsvRows: 0,
    reportMonths: 120,
  },
  business: {
    accounts: 20,
    members: 50,
    importedWallets: 100,
    bulkCsvRows: 500,
    reportMonths: 120,
  },
};

export const TRIAL_DAYS = 30;

/** The plan a trial grants, by org type. Personal orgs trial `premium`. */
export function trialPlanFor(type: OrgType): PlanId {
  return type === "business" ? "business" : "premium";
}

export function trialIsActive(
  org: Pick<Organisation, "trial">,
  now = new Date(),
): boolean {
  const t = org.trial;
  if (!t || t.endedAt) return false;
  return new Date(t.endsAt).getTime() > now.getTime();
}

/**
 * The plan actually in force right now: the org's plan, or the trial's grant
 * while a trial is running. `org.plan` is deliberately not mutated by a trial,
 * so this is the only correct way to ask.
 */
export function effectivePlan(
  org: Pick<Organisation, "plan" | "trial">,
  now = new Date(),
): PlanId {
  return trialIsActive(org, now) ? org.trial!.grantsPlan : org.plan;
}

export interface CapabilityVerdict {
  allowed: boolean;
  capability: CapabilityId;
  label: string;
  /** Present when refused: why, in words meant for the person reading them. */
  reason?: string;
  /** Present when a paid plan would grant it. Absent when nothing would. */
  requiresPlan?: PlanId[];
  upgradeHint?: string;
  /** Set when the feature does not exist at any price. */
  unavailable?: string;
}

/**
 * Whether an org may use a capability right now.
 *
 * Order matters: "not built" is reported before "not on your plan", because
 * telling someone to upgrade for something that does not exist is a lie that
 * costs them money.
 */
export function can(
  org: Pick<Organisation, "type" | "plan" | "trial">,
  capability: CapabilityId,
  now = new Date(),
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

  const plan = effectivePlan(org, now);
  if (def.grantedTo.includes(plan)) return { ...base, allowed: true };

  // Which plans would grant it, restricted to ones this org type may hold.
  const requiresPlan = def.grantedTo.filter((p) =>
    PLANS[p].orgTypes.includes(org.type),
  );
  return {
    ...base,
    allowed: false,
    reason: requiresPlan.length
      ? `${def.label} is included in ${requiresPlan.map((p) => PLANS[p].name).join(" or ")}.`
      : `${def.label} is not available on a ${org.type} account.`,
    requiresPlan: requiresPlan.length ? requiresPlan : undefined,
    upgradeHint: def.upgradeHint,
  };
}

export function limitsFor(
  org: Pick<Organisation, "type" | "plan" | "trial">,
  now = new Date(),
): PlanLimits {
  return PLAN_LIMITS[effectivePlan(org, now)];
}

/**
 * The whole matrix for one org, for the UI. Refused capabilities are returned
 * WITH their reasons rather than omitted, so the client can render an upgrade
 * prompt in place instead of silently hiding a feature — the difference between
 * a product that sells and one that looks broken.
 */
export function capabilityMatrix(
  org: Pick<Organisation, "type" | "plan" | "trial">,
  now = new Date(),
): Record<CapabilityId, CapabilityVerdict> {
  const out: Partial<Record<CapabilityId, CapabilityVerdict>> = {};
  for (const def of CAPS) out[def.id] = can(org, def.id, now);
  return out as Record<CapabilityId, CapabilityVerdict>;
}

/** Plans an org of this type may actually buy, for the settings page. */
export function plansFor(type: OrgType): PlanDefinition[] {
  return PLAN_IDS.map((id) => PLANS[id]).filter((p) => p.orgTypes.includes(type));
}
