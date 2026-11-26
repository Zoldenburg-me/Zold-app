/**
 * /api/orgs/:orgId/drafts/:draftId/bank-run: a company pays a payment run of
 * bank payees from its own IBAN (design note §3.3, §5 step 4).
 *
 * Each line is one Monerium redeem order from the company Safe, built and
 * signed exactly as a single payout is (org-monerium-payouts.ts): Monerium's
 * redeem message for that amount and IBAN, signed by an owner's passkey,
 * becomes the Safe's EIP-1271 signature (threshold 1 only). Zold holds no
 * key. One passkey prompt per line, because each line's message is different.
 *
 *  - POST /start → every check, then one challenge per line for this owner's
 *    passkey. Nothing is written to the draft and nothing is sent.
 *  - POST { runId, assertions: [{ requestId, authenticatorData,
 *    clientDataJSON, signature }] } → every check again, every assertion
 *    verified, the draft claimed, then one order at a time.
 *
 * Q9 asks for all lines or none, which separate redeem orders cannot give.
 * The rule (domain/company-bank-run.ts): nothing is sent until every line is
 * checked and signed; then the lines go in order, and the run stops at the
 * first line Monerium does not accept. Lines already accepted stay accepted;
 * no later line is ever sent; an `unknown` line is never retried.
 *
 * Each line is a CompanyBankPayout row on the company account, so the
 * statement books it as `sepa_out` once Monerium reports it processed, like a
 * single payout, and the list in Settings re-reads it.
 *
 * Off unless MONERIUM_ORG_PAYOUTS=on, like single payouts.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { SECURITY } from "../../config.js";
import { ibanChecksumValid, normaliseIban } from "../../domain/contacts.js";
import { orgEntity } from "../../domain/org-entity.js";
import { activity, currentFingerprint } from "../../domain/drafts.js";
import { paymentReference } from "../../domain/invoices.js";
import { paymentReviewRequired } from "../../domain/payment-review.js";
import { roleCan } from "../../domain/roles.js";
import { publicPayout } from "../../domain/org-monerium-payout.js";
import {
  COMPANY_BANK_RUN_MAX_LINES, bankRunDraftState, bankRunReport, markSending, stopRun,
} from "../../domain/company-bank-run.js";
import type { CompanyBankPayout, CompanyBankRun, DraftPayment, DraftState } from "../../domain/types.js";
import { redactedMessage } from "../../http/log-cause.js";
import { moneriumRedeemMessage, paymentMemo, redeemMessageStale } from "../../sepa.js";
import { store } from "../../store.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../../webauthn.js";
import { safeMessageHash } from "../../wallet/candide.js";
import { passkeySafeChallenge } from "../../wallet/passkey-safe-plan.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import { orgMoneriumStatus } from "./org-monerium.js";
import {
  APPROVAL_WINDOW_MS, Refusal, livePayoutIo, low, payoutKit, pendingPayouts, prune,
  type OrgPayoutIo, type PendingPayout,
} from "./org-monerium-payouts.js";
import { contactsById, reconcileDrift, withExecutionState } from "./state.js";

type Hex = `0x${string}`;

/** One line, checked and ready to sign. */
interface PlannedLine {
  lineId: string;
  recipientName: string;
  recipientIban: string;
  amountEur: number;
  invoiceId?: string;
}

/** An amount string with at most two decimals, in euros, or null. */
function eurOf(raw: string): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return cents / 100;
}

/** The states a run may be sent from: the org's review policy decides, as for
 *  every other draft (drafts.ts). */
const claimableOf = (ctx: OrgContext): DraftState[] => (paymentReviewRequired(ctx.org) ? ["REVIEWED"] : ["DRAFT", "REVIEWED"]);

/**
 * Every line, checked against the address book as it is now, or the reasons
 * it cannot be paid. Each bank account read is checked against the line's
 * approved fingerprint (INVALID_DATA): an edit landing after the drift check
 * must not plan an IBAN nobody approved.
 */
async function planLines(draft: DraftPayment): Promise<{ plans: PlannedLine[]; problems: { lineId: string; reason: string }[] }> {
  const plans: PlannedLine[] = [];
  const problems: { lineId: string; reason: string }[] = [];
  const contacts = await contactsById(draft.orgId);
  const invoiced = new Set<string>();
  for (const line of draft.lines) {
    const d = line.destination;
    if (d.kind !== "bank") {
      problems.push({ lineId: line.id, reason: "A bank run pays bank accounts only. Pay a wallet in a payment of its own." });
      continue;
    }
    if (line.invoiceId) {
      if (invoiced.has(line.invoiceId)) {
        problems.push({ lineId: line.id, reason: "This line pays the same invoice as an earlier line. Pay an invoice in one line." });
        continue;
      }
      invoiced.add(line.invoiceId);
    }
    const contact = line.contactId ? contacts.get(line.contactId) : undefined;
    const bank = contact && contact.orgId === draft.orgId ? contact.bankAccounts.find((b) => b.id === d.bankAccountId) : undefined;
    if (!contact || !bank) {
      problems.push({ lineId: line.id, reason: "The saved bank account is gone." });
      continue;
    }
    if (!d.fingerprint || currentFingerprint(line, contact) !== d.fingerprint) {
      problems.push({ lineId: line.id, reason: "This recipient changed after the draft was approved." });
      continue;
    }
    if (bank.currency !== "EUR" || line.asset.toUpperCase() !== "EUR" || !bank.iban) {
      problems.push({ lineId: line.id, reason: "A company pays bank accounts in euros only, from its IBAN." });
      continue;
    }
    const iban = normaliseIban(bank.iban);
    if (!ibanChecksumValid(iban)) {
      problems.push({ lineId: line.id, reason: "The saved IBAN is not valid. Correct it in the address book." });
      continue;
    }
    const name = (bank.holderName ?? "").trim();
    if (!name || name.length > 140 || /[\u0000-\u001f\u007f]/.test(name)) {
      problems.push({ lineId: line.id, reason: "The account holder’s name is missing or contains a character a bank cannot carry." });
      continue;
    }
    const amountEur = eurOf(line.amount);
    if (amountEur === null) {
      problems.push({ lineId: line.id, reason: `€${line.amount} is not an amount in euros and cents.` });
      continue;
    }
    plans.push({ lineId: line.id, recipientName: name, recipientIban: iban, amountEur, ...(line.invoiceId ? { invoiceId: line.invoiceId } : {}) });
  }
  return { plans, problems };
}

const sumEur = (xs: { amountEur: number }[]) => Math.round(xs.reduce((s, x) => s + x.amountEur * 100, 0)) / 100;

export function createOrgMoneriumBankRunRoutes(
  deps: { ctxOf: (req: express.Request, res: express.Response) => Promise<OrgContext | undefined> },
  io: OrgPayoutIo = livePayoutIo,
): express.Router {
  const r = express.Router();
  const { payoutable, writePayout, availableNow, placePayout } = payoutKit(io);

  /** Who may sign: an owner (transfers.sign) of a company. Whether their
   *  passkey is one of the Safe's owners is payoutable's check. */
  const gate = async (req: express.Request, res: express.Response) => {
    const ctx = await deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (orgEntity(ctx.org) !== "company") {
      res.status(409).json({ code: "NOT_A_COMPANY", error: "Only a company pays a bank run from its own IBAN." });
      return undefined;
    }
    if (!roleCan(ctx.member.role, "transfers.sign", "company")) {
      res.status(403).json({
        code: "OWNER_SIGNS",
        error: "An owner signs the company’s bank payments with their passkey. Your role can prepare this payment; ask an owner to send it.",
      });
      return undefined;
    }
    if (!requirePermission(ctx, res, "transfers.sign")) return undefined;
    return ctx;
  };

  const answer = (res: express.Response, err: unknown) => {
    if (err instanceof Refusal) return res.status(err.status).json({ code: err.code, error: err.message });
    throw err;
  };

  /** The draft, if it is this org's run from the company's account and may
   *  be sent now; otherwise the refusal is already sent. */
  async function sendable(ctx: OrgContext, res: express.Response, draftId: string, accountId: string) {
    const draft = await store.findDraft(draftId);
    if (!draft || draft.orgId !== ctx.org.id) {
      res.status(404).json({ error: "no such draft" });
      return undefined;
    }
    if (draft.bankRun || draft.state === "EXECUTING" || draft.state === "EXECUTED" || draft.state === "FAILED") {
      res.status(409).json({ code: "RUN_ALREADY_SENT", error: "This payment run was already signed and sent. Nothing more can be sent from it: create a new payment." });
      return undefined;
    }
    const checked = await reconcileDrift(draft);
    if (checked.state === "INVALID_DATA") {
      res.status(409).json({ code: "INVALID_DATA", error: "Some recipients changed since this draft was approved. It has been held. Nothing was sent.", draft: checked });
      return undefined;
    }
    const claimable = claimableOf(ctx);
    if (!claimable.includes(checked.state)) {
      res.status(409).json({
        code: "NOT_SENDABLE",
        error: paymentReviewRequired(ctx.org)
          ? `This draft is ${checked.state}. This organisation requires a second person to review a payment before it can be sent.`
          : checked.state === "PENDING_REVIEW"
            ? "This draft is waiting for review. It was submitted while review applied, so it is sent once someone reviews it."
            : `This draft is ${checked.state} and cannot be sent from that state.`,
      });
      return undefined;
    }
    if (checked.source.kind !== "account" || checked.source.accountId !== accountId) {
      res.status(409).json({ code: "NOT_THE_COMPANY_ACCOUNT", error: "This draft does not pay from the company’s IBAN account, so it cannot be sent as a bank run." });
      return undefined;
    }
    if (checked.lines.length > COMPANY_BANK_RUN_MAX_LINES) {
      res.status(422).json({
        code: "RUN_TOO_LONG",
        error: `A company bank run pays at most ${COMPANY_BANK_RUN_MAX_LINES} lines: each line is its own passkey signature, and all of them must be signed within a few minutes. Split this payment.`,
      });
      return undefined;
    }
    return { draft: checked, claimable };
  }

  r.post("/:orgId/drafts/:draftId/bank-run/start", wrap(async (req, res) => {
    const ctx = await gate(req, res);
    if (!ctx) return;
    let s;
    try {
      s = await payoutable(ctx);
    } catch (err) {
      return answer(res, err);
    }
    const draftId = String(req.params.draftId);
    // A new start replaces this member's run of this draft still waiting for
    // a passkey: it would otherwise hold the same euros until it expires.
    for (const [k, v] of pendingPayouts) {
      if (v.draftId === draftId && v.memberId === ctx.member.id && !v.submitting) pendingPayouts.delete(k);
    }
    const ok = await sendable(ctx, res, draftId, s.account.id);
    if (!ok) return;
    const { plans, problems } = await planLines(ok.draft);
    if (problems.length) {
      return res.status(422).json({ code: "LINES_NOT_PAYABLE", error: `${problems.length} of ${ok.draft.lines.length} line(s) cannot be paid. Nothing was sent.`, problems });
    }
    if (!plans.length) return res.status(422).json({ code: "LINES_NOT_PAYABLE", error: "This draft has no lines to pay." });
    // The total against what the Safe holds less every payout already
    // holding money: orders Monerium holds or may hold, and approvals waiting
    // in this process. N lines that each fit can still overdraw together.
    const totalEur = sumEur(plans);
    let available;
    try {
      available = await availableNow(s.account.id, ctx.org.id, s.plan.address);
    } catch (err) {
      return answer(res, err);
    }
    if (totalEur > available + 1e-9) {
      return res.status(409).json({
        code: "AMOUNT_OVER_BALANCE",
        error: `This run sends €${totalEur.toFixed(2)} in total, and the company Safe has €${available.toFixed(2)} available for payouts. Nothing was sent.`,
        totalEur,
        availableEur: available,
      });
    }
    prune();
    const runId = randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = Date.now() + APPROVAL_WINDOW_MS;
    const lines = [];
    for (const p of plans) {
      const invoice = p.invoiceId ? await store.findInvoice(p.invoiceId) : undefined;
      const reference = invoice && invoice.orgId === ctx.org.id
        ? paymentReference(invoice, ctx.org.name)
        : `${ctx.org.name} ${ok.draft.id.slice(0, 8)}`.slice(0, 140);
      const requestId = randomUUID();
      const redeem = moneriumRedeemMessage(p.amountEur, p.recipientIban, issuedAt);
      const memo = paymentMemo(requestId, reference);
      const challenge = passkeySafeChallenge(safeMessageHash(s.plan.address, redeem.message));
      const hold: PendingPayout & { plannedAt: string } = {
        requestId,
        orgId: ctx.org.id,
        memberId: ctx.member.id,
        userId: ctx.userId,
        safeAddress: s.plan.address as Hex,
        ownerAddress: s.owner,
        profileId: ctx.org.monerium!.profile.id,
        challenge,
        amountEur: p.amountEur,
        recipientName: p.recipientName,
        recipientIban: p.recipientIban,
        reference,
        memo,
        message: redeem.message,
        issuedAt,
        expiresAt,
        runId,
        draftId: ok.draft.id,
        lineId: p.lineId,
        plannedAt: ok.draft.updatedAt,
      };
      pendingPayouts.set(requestId, hold);
      lines.push({
        lineId: p.lineId,
        requestId,
        challenge,
        message: redeem.message,
        amount: redeem.amount,
        amountEur: p.amountEur,
        iban: redeem.iban,
        recipientName: p.recipientName,
        reference,
      });
    }
    res.status(201).json({
      runId,
      credentialId: s.passkey.credentialId,
      rpId: s.passkey.rpId ?? SECURITY.rpId,
      totalEur,
      availableEur: available,
      expiresAt: new Date(expiresAt).toISOString(),
      lines,
      submitTo: `/api/orgs/${ctx.org.id}/drafts/${ok.draft.id}/bank-run`,
      note: `${lines.length} bank payment(s). Sign each with your passkey; nothing is sent until every line is signed. They are then sent one at a time, and the run stops at the first one Monerium does not accept.`,
    });
  }));

  r.post("/:orgId/drafts/:draftId/bank-run", wrap(async (req, res) => {
    const ctx = await gate(req, res);
    if (!ctx) return;
    const draftId = String(req.params.draftId);
    const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
    const holds = [...pendingPayouts.values()].filter((p) => runId && p.runId === runId) as (PendingPayout & { plannedAt: string })[];
    if (!holds.length || holds.some((h) => h.orgId !== ctx.org.id || h.userId !== ctx.userId || h.memberId !== ctx.member.id || h.draftId !== draftId)) {
      return res.status(409).json({ code: "RUN_NOT_STARTED", error: "Start again: sign the payment run with your passkey when asked." });
    }
    if (holds.some((h) => h.submitting)) {
      return res.status(409).json({ code: "RUN_NOT_STARTED", error: "This payment run is already being sent. Wait for it to finish." });
    }
    const raw: unknown[] = Array.isArray(req.body?.assertions) ? req.body.assertions : [];
    const byRequest = new Map<string, { authenticatorData: string; clientDataJSON: string; signature: string }>();
    for (const a of raw as any[]) {
      if (typeof a?.requestId !== "string" || typeof a.authenticatorData !== "string" || typeof a.clientDataJSON !== "string" || typeof a.signature !== "string") {
        return res.status(400).json({ error: "Each assertion needs requestId, authenticatorData, clientDataJSON and signature." });
      }
      byRequest.set(a.requestId, a);
    }
    if (byRequest.size !== raw.length || holds.length !== byRequest.size || holds.some((h) => !byRequest.has(h.requestId))) {
      return res.status(400).json({ code: "RUN_INCOMPLETE", error: "Every line of the run must be signed, once each. Nothing was sent." });
    }
    if (redeemMessageStale(holds[0].issuedAt)) {
      for (const h of holds) pendingPayouts.delete(h.requestId);
      return res.status(409).json({ code: "PAYOUT_EXPIRED", error: "The approval for this payment run expired before it was sent, so nothing was sent. Start again." });
    }
    // The holds stay until each line's payout row is written: another
    // payout cannot claim the same euros while this run is checked and sent.
    for (const h of holds) h.submitting = true;
    try {
      // ── Everything again, before anything is sent ─────────────────────
      let s;
      try {
        s = await payoutable(ctx);
      } catch (err) {
        return answer(res, err);
      }
      if (holds.some((h) => low(s.plan.address) !== low(h.safeAddress) || low(s.owner) !== low(h.ownerAddress))) {
        return res.status(409).json({ code: "RUN_NOT_STARTED", error: "The company’s Safe or your passkey changed since you started. Nothing was sent. Start again." });
      }
      const ok = await sendable(ctx, res, draftId, s.account.id);
      if (!ok) return;
      const plannedAt = holds[0].plannedAt;
      if (ok.draft.updatedAt !== plannedAt) {
        return res.status(409).json({ code: "DRAFT_CHANGED", error: "This draft changed after you signed it. Nothing was sent. Look at it again and sign it again." });
      }
      // What is sent is what was signed: the same lines, payees and amounts,
      // re-read from the address book now.
      const { plans, problems } = await planLines(ok.draft);
      if (problems.length) {
        return res.status(422).json({ code: "LINES_NOT_PAYABLE", error: `${problems.length} of ${ok.draft.lines.length} line(s) cannot be paid. Nothing was sent.`, problems });
      }
      const ordered: { plan: PlannedLine; hold: PendingPayout & { plannedAt: string } }[] = [];
      for (const plan of plans) {
        const hold = holds.find((h) => h.lineId === plan.lineId);
        if (!hold || hold.recipientIban !== plan.recipientIban || hold.recipientName !== plan.recipientName || Math.abs(hold.amountEur - plan.amountEur) > 1e-9) {
          return res.status(409).json({ code: "DRAFT_CHANGED", error: "A line changed after you signed it. Nothing was sent. Start again." });
        }
        ordered.push({ plan, hold });
      }
      if (ordered.length !== holds.length) {
        return res.status(409).json({ code: "DRAFT_CHANGED", error: "The run’s lines changed after you signed it. Nothing was sent. Start again." });
      }
      const totalEur = sumEur(plans);
      let available;
      try {
        available = await availableNow(s.account.id, ctx.org.id, s.plan.address, runId);
      } catch (err) {
        return answer(res, err);
      }
      if (totalEur > available + 1e-9) {
        return res.status(409).json({
          code: "AMOUNT_OVER_BALANCE",
          error: `This run sends €${totalEur.toFixed(2)} in total, and the company Safe now has €${available.toFixed(2)} available for payouts. Nothing was sent.`,
        });
      }
      // Every assertion, in line order: authenticator counters rise with
      // each ceremony. One that fails sends nothing.
      let count = s.passkey.signCount ?? 0;
      for (const { hold } of ordered) {
        const a = byRequest.get(hold.requestId)!;
        try {
          const { signCount } = await verifyAssertionForChallenge(
            a.authenticatorData, a.clientDataJSON, a.signature,
            s.passkey.publicKey!, count, s.passkey.rpId ?? SECURITY.rpId, SECURITY.origins, hold.challenge, true,
          );
          if (!(await store.recordPasskeyUse(s.user.id, s.passkey.credentialId, signCount))) throw new Error("this passkey is no longer the account's passkey");
          count = signCount;
        } catch (err) {
          return res.status(401).json({ code: "PASSKEY_INVALID", error: `${redactedMessage(err)}. Nothing was sent.` });
        }
      }
      // The member and the keys as they are now: a role revoked, or keys
      // replaced, while the passkeys were checked means nothing is sent.
      const orgNow = (await store.findOrganisation(ctx.org.id))!;
      const memberNow = (await store.membersOf(ctx.org.id)).find((m) => m.id === ctx.member.id);
      if (!memberNow || memberNow.status !== "active" || !roleCan(memberNow.role, "transfers.sign", "company")) {
        return res.status(403).json({ code: "NOT_A_SIGNER", error: "Your role changed while the run was being approved. Nothing was sent." });
      }
      if (!orgNow.monerium || orgMoneriumStatus(orgNow.monerium) !== "connected") {
        return res.status(409).json({ code: "MONERIUM_KEYS_CHANGED", error: "The company’s Monerium keys changed meanwhile. Nothing was sent. Open Settings → Monerium and start again." });
      }
      const signatures = ordered.map(({ hold }) => {
        const a = byRequest.get(hold.requestId)!;
        return io.sign(s.signer, {
          authenticatorData: b64urlToBuf(a.authenticatorData),
          clientDataJSON: b64urlToBuf(a.clientDataJSON),
          signature: b64urlToBuf(a.signature),
        });
      });

      // ── Claim: refused if anyone wrote the draft since it was signed ───
      const claimed = await store.claimDraftExecution(draftId, ok.claimable, plannedAt);
      if (!claimed) {
        return res.status(409).json({ code: "DRAFT_CHANGED", error: "This draft changed while it was being sent. Nothing was sent; check it and send again." });
      }
      const run: CompanyBankRun = {
        accountId: s.account.id,
        safeAddress: s.plan.address as Hex,
        signedByMemberId: ctx.member.id,
        issuedAt: holds[0].issuedAt,
        lines: ordered.map(({ plan, hold }) => ({
          lineId: plan.lineId,
          payoutId: hold.requestId,
          amountEur: plan.amountEur,
          recipientName: plan.recipientName,
          recipientIban: plan.recipientIban,
          state: "signed",
        })),
      };
      await store.appendDraftActivity(claimed.id, activity(ctx.member.id, "executing", `${run.lines.length} bank payment(s) signed; sent one at a time from the company’s IBAN.`), { bankRun: run });

      // ── One order at a time; the first not accepted stops the run ──────
      let stop: { status: number; code: string; error: string } | undefined;
      for (let i = 0; i < ordered.length; i++) {
        const { hold } = ordered[i];
        if (redeemMessageStale(hold.issuedAt)) {
          stop = { status: 409, code: "PAYOUT_EXPIRED", error: "The approval expired before every line was sent." };
          break;
        }
        const at = new Date().toISOString();
        const payout: CompanyBankPayout = {
          id: hold.requestId,
          amountEur: hold.amountEur,
          recipientName: hold.recipientName,
          recipientIban: hold.recipientIban,
          ...(hold.reference ? { reference: hold.reference } : {}),
          memo: hold.memo,
          message: hold.message,
          issuedAt: hold.issuedAt,
          safeAddress: hold.safeAddress,
          profileId: hold.profileId,
          signedByMemberId: ctx.member.id,
          draftId,
          lineId: hold.lineId,
          // Written before Monerium is asked, as a single payout is.
          state: "unknown",
          error: "Zold has not confirmed this payout with Monerium yet. If it stays this way, check Monerium before sending it again.",
          createdAt: at,
          updatedAt: at,
        };
        // The line reads `sending` first: a process that stops from here on
        // leaves it unclear, never not sent.
        await store.tx(async () => {
          await store.lockKey(`draft:${draftId}`);
          const d = (await store.findDraft(draftId))!;
          await store.updateDraft(draftId, { bankRun: markSending(d.bankRun!, payout.id) });
        });
        await writePayout(s.account.id, payout);
        pendingPayouts.delete(hold.requestId);
        const sent = await placePayout(orgNow, ctx.userId, s.account.id, payout, signatures[i]);
        const row = (await store.findAccount(s.account.id))?.moneriumPayouts?.find((p) => p.id === payout.id);
        if (!row || row.state === "failed" || row.state === "unknown") {
          stop = {
            status: row?.state === "unknown" ? 502 : sent.status >= 400 ? sent.status : 409,
            code: row?.state === "unknown" ? "MONERIUM_UNSURE" : sent.body.code ?? "MONERIUM_REFUSED",
            error: row?.state === "unknown"
              ? `Monerium did not confirm the payment to ${hold.recipientName}. It may have been accepted, so check Monerium before paying it again.`
              : `Monerium did not accept the payment to ${hold.recipientName}.`,
          };
          break;
        }
      }
      if (stop) {
        const why = "Not sent: the run stopped at an earlier line.";
        await store.tx(async () => {
          await store.lockKey(`draft:${draftId}`);
          const d = (await store.findDraft(draftId))!;
          const stopped = stopRun(d.bankRun!, why);
          await store.appendDraftActivity(draftId, activity(ctx.member.id, "execution_failed", `${stop!.error} ${bankRunReport(stopped)}`), {
            bankRun: stopped,
            state: bankRunDraftState(stopped),
            failureReason: bankRunReport(stopped),
          });
        });
      }
      const view = await withExecutionState((await store.findDraft(draftId))!);
      const payouts = ((await store.findAccount(s.account.id))?.moneriumPayouts ?? []).filter((p) => p.draftId === draftId).map(publicPayout);
      if (stop) {
        return res.status(stop.status).json({ code: stop.code, error: `${stop.error} The run stopped there: no later line was sent. ${view.failureReason ?? ""}`.trim(), draft: view, payouts });
      }
      return res.status(201).json({ draft: view, payouts, note: `${payouts.length} bank payment(s) placed with Monerium. Each is booked once Monerium reports it sent.` });
    } finally {
      for (const h of holds) pendingPayouts.delete(h.requestId);
    }
  }));

  return r;
}
