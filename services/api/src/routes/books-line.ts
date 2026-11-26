/**
 * The statement line behind one payment, for its detail sheet in /app: which
 * org the person's Safe books under is the server's to decide (booksFor), and
 * a line's id is derived from that org.
 *
 * `line` is null where the sheet draws no action: no line, no books, no
 * permission, a payment outside keysOf, or a line that cannot be an own
 * transfer (an invoice payment among them). A line already marked always comes back, so the mark can be undone.
 * `belegStale` says its Beleg no longer verifies and this person may replace it.
 */
import express from "express";
import { store } from "../store.js";
import { can } from "../domain/plans.js";
import { roleCan } from "../domain/roles.js";
import { isOwnTransfer } from "../domain/ledger.js";
import { booksFor, writeStatementLinesFor } from "../bookkeeping/writer.js";
import { describeCause } from "../http/log-cause.js";
import { invoicePayments, lineId, ownTransferAllowed } from "../bookkeeping/statement.js";
import { belegOfLine } from "../bookkeeping/issue.js";

/** The keys a payment on these sheets can have a mark-able line under. A
 *  conversion in parts has one line per part: it is marked on the statement in
 *  /business. */
const keysOf = (id: string) => [
  `transfer:${id}:payout`,
  `cryptosend:${id}`,
  `monerium:issue:${id}`,
  `deposit:${id}:eure`,
  `deposit:${id}:held`,
  `deposit:${id}:converted`,
];

export function createBooksLineRouter({ requireUserSession }: { requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown> }) {
  const r = express.Router();
  r.get("/users/:id/books-line/:paymentId", async (req, res) => {
    return store.tx(async () => {
      const userId = String(req.params.id);
      if (!(await requireUserSession(req, res, userId))) return;
      const books = await booksFor(userId);
      const org = books && (await store.findOrganisation(books.orgId));
      const member = org && (await store.memberFor(org.id, userId));
      if (!org || member?.status !== "active" || !roleCan(member.role, "ledger.categorise") || !can(org, "ledger.transactions").allowed) {
        return res.json({ line: null });
      }
      // The sweep writes lines once a minute, and a send reads SENT before then:
      // write this person's lines first, so a payment just confirmed has its own
      // (as one file write, like the sweep).
      const user = await store.findUser(userId);
      try { if (user) await store.tx(async () => await writeStatementLinesFor(user)); } catch (e) { console.error(`books-line ${userId}: ${describeCause(e)}`); }
      const ids = new Set(keysOf(String(req.params.paymentId)).map((k) => lineId(org.id, k)));
      const paid = invoicePayments(await store.list("invoices"));
      const entry = (await store.ledgerOf(org.id)).find((e) => ids.has(e.id) && (ownTransferAllowed(e, paid) || isOwnTransfer(e)));
      // A Beleg that stopped verifying (say after Undo): the sheet offers to replace it.
      const b = entry && (await belegOfLine(entry));
      const stale = b && "stale" in b && roleCan(member.role, "reports.run") && can(org, "export.ledger").allowed;
      res.json({ line: entry ? { orgId: org.id, lineId: entry.id, ownTransfer: isOwnTransfer(entry), ...(stale ? { belegStale: true } : {}) } : null });
    });
  });
  return r;
}
