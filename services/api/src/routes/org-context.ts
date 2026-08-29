/**
 * Request context for everything under /api/orgs/:orgId.
 *
 * THREE checks, and all three must pass. They are separate because they answer
 * different questions and collapsing any two of them opens a hole:
 *
 *   1. session   — who is this?            (server.ts owns it)
 *   2. member    — may they reach this org, and as what role?
 *   3. capability— did the ORGANISATION buy this feature?
 *
 * A viewer on a Business plan must not be able to send money (2 catches it),
 * and an owner on Starter must not reach the chart of accounts (3 catches it).
 * A single `isAuthorised` flag would let either through.
 */

import type express from "express";
import { store } from "../store.js";
import { can, capabilityMatrix, effectivePlan, limitsFor, type CapabilityId } from "../domain/plans.js";
import { roleCan, type Permission } from "../domain/roles.js";
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

/**
 * Plan gate. Answers 402 Payment Required with the upgrade path, or 409 when
 * the feature does not exist at any price — a distinction worth keeping, since
 * telling someone to pay for something unbuilt costs them money.
 */
export function requireCapability(
  ctx: OrgContext,
  res: express.Response,
  capability: CapabilityId,
): boolean {
  const verdict = can(ctx.org, capability);
  if (verdict.allowed) return true;
  res.status(verdict.unavailable ? 409 : 402).json({
    error: verdict.reason,
    capability,
    requiresPlan: verdict.requiresPlan,
    upgradeHint: verdict.upgradeHint,
    unavailable: verdict.unavailable,
  });
  return false;
}

/** Refuse a create that would cross a plan ceiling. Never hides existing rows. */
export function requireWithinLimit(
  ctx: OrgContext,
  res: express.Response,
  limit: keyof ReturnType<typeof limitsFor>,
  current: number,
  noun: string,
): boolean {
  const max = limitsFor(ctx.org)[limit];
  if (current < max) return true;
  res.status(402).json({
    error: `Your plan allows ${max} ${noun}${max === 1 ? "" : "s"} and you have ${current}.`,
    limit: max,
    current,
  });
  return false;
}

/** The org as the client should see it, with its plan state resolved. */
export function publicOrg(org: Organisation, member?: Member) {
  return {
    id: org.id,
    type: org.type,
    name: org.name,
    legalName: org.legalName,
    taxId: org.taxId,
    email: org.email,
    address: org.address,
    plan: org.plan,
    effectivePlan: effectivePlan(org),
    trial: org.trial,
    reporting: org.reporting,
    verifications: org.verifications,
    notificationEmail: org.notificationEmail,
    createdAt: org.createdAt,
    ...(member ? { role: member.role, memberId: member.id } : {}),
    capabilities: capabilityMatrix(org),
    limits: limitsFor(org),
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
