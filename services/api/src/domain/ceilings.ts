/**
 * Storage ceilings: how many rows one org or one user may create, whatever
 * the plan. Not product limits (those are plans.ts and answer 402): these sit
 * far above any real use and exist because every row lives in one file that
 * is rewritten on each write, so an account looping on a create would slow
 * every request for everyone. Reaching one answers 409 LIMIT_REACHED.
 */
export const CEILINGS = {
  /** Business orgs one person owns. Every per-org ceiling below bounds one
   *  org; this keeps one person from multiplying them. */
  businessOrgsPerUser: 20,
  contactsPerOrg: 5_000,
  openDraftsPerOrg: 500,
  linesPerDraft: 200,
  openInvoiceLinksPerOrg: 500,
  openPaymentRequestsPerUser: 500,
  documentsPerUserPerDay: 100,
  /** Wallet sync pauses here rather than book past it. */
  ledgerRowsPerOrg: 100_000,
} as const;

export function ceilingRefusal(noun: string, max: number) {
  return {
    error: `There are already ${max.toLocaleString("en")} ${noun}. Close or finish some before adding more, or ask support@zoldhq.com to raise the limit.`,
    code: "LIMIT_REACHED",
    limit: max,
  };
}
