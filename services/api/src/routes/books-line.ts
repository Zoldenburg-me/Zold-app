/**
 * The statement line behind one payment, for its detail sheet in /app: which
 * org the person's Safe books under is the server's to decide (booksFor), and
 * a line's id is derived from that org.
 *
 * `line` is null wherever the mark would be refused, so the sheet draws no
 * action there: no line yet, no books, no permission, or a line that cannot
 * be an own transfer.
 */
import express from "express";
import { store } from "../store.js";
import { can } from "../domain/plans.js";
import { roleCan } from "../domain/roles.js";
import { isInternal } from "../domain/ledger.js";
import { booksFor } from "../bookkeeping/writer.js";
import { lineId, ownTransferAllowed } from "../bookkeeping/statement.js";

/** The keys a payment id in the activity feed can have a mark-able line under. */
const keysOf = (id: string) => [
  `transfer:${id}:payout`,
  `monerium:issue:${id}`,
  `deposit:${id}:eure`,
  `deposit:${id}:held`,
  `deposit:${id}:converted`,
  `cryptosend:${id}`,
];

export function createBooksLineRouter({ requireUserSession }: { requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown }) {
  const r = express.Router();
  r.get("/users/:id/books-line/:paymentId", (req, res) => {
    const userId = String(req.params.id);
    if (!requireUserSession(req, res, userId)) return;
    const books = booksFor(userId);
    const org = books && store.findOrganisation(books.orgId);
    const member = org && store.memberFor(org.id, userId);
    if (!org || member?.status !== "active" || !roleCan(member.role, "ledger.categorise") || !can(org, "ledger.transactions").allowed) {
      return res.json({ line: null });
    }
    const ids = new Set(keysOf(String(req.params.paymentId)).map((k) => lineId(org.id, k)));
    const entry = store.ledgerOf(org.id).find((e) => ids.has(e.id) && ownTransferAllowed(e));
    res.json({ line: entry ? { orgId: org.id, lineId: entry.id, ownTransfer: isInternal(entry) } : null });
  });
  return r;
}
