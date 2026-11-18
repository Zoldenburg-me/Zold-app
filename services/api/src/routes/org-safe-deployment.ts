/**
 * /api/orgs/:orgId/safe/deployment — a company org's own Safe, deployed with
 * the passkey of the owner who sets it up as its one first owner (design note
 * §2.2). The same two round trips as a person's Safe (routes/auth.ts): prepare,
 * the browser signs, submit. It cannot ride POST /api/orgs, which has no
 * passkey assertion, so a company's EUR account is opened `gated` with no
 * address and this sets it.
 *
 * Only an owner whose login passkey can sign for a Safe deploys it: the rule
 * signerRefusal states for every org Safe operation. Never the caller's
 * personal Safe, and the caller's personal Safe need not be activated
 * (custodyBlockerBeforeFunding gates a person's own funding, not this).
 *
 * Failure is asymmetric, like every Safe submit: a refusal the bundler states
 * writes nothing; an unconfirmed or reverted submit stores the plan `planned`,
 * so a retry re-reads the chain and finishes on the Safe that landed.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { auditEntry } from "../audit.js";
import { store, type User } from "../store.js";
import { orgEntity } from "../domain/org-entity.js";
import { copyOrgSafePlan, isOrgSafePlan } from "../domain/org-safe-plan.js";
import { signerRefusal } from "../domain/safe-op-queue.js";
import type { Account, OrgSafePlan } from "../domain/types.js";
import {
  BundlerRefusedError,
  SafeOperationUncertainError,
  isDeployed,
  orgSafeAccountFor,
  ownerAddressOfStored,
  passkeyAccountAddress,
  prepareOrgSafeDeployment,
  submitOrgSafeDeployment,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "../wallet/candide.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import { pendingOrgSafeDeployments, prunePendingOrgSafeDeployments } from "../http/pending.js";
import { checkOpAssertion } from "../http/passkey-assertion.js";
import { describeCause, redactedMessage } from "../http/log-cause.js";
import { b64urlToBuf } from "../webauthn.js";
import { resolveOrg, type OrgContext, type SessionResolver } from "./org-context.js";
import { wrap } from "./util.js";

/** The chain half, injectable so the suite runs without a bundler. */
export interface OrgSafeChain {
  prepare: typeof prepareOrgSafeDeployment;
  submit: typeof submitOrgSafeDeployment;
  isDeployed: typeof isDeployed;
}
const liveChain: OrgSafeChain = { prepare: prepareOrgSafeDeployment, submit: submitOrgSafeDeployment, isDeployed };

type Refusal = { status: number; code: string; error: string };

/** The company's one EUR account, which the Safe's address is written to. */
const eurAccountOf = (orgId: string): Account | undefined => store.accountsOf(orgId).find((a) => a.currency === "EUR");

/** The P-256 key the caller's login passkey signs a Safe with, if any. */
function passkeyOwnerOf(user: User | undefined) {
  const pk = user?.passkey?.publicKey;
  return pk && pk.alg === "ES256" ? webauthnOwnerFromJwk(pk.jwk) : null;
}

/** Whether an active owner of the org still logs in with the passkey this
 *  stored plan was made from. */
function planOwnerStillHere(orgId: string, plan: OrgSafePlan): boolean {
  const at = ownerAddressOfStored(plan.owners[0]).toLowerCase();
  return store.membersOf(orgId).some((m) => {
    if (m.status !== "active" || m.role !== "owner" || !m.userId) return false;
    const owner = passkeyOwnerOf(store.findUser(m.userId));
    return owner ? passkeyAccountAddress(owner).toLowerCase() === at : false;
  });
}

/**
 * The plan this caller may deploy, or why not. A stored plan (one whose
 * deployment may have landed) is the only one: its owner must be this
 * caller's passkey. With none stored, the plan is derived from this caller's
 * passkey and the org, and is written only once a submit may have landed.
 * One exception: a `planned` plan whose owner is no longer an active owner
 * here would strand the company, so another owner derives a new plan, marked
 * `replaces`; the route reads the chain before using it.
 */
function deployable(ctx: OrgContext, user: User | undefined, accounts = store.accountsOf(ctx.org.id)): { plan: OrgSafePlan; account: Account; replaces?: `0x${string}` } | Refusal {
  if (orgEntity(ctx.org) !== "company") {
    return { status: 409, code: "NOT_A_COMPANY", error: "Only a company has its own Safe; this organisation's account is backed by a member's own Safe." };
  }
  const account = accounts.find((a) => a.currency === "EUR");
  if (!account) return { status: 409, code: "NO_EUR_ACCOUNT", error: "Open the company’s euro account first; its Safe is set up for it." };
  if (ctx.org.safe && !isOrgSafePlan(ctx.org.safe)) {
    return { status: 409, code: "ORG_SAFE_UNREADABLE", error: "This company's Safe record is unreadable, so it can't be set up from here." };
  }
  const owner = passkeyOwnerOf(user);
  const ownerAddress = owner ? passkeyAccountAddress(owner) : null;
  let stored = ctx.org.safe ? copyOrgSafePlan(ctx.org.safe) : undefined;
  const orphaned = stored?.status === "planned" && !account.address && !planOwnerStillHere(ctx.org.id, stored);
  const replaces = orphaned ? stored!.address : undefined;
  if (orphaned) stored = undefined;
  const plan: OrgSafePlan | undefined = stored ?? (owner
    ? { kind: "org", status: "planned", address: orgSafeAccountFor(owner, ctx.org.id).accountAddress as `0x${string}`, owners: [webauthnOwnerToStore(owner)], createdAt: new Date().toISOString() }
    : undefined);
  const refused = signerRefusal(ctx.member, ownerAddress, plan ? plan.owners.map(ownerAddressOfStored) : []);
  if (refused) return refused;
  if (account.address && account.address.toLowerCase() !== plan!.address.toLowerCase()) {
    return { status: 409, code: "ACCOUNT_HAS_OTHER_SAFE", error: "This company's euro account already points at another Safe." };
  }
  // Every org's salt is its own, so this is a second line: no Safe that is
  // already another account's (or a person's) becomes this company's.
  const at = plan!.address.toLowerCase();
  const elsewhere = store.accounts.some((a) => a.orgId !== ctx.org.id && a.address?.toLowerCase() === at) ||
    store.users.some((u) => u.address?.toLowerCase() === at || u.passkeySafe?.address.toLowerCase() === at);
  if (elsewhere) return { status: 409, code: "SAFE_IN_OTHER_ORG", error: "This Safe address is already in use elsewhere, so it can't be the company's." };
  return { plan: plan!, account, ...(replaces ? { replaces } : {}) };
}

/** What GET .../accounts says about setting the Safe up, so the console
 *  offers the action only where the deployment route would accept it. */
export function orgSafeDeployOffer(ctx: OrgContext, user: User | undefined, accounts: Account[]): { allowed: boolean; reason?: string; code?: string } {
  const eur = accounts.find((a) => a.currency === "EUR");
  if (eur?.address && ctx.org.safe?.status === "active") return { allowed: false, code: "DEPLOYED" };
  const r = deployable(ctx, user, accounts);
  if ("plan" in r) return { allowed: true };
  // The queue's wording is about signing operations; on Accounts it is this.
  const reason = r.code === "NOT_A_SIGNER" ? "Only an owner can set up the company’s Safe." : r.error;
  return { allowed: false, reason, code: r.code };
}

/** Record a Safe the chain has: plan active, the account's address set, and
 *  the deploying owner's member row labelled with the owner address the Safe
 *  was deployed with (a label; the chain says who signs). The account stays
 *  `gated`: it has no IBAN until Monerium issues one. */
function finish(orgId: string, plan: OrgSafePlan, accountId: string, memberId: string) {
  store.setOrgSafePlan(orgId, { ...plan, status: "active" });
  store.updateMember(memberId, { signerAddress: ownerAddressOfStored(plan.owners[0]) });
  const account = store.findAccount(accountId)!;
  if (!account.address) store.updateAccount(accountId, { address: plan.address });
  return store.findAccount(accountId)!;
}

export function createOrgSafeDeploymentRoutes(requireSession: SessionResolver, chain: OrgSafeChain = liveChain): express.Router {
  const r = express.Router();
  const ctxOf = (req: express.Request, res: express.Response) => resolveOrg(req, res, requireSession);
  /** Orgs with a deployment being submitted: two owners' plans never race. */
  const submitting = new Set<string>();

  r.post("/:orgId/safe/deployment", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    const user = store.findUser(ctx.userId);
    const eur = eurAccountOf(ctx.org.id);
    if (eur?.address && ctx.org.safe?.status === "active" && orgEntity(ctx.org) === "company") {
      return res.json({ safeAddress: ctx.org.safe.address, status: "active" });
    }
    const d = deployable(ctx, user);
    if (!("plan" in d)) return res.status(d.status).json({ error: d.error, code: d.code });
    if (d.replaces) {
      // The plan's owner has left. Re-planned only where the chain has no
      // Safe at the old address; a read that fails refuses.
      let there: boolean;
      try {
        there = await chain.isDeployed(d.replaces);
      } catch (err) {
        return res.status(502).json({ error: `The company's planned Safe could not be checked on chain: ${redactedMessage(err)}`, code: "ORG_SAFE_PREPARE_FAILED" });
      }
      if (there) {
        return res.status(409).json({ error: "The company's Safe was deployed with the passkey of an owner who is no longer in the company, so it can't be set up again from here.", code: "ORG_SAFE_OWNER_GONE" });
      }
      store.replaceUndeployedOrgSafePlan(ctx.org.id, d.replaces, d.plan);
      store.audit(auditEntry("org_safe.replanned", { orgId: ctx.org.id, replaced: d.replaces, address: d.plan.address }, ctx.userId));
    }
    let prepared: Awaited<ReturnType<OrgSafeChain["prepare"]>>;
    try {
      prepared = await chain.prepare(d.plan, ctx.org.id);
    } catch (err) {
      return res.status(502).json({ error: `The company's Safe could not be prepared: ${redactedMessage(err)}`, code: "ORG_SAFE_PREPARE_FAILED" });
    }
    if (prepared.challenge === "0x") {
      // Already on chain (an earlier submit landed unconfirmed): record it.
      const account = finish(ctx.org.id, d.plan, d.account.id, ctx.member.id);
      return res.json({ safeAddress: d.plan.address, status: "active", accountId: account.id });
    }
    prunePendingOrgSafeDeployments();
    const requestId = randomUUID();
    const challenge = passkeySafeChallenge(prepared.challenge);
    pendingOrgSafeDeployments.set(requestId, {
      orgId: ctx.org.id, memberId: ctx.member.id, expiresAt: Date.now() + 5 * 60_000,
      userOperation: prepared.userOperation, challenge, plan: copyOrgSafePlan(d.plan),
    });
    res.status(201).json({
      requestId,
      safeAddress: d.plan.address,
      credentialId: user!.passkey!.credentialId,
      challenge,
      submitTo: `/api/orgs/${ctx.org.id}/safe/deployment/${requestId}`,
    });
  }));

  r.post("/:orgId/safe/deployment/:requestId", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    prunePendingOrgSafeDeployments();
    const pending = pendingOrgSafeDeployments.get(req.params.requestId);
    if (!pending || pending.orgId !== ctx.org.id || pending.memberId !== ctx.member.id) {
      return res.status(404).json({ error: "This Safe set-up request was not found or has expired. Start again." });
    }
    const user = store.findUser(ctx.userId);
    // Checked again: the role, the passkey or the stored plan may have
    // changed since the prepare.
    const d = deployable(ctx, user);
    if (!("plan" in d)) return res.status(d.status).json({ error: d.error, code: d.code });
    if (d.plan.address.toLowerCase() !== pending.plan.address.toLowerCase() || d.plan.owners[0].x !== pending.plan.owners[0].x || d.plan.owners[0].y !== pending.plan.owners[0].y) {
      pendingOrgSafeDeployments.delete(req.params.requestId);
      return res.status(409).json({ error: "The company's Safe changed since this was prepared. Start again.", code: "ORG_SAFE_CHANGED" });
    }
    if (submitting.has(ctx.org.id)) return res.status(409).json({ error: "The company's Safe is being set up already.", code: "ORG_SAFE_DEPLOYING" });
    // Claimed BEFORE the await: two parallel submits of one signature must
    // not both send the deployment.
    pendingOrgSafeDeployments.delete(req.params.requestId);
    submitting.add(ctx.org.id);
    try {
      if (!(await checkOpAssertion(user!, req.body, pending.challenge, res))) return;
      const { authenticatorData, clientDataJSON, signature } = req.body;
      let op;
      try {
        op = await chain.submit(pending.plan, ctx.org.id, pending.userOperation, {
          authenticatorData: b64urlToBuf(authenticatorData),
          clientDataJSON: b64urlToBuf(clientDataJSON),
          signature: b64urlToBuf(signature),
        });
      } catch (err) {
        if (err instanceof BundlerRefusedError) {
          return res.status(502).json({ error: `${redactedMessage(err)} — the company's Safe was not set up. Start again.`, code: "BUNDLER_REFUSED" });
        }
        if (!(err instanceof SafeOperationUncertainError)) throw err;
        console.error(`org safe deploy: operation ${err.userOpHash} unconfirmed:`, describeCause(err.cause));
        // It may still land: the plan is kept, so a retry finds that Safe.
        store.setOrgSafePlan(ctx.org.id, pending.plan);
        return res.status(502).json({
          error: `${redactedMessage(err)} — the company's Safe is not recorded as set up until that is confirmed; try again shortly`,
          code: "SAFE_OP_UNCONFIRMED",
          deployOpHash: err.userOpHash,
        });
      }
      if (op.success !== true) {
        // Included: a deployment's account is created before its call runs,
        // so the plan is kept and a retry reads the chain.
        store.setOrgSafePlan(ctx.org.id, pending.plan);
        return res.status(502).json({ error: `The deployment ${op.userOpHash} was included but reverted. Try again.`, code: "SAFE_OP_REVERTED", deployOpHash: op.userOpHash });
      }
      const account = finish(ctx.org.id, pending.plan, d.account.id, ctx.member.id);
      res.status(201).json({ safeAddress: pending.plan.address, status: "active", accountId: account.id, deployOpHash: op.userOpHash });
    } finally {
      submitting.delete(ctx.org.id);
    }
  }));

  return r;
}
