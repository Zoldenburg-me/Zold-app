/**
 * /api/orgs/:orgId/monerium: a company org's own Monerium API keys.
 *
 * A company's euro account is its own Safe, never a login's (access-model.js
 * isOwnCompanyOrg), so the login's Monerium connection does not stand for it.
 * The company connects its own Monerium app instead: client id + secret from
 * the company's Monerium developer section. This file only stores and checks
 * them. Linking the company Safe and issuing its IBAN are not built, and
 * nothing here moves money.
 *
 * Keys are proven against Monerium (client-credentials grant) before they
 * are stored, and must open a corporate profile: Monerium's Business Terms
 * are for legal persons, and a personal profile never backs a company
 * (domain/monerium-profile.ts). The secret is sealed through stored-secrets.ts
 * under its own purpose, bound to the org row, and never returned, not even
 * as ciphertext or a hint. The environment is the deployment's
 * (MONERIUM.baseUrl), never a choice per org: keys from the other
 * environment are refused by Monerium.
 *
 * Who: owners and admins (accounts.open), in a company org only. Others get
 * 403; a sole_trader or personal org gets 409 NOT_A_COMPANY.
 *
 *  - GET    → { monerium: view }
 *  - POST   { clientId, clientSecret } → 201 { monerium } | 400 | 409 | 503
 *  - POST   /check → re-reads the profile on the stored keys
 *  - DELETE → removes the keys
 */
import express from "express";
import { auditEntry } from "../../audit.js";
import { MONERIUM } from "../../config.js";
import { dataEncryptionProblem } from "../../config/data-keys.js";
import { EncryptionUnavailableError } from "../../crypto-at-rest.js";
import { orgEntity } from "../../domain/org-entity.js";
import { pickProfileForSignup } from "../../domain/monerium-profile.js";
import type { Organisation } from "../../domain/types.js";
import { MoneriumApiError } from "../../adapters/monerium-client.js";
import { moneriumEnvironment, validateApiKeyInput, verifyApiKeys, type VerifiedApiKeys } from "../../adapters/monerium-connection.js";
import { redactedMessage } from "../../http/log-cause.js";
import { SECRETS } from "../../stored-secrets.js";
import { store } from "../../store.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";

export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

export type Verify = (clientId: string, clientSecret: string) => Promise<VerifiedApiKeys>;

export type OrgMoneriumStatus = "not_connected" | "pending" | "connected" | "invalid";

/** connected: Monerium approved the corporate profile. invalid: Monerium
 *  refused the stored keys, or rejected or closed the profile. pending: any
 *  other profile state (created, incomplete, pending, review). */
export function orgMoneriumStatus(m: Organisation["monerium"]): OrgMoneriumStatus {
  if (!m) return "not_connected";
  if (m.rejectedAt || m.profile.state === "rejected" || m.profile.state === "closed") return "invalid";
  return m.profile.state === "approved" ? "connected" : "pending";
}

/** "abcd…wxyz": enough to recognise the app, the id itself is not secret. */
const maskId = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…");

/** What a member may see. Never the secret, in any form. */
export function publicOrgMonerium(org: Organisation) {
  const m = org.monerium;
  const environment = moneriumEnvironment(MONERIUM.baseUrl);
  if (!m) {
    const problem = dataEncryptionProblem();
    return { status: "not_connected" as const, environment, available: problem === null, ...(problem ? { needs: `the server's data encryption key: ${problem}` } : {}) };
  }
  return {
    status: orgMoneriumStatus(m),
    environment,
    available: true,
    clientId: maskId(m.clientId),
    profile: { name: m.profile.name, state: m.profile.state },
    connectedAt: m.connectedAt,
    checkedAt: m.checkedAt,
    ...(m.rejectedAt ? { rejectedAt: m.rejectedAt } : {}),
  };
}

const NOT_A_COMPANY = {
  code: "NOT_A_COMPANY",
  error: "Only a company connects its own Monerium keys. This organisation's account is backed by a member's own Monerium connection, in the app.",
};

/** The verifier's refusal as an answer: Monerium's no is a 400, anything else
 *  (5xx, network) is a 503 the caller may retry. */
function refusal(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof MoneriumApiError && err.status === 400) return { status: 400, body: { error: err.message, code: "MONERIUM_KEYS_REFUSED" } };
  return { status: 503, body: { error: `Monerium could not be reached to check the keys: ${redactedMessage(err).slice(0, 160)}`, code: "MONERIUM_UNREACHABLE" } };
}

/** The corporate profile the keys opened, or the refusal. */
function corporateProfile(v: VerifiedApiKeys) {
  const pick = pickProfileForSignup("company", v.profiles);
  if (pick.ok) return { profile: { id: pick.profile.id, ...(pick.profile.name ? { name: pick.profile.name } : {}), state: pick.profile.state || "unknown" } };
  return {
    refusal: {
      code: pick.code,
      error: "These keys open a Monerium account with no company profile. A company's account needs a company profile at Monerium: use keys from the company's own Monerium account.",
    },
  };
}

export function createOrgMoneriumRoutes(deps: OrgRoutes, verify: Verify = verifyApiKeys): express.Router {
  const r = express.Router();

  /** Session, role, then org kind: the three checks, in that order. */
  const gate = (req: express.Request, res: express.Response) => {
    const ctx = deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (!requirePermission(ctx, res, "accounts.open")) return undefined;
    if (orgEntity(ctx.org) !== "company") {
      res.status(409).json(NOT_A_COMPANY);
      return undefined;
    }
    return ctx;
  };

  r.get("/:orgId/monerium", (req, res) => {
    const ctx = gate(req, res);
    if (!ctx) return;
    res.json({ monerium: publicOrgMonerium(ctx.org) });
  });

  r.post("/:orgId/monerium", wrap(async (req, res) => {
    const ctx = gate(req, res);
    if (!ctx) return;
    const problem = dataEncryptionProblem();
    if (problem) return res.status(503).json({ error: `${problem}, so Monerium keys cannot be stored` });
    let input;
    try {
      input = validateApiKeyInput(req.body);
    } catch (err) {
      if (err instanceof MoneriumApiError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    let verified;
    try {
      verified = await verify(input.clientId, input.clientSecret);
    } catch (err) {
      const no = refusal(err);
      if (no.status === 400) store.audit(auditEntry("partner.call_refused", { partner: "monerium", status: 400, orgId: ctx.org.id }, ctx.userId));
      return res.status(no.status).json(no.body);
    }
    const picked = corporateProfile(verified);
    if (!picked.profile) return res.status(409).json(picked.refusal);
    let clientSecretEnc: string;
    try {
      clientSecretEnc = SECRETS.orgMoneriumApiSecret.seal(ctx.org.id, input.clientSecret);
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) return res.status(503).json({ error: err.message });
      throw err;
    }
    const now = new Date().toISOString();
    const org = store.updateOrganisation(ctx.org.id, {
      monerium: { clientId: input.clientId, clientSecretEnc, profile: picked.profile, connectedAt: now, checkedAt: now, connectedByMemberId: ctx.member.id },
    });
    store.audit(auditEntry("partner.credentials_connected", { partner: "monerium", orgId: org.id, profileState: picked.profile.state }, ctx.userId));
    res.status(201).json({ monerium: publicOrgMonerium(org) });
  }));

  r.post("/:orgId/monerium/check", wrap(async (req, res) => {
    const ctx = gate(req, res);
    if (!ctx) return;
    const m = ctx.org.monerium;
    if (!m) return res.status(409).json({ error: "no Monerium keys are connected", code: "MONERIUM_NOT_CONNECTED" });
    let verified;
    try {
      verified = await verify(m.clientId, SECRETS.orgMoneriumApiSecret.open(ctx.org.id, m.clientSecretEnc));
    } catch (err) {
      const no = refusal(err);
      if (no.status !== 400) return res.status(no.status).json(no.body);
      // Monerium refused keys it accepted before: say so, keep the row so an
      // admin sees what was connected and replaces it.
      const org = store.updateOrganisation(ctx.org.id, { monerium: { ...m, checkedAt: new Date().toISOString(), rejectedAt: new Date().toISOString() } });
      store.audit(auditEntry("partner.call_refused", { partner: "monerium", status: 400, orgId: ctx.org.id }, ctx.userId));
      return res.json({ monerium: publicOrgMonerium(org) });
    }
    const picked = corporateProfile(verified);
    if (!picked.profile) return res.status(409).json(picked.refusal);
    const { rejectedAt: _cleared, ...rest } = m;
    // The profile the keys opened at connect is the company's; a different one now is not silently adopted.
    if (picked.profile.id !== m.profile.id) {
      return res.status(409).json({ code: "MONERIUM_PROFILE_CHANGED", error: "These keys now open a different company profile at Monerium than when they were connected. Remove the keys and connect them again to use it." });
    }
    const org = store.updateOrganisation(ctx.org.id, { monerium: { ...rest, profile: picked.profile, checkedAt: new Date().toISOString() } });
    res.json({ monerium: publicOrgMonerium(org) });
  }));

  r.delete("/:orgId/monerium", (req, res) => {
    const ctx = gate(req, res);
    if (!ctx) return;
    if (!ctx.org.monerium) return res.status(409).json({ error: "no Monerium keys are connected", code: "MONERIUM_NOT_CONNECTED" });
    const org = store.updateOrganisation(ctx.org.id, { monerium: undefined });
    store.audit(auditEntry("partner.credentials_removed", { partner: "monerium", orgId: org.id }, ctx.userId));
    res.json({ monerium: publicOrgMonerium(org) });
  });

  return r;
}
