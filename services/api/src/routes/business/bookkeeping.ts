/**
 * The chart of accounts, categorisation rules, the ledger, positions and
 * export.
 *
 * Gating is a read-time filter, not a delete. A downgraded org keeps its
 * chart of accounts, rules and history; the API refuses to serve them until
 * an upgrade. Nothing here may delete on downgrade.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import { TX_TYPES, applyRules, validateChartAccount } from "../../domain/coa.js";
import {
  LEDGER_EXPORT_COLUMNS,
  computeCostBasis,
  ledgerExportRows,
  monthlyBalances,
  positions,
  realisedByMonth,
  toCsv,
} from "../../domain/ledger.js";
import { IncomeInvoiceError } from "../../domain/income-invoices.js";
import { proofStateOf } from "../../domain/wallet-ownership.js";
import { revaluable, revalueEntry } from "../../wallet-sync/revalue.js";
import { CHAIN_ID } from "../../config.js";
import { wrap } from "../util.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { limitsFor } from "../../domain/plans.js";
import {
  badRequest, } from "./shared.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

/** Rows retried by one call of the bulk revalue: each is a price call, so a
 *  call stays short and the client pages with `after`. */
const REVALUE_BATCH = 10;

/** What every cost-basis answer says about itself. */
const COST_BASIS_NOTES = [
  "First in, first out, per token contract on its chain, pooled across the organisation's imported wallets.",
  "A swap is booked as a sale of what left and a purchase of what arrived, each at its own EUR value; they are not paired.",
  "A gain is shown only where the sale, and every lot it used, has a EUR value and nothing was sold beyond the booked lots.",
  "Whether a disposal is taxable, the holding period and the cost-basis method are for your tax adviser (Steuerberater) to decide; Zold computes, it does not classify.",
];

/** The cost basis over the organisation's whole ledger. */
function basisOf(ctx: OrgContext) {
  const ownAccounts = store.accounts
    .filter((a) => a.orgId === ctx.org.id && a.address)
    .map((a) => ({ chainId: CHAIN_ID, address: a.address! }));
  const ownWallets = store.importedWalletsOf(ctx.org.id).map((w) => ({ chainId: w.chainId, address: w.address }));
  return computeCostBasis(store.ledgerOf(ctx.org.id), { ownWallets, ownAccounts });
}

export function createBookkeepingRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

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
    const walletId = req.body?.walletId ? String(req.body.walletId) : undefined;
    if (walletId && !store.importedWalletsOf(ctx.org.id).some((w) => w.id === walletId)) {
      return res.status(400).json({ error: "No such imported wallet on this organisation." });
    }
    const contactId = req.body?.contactId ? String(req.body.contactId) : undefined;
    if (contactId && !store.contactsOf(ctx.org.id).some((c) => c.id === contactId)) {
      return res.status(400).json({ error: "No such contact on this organisation." });
    }

    res.status(201).json({
      rule: store.addAccountRule({
        id: `rule_${randomUUID()}`,
        orgId: ctx.org.id,
        scope: scope as "default" | "wallet" | "asset" | "contact",
        match: {
          txType: req.body?.txType ? String(req.body.txType) : undefined,
          walletId,
          asset: req.body?.asset ? String(req.body.asset) : undefined,
          contactId,
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
      const code = String(req.body.accountCode);
      if (!store.chartOf(ctx.org.id).some((c) => c.code === code)) {
        return res.status(400).json({ error: `No account with code ${code}.` });
      }
      patch.accountCode = code;
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

  /**
   * Holdings per token with their lots, every disposal, and what is not
   * valued. Each figure names the ledger rows behind it. A wallet that is
   * not proven to be the organisation's is still counted, and labelled.
   */
  r.get("/:orgId/assets", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "assets.costBasis")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const basis = basisOf(ctx);
    const wallets = store.importedWalletsOf(ctx.org.id);
    const proof = new Map(wallets.map((w) => [w.id, proofStateOf(w)]));
    const proofOfLot = (walletId?: string) => (walletId ? proof.get(walletId) ?? "removed" : undefined);
    res.json({
      positions: positions(basis).map((p) => ({
        ...p,
        lots: p.lots.map((l) => ({ ...l, ...(l.walletId ? { walletProofState: proofOfLot(l.walletId) } : {}) })),
      })),
      disposals: basis.disposals,
      moved: basis.moved,
      // Surfaced rather than folded into profit: an unmatched disposal usually
      // means history is missing, and booking it at zero cost overstates income.
      shortfalls: basis.shortfalls,
      quantityOnly: basis.quantityOnly,
      unreadable: basis.unreadable,
      needsValuation: revaluable(ctx.org.id).map((e) => ({
        entryId: e.id, at: e.at, direction: e.direction, asset: e.asset, amount: e.amount, chainId: e.chainId,
        token: e.token, txHash: e.txHash, note: e.note, walletId: e.source.kind === "wallet" ? e.source.walletId : undefined,
      })),
      wallets: wallets.map((w) => ({ id: w.id, label: w.label, chainId: w.chainId, address: w.address, proofState: proofStateOf(w) })),
      costBasisMethod: ctx.org.reporting.costBasisMethod,
      notes: COST_BASIS_NOTES,
    });
  });

  /** Measured gains and losses per month, with every disposal behind them. */
  r.get("/:orgId/reports/realised-gains", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "assets.costBasis")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const basis = basisOf(ctx);
    try {
      res.json({
        timeZone: ctx.org.reporting.timeZone,
        months: realisedByMonth(basis.disposals, ctx.org.reporting.timeZone),
        disposals: basis.disposals,
        shortfalls: basis.shortfalls,
        moved: basis.moved,
        unreadable: basis.unreadable,
        costBasisMethod: ctx.org.reporting.costBasisMethod,
        notes: COST_BASIS_NOTES,
      });
    } catch (err) {
      if (err instanceof IncomeInvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  /** Ask the price feed again for a row synced without a value. */
  r.post("/:orgId/ledger/:entryId/revalue", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const outcome = await revalueEntry(ctx.org.id, String(req.params.entryId), { memberId: ctx.member.id });
    if (!outcome) return res.status(404).json({ error: "no such transaction" });
    if (outcome.status === "valued") return res.json({ entry: outcome.entry });
    const status = outcome.status === "refused" ? 409 : outcome.status === "no-price" ? 422 : 503;
    res.status(status).json({ error: `Not valued: ${outcome.reason}`, status: outcome.status });
  }));

  /** The same for the rows synced without a value, a page at a time in id
   *  order: `after` is the last id of the previous page, `next` this one's
   *  when more remain. A row that still has no price does not hold back the
   *  rows after it. */
  r.post("/:orgId/ledger/revalue", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const after = typeof req.body?.after === "string" ? req.body.after : "";
    const rows = revaluable(ctx.org.id).filter((e) => e.id > after);
    const page = rows.slice(0, REVALUE_BATCH);
    const results: { entryId: string; status: string; reason?: string; fiatValue?: string }[] = [];
    for (const row of page) {
      const outcome = await revalueEntry(ctx.org.id, row.id, { memberId: ctx.member.id });
      if (!outcome) continue;
      results.push(
        outcome.status === "valued"
          ? { entryId: row.id, status: "valued", fiatValue: outcome.entry.fiatValue }
          : { entryId: row.id, status: outcome.status === "refused" ? "skipped" : outcome.status, reason: outcome.reason },
      );
    }
    const remaining = rows.length - page.length;
    res.json({ results, remaining, ...(remaining ? { next: page[page.length - 1].id } : {}) });
  }));

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
