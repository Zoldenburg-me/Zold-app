/**
 * /api/orgs — organisations, members, plans, accounts, contacts, wallets.
 *
 * A router factory rather than a module that imports the app, so server.ts
 * keeps ownership of authentication and this file cannot quietly acquire a
 * second way to decide who is calling.
 */

import { safeBooksStart } from "../domain/safe-books.js";
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../store.js";
import {
  publicMember,
  publicOrg,
  requireCapability,
  requirePermission,
  requireWithinLimit,
  resolveOrg,
  type OrgContext,
  type SessionResolver,
} from "./org-context.js";
import {
  CURRENCY_REGISTRY,
  currencyAvailability,
  defaultLabel,
  initialStatusFor,
  isCurrencyCode,
  suggestedCurrency,
} from "../domain/accounts.js";
import {
  PLANS,
  TRIAL_DAYS,
  can,
  effectivePlan,
  limitsFor,
  plansFor,
  trialIsActive,
  trialPlanFor,
} from "../domain/plans.js";
import { ROLES, type Account, type OrgType, type Organisation, type PlanId, type Role } from "../domain/types.js";
import { ADDRESS_RE, ContactError, validateBankAccount, validateWallet } from "../domain/contacts.js";
import { hashToken } from "../domain/invoices.js";
import { emailIsProven, roleCan, wouldOrphanOrg } from "../domain/roles.js";
import { CHAIN_ID, KYC } from "../config.js";
import { wrap } from "./util.js";
import { hashMessage } from "viem";
import { auditEntry } from "../audit.js";
import { newChallenge, parseSignature, publicWallet } from "../domain/wallet-ownership.js";
import { verifyOwnership } from "../wallet-sync/ownership.js";
import { walletEntryId } from "../domain/wallet-transfers.js";
import { accountProfileStanding } from "../domain/monerium-profile.js";
import { cleanName, sameName } from "../users/display-name.js";
import { adoptionHint, auditProfileCheck, checkBackingProfile, profileWait } from "../adapters/monerium-profile.js";
import { emailLooksValid } from "../domain/email.js";
import { CEILINGS, ceilingRefusal } from "../domain/ceilings.js";
import { paymentReviewRequired, reviewHeldOnPlanChange } from "../domain/payment-review.js";
import { verifyPasskeyStepUp } from "./auth.js";

const INVITE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // Gnosis expired invites at 3 days
/** An organisation's name and legal name, in characters. */
const ORG_NAME_MAX = 120;
/** A contact's (payee's) name, in characters. */
const CONTACT_NAME_MAX = 200;

/** Why an EUR account with no IBAN behind it cannot send, and what connects
 *  one, in the words the Accounts screen shows: no API field names. */
function noIbanGate(type: OrgType): NonNullable<Account["gate"]> {
  return type === "business"
    ? {
        reason: "No IBAN is connected to this account yet, so nothing can be sent from it.",
        needs: "the company’s IBAN from its company profile at Monerium. Once Monerium has issued it, connect it here.",
      }
    : {
        reason: "No IBAN is connected to this account yet, so nothing can be sent from it.",
        needs: "your own IBAN from Monerium. Once it is issued, fund this account from it.",
      };
}

/**
 * The gate an account shows, from what it lacks when it is read. A row's
 * stored `gate` keeps the wording it was opened with, so it is only the
 * fallback.
 */
function gateOf(org: Pick<Organisation, "type">, a: Account): Account["gate"] {
  if (a.status !== "gated") return undefined;
  if (a.currency === "EUR" && !a.backingUserId) return noIbanGate(org.type);
  return initialStatusFor(a.currency).gate ?? a.gate;
}

/** An account as the API returns it: read-time gate and profile standing. */
function accountView(org: Organisation, a: Account) {
  // Who backs it, by the name members already see on Members: Home says
  // "Spends from Jonas's account" instead of a bare user id.
  const backer = a.backingUserId
    ? store.membersOf(org.id).find((m) => m.userId === a.backingUserId && m.status === "active")
    : undefined;
  return {
    ...a, gate: gateOf(org, a), profile: accountProfileStanding(org, a),
    // As Members shows them: the name, else the email.
    ...(backer?.name || backer?.email ? { backingMemberName: backer.name || backer.email } : {}),
  };
}

/**
 * A Safe belongs to one organisation: the company whose active account it
 * backs. The person's own (personal) space does not count, since connecting
 * the Safe to a company is how it moves there. Returns that company, if it is
 * not `orgId`.
 */
export function safeTakenBy(userId: string, orgId: string): { id: string; name: string } | undefined {
  for (const a of store.accounts) {
    if (a.backingUserId !== userId || a.orgId === orgId || a.status !== "active") continue;
    const other = store.findOrganisation(a.orgId);
    if (other?.type === "business") return { id: other.id, name: other.name };
  }
  return undefined;
}

const safeTakenError = (o: { name: string }) =>
  `Your account is connected to ${o.name}, and an account belongs to one organisation. It can't be connected here as well.`;

export function createOrgRouter(requireSession: SessionResolver): express.Router {
  const r = express.Router();
  const ctxOf = (req: express.Request, res: express.Response) =>
    resolveOrg(req, res, requireSession);

  // ── Reference data (no org needed) ────────────────────────────────────────

  /** Which currencies exist and which are actually open. The client renders
   *  the gated ones with their `needs` line rather than hiding them. */
  r.get("/currencies", (_req, res) => {
    res.json({ currencies: currencyAvailability() });
  });

  r.get("/plans", (req, res) => {
    const type = (req.query.type === "business" ? "business" : "personal") as OrgType;
    res.json({ plans: plansFor(type), trialDays: TRIAL_DAYS });
  });

  // ── Organisations ─────────────────────────────────────────────────────────

  /** Every org this session can reach. The app's org switcher reads this. */
  r.get("/", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    res.json({
      organisations: store
        .organisationsForUser(session.userId)
        .map(({ org, member }) => publicOrg(org, member)),
    });
  });

  r.post("/", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;

    const { name, type, country, legalName, taxId, email } = req.body ?? {};
    const orgType: OrgType = type === "business" ? "business" : "personal";
    // Printed on invoices and documents: the same rule as a person's name.
    const orgName = cleanName(name, { min: 2, max: ORG_NAME_MAX });
    if (orgName === null) {
      return res.status(400).json({ code: "NAME_INVALID", error: `An organisation needs a name of 2 to ${ORG_NAME_MAX} characters, without hidden or control characters.` });
    }
    const orgLegalName = typeof legalName === "string" && legalName.trim() ? cleanName(legalName, { min: 2, max: ORG_NAME_MAX }) : undefined;
    if (orgLegalName === null) {
      return res.status(400).json({ code: "NAME_INVALID", error: `The legal name needs 2 to ${ORG_NAME_MAX} characters, without hidden or control characters.` });
    }
    if (typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country)) {
      return res
        .status(400)
        .json({ error: "Country must be an ISO 3166-1 alpha-2 code, e.g. DE." });
    }

    /**
     * A personal org is the person's own books, so there is one per person,
     * and none for a company login: its Safe and IBAN are the company's.
     */
    if (orgType === "personal") {
      if (store.findUser(session.userId)?.accountType === "company") {
        return res.status(409).json({
          code: "PERSONAL_ORG_COMPANY_LOGIN",
          error: "This is a company login, so it has no personal space. For your own money, sign up for Zold as a person with your own email.",
        });
      }
      if (store.organisationsForUser(session.userId).some(({ org: o }) => o.type === "personal")) {
        return res.status(409).json({ code: "PERSONAL_ORG_EXISTS", error: "You already have a personal space." });
      }
    }

    const now = new Date().toISOString();
    const org: Organisation = {
      id: `org_${randomUUID()}`,
      type: orgType,
      name: orgName,
      legalName: orgLegalName,
      taxId: typeof taxId === "string" ? taxId.trim() : undefined,
      email: typeof email === "string" ? email.trim() : undefined,
      address: { country: country.toUpperCase() },
      plan: "starter",
      reporting: {
        // Reporting currency follows the local currency where we know it, so a
        // German business does not start out reporting in something else.
        currency: suggestedCurrency({ address: { country: country.toUpperCase() } }),
        timeZone: "Europe/Berlin",
        costBasisMethod: "FIFO",
      },
      verifications: {},
      createdAt: now,
      updatedAt: now,
    };
    store.addOrganisation(org);

    const member = store.addMember({
      id: `mem_${randomUUID()}`,
      orgId: org.id,
      userId: session.userId,
      email: org.email ?? "",
      role: "owner",
      status: "active",
      invitedAt: now,
      acceptedAt: now,
    });

    /**
     * A company signup's first business org is the company that login was
     * made for, so it gets its EUR account now and the Accounts screen is not
     * empty. Without an IBAN behind it: the owner connects the company's IBAN
     * (POST .../fund) once Monerium has issued it, and that call is the live
     * profile check. Any further business org opens its accounts by hand.
     */
    const caller = store.findUser(session.userId);
    const firstCompanyOrg =
      orgType === "business" &&
      caller?.accountType === "company" &&
      !store.organisationsForUser(session.userId).some(({ org: o }) => o.id !== org.id && o.type === "business");
    if (firstCompanyOrg) {
      store.addAccount({
        id: `acc_${randomUUID()}`,
        orgId: org.id,
        currency: "EUR",
        label: defaultLabel("EUR"),
        status: "gated",
        provider: CURRENCY_REGISTRY.EUR.provider,
        identifier: {},
        gate: noIbanGate("business"),
        createdAt: now,
        updatedAt: now,
      });
    }

    res.status(201).json({ organisation: publicOrg(org, member) });
  });

  r.get("/:orgId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    res.json({ organisation: publicOrg(ctx.org, ctx.member) });
  });

  r.patch("/:orgId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.update")) return;

    const patch: Partial<Organisation> = {};
    const b = req.body ?? {};
    // Settings sends every field on save: a name it did not change is left as
    // stored, so one an older rule let in does not block the rest of the save.
    if (typeof b.name === "string" && !sameName(b.name, ctx.org.name)) {
      const n = cleanName(b.name, { min: 2, max: ORG_NAME_MAX });
      if (n === null) return res.status(400).json({ code: "NAME_INVALID", error: `The name needs 2 to ${ORG_NAME_MAX} characters, without hidden or control characters.` });
      patch.name = n;
    }
    // A personal space is named after its person: one name, changed in the app.
    if (ctx.org.type === "personal" && patch.name !== undefined) {
      return res.status(409).json({
        code: "PERSONAL_ORG_NAME",
        error: "Your personal space is named after you. Change your name in the Zold app, under Profile.",
      });
    }
    if (typeof b.legalName === "string" && !sameName(b.legalName, ctx.org.legalName ?? "")) {
      // Empty clears it; anything else follows the name rule.
      const n = b.legalName.trim() ? cleanName(b.legalName, { min: 2, max: ORG_NAME_MAX }) : "";
      if (n === null) return res.status(400).json({ code: "NAME_INVALID", error: `The legal name needs 2 to ${ORG_NAME_MAX} characters, without hidden or control characters.` });
      patch.legalName = n;
    }
    if (typeof b.taxId === "string") patch.taxId = b.taxId.trim();
    if (typeof b.email === "string") patch.email = b.email.trim();
    if (typeof b.notificationEmail === "string") {
      patch.notificationEmail = b.notificationEmail.trim();
    }
    if (b.address && typeof b.address === "object") {
      const country = String(b.address.country ?? ctx.org.address?.country ?? "");
      if (!/^[A-Za-z]{2}$/.test(country)) {
        return res.status(400).json({ error: "Country must be an alpha-2 code." });
      }
      // Only the known fields, as strings — the body is untrusted and the
      // address is printed verbatim on issued invoices.
      const next = { ...ctx.org.address, country: country.toUpperCase() };
      for (const k of ["line1", "line2", "city", "postalCode", "stateOrProvince"] as const) {
        if (typeof b.address[k] === "string") {
          const v = b.address[k].trim();
          if (v) next[k] = v; else delete next[k];
        }
      }
      patch.address = next;
    }
    if (b.reporting && typeof b.reporting === "object") {
      const next = { ...ctx.org.reporting };
      if (typeof b.reporting.timeZone === "string") next.timeZone = b.reporting.timeZone;
      // Reporting currency is a paid feature — Gnosis reserved it for Business.
      if (
        typeof b.reporting.currency === "string" &&
        b.reporting.currency !== ctx.org.reporting.currency
      ) {
        if (!requireCapability(ctx, res, "settings.reportingCurrency")) return;
        next.currency = b.reporting.currency.toUpperCase();
      }
      patch.reporting = next;
    }

    res.json({ organisation: publicOrg(store.updateOrganisation(ctx.org.id, patch), ctx.member) });
  });

  // ── Plan and trial ────────────────────────────────────────────────────────

  r.get("/:orgId/plan", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    res.json({
      plan: ctx.org.plan,
      effectivePlan: effectivePlan(ctx.org),
      trial: ctx.org.trial,
      trialAvailable: !ctx.org.trial,
      trialDays: TRIAL_DAYS,
      available: plansFor(ctx.org.type),
    });
  });

  /**
   * Start the one trial this org gets.
   *
   * A trial is a grant with an end date, not a plan change: `org.plan` is left
   * alone so lapsing needs no migration and touches no data.
   */
  r.post("/:orgId/plan/trial", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.billing")) return;
    if (ctx.org.trial) {
      return res.status(409).json({
        error: trialIsActive(ctx.org)
          ? "This organisation is already on its trial."
          : "This organisation has already used its trial. Each one gets a single 30-day trial.",
        trial: ctx.org.trial,
      });
    }
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const org = store.updateOrganisation(ctx.org.id, {
      trial: {
        grantsPlan: trialPlanFor(ctx.org.type),
        startedAt: startedAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });
    res.json({ organisation: publicOrg(org, ctx.member) });
  });

  /**
   * Change plan.
   *
   * A downgrade deletes nothing: the chart of accounts, tags and history stay
   * in the store and are just not served until the org upgrades again. No code
   * path here may remove rows.
   */
  r.post("/:orgId/plan", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.billing")) return;

    const plan = String(req.body?.plan ?? "");
    const allowed: string[] = plansFor(ctx.org.type).map((p) => p.id);
    if (!allowed.includes(plan)) {
      return res.status(400).json({
        error: `A ${ctx.org.type} organisation can hold ${allowed.join(" or ")}.`,
      });
    }
    // There is no billing, so an owner cannot buy a paid plan here: a click
    // that grants one is a paywall that charges nothing. Moving onto a paid
    // plan is an operator grant (POST /api/admin/orgs/:orgId/plan); the
    // 30-day trial is the self-serve way in. Downgrading stays open.
    if (PLANS[plan as PlanId].price !== "Free" && plan !== ctx.org.plan) {
      return res.status(402).json({
        error: `${PLANS[plan as PlanId].name} is a paid plan and Zold takes no payments yet, so it cannot be switched on here. Start the trial, or ask Zold to grant it.`,
        code: "PAID_PLAN_NEEDS_GRANT",
      });
    }
    const org = store.updateOrganisation(ctx.org.id, {
      plan: plan as Organisation["plan"],
      ...reviewHeldOnPlanChange(ctx.org, plan as PlanId),
      // A real plan change supersedes a running trial rather than stacking.
      ...(trialIsActive(ctx.org)
        ? { trial: { ...ctx.org.trial!, endedAt: new Date().toISOString() } }
        : {}),
    });
    res.json({
      organisation: publicOrg(org, ctx.member),
      note:
        plan === "starter"
          ? "Business features are paused, not deleted. Your chart of accounts, tags and history are kept and return if you upgrade again."
          : undefined,
    });
  });

  // ── Payment review policy ─────────────────────────────────────────────────

  /**
   * Turn payment review on or off for this organisation.
   *
   * Off removes a financial control, so it takes an owner and a fresh passkey
   * approval, on any plan: a downgraded org must be able to make the choice
   * the plan no longer makes for it. On is the paid feature, so it needs the
   * plan. Drafts already waiting for review keep waiting either way.
   */
  r.post("/:orgId/payment-review", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "payments.policy")) return;
    if (ctx.org.type !== "business") {
      return res.status(400).json({ error: "Payment review is part of the business product." });
    }
    if (typeof req.body?.required !== "boolean") {
      return res.status(400).json({ error: "Say whether review is required: { required: true | false }." });
    }
    const required: boolean = req.body.required;
    const was = paymentReviewRequired(ctx.org);
    if (required && !was && !requireCapability(ctx, res, "transfers.approvals")) return;
    if (!required && was) {
      const user = store.findUser(ctx.userId);
      if (!user) return res.status(401).json({ error: "no such user" });
      if (!(await verifyPasskeyStepUp(user, req.body, res))) return;
    }
    const org = store.updateOrganisation(ctx.org.id, {
      paymentReview: { required, changedAt: new Date().toISOString(), source: "owner", changedByMemberId: ctx.member.id },
    });
    if (required !== was) {
      store.audit(auditEntry("org.payment_review_changed", { orgId: org.id, required, memberId: ctx.member.id }, ctx.userId));
    }
    res.json({ organisation: publicOrg(org, ctx.member) });
  }));

  // ── Members ───────────────────────────────────────────────────────────────

  r.get("/:orgId/members", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "members.read")) return;
    res.json({ members: store.membersOf(ctx.org.id).map(publicMember) });
  });

  r.post("/:orgId/members", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "members.manage")) return;
    if (!requirePermission(ctx, res, "members.invite")) return;

    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const role = String(req.body?.role ?? "viewer") as Role;
    if (!emailLooksValid(email)) {
      return res.status(400).json({ error: "A member needs a valid email address." });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}.` });
    }
    // Optional, and shown on Members until they accept: the person name rule.
    const rawName = req.body?.name;
    const inviteName = typeof rawName === "string" && rawName.trim() ? cleanName(rawName, { min: 1, max: 120 }) : undefined;
    if (inviteName === null) {
      return res.status(400).json({ code: "NAME_INVALID", error: "The name needs 1 to 120 characters, without hidden or control characters." });
    }
    // Only an owner may mint another owner; otherwise an admin could promote
    // themselves past the person who pays the bill.
    if (role === "owner" && ctx.member.role !== "owner") {
      return res.status(403).json({ error: "Only an owner can invite another owner." });
    }
    const existing = store
      .membersOf(ctx.org.id)
      .find((m) => m.email.toLowerCase() === email && m.status !== "deactivated");
    if (existing) {
      return res.status(409).json({ error: `${email} is already on this organisation.` });
    }
    const active = store.membersOf(ctx.org.id).filter((m) => m.status !== "deactivated");
    if (!requireWithinLimit(ctx, res, "members", active.length, "member")) return;

    // The plaintext token is returned exactly once and is not recoverable.
    const token = randomBytes(24).toString("base64url");
    const member = store.addMember({
      id: `mem_${randomUUID()}`,
      orgId: ctx.org.id,
      email,
      name: inviteName,
      role,
      status: "invited",
      invite: {
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        invitedBy: ctx.member.id,
        message: typeof req.body?.message === "string" ? req.body.message : undefined,
      },
      invitedAt: new Date().toISOString(),
    });

    res.status(201).json({
      member: publicMember(member),
      // The caller sends this on; we have no mail transport, and pretending to
      // have sent an email nobody receives is worse than saying so.
      inviteToken: token,
      note: "Send this link yourself — this deployment has no mail transport, so no invitation email was sent.",
    });
  });

  r.patch("/:orgId/members/:memberId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "members.manage")) return;
    if (!requirePermission(ctx, res, "members.update")) return;

    const member = store.findMember(String(req.params.memberId));
    if (!member || member.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such member" });
    }
    // Checked before either field: an admin deactivating an owner is the
    // same escalation as demoting one, reached through the other field.
    if (member.role === "owner" && ctx.member.role !== "owner") {
      return res.status(403).json({ error: "Only an owner can change an owner." });
    }
    const next: { role?: Role; status?: string } = {};
    if (req.body?.role !== undefined) {
      const role = String(req.body.role) as Role;
      if (!ROLES.includes(role)) {
        return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}.` });
      }
      if (role === "owner" && ctx.member.role !== "owner") {
        return res.status(403).json({ error: "Only an owner can make another owner." });
      }
      next.role = role;
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!["active", "deactivated"].includes(status)) {
        return res.status(400).json({ error: "Status must be active or deactivated." });
      }
      // An invited row has no login behind it; activating it by hand would
      // make a member nobody can be, and strand the invitee's own accept.
      if (status === "active" && !member.userId) {
        return res.status(409).json({ error: "That person has not accepted their invitation yet." });
      }
      next.status = status;
    }

    // An org must never lose its last owner — by role change or deactivation,
    // which are the same hole reached two ways.
    if (wouldOrphanOrg(store.membersOf(ctx.org.id), member.id, next)) {
      return res.status(409).json({
        error:
          "That would leave the organisation with no active owner. Make someone else an owner first.",
      });
    }

    const patch: Record<string, unknown> = { ...next };
    if (next.status === "deactivated") patch.deactivatedAt = new Date().toISOString();
    if (next.status === "active") patch.deactivatedAt = undefined;
    res.json({ member: publicMember(store.updateMember(member.id, patch)) });
  });

  /** Accept an invitation. The invitation was addressed to an email, so the
   *  accepting session must belong to an account that has PROVEN it controls
   *  that email — the token alone is a link anyone could have been forwarded,
   *  and the account's email field is whatever was typed at signup. */
  r.post("/invites/accept", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const token = String(req.body?.token ?? "");
    if (!token) return res.status(400).json({ error: "An invitation token is required." });

    const member = store.findMemberByInviteHash(hashToken(token));
    if (!member || member.status !== "invited") {
      return res.status(404).json({ error: "That invitation is not valid." });
    }
    if (Date.now() > Date.parse(member.invite!.expiresAt)) {
      return res.status(410).json({
        error: "That invitation has expired. Invitations last 3 days — ask for a new one.",
      });
    }
    const user = store.findUser(session.userId);
    if (!user?.email || user.email.trim().toLowerCase() !== member.email.toLowerCase()) {
      return res.status(403).json({ error: "This invitation was sent to a different email address." });
    }
    // Typing the address at signup proves nothing; a code sent to it does.
    // KYC.autoApprove is the harness seam (hardhat 31337 only, refused in
    // production) that approves test identities up front.
    if (!emailIsProven(user, member.email) && !KYC.autoApprove) {
      return res.status(403).json({
        error:
          "Confirm you own this email first: add it as your email recovery channel (Settings → Recovery), enter the code it receives, then open the invitation again.",
        code: "EMAIL_UNVERIFIED",
      });
    }
    const existing = store.memberFor(member.orgId, session.userId);
    if (existing && existing.status !== "deactivated") {
      return res.status(409).json({ error: "You are already on this organisation." });
    }
    const accepted = store.updateMember(member.id, {
      userId: session.userId,
      status: "active",
      acceptedAt: new Date().toISOString(),
      invite: undefined, // spend the token
    });
    const org = store.findOrganisation(member.orgId)!;
    res.json({ organisation: publicOrg(org, accepted), member: publicMember(accepted) });
  });

  // ── Accounts ──────────────────────────────────────────────────────────────

  r.get("/:orgId/accounts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "accounts.read")) return;
    const accounts = store.accountsOf(ctx.org.id);
    const caller = store.findUser(ctx.userId);
    const adoption = roleCan(ctx.member.role, "accounts.open")
      ? adoptionHint(ctx.org, caller)
      : { allowed: false, reason: `Your role (${ctx.member.role}) cannot open or fund accounts.` };
    res.json({
      // `gate` and `profile` are derived here, at read time: no row is
      // rewritten when the wording or the Monerium check changes.
      accounts: accounts.map((a) => accountView(ctx.org, a)),
      // Whether "fund from my account" would pass, from stored facts only, so
      // the UI offers it only where the API would accept it.
      adoption,
      // Monerium has not approved the caller's profile yet (as last seen), so
      // connecting would be refused until it does.
      ...(adoption.allowed ? { profileWait: profileWait(caller) } : {}),
      mayManageAccounts: roleCan(ctx.member.role, "accounts.open"),
      currencies: currencyAvailability(),
      // What a second account would cost, so the UI can show the ceiling
      // before the user hits it rather than after.
      canOpenMore: accounts.length < limitsFor(ctx.org).accounts,
    });
  });

  r.post("/:orgId/accounts", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "accounts.open")) return;

    const currency = String(req.body?.currency ?? "").toUpperCase();
    if (!isCurrencyCode(currency)) {
      return res.status(400).json({
        error: `Unknown currency ${currency}.`,
        currencies: currencyAvailability(),
      });
    }
    const existing = store.accountsOf(ctx.org.id);
    if (existing.some((a) => a.currency === currency)) {
      return res
        .status(409)
        .json({ error: `This organisation already has a ${currency} account.` });
    }
    // A second currency is the paid feature; the first one is not.
    if (existing.length >= 1 && !requireCapability(ctx, res, "accounts.multiCurrency")) return;
    if (!requireWithinLimit(ctx, res, "accounts", existing.length, "account")) return;

    const initial = initialStatusFor(currency);
    const now = new Date().toISOString();

    /**
     * Where the money comes from.
     *
     * Per-organisation provisioning (a Safe and a Monerium profile per org) is
     * not built. Until it is, the only spendable account is one backed by a
     * person's funded account, so an org either adopts the caller's or has no
     * funding identity and says so.
     *
     * A personal org adopts automatically, since it is that person. A business
     * org must opt in (`useMyAccount: true`), because funding the company from
     * someone's own wallet should be an explicit choice. `backingUserId`
     * records whose device key can sign; spending authority does not follow a
     * membership change.
     *
     * The caller's Monerium profile must match the org: `corporate` for a
     * business, `personal` for a personal org (domain/monerium-profile.ts).
     * A member's personal IBAN cannot back a company.
     */
    const caller = store.findUser(ctx.userId);
    const callerFunded =
      caller && caller.iban && caller.funding?.status === "active" ? caller : undefined;
    const wantsAdoption =
      currency === "EUR" &&
      Boolean(callerFunded) &&
      (ctx.org.type === "personal" || req.body?.useMyAccount === true);

    /**
     * An account nobody can fund is `gated`, with a reason. `provisioning`
     * would imply work in progress; with no per-organisation provisioning the
     * account would stay there forever and look like a stuck job.
     */
    // Whose IBAN is it? Monerium's answer, on the caller's own credentials,
    // before anything is written. A refusal (or Monerium not answering)
    // refuses the whole request: nothing is opened half-adopted.
    let profileRecord: NonNullable<Account["moneriumProfile"]> | undefined;
    let profileWarning: string | undefined;
    const takenBy = wantsAdoption ? safeTakenBy(callerFunded!.id, ctx.org.id) : undefined;
    if (takenBy) return res.status(409).json({ error: safeTakenError(takenBy), code: "SAFE_IN_OTHER_ORG" });
    if (wantsAdoption) {
      const checked = await checkBackingProfile(ctx.org, callerFunded!);
      auditProfileCheck("adopt", { orgId: ctx.org.id }, callerFunded!.id, checked, ctx.userId);
      if (!checked.ok) {
        return res.status(checked.status).json({ error: checked.error, code: checked.code });
      }
      profileRecord = checked.record;
      profileWarning = checked.warning;
      // The Monerium read is an await: a parallel open may have landed in it.
      if (store.accountsOf(ctx.org.id).some((a) => a.currency === currency)) {
        return res.status(409).json({ error: `This organisation already has a ${currency} account.` });
      }
      const lateTaken = safeTakenBy(callerFunded!.id, ctx.org.id);
      if (lateTaken) return res.status(409).json({ error: safeTakenError(lateTaken), code: "SAFE_IN_OTHER_ORG" });
    }

    const status = wantsAdoption ? "active" : "gated";
    const gate = wantsAdoption
      ? undefined
      : (initial.gate ?? noIbanGate(ctx.org.type));

    const account = store.addAccount({
      id: `acc_${randomUUID()}`,
      orgId: ctx.org.id,
      currency,
      label: String(req.body?.label ?? "").trim() || defaultLabel(currency),
      status,
      provider: CURRENCY_REGISTRY[currency].provider,
      identifier: wantsAdoption ? { iban: callerFunded!.iban } : {},
      address: wantsAdoption ? callerFunded!.address : undefined,
      backingUserId: wantsAdoption ? callerFunded!.id : undefined,
      ...(wantsAdoption ? { backedSince: safeBooksStart(callerFunded!) } : {}),
      ...(profileRecord ? { moneriumProfile: profileRecord } : {}),
      gate,
      createdAt: now,
      updatedAt: now,
    });

    let note: string | undefined;
    if (account.status === "gated") {
      note = currency === "EUR"
        ? `Opened. ${account.gate?.reason} It needs ${account.gate?.needs}`
        : `Recorded, but ${CURRENCY_REGISTRY[currency].name} accounts cannot be opened yet: ${account.gate?.needs}`;
    } else if (wantsAdoption && ctx.org.type === "business") {
      note = `This organisation is now funded from the Monerium company profile${profileRecord?.name ? ` "${profileRecord.name}"` : ""} connected to your login. Only your device key can authorise its payments.`;
    }

    res.status(201).json({
      account: accountView(ctx.org, account),
      note,
      ...(profileWarning ? { warning: profileWarning } : {}),
    });
  }));

  /**
   * Give an existing account a funding identity, from the caller's own account.
   * Refused while the caller's Safe is connected to another company
   * (safeTakenBy).
   *
   * A separate endpoint because this is when a person's own balance starts
   * paying an organisation's bills: it gets its own call, permission check and
   * plain-language response.
   */
  r.post("/:orgId/accounts/:accountId/fund", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "accounts.open")) return;

    const account = store.findAccount(String(req.params.accountId));
    if (!account || account.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such account" });
    }
    if (account.backingUserId) {
      return res.status(409).json({
        error:
          account.backingUserId === ctx.userId
            ? "This account is already funded by your account."
            : "This account is already funded by another member's account. Only they can authorise its payments.",
      });
    }
    if (account.currency !== "EUR") {
      // A row can carry a currency the registry no longer lists.
      const def = CURRENCY_REGISTRY[account.currency];
      return res.status(409).json({
        error: `${def?.name ?? account.currency} cannot be funded this way: ${def?.needs ?? "no rail"}`,
      });
    }
    // `active` is set exactly when Monerium attributed an IBAN to the Safe
    // (activation), so the status alone is the funded test; the hardhat
    // harness marks its auto-approved accounts active with no IBAN.
    const caller = store.findUser(ctx.userId);
    if (caller?.funding?.status !== "active") {
      return res.status(409).json({
        error:
          "Your own account is not funded yet, so it cannot fund this organisation. Add money to your account first.",
      });
    }

    const takenBy = safeTakenBy(caller.id, ctx.org.id);
    if (takenBy) return res.status(409).json({ error: safeTakenError(takenBy), code: "SAFE_IN_OTHER_ORG" });

    // The account stays gated on any refusal, including Monerium not
    // answering: fail closed, write nothing.
    const checked = await checkBackingProfile(ctx.org, caller);
    auditProfileCheck("fund", { orgId: ctx.org.id, accountId: account.id }, caller.id, checked, ctx.userId);
    if (!checked.ok) {
      return res.status(checked.status).json({ error: checked.error, code: checked.code });
    }
    // The Monerium read is an await: another adoption may have landed in it.
    if (store.findAccount(account.id)?.backingUserId) {
      return res.status(409).json({ error: "This account was funded by another request while we checked with Monerium." });
    }
    const lateTaken = safeTakenBy(caller.id, ctx.org.id);
    if (lateTaken) return res.status(409).json({ error: safeTakenError(lateTaken), code: "SAFE_IN_OTHER_ORG" });

    const funded = store.updateAccount(account.id, {
      status: "active",
      identifier: { iban: caller.iban },
      address: caller.address,
      backingUserId: caller.id,
      backedSince: safeBooksStart(caller),
      moneriumProfile: checked.record,
      gate: undefined,
    });
    res.json({
      account: accountView(ctx.org, funded),
      note:
        ctx.org.type === "business"
          ? `This organisation is now funded from the Monerium company profile${checked.record.name ? ` "${checked.record.name}"` : ""} connected to your login. Only your device key can authorise its payments.`
          : "Funded from your account.",
      ...(checked.warning ? { warning: checked.warning } : {}),
    });
  }));

  /**
   * Check an adopted account's Monerium profile again, on the backing user's
   * own credentials. How an account adopted before the check existed (or
   * whose profile Monerium has since approved) becomes sendable. Records the
   * result only when it passes; a refusal changes nothing.
   */
  r.post("/:orgId/accounts/:accountId/profile-check", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "accounts.open")) return;

    const account = store.findAccount(String(req.params.accountId));
    if (!account || account.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such account" });
    }
    const backer = account.backingUserId ? store.findUser(account.backingUserId) : undefined;
    if (!backer) {
      return res.status(409).json({ error: "This account has no funding identity, so there is no Monerium profile to check." });
    }
    const checked = await checkBackingProfile(ctx.org, backer);
    auditProfileCheck("recheck", { orgId: ctx.org.id, accountId: account.id }, backer.id, checked, ctx.userId);
    if (!checked.ok) {
      return res.status(checked.status).json({ error: checked.error, code: checked.code });
    }
    const updated = store.updateAccount(account.id, { moneriumProfile: checked.record });
    res.json({
      account: accountView(ctx.org, updated),
      ...(checked.warning ? { warning: checked.warning } : {}),
    });
  }));

  // ── Contacts (the address book) ───────────────────────────────────────────

  r.get("/:orgId/contacts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.read")) return;
    // A payer rule belongs to invoicing: without that capability it is left
    // out of the answer, and stays on the row.
    const showRules = can(ctx.org, "invoices").allowed;
    res.json({
      contacts: store.contactsOf(ctx.org.id).map((c) => (showRules ? c : { ...c, payerRule: undefined })),
    });
  });

  r.post("/:orgId/contacts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.manage")) return;

    // A payee: printed on payment runs and documents, so the name rule applies.
    const name = cleanName(req.body?.name, { min: 2, max: CONTACT_NAME_MAX });
    if (name === null) return res.status(400).json({ code: "NAME_INVALID", error: `A contact needs a name of 2 to ${CONTACT_NAME_MAX} characters, without hidden or control characters.` });
    if (store.contactsOf(ctx.org.id).length >= CEILINGS.contactsPerOrg) {
      return res.status(409).json(ceilingRefusal("contacts in this organisation", CEILINGS.contactsPerOrg));
    }

    try {
      const now = new Date().toISOString();
      const contact = store.addContact({
        id: `con_${randomUUID()}`,
        orgId: ctx.org.id,
        name,
        email: typeof req.body?.email === "string" ? req.body.email.trim() : undefined,
        wallets: (Array.isArray(req.body?.wallets) ? req.body.wallets : []).map((w: unknown) => ({
          id: `cw_${randomUUID()}`,
          ...validateWallet(w),
        })),
        bankAccounts: (Array.isArray(req.body?.bankAccounts) ? req.body.bankAccounts : []).map((b: unknown) => ({
          id: `cb_${randomUUID()}`,
          ...validateBankAccount(b),
        })),
        notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
        createdAt: now,
        updatedAt: now,
      });
      res.status(201).json({ contact });
    } catch (err) {
      if (err instanceof ContactError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  r.patch("/:orgId/contacts/:contactId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.manage")) return;

    const contact = store.findContact(String(req.params.contactId));
    if (!contact || contact.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such contact" });
    }
    try {
      const patch: Record<string, unknown> = {};
      // The edit form sends the name on every save: unchanged is left as stored.
      if (typeof req.body?.name === "string" && !sameName(req.body.name, contact.name)) {
        const n = cleanName(req.body.name, { min: 2, max: CONTACT_NAME_MAX });
        if (n === null) return res.status(400).json({ code: "NAME_INVALID", error: `A contact needs a name of 2 to ${CONTACT_NAME_MAX} characters, without hidden or control characters.` });
        patch.name = n;
      }
      if (typeof req.body?.email === "string") patch.email = req.body.email.trim();
      if (typeof req.body?.notes === "string") patch.notes = req.body.notes;
      if (Array.isArray(req.body?.wallets)) {
        patch.wallets = req.body.wallets.map((w: Record<string, unknown>) => ({
          id: typeof w?.id === "string" ? w.id : `cw_${randomUUID()}`,
          ...validateWallet(w),
        }));
      }
      if (Array.isArray(req.body?.bankAccounts)) {
        // Ids are preserved where supplied so a draft referencing a bank
        // account keeps pointing at it — and so an edit shows up as DRIFT on
        // that draft rather than silently re-targeting the payment.
        patch.bankAccounts = req.body.bankAccounts.map((b: Record<string, unknown>) => ({
          id: typeof b?.id === "string" ? b.id : `cb_${randomUUID()}`,
          ...validateBankAccount(b),
        }));
      }
      const saved = store.updateContact(contact.id, patch);
      res.json({ contact: can(ctx.org, "invoices").allowed ? saved : { ...saved, payerRule: undefined } });
    } catch (err) {
      if (err instanceof ContactError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  r.delete("/:orgId/contacts/:contactId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.manage")) return;
    const contact = store.findContact(String(req.params.contactId));
    if (!contact || contact.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such contact" });
    }
    store.removeContact(contact.id);
    res.json({ deleted: true });
  });

  // ── Imported wallets (read-only treasury view) ────────────────────────────

  r.get("/:orgId/wallets", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "wallets.read")) return;
    res.json({ wallets: store.importedWalletsOf(ctx.org.id).map(publicWallet) });
  });

  /**
   * Import a wallet to watch. We never hold a key for one of these: the row is
   * stamped `custody: "external"` and the signing paths assert on it. A payment
   * from an imported wallet is built here and signed by its owner.
   */
  r.post("/:orgId/wallets", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "wallets.manage")) return;

    const address = String(req.body?.address ?? "").trim();
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: `${address || "(empty)"} is not an EVM address.` });
    }
    const chainId = Number(req.body?.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return res.status(400).json({ error: "A wallet needs the chain id it lives on." });
    }
    const kind = ["eoa", "safe", "mpc"].includes(String(req.body?.kind))
      ? (String(req.body.kind) as "eoa" | "safe" | "mpc")
      : "eoa";

    const existing = store.importedWalletsOf(ctx.org.id);
    if (
      existing.some(
        (w) => w.address.toLowerCase() === address.toLowerCase() && w.chainId === chainId,
      )
    ) {
      return res.status(409).json({ error: "That wallet is already imported." });
    }
    if (!requireWithinLimit(ctx, res, "importedWallets", existing.length, "imported wallet")) {
      return;
    }
    // The org's own Zold account is already in the books (statement lines);
    // watching it too would book every movement twice.
    if (
      chainId === CHAIN_ID &&
      store.accounts.some((a) => a.orgId === ctx.org.id && a.address?.toLowerCase() === address.toLowerCase())
    ) {
      return res.status(409).json({ error: "That is this organisation's own Zold account. It is already in the books." });
    }
    // Books from a past day: the sync starts at that day's first block.
    // Without it, the wallet is booked from now on.
    const syncFrom = req.body?.syncFrom ? String(req.body.syncFrom).trim() : undefined;
    if (syncFrom !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(syncFrom) || !Number.isFinite(Date.parse(`${syncFrom}T00:00:00Z`))) {
        return res.status(400).json({ error: "Start day must be a date, YYYY-MM-DD." });
      }
      if (Date.parse(`${syncFrom}T00:00:00Z`) > Date.now()) {
        return res.status(400).json({ error: "Start day is in the future." });
      }
      // No ERC-20 exists before Ethereum's first block; an earlier day only
      // costs the binary search over block times.
      if (syncFrom < "2015-07-30") {
        return res.status(400).json({ error: "Start day is before any chain existed; the earliest is 2015-07-30." });
      }
      if (!requireCapability(ctx, res, "ledger.historicalSync")) return;
    }

    const wallet = store.batched(() => {
      const added = store.addImportedWallet({
      id: `iw_${randomUUID()}`,
      orgId: ctx.org.id,
      address: address.toLowerCase() as `0x${string}`,
      chainId,
      label: String(req.body?.label ?? "").trim() || `${kind.toUpperCase()} ${address.slice(0, 8)}`,
      kind,
      custody: "external",
      sync: { status: "pending", ...(syncFrom ? { from: syncFrom } : {}) },
      createdAt: new Date().toISOString(),
      });
      // Rows booked for this address while it was imported before (removing a
      // wallet keeps its rows) point at the removed wallet. They are this
      // address's rows exactly when their id is this address's row id, and
      // they follow the new wallet, its sync and its proof.
      const live = new Set(store.importedWalletsOf(ctx.org.id).map((w) => w.id));
      const orphans = store.ledgerOf(ctx.org.id).flatMap((e) =>
        e.source.kind === "wallet" && !live.has(e.source.walletId) && e.chainId === chainId && e.txHash && e.logIndex !== undefined &&
        e.id === walletEntryId(ctx.org.id, added.address, chainId, e.txHash, e.logIndex)
          ? [{ ...e, source: { kind: "wallet" as const, walletId: added.id } }]
          : [],
      );
      if (orphans.length) store.replaceLedgerEntries(orphans);
      return added;
    });
    res.status(201).json({
      wallet,
      note: "Imported read-only. We never hold a key for this wallet — payments from it are built here and signed by you. Token transfers in and out are booked from " + (syncFrom ? syncFrom : "now") + " on, once an RPC is configured for its chain.",
    });
  });

  // ── Proving an imported wallet is this organisation's ───────────────────
  //
  // The person signs a challenge in their own wallet; the wallet's chain is
  // asked whether the signature is valid. Zold holds no key and proposes no
  // transaction. See domain/wallet-ownership.ts.

  const walletOf = (ctx: OrgContext, req: express.Request) => {
    const wallet = store.findImportedWallet(String(req.params.walletId));
    return wallet && wallet.orgId === ctx.org.id ? wallet : undefined;
  };
  const mayProve = (ctx: OrgContext, res: express.Response) =>
    requirePermission(ctx, res, "wallets.manage") && requireCapability(ctx, res, "wallets.manage");

  /** A new challenge for the wallet, replacing any that is waiting. */
  r.post("/:orgId/wallets/:walletId/ownership/challenge", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!mayProve(ctx, res)) return;
    const wallet = walletOf(ctx, req);
    if (!wallet) return res.status(404).json({ error: "no such wallet" });
    const challenge = newChallenge(ctx.org, wallet, randomBytes(16).toString("hex"), new Date());
    store.updateImportedWallet(wallet.id, { ownershipChallenge: challenge });
    res.status(201).json({
      challenge: { ...challenge, messageHash: hashMessage(challenge.message) },
      howToSign:
        "Sign this exact text in the wallet itself. An ordinary wallet: sign it as a message and send back the signature. " +
        "A Safe: sign it as a message in Safe{Wallet}; send back the signature it shows once enough owners have signed, " +
        "or nothing if the Safe signed the message on chain. Zold then asks the wallet's own chain.",
    });
  });

  /** Prove the wallet with its current challenge. Only the chain's answer
   *  writes anything; a challenge is spent by the proof it produces. */
  r.post("/:orgId/wallets/:walletId/ownership", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!mayProve(ctx, res)) return;
    const wallet = walletOf(ctx, req);
    if (!wallet) return res.status(404).json({ error: "no such wallet" });
    const challengeId = String(req.body?.challengeId ?? "");
    const pending = wallet.ownershipChallenge;
    if (!pending || pending.id !== challengeId) {
      return res.status(409).json({ error: "That is not this wallet's current challenge. Ask for a new one and sign that." });
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      store.updateImportedWallet(wallet.id, { ownershipChallenge: undefined });
      return res.status(410).json({ error: "The challenge has expired. Ask for a new one and sign that." });
    }
    const signature = parseSignature(req.body?.signature);
    if (!signature) return res.status(400).json({ error: "The signature is hex, starting 0x." });

    const result = await verifyOwnership(wallet, pending.message, signature);
    const audit = (outcome: string, reason?: string) =>
      store.audit(auditEntry("wallet.ownership_checked", {
        orgId: ctx.org.id, walletId: wallet.id, chainId: wallet.chainId, address: wallet.address,
        check: "prove", outcome, ...(reason ? { reason } : {}),
      }, ctx.userId));
    if (result.verdict === "unverified") {
      audit("unverified", result.reason);
      return res.status(503).json({ proven: false, error: `Not verified: ${result.reason}. Nothing was recorded; try again with the same challenge.` });
    }
    if (result.verdict === "rejected") {
      audit("rejected", result.reason);
      return res.status(422).json({ proven: false, error: `The chain does not accept this as the wallet's signature of the challenge: ${result.reason}.` });
    }
    const answer = store.batched(() => {
      // Another request may have spent or replaced the challenge meanwhile.
      const current = store.findImportedWallet(wallet.id);
      if (!current || current.orgId !== ctx.org.id || current.ownershipChallenge?.id !== pending.id) return undefined;
      const at = new Date().toISOString();
      audit("proven");
      return store.updateImportedWallet(wallet.id, {
        ownershipChallenge: undefined,
        ownership: {
          status: "proven", method: result.method, message: pending.message, signature,
          provenAt: at, checkedAt: at, provenByMemberId: ctx.member.id,
        },
      });
    });
    if (!answer) return res.status(409).json({ error: "This challenge was used or replaced while it was being checked. Nothing was recorded." });
    res.json({ proven: true, wallet: publicWallet(answer) });
  }));

  /** Ask the chain again about the stored proof. A refusal lapses it; a
   *  chain that cannot be asked changes nothing. */
  r.post("/:orgId/wallets/:walletId/ownership/recheck", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!mayProve(ctx, res)) return;
    const wallet = walletOf(ctx, req);
    if (!wallet) return res.status(404).json({ error: "no such wallet" });
    const proof = wallet.ownership;
    if (!proof) return res.status(409).json({ error: "This wallet has no proof to check. Prove it first." });

    const result = await verifyOwnership(wallet, proof.message, proof.signature, proof.method);
    store.audit(auditEntry("wallet.ownership_checked", {
      orgId: ctx.org.id, walletId: wallet.id, chainId: wallet.chainId, address: wallet.address,
      check: "recheck", outcome: result.verdict, ...(result.verdict !== "valid" ? { reason: result.reason } : {}),
    }, ctx.userId));
    if (result.verdict === "unverified") {
      return res.status(503).json({ error: `Not checked: ${result.reason}. The proof stays as it was.`, wallet: publicWallet(wallet) });
    }
    const updated = store.batched(() => {
      const current = store.findImportedWallet(wallet.id);
      // Proven again meanwhile with another signature: this answer is about the old one.
      if (!current?.ownership || current.ownership.signature !== proof.signature || current.ownership.message !== proof.message) return undefined;
      const at = new Date().toISOString();
      return store.updateImportedWallet(wallet.id, {
        ownership:
          result.verdict === "valid"
            ? { ...current.ownership, status: "proven", checkedAt: at, lapsedAt: undefined, lapseReason: undefined }
            : { ...current.ownership, status: "lapsed", checkedAt: at, lapsedAt: current.ownership.lapsedAt ?? at, lapseReason: result.reason },
      });
    });
    if (!updated) return res.status(409).json({ error: "The proof changed while it was being checked. Check again." });
    res.json({ wallet: publicWallet(updated) });
  }));

  r.delete("/:orgId/wallets/:walletId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "wallets.manage")) return;
    const wallet = store.findImportedWallet(String(req.params.walletId));
    if (!wallet || wallet.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such wallet" });
    }
    store.removeImportedWallet(wallet.id);
    res.json({ deleted: true });
  });

  return r;
}
