/**
 * The monthly export for the accountant: the statement lines of a month,
 * their Belege, a Lexware Office bank-import CSV and a ZIP of the Belege
 * named so each maps to its line.
 *
 * Prepare first (issues the missing Belege, a write), then download (reads).
 * The CSV carries every line of the month; a line whose Beleg is missing
 * says so in the Zusatzinfo column rather than being dropped.
 */
import express from "express";
import { store } from "../../store.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { isMonth, linesInMonth } from "../../bookkeeping/statement.js";
import { statementLinesOf, swapsHaveExecuted, writeStatementLinesFor } from "../../bookkeeping/writer.js";
import { issueBelegForLine } from "../../bookkeeping/issue.js";
import { belegFileName, belegPdf, UNEXECUTED_NOTE } from "../../bookkeeping/beleg.js";
import { lexwareCsvBytes, lexwareRow } from "../../bookkeeping/lexware.js";
import { zipStored } from "../../bookkeeping/zip.js";
import { documentUrl } from "../../documents.js";
import type { LedgerEntry } from "../../domain/types.js";

export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

/** The line as the dashboard and the accountant see it. */
export function publicStatementLine(e: LedgerEntry) {
  const s = e.statement!;
  return {
    id: e.id,
    event: s.event,
    bookingDate: s.bookingDate,
    valueDate: s.valueDate,
    amountCents: s.amountCents,
    counterparty: s.counterparty,
    reference: s.reference,
    accountCode: e.accountCode,
    tags: e.tags,
    note: e.note,
    links: s.links,
    ...(s.documentCode ? { documentCode: s.documentCode, documentUrl: documentUrl(s.documentCode) } : {}),
    ...(s.unexecuted ? { unexecuted: true } : {}),
  };
}

const holderNameFor = (orgId: string): string => {
  const org = store.findOrganisation(orgId);
  return org?.legalName || org?.name || "Account holder";
};

const monthOf = (req: express.Request, res: express.Response): string | undefined => {
  const month = String(req.params.month ?? req.query.month ?? "");
  if (!isMonth(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return undefined;
  }
  return month;
};

export function createBookkeepingExportRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/bookkeeping/statement", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const month = req.query.month ? String(req.query.month) : undefined;
    if (month && !isMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
    const all = statementLinesOf(ctx.org.id);
    const lines = (month ? linesInMonth(all, month) : all).map(publicStatementLine);
    const months = [...new Set(all.map((e) => e.statement!.valueDate.slice(0, 7)))].sort().reverse();
    res.json({
      month,
      months,
      lines,
      swapsHaveExecuted: swapsHaveExecuted(),
      ...(swapsHaveExecuted() ? {} : { note: UNEXECUTED_NOTE }),
    });
  });

  /** Re-run the writer for this org's accounts. Idempotent; human codes stay. */
  r.post("/:orgId/bookkeeping/statement/rebuild", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    let added = 0;
    let updated = 0;
    for (const a of store.accountsOf(ctx.org.id)) {
      const u = a.backingUserId ? store.findUser(a.backingUserId) : undefined;
      if (!u) continue;
      const r2 = writeStatementLinesFor(u);
      added += r2.added;
      updated += r2.updated;
    }
    res.json({ added, updated });
  });

  r.post("/:orgId/bookkeeping/export/:month/prepare", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "export.ledger")) return;
      if (!requirePermission(ctx, res, "reports.run")) return;
      const month = monthOf(req, res);
      if (!month) return;
      const lines = linesInMonth(statementLinesOf(ctx.org.id), month);
      const issued: string[] = [];
      const failed: { lineId: string; error: string }[] = [];
      for (const line of lines) {
        try {
          const { doc, issued: fresh } = await issueBelegForLine(line);
          if (fresh) issued.push(doc.code);
        } catch (err: any) {
          failed.push({ lineId: line.id, error: String(err?.message ?? err).slice(0, 160) });
        }
      }
      res.json({
        month,
        lines: lines.length,
        belegeIssued: issued.length,
        failed,
        files: {
          csv: `/api/orgs/${ctx.org.id}/bookkeeping/export/${month}/lexware.csv`,
          zip: `/api/orgs/${ctx.org.id}/bookkeeping/export/${month}/belege.zip`,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/:orgId/bookkeeping/export/:month/lexware.csv", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "export.ledger")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const month = monthOf(req, res);
    if (!month) return;
    const lines = linesInMonth(statementLinesOf(ctx.org.id), month);
    const holder = holderNameFor(ctx.org.id);
    const rows = lines.map((e) => {
      const row = lexwareRow(e, holder);
      if (!e.statement!.documentCode) row.extra = ["Beleg fehlt (Export noch nicht vorbereitet)", row.extra].filter(Boolean).join(" | ");
      return row;
    });
    // Set after attachment(): express re-derives the charset from the
    // extension there, and these bytes are Latin-1, as the template is.
    res.status(200).attachment(`zold-${month}-lexware.csv`);
    res.setHeader("content-type", "text/csv; charset=iso-8859-1");
    res.send(lexwareCsvBytes(rows));
  });

  r.get("/:orgId/bookkeeping/export/:month/belege.zip", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "export.ledger")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const month = monthOf(req, res);
    if (!month) return;
    const lines = linesInMonth(statementLinesOf(ctx.org.id), month);
    const entries = [];
    const missing: string[] = [];
    for (const e of lines) {
      const code = e.statement!.documentCode;
      const doc = code ? store.findDocumentByCode(code) : undefined;
      if (!doc || doc.snapshot.kind !== "beleg") {
        missing.push(e.id);
        continue;
      }
      entries.push({ name: belegFileName(doc.snapshot, doc.code), data: belegPdf(doc.snapshot, doc.code, doc.createdAt), modifiedAt: new Date(doc.createdAt) });
    }
    if (missing.length) {
      entries.push({
        name: `MISSING-${month}.txt`,
        data: Buffer.from(`${missing.length} line(s) have no Beleg yet. Run prepare for ${month} first.\n${missing.join("\n")}\n`, "utf8"),
      });
    }
    res.status(200).type("application/zip").attachment(`zold-${month}-belege.zip`).send(zipStored(entries));
  });

  /** One line's Beleg on demand, for the dashboard. */
  r.post("/:orgId/bookkeeping/lines/:lineId/beleg", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "export.ledger")) return;
      if (!requirePermission(ctx, res, "reports.run")) return;
      const line = store.ledgerOf(ctx.org.id).find((e) => e.id === String(req.params.lineId) && e.statement);
      if (!line) return res.status(404).json({ error: "no such statement line" });
      const { doc, issued } = await issueBelegForLine(line);
      res.status(issued ? 201 : 200).json({ code: doc.code, url: documentUrl(doc.code), issued });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
