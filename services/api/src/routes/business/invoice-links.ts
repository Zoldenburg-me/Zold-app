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
import { ContactError, chainName } from "../../domain/contacts.js";
import { CHAIN_ID } from "../../config.js";
import { mailAvailable, sendInvoiceSubmitted, sendSendLinkFilled } from "../../adapters/mailer.js";
import {
  InvoiceError,
  assertTransition as assertInvoiceTransition,
  hashToken,
  supplierView,
  validateLines,
  validateSendLinkSubmit,
  assertSendLinkLimit,
} from "../../domain/invoices.js";
import { passwordMatches } from "../../domain/passwords.js";
import { forgetFailure, recordFailure, tooManyFailures } from "../../http/policy.js";
import { invoiceBankOf, parsePayTo } from "./shared.js";
import { openLinkPath, payLinkLapsed } from "./invoice-pay-link.js";
import { syncInvoicePayment } from "./state.js";
import type { Invoice } from "../../domain/types.js";

/** Wrong passwords one link absorbs, from any number of addresses, per window. */
const PASSWORD_FAILURES_MAX = 10;
const PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000;
const SEND_LIMIT_MISSES_MAX = 5;
const SEND_LIMIT_MISS_WINDOW_MS = 24 * 60 * 60_000;
const DUE_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const payorName = (invoice: Invoice) =>
  store.findOrganisation(invoice.orgId)?.name ?? "";

/** "Managing director" in each language an invoice can be written in. */
const DIRECTOR_LABEL: Record<string, string> = {
  de: "Geschäftsführung",
  en: "Managing director",
  fr: "Directeur général",
  es: "Director general",
};

/**
 * Bank details, footer and payment link come from the ISSUING org, and only
 * for an invoice it issued. An incoming invoice must not leak our bank
 * details to the supplier who filled it in. The footer's labels are in the
 * invoice's language, not German by default.
 */
const issuerExtras = (invoice: Invoice) => {
  if (invoice.direction !== "outgoing") return undefined;
  const org = store.findOrganisation(invoice.orgId);
  const director = DIRECTOR_LABEL[invoice.issued?.language ?? "en"] ?? DIRECTOR_LABEL.en;
  const footerNote = [
    org?.invoicing?.footerNote,
    [org?.invoicing?.registerCourt, org?.invoicing?.registerNumber].filter(Boolean).join(" ") || undefined,
    org?.invoicing?.managingDirector ? `${director}: ${org.invoicing.managingDirector}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const settled = invoice.state === "PAID" || invoice.state === "RECONCILED";
  return {
    bank: org ? invoiceBankOf(org) : undefined,
    footerNote: footerNote || undefined,
    // The customer holding the invoice link is the one its payment link was
    // made for; a settled invoice has nothing left to pay.
    payPath: settled ? undefined : openLinkPath(invoice),
    payLinkLapsed: settled ? undefined : payLinkLapsed(invoice) || undefined,
  };
};

/** The issued document exactly as the link holder sees it; the owner's
 *  print view (routes/business/invoices.ts) reads the same projection. */
export const linkInvoiceView = (invoice: Invoice) =>
  supplierView(payeeState(invoice), payorName(invoice), issuerExtras(invoice));

/** A send link tied to a payment the payer has not yet signed reads as
 *  still waiting to the payee: nothing is on its way until it is signed. */
const payeeState = (invoice: Invoice): Invoice => {
  if (!invoice.sendLink || invoice.state !== "PAYING") return invoice;
  const p = invoice.payment;
  const send = p?.cryptoSendId ? store.findCryptoSend(p.cryptoSendId) : undefined;
  const t = p?.transferId ? store.findTransfer(p.transferId) : undefined;
  const unsigned = send ? send.state === "CREATED" : !!t && t.state === "CREATED" && !t.auth?.authorizedAt && !t.moneriumRedeem?.signedAt;
  return unsigned ? { ...invoice, state: "SUBMITTED" } : invoice;
};

/** The chains a supplier may name for a wallet payout: the one this
 *  deployment runs on, the only one the payor's account holds money on. */
export const payoutChains = () => [{ chainId: CHAIN_ID, name: chainName(CHAIN_ID) }];

/**
 * Mail whoever made the link that the supplier submitted it. Never blocks or
 * fails the submission: no mail configured, no email on file, or a refused
 * send is logged and dropped. `mailOn` and `send` are for tests.
 */
export async function notifyRequester(
  invoice: Invoice,
  { mailOn = mailAvailable(), send = invoice.sendLink ? (to: string) => sendSendLinkFilled(to) : sendInvoiceSubmitted } = {},
): Promise<"sent" | "off" | "no-email" | "failed"> {
  if (!mailOn) return "off";
  // All of it in the try: this runs unawaited, and an unhandled rejection exits the API.
  try {
    // A requester who has left the org, or never confirmed the address, is told nothing.
    const member = invoice.createdByMemberId ? store.findMember(invoice.createdByMemberId) : undefined;
    const user = member?.status === "active" && member.userId ? store.findUser(member.userId) : undefined;
    const email = user?.emailVerifiedAt ? user.email : undefined;
    if (!email) {
      console.error(`invoice submitted: ${invoice.id}: the requester has no confirmed email or left the org`);
      return "no-email";
    }
    await send(email, store.findOrganisation(invoice.orgId)?.name ?? "your organisation");
    return "sent";
  } catch (err: any) {
    // Codes only: the SMTP server's reply can quote the address.
    console.error(`invoice submitted: ${invoice.id}: mail failed: ${err?.code ?? "error"}${err?.responseCode ? ` (SMTP ${err.responseCode})` : ""}`);
    return "failed";
  }
}

export function createInvoiceLinkRouter(): express.Router {
  const r = express.Router();

  const load = async (
    req: express.Request,
    res: express.Response,
  ): Promise<Invoice | undefined> => {
    const token = String(req.params.token ?? "");
    const found = store.findInvoiceByLinkHash(hashToken(token));
    // The payee's receipt follows the payment too, not only the owner's list.
    const invoice = found ? syncInvoicePayment(found) : undefined;
    if (!invoice || invoice.state === "DELETED" || invoice.state === "DRAFT") {
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
      // Counted as a failure before the (async) check, so guesses in flight
      // together are all counted; a right password takes its count back.
      recordFailure(key, PASSWORD_FAILURE_WINDOW_MS);
      if (supplied.length > 256 || !(await passwordMatches(supplied, invoice.linkPasswordHash))) {
        res.status(401).json({ error: "That password is not right.", passwordRequired: true });
        return undefined;
      }
      forgetFailure(key);
    }
    return invoice;
  };

  r.get("/:token", async (req, res) => {
    const invoice = await load(req, res);
    if (!invoice) return;
    res.json({ invoice: linkInvoiceView(invoice), payoutChains: payoutChains() });
  });

  /** The supplier fills the invoice in. Locked once submitted. */
  r.post("/:token/submit", async (req, res) => {
    const invoice = await load(req, res);
    if (!invoice) return;
    if (invoice.state !== "LINK_CREATED") {
      return res.status(409).json({
        error: invoice.sendLink
          ? "This link was already filled in."
          : "This invoice was already submitted. Submitted invoices are timestamped and locked.",
        invoice: linkInvoiceView(invoice),
      });
    }
    if (invoice.sendLink) {
      // The limit is hidden; asking over it says only "too much". Counting misses
      // keeps that from finding the limit by trying amount after amount, and the
      // limit is checked last, so no other refusal answers for free.
      // shortcut: the count is per link and in memory, so anyone holding the URL can
      // lock the payee out for 24 h and a restart clears it; persist it per client
      // once a link is abused.
      const missKey = `send-limit:${invoice.id}`;
      if (tooManyFailures(missKey, SEND_LIMIT_MISSES_MAX)) {
        return res.status(429).json({ error: "Too many amounts over this link's limit. Ask the person who sent it for a new link." });
      }
      try {
        const { lines, total, name } = validateSendLinkSubmit(req.body);
        const raw = req.body?.payTo;
        // The account holder is the person filling the link in: one name, not two fields.
        const payTo = parsePayTo(raw && typeof raw === "object" && raw.kind === "bank" ? { kind: "bank", bank: { ...(raw.bank ?? raw), holderName: name } } : raw, "EUR");
        if (!payTo) return res.status(400).json({ error: "Say where to send the money: an IBAN or a wallet address." });
        if (payTo.kind === "wallet" && !payoutChains().some((c) => c.chainId === payTo.chainId)) {
          return res.status(400).json({ error: `A wallet must be on ${payoutChains().map((c) => c.name).join(" or ")}.` });
        }
        try { assertSendLinkLimit(invoice.sendLink, total); } catch (err) {
          recordFailure(missKey, SEND_LIMIT_MISS_WINDOW_MS);
          throw err;
        }
        assertInvoiceTransition(invoice.state, "SUBMITTED");
        const updated = store.updateInvoice(invoice.id, {
          state: "SUBMITTED",
          // The number is the SEPA reference the payer's transfer carries.
          supplier: { orgName: name, email: "", invoiceNumber: `LINK-${invoice.id.slice(4, 12).toUpperCase()}` },
          lines,
          total,
          payTo,
          submittedAt: new Date().toISOString(),
        });
        res.json({ invoice: linkInvoiceView(updated) });
        void notifyRequester(updated);
      } catch (err) {
        if (err instanceof InvoiceError || err instanceof ContactError) return res.status(400).json({ error: err.message, ...(err instanceof InvoiceError && err.code ? { code: err.code } : {}) });
        throw err;
      }
      return;
    }
    try {
      const { lines, total } = validateLines(req.body?.lines);
      const supplier = req.body?.supplier ?? {};
      for (const field of ["orgName", "email", "invoiceNumber"]) {
        if (!String(supplier[field] ?? "").trim()) {
          return res.status(400).json({ error: `Your ${field} is required.` });
        }
      }
      // Printed on the payor's documents; the link is reachable by anyone who
      // holds it, so nothing in it is unbounded.
      const maxLength: Record<string, number> = { orgName: 200, email: 254, address: 500, taxId: 40, invoiceNumber: 60 };
      for (const [field, max] of Object.entries(maxLength)) {
        if (String(supplier[field] ?? "").trim().length > max) {
          return res.status(400).json({ error: `Your ${field} is limited to ${max} characters.` });
        }
      }
      const dueDate = req.body?.dueDate;
      if (dueDate !== undefined && dueDate !== null && dueDate !== "" && !(typeof dueDate === "string" && DUE_DATE.test(dueDate))) {
        return res.status(400).json({ error: "The due date must be a date, YYYY-MM-DD." });
      }
      const payTo = parsePayTo(req.body?.payTo, invoice.currency);
      if (payTo?.kind === "wallet" && !payoutChains().some((c) => c.chainId === payTo.chainId)) {
        return res.status(400).json({ error: `A wallet must be on ${payoutChains().map((c) => c.name).join(" or ")}.` });
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
        payTo,
        dueDate: typeof dueDate === "string" && dueDate ? dueDate : invoice.dueDate,
        submittedAt: new Date().toISOString(),
      });
      res.json({ invoice: linkInvoiceView(updated) });
      void notifyRequester(updated);
    } catch (err) {
      if (err instanceof InvoiceError || err instanceof ContactError) return res.status(400).json({ error: err.message, ...(err instanceof InvoiceError && err.code ? { code: err.code } : {}) });
      throw err;
    }
  });

  return r;
}
