/**
 * /api/orgs — organisations, members, plans, accounts, contacts, wallets.
 *
 * A router factory rather than a module that imports the app, so server.ts
 * keeps ownership of authentication and this file cannot quietly acquire a
 * second way to decide who is calling.
 */

import express from "express";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { store } from "../store.js";
import {
  publicMember,
  publicOrg,
  requireCapability,
  requirePermission,
  requireWithinLimit,
  resolveOrg,
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
  TRIAL_DAYS,
  effectivePlan,
  plansFor,
  trialIsActive,
  trialPlanFor,
} from "../domain/plans.js";
import { ROLES, type OrgType, type Organisation, type Role } from "../domain/types.js";
import { ContactError, validateBankAccount, validateWallet } from "../domain/contacts.js";
import { wouldOrphanOrg } from "../domain/roles.js";

const INVITE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // Gnosis expired invites at 3 days
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

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
    if (typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "An organisation needs a name." });
    }
    if (typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country)) {
      return res
        .status(400)
        .json({ error: "Country must be an ISO 3166-1 alpha-2 code, e.g. DE." });
    }

    const now = new Date().toISOString();
    const org: Organisation = {
      id: `org_${randomUUID()}`,
      type: orgType,
      name: name.trim(),
      legalName: typeof legalName === "string" ? legalName.trim() : undefined,
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
    if (typeof b.name === "string" && b.name.trim().length >= 2) patch.name = b.name.trim();
    if (typeof b.legalName === "string") patch.legalName = b.legalName.trim();
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
      patch.address = { ...ctx.org.address, ...b.address, country: country.toUpperCase() };
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
   * Downgrade is allowed and deliberately DELETES NOTHING — the chart of
   * accounts, tags and history stay exactly where they are and simply stop
   * being served. That is what makes the upgrade path honest, and it is only
   * true because no code path here removes rows.
   */
  r.post("/:orgId/plan", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.billing")) return;

    const plan = String(req.body?.plan ?? "");
    const allowed = plansFor(ctx.org.type).map((p) => p.id);
    if (!allowed.includes(plan as never)) {
      return res.status(400).json({
        error: `A ${ctx.org.type} organisation can hold ${allowed.join(" or ")}.`,
      });
    }
    const org = store.updateOrganisation(ctx.org.id, {
      plan: plan as Organisation["plan"],
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "A member needs a valid email address." });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}.` });
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
      name: typeof req.body?.name === "string" ? req.body.name.trim() : undefined,
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
    const next: { role?: Role; status?: string } = {};
    if (req.body?.role !== undefined) {
      const role = String(req.body.role) as Role;
      if (!ROLES.includes(role)) {
        return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}.` });
      }
      if ((role === "owner" || member.role === "owner") && ctx.member.role !== "owner") {
        return res.status(403).json({ error: "Only an owner can change an owner's role." });
      }
      next.role = role;
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!["active", "deactivated"].includes(status)) {
        return res.status(400).json({ error: "Status must be active or deactivated." });
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

  /** Accept an invitation. Binds the invited email to the calling session. */
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
    if (store.memberFor(member.orgId, session.userId)) {
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
    res.json({
      accounts,
      currencies: currencyAvailability(),
      // What a second account would cost, so the UI can show the ceiling
      // before the user hits it rather than after.
      canOpenMore: accounts.length < (publicOrg(ctx.org).limits.accounts as number),
    });
  });

  r.post("/:orgId/accounts", (req, res) => {
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
     * Where the money actually comes from.
     *
     * Provisioning a Safe and a Monerium profile PER ORGANISATION is not built.
     * Until it is, the only spendable account is one backed by a person's
     * existing funded account — so an org either adopts the caller's, or has no
     * funding identity and says so.
     *
     * A personal org adopts automatically: it IS that person. A business org
     * must ask (`useMyAccount: true`), because "your own wallet is now funding
     * the company" is a decision someone should make on purpose rather than
     * discover later. Either way `backingUserId` records whose device key can
     * sign, since spending authority never follows a membership change.
     */
    const caller = store.findUser(ctx.userId);
    const callerFunded =
      caller && caller.iban && caller.funding?.status === "active" ? caller : undefined;
    const wantsAdoption =
      currency === "EUR" &&
      Boolean(callerFunded) &&
      (ctx.org.type === "personal" || req.body?.useMyAccount === true);

    /**
     * An account nobody can fund is GATED, not "provisioning".
     *
     * `provisioning` promises that something is working on it. Nothing is:
     * per-organisation provisioning does not exist, so without adoption the
     * account would sit in that state forever, which reads as a stuck job
     * rather than a missing feature. Gated with a reason is the honest state.
     */
    const status = wantsAdoption ? "active" : "gated";
    const gate = wantsAdoption
      ? undefined
      : (initial.gate ?? {
          reason:
            "This account has no funding identity, so nothing can be sent from it.",
          needs:
            "per-organisation account provisioning (a Safe and a Monerium profile of its own), which is not built. Until then an organisation can be funded from a member's own account with useMyAccount: true.",
        });

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
      gate,
      createdAt: now,
      updatedAt: now,
    });

    let note: string | undefined;
    if (account.status === "gated") {
      note = `Recorded, but ${CURRENCY_REGISTRY[currency].name} accounts cannot be opened yet: ${account.gate?.needs}`;
    } else if (wantsAdoption && ctx.org.type === "business") {
      note =
        "This organisation is now funded by your personal account — payments come out of your balance and only your device key can authorise them. Per-organisation accounts are not built yet.";
    } else if (!wantsAdoption && currency === "EUR") {
      note = callerFunded
        ? "Opened without a funding identity. Pass useMyAccount: true to fund it from your own account until per-organisation provisioning exists."
        : "Opened without a funding identity — your own account is not funded yet, and per-organisation provisioning is not built. Nothing can be sent from this account.";
    }

    res.status(201).json({ account, note });
  });

  /**
   * Give an existing account a funding identity, from the caller's own account.
   *
   * Separate endpoint rather than a flag on update, because this is the moment
   * a person's own balance starts paying an organisation's bills — it deserves
   * its own call, its own permission and its own plain-language answer.
   */
  r.post("/:orgId/accounts/:accountId/fund", (req, res) => {
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
      const def = CURRENCY_REGISTRY[account.currency];
      return res.status(409).json({
        error: `${def.name} cannot be funded this way: ${def.needs}`,
      });
    }
    const caller = store.findUser(ctx.userId);
    if (!caller?.iban || caller.funding?.status !== "active") {
      return res.status(409).json({
        error:
          "Your own account is not funded yet, so it cannot fund this organisation. Add money to your account first.",
      });
    }

    const funded = store.updateAccount(account.id, {
      status: "active",
      identifier: { iban: caller.iban },
      address: caller.address,
      backingUserId: caller.id,
      gate: undefined,
    });
    res.json({
      account: funded,
      note:
        ctx.org.type === "business"
          ? "This organisation is now funded by your personal account — payments come out of your balance and only your device key can authorise them. Per-organisation accounts are not built yet."
          : "Funded from your account.",
    });
  });

  // ── Contacts (the address book) ───────────────────────────────────────────

  r.get("/:orgId/contacts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.read")) return;
    res.json({ contacts: store.contactsOf(ctx.org.id) });
  });

  r.post("/:orgId/contacts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "contacts.manage")) return;

    const name = String(req.body?.name ?? "").trim();
    if (name.length < 2) return res.status(400).json({ error: "A contact needs a name." });

    try {
      const now = new Date().toISOString();
      const contact = store.addContact({
        id: `con_${randomUUID()}`,
        orgId: ctx.org.id,
        name,
        email: typeof req.body?.email === "string" ? req.body.email.trim() : undefined,
        wallets: (req.body?.wallets ?? []).map((w: unknown) => ({
          id: `cw_${randomUUID()}`,
          ...validateWallet(w as never),
        })),
        bankAccounts: (req.body?.bankAccounts ?? []).map((b: unknown) => ({
          id: `cb_${randomUUID()}`,
          ...validateBankAccount(b as never),
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
      if (typeof req.body?.name === "string" && req.body.name.trim().length >= 2) {
        patch.name = req.body.name.trim();
      }
      if (typeof req.body?.email === "string") patch.email = req.body.email.trim();
      if (typeof req.body?.notes === "string") patch.notes = req.body.notes;
      if (typeof req.body?.defaultAccountCodeIn === "string") {
        patch.defaultAccountCodeIn = req.body.defaultAccountCodeIn;
      }
      if (typeof req.body?.defaultAccountCodeOut === "string") {
        patch.defaultAccountCodeOut = req.body.defaultAccountCodeOut;
      }
      if (Array.isArray(req.body?.wallets)) {
        patch.wallets = req.body.wallets.map((w: Record<string, unknown>) => ({
          id: typeof w.id === "string" ? w.id : `cw_${randomUUID()}`,
          ...validateWallet(w as never),
        }));
      }
      if (Array.isArray(req.body?.bankAccounts)) {
        // Ids are preserved where supplied so a draft referencing a bank
        // account keeps pointing at it — and so an edit shows up as DRIFT on
        // that draft rather than silently re-targeting the payment.
        patch.bankAccounts = req.body.bankAccounts.map((b: Record<string, unknown>) => ({
          id: typeof b.id === "string" ? b.id : `cb_${randomUUID()}`,
          ...validateBankAccount(b as never),
        }));
      }
      res.json({ contact: store.updateContact(contact.id, patch) });
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
    res.json({
      wallets: store.importedWalletsOf(ctx.org.id),
      groups: store.walletGroupsOf(ctx.org.id),
    });
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

    const wallet = store.addImportedWallet({
      id: `iw_${randomUUID()}`,
      orgId: ctx.org.id,
      address: address.toLowerCase() as `0x${string}`,
      chainId,
      label: String(req.body?.label ?? "").trim() || `${kind.toUpperCase()} ${address.slice(0, 8)}`,
      kind,
      groupId: typeof req.body?.groupId === "string" ? req.body.groupId : undefined,
      custody: "external",
      sync: { status: "pending" },
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({
      wallet,
      note: "Imported read-only. We never hold a key for this wallet — payments from it are built here and signed by you.",
    });
  });

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

  r.post("/:orgId/wallet-groups", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "wallets.manage")) return;
    const name = String(req.body?.name ?? "").trim();
    if (name.length < 1) return res.status(400).json({ error: "A group needs a name." });
    res.status(201).json({
      group: store.addWalletGroup({
        id: `wg_${randomUUID()}`,
        orgId: ctx.org.id,
        name,
        createdAt: new Date().toISOString(),
      }),
    });
  });

  return r;
}
