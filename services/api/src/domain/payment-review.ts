/**
 * Whether a payment run needs a second person's review before it is sent.
 *
 * Review is a financial control the org chooses: an owner turns it on or off
 * (POST /api/orgs/:id/payment-review, off takes a fresh passkey approval).
 * Until an owner has chosen, an org that held the business plan or its trial
 * keeps the review it worked under; every other org starts without it, since
 * a one-person company would otherwise have nobody to approve its payments.
 */
import type { Organisation } from "./types.js";

type ReviewOrg = Pick<Organisation, "type" | "plan" | "trial" | "paymentReview">;

export function paymentReviewRequired(org: ReviewOrg): boolean {
  if (org.type !== "business") return false;
  if (org.paymentReview) return org.paymentReview.required;
  return org.plan === "business" || org.trial?.grantsPlan === "business";
}
