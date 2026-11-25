/**
 * /api/orgs/:orgId/monerium/payouts: paying a bank account from a company's
 * own IBAN (design note §3.3), as a SEPA credit transfer Monerium sends.
 *
 * A payout is one Monerium redeem order from the company Safe: the euros are
 * burned on chain and Monerium pays the recipient's IBAN. Zold holds no key:
 * an owner member whose login passkey is an owner of the Safe on chain signs
 * Monerium's redeem message ("Send EUR <amount> to <iban> at <time>") with
 * their passkey, and that assertion becomes the Safe's EIP-1271 signature
 * (orgSafeMessageSignature, threshold 1 only). Without that fresh assertion
 * there is no signature and no order.
 *
 *  - POST /start { recipientName, recipientIban, amountEur, reference? } →
 *    the challenge for that owner's passkey, and the exact message it signs.
 *  - POST { requestId, authenticatorData, clientDataJSON, signature } →
 *    re-reads everything, verifies the assertion, and places the redeem on the
 *    company's own Monerium keys. Nothing is retried automatically.
 *  - GET → the payouts as stored, with orders Monerium still holds re-read.
 *
 * Refusals are specific and change nothing: no approved keys, no Safe, no
 * issued IBAN, an IBAN Monerium lists on another address or network, an amount
 * over what the Safe holds, a Safe needing 2+ signatures, a stale approval.
 * Monerium's own response text never reaches the browser or the log: only the
 * status. A failure that may have placed an order is stored as `unknown`, not
 * as failed and never as sent.
 *
 * Off unless MONERIUM_ORG_PAYOUTS=on (config/monerium.ts). A company bank run
 * (several payees from one draft) is still refused by name in drafts.ts.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { WebauthnPublicKey } from "abstractionkit";
import { auditEntry } from "../../audit.js";
import { MONERIUM, SECURITY, orgPayoutsEnabled } from "../../config.js";
import { safeEurBalance } from "../../chain.js";
import { ibanChecksumValid, normaliseIban } from "../../domain/contacts.js";
import { orgEntity } from "../../domain/org-entity.js";
import { companyEurAccount, companyIbanState } from "../../domain/org-monerium-iban.js";
import { capPayouts, payoutStateOf, publicPayout, recentPayouts } from "../../domain/org-monerium-payout.js";
import { roleCan } from "../../domain/roles.js";
import { OrgSafePlanRefusal, orgSafePlan } from "../../domain/org-safe-plan.js";
import { assertReadableSafeState } from "../../domain/safe-op-queue.js";
import { moneriumIbanList } from "../../domain/monerium-profile.js";
import type { Account, CompanyBankPayout, Organisation } from "../../domain/types.js";
import { MoneriumAccessError, MoneriumApiError, isMoneriumOrderId } from "../../adapters/monerium-client.js";
import { redactedMessage } from "../../http/log-cause.js";
import { SEPA_REMITTANCE_MAX, moneriumAmountString, moneriumRedeemMessage, paymentMemo, redeemMessageStale } from "../../sepa.js";
import { store } from "../../store.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../../webauthn.js";
import { orgSafeMessageSignature, safeMessageHash, webauthnOwnerFromJwk, type BrowserPasskeyAssertion } from "../../wallet/candide.js";
import { passkeySafeChallenge } from "../../wallet/passkey-safe-plan.js";
import { liveOrgSafeReader, ownerAddressOfMember, type OrgSafeReader } from "../../wallet/org-signers.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import { companyMoneriumClient, type CompanyMonerium } from "./org-monerium-iban.js";
import { orgMoneriumStatus } from "./org-monerium.js";

type Hex = `0x${string}`;

/** How long an owner has to approve one payout: the same window Monerium
 *  accepts a redeem message in, less the time the fee-less order takes. */
const APPROVAL_WINDOW_MS = 4 * 60_000;

/** The calls on the company's keys, the chain read and the Safe signature,
 *  injectable so a suite runs offline. */
export interface OrgPayoutIo {
  monerium(org: Organisation): CompanyMonerium;
  safe: OrgSafeReader;
  /** The Safe's EIP-1271 signature from one owner's assertion (threshold 1). */
  sign(owner: WebauthnPublicKey, assertion: BrowserPasskeyAssertion): Hex;
  /** EURe on the Safe, in euros. */
  balance(address: Hex): Promise<number>;
}

export const livePayoutIo: OrgPayoutIo = {
  monerium: companyMoneriumClient,
  safe: liveOrgSafeReader,
  sign: orgSafeMessageSignature,
  balance: safeEurBalance,
};

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const low = (a: string) => a.toLowerCase();

/** A Monerium failure as an answer: its response body stays out of the
 *  browser and the log, only the status is logged. */
function moneriumFailure(what: string, err: unknown): Refusal {
  const why = err instanceof MoneriumApiError ? `Monerium answered ${err.status}` : redactedMessage(err);
  console.warn(`org-monerium-payouts: ${what} failed: ${why}`);
  if (err instanceof MoneriumApiError && err.status >= 400 && err.status < 500) {
    return new Refusal(400, "MONERIUM_REFUSED", `Monerium refused ${what}. Nothing else was changed.`);
  }
  return new Refusal(503, "MONERIUM_UNREACHABLE", `Monerium could not be reached for ${what}. Try again in a minute.`);
}

/** An amount in euros with at most two decimals, or null. */
function amountOf(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim().replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return cents / 100;
}

interface PayoutInput {
  amountEur: number;
  recipientName: string;
  recipientIban: string;
  reference?: string;
}

/** The form as checked values, or a refusal naming what to fix. */
function inputOf(body: unknown): PayoutInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const recipientName = typeof b.recipientName === "string" ? b.recipientName.trim() : "";
  if (!recipientName || recipientName.length > 140) {
    throw new Refusal(400, "RECIPIENT_NAME_INVALID", "Enter the recipient’s name (up to 140 characters).");
  }
  if (/[\u0000-\u001f\u007f]/.test(recipientName)) {
    throw new Refusal(400, "RECIPIENT_NAME_INVALID", "The recipient’s name contains a character a bank cannot carry.");
  }
  const recipientIban = typeof b.recipientIban === "string" ? normaliseIban(b.recipientIban) : "";
  if (!ibanChecksumValid(recipientIban)) {
    throw new Refusal(400, "RECIPIENT_IBAN_INVALID", "That is not a valid IBAN. Check it against the recipient’s details.");
  }
  const amountEur = amountOf(b.amountEur);
  if (amountEur === null) {
    throw new Refusal(400, "AMOUNT_INVALID", "Enter an amount in euros and cents, like 250 or 250.00.");
  }
  let reference: string | undefined;
  if (b.reference !== undefined && b.reference !== null) {
    if (typeof b.reference !== "string") throw new Refusal(400, "REFERENCE_INVALID", "The reference must be text.");
    reference = b.reference.trim();
    if (reference.length > SEPA_REMITTANCE_MAX) {
      throw new Refusal(400, "REFERENCE_INVALID", `The reference can be at most ${SEPA_REMITTANCE_MAX} characters.`);
    }
    if (!reference) reference = undefined;
  }
  return { amountEur, recipientName, recipientIban, ...(reference ? { reference } : {}) };
}

/** Monerium's counterpart details. The country is the IBAN's, and the name is
 *  split as the personal rail does; a company name still reaches the payee. */
function counterpartOf(recipientName: string, recipientIban: string) {
  const words = recipientName.split(/\s+/).filter(Boolean);
  return {
    identifier: { standard: "iban" as const, iban: recipientIban },
    details: {
      firstName: words.slice(0, -1).join(" ") || words[0],
      lastName: words.length > 1 ? words[words.length - 1] : words[0],
      country: recipientIban.slice(0, 2),
    },
  };
}

/** One approval waiting for its owner's passkey. */
interface PendingPayout {
  requestId: string;
  orgId: string;
  memberId: string;
  userId: string;
  safeAddress: Hex;
  ownerAddress: string;
  profileId: string;
  challenge: string;
  amountEur: number;
  recipientName: string;
  recipientIban: string;
  reference?: string;
  memo: string;
  message: string;
  issuedAt: string;
  expiresAt: number;
  /** Its submission has started: the hold stays until the payout row exists. */
  submitting?: boolean;
}
const pendingPayouts = new Map<string, PendingPayout>();
/** Which pending payouts the list re-reads next, per account, so an order
 *  Monerium keeps holding cannot starve the rest. */
const reconcileCursor = new Map<string, number>();
const prune = () => {
  for (const [k, v] of pendingPayouts) if (v.expiresAt < Date.now()) pendingPayouts.delete(k);
};

/** Drop approvals waiting in this process. For a suite that starts payouts
 *  without submitting them: they would otherwise claim balance in the next
 *  case (in a real process they expire in APPROVAL_WINDOW_MS). */
export const clearPendingPayouts = () => pendingPayouts.clear();

/** What the Safe holds less what payouts already claim: orders Monerium holds
 *  (`pending`) or may hold (`unknown`), and approvals in this process.
 *  `except` is the submission asking, whose own approval must not be counted
 *  twice (its row is written before it is released). */
function availableEur(account: Account, orgId: string, balanceEur: number, except?: string): number {
  const claimed = (account.moneriumPayouts ?? [])
    .filter((p) => p.state === "pending" || p.state === "unknown")
    .reduce((sum, p) => sum + p.amountEur, 0);
  prune();
  const authorising = [...pendingPayouts.values()]
    .filter((p) => p.orgId === orgId && p.requestId !== except)
    .reduce((sum, p) => sum + p.amountEur, 0);
  return Math.max(0, balanceEur - claimed - authorising);
}

export function createOrgMoneriumPayoutRoutes(
  deps: { ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined },
  io: OrgPayoutIo = livePayoutIo,
): express.Router {
  const r = express.Router();

  const gate = (req: express.Request, res: express.Response, permission: "transfers.sign" | "accounts.open") => {
    const ctx = deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (!requirePermission(ctx, res, permission)) return undefined;
    if (orgEntity(ctx.org) !== "company") {
      res.status(409).json({ code: "NOT_A_COMPANY", error: "Only a company pays a bank account from its own IBAN." });
      return undefined;
    }
    return ctx;
  };

  const answer = (res: express.Response, err: unknown) => {
    if (err instanceof Refusal) return res.status(err.status).json({ code: err.code, error: err.message });
    throw err;
  };

  /**
   * What must hold before an owner signs, and again before the order is sent:
   * the payout switch, approved keys, the company Safe behind its EUR account,
   * an issued IBAN Monerium still lists on this Safe and network, a readable
   * Safe at threshold 1 with this member's passkey among its owners.
   */
  async function payoutable(ctx: OrgContext) {
    if (!orgPayoutsEnabled()) {
      throw new Refusal(409, "ORG_PAYOUTS_OFF", "Bank payouts from a company’s IBAN are switched off on this deployment.");
    }
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
    const account = companyEurAccount(store.accountsOf(org.id));
    if (plan.status !== "active" || !account?.address || low(account.address) !== low(plan.address)) {
      throw new Refusal(409, "ORG_SAFE_NOT_DEPLOYED", "The company’s Safe is not set up yet, so nothing can be paid from it.");
    }
    // A move Monerium reported is kept on the account. It is checked before
    // the account's open state, so an account left open by an older build
    // cannot pay out from an IBAN that now pays elsewhere.
    const keys = org.monerium!;
    const moved = account.moneriumIban;
    if (moved?.movedAwayAt && moved.profileId === keys.profile.id && low(moved.safeAddress) === low(plan.address)) {
      throw new Refusal(409, "IBAN_MOVED", "Monerium lists the company’s IBAN on another address or network, so no payout can be sent from it. Write to support@zoldhq.com.");
    }
    const state = companyIbanState(org, account);
    if (state === "moved") {
      throw new Refusal(409, "IBAN_MOVED", "Monerium lists the company’s IBAN on another address or network, so no payout can be sent from it. Write to support@zoldhq.com.");
    }
    if (state !== "issued") {
      throw new Refusal(409, "IBAN_NOT_ISSUED", "The company has no IBAN on its Safe yet, so there is nothing to pay out from. Issue it in Settings → Monerium first.");
    }
    const owner = ownerAddressOfMember(ctx.member);
    const user = store.findUser(ctx.userId);
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
      console.warn(`org-monerium-payouts: reading the company Safe ${plan.address} failed: ${redactedMessage(err)}`);
      throw new Refusal(503, "SAFE_UNREADABLE", "The company Safe’s signers couldn’t be read from the chain just now. Try again in a minute.");
    }
    if (!chain.owners.some((o) => low(o) === low(owner))) {
      throw new Refusal(403, "NOT_A_SIGNER", "Your passkey is not one of the company Safe’s signers, so it cannot sign for it.");
    }
    if (chain.threshold !== 1) {
      throw new Refusal(409, "ORG_SAFE_NEEDS_MORE_SIGNATURES", `The company’s Safe needs ${chain.threshold} signatures, and Zold can collect only one for a Monerium payout so far. Nothing was sent.`);
    }
    // The IBAN as Monerium lists it right now: a move or a close is refused
    // before anything is signed, not discovered by Monerium mid-order.
    let list;
    try {
      list = moneriumIbanList(await io.monerium(org).ibans());
    } catch (err) {
      throw moneriumFailure("reading the company’s IBANs", err);
    }
    const iban = normaliseIban(account.identifier.iban!);
    const entry = list.find((i) => normaliseIban(i.iban) === iban);
    if (!entry) {
      throw new Refusal(409, "IBAN_NOT_LISTED", "Monerium no longer lists the company’s IBAN, so no payout can be sent from it. Check the account in Settings → Monerium.");
    }
    if (entry.profile !== keys.profile.id) {
      throw new Refusal(409, "IBAN_ON_ANOTHER_PROFILE", "Monerium lists the company’s IBAN under another profile, so no payout can be sent from it. Check the account in Settings → Monerium.");
    }
    if (typeof entry.address !== "string" || low(entry.address) !== low(plan.address) || (entry.chain && entry.chain !== MONERIUM.chain)) {
      throw new Refusal(409, "IBAN_MOVED", "Monerium lists the company’s IBAN on another address or network, so no payout can be sent from it. Write to support@zoldhq.com.");
    }
    if (entry.state !== "approved") {
      throw new Refusal(409, "IBAN_NOT_APPROVED", "Monerium has not approved the company’s IBAN, so no payout can be sent from it.");
    }
    return { org, plan, account, owner, signer, user, passkey: user.passkey };
  }

  /** The balance, or a refusal: an unreadable balance must not read as €0. */
  async function safeBalance(planAddress: string): Promise<number> {
    try {
      return await io.balance(planAddress as Hex);
    } catch (err) {
      console.warn(`org-monerium-payouts: reading the company Safe balance failed: ${redactedMessage(err)}`);
      throw new Refusal(503, "SAFE_BALANCE_UNREADABLE", "The company Safe’s balance couldn’t be read just now, so nothing was sent. Try again in a minute.");
    }
  }

  /** One payout row, written against the account as it is now. */
  const writePayout = (accountId: string, payout: CompanyBankPayout) => {
    const account = store.findAccount(accountId)!;
    store.updateAccount(accountId, { moneriumPayouts: capPayouts([payout, ...(account.moneriumPayouts ?? [])]) });
  };
  const patchPayout = (accountId: string, id: string, patch: Partial<CompanyBankPayout>) => {
    const account = store.findAccount(accountId)!;
    const at = new Date().toISOString();
    store.updateAccount(accountId, {
      moneriumPayouts: capPayouts((account.moneriumPayouts ?? []).map((p) => (p.id === id ? { ...p, ...patch, updatedAt: at } : p))),
    });
  };
  const payoutOf = (accountId: string, id: string): CompanyBankPayout =>
    store.findAccount(accountId)!.moneriumPayouts!.find((p) => p.id === id)!;

  r.post("/:orgId/monerium/payouts/start", wrap(async (req, res) => {
    const ctx = gate(req, res, "transfers.sign");
    if (!ctx) return;
    let s, input;
    try {
      input = inputOf(req.body);
      s = await payoutable(ctx);
    } catch (err) {
      return answer(res, err);
    }
    // A new start replaces this member's approvals still waiting for a
    // passkey (a cancelled prompt, say): they would otherwise hold the same
    // euros until they expire. One being submitted keeps its hold.
    for (const [k, v] of pendingPayouts) {
      if (v.orgId === ctx.org.id && v.memberId === ctx.member.id && !v.submitting) pendingPayouts.delete(k);
    }
    let available;
    try {
      available = availableEur(s.account, ctx.org.id, await safeBalance(s.plan.address));
    } catch (err) {
      return answer(res, err);
    }
    if (input.amountEur > available + 1e-9) {
      return res.status(409).json({
        code: "AMOUNT_OVER_BALANCE",
        error: `The company Safe has €${available.toFixed(2)} available for payouts, so €${input.amountEur.toFixed(2)} cannot be sent. Nothing was sent.`,
      });
    }
    prune();
    const requestId = randomUUID();
    const issuedAt = new Date().toISOString();
    const redeem = moneriumRedeemMessage(input.amountEur, input.recipientIban, issuedAt);
    const memo = paymentMemo(requestId, input.reference);
    const challenge = passkeySafeChallenge(safeMessageHash(s.plan.address, redeem.message));
    const expiresAt = Date.now() + APPROVAL_WINDOW_MS;
    pendingPayouts.set(requestId, {
      requestId,
      orgId: ctx.org.id,
      memberId: ctx.member.id,
      userId: ctx.userId,
      safeAddress: s.plan.address as Hex,
      ownerAddress: s.owner,
      profileId: ctx.org.monerium!.profile.id,
      challenge,
      amountEur: input.amountEur,
      recipientName: input.recipientName,
      recipientIban: input.recipientIban,
      ...(input.reference ? { reference: input.reference } : {}),
      memo,
      message: redeem.message,
      issuedAt,
      expiresAt,
    });
    res.status(201).json({
      requestId,
      credentialId: s.passkey.credentialId,
      challenge,
      rpId: s.passkey.rpId ?? SECURITY.rpId,
      message: redeem.message,
      amount: redeem.amount,
      amountEur: input.amountEur,
      iban: redeem.iban,
      recipientName: input.recipientName,
      ...(input.reference ? { reference: input.reference } : {}),
      memo,
      availableEur: available,
      expiresAt: new Date(expiresAt).toISOString(),
      submitTo: `/api/orgs/${ctx.org.id}/monerium/payouts`,
    });
  }));

  r.post("/:orgId/monerium/payouts", wrap(async (req, res) => {
    const ctx = gate(req, res, "transfers.sign");
    if (!ctx) return;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
    const pending = pendingPayouts.get(requestId);
    if (!pending || pending.orgId !== ctx.org.id || pending.userId !== ctx.userId || pending.memberId !== ctx.member.id) {
      return res.status(409).json({ code: "PAYOUT_NOT_STARTED", error: "Start again: approve the payout with your passkey when asked." });
    }
    if (pending.submitting) {
      return res.status(409).json({ code: "PAYOUT_NOT_STARTED", error: "This payout is already being sent. Wait for it to finish." });
    }
    const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (typeof authenticatorData !== "string" || typeof clientDataJSON !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
    }
    if (redeemMessageStale(pending.issuedAt)) {
      pendingPayouts.delete(requestId);
      return res.status(409).json({ code: "PAYOUT_EXPIRED", error: "The approval for this payout expired before it was sent, so nothing was sent. Start again." });
    }
    // The approval keeps its hold until its payout row is written: another
    // submission cannot claim the same euros while this one is being checked.
    pending.submitting = true;
    try {
      let s;
      try {
        // Everything again: the keys, the IBAN, the Safe's owners and threshold.
        s = await payoutable(ctx);
      } catch (err) {
        return answer(res, err);
      }
      if (low(s.plan.address) !== low(pending.safeAddress) || low(s.owner) !== low(pending.ownerAddress)) {
        return res.status(409).json({ code: "PAYOUT_NOT_STARTED", error: "The company’s Safe or your passkey changed since you started. Start again." });
      }
      let available;
      try {
        available = availableEur(s.account, ctx.org.id, await safeBalance(s.plan.address), requestId);
      } catch (err) {
        return answer(res, err);
      }
      if (pending.amountEur > available + 1e-9) {
        return res.status(409).json({
          code: "AMOUNT_OVER_BALANCE",
          error: `The company Safe now has €${available.toFixed(2)} available for payouts, so €${pending.amountEur.toFixed(2)} cannot be sent. Nothing was sent.`,
        });
      }
      try {
        const { signCount } = await verifyAssertionForChallenge(
          authenticatorData,
          clientDataJSON,
          signature,
          s.passkey.publicKey!,
          s.passkey.signCount ?? 0,
          s.passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          pending.challenge,
          true,
        );
        if (!store.recordPasskeyUse(s.user.id, s.passkey.credentialId, signCount)) throw new Error("this passkey is no longer the account's passkey");
      } catch (err) {
        return res.status(401).json({ code: "PASSKEY_INVALID", error: redactedMessage(err) });
      }
      // The member and the keys are read now: a role revoked, or keys
      // replaced or removed, while the passkey was being checked means
      // nothing is sent on either the old or the new state.
      const orgNow = store.findOrganisation(ctx.org.id)!;
      const memberNow = store.membersOf(ctx.org.id).find((m) => m.id === ctx.member.id);
      if (!memberNow || memberNow.status !== "active" || !roleCan(memberNow.role, "transfers.sign", "company")) {
        return res.status(403).json({ code: "NOT_A_SIGNER", error: "Your role changed while the payout was being approved. Nothing was sent." });
      }
      if (!orgNow.monerium || orgMoneriumStatus(orgNow.monerium) !== "connected") {
        return res.status(409).json({ code: "MONERIUM_KEYS_CHANGED", error: "The company’s Monerium keys changed meanwhile. Nothing was sent. Open Settings → Monerium and start again." });
      }
      const safeSignature = io.sign(s.signer, {
        authenticatorData: b64urlToBuf(authenticatorData),
        clientDataJSON: b64urlToBuf(clientDataJSON),
        signature: b64urlToBuf(signature),
      });
      const at = new Date().toISOString();
      const payout: CompanyBankPayout = {
        id: pending.requestId,
        amountEur: pending.amountEur,
        recipientName: pending.recipientName,
        recipientIban: pending.recipientIban,
        ...(pending.reference ? { reference: pending.reference } : {}),
        memo: pending.memo,
        message: pending.message,
        issuedAt: pending.issuedAt,
        safeAddress: pending.safeAddress,
        profileId: pending.profileId,
        signedByMemberId: ctx.member.id,
        // Written before Monerium is asked: if this process dies mid-call,
        // the row must say the outcome is unknown, never that Monerium holds
        // an order it may never have received.
        state: "unknown",
        error: "Zold has not confirmed this payout with Monerium yet. If it stays this way, check Monerium before sending it again.",
        createdAt: at,
        updatedAt: at,
      };
      writePayout(s.account.id, payout);
      const audit = (kind: "org_payout.placed" | "org_payout.sent" | "org_payout.refused" | "org_payout.unknown", extra: Record<string, unknown>) =>
        store.audit(auditEntry(kind, { orgId: ctx.org.id, accountId: s.account.id, payoutId: payout.id, amountEur: payout.amountEur, safeAddress: payout.safeAddress, ...extra }, ctx.userId));
      try {
        const order = await io.monerium(orgNow).placeOrder({
          address: pending.safeAddress,
          chain: MONERIUM.chain,
          kind: "redeem",
          amount: moneriumAmountString(pending.amountEur),
          currency: "eur",
          counterpart: counterpartOf(pending.recipientName, pending.recipientIban),
          message: pending.message,
          signature: safeSignature,
          memo: pending.memo,
        });
        const orderId = typeof order?.id === "string" && isMoneriumOrderId(order.id) ? order.id : undefined;
        const providerState = typeof order?.meta?.state === "string" ? order.meta.state : typeof order?.state === "string" ? order.state : undefined;
        if (!orderId) {
          // Accepted, but nothing can follow it: never shown as sent.
          patchPayout(s.account.id, payout.id, {
            state: "unknown",
            ...(providerState ? { providerState } : {}),
            error: "Monerium accepted the payout but returned no order id, so Zold cannot follow it. Check Monerium before sending it again.",
          });
          audit("org_payout.unknown", { reason: "no-order-id" });
          return res.status(202).json({ payout: publicPayout(payoutOf(s.account.id, payout.id)) });
        }
        const state = payoutStateOf(providerState);
        patchPayout(s.account.id, payout.id, {
          orderId,
          ...(providerState ? { providerState } : {}),
          state,
          error: state === "failed" ? "Monerium rejected the payout order. Nothing was sent." : undefined,
        });
        audit(state === "failed" ? "org_payout.refused" : state === "sent" ? "org_payout.sent" : "org_payout.placed", { orderId, ...(providerState ? { providerState } : {}) });
        return res.json({ payout: publicPayout(payoutOf(s.account.id, payout.id)) });
      } catch (err) {
        if (err instanceof MoneriumAccessError) {
          // The token grant failed, before POST /orders: no order exists.
          console.warn(`org-monerium-payouts: Monerium access failed: ${err.partnerStatus ?? "no status"}`);
          patchPayout(s.account.id, payout.id, {
            state: "failed",
            error: "Monerium refused Zold’s access to the company account, so no payout was sent. Check the keys in Settings → Monerium, then send it again.",
          });
          audit("org_payout.refused", { reason: "access" });
          return res.status(503).json({ code: "MONERIUM_NOT_CONNECTED", error: "Monerium refused Zold’s access to the company account, so no payout was sent.", payout: publicPayout(payoutOf(s.account.id, payout.id)) });
        }
        if (err instanceof MoneriumApiError && (err.status === 401 || err.status === 403)) {
          // "May not place it", so no order (the same reading as the personal rail).
          console.warn(`org-monerium-payouts: placing a payout was refused: Monerium answered ${err.status}`);
          patchPayout(s.account.id, payout.id, { state: "failed", error: "Monerium refused the payout. Nothing was sent." });
          audit("org_payout.refused", { status: err.status });
          return res.status(400).json({ code: "MONERIUM_REFUSED", error: "Monerium refused the payout. Nothing was sent.", payout: publicPayout(payoutOf(s.account.id, payout.id)) });
        }
        // A 400/409/422, a timeout, a 5xx or a reset may have placed an order.
        const why = err instanceof MoneriumApiError ? `Monerium answered ${err.status}` : redactedMessage(err);
        console.warn(`org-monerium-payouts: payout outcome unknown: ${why}`);
        patchPayout(s.account.id, payout.id, {
          state: "unknown",
          error: "Monerium did not confirm the payout. It may have accepted it, so check Monerium before sending it again. Nothing is retried automatically.",
        });
        audit("org_payout.unknown", err instanceof MoneriumApiError ? { status: err.status } : {});
        return res.status(502).json({ code: "MONERIUM_UNSURE", error: "Monerium did not confirm the payout. It may have been accepted, so check before sending it again.", payout: publicPayout(payoutOf(s.account.id, payout.id)) });
      }
    } finally {
      pendingPayouts.delete(requestId);
    }
  }));

  r.get("/:orgId/monerium/payouts", wrap(async (req, res) => {
    const ctx = gate(req, res, "accounts.open");
    if (!ctx) return;
    const account = companyEurAccount(store.accountsOf(ctx.org.id));
    if (!account) return res.json({ payouts: [] });
    // Orders Monerium still holds are re-read (at most five a call). A read
    // failure leaves the stored state: never a claim of success.
    if (ctx.org.monerium && orgMoneriumStatus(ctx.org.monerium) === "connected") {
      // Every pending order, oldest first, read five at a time from where the
      // last call stopped: an old order still reserving money is re-read too.
      const all = [...(account.moneriumPayouts ?? [])]
        .filter((p) => p.orderId && p.state === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const from = all.length ? (reconcileCursor.get(account.id) ?? 0) % all.length : 0;
      const waiting = [...all.slice(from), ...all.slice(0, from)].slice(0, 5);
      reconcileCursor.set(account.id, from + waiting.length);
      for (const p of waiting) {
        try {
          const order = await io.monerium(ctx.org).getOrder(p.orderId!);
          const providerState = typeof order?.meta?.state === "string" ? order.meta.state : typeof order?.state === "string" ? order.state : undefined;
          if (!providerState || providerState === p.providerState) continue;
          const state = payoutStateOf(providerState);
          patchPayout(account.id, p.id, {
            providerState,
            state,
            ...(state === "failed" ? { error: "Monerium rejected the payout order. Nothing was sent." } : {}),
          });
        } catch (err) {
          const why = err instanceof MoneriumApiError ? `Monerium answered ${err.status}` : redactedMessage(err);
          console.warn(`org-monerium-payouts: reading payout ${p.id} failed: ${why}`);
        }
      }
    }
    res.json({ payouts: recentPayouts(store.findAccount(account.id)!.moneriumPayouts).map(publicPayout) });
  }));

  return r;
}
