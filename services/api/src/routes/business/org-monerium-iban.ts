/**
 * /api/orgs/:orgId/monerium/{link,iban,deposits}: a company's IBAN on its own
 * Safe (design note §3.3), on the company's own Monerium keys
 * (./org-monerium.ts).
 *
 *  - POST link/start → the passkey challenge for the Safe's ownership
 *    declaration (Monerium's LINK_MESSAGE, as a Safe message).
 *  - POST link { requestId, authenticatorData, clientDataJSON, signature } →
 *    the owner's assertion becomes the Safe's EIP-1271 signature; Monerium
 *    links the Safe under the company profile; Zold requests the IBAN.
 *  - POST iban/check → reads where Monerium has got, and opens the account
 *    once an IBAN is attributed to the Safe.
 *  - GET deposits → the company's incoming bank transfers as Monerium lists
 *    them, read live and stored nowhere.
 *
 * Who signs: an owner member whose login passkey is an owner of the Safe on
 * chain (transfers.sign; only owners sign on a company). The API holds no key:
 * without that owner's fresh assertion there is no signature. Only a Safe at
 * threshold 1 can be linked here: collecting several owners' signatures on a
 * message is not built, and the route refuses by name rather than send a
 * signature the Safe would reject.
 *
 * The IBAN opens the account only when Monerium attributes it to this Safe
 * under the company profile (address-matched, as for a person). A profile
 * whose one IBAN pays another address is refused: moving it is not built.
 * Paying out from the company's IBAN is ./org-monerium-payouts.ts (one redeem
 * signed by an owner); a company bank run stays refused by name in drafts.ts.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { WebauthnPublicKey } from "abstractionkit";
import { auditEntry } from "../../audit.js";
import { MONERIUM, SECURITY } from "../../config.js";
import { orgEntity } from "../../domain/org-entity.js";
import { OrgSafePlanRefusal, orgSafePlan } from "../../domain/org-safe-plan.js";
import { assertReadableSafeState } from "../../domain/safe-op-queue.js";
import { companyEurAccount, companyIbanIssued, companyIbanState } from "../../domain/org-monerium-iban.js";
import { moneriumIbanList } from "../../domain/monerium-profile.js";
import type { Organisation } from "../../domain/types.js";
import { LINK_MESSAGE, MoneriumApiError, MoneriumClient, type MoneriumOrder, type MoneriumRedeemOrder } from "../../adapters/monerium-client.js";
import { redactedMessage } from "../../http/log-cause.js";
import { SECRETS } from "../../stored-secrets.js";
import { store } from "../../store.js";
import { sameSecret } from "../../store/rules.js";
import { normalizeIban } from "../../sepa.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../../webauthn.js";
import { orgSafeMessageSignature, safeMessageHash, webauthnOwnerFromJwk, type BrowserPasskeyAssertion } from "../../wallet/candide.js";
import { passkeySafeChallenge } from "../../wallet/passkey-safe-plan.js";
import { liveOrgSafeReader, ownerAddressOfMember, type OrgSafeReader } from "../../wallet/org-signers.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import { orgMoneriumStatus, publicOrgMonerium } from "./org-monerium.js";

type Hex = `0x${string}`;

/** The calls on the company's keys, injectable so a suite runs offline. */
export interface CompanyMonerium {
  linkAddress(params: { address: string; signature: string; chain: string; message: string; profile: string }): Promise<unknown>;
  /** The profile Monerium has `address` linked under, or undefined. */
  linkedProfile(address: string): Promise<string | undefined>;
  requestIban(address: string, chain: string): Promise<unknown>;
  ibans(): Promise<unknown>;
  orders(profileId: string): Promise<unknown>;
  /** A redeem from the company's Safe: the SEPA payout (org-monerium-payouts.ts). */
  placeOrder(body: MoneriumRedeemOrder): Promise<MoneriumOrder>;
  getOrder(orderId: string): Promise<MoneriumOrder>;
}

export interface OrgMoneriumIbanIo {
  monerium(org: Organisation): CompanyMonerium;
  safe: OrgSafeReader;
  /** The Safe's EIP-1271 signature from one owner's assertion (threshold 1). */
  sign(owner: WebauthnPublicKey, assertion: BrowserPasskeyAssertion): Hex;
}

/** A client on the company's own keys, opened for this call only. */
export function companyMoneriumClient(org: Organisation): CompanyMonerium {
  const m = org.monerium;
  if (!m) throw new Error("no Monerium keys are connected");
  const client = new MoneriumClient({ baseUrl: MONERIUM.baseUrl, clientId: m.clientId, clientSecret: SECRETS.orgMoneriumApiSecret.open(org.id, m.clientSecretEnc) });
  return {
    linkAddress: (p) => client.linkAddress(p),
    async linkedProfile(address) {
      try {
        const rec = await client.address(address);
        return typeof rec?.profile === "string" && rec.profile ? rec.profile : undefined;
      } catch (err) {
        // Not linked (yet) is a 404; anything else is a failed read.
        if (err instanceof MoneriumApiError && err.status === 404) return undefined;
        throw err;
      }
    },
    requestIban: (address, chain) => client.requestIban(address, chain),
    ibans: () => client.ibans(),
    orders: (profileId) => client.orders(profileId),
    placeOrder: (body) => client.placeOrder(body),
    getOrder: (orderId) => client.getOrder(orderId),
  };
}

export const liveIbanIo: OrgMoneriumIbanIo = { monerium: companyMoneriumClient, safe: liveOrgSafeReader, sign: orgSafeMessageSignature };

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const low = (a: string) => a.toLowerCase();

/** Does Monerium's IBAN record pay into this Safe on OUR chain? Monerium
 *  links one address on several chains; a record without a chain is taken on
 *  the address (as paysInto in adapters/monerium-sandbox.ts). */
const paysIntoSafe = (i: { address?: unknown; chain?: unknown }, address: string) =>
  typeof i.address === "string" && low(i.address) === low(address) && (!i.chain || i.chain === MONERIUM.chain);

/** The same stored keys: a write after a wait only lands on the keys it read. */
const sameKeys = (a: Organisation["monerium"], b: NonNullable<Organisation["monerium"]>) =>
  !!a && a.clientId === b.clientId && sameSecret(a.clientSecretEnc, b.clientSecretEnc);

/** Monerium's 304 for a profile that already has its one IBAN (fetch drops a
 *  304's body, so the status is the signal). */
const profileHasIban = (err: unknown) => err instanceof MoneriumApiError && (err.status === 304 || /already has an iban/i.test(err.message));
/** "Already linked" and the like: done, not refused. */
const alreadyDone = (err: unknown) => err instanceof MoneriumApiError && err.status < 500 && /already|exist|duplicate/i.test(err.message);

/** A Monerium failure as an answer: its response body stays out of the
 *  browser and the log, only the status is logged. */
function moneriumFailure(what: string, err: unknown): Refusal {
  const why = err instanceof MoneriumApiError ? `Monerium answered ${err.status}` : redactedMessage(err);
  console.warn(`org-monerium-iban: ${what} failed: ${why}`);
  if (err instanceof MoneriumApiError && err.status >= 400 && err.status < 500) {
    return new Refusal(400, "MONERIUM_REFUSED", `Monerium refused ${what}. Nothing else was changed.`);
  }
  return new Refusal(503, "MONERIUM_UNREACHABLE", `Monerium could not be reached for ${what}. Try again in a minute.`);
}

/** One pending declaration: challenged for one owner of one org's Safe. */
interface PendingLink {
  orgId: string;
  memberId: string;
  userId: string;
  safeAddress: Hex;
  ownerAddress: string;
  challenge: string;
  expiresAt: number;
}
const pendingLinks = new Map<string, PendingLink>();
const prune = () => {
  for (const [k, v] of pendingLinks) if (v.expiresAt < Date.now()) pendingLinks.delete(k);
};

/**
 * The keys as they are now, if they are still the ones `m` was read with:
 * every write after a wait on Monerium goes through this, in one store.tx
 * with the write, so keys an owner removed or replaced meanwhile are never
 * written back.
 */
const stillKeys = async (orgId: string, m: NonNullable<Organisation["monerium"]>) => {
  // Locked (inside the store.tx every caller runs it in): the keys stay
  // the ones compared until the write commits.
  const cur = (await store.lockOrganisation(orgId))?.monerium;
  if (!sameKeys(cur, m)) throw new Refusal(409, "MONERIUM_KEYS_CHANGED", "The company’s Monerium keys were replaced or removed meanwhile. Open Settings → Monerium again.");
  return cur!;
};

/**
 * An issued IBAN, read again: Monerium can move it to another address or
 * chain. Only a positive answer that it now pays elsewhere closes the
 * account (gated, the IBAN no longer offered); an outage or an IBAN Monerium
 * does not list changes nothing. A new destination is never adopted.
 */
async function recheckIssued(io: OrgMoneriumIbanIo, orgId: string, userId?: string): Promise<void> {
  const org = (await store.findOrganisation(orgId))!;
  const m = org.monerium!;
  const account0 = companyEurAccount(await store.accountsOf(orgId))!;
  let list;
  try {
    list = moneriumIbanList(await io.monerium(org).ibans());
  } catch (err) {
    throw moneriumFailure("reading the company’s IBANs", err);
  }
  await store.tx(async () => {
    const cur = await stillKeys(orgId, m);
    const account = (await store.findAccount(account0.id))!;
    if (!account.identifier.iban) return; // gated by a recheck that landed first
    const iban = normalizeIban(account.identifier.iban);
    // As applyIbanBinding: two records for one IBAN decide nothing.
    const hits = list.filter((i) => normalizeIban(i.iban) === iban);
    const entry = hits.length === 1 ? hits[0] : undefined;
    if (!entry || typeof entry.address !== "string" || paysIntoSafe(entry, account.address!)) return;
    if (cur.safe) await store.updateOrganisation(orgId, { monerium: { ...cur, safe: { ...cur.safe, movedAwayAt: new Date().toISOString() } } });
    await store.updateAccount(account.id, {
      status: "gated",
      identifier: { ...account.identifier, iban: undefined },
      detail: "Monerium now lists the company's IBAN on another address or network, so it is no longer offered for this Safe.",
      // On the account, not the key record: Remove keys deletes that record,
      // and reconnecting the same profile must not offer a fresh issue while
      // Monerium still pays the IBAN elsewhere.
      moneriumIban: { safeAddress: account.address!, profileId: m.profile.id, movedAwayAt: new Date().toISOString() },
    });
    await store.audit(auditEntry("org_iban.moved_away", { orgId, accountId: account.id, safeAddress: account.address }, userId));
  });
}

/**
 * An IBAN Monerium moved, read again after the keys were removed and
 * reconnected (the key record and its link are gone then). An approved
 * IBAN on the current profile paying into the company Safe on our chain
 * reopens the account and clears the move; anything else keeps it moved.
 */
async function recheckMoved(io: OrgMoneriumIbanIo, orgId: string, userId?: string): Promise<void> {
  const org = (await store.findOrganisation(orgId))!;
  const m = org.monerium!;
  const account0 = companyEurAccount(await store.accountsOf(orgId))!;
  const plan = orgSafePlan(org);
  let list;
  try {
    list = moneriumIbanList(await io.monerium(org).ibans());
  } catch (err) {
    throw moneriumFailure("reading the company’s IBANs", err);
  }
  const ours = list.find((i) => i.profile === m.profile.id && i.state === "approved" && paysIntoSafe(i, plan.address));
  // Written only against the account and keys as they are now.
  await store.tx(async () => {
    const cur = await stillKeys(orgId, m);
    const account = (await store.findAccount(account0.id))!;
    if (!ours) {
      // Another check reopened it after this read: a stale "away" is dropped.
      if (companyIbanIssued(account)) return;
      const movedAt = cur.safe?.movedAwayAt ?? account.moneriumIban?.movedAwayAt ?? new Date().toISOString();
      await store.updateAccount(account.id, { moneriumIban: { safeAddress: plan.address as Hex, profileId: m.profile.id, movedAwayAt: movedAt } });
      return;
    }
    const at = new Date().toISOString();
    await store.updateAccount(account.id, {
      status: "active",
      provider: "monerium",
      identifier: { ...account.identifier, iban: normalizeIban(ours.iban) },
      gate: undefined,
      detail: undefined,
      moneriumProfile: { id: m.profile.id, kind: "corporate", ...(m.profile.name ? { name: m.profile.name } : {}), checkedAt: at },
      moneriumIban: { safeAddress: plan.address as Hex, profileId: m.profile.id },
    });
    await store.audit(auditEntry("org_iban.issued", { orgId, accountId: account.id, safeAddress: plan.address, profileId: m.profile.id }, userId));
  });
}


/** When each company's IBAN was last re-read by recheckCompanyIbans. */
const ibanCheckedAt = new Map<string, number>();

/**
 * Every company's IBAN, re-read on its own keys, as verifyIbanBinding does for
 * a person (adapters/monerium-sandbox.ts, from the same poller): an issued one
 * Monerium now pays elsewhere comes off the account, a moved one attributed to
 * the Safe again returns. At most once per MONERIUM.ibanCheckMs per company; a
 * read that fails changes nothing.
 */
export async function recheckCompanyIbans(io: OrgMoneriumIbanIo = liveIbanIo): Promise<void> {
  for (const org of await store.list("organisations")) {
    if (orgEntity(org) !== "company" || !org.monerium) continue;
    const state = companyIbanState(org, companyEurAccount(await store.accountsOf(org.id)));
    if (state !== "issued" && !(state === "moved" && orgMoneriumStatus(org.monerium) === "connected")) continue;
    const last = ibanCheckedAt.get(org.id);
    if (last !== undefined && Date.now() - last < MONERIUM.ibanCheckMs) continue;
    ibanCheckedAt.set(org.id, Date.now());
    try {
      await (state === "issued" ? recheckIssued : recheckMoved)(io, org.id);
    } catch (err) {
      // moneriumFailure has logged a Monerium answer; keys replaced meanwhile wait for the next pass.
      if (!(err instanceof Refusal)) console.warn(`org-monerium-iban: re-reading the IBAN of ${org.id} failed: ${redactedMessage(err)}`);
    }
  }
}

export function createOrgMoneriumIbanRoutes(deps: { ctxOf: (req: express.Request, res: express.Response) => Promise<OrgContext | undefined> }, io: OrgMoneriumIbanIo = liveIbanIo): express.Router {
  const r = express.Router();

  /** Session, role, company: the three checks. */
  const gate = async (req: express.Request, res: express.Response, permission: "transfers.sign" | "accounts.open") => {
    const ctx = await deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (!requirePermission(ctx, res, permission)) return undefined;
    if (orgEntity(ctx.org) !== "company") {
      res.status(409).json({ code: "NOT_A_COMPANY", error: "Only a company has an IBAN on its own Safe." });
      return undefined;
    }
    return ctx;
  };

  /**
   * What must hold before an owner signs, and again before the signature is
   * sent: approved keys, the company Safe set up behind its EUR account, a
   * readable Safe at threshold 1 with this member's passkey among its owners.
   */
  async function signable(ctx: OrgContext) {
    const org = ctx.org;
    if (orgMoneriumStatus(org.monerium) !== "connected") {
      throw new Refusal(409, "MONERIUM_NOT_CONNECTED", "Connect the company’s Monerium keys first, with a company profile Monerium has approved.");
    }
    let plan;
    try {
      plan = orgSafePlan(org);
    } catch (err) {
      if (err instanceof OrgSafePlanRefusal) throw new Refusal(err.status, err.code, err.message);
      throw err;
    }
    const account = companyEurAccount(await store.accountsOf(org.id));
    if (plan.status !== "active" || !account?.address || low(account.address) !== low(plan.address)) {
      throw new Refusal(409, "ORG_SAFE_NOT_DEPLOYED", "The company’s Safe is not set up yet. Set it up first, then issue its IBAN.");
    }
    const state = companyIbanState(org, account);
    if (state === "issued") throw new Refusal(409, "IBAN_ISSUED", "The company’s IBAN is already issued onto its Safe.");
    const owner = await ownerAddressOfMember(ctx.member);
    const user = await store.findUser(ctx.userId);
    const jwk = user?.passkey?.publicKey?.alg === "ES256" ? user.passkey.publicKey.jwk : undefined;
    const signer = jwk ? webauthnOwnerFromJwk(jwk) : null;
    if (!owner || !signer || !user?.passkey) {
      throw new Refusal(409, "NO_PASSKEY", "Your login has no passkey that can sign for the company’s Safe.");
    }
    let chain;
    try {
      chain = await io.safe.read(plan.address as Hex);
      assertReadableSafeState(plan.address, chain);
    } catch (err) {
      console.warn(`org-monerium-iban: reading the company Safe ${plan.address} failed: ${redactedMessage(err)}`);
      throw new Refusal(503, "SAFE_UNREADABLE", "The company Safe’s signers couldn’t be read from the chain just now. Try again in a minute.");
    }
    if (!chain.owners.some((o) => low(o) === low(owner))) {
      throw new Refusal(403, "NOT_A_SIGNER", "Your passkey is not one of the company Safe’s signers, so it cannot sign for it.");
    }
    if (chain.threshold !== 1) {
      throw new Refusal(409, "ORG_SAFE_NEEDS_MORE_SIGNATURES", `The company’s Safe needs ${chain.threshold} signatures, and Zold can collect only one for Monerium’s declaration so far. Nothing was sent.`);
    }
    return { org, plan, account, owner, signer, user, passkey: user.passkey };
  }

  const answer = (res: express.Response, err: unknown) => {
    if (err instanceof Refusal) return res.status(err.status).json({ code: err.code, error: err.message });
    throw err;
  };

  /**
   * Take the company Safe as far as Monerium has got: linked under the
   * company profile → IBAN requested → IBAN attributed → account open. Every
   * read is fresh. Refuses, and changes nothing, when the Safe is linked
   * under another profile or the profile's one IBAN pays another address or
   * chain.
   */
  async function advance(orgId: string, userId: string): Promise<void> {
    const org = (await store.findOrganisation(orgId))!;
    const m = org.monerium!;
    const link = m.safe!;
    const client = io.monerium(org);
    if (!link.linkedAt) {
      let under: string | undefined;
      try {
        under = await client.linkedProfile(link.address);
      } catch (err) {
        throw moneriumFailure("reading the Safe’s link", err);
      }
      if (!under) return; // Monerium has not linked it yet: link_pending.
      if (under !== m.profile.id) {
        throw new Refusal(409, "ADDRESS_NOT_ON_PROFILE", "Monerium has the company’s Safe linked under another profile, so no IBAN was requested. Monerium support has to move it; write to support@zoldhq.com.");
      }
      await store.tx(async () => {
        const cur = await stillKeys(orgId, m);
        await store.updateOrganisation(orgId, { monerium: { ...cur, safe: { ...cur.safe!, linkedAt: new Date().toISOString() } } });
      });
    }
    let hasOne = false;
    if (!link.ibanRequestedAt) {
      try {
        await client.requestIban(link.address, MONERIUM.chain);
      } catch (err) {
        if (profileHasIban(err)) hasOne = true;
        else if (!alreadyDone(err)) throw moneriumFailure("the IBAN request", err);
      }
      await store.tx(async () => {
        const cur = await stillKeys(orgId, m);
        await store.updateOrganisation(orgId, { monerium: { ...cur, safe: { ...cur.safe!, ibanRequestedAt: new Date().toISOString() } } });
      });
    }
    let list;
    try {
      list = moneriumIbanList(await client.ibans());
    } catch (err) {
      throw moneriumFailure("reading the company’s IBANs", err);
    }
    const onProfile = list.filter((i) => i.profile === m.profile.id && normalizeIban(i.iban));
    const ours = onProfile.find((i) => i.state === "approved" && paysIntoSafe(i, link.address));
    if (!ours) {
      // The profile's one IBAN pays another address, or this address on
      // another chain: never this Safe's.
      if (hasOne || onProfile.some((i) => typeof i.address === "string" && !paysIntoSafe(i, link.address))) {
        throw new Refusal(409, "PROFILE_IBAN_ELSEWHERE", "The company’s Monerium profile already has its one IBAN, paying into another address or network. Moving it onto the company’s Safe is not built; write to support@zoldhq.com.");
      }
      return; // iban_requested: Monerium has not issued it yet.
    }
    // Written only against the account and keys as they are now.
    await store.tx(async () => {
      await stillKeys(orgId, m);
      const account = companyEurAccount(await store.accountsOf(orgId));
      if (!account || !account.address || low(account.address) !== low(link.address)) return;
      const at = new Date().toISOString();
      await store.updateAccount(account.id, {
        status: "active",
        provider: "monerium",
        identifier: { ...account.identifier, iban: normalizeIban(ours.iban) },
        gate: undefined,
        detail: undefined,
        moneriumProfile: { id: m.profile.id, kind: "corporate", ...(m.profile.name ? { name: m.profile.name } : {}), checkedAt: at },
        // Monerium has the IBAN on this Safe again: a move it reported before
        // no longer stands, whichever key record is current.
        moneriumIban: { safeAddress: link.address, profileId: m.profile.id },
      });
      const after = (await store.findOrganisation(orgId))!.monerium!;
      if (after.safe?.movedAwayAt) await store.updateOrganisation(orgId, { monerium: { ...after, safe: { ...after.safe, movedAwayAt: undefined } } });
      await store.audit(auditEntry("org_iban.issued", { orgId, accountId: account.id, safeAddress: link.address, profileId: m.profile.id }, userId));
    });
  }

  const view = async (orgId: string) => ({ monerium: await publicOrgMonerium((await store.findOrganisation(orgId))!) });

  r.post("/:orgId/monerium/link/start", wrap(async (req, res) => {
    const ctx = await gate(req, res, "transfers.sign");
    if (!ctx) return;
    let s;
    try {
      s = await signable(ctx);
    } catch (err) {
      return answer(res, err);
    }
    prune();
    const requestId = randomUUID();
    const challenge = passkeySafeChallenge(safeMessageHash(s.plan.address, LINK_MESSAGE));
    pendingLinks.set(requestId, { orgId: ctx.org.id, memberId: ctx.member.id, userId: ctx.userId, safeAddress: s.plan.address as Hex, ownerAddress: s.owner, challenge, expiresAt: Date.now() + 5 * 60_000 });
    res.status(201).json({
      requestId,
      credentialId: s.passkey.credentialId,
      challenge,
      rpId: s.passkey.rpId ?? SECURITY.rpId,
      message: LINK_MESSAGE,
      address: s.plan.address,
      submitTo: `/api/orgs/${ctx.org.id}/monerium/link`,
    });
  }));

  r.post("/:orgId/monerium/link", wrap(async (req, res) => {
    const ctx = await gate(req, res, "transfers.sign");
    if (!ctx) return;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
    const pending = pendingLinks.get(requestId);
    if (!pending || pending.orgId !== ctx.org.id || pending.userId !== ctx.userId || pending.memberId !== ctx.member.id || pending.expiresAt < Date.now()) {
      return res.status(409).json({ code: "LINK_NOT_STARTED", error: "Start again: approve the declaration with your passkey when asked." });
    }
    pendingLinks.delete(requestId); // spent on use, whatever follows
    const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (typeof authenticatorData !== "string" || typeof clientDataJSON !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
    }
    let s;
    try {
      // Everything again: the org, the Safe's owners and threshold may have moved.
      s = await signable(ctx);
    } catch (err) {
      return answer(res, err);
    }
    if (low(s.plan.address) !== low(pending.safeAddress) || low(s.owner) !== low(pending.ownerAddress)) {
      return res.status(409).json({ code: "LINK_NOT_STARTED", error: "The company’s Safe or your passkey changed since you started. Start again." });
    }
    try {
      const { signCount } = await verifyAssertionForChallenge(authenticatorData, clientDataJSON, signature, s.passkey.publicKey!, s.passkey.signCount ?? 0, s.passkey.rpId ?? SECURITY.rpId, SECURITY.origins, pending.challenge, true);
      if (!(await store.recordPasskeyUse(s.user.id, s.passkey.credentialId, signCount))) throw new Error("this passkey is no longer the account's passkey");
    } catch (err) {
      return res.status(401).json({ code: "PASSKEY_INVALID", error: redactedMessage(err) });
    }
    const safeSignature = io.sign(s.signer, { authenticatorData: b64urlToBuf(authenticatorData), clientDataJSON: b64urlToBuf(clientDataJSON), signature: b64urlToBuf(signature) });
    // The keys are read now: replaced or removed while the passkey was being
    // checked, the current ones are used, and none refuses.
    const org = (await store.findOrganisation(ctx.org.id))!;
    const m = org.monerium;
    if (!m || orgMoneriumStatus(m) !== "connected") {
      return res.status(409).json({ code: "MONERIUM_NOT_CONNECTED", error: "The company’s Monerium keys changed meanwhile. Open Settings → Monerium and start again." });
    }
    try {
      await io.monerium(org).linkAddress({ address: s.plan.address, signature: safeSignature, chain: MONERIUM.chain, message: LINK_MESSAGE, profile: m.profile.id });
    } catch (err) {
      if (!alreadyDone(err)) return answer(res, moneriumFailure("linking the company’s Safe", err));
    }
    const at = new Date().toISOString();
    try {
      await store.tx(async () => {
        const cur = await stillKeys(org.id, m);
        await store.updateOrganisation(org.id, { monerium: { ...cur, safe: { address: s.plan.address as Hex, signedByMemberId: ctx.member.id, linkSubmittedAt: at } } });
      });
    } catch (err) {
      return answer(res, err);
    }
    await store.audit(auditEntry("org_iban.link_submitted", { orgId: org.id, safeAddress: s.plan.address, profileId: m.profile.id }, ctx.userId));
    try {
      await advance(org.id, ctx.userId);
    } catch (err) {
      if (err instanceof Refusal) return res.status(err.status).json({ code: err.code, error: err.message, ...(await view(org.id)) });
      throw err;
    }
    res.json(await view(org.id));
  }));

  r.post("/:orgId/monerium/iban/check", wrap(async (req, res) => {
    const ctx = await gate(req, res, "accounts.open");
    if (!ctx) return;
    const state = companyIbanState(ctx.org, companyEurAccount(await store.accountsOf(ctx.org.id)));
    if (state !== "link_pending" && state !== "iban_requested" && state !== "issued" && state !== "moved") return res.json(await view(ctx.org.id));
    if (!ctx.org.monerium || (state !== "issued" && orgMoneriumStatus(ctx.org.monerium) !== "connected")) {
      return res.status(409).json({ code: "MONERIUM_NOT_CONNECTED", error: "The company’s Monerium keys need attention first: open Settings → Monerium." });
    }
    try {
      if (state === "issued" || state === "moved") await (state === "issued" ? recheckIssued : recheckMoved)(io, ctx.org.id, ctx.userId);
      else await advance(ctx.org.id, ctx.userId);
    } catch (err) {
      if (err instanceof Refusal) return res.status(err.status).json({ code: err.code, error: err.message, ...(await view(ctx.org.id)) });
      throw err;
    }
    res.json(await view(ctx.org.id));
  }));

  r.get("/:orgId/monerium/deposits", wrap(async (req, res) => {
    const ctx = await gate(req, res, "accounts.open");
    if (!ctx) return;
    const account = companyEurAccount(await store.accountsOf(ctx.org.id));
    if (companyIbanState(ctx.org, account) !== "issued" || !ctx.org.monerium) return res.json({ deposits: [] });
    let raw: any;
    try {
      raw = await io.monerium(ctx.org).orders(ctx.org.monerium.profile.id);
    } catch (err) {
      return answer(res, moneriumFailure("reading the company’s deposits", err));
    }
    const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.orders) ? raw.orders : [];
    const safe = low(account!.address!);
    const deposits = list
      // Only EURe issued on OUR chain is a euro deposit to this account (as mirrorOrder).
      .filter((o) => o?.kind === "issue" && typeof o.address === "string" && low(o.address) === safe && o.chain === MONERIUM.chain && String(o.currency ?? "eur").toLowerCase() === "eur")
      .map((o) => {
        const d = o.counterpart?.details ?? {};
        const from = d.name || d.companyName || [d.firstName, d.lastName].filter(Boolean).join(" ") || undefined;
        return {
          id: String(o.id),
          amountEur: Number(o.amount),
          state: String(o.meta?.state ?? o.state ?? "unknown"),
          at: o.meta?.processedAt ?? o.meta?.placedAt ?? o.placedAt ?? "",
          ...(from ? { from: String(from) } : {}),
          ...(typeof o.memo === "string" && o.memo ? { memo: o.memo } : {}),
        };
      })
      .filter((d) => Number.isFinite(d.amountEur) && d.amountEur > 0)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 20);
    res.json({ deposits });
  }));

  return r;
}
