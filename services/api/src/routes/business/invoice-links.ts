/**
 * The supplier's half of the invoice flow: no account, no wallet, no session.
 *
 * Mounted at /api/invoice-links and reached only with the one-time token. Every
 * response goes through supplierView(), which is an ALLOWLIST — a field added
 * to Invoice later must be chosen into it rather than leaking by default.
 *
 * The token and its optional password are bearer secrets, so both compare in
 * constant time and this router sits on the tight rate bucket. The password is
 * human-chosen, so its wrong guesses are also counted per link, across every
 * source address.
 */
import express from "express";
import { store } from "../../store.js";
import { ContactError } from "../../domain/contacts.js";
import {
  InvoiceError,
  assertTransition as assertInvoiceTransition,
  hashToken,
  supplierView,
  validateLines,
} from "../../domain/invoices.js";
import { passwordMatches } from "../../domain/passwords.js";
import { recordFailure, tooManyFailures } from "../../http/policy.js";
import { parsePayTo } from "./shared.js";
import type { Invoice } from "../../domain/types.js";

/** Wrong passwords one link absorbs, from any number of addresses, per window. */
const PASSWORD_FAILURES_MAX = 10;
const PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000;

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
      const key = `invoice-pw:${invoice.id}`;
      if (tooManyFailures(key, PASSWORD_FAILURES_MAX)) {
        res.status(429).json({ error: "Too many wrong passwords for this link. Try again in 15 minutes." });
        return undefined;
      }
      const supplied = String(req.header("x-invoice-password") ?? req.body?.password ?? "");
      if (!supplied) {
        res.status(401).json({ error: "This invoice link is password protected.", passwordRequired: true });
        return undefined;
      }
      if (supplied.length > 256 || !passwordMatches(supplied, invoice.linkPasswordHash)) {
        recordFailure(key, PASSWORD_FAILURE_WINDOW_MS);
        res.status(401).json({ error: "That password is not right.", passwordRequired: true });
        return undefined;
      }
    }
    return invoice;
  };

  const payorName = (invoice: Invoice) =>
    store.findOrganisation(invoice.orgId)?.name ?? "";

  /**
   * Bank details and footer come from the ISSUING org, and only for an invoice
   * it issued. An incoming invoice must not leak our bank details to the
   * supplier who filled it in.
   */
  const issuerExtras = (invoice: Invoice) => {
    if (invoice.direction !== "outgoing") return undefined;
    const org = store.findOrganisation(invoice.orgId);
    const footerNote = [
      org?.invoicing?.footerNote,
      org?.invoicing?.registerCourt && org?.invoicing?.registerNumber
        ? `${org.invoicing.registerCourt} ${org.invoicing.registerNumber}`
        : undefined,
      org?.invoicing?.managingDirector
        ? `Geschäftsführer: ${org.invoicing.managingDirector}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return { bank: org?.invoicing?.bank, footerNote: footerNote || undefined };
  };

  r.get("/:token", (req, res) => {
    const invoice = load(req, res);
    if (!invoice) return;
    res.json({ invoice: supplierView(invoice, payorName(invoice), issuerExtras(invoice)) });
  });

  /** The supplier fills the invoice in. Locked once submitted. */
  r.post("/:token/submit", (req, res) => {
    const invoice = load(req, res);
    if (!invoice) return;
    if (invoice.state !== "LINK_CREATED") {
      return res.status(409).json({
        error: "This invoice was already submitted. Submitted invoices are timestamped and locked.",
        invoice: supplierView(invoice, payorName(invoice), issuerExtras(invoice)),
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
        payTo: parsePayTo(req.body?.payTo, invoice.currency),
        dueDate: typeof req.body?.dueDate === "string" ? req.body.dueDate : invoice.dueDate,
        submittedAt: new Date().toISOString(),
      });
      res.json({ invoice: supplierView(updated, payorName(updated), issuerExtras(updated)) });
    } catch (err) {
      if (err instanceof InvoiceError || err instanceof ContactError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  return r;
}
