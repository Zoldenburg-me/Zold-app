/**
 * /api/orgs/:orgId/monerium: a company org's own Monerium API keys.
 *
 * A company's euro account is its own Safe, never a login's (access-model.js
 * isOwnCompanyOrg), so the login's Monerium connection does not stand for it.
 * The company connects its own Monerium app instead: client id + secret from
 * the company's Monerium developer section. This file only stores and checks
 * them; linking the company Safe and issuing its IBAN on them is
 * ./org-monerium-iban.ts. Nothing here moves money.
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
 * 403; a sole_trader or personal org gets 409 NOT_A_COMPANY. Replacing or
 * removing stored keys also needs a fresh passkey approval
 * (`org.monerium.keys`): the keys open the company's Monerium account, which
 * holds its IBAN. The first connection replaces nothing and needs none.
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
import { companyEurAccount, companyIbanState } from "../../domain/org-monerium-iban.js";
import { MoneriumApiError } from "../../adapters/monerium-client.js";
import { MoneriumKeysRefusedError, moneriumEnvironment, validateApiKeyInput, verifyCompanyKeys } from "../../adapters/monerium-connection.js";
import { redactedMessage } from "../../http/log-cause.js";
import { SECRETS } from "../../stored-secrets.js";
import { store } from "../../store.js";
import { sameSecret } from "../../store/rules.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { verifyPasskeyStepUp } from "../auth.js";
import { wrap } from "../util.js";

export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => Promise<OrgContext | undefined>;
}

/** Proves the keys (token grant) and lists the profiles they open. */
export type Verify = (clientId: string, clientSecret: string) => Promise<{ profiles: unknown[] }>;

/** A fresh passkey approval of `org.monerium.keys` by this user, from the
 *  request body's `stepUp`; answers the refusal itself and returns false. */
export type StepUp = (userId: string, body: unknown, res: express.Response) => Promise<boolean>;

const liveStepUp: StepUp = async (userId, body, res) => {
  const user = await store.findUser(userId);
  if (!user) {
    res.status(401).json({ error: "no such user" });
    return false;
  }
  return verifyPasskeyStepUp(user, body, res, "org.monerium.keys");
};

export type OrgMoneriumStatus = "not_connected" | "pending" | "connected" | "invalid";

/** connected: Monerium approved the corporate profile. invalid: Monerium
 *  refused the stored keys, no longer lists the stored profile, or rejected
 *  or closed it. pending: any other profile state (created, incomplete,
 *  pending, review). */
export function orgMoneriumStatus(m: Organisation["monerium"]): OrgMoneriumStatus {
  if (!m) return "not_connected";
  if (m.rejectedAt || m.profileMissingAt || m.profile.state === "rejected" || m.profile.state === "closed") return "invalid";
  return m.profile.state === "approved" ? "connected" : "pending";
}

/** "abcd…wxyz": enough to recognise the app, the id itself is not secret. */
const maskId = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…");

/** How far the company's IBAN on its Safe has got (domain/org-monerium-iban.ts). */
async function ibanView(org: Organisation) {
  const account = companyEurAccount(await store.accountsOf(org.id));
  const state = companyIbanState(org, account);
  return { state, ...(state === "issued" ? { iban: account!.identifier.iban, safeAddress: account!.address } : {}) };
}

/** What a member may see. Never the secret, in any form. */
export async function publicOrgMonerium(org: Organisation) {
  const m = org.monerium;
  const environment = moneriumEnvironment(MONERIUM.baseUrl);
  if (!m) {
    const problem = dataEncryptionProblem();
    return { status: "not_connected" as const, environment, available: problem === null, ...(problem ? { needs: `the server's data encryption key: ${problem}` } : {}), companyIban: await ibanView(org) };
  }
  return {
    companyIban: await ibanView(org),
    status: orgMoneriumStatus(m),
    environment,
    available: true,
    clientId: maskId(m.clientId),
    profile: { name: m.profile.name, state: m.profile.state },
    connectedAt: m.connectedAt,
    checkedAt: m.checkedAt,
    ...(m.rejectedAt ? { rejectedAt: m.rejectedAt } : {}),
    ...(m.profileMissingAt ? { profileMissingAt: m.profileMissingAt } : {}),
  };
}

const NOT_A_COMPANY = {
  code: "NOT_A_COMPANY",
  error: "Only a company connects its own Monerium keys. This organisation's account is backed by a member's own Monerium connection, in the app.",
};

/** The verifier's refusal as an answer. Only Monerium refusing the token
 *  grant is a 400; anything else (5xx, network, a failed read) is a 503 the
 *  caller may retry. Either way the answer is a fixed text: Monerium's own
 *  response body never reaches the browser, only the server log, redacted. */
function refusal(err: unknown): { status: number; body: { error: string; code: string } } {
  const environment = moneriumEnvironment(MONERIUM.baseUrl);
  if (err instanceof MoneriumKeysRefusedError) {
    return { status: 400, body: { code: "MONERIUM_KEYS_REFUSED", error: `Monerium (${environment}) refused these keys. Check the client id and secret, and that they come from the company's Monerium ${environment} account.` } };
  }
  // A Monerium HTTP error carries the provider's response body in its message:
  // log only the status. Anything else (network, a malformed answer) is ours.
  const why = err instanceof MoneriumApiError ? `Monerium answered ${err.status}` : redactedMessage(err);
  console.warn(`org-monerium: checking keys with Monerium failed: ${why}`);
  return { status: 503, body: { code: "MONERIUM_UNREACHABLE", error: "Monerium could not be reached to check the keys. Try again in a minute." } };
}

const NO_COMPANY_PROFILE = {
  code: "MONERIUM_PROFILE_KIND_MISSING",
  error: "These keys open a Monerium account with no company profile. A company's account needs a company profile at Monerium: use keys from the company's own Monerium account.",
};

type Profile = NonNullable<Organisation["monerium"]>["profile"];
const asProfile = (p: { id: string; name?: string; state?: string }): Profile => ({ id: p.id, ...(p.name ? { name: p.name } : {}), state: p.state || "unknown" });

/** At connect: the corporate profile the keys opened (the signup picker). */
function corporateProfile(profiles: unknown[]): Profile | undefined {
  const pick = pickProfileForSignup("company", profiles);
  return pick.ok ? asProfile(pick.profile) : undefined;
}

/** At a re-check: the stored profile, looked up by its id among the
 *  corporate profiles the keys open. Another one ranking first never stands
 *  in for it. */
function storedProfile(profiles: unknown[], id: string): Profile | undefined {
  const p = (Array.isArray(profiles) ? profiles : []).find((x: any) => x?.kind === "corporate" && x?.id === id) as any;
  return p ? asProfile(p) : undefined;
}

/** The same stored keys: a re-check writes only over the keys it checked. */
const sameKeys = (a: Organisation["monerium"], b: NonNullable<Organisation["monerium"]>) =>
  !!a && a.clientId === b.clientId && sameSecret(a.clientSecretEnc, b.clientSecretEnc);

/** The Monerium profile the company's issued IBAN belongs to, if one is. */
export async function issuedProfileId(orgId: string): Promise<string | undefined> {
  const a = (await store.accountsOf(orgId)).find((x) => x.currency === "EUR" && x.identifier?.iban && x.moneriumProfile);
  return a?.moneriumProfile?.id;
}

const ISSUED_PROFILE_MISSING = {
  code: "MONERIUM_PROFILE_CHANGED",
  error: "These keys don't open the company profile the company's IBAN belongs to. Use keys from that same Monerium company account.",
};

const KEYS_CHANGED = {
  code: "MONERIUM_KEYS_CHANGED",
  error: "The company's Monerium keys were replaced or removed while they were being checked. Open Settings again to see the current keys.",
};

export function createOrgMoneriumRoutes(deps: OrgRoutes, verify: Verify = verifyCompanyKeys, stepUp: StepUp = liveStepUp): express.Router {
  const r = express.Router();

  /** Session, role, then org kind: the three checks, in that order. Run
   *  again after every wait on Monerium, so what is written is decided on the
   *  org and membership as they are then, not as they were before the call. */
  const gate = async (req: express.Request, res: express.Response) => {
    const ctx = await deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (!requirePermission(ctx, res, "accounts.open")) return undefined;
    if (orgEntity(ctx.org) !== "company") {
      res.status(409).json(NOT_A_COMPANY);
      return undefined;
    }
    return ctx;
  };

  r.get("/:orgId/monerium", async (req, res) => {
    const ctx = await gate(req, res);
    if (!ctx) return;
    res.json({ monerium: await publicOrgMonerium(ctx.org) });
  });

  r.post("/:orgId/monerium", wrap(async (req, res) => {
    const ctx = await gate(req, res);
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
    // The keys as they are before any wait (ctx.org is the live row).
    const before = ctx.org.monerium ? { ...ctx.org.monerium } : undefined;
    // Replacing keys that are stored: the passkey approves it, before Monerium is asked.
    if (before && !(await stepUp(ctx.userId, req.body, res))) return;
    let verified;
    try {
      verified = await verify(input.clientId, input.clientSecret);
    } catch (err) {
      const no = refusal(err);
      if (no.status === 400) await store.audit(auditEntry("partner.call_refused", { partner: "monerium", status: 400, orgId: ctx.org.id }, ctx.userId));
      return res.status(no.status).json(no.body);
    }
    // Once the company's IBAN is issued, its profile is fixed: replacement
    // keys must open that same profile, or the IBAN could no longer be read.
    const issuedTo = await issuedProfileId(ctx.org.id);
    const profile = issuedTo ? storedProfile(verified.profiles, issuedTo) : corporateProfile(verified.profiles);
    if (!profile) return res.status(409).json(issuedTo ? ISSUED_PROFILE_MISSING : NO_COMPANY_PROFILE);
    // A member removed or demoted, or the org no longer a company, while Monerium answered: nothing is stored.
    const cur = await gate(req, res);
    if (!cur) return;
    // Keys connected or replaced by someone else meanwhile are not written
    // over: a first connection was approved by nobody's passkey, and a
    // replacement only for the keys that were there.
    if (before ? !sameKeys(cur.org.monerium, before) : !!cur.org.monerium) return res.status(409).json(KEYS_CHANGED);
    let clientSecretEnc: string;
    try {
      clientSecretEnc = SECRETS.orgMoneriumApiSecret.seal(ctx.org.id, input.clientSecret);
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) return res.status(503).json({ error: err.message });
      throw err;
    }
    const now = new Date().toISOString();
    // Compared again on the stored row as it is written. The Safe's link
    // belongs to the profile: kept for the same one, dropped for another.
    const org = await store.updateOrganisationIf(
      ctx.org.id,
      (o) => (before ? sameKeys(o.monerium, before) : !o.monerium),
      (o) => {
        const prior = o.monerium;
        const safe = prior?.safe && prior.profile.id === profile.id ? { safe: prior.safe } : {};
        return { monerium: { clientId: input.clientId, clientSecretEnc, profile, connectedAt: now, checkedAt: now, connectedByMemberId: ctx.member.id, ...safe } };
      },
    );
    if (!org) return res.status(409).json(KEYS_CHANGED);
    await store.audit(auditEntry("partner.credentials_connected", { partner: "monerium", orgId: org.id, profileState: profile.state }, ctx.userId));
    res.status(201).json({ monerium: await publicOrgMonerium(org) });
  }));

  r.post("/:orgId/monerium/check", wrap(async (req, res) => {
    const ctx = await gate(req, res);
    if (!ctx) return;
    const m = ctx.org.monerium;
    if (!m) return res.status(409).json({ error: "no Monerium keys are connected", code: "MONERIUM_NOT_CONNECTED" });
    let verified;
    try {
      verified = await verify(m.clientId, SECRETS.orgMoneriumApiSecret.open(ctx.org.id, m.clientSecretEnc));
    } catch (err) {
      const no = refusal(err);
      if (no.status !== 400) return res.status(no.status).json(no.body);
    }
    // Who may write, and over which keys, is decided now: an owner may have
    // removed or replaced the keys, or this member, while Monerium answered.
    const cur = await gate(req, res);
    if (!cur) return;
    if (!sameKeys(cur.org.monerium, m)) return res.status(409).json(KEYS_CHANGED);
    const at = new Date().toISOString();
    // Each write below is compared again on the stored row.
    const write = async (extra: Partial<NonNullable<Organisation["monerium"]>>) => {
      const org = await store.updateOrganisationIf(ctx.org.id, (o) => sameKeys(o.monerium, m), (o) => {
        const { rejectedAt: _r, profileMissingAt: _p, ...rest } = o.monerium!;
        return { monerium: { ...rest, checkedAt: at, ...extra } };
      });
      if (!org) res.status(409).json(KEYS_CHANGED);
      return org;
    };
    if (!verified) {
      // Monerium refused keys it accepted before: say so, keep the row so an
      // admin sees what was connected and replaces it.
      const org = await write({ rejectedAt: at });
      if (!org) return;
      await store.audit(auditEntry("partner.call_refused", { partner: "monerium", status: 400, orgId: ctx.org.id }, ctx.userId));
      return res.json({ monerium: await publicOrgMonerium(org) });
    }
    // The profile the keys opened at connect is the company's. If the keys no
    // longer open it, the connection is invalid until it is back or the keys
    // are replaced; a different one is never silently adopted.
    const profile = storedProfile(verified.profiles, m.profile.id);
    if (!profile) {
      const org = await write({ profileMissingAt: at });
      if (!org) return;
      return res.status(409).json({
        code: "MONERIUM_PROFILE_CHANGED",
        error: "These keys no longer open the company profile they were connected with. Remove the keys and connect the company's current keys.",
        monerium: await publicOrgMonerium(org),
      });
    }
    const org = await write({ profile });
    if (!org) return;
    res.json({ monerium: await publicOrgMonerium(org) });
  }));

  r.delete("/:orgId/monerium", wrap(async (req, res) => {
    const ctx = await gate(req, res);
    if (!ctx) return;
    if (!ctx.org.monerium) return res.status(409).json({ error: "no Monerium keys are connected", code: "MONERIUM_NOT_CONNECTED" });
    const approved = { ...ctx.org.monerium };
    if (!(await stepUp(ctx.userId, req.body, res))) return;
    // Decided on the org and membership as they are after the approval: only
    // the keys the passkey approved removing are removed.
    const cur = await gate(req, res);
    if (!cur) return;
    if (!sameKeys(cur.org.monerium, approved)) return res.status(409).json(KEYS_CHANGED);
    const org = await store.updateOrganisation(ctx.org.id, { monerium: undefined });
    await store.audit(auditEntry("partner.credentials_removed", { partner: "monerium", orgId: org.id }, ctx.userId));
    res.json({ monerium: await publicOrgMonerium(org) });
  }));

  return r;
}
