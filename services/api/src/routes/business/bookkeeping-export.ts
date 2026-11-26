/**
 * The monthly export for the accountant: the statement lines of a month,
 * their Belege, a Lexware Office bank-import CSV and a ZIP of the Belege
 * named so each maps to its line.
 *
 * Prepare first (issues the missing Belege, a write), then download (reads).
 * The CSV carries every line of the month; a line whose Beleg is missing
 * says so in the Zusatzinfo column rather than being dropped.
 *
 * Which Beleg may be handed out is one rule, belegOfLine: issued, not
 * revoked, and its records still agree, the same check as the verify page.
 * One that no longer agrees is not shipped until someone who may manage the
 * books replaces it (POST .../beleg/replace).
 */
import express from "express";
import { store } from "../../store.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { invoicePayments, isMonth, linesInMonth, ownTransferAllowed, type InvoicePayments } from "../../bookkeeping/statement.js";
import { statementLinesOf, swapsHaveExecuted, writeAccountStatementLines, writeStatementLinesFor } from "../../bookkeeping/writer.js";
import { belegOfLine, documentsByCode, type DocumentsByCode, BelegAmbiguous, BelegStillVerifies, BelegWouldNotVerify, issueBelegForLine, replaceBelegForLine } from "../../bookkeeping/issue.js";
import { belegFileName, belegPdf, UNEXECUTED_NOTE } from "../../bookkeeping/beleg.js";
import { lexwareCsvBytes, lexwareRow } from "../../bookkeeping/lexware.js";
import { zipStored, type ZipEntry } from "../../bookkeeping/zip.js";
import { documentUrl } from "../../documents.js";
import type { LedgerEntry } from "../../domain/types.js";
import { bookedCode, isOwnTransfer } from "../../domain/ledger.js";
import { redactedMessage } from "../../http/log-cause.js";
import { auditEntry } from "../../audit.js";

export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

/** The line as the dashboard and the accountant see it. A listing builds
 *  `paid` and `docs` once. The statement, the CSV and the ZIP all take the
 *  Beleg from belegOfLine, so a revoked Beleg reads as missing everywhere
 *  until prepare issues a new one, and one that stopped verifying until it is
 *  replaced. */
export function publicStatementLine(
  e: LedgerEntry,
  paid: InvoicePayments = invoicePayments(store.invoices),
  docs?: DocumentsByCode,
) {
  const s = e.statement!;
  const b = belegOfLine(e, docs);
  const beleg = b && "live" in b ? b.live : undefined;
  return {
    id: e.id,
    event: s.event,
    bookingDate: s.bookingDate,
    valueDate: s.valueDate,
    amountCents: s.amountCents,
    counterparty: s.counterparty,
    reference: s.reference,
    accountCode: bookedCode(e),
    // A rule chose it (true) or a person did (false): Books overview counts
    // the lines only the default rule sorted.
    ...(bookedCode(e) ? { accountCodeAuto: e.accountCodeAuto !== false } : {}),
    tags: e.tags,
    ...(isOwnTransfer(e) ? { ownTransfer: true } : {}),
    ...(ownTransferAllowed(e, paid) ? { ownTransferAllowed: true } : {}),
    note: e.note,
    links: s.links,
    ...(beleg ? { documentCode: beleg.code, documentUrl: documentUrl(beleg.code) } : {}),
    // Offered only to be replaced: its page still says why it fails.
    ...(b && "stale" in b ? { belegStale: { code: b.stale.code, url: documentUrl(b.stale.code), detail: b.detail } } : {}),
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
    const paid = invoicePayments(store.invoices);
    const docs = documentsByCode();
    const lines = (month ? linesInMonth(all, month) : all).map((e) => publicStatementLine(e, paid, docs));
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
      // A company's own Safe has no backing user: its lines are its own.
      if (!u && !a.address) continue;
      const r2 = u ? writeStatementLinesFor(u) : writeAccountStatementLines(a);
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
          failed.push({ lineId: line.id, error: redactedMessage(err).slice(0, 160) });
        }
      }
      res.json({
        month,
        // Which legal entity owns each IBAN, as Monerium reported it at the
        // account's last profile check; null for an account never checked.
        ibanOwners: store.accountsOf(ctx.org.id).filter((a) => a.backingUserId).map((a) => ({
          accountId: a.id,
          currency: a.currency,
          moneriumProfile: a.moneriumProfile ?? null,
        })),
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
    const docs = documentsByCode();
    const rows = lines.map((e) => {
      const b = belegOfLine(e, docs);
      const code = b && "live" in b ? b.live.code : undefined;
      const row = lexwareRow(e, holder, code);
      const why = b && "stale" in b ? "Beleg stimmt nicht mehr (in Zold ersetzen)" : "Beleg fehlt (Export noch nicht vorbereitet)";
      if (!code) row.extra = [why, row.extra].filter(Boolean).join(" | ");
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
    const entries: ZipEntry[] = [];
    const missing: string[] = [];
    const stale: string[] = [];
    const docs = documentsByCode();
    for (const e of lines) {
      const b = belegOfLine(e, docs);
      if (!b) {
        missing.push(e.id);
        continue;
      }
      if ("stale" in b) {
        stale.push(`${e.id}: ${b.detail}`);
        continue;
      }
      const doc = b.live;
      // Unique in the archive even where two stored codes clean to one name.
      const base = belegFileName(doc.snapshot, doc.code);
      let name = base;
      for (let n = 2; entries.some((x) => x.name === name); n++) name = base.replace(/\.pdf$/, `_${n}.pdf`);
      entries.push({ name, data: belegPdf(doc.snapshot, doc.code, doc.createdAt), modifiedAt: new Date(doc.createdAt) });
    }
    if (missing.length || stale.length) {
      const text = [
        ...(missing.length ? [`${missing.length} line(s) have no Beleg yet. Run prepare for ${month} first.`, ...missing] : []),
        ...(stale.length ? [`${stale.length} line(s) have a Beleg that no longer matches the books, so it is left out. Replace it in Zold's Books, then download again.`, ...stale] : []),
      ];
      entries.push({ name: `MISSING-${month}.txt`, data: Buffer.from(`${text.join("\n")}\n`, "utf8") });
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
      let out;
      try {
        out = await issueBelegForLine(line);
      } catch (err) {
        if (err instanceof BelegAmbiguous) return res.status(409).json({ error: err.message });
        throw err;
      }
      const { doc, issued } = out;
      res.status(issued ? 201 : 200).json({ code: doc.code, url: documentUrl(doc.code), issued });
    } catch (err) {
      next(err);
    }
  });

  /** Revoke the line's Beleg that stopped verifying and issue a new one.
   *  Whoever may issue a Beleg may replace one: the owner, an admin, the
   *  accountant. One that still verifies is refused, so nothing true is
   *  revoked. */
  r.post("/:orgId/bookkeeping/lines/:lineId/beleg/replace", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "export.ledger")) return;
      if (!requirePermission(ctx, res, "reports.run")) return;
      const line = store.ledgerOf(ctx.org.id).find((e) => e.id === String(req.params.lineId) && e.statement);
      if (!line) return res.status(404).json({ error: "no such statement line" });
      let out;
      try {
        out = await replaceBelegForLine(line);
      } catch (err) {
        if (err instanceof BelegStillVerifies) return res.status(409).json({ error: "this receipt still matches the books, so there is nothing to replace" });
        if (err instanceof BelegAmbiguous) return res.status(409).json({ error: err.message });
        if (err instanceof BelegWouldNotVerify) return res.status(409).json({ error: `a new receipt would not match the books either (${err.message}), so this one is left as it is` });
        throw err;
      }
      // Document ids, never codes: a verification code is a credential.
      store.audit(auditEntry("document.reissued", {
        orgId: ctx.org.id, memberId: ctx.member.id, lineId: line.id, documentId: out.doc.id, ...(out.revoked ? { revokedDocumentId: out.revoked.id } : {}),
      }, ctx.userId));
      res.status(201).json({ code: out.doc.code, url: documentUrl(out.doc.code), issued: out.issued, revoked: !!out.revoked });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
