/**
 * Incoming invoices: the Invoice-Me link a supplier fills in, paying one, and
 * reconciling one paid elsewhere.
 *
 * An invoice is paid through a draft. A send link (`sendLink`, one line the
 * payee fills in under the payer's limit) is the one exception: it is paid
 * from the app's own send screens, and POST .../paying ties that transfer or
 * wallet send to it after checking it pays exactly what the payee asked, to
 * exactly where. The supplier is matched to a contact by IBAN, else a new
 * contact is created.
 * Self-declared supplier details are never merged into a trusted contact
 * (that is how invoice fraud works).
 */
import { mapSeq } from "../../seq.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import { expiredUnsigned } from "../../orchestrator.js";
import { activity, validateLine } from "../../domain/drafts.js";
import {
  InvoiceError,
  assertDeletable,
  assertPayable,
  badDueDate,
  INVOICE_CURRENCIES,
  assertTransition as assertInvoiceTransition,
  centsOf,
  ownerInvoiceView,
  isOverdue,
  newLinkToken,
  validateSendLinkCreate,
} from "../../domain/invoices.js";
import { hashPassword, passwordProblem } from "../../domain/passwords.js";
import { normaliseIban, validateBankAccount } from "../../domain/contacts.js";
import type { Contact, Invoice } from "../../domain/types.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { paymentReviewRequired } from "../../domain/payment-review.js";
import {
  badRequest, } from "./shared.js";
import {
  syncInvoicePayment, } from "./state.js";
import { CEILINGS, ceilingRefusal } from "../../domain/ceilings.js";
import { linkInvoiceView, payoutChains } from "./invoice-links.js";
import { openLinkFor, payLinkOffer } from "./invoice-pay-link.js";
import { SECRETS, sealInvoiceLink } from "../../stored-secrets.js";
import { liveCryptoSend } from "../../wallet/org-debit.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => Promise<OrgContext | undefined>;
}

const linkPathOf = (invoice: Pick<Invoice, "sendLink">, token: string) => (invoice.sendLink ? `/send/${token}` : `/invoice/${token}`);

export function createInvoiceRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/invoices", async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    res.json({
      invoices: (await mapSeq((await store.invoicesOf(ctx.org.id)).filter((i) => i.state !== "DELETED"), async (i) => (i.state === "PAYING" ? syncInvoicePayment(i) : i)))
        .map((i) => ({ ...ownerInvoiceView(i), overdue: isOverdue(i) })),
      // Whether "Payment link" on an issued invoice would pass for this
      // caller, so the UI offers it only where the API would accept it.
      payLink: await payLinkOffer(ctx),
    });
  });

  /** An issued invoice as its customer sees it, for the owner to read and
   *  print again: the same projection the link gives, reached with their
   *  session. Read only. */
  r.get("/:orgId/invoices/:invoiceId/document", async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    const invoice = await store.findInvoice(String(req.params.invoiceId));
    if (!invoice || invoice.orgId !== ctx.org.id || invoice.direction !== "outgoing" || !invoice.issued || invoice.state === "DELETED") {
      return res.status(404).json({ error: "no such invoice" });
    }
    // The pay link is the customer's credential, and invoices.read is every
    // role's: the owner's copy carries the document, not the way to pay it.
    const { payPath: _payPath, payLinkLapsed: _lapsed, ...document } = await linkInvoiceView(invoice);
    res.json({ invoice: document });
  });

  /**
   * The invoice's link again, opened from its sealed copy. A link is a
   * credential: whoever may make one may read it, and a send link only its
   * maker, as only they can pay it.
   */
  r.get("/:orgId/invoices/:invoiceId/link", async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const invoice = await store.findInvoice(String(req.params.invoiceId));
    if (!invoice || invoice.orgId !== ctx.org.id || invoice.state === "DELETED" || invoice.state === "DRAFT") {
      return res.status(404).json({ error: "no such invoice" });
    }
    if (invoice.sendLink && invoice.createdByMemberId !== ctx.member.id) {
      return res.status(403).json({ error: "Only the person who made this link can read it." });
    }
    if (!invoice.linkTokenEnc) {
      return res.status(409).json({ error: "No copy of this link was kept. It was shown when it was made.", code: "NO_LINK_COPY" });
    }
    res.json({ linkPath: linkPathOf(invoice, SECRETS.invoiceLinkToken.open(invoice.id, invoice.linkTokenEnc)) });
  });

  /** Create the "Invoice-Me" link. */
  r.post("/:orgId/invoices", async (req, res) => {
    const ctx = await ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    const waiting = (await store.invoicesOf(ctx.org.id)).filter((i) => i.state === "LINK_CREATED").length;
    if (waiting >= CEILINGS.openInvoiceLinksPerOrg) {
      return res.status(409).json(ceilingRefusal("invoice links not yet filled in", CEILINGS.openInvoiceLinksPerOrg));
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password) {
      const problem = passwordProblem(password, [ctx.org.name]);
      if (problem) return res.status(400).json({ error: `Link password refused: ${problem}` });
    }
    let sendLink;
    try {
      sendLink = req.body?.sendLink ? validateSendLinkCreate(req.body.sendLink) : undefined;
      // /paying ties the caller's own payment, so a send link lives only in their personal org.
      if (sendLink && ctx.org.type !== "personal") throw new InvoiceError("Send links are made from your personal account.");
      // send.html has no password step: a protected send link could never be filled in.
      if (sendLink && password) throw new InvoiceError("A send link cannot have a password.");
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
    // A send link is paid from a euro balance, whatever the org reports in.
    const currency = sendLink ? "EUR" : String(req.body?.currency ?? ctx.org.reporting.currency).toUpperCase();
    if (!(INVOICE_CURRENCIES as readonly string[]).includes(currency)) {
      return res.status(400).json({ error: `An invoice can be requested in ${INVOICE_CURRENCIES.join(" or ")}.` });
    }
    // A dollar invoice is paid to a wallet only: no link where no wallet can be paid.
    if (currency === "USD" && !payoutChains().length) {
      return res.status(400).json({ error: "Dollar invoices are paid in USDC to a wallet, and sending to a wallet is not open here." });
    }
    const dueDate = req.body?.dueDate;
    if (badDueDate(dueDate)) {
      return res.status(400).json({ error: "The due date must be a date, YYYY-MM-DD." });
    }
    const passwordHash = password ? await hashPassword(password) : undefined;
    const { token, hash } = newLinkToken();
    const now = new Date().toISOString();
    const id = `inv_${randomUUID()}`;
    const invoice = await store.addInvoice({
      id,
      orgId: ctx.org.id,
      linkTokenHash: hash,
      linkTokenEnc: sealInvoiceLink(id, token),
      linkPasswordHash: passwordHash,
      state: "LINK_CREATED",
      lines: [],
      currency,
      total: "0.00",
      ...(sendLink ? { sendLink } : {}),
      dueDate: dueDate || undefined,
      createdByMemberId: ctx.member.id,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({
      invoice: ownerInvoiceView(invoice),
      linkToken: token,
      linkPath: linkPathOf(invoice, token),
      note: "Send this link to your supplier.",
    });
  });

  r.delete("/:orgId/invoices/:invoiceId", async (req, res) => {
    return store.tx(async () => {
      const ctx = await ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "invoices")) return;
      if (!requirePermission(ctx, res, "invoices.manage")) return;
      const invoice = await store.findInvoice(String(req.params.invoiceId));
      if (!invoice || invoice.orgId !== ctx.org.id) {
        return res.status(404).json({ error: "no such invoice" });
      }
      try {
        assertDeletable(invoice);
        // From the state checked: a payment or settlement landing meanwhile wins.
        if (!(await store.updateInvoiceFrom(invoice.id, [invoice.state], { state: "DELETED" }))) {
          return res.status(409).json({ error: "This invoice changed meanwhile. Reload it." });
        }
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
        throw err;
      }
    });
  });

  /**
   * Pay an incoming invoice: one draft, one line, built from what the supplier
   * gave: a SEPA transfer to their IBAN, or EURe or USDC to their wallet. The
   * supplier lands in the address book (or is matched to an existing contact
   * by that destination) so the line carries a fingerprint and the
   * four-eyes review applies exactly as to any other payment. The invoice
   * moves to PAYING and follows its transfer from there.
   */
  r.post("/:orgId/invoices/:invoiceId/pay", async (req, res) => {
    return store.tx(async () => {
      const ctx = await ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "invoices")) return;
      if (!requirePermission(ctx, res, "drafts.create")) return;
      const invoice = await store.findInvoice(String(req.params.invoiceId));
      if (!invoice || invoice.orgId !== ctx.org.id) return res.status(404).json({ error: "no such invoice" });

      let payee: ReturnType<typeof assertPayable>;
      try {
        payee = assertPayable(await syncInvoicePayment(invoice));
      } catch (err) {
        if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
        throw err;
      }
      if (payee.kind === "wallet" && !payoutChains().some((c) => c.chainId === payee.chainId)) {
        return res.status(409).json({ error: payoutChains().length
          ? `The supplier's wallet is on another network; this account pays on ${payoutChains().map((c) => c.name).join(" or ")}.`
          : "Sending to a wallet is not open here. Reconcile this invoice once it is paid another way." });
      }

      // A wallet is paid from the Safe behind the euro account, in the
      // invoice's token: a dollar account is gated and has no Safe of its own.
      const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : undefined;
      const accounts = await store.accountsOf(ctx.org.id);
      const account = accountId
        ? (await store.findAccount(accountId))
        : accounts.find((a) => a.currency === (payee.kind === "wallet" ? "EUR" : invoice.currency));
      if (!account || account.orgId !== ctx.org.id) {
        return res.status(400).json({ error: `This organisation has no ${invoice.currency} account to pay from.` });
      }

      // The supplier as a contact. Match on the IBAN or the wallet address
      // only: the same destination under a renamed company is the same payee.
      // Don't match by name: the name is the supplier's own claim, and
      // attaching their destination to a trusted contact of that name is
      // classic invoice fraud. An unknown destination gets a new contact,
      // which the reviewer sees as new.
      const contacts = await store.contactsOf(ctx.org.id);
      const supplierName = invoice.supplier?.orgName?.trim() || (payee.kind === "bank" ? payee.holderName : "");
      const now = new Date().toISOString();
      const newContact = (dest: { wallets: Contact["wallets"]; bankAccounts: Contact["bankAccounts"] }) => store.addContact({
        id: `con_${randomUUID()}`,
        orgId: ctx.org.id,
        name: supplierName,
        email: invoice.supplier?.email,
        ...dest,
        notes: `Added from invoice ${invoice.supplier?.invoiceNumber ?? invoice.id}`,
        createdAt: now,
        updatedAt: now,
      });
      let contact: Contact;
      let destination: Record<string, unknown>;
      if (payee.kind === "wallet") {
        const same = (w: Contact["wallets"][number]) => w.chainId === payee.chainId && w.address.toLowerCase() === payee.address.toLowerCase();
        const known = contacts.find((c) => c.wallets.some(same));
        contact = known ?? (await newContact({ wallets: [{ id: `cw_${randomUUID()}`, chainId: payee.chainId, address: payee.address, label: "invoice" }], bankAccounts: [] }));
        // The name the address book has: on a matched contact the supplier's own is only their claim.
        destination = { kind: "wallet", chainId: payee.chainId, address: payee.address, displayName: known?.name ?? supplierName };
      } else {
        const iban = normaliseIban(payee.iban);
        const has = (b: Contact["bankAccounts"][number]) => !!b.iban && normaliseIban(b.iban) === iban;
        const known = contacts.find((c) => c.bankAccounts.some(has));
        let bankAccount = known?.bankAccounts.find(has);
        if (!known || !bankAccount) {
          bankAccount = {
            id: `cb_${randomUUID()}`,
            ...validateBankAccount({
              currency: invoice.currency,
              country: iban.slice(0, 2),
              holderName: payee.holderName,
              iban,
              bic: payee.bic,
            }),
          };
          contact = await newContact({ wallets: [], bankAccounts: [bankAccount] });
        } else contact = known;
        // The holder the address book has for this account: on a matched
        // contact the supplier's own spelling is only their claim.
        destination = { kind: "bank", bankAccountId: bankAccount.id, displayName: bankAccount.holderName ?? payee.holderName };
      }
      let line;
      try {
        line = {
          id: `dl_${randomUUID()}`,
          ...validateLine(
            {
              contactId: contact.id,
              invoiceId: invoice.id,
              destination,
              asset: payee.kind === "wallet" ? payee.asset : invoice.currency,
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
      // SUBMITTED to PAYING and the draft, as one write: a second /pay finds
      // the invoice PAYING and gets no second draft.
      const started = await store.startInvoicePayment(invoice.id, ["SUBMITTED"], {
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
      if (!started) return res.status(409).json({ error: "A payment for this invoice is already under way." });
      const { invoice: updated, draft } = started;
      res.status(201).json({
        invoice: ownerInvoiceView(updated),
        draft,
        contact,
        note: paymentReviewRequired(ctx.org)
          ? "A draft was created. A second person reviews it, then the account holder signs it."
          : "A draft was created. The account holder signs it to send.",
      });
    });
  });

  /**
   * Tie the caller's own payment to a filled-in send link. The payment was
   * made on the app's send screens; this only records which one pays the link,
   * after checking it is the caller's, goes to the payee's destination and is
   * the amount the payee asked for. From then on the link follows the payment
   * (syncInvoicePayment), so it reads PAID only once the money has moved.
   */
  r.post("/:orgId/invoices/:invoiceId/paying", async (req, res) => {
    return store.tx(async () => {
      const ctx = await ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "invoices")) return;
      if (!requirePermission(ctx, res, "invoices.manage")) return;
      const found = await store.findInvoice(String(req.params.invoiceId));
      if (!found || found.orgId !== ctx.org.id || !found.sendLink) return res.status(404).json({ error: "no such send link" });
      // The link's maker pays it: another member's payment could hold it in PAYING.
      if (found.createdByMemberId !== ctx.member.id) return res.status(403).json({ error: "Only the person who made this link can pay it." });
      const invoice = await syncInvoicePayment(found);
      if (invoice.state !== "SUBMITTED") {
        return res.status(409).json({ error: invoice.state === "LINK_CREATED" ? "Nobody has filled this link in yet." : "This link is already being paid or is paid." });
      }
      const transferId = typeof req.body?.transferId === "string" ? req.body.transferId : undefined;
      const cryptoSendId = typeof req.body?.cryptoSendId === "string" ? req.body.cryptoSendId : undefined;
      if (!transferId === !cryptoSendId) return res.status(400).json({ error: "Name one payment: transferId or cryptoSendId." });
      // The payment is the caller's: their row held, two links cannot both
      // find it free (a link in another org is not under this org's lock).
      await store.lockUser(ctx.userId);
      const taken = (await store.list("invoices")).some((i) => i.id !== invoice.id && ((transferId && i.payment?.transferId === transferId) || (cryptoSendId && i.payment?.cryptoSendId === cryptoSendId)));
      if (taken) return res.status(409).json({ error: "That payment already pays another link." });
      const owed = centsOf(invoice.total);
      const payTo = invoice.payTo;

      if (transferId) {
        const t = await store.findTransfer(transferId);
        if (!t || t.userId !== ctx.userId) return res.status(404).json({ error: "no such payment" });
        if (payTo?.kind !== "bank" || !t.recipientIban || normaliseIban(t.recipientIban) !== normaliseIban(payTo.bank?.iban ?? "")) {
          return res.status(409).json({ error: "That payment goes to a different account than the one on the link." });
        }
        // What arrives, not what is debited: a SEPA fee comes out of the debit.
        if (Math.abs((t.receiveEur ?? 0) * 100 - owed) > 1e-6) return res.status(409).json({ error: `That payment is not the €${invoice.total} the link asks for.` });
        if (t.state === "FAILED" || t.state === "REFUNDED" || expiredUnsigned(t)) return res.status(409).json({ error: "That payment did not go through.", code: "PAYMENT_DEAD" });
        if (t.createdAt < invoice.submittedAt!) return res.status(409).json({ error: "That payment was made before the link was filled in." });
      } else {
        const found = await store.findCryptoSend(cryptoSendId!);
        const s = found && (await liveCryptoSend(found));
        if (!s || s.userId !== ctx.userId || (s.orgId && s.orgId !== ctx.org.id)) return res.status(404).json({ error: "no such payment" });
        if (payTo?.kind !== "wallet" || !payTo.address || s.to.toLowerCase() !== payTo.address.toLowerCase()) {
          return res.status(409).json({ error: "That payment goes to a different wallet than the one on the link." });
        }
        // Whole cents only: "11.454" would round onto the link's €11.45.
        if (s.token !== "EURE" || !/^\d+(\.\d{1,2}0*)?$/.test(s.amount) || centsOf(s.amount) !== owed) {
          return res.status(409).json({ error: `That payment is not the €${invoice.total} in EURe the link asks for.` });
        }
        // An unsigned send may be one whose /authorize answer was lost; it ties
        // until its deadline, and syncInvoicePayment frees the link after that.
        if (s.state === "FAILED" || (s.state === "CREATED" && s.deadline * 1000 < Date.now())) {
          return res.status(409).json({ error: "That payment was not sent.", code: "PAYMENT_DEAD" });
        }
        if (s.createdAt < invoice.submittedAt!) return res.status(409).json({ error: "That payment was made before the link was filled in." });
      }
      const updated = await store.updateInvoiceFrom(invoice.id, ["SUBMITTED"], {
        state: "PAYING",
        payment: { ...invoice.payment, ...(transferId ? { transferId } : { cryptoSendId }) },
      });
      if (!updated) return res.status(409).json({ error: "This link is already being paid or is paid." });
      res.json({ invoice: ownerInvoiceView(await syncInvoicePayment(updated)) });
    });
  });

  /** Mark an invoice settled outside the platform (manual reconciliation). */
  r.post("/:orgId/invoices/:invoiceId/reconcile", async (req, res) => {
    return store.tx(async () => {
      const ctx = await ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "invoices")) return;
      if (!requirePermission(ctx, res, "invoices.manage")) return;
      const invoice = await store.findInvoice(String(req.params.invoiceId));
      if (!invoice || invoice.orgId !== ctx.org.id) {
        return res.status(404).json({ error: "no such invoice" });
      }
      try {
        assertInvoiceTransition(invoice.state, "RECONCILED");
        // From the state checked: a payment or settlement landing meanwhile wins.
        const reconciled = await store.updateInvoiceFrom(invoice.id, [invoice.state], {
          state: "RECONCILED",
          payment: {
            ...invoice.payment,
            manual: {
              byMemberId: ctx.member.id,
              at: new Date().toISOString(),
              note: typeof req.body?.note === "string" ? req.body.note : undefined,
            },
          },
        });
        if (!reconciled) return res.status(409).json({ error: "This invoice changed meanwhile. Reload it." });
        // Settled elsewhere: its payment link must not take the money a second time.
        const link = await openLinkFor(reconciled);
        if (link) await store.cancelUnpaidPaymentRequest(link.id, new Date(), true);
        res.json({ invoice: ownerInvoiceView(reconciled) });
      } catch (err) {
        if (err instanceof InvoiceError) return res.status(409).json({ error: err.message });
        throw err;
      }
    });
  });

  // ── Invoicing profile (§14 UStG identity, prefilled onto every invoice) ───

  /**
   * What the issuer looks like on paper, plus the reference data the editor
   * needs: the VAT rates, the exemption reasons with their statutes, and the
   * optional blocks that may be switched off. Mandatory §14 fields are not in
   * the display map, so settings cannot produce an invalid invoice (which
   * would cost the customer their input-tax deduction).
   */

  return r;
}
