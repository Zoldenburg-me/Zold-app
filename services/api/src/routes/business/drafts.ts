/**
 * Draft payments: compose, edit, submit, review, execute.
 *
 * Four eyes: the reviewer may not be the drafter, whatever their role.
 * Any edit, with or without new lines, makes the editor the drafter.
 *
 * All-or-nothing at execution: every line is planned before anything is
 * created (wallet destinations, gated currencies, sub-fee and over-cap amounts
 * all refuse up front), and the balance is checked as a total, because N lines
 * that each fit can still overdraw together.
 *
 * INVALID_DATA: a draft whose payee changed after it was saved is held, not
 * retargeted. The fingerprint is recomputed at review and again at execution,
 * because an address-book edit can land between approval and execution.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import { FX, railFeeEur } from "../../config.js";
import { createQuote } from "../../fx.js";
import { MONERIUM_NOT_CONNECTED, moneriumLiveFor } from "../../adapters/monerium-connection.js";
import { accountBalances } from "../../chain.js";
import { CURRENCY_REGISTRY, accountIsSpendable } from "../../domain/accounts.js";
import { canReviewDraft, roleCan } from "../../domain/roles.js";
import { auditProfileCheck, checkBackingProfile } from "../../adapters/monerium-profile.js";
import {
  CSV_MAX_BYTES,
  activity,
  assertTransition,
  importCsv,
  isCancellable,
  isEditable,
  totalsByAsset,
  validateLine,
} from "../../domain/drafts.js";
import { paymentReference } from "../../domain/invoices.js";
import type { DraftPayment, DraftState } from "../../domain/types.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { paymentReviewRequired } from "../../domain/payment-review.js";
import { limitsFor } from "../../domain/plans.js";
import {
  badRequest, type TransferFactory,
} from "./shared.js";
import {
  contactsById, reconcileDrift, releaseInvoicesOf, withExecutionState,
} from "./state.js";
import { CEILINGS, ceilingRefusal } from "../../domain/ceilings.js";
import { knownError } from "../../http/known-errors.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

/** Reads an account's EUR balance. The chain read in production; a suite
 *  that mounts this router without a chain passes its own. */
export type BalanceReader = (address: `0x${string}`) => Promise<{ safeBalanceEur: number }>;

export function createDraftRoutes(
  deps: OrgRoutes,
  buildTransferFromQuote: TransferFactory,
  readBalances: BalanceReader = accountBalances,
): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.read")) return;
    const drafts = store.draftsOf(ctx.org.id);
    res.json({
      drafts: drafts.map((d) => ({ ...withExecutionState(d), totals: totalsByAsset(d) })),
    });
  });

  r.post("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    const open = store.draftsOf(ctx.org.id).filter((d) => !["EXECUTED", "FAILED", "REJECTED", "CANCELLED"].includes(d.state)).length;
    if (open >= CEILINGS.openDraftsPerOrg) {
      return res.status(409).json(ceilingRefusal("payment runs not yet executed", CEILINGS.openDraftsPerOrg));
    }
    if (!Array.isArray(req.body?.lines) || req.body.lines.length > CEILINGS.linesPerDraft) {
      return res.status(400).json({ error: `A draft needs a list of lines, at most ${CEILINGS.linesPerDraft}.` });
    }

    // The funding source is resolved INSIDE this org and stored as an id only:
    // an account or wallet id from another org must not be accepted, and the
    // body must not be spread into the row.
    const raw = req.body?.source;
    const source: DraftPayment["source"] | undefined =
      raw?.kind === "account" && store.accountsOf(ctx.org.id).some((a) => a.id === String(raw.accountId))
        ? { kind: "account", accountId: String(raw.accountId) }
        : raw?.kind === "wallet" && store.importedWalletsOf(ctx.org.id).some((w) => w.id === String(raw.walletId))
          ? { kind: "wallet", walletId: String(raw.walletId) }
          : undefined;
    if (!source) {
      return res
        .status(400)
        .json({ error: "A draft needs a funding source: an account or an imported wallet of this organisation." });
    }

    try {
      const contacts = contactsById(ctx.org.id);
      const lines = (req.body?.lines ?? []).map((l: Record<string, unknown>) => ({
        id: `dl_${randomUUID()}`,
        ...validateLine(l, typeof l?.contactId === "string" ? contacts.get(l.contactId) : undefined),
      }));
      if (!lines.length) return res.status(400).json({ error: "A draft needs at least one line." });

      const now = new Date().toISOString();
      const draft = store.addDraft({
        id: `dft_${randomUUID()}`,
        orgId: ctx.org.id,
        source,
        state: "DRAFT",
        lines,
        createdByMemberId: ctx.member.id,
        activity: [activity(ctx.member.id, "created")],
        createdAt: now,
        updatedAt: now,
      });
      res.status(201).json({ draft, totals: totalsByAsset(draft) });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  r.patch("/:orgId/drafts/:draftId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    if (!isEditable(draft.state)) {
      return res.status(409).json({
        error: {
          EXECUTING: "This payment run is being sent, so it can no longer be edited.",
          EXECUTED: "This payment run was sent, so it can no longer be edited.",
          FAILED: "This payment run failed while it was being sent. Start a new payment run instead of editing it.",
          CANCELLED: "This payment run was cancelled. Start a new payment run instead.",
        }[draft.state as "EXECUTING" | "EXECUTED" | "FAILED" | "CANCELLED"] ?? `A draft in ${draft.state} cannot be edited.`,
      });
    }
    try {
      const contacts = contactsById(ctx.org.id);
      const replaced = Array.isArray(req.body?.lines);
      if (replaced && req.body.lines.length > CEILINGS.linesPerDraft) {
        return res.status(400).json({ error: `A draft is limited to ${CEILINGS.linesPerDraft} lines.` });
      }
      const lines = (replaced ? req.body.lines : draft.lines).map((l: Record<string, unknown>) => ({
        id: typeof l?.id === "string" ? l.id : `dl_${randomUUID()}`,
        ...validateLine(l, typeof l?.contactId === "string" ? contacts.get(l.contactId) : undefined),
      }));
      const updated = store.updateDraft(draft.id, {
        lines,
        // Re-pointing the lines is exactly how INVALID_DATA is resolved.
        state: "DRAFT",
        invalidLineIds: undefined,
        // Whoever edits authored what is now in it, so they become the drafter
        // four-eyes measures against. That holds without `lines` too: every
        // line is re-read from the address book above, so an empty edit is how
        // a changed IBAN gets stamped into the draft. Without this, B could
        // point A's payee at B's own IBAN, edit, and then review it.
        createdByMemberId: ctx.member.id,
        reviewedByMemberId: undefined,
        reviewedAt: undefined,
        rejectedReason: undefined,
        activity: [
          ...draft.activity,
          activity(ctx.member.id, "edited", ["PENDING_REVIEW", "REVIEWED"].includes(draft.state) ? `was ${draft.state}; review starts again` : undefined),
        ],
      });
      res.json({ draft: updated, totals: totalsByAsset(updated) });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /** Submit for review. Drift is checked here and again at execution. */
  r.post("/:orgId/drafts/:draftId/submit", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    // Submitting is possible wherever review is: the plan includes it, or the
    // org's policy still requires it after a downgrade.
    if (!paymentReviewRequired(ctx.org) && !requireCapability(ctx, res, "transfers.approvals")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const checked = reconcileDrift(draft);
    if (checked.state === "INVALID_DATA") {
      return res.status(409).json({
        error:
          "Some recipients changed since this draft was saved. Re-point those lines before submitting.",
        draft: checked,
      });
    }
    try {
      assertTransition(checked.state, "PENDING_REVIEW");
      res.json({
        draft: store.updateDraft(draft.id, {
          state: "PENDING_REVIEW",
          activity: [...checked.activity, activity(ctx.member.id, "submitted_for_review")],
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /**
   * Review. Four eyes: the reviewer may not be the drafter, whatever the role —
   * otherwise review is a button the same person presses twice.
   */
  r.post("/:orgId/drafts/:draftId/review", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    // No plan check: a draft waiting for review was put there when review
    // applied, and it stays reviewable after a downgrade or after review is
    // turned off. The state machine only lets PENDING_REVIEW be reviewed.

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    // Compared as people, not member rows: someone deactivated and re-invited
    // holds a new row. A drafter that resolves to no user counts as the reviewer.
    const drafterUserId = store.findMember(draft.createdByMemberId)?.userId ?? ctx.userId;
    const verdict = canReviewDraft(ctx.member.role, ctx.userId, drafterUserId);
    if (!verdict.allowed) return res.status(403).json({ error: verdict.reason });

    const approve = req.body?.approve !== false;
    try {
      if (!approve) {
        assertTransition(draft.state, "REJECTED");
        return res.json({
          draft: store.updateDraft(draft.id, {
            state: "REJECTED",
            rejectedReason: String(req.body?.reason ?? "").trim() || undefined,
            reviewedByMemberId: ctx.member.id,
            reviewedAt: new Date().toISOString(),
            activity: [...draft.activity, activity(ctx.member.id, "rejected", req.body?.reason)],
          }),
        });
      }
      const checked = reconcileDrift(draft);
      if (checked.state === "INVALID_DATA") {
        return res.status(409).json({
          error: "Some recipients changed since this draft was submitted.",
          draft: checked,
        });
      }
      assertTransition(checked.state, "REVIEWED");
      res.json({
        draft: store.updateDraft(draft.id, {
          state: "REVIEWED",
          reviewedByMemberId: ctx.member.id,
          reviewedAt: new Date().toISOString(),
          activity: [...checked.activity, activity(ctx.member.id, "reviewed")],
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /**
   * Cancel a draft that has not started sending. A draft is a proposal, so
   * whoever may propose payments, or review them, may withdraw one; the row
   * is kept as CANCELLED, never deleted, and any invoice it was paying goes
   * back to waiting for payment. Once execution starts, transfers may exist
   * and nothing here can withdraw them.
   */
  r.post("/:orgId/drafts/:draftId/cancel", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    if (!roleCan(ctx.member.role, "drafts.create") && !roleCan(ctx.member.role, "drafts.review")) {
      return res.status(403).json({ error: "Your role cannot propose or review payments, so it cannot cancel one." });
    }
    if (!isCancellable(draft.state)) {
      return res.status(409).json({
        error: draft.state === "CANCELLED"
          ? "This draft is already cancelled."
          : `A draft in ${draft.state} cannot be cancelled: sending has started.`,
      });
    }
    const reason = String(req.body?.reason ?? "").trim().slice(0, 300) || undefined;
    const cancelled = store.updateDraft(draft.id, {
      state: "CANCELLED",
      activity: [...draft.activity, activity(ctx.member.id, "cancelled", reason)],
    });
    releaseInvoicesOf(draft.id);
    res.json({ draft: cancelled });
  });

  /**
   * Execute a reviewed draft: one transfer per line, each needing its own
   * device signature.
   *
   * No money moves here. This endpoint creates transfers and returns the
   * authorizations the device must sign; an unsigned transfer cannot debit
   * anything, which is what makes the partial-failure path below safe.
   *
   * The claim is synchronous, like the transfer authorization claim, so two
   * parallel submissions of one draft cannot both pass the state check. Drift
   * is re-checked just before, since an address-book edit can land between
   * approval and execution.
   */
  r.post("/:orgId/drafts/:draftId/execute", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "transfers.execute")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    let checked = reconcileDrift(draft);
    const heldForDrift = () =>
      res.status(409).json({
        error: "Some recipients changed since this draft was approved. It has been held.",
        draft: checked,
      });
    if (checked.state === "INVALID_DATA") return heldForDrift();

    // An imported wallet is read-only: we build the transactions and its
    // owner signs them. The response says so explicitly.
    if (checked.source.kind === "wallet") {
      const walletId = checked.source.walletId;
      const wallet = store.importedWalletsOf(ctx.org.id).find((w) => w.id === walletId);
      return res.status(200).json({
        unsigned: true,
        wallet: wallet
          ? { address: wallet.address, chainId: wallet.chainId, kind: wallet.kind }
          : null,
        lines: checked.lines,
        note:
          "This wallet was imported read-only — we hold no key for it. Sign these transactions in your own wallet; nothing has been submitted.",
      });
    }

    // ── Funding identity ──────────────────────────────────────────────────
    const account = store.findAccount(checked.source.accountId);
    if (!account || account.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "This draft's funding account no longer exists." });
    }
    const spendable = accountIsSpendable(account);
    if (!spendable.ok) return res.status(409).json({ error: spendable.reason });
    if (!account.backingUserId) {
      return res.status(409).json({
        error:
          "No IBAN is connected to this account yet, so nothing can be sent from it. Connect one on the Accounts screen first.",
      });
    }
    // Spending authority is a device key in one person's browser. A `payer` on
    // the org cannot sign for somebody else's key, and there is no server-side
    // authority to fall back on, so say that rather than failing later at
    // /authorize with something that reads like a bug.
    if (ctx.userId !== account.backingUserId) {
      return res.status(403).json({
        error:
          "Only the person holding this account's device key can authorise its payments. Your role permits sending, but the signature has to come from that device.",
      });
    }
    const user = store.findUser(account.backingUserId);
    if (!user) {
      return res.status(409).json({ error: "This account's funding identity is missing." });
    }

    // ── Whose IBAN, re-read now ───────────────────────────────────────────
    // Before any quote or fee: the profile recorded at adoption must still be
    // the one connected, still the kind this org needs, and still approved.
    // Monerium not answering refuses (503) — nothing is created.
    if (ctx.org.type === "business" || account.moneriumProfile) {
      if (!account.moneriumProfile) {
        return res.status(409).json({
          code: "MONERIUM_PROFILE_UNVERIFIED",
          error:
            "We have not yet confirmed that this account's IBAN belongs to a company profile at Monerium. Check the account again on the Accounts screen, then send.",
        });
      }
      const profile = await checkBackingProfile(ctx.org, user, account.moneriumProfile.id);
      auditProfileCheck("execute", { orgId: ctx.org.id, accountId: account.id }, user.id, profile, ctx.userId);
      if (!profile.ok) {
        return res.status(profile.status).json({ code: profile.code, error: profile.error });
      }
    }

    // ── Plan every line BEFORE creating anything ──────────────────────────
    // A half-created batch consumes quotes and leaves transfers nobody asked
    // for, so every line is checked first and the whole draft is refused if any
    // one of them cannot be paid.
    //
    // The address book is checked here, with nothing awaited between this
    // check and the bank details read below, so every IBAN and name planned
    // is the one that was approved; later awaits use these copies.
    checked = reconcileDrift(store.findDraft(checked.id) ?? checked);
    if (checked.state === "INVALID_DATA") return heldForDrift();
    // The row is live and written in place, so this is copied now: the claim
    // below compares against the draft as it was when it was planned.
    const plannedAt = checked.updatedAt;
    const plans: { lineId: string; iban: string; name: string; sendEur: number; invoiceId?: string }[] = [];
    const problems: { lineId: string; reason: string }[] = [];

    for (const line of checked.lines) {
      const d = line.destination;
      if (d.kind === "wallet") {
        problems.push({
          lineId: line.id,
          reason:
            "Paying a wallet from an issued account is not wired — that is a token-to-token payment, not a payout rail.",
        });
        continue;
      }
      const contact = line.contactId ? store.findContact(line.contactId) : undefined;
      const bank = contact?.bankAccounts.find((b) => b.id === d.bankAccountId);
      if (!bank) {
        problems.push({ lineId: line.id, reason: "The saved bank account is gone." });
        continue;
      }
      if (bank.currency !== "EUR" || !bank.iban) {
        const def = CURRENCY_REGISTRY[bank.currency];
        problems.push({
          lineId: line.id,
          reason: `${def?.name ?? bank.currency} payouts are not open: ${def?.needs ?? "no rail"}`,
        });
        continue;
      }
      const sendEur = Number(line.amount);
      // createQuote refuses these too, but refusing here keeps the whole batch
      // atomic instead of failing halfway through.
      const sepaFee = railFeeEur("sepa");
      if (!(sendEur > sepaFee)) {
        problems.push({
          lineId: line.id,
          reason: sepaFee > 0
            ? `€${line.amount} does not exceed the €${sepaFee} fee, so nothing would arrive.`
            : `€${line.amount} is not a positive amount.`,
        });
        continue;
      }
      if (sendEur > FX.DAILY_CAP_EUR) {
        problems.push({
          lineId: line.id,
          reason: `€${line.amount} is over the €${FX.DAILY_CAP_EUR} daily cap.`,
        });
        continue;
      }
      plans.push({ lineId: line.id, iban: bank.iban, name: bank.holderName, sendEur, invoiceId: line.invoiceId });
    }

    if (problems.length) {
      return res.status(422).json({
        error: `${problems.length} of ${checked.lines.length} line(s) cannot be paid. Nothing was created.`,
        problems,
      });
    }

    // Each line is its own transfer and therefore its own fixed fee. Checked
    // against the balance as a TOTAL: the per-transfer check inside
    // buildTransferFromQuote sees the full balance every time, so N lines that
    // each fit individually can still overdraw together.
    const totalEur = plans.reduce((s, p) => s + p.sendEur, 0);
    try {
      const balances = await readBalances(user.address);
      if (balances.safeBalanceEur < totalEur) {
        return res.status(400).json({
          error: `This draft sends €${totalEur.toFixed(2)} in total but the account holds €${balances.safeBalanceEur.toFixed(2)}.`,
          totalEur,
          availableEur: balances.safeBalanceEur,
        });
      }
    } catch (err) {
      return res.status(502).json({
        error: `Could not read the account balance, so the batch was not started: ${(err as Error).message}`,
      });
    }

    // ── Claim, then create ────────────────────────────────────────────────
    // Which states may be sent from is the org's review policy, not the plan
    // of the day: an org that requires review sends only REVIEWED drafts,
    // after a downgrade too. One without review has no review step, so it
    // sends from DRAFT. A draft waiting for review is never sent until it is
    // reviewed, even if review has since been turned off.
    const reviewRequired = paymentReviewRequired(ctx.org);
    const claimable: DraftState[] = reviewRequired ? ["REVIEWED"] : ["DRAFT", "REVIEWED"];
    const notClaimable = (state: DraftState) => ({
      error: reviewRequired
        ? `This draft is ${state}. This organisation requires a second person to review a payment before it can be sent.`
        : state === "PENDING_REVIEW"
          ? "This draft is waiting for review. It was submitted while review applied, so it is sent once someone reviews it."
          : `This draft is ${state} and cannot be sent from that state — it may already be executing.`,
    });
    if (!claimable.includes(checked.state)) {
      return res.status(409).json(notClaimable(checked.state));
    }

    // Every line is a Monerium redeem. Without a connection each one would be
    // refused at execution, after the passkey ceremonies — the same reason
    // POST /api/quotes refuses here. Account-wide, so the draft keeps its
    // state and can be sent once the account is connected.
    if (!moneriumLiveFor(user)) {
      return res.status(409).json(MONERIUM_NOT_CONNECTED);
    }

    // Refused if anyone wrote the draft since the plans above were made from
    // it (an edit, a cancel, a review): what is sent is what was checked.
    const claimed = store.claimDraftExecution(checked.id, claimable, plannedAt);
    if (!claimed) {
      const now = store.findDraft(checked.id);
      return res.status(409).json(
        now && now.updatedAt !== plannedAt && claimable.includes(now.state)
          ? { error: "This draft changed while it was being prepared. Nothing was sent; check it and send again." }
          : notClaimable(now?.state ?? checked.state),
      );
    }

    const authorizations: {
      lineId: string;
      transferId: string;
      recipient: string;
      sendEur: number;
      authorization: unknown;
    }[] = [];

    for (const plan of plans) {
      // A line that pays an invoice carries the supplier's invoice number as
      // the remittance text — the one string their bookkeeping matches on.
      // A line's invoiceId arrived in a request body, so it is only honoured
      // for an invoice of THIS org — otherwise a member could stamp another
      // org's invoice number on a transfer, or overwrite its payment link.
      const found = plan.invoiceId ? store.findInvoice(plan.invoiceId) : undefined;
      const invoice = found && found.orgId === ctx.org.id ? found : undefined;
      let built;
      try {
        const quote = await createQuote(user.id, { rail: "sepa", sendEur: plan.sendEur });
        built = await buildTransferFromQuote(quote, {
          recipientName: plan.name,
          recipientIban: plan.iban,
          reference: invoice
            ? paymentReference(invoice, ctx.org.name)
            : `${ctx.org.name} ${claimed.id.slice(0, 8)}`.slice(0, 140),
        });
      } catch (err) {
        // A quote or build that threw is a partner or rate failure (a refusal
        // comes back as built.ok === false): 503 with what failed, and the
        // known kinds (rates down, Monerium refused) in their own words.
        const known = knownError(err);
        built = known
          ? { ok: false as const, status: known.status, body: known.body }
          : { ok: false as const, status: 503, body: { error: `Line ${plan.name}: the payment could not be prepared (${(err as Error).message}).` } };
      }

      if (!built.ok) {
        // Partial batch. The transfers already created sit in CREATED with no
        // signature, so no money can move through them — they simply expire.
        // The draft goes to FAILED rather than back to REVIEWED so that a retry
        // is a deliberate re-draft instead of a second batch on top of the
        // first.
        // Invoices this draft was paying go back to SUBMITTED so they can be
        // paid again by a fresh draft; the failed one is not their payment.
        releaseInvoicesOf(claimed.id);
        store.updateDraft(claimed.id, {
          state: "FAILED",
          transferIds: authorizations.map((a) => a.transferId),
          failureReason: `Line ${plan.lineId} could not be prepared: ${built.body?.error ?? "unknown"}`,
          activity: [
            ...claimed.activity,
            activity(
              ctx.member.id,
              "execution_failed",
              `${authorizations.length} transfer(s) were created and left unsigned; they expire without moving anything.`,
            ),
          ],
        });
        return res.status(built.status).json({
          error: `Line ${plan.lineId} could not be prepared, so the batch was stopped.`,
          detail: built.body?.error,
          createdButUnsigned: authorizations.map((a) => a.transferId),
          note: "Nothing moved. Transfers created before the failure carry no signature and expire unused.",
        });
      }

      if (invoice && invoice.state === "PAYING" && invoice.payment?.draftId === claimed.id) {
        store.updateInvoice(invoice.id, {
          payment: { ...invoice.payment, transferId: built.transfer.id },
        });
      }
      authorizations.push({
        lineId: plan.lineId,
        transferId: built.transfer.id,
        recipient: plan.name,
        sendEur: plan.sendEur,
        authorization: built.authorization,
      });
    }

    const updated = store.updateDraft(claimed.id, {
      transferIds: authorizations.map((a) => a.transferId),
      activity: [
        ...claimed.activity,
        activity(
          ctx.member.id,
          "executing",
          `${authorizations.length} transfer(s) created, awaiting a device signature for each.`,
        ),
      ],
    });

    res.status(201).json({
      draft: updated,
      authorizations,
      totalEur,
      // Said plainly: the draft is not sent until every line is signed.
      note: `${authorizations.length} transfer(s) created. Each needs its own device signature — sign them and POST to each authorization's submitTo. Nothing has moved yet.`,
    });
  });

  /**
   * One draft, with its execution state derived from its transfers.
   *
   * Derived, not stored, because the transfers are the source of truth: a
   * stored EXECUTED could disagree with a transfer sitting in MANUAL_REVIEW.
   */
  r.get("/:orgId/drafts/:draftId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.read")) return;
    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    res.json({ draft: withExecutionState(draft), totals: totalsByAsset(draft) });
  });

  /** Bulk import lines from a CSV. */
  r.post("/:orgId/drafts/import-csv", express.text({ type: "*/*", limit: CSV_MAX_BYTES }), (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    if (!requireCapability(ctx, res, "transfers.bulkCsv")) return;

    const mapping = {
      recipientAddress: String(req.query.recipientAddress ?? "Recipient Address"),
      token: String(req.query.token ?? "Token"),
      amount: String(req.query.amount ?? "Amount"),
      recipientName: req.query.recipientName ? String(req.query.recipientName) : "Recipient Name",
      account: req.query.account ? String(req.query.account) : "Account",
      notes: req.query.notes ? String(req.query.notes) : "Notes",
      tags: req.query.tags ? String(req.query.tags) : "Tags",
    };
    if (typeof req.body !== "string") {
      return res.status(415).json({ error: "Send the CSV as text (content-type text/csv), not JSON." });
    }
    try {
      const knownTags = new Set(
        store.ledgerOf(ctx.org.id).flatMap((e) => e.tags),
      );
      const result = importCsv(req.body, mapping, {
        maxRows: limitsFor(ctx.org).bulkCsvRows,
        knownTags,
      });
      res.json({
        lines: result.lines,
        rejected: result.rejected,
        newTags: result.newTags,
        // Rejected rows are always reported. A bulk file that loses rows
        // without saying so pays fewer people than the operator expects.
        summary: `${result.lines.length} row(s) ready, ${result.rejected.length} rejected.`,
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  // ── Invoices ──────────────────────────────────────────────────────────────

  return r;
}
