/**
 * Whether a payment run needs a second person's review before it is sent.
 *
 * Review is a paid feature to switch ON, but once an organisation works with
 * it, it is a financial control and no longer a plan perk: a lapsed trial or
 * a downgrade must not remove it on its own. So the org carries its own
 * policy, and only an owner turns review off (POST /api/orgs/:id/payment-review,
 * with a fresh passkey approval). Until something sets it, the plan decides.
 */
import { CAPABILITIES, can } from "./plans.js";
import type { Organisation, PlanId } from "./types.js";

type ReviewOrg = Pick<Organisation, "type" | "plan" | "trial" | "paymentReview">;

const planGrantsReview = (plan: PlanId) => CAPABILITIES["transfers.approvals"].grantedTo.includes(plan);

export function paymentReviewRequired(org: ReviewOrg, now = new Date()): boolean {
  if (org.type !== "business") return false;
  if (org.paymentReview) return org.paymentReview.required;
  if (can(org, "transfers.approvals", now).allowed) return true;
  // A trial that granted review has ended: the org worked under review, so
  // it keeps it until an owner says otherwise.
  return Boolean(org.trial && planGrantsReview(org.trial.grantsPlan));
}

/**
 * The patch that keeps review required when an org moves to `nextPlan`: it
 * records the policy the org had before the change. Nothing when the org
 * already has its own policy, or the next plan includes review anyway.
 */
export function reviewHeldOnPlanChange(
  org: ReviewOrg,
  nextPlan: PlanId,
  now = new Date(),
): Pick<Organisation, "paymentReview"> | Record<string, never> {
  if (org.paymentReview || !paymentReviewRequired(org, now) || planGrantsReview(nextPlan)) return {};
  return { paymentReview: { required: true, changedAt: now.toISOString(), source: "plan_change" } };
}
