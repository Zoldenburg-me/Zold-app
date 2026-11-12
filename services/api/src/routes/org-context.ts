/**
 * Request context for everything under /api/orgs/:orgId.
 *
 * Three separate checks, all of which must pass. Don't merge any two:
 *
 *   1. session   — who is this?            (server.ts owns it)
 *   2. member    — may they reach this org, and as what role?
 *   3. capability— is this feature built, and part of this kind of org?
 *
 * A viewer must not send money (2 catches it), and a personal org must not
 * reach the chart of accounts (3 catches it).
 */

import type express from "express";
import { store } from "../store.js";
import { LIMITS, can, capabilityMatrix, type CapabilityId } from "../domain/plans.js";
import { roleCan, type Permission } from "../domain/roles.js";
import { paymentReviewRequired } from "../domain/payment-review.js";
import { issuerTaxIds } from "../domain/invoicing.js";
import type { Member, Organisation } from "../domain/types.js";

export interface OrgContext {
  org: Organisation;
  member: Member;
  userId: string;
}

export interface SessionResolver {
  (req: express.Request, res: express.Response): { userId: string } | undefined;
}

/**
 * Resolve the org and the caller's membership, answering with the reason on
 * failure. Returns undefined once a response has been sent.
 *
 * Note the 404 on a non-member: an org id is a guessable-ish opaque string, and
 * answering 403 for "exists but not yours" versus 404 for "no such org" leaks
 * which organisations exist. Both answer 404.
 */
export function resolveOrg(
  req: express.Request,
  res: express.Response,
  requireSession: SessionResolver,
): OrgContext | undefined {
  const session = requireSession(req, res);
  if (!session) return undefined;

  const orgId = String(req.params.orgId ?? "");
  const org = store.findOrganisation(orgId);
  const member = org ? store.memberFor(org.id, session.userId) : undefined;

  if (!org || !member || member.status !== "active") {
    res.status(404).json({ error: "no such organisation" });
    return undefined;
  }
  return { org, member, userId: session.userId };
}

/** Role gate. Answers 403 with the role and what it lacks. */
export function requirePermission(
  ctx: OrgContext,
  res: express.Response,
  permission: Permission,
): boolean {
  if (roleCan(ctx.member.role, permission)) return true;
  res.status(403).json({
    error: `Your role (${ctx.member.role}) cannot do this.`,
    role: ctx.member.role,
    needs: permission,
  });
  return false;
}

/** Feature gate: 409 when the feature is not built or not part of this kind
 *  of organisation. No plan decides it; every built feature is free. */
export function requireCapability(
  ctx: OrgContext,
  res: express.Response,
  capability: CapabilityId,
): boolean {
  const verdict = can(ctx.org, capability);
  if (verdict.allowed) return true;
  res.status(409).json({
    error: verdict.reason,
    capability,
    unavailable: verdict.unavailable,
  });
  return false;
}

/** Refuse a create that would cross a service ceiling. Never hides existing rows. */
export function requireWithinLimit(
  ctx: OrgContext,
  res: express.Response,
  limit: keyof typeof LIMITS,
  current: number,
  noun: string,
): boolean {
  const max = LIMITS[limit];
  if (current < max) return true;
  res.status(409).json({
    error: `An organisation can have up to ${max} ${noun}s and this one has ${current}.`,
    limit: max,
    current,
  });
  return false;
}

/** The org as the client should see it. */
export function publicOrg(org: Organisation, member?: Member) {
  return {
    id: org.id,
    type: org.type,
    name: org.name,
    legalName: org.legalName,
    taxId: org.taxId,
    // What invoices print about the issuer, edited on the business profile;
    // the signup tax id fills in until then, only if it passes the check.
    issuerDetails: {
      ...issuerTaxIds(org),
      registerCourt: org.invoicing?.registerCourt,
      registerNumber: org.invoicing?.registerNumber,
      managingDirector: org.invoicing?.managingDirector,
    },
    email: org.email,
    address: org.address,
    reporting: org.reporting,
    verifications: org.verifications,
    notificationEmail: org.notificationEmail,
    createdAt: org.createdAt,
    ...(member ? { role: member.role, memberId: member.id } : {}),
    paymentReview: { ...org.paymentReview, required: paymentReviewRequired(org) },
    capabilities: capabilityMatrix(org),
    limits: LIMITS,
  };
}

/** A member as the client should see it. Invite token hashes never cross. */
export function publicMember(m: Member) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
    status: m.status,
    invitedAt: m.invitedAt,
    acceptedAt: m.acceptedAt,
    deactivatedAt: m.deactivatedAt,
    inviteExpiresAt: m.invite?.expiresAt,
  };
}
