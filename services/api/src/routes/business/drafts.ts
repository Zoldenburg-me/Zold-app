/**
 * Draft payments: compose, edit, submit, review, execute.
 *
 * FOUR EYES. The reviewer may not be the drafter, whatever their role, or
 * review is a button the same person presses twice. Editing another person's
 * lines makes the editor the drafter, which is the same hole reached sideways.
 *
 * ALL-OR-NOTHING AT EXECUTION. Every line is planned before anything is
 * created — wallet destinations, gated currencies, sub-fee and over-cap
 * amounts all refuse up front — and the balance is checked as a TOTAL, because
 * N lines that each fit can still overdraw together.
 *
 * INVALID_DATA. A draft whose payee changed after it was saved is HELD, not
 * retargeted. The fingerprint is recomputed at review AND again at execution:
 * the gap between approval and execution is exactly where an address-book edit
 * lands.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import { FX, railFeeEur } from "../../config.js";
import { createQuote } from "../../fx.js";
import { accountBalances } from "../../chain.js";
import { CURRENCY_REGISTRY, accountIsSpendable } from "../../domain/accounts.js";
import { canReviewDraft } from "../../domain/roles.js";
import {
  CSV_MAX_BYTES,
  activity,
  assertTransition,
  importCsv,
  isEditable,
  totalsByAsset,
  validateLine,
} from "../../domain/drafts.js";
import { paymentReference } from "../../domain/invoices.js";
import type { DraftPayment, DraftState } from "../../domain/types.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { can, limitsFor } from "../../domain/plans.js";
import {
  badRequest, type TransferFactory,
} from "./shared.js";
import {
  contactsById, reconcileDrift, releaseInvoicesOf, withExecutionState,
} from "./state.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

export function createDraftRoutes(deps: OrgRoutes, buildTransferFromQuote: TransferFactory): express.Router {
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
        ...validateLine(l, typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined),
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
        error: `A draft in ${draft.state} cannot be edited. Send it back to draft first.`,
      });
    }
    try {
      const contacts = contactsById(ctx.org.id);
      const replaced = Array.isArray(req.body?.lines);
      const lines = (replaced ? req.body.lines : draft.lines).map((l: Record<string, unknown>) => ({
        id: typeof l.id === "string" ? l.id : `dl_${randomUUID()}`,
        ...validateLine(l, typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined),
      }));
      const updated = store.updateDraft(draft.id, {
        lines,
        // Re-pointing the lines is exactly how INVALID_DATA is resolved.
        state: "DRAFT",
        invalidLineIds: undefined,
        // Whoever replaces the lines authored what is now in them, so they
        // become the drafter four-eyes measures against. Without this, B could
        // rewrite A's €1 draft into €9,000 to B's contact and then review it.
        ...(replaced ? { createdByMemberId: ctx.member.id } : {}),
        reviewedByMemberId: undefined,
        reviewedAt: undefined,
        rejectedReason: undefined,
        activity: [...draft.activity, activity(ctx.member.id, "edited")],
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
    if (!requireCapability(ctx, res, "transfers.approvals")) return;

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
    if (!requireCapability(ctx, res, "transfers.approvals")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const verdict = canReviewDraft(ctx.member.role, ctx.member.id, draft.createdByMemberId);
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
   * Execute a reviewed draft: one transfer per line, each needing its own
   * device signature.
   *
   * NOTHING MOVES HERE. This endpoint creates transfers and hands back the
   * authorizations the device must sign; a transfer with no signature can never
   * debit anything. That property is what makes the partial-failure path below
   * safe.
   *
   * The claim is synchronous — same shape as the transfer authorization claim,
   * and for the same reason: two parallel submissions of one draft must not
   * both pass the state check. Drift is re-checked immediately before, because
   * the gap between approval and execution is exactly where an address-book
   * edit lands.
   */
  r.post("/:orgId/drafts/:draftId/execute", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "transfers.execute")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const checked = reconcileDrift(draft);
    if (checked.state === "INVALID_DATA") {
      return res.status(409).json({
        error: "Some recipients changed since this draft was approved. It has been held.",
        draft: checked,
      });
    }

    // An imported wallet is read-only: we build the transactions, its owner
    // signs them. Saying so is the point; silently doing nothing would not be.
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
          "This account has no funding identity yet. Provisioning a Safe and a Monerium profile per organisation is not built — only accounts carried over from an existing personal account can be spent from today.",
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

    // ── Plan every line BEFORE creating anything ──────────────────────────
    // A half-created batch consumes quotes and leaves transfers nobody asked
    // for, so every line is checked first and the whole draft is refused if any
    // one of them cannot be paid.
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
      const balances = await accountBalances(user.address);
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
    // Which states may be sent from depends on the plan. An org WITH approvals
    // must go through review — that is what it bought. An org without them has
    // no review step at all, so requiring REVIEWED there would make every draft
    // permanently unsendable.
    const approvals = can(ctx.org, "transfers.approvals").allowed;
    const claimable: DraftState[] = approvals ? ["REVIEWED"] : ["DRAFT", "REVIEWED"];
    const claimed = store.claimDraftExecution(checked.id, claimable);
    if (!claimed) {
      return res.status(409).json({
        error: approvals
          ? `This draft is ${checked.state}. On your plan a payment must be reviewed by a second person before it can be sent.`
          : `This draft is ${checked.state} and cannot be sent from that state — it may already be executing.`,
      });
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
      const invoice = plan.invoiceId ? store.findInvoice(plan.invoiceId) : undefined;
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
        built = { ok: false as const, status: 500, body: { error: (err as Error).message } };
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

      if (invoice && invoice.state === "PAYING") {
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
   * Derived rather than stored: the transfers are the truth, and a draft row
   * that says EXECUTED while a transfer sits in MANUAL_REVIEW would be a
   * comfortable lie.
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
        // Rejected rows are reported, never dropped silently: a bulk file that
        // quietly loses rows pays fewer people than the operator believes.
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
