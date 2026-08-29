/**
 * /api/orgs/:orgId — the business surface: draft payments with approval,
 * invoices, chart of accounts, the ledger, reports and export.
 *
 * Plus the public, unauthenticated invoice-link endpoints, which are mounted
 * separately at /api/invoice-links because they are reached by a supplier who
 * has no account and no session.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../store.js";
import {
  requireCapability,
  requirePermission,
  resolveOrg,
  type SessionResolver,
} from "./org-context.js";
import { limitsFor } from "../domain/plans.js";
import { canReviewDraft } from "../domain/roles.js";
import {
  CSV_MAX_BYTES,
  DraftError,
  activity,
  assertTransition,
  findDriftedLines,
  importCsv,
  isEditable,
  totalsByAsset,
  validateLine,
} from "../domain/drafts.js";
import {
  InvoiceError,
  assertDeletable,
  assertTransition as assertInvoiceTransition,
  hashToken,
  isOverdue,
  newLinkToken,
  supplierView,
  validateLines,
} from "../domain/invoices.js";
import { CoaError, applyRules, TX_TYPES, validateChartAccount } from "../domain/coa.js";
import {
  LEDGER_EXPORT_COLUMNS,
  computeCostBasis,
  ledgerExportRows,
  monthlyBalances,
  positions,
  toCsv,
} from "../domain/ledger.js";
import type { DraftPayment, Invoice } from "../domain/types.js";

const badRequest = (res: express.Response, err: unknown) => {
  if (err instanceof DraftError || err instanceof InvoiceError || err instanceof CoaError) {
    res.status(400).json({ error: (err as Error).message });
    return true;
  }
  return false;
};

export function createBusinessRouter(requireSession: SessionResolver): express.Router {
  const r = express.Router();
  const ctxOf = (req: express.Request, res: express.Response) =>
    resolveOrg(req, res, requireSession);

  const contactsById = (orgId: string) =>
    new Map(store.contactsOf(orgId).map((c) => [c.id, c] as const));

  /** Re-check a draft against the address book and park it if anything moved. */
  const reconcileDrift = (draft: DraftPayment): DraftPayment => {
    const drifted = findDriftedLines(draft, contactsById(draft.orgId));
    if (!drifted.length) return draft;
    return store.updateDraft(draft.id, {
      state: "INVALID_DATA",
      invalidLineIds: drifted,
      activity: [
        ...draft.activity,
        activity(
          "system",
          "invalid_data",
          `${drifted.length} line(s) point at a recipient that has changed since the draft was saved.`,
        ),
      ],
    });
  };

  // ── Draft payments ────────────────────────────────────────────────────────

  r.get("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.read")) return;
    const drafts = store.draftsOf(ctx.org.id);
    res.json({
      drafts: drafts.map((d) => ({ ...d, totals: totalsByAsset(d) })),
    });
  });

  r.post("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;

    const source = req.body?.source;
    if (
      !source ||
      (source.kind === "account" && !store.findAccount(String(source.accountId))) ||
      (source.kind === "wallet" && !store.findImportedWallet(String(source.walletId))) ||
      !["account", "wallet"].includes(source.kind)
    ) {
      return res
        .status(400)
        .json({ error: "A draft needs a funding source: an account or an imported wallet." });
    }

    try {
      const contacts = contactsById(ctx.org.id);
      const lines = (req.body?.lines ?? []).map((l: Record<string, unknown>) => ({
        id: `dl_${randomUUID()}`,
        ...validateLine(
          l as never,
          typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined,
        ),
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
      const lines = (req.body?.lines ?? draft.lines).map((l: Record<string, unknown>) => ({
        id: typeof l.id === "string" ? l.id : `dl_${randomUUID()}`,
        ...validateLine(
          l as never,
          typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined,
        ),
      }));
      const updated = store.updateDraft(draft.id, {
        lines,
        // Re-pointing the lines is exactly how INVALID_DATA is resolved.
        state: "DRAFT",
        invalidLineIds: undefined,
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
   * Execute a reviewed draft.
   *
   * The claim is synchronous — same shape as the transfer authorization claim,
   * and for the same reason: two parallel submissions of one draft must not
   * both pass the state check. Drift is re-checked immediately before, because
   * the gap between approval and execution is exactly where an address-book
   * edit lands.
   */
  r.post("/:orgId/drafts/:draftId/execute", (req, res) => {
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
    const claimed = store.claimDraftExecution(draft.id);
    if (!claimed) {
      return res.status(409).json({
        error: `This draft is ${checked.state}, not REVIEWED — it may already be executing.`,
      });
    }

    // An imported wallet is read-only: we build the transactions, its owner
    // signs them. Saying so is the point; silently doing nothing would not be.
    if (claimed.source.kind === "wallet") {
      const wallet = store.findImportedWallet(claimed.source.walletId);
      store.updateDraft(claimed.id, {
        state: "REVIEWED",
        activity: [...claimed.activity, activity(ctx.member.id, "prepared_unsigned")],
      });
      return res.status(200).json({
        unsigned: true,
        wallet: wallet ? { address: wallet.address, chainId: wallet.chainId, kind: wallet.kind } : null,
        lines: claimed.lines,
        note:
          "This wallet was imported read-only — we hold no key for it. Sign these transactions in your own wallet; nothing has been submitted.",
      });
    }

    // Issued account: hand off to the existing transfer machinery. That path
    // still requires the FP4 device signature per payment, so this endpoint
    // prepares and does not move money on its own.
    store.updateDraft(claimed.id, {
      state: "REVIEWED",
      activity: [...claimed.activity, activity(ctx.member.id, "execution_requested")],
    });
    res.status(501).json({
      error:
        "Executing a draft from an issued account is not wired to the transfer machinery yet. The approval workflow, the drift check and the claim are in place; the last hop must create one transfer per line and collect a device signature for each.",
      draft: claimed,
    });
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
    try {
      const knownTags = new Set(
        store.ledgerOf(ctx.org.id).flatMap((e) => e.tags),
      );
      const result = importCsv(String(req.body ?? ""), mapping, {
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

  r.get("/:orgId/invoices", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    res.json({
      invoices: store
        .invoicesOf(ctx.org.id)
        .filter((i) => i.state !== "DELETED")
        .map((i) => ({ ...i, linkTokenHash: undefined, overdue: isOverdue(i) })),
    });
  });

  /** Create the one-time "Invoice-Me" link. The token is shown once. */
  r.post("/:orgId/invoices", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    const { token, hash } = newLinkToken();
    const now = new Date().toISOString();
    const invoice = store.addInvoice({
      id: `inv_${randomUUID()}`,
      orgId: ctx.org.id,
      linkTokenHash: hash,
      linkPasswordHash:
        typeof req.body?.password === "string" && req.body.password
          ? hashToken(req.body.password)
          : undefined,
      state: "LINK_CREATED",
      lines: [],
      currency: String(req.body?.currency ?? ctx.org.reporting.currency).toUpperCase(),
      total: "0.00",
      dueDate: typeof req.body?.dueDate === "string" ? req.body.dueDate : undefined,
      createdByMemberId: ctx.member.id,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({
      invoice: { ...invoice, linkTokenHash: undefined },
      // Returned once. We store only the hash, so this cannot be recovered.
      linkToken: token,
      linkPath: `/invoice/${token}`,
      note: "Send this link to your supplier. It is shown once — we store only its hash.",
    });
  });

  r.delete("/:orgId/invoices/:invoiceId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const invoice = store.findInvoice(String(req.params.invoiceId));
    if (!invoice || invoice.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such invoice" });
    }
    try {
      assertDeletable(invoice);
      store.updateInvoice(invoice.id, { state: "DELETED" });
      res.json({ deleted: true });
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  /** Mark an invoice settled outside the platform (manual reconciliation). */
  r.post("/:orgId/invoices/:invoiceId/reconcile", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const invoice = store.findInvoice(String(req.params.invoiceId));
    if (!invoice || invoice.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such invoice" });
    }
    try {
      assertInvoiceTransition(invoice.state, "RECONCILED");
      res.json({
        invoice: store.updateInvoice(invoice.id, {
          state: "RECONCILED",
          payment: {
            ...invoice.payment,
            manual: {
              byMemberId: ctx.member.id,
              at: new Date().toISOString(),
              note: typeof req.body?.note === "string" ? req.body.note : undefined,
            },
          },
        }),
      });
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // ── Chart of accounts ─────────────────────────────────────────────────────

  r.get("/:orgId/chart-of-accounts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.manage")) return;
    if (!requirePermission(ctx, res, "coa.read")) return;
    res.json({
      accounts: store.chartOf(ctx.org.id),
      rules: store.rulesOf(ctx.org.id),
      txTypes: TX_TYPES,
    });
  });

  r.post("/:orgId/chart-of-accounts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.manage")) return;
    if (!requirePermission(ctx, res, "coa.manage")) return;
    try {
      const fields = validateChartAccount(req.body ?? {});
      if (store.chartOf(ctx.org.id).some((c) => c.code === fields.code)) {
        return res.status(409).json({ error: `Account code ${fields.code} is already in use.` });
      }
      res.status(201).json({
        account: store.addChartAccount({
          id: `coa_${randomUUID()}`,
          orgId: ctx.org.id,
          ...fields,
          archived: false,
          createdAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  r.post("/:orgId/account-rules", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.rules")) return;
    if (!requirePermission(ctx, res, "coa.manage")) return;

    const scope = String(req.body?.scope ?? "");
    if (!["default", "wallet", "asset", "contact"].includes(scope)) {
      return res
        .status(400)
        .json({ error: "Scope must be default, wallet, asset or contact." });
    }
    const accountCode = String(req.body?.accountCode ?? "");
    if (!store.chartOf(ctx.org.id).some((c) => c.code === accountCode)) {
      return res.status(400).json({ error: `No account with code ${accountCode}.` });
    }
    const direction = ["in", "out", "both"].includes(String(req.body?.direction))
      ? (String(req.body.direction) as "in" | "out" | "both")
      : "both";

    res.status(201).json({
      rule: store.addAccountRule({
        id: `rule_${randomUUID()}`,
        orgId: ctx.org.id,
        scope: scope as never,
        match: {
          txType: req.body?.txType ? String(req.body.txType) : undefined,
          walletId: req.body?.walletId ? String(req.body.walletId) : undefined,
          asset: req.body?.asset ? String(req.body.asset) : undefined,
          contactId: req.body?.contactId ? String(req.body.contactId) : undefined,
        },
        direction,
        accountCode,
        createdAt: new Date().toISOString(),
      }),
    });
  });

  /** Re-run the rules. Touches only rows a rule set before, never a human's. */
  r.post("/:orgId/account-rules/apply", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.rules")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const { changed, entries } = applyRules(store.rulesOf(ctx.org.id), store.ledgerOf(ctx.org.id));
    store.replaceLedgerEntries(entries);
    res.json({
      changed,
      note: "Only automatically mapped rows were touched. Anything you categorised by hand was left alone.",
    });
  });

  // ── Ledger, assets, reports, export ───────────────────────────────────────

  r.get("/:orgId/ledger", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;

    let entries = store.ledgerOf(ctx.org.id);
    const { from, to, asset, direction, accountCode, tag } = req.query;
    if (from) entries = entries.filter((e) => e.at >= String(from));
    if (to) entries = entries.filter((e) => e.at <= String(to));
    if (asset) entries = entries.filter((e) => e.asset.toUpperCase() === String(asset).toUpperCase());
    if (direction) entries = entries.filter((e) => e.direction === direction);
    if (accountCode) entries = entries.filter((e) => e.accountCode === String(accountCode));
    if (tag) entries = entries.filter((e) => e.tags.includes(String(tag)));

    res.json({
      entries: entries.sort((a, b) => b.at.localeCompare(a.at)),
      total: entries.length,
    });
  });

  r.patch("/:orgId/ledger/:entryId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const entry = store.ledgerOf(ctx.org.id).find((e) => e.id === String(req.params.entryId));
    if (!entry) return res.status(404).json({ error: "no such transaction" });

    const patch: Record<string, unknown> = {};
    if (req.body?.accountCode !== undefined) {
      patch.accountCode = String(req.body.accountCode);
      // A human set it, so a later rule run must not overwrite it.
      patch.accountCodeAuto = false;
    }
    if (Array.isArray(req.body?.tags)) {
      if (!requireCapability(ctx, res, "ledger.tags")) return;
      patch.tags = req.body.tags.map(String);
    }
    if (typeof req.body?.note === "string") patch.note = req.body.note;
    res.json({ entry: store.updateLedgerEntry(entry.id, patch) });
  });

  r.get("/:orgId/assets", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "assets.costBasis")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const basis = computeCostBasis(store.ledgerOf(ctx.org.id));
    res.json({
      positions: positions(basis),
      disposals: basis.disposals,
      // Surfaced rather than folded into profit: an unmatched disposal usually
      // means history is missing, and booking it at zero cost overstates income.
      shortfalls: basis.shortfalls,
      costBasisMethod: ctx.org.reporting.costBasisMethod,
    });
  });

  r.get("/:orgId/reports/monthly-balance", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "reports.monthlyBalance")) return;
    if (!requirePermission(ctx, res, "reports.run")) return;

    const months = limitsFor(ctx.org).reportMonths;
    const earliest = new Date();
    earliest.setMonth(earliest.getMonth() - months);
    const floor = earliest.toISOString().slice(0, 7);
    const from = req.query.from ? String(req.query.from) : undefined;

    const rows = monthlyBalances(store.ledgerOf(ctx.org.id), {
      from: from && from > floor ? from : floor,
      to: req.query.to ? String(req.query.to) : undefined,
    });
    if (String(req.query.format) === "csv") {
      res.type("text/csv").attachment("monthly-balance.csv").send(toCsv(rows as never));
      return;
    }
    res.json({
      rows,
      // The ceiling is stated, so a short report reads as a plan limit rather
      // than as missing data.
      windowMonths: months,
      earliestMonth: floor,
    });
  });

  r.get("/:orgId/export/ledger.csv", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "export.ledger")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const rows = ledgerExportRows(store.ledgerOf(ctx.org.id));
    res
      .type("text/csv")
      .attachment("transactions.csv")
      .send(toCsv(rows, [...LEDGER_EXPORT_COLUMNS]));
  });

  return r;
}

/**
 * The supplier's half of the invoice flow: no account, no wallet, no session.
 *
 * Mounted at /api/invoice-links and reached only with the one-time token. Every
 * response goes through supplierView(), which is an allowlist — a field added
 * to Invoice later must be chosen into it rather than leaking by default.
 */
export function createInvoiceLinkRouter(): express.Router {
  const r = express.Router();

  const load = (
    req: express.Request,
    res: express.Response,
  ): Invoice | undefined => {
    const token = String(req.params.token ?? "");
    const invoice = store.findInvoiceByLinkHash(hashToken(token));
    if (!invoice || invoice.state === "DELETED") {
      res.status(404).json({ error: "That invoice link is not valid." });
      return undefined;
    }
    if (invoice.linkPasswordHash) {
      const supplied = String(req.header("x-invoice-password") ?? req.body?.password ?? "");
      if (!supplied || hashToken(supplied) !== invoice.linkPasswordHash) {
        res.status(401).json({ error: "This invoice link is password protected.", passwordRequired: true });
        return undefined;
      }
    }
    return invoice;
  };

  const payorName = (invoice: Invoice) =>
    store.findOrganisation(invoice.orgId)?.name ?? "";

  r.get("/:token", (req, res) => {
    const invoice = load(req, res);
    if (!invoice) return;
    res.json({ invoice: supplierView(invoice, payorName(invoice)) });
  });

  /** The supplier fills the invoice in. Locked once submitted. */
  r.post("/:token/submit", (req, res) => {
    const invoice = load(req, res);
    if (!invoice) return;
    if (invoice.state !== "LINK_CREATED") {
      return res.status(409).json({
        error: "This invoice was already submitted. Submitted invoices are timestamped and locked.",
        invoice: supplierView(invoice, payorName(invoice)),
      });
    }
    try {
      const { lines, total } = validateLines(req.body?.lines);
      const supplier = req.body?.supplier ?? {};
      for (const field of ["orgName", "email", "invoiceNumber"]) {
        if (!String(supplier[field] ?? "").trim()) {
          return res.status(400).json({ error: `Your ${field} is required.` });
        }
      }
      assertInvoiceTransition(invoice.state, "SUBMITTED");
      const updated = store.updateInvoice(invoice.id, {
        state: "SUBMITTED",
        supplier: {
          orgName: String(supplier.orgName).trim(),
          email: String(supplier.email).trim(),
          address: supplier.address ? String(supplier.address).trim() : undefined,
          taxId: supplier.taxId ? String(supplier.taxId).trim() : undefined,
          invoiceNumber: String(supplier.invoiceNumber).trim(),
        },
        lines,
        total,
        payTo: req.body?.payTo,
        dueDate: typeof req.body?.dueDate === "string" ? req.body.dueDate : invoice.dueDate,
        submittedAt: new Date().toISOString(),
      });
      res.json({ invoice: supplierView(updated, payorName(updated)) });
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  return r;
}
