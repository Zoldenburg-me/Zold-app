/**
 * Incoming invoices: the Invoice-Me link a supplier fills in, paying one, and
 * reconciling one paid elsewhere.
 *
 * AN INVOICE IS PAID THROUGH A DRAFT, never by a second payment path. The
 * supplier is matched to a contact BY IBAN, then by name, else created — never
 * by merging a supplier's self-declared details into a trusted contact, which
 * is how invoice fraud works.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import { activity, validateLine } from "../../domain/drafts.js";
import {
  InvoiceError,
  assertDeletable,
  assertPayable,
  assertTransition as assertInvoiceTransition,
  hashToken,
  isOverdue,
  newLinkToken,
} from "../../domain/invoices.js";
import { normaliseIban, validateBankAccount } from "../../domain/contacts.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { can } from "../../domain/plans.js";
import {
  badRequest, } from "./shared.js";
import {
  syncInvoicePayment, } from "./state.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

export function createInvoiceRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/invoices", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    res.json({
      invoices: store
        .invoicesOf(ctx.org.id)
        .filter((i) => i.state !== "DELETED")
        .map(syncInvoicePayment)
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
    if (!requireCapability(ctx, res, "invoices")) return;
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

  /**
   * Pay an incoming invoice: one draft, one line, built from what the supplier
   * gave. The supplier lands in the address book (or is matched to an existing
   * contact by IBAN, then by name) so the line carries a fingerprint and the
   * four-eyes review applies exactly as to any other payment. The invoice
   * moves to PAYING and follows its transfer from there.
   */
  r.post("/:orgId/invoices/:invoiceId/pay", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    const invoice = store.findInvoice(String(req.params.invoiceId));
    if (!invoice || invoice.orgId !== ctx.org.id) return res.status(404).json({ error: "no such invoice" });

    let bank: ReturnType<typeof assertPayable>;
    try {
      bank = assertPayable(syncInvoicePayment(invoice));
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
      throw err;
    }

    const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : undefined;
    const account = accountId
      ? store.findAccount(accountId)
      : store.accountsOf(ctx.org.id).find((a) => a.currency === invoice.currency);
    if (!account || account.orgId !== ctx.org.id) {
      return res.status(400).json({ error: `This organisation has no ${invoice.currency} account to pay from.` });
    }

    // The supplier as a contact. Match on IBAN only: the same account under a
    // renamed company is the same payee. NEVER by name — the name is the
    // supplier's own claim through the link, and attaching a stranger's IBAN
    // to a trusted contact because they typed its name is the classic
    // invoice-fraud move. An unknown IBAN gets a new contact the reviewer sees
    // as new.
    const iban = normaliseIban(bank.iban);
    const contacts = store.contactsOf(ctx.org.id);
    let contact = contacts.find((c) => c.bankAccounts.some((b) => b.iban && normaliseIban(b.iban) === iban));
    let bankAccountId = contact?.bankAccounts.find((b) => b.iban && normaliseIban(b.iban) === iban)?.id;
    const supplierName = invoice.supplier?.orgName?.trim() || bank.holderName;
    const now = new Date().toISOString();
    if (!bankAccountId) {
      const bankAccount = {
        id: `cb_${randomUUID()}`,
        ...validateBankAccount({
          currency: invoice.currency,
          country: iban.slice(0, 2),
          holderName: bank.holderName,
          iban,
          bic: bank.bic,
        }),
      };
      bankAccountId = bankAccount.id;
      {
        contact = store.addContact({
          id: `con_${randomUUID()}`,
          orgId: ctx.org.id,
          name: supplierName,
          email: invoice.supplier?.email,
          wallets: [],
          bankAccounts: [bankAccount],
          notes: `Added from invoice ${invoice.supplier?.invoiceNumber ?? invoice.id}`,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (!contact || !bankAccountId) {
      return res.status(500).json({ error: "could not resolve the supplier's bank account" });
    }
    let line;
    try {
      line = {
        id: `dl_${randomUUID()}`,
        ...validateLine(
          {
            contactId: contact.id,
            invoiceId: invoice.id,
            destination: { kind: "bank", bankAccountId, displayName: bank.holderName },
            asset: invoice.currency,
            amount: invoice.total,
            note: `Invoice ${invoice.supplier?.invoiceNumber ?? ""} · ${supplierName}`.trim(),
            tags: [],
          },
          contact,
        ),
      };
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
    const draft = store.addDraft({
      id: `dft_${randomUUID()}`,
      orgId: ctx.org.id,
      source: { kind: "account", accountId: account.id },
      state: "DRAFT",
      lines: [line],
      createdByMemberId: ctx.member.id,
      activity: [activity(ctx.member.id, "created", `Pays invoice ${invoice.supplier?.invoiceNumber ?? invoice.id}`)],
      createdAt: now,
      updatedAt: now,
    });
    const updated = store.updateInvoice(invoice.id, {
      state: "PAYING",
      payment: { ...invoice.payment, draftId: draft.id },
    });
    res.status(201).json({
      invoice: { ...updated, linkTokenHash: undefined },
      draft,
      contact,
      note: can(ctx.org, "transfers.approvals").allowed
        ? "A draft was created. A second person reviews it, then the account holder signs it."
        : "A draft was created. The account holder signs it to send.",
    });
  });

  /** Mark an invoice settled outside the platform (manual reconciliation). */
  r.post("/:orgId/invoices/:invoiceId/reconcile", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
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

  // ── Invoicing profile (§14 UStG identity, prefilled onto every invoice) ───

  /**
   * What the issuer looks like on paper, plus the reference data the editor
   * needs: the VAT rates, the exemption reasons with their statutes, and the
   * optional blocks that may be switched off. Mandatory §14 fields are NOT in
   * the display map — an invoice generator whose settings can produce an
   * invalid document is a trap, and the person it catches is the customer who
   * loses their input-tax deduction.
   */

  return r;
}
