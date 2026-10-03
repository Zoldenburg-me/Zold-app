/**
 * Invoices made from wallet receipts: the payer rule on a contact, the
 * monthly run that collects a payer's receipts into a draft, and issuing a
 * draft.
 *
 * The run only ever writes drafts. Issuing one is a separate call by a
 * member who may issue invoices, and goes through the same compliance check
 * and numbering as an invoice typed into the editor (issue-outgoing.ts). The
 * lines of a draft come from the ledger, never from the request.
 *
 * The tax line is the organisation's choice, stored on the rule and applied
 * as given. Nothing here decides how a payment from a DAO is taxed.
 */
import express from "express";
import { store } from "../../store.js";
import {
  IncomeInvoiceError,
  assertCollectableMonth,
  changedReceipts,
  dayOf,
  monthOf,
  monthPeriod,
  planIncomeDrafts,
  type IncomePlan,
} from "../../domain/income-invoices.js";
import { ContactError, validateWallet } from "../../domain/contacts.js";
import { InvoiceComplianceError } from "../../domain/invoicing.js";
import { newLinkToken, ownerInvoiceView } from "../../domain/invoices.js";
import type { ContactWallet, Invoice, Organisation, PayerRule } from "../../domain/types.js";
import { randomUUID } from "node:crypto";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import { issueOutgoing } from "./issue-outgoing.js";
import { draftFrom, str } from "./shared.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

/** Short enough that a line (description, amount, token, date, value and
 *  transaction hash) stays under the 500 characters an invoice line allows. */
const SERVICE_DESCRIPTION_MAX = 200;
const NOTES_MAX = 1000;
const RECIPIENT_FIELD_MAX = 200;
const PAYER_WALLETS_MAX = 50;

class PayerRuleError extends Error {}

/**
 * A payer rule from the request, or a refusal naming what is missing.
 *
 * The tax line and the recipient go through `draftFrom`, the same reading an
 * issued invoice gets, so a rule cannot hold a treatment the issue would
 * refuse. Unlike the editor, nothing is defaulted: a rule with no tax line,
 * a rate left blank or an exemption with no reason is refused, because a
 * default here would be Zold choosing the tax treatment.
 */
function payerRuleFrom(org: Organisation, raw: unknown, memberId: string, now: string): PayerRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PayerRuleError("A payer rule is an object.");
  const body = raw as Record<string, any>;
  const serviceDescription = str(body.serviceDescription) ?? "";
  if (!serviceDescription) throw new PayerRuleError("Say what is being invoiced: the service description.");
  if (serviceDescription.length > SERVICE_DESCRIPTION_MAX) {
    throw new PayerRuleError(`The service description is limited to ${SERVICE_DESCRIPTION_MAX} characters.`);
  }
  const vat = body.vat;
  if (!vat || typeof vat !== "object" || (vat.kind !== "standard" && vat.kind !== "exempt")) {
    throw new PayerRuleError("Choose the tax line: a VAT rate, or an exemption with its reason. Zold does not choose one.");
  }
  if (vat.kind === "standard" && typeof vat.rate !== "number") {
    throw new PayerRuleError("A tax line with VAT needs the rate, as a number.");
  }
  if (vat.kind === "exempt" && !str(vat.reason)) {
    throw new PayerRuleError("A tax line without VAT needs the reason.");
  }
  if (!body.recipient || typeof body.recipient !== "object" || !str(body.recipient.name)) {
    throw new PayerRuleError("Say who the invoice is addressed to: the recipient's name.");
  }
  for (const field of ["name", "addressLine", "postalCode", "city", "country", "vatId", "email"]) {
    const value: unknown = body.recipient[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > RECIPIENT_FIELD_MAX)) {
      throw new PayerRuleError(`The recipient's ${field} is text of at most ${RECIPIENT_FIELD_MAX} characters.`);
    }
  }
  if (body.language !== undefined && body.language !== "de" && body.language !== "en") {
    throw new PayerRuleError('Invoices are written in German ("de") or English ("en").');
  }
  const notes = str(body.notes);
  if (notes && notes.length > NOTES_MAX) throw new PayerRuleError(`Notes are limited to ${NOTES_MAX} characters.`);

  const read = draftFrom(org, { vat, recipient: body.recipient, supplyKind: body.supplyKind, lines: [] });
  return {
    serviceDescription,
    vat: read.treatment,
    recipient: read.recipient,
    ...(read.recipientIsBusiness === undefined ? {} : { recipientIsBusiness: read.recipientIsBusiness }),
    ...(read.supplyKind ? { supplyKind: read.supplyKind } : {}),
    ...(body.language ? { language: body.language } : {}),
    ...(notes ? { notes } : {}),
    updatedAt: now,
    updatedByMemberId: memberId,
  };
}

/** The addresses the payer sends from, when the rule is saved with them.
 *  A wallet the contact already has keeps its id. */
function payerWalletsFrom(raw: unknown, existing: ContactWallet[]): ContactWallet[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > PAYER_WALLETS_MAX) {
    throw new PayerRuleError(`wallets is a list of at most ${PAYER_WALLETS_MAX} addresses.`);
  }
  return raw.map((w) => {
    const wallet = validateWallet(w);
    const known = existing.find((x) => x.chainId === wallet.chainId && x.address.toLowerCase() === wallet.address);
    return known ?? { id: `cw_${randomUUID()}`, ...wallet };
  });
}

/**
 * What the imported wallets' sync state leaves uncertain about a month. A
 * draft made while a wallet is behind bills only what the ledger holds, so
 * the person issuing it is told, on the draft, what may be missing.
 */
function syncWarningsFor(ctx: OrgContext, month: string, now: string): string[] {
  const timeZone = ctx.org.reporting.timeZone;
  const monthIsOver = month < monthOf(now, timeZone);
  const firstDay = monthPeriod(month).from;
  return store.importedWalletsOf(ctx.org.id).flatMap((w) => {
    const name = w.label || `${w.address.slice(0, 8)}…`;
    const bookedFrom = w.sync.from ?? dayOf(w.createdAt, timeZone);
    return [
      ...(w.sync.status !== "synced" ? [`${name} is not synced (${w.sync.status}).`] : []),
      ...(w.sync.status === "synced" && monthIsOver && (!w.sync.lastSyncedAt || monthOf(w.sync.lastSyncedAt, timeZone) <= month)
        ? [`${name} was last synced before the month ended.`]
        : []),
      ...(bookedFrom > firstDay
        ? [`${name} is booked from ${bookedFrom}; earlier transfers of the month are not in the ledger.`]
        : []),
      ...(w.sync.skipped ? [`${w.sync.skipped} transfer${w.sync.skipped === 1 ? "" : "s"} of ${name} could not be read and ${w.sync.skipped === 1 ? "is" : "are"} in no ledger row.`] : []),
    ];
  });
}

/** Plan a month from what the store holds now. Each draft carries what the
 *  wallets' sync state leaves uncertain about the month. */
function planFor(ctx: OrgContext, month: string, now: string): IncomePlan & { syncWarnings: string[] } {
  const syncWarnings = syncWarningsFor(ctx, month, now);
  const plan = planFrom(ctx, month, now);
  return {
    ...plan,
    drafts: plan.drafts.map((d) => ({ ...d, fromReceipts: { ...d.fromReceipts!, syncWarnings } })),
    syncWarnings,
  };
}

function planFrom(ctx: OrgContext, month: string, now: string): IncomePlan {
  return planIncomeDrafts({
    orgId: ctx.org.id,
    timeZone: ctx.org.reporting.timeZone,
    month,
    contacts: store.contactsOf(ctx.org.id),
    ledger: store.ledgerOf(ctx.org.id),
    invoices: store.invoicesOf(ctx.org.id),
    now,
    memberId: ctx.member.id,
    newLinkTokenHash: () => newLinkToken().hash,
  });
}

/** An id held by anything but this organisation's own draft is a bug in the
 *  plan, and writing over it would rewrite an issued invoice. */
function assertWritable(draft: Invoice): void {
  const existing = store.findInvoice(draft.id);
  if (existing && (existing.orgId !== draft.orgId || existing.state !== "DRAFT")) {
    throw new Error(`income draft ${draft.id} collides with an invoice in ${existing.state}`);
  }
}

/** Add new drafts and replace those that are still drafts. All are checked
 *  before the first is written, so a refusal leaves none half done. */
function writeDrafts(drafts: Invoice[]): Invoice[] {
  drafts.forEach(assertWritable);
  return drafts.map((draft) => (store.findInvoice(draft.id) ? store.updateInvoice(draft.id, draft) : store.addInvoice(draft)));
}

/** The issue request for a draft: the rule's template, the draft's lines. */
function issueBodyFor(draft: Invoice, month: string, rule: PayerRule, requested: Record<string, unknown>): Record<string, unknown> {
  return {
    recipient: { ...rule.recipient, isBusiness: rule.recipientIsBusiness },
    vat: rule.vat,
    supplyKind: rule.supplyKind,
    supplyPeriod: monthPeriod(month),
    language: requested.language ?? rule.language,
    notes: rule.notes,
    lines: draft.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceNet: l.unitPrice })),
    ...(typeof requested.number === "string" ? { number: requested.number } : {}),
    acceptWarnings: requested.acceptWarnings === true,
  };
}

export function createIncomeInvoiceRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  const contactOf = (ctx: OrgContext, req: express.Request) => {
    const contact = store.findContact(String(req.params.contactId));
    return contact && contact.orgId === ctx.org.id ? contact : undefined;
  };

  r.put("/:orgId/contacts/:contactId/payer-rule", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const contact = contactOf(ctx, req);
    if (!contact) return res.status(404).json({ error: "no such contact" });
    try {
      const payerRule = payerRuleFrom(ctx.org, req.body, ctx.member.id, new Date().toISOString());
      // The rule and the addresses it reads are saved together or not at all.
      const wallets = payerWalletsFrom(req.body?.wallets, contact.wallets);
      res.json({ contact: store.updateContact(contact.id, { payerRule, ...(wallets ? { wallets } : {}) }) });
    } catch (err) {
      if (err instanceof PayerRuleError || err instanceof InvoiceComplianceError || err instanceof ContactError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  /** Stop invoicing a contact's receipts. Its drafts and invoices stay. */
  r.delete("/:orgId/contacts/:contactId/payer-rule", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const contact = contactOf(ctx, req);
    if (!contact) return res.status(404).json({ error: "no such contact" });
    res.json({ contact: store.updateContact(contact.id, { payerRule: undefined }) });
  });

  /**
   * Collect one month's receipts into drafts, one per contact with a payer
   * rule. Running it again rebuilds the drafts that are still drafts and
   * touches nothing that was issued. The answer accounts for every valued
   * receipt of the month that is on no draft.
   */
  r.post("/:orgId/income-invoices/run", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    try {
      const now = new Date().toISOString();
      const month: unknown = req.body?.month;
      assertCollectableMonth(month, ctx.org.reporting.timeZone, now);
      // Read and write with nothing awaited between: two runs cannot both
      // claim a row.
      const { plan, written } = store.batched(() => {
        const plan = planFor(ctx, month, now);
        return { plan, written: writeDrafts(plan.drafts) };
      });
      res.json({
        month,
        timeZone: ctx.org.reporting.timeZone,
        contacts: plan.contacts,
        withoutRule: plan.withoutRule,
        withoutContact: plan.withoutContact,
        alreadyInvoiced: plan.alreadyInvoiced,
        onOtherDrafts: plan.onOtherDrafts,
        syncWarnings: plan.syncWarnings,
        invoices: written.map(ownerInvoiceView),
      });
    } catch (err) {
      if (err instanceof IncomeInvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  /**
   * Issue a draft made from receipts.
   *
   * The draft is first rebuilt from the ledger as it stands. If the rows it
   * bills, or their amounts, are not the ones the stored draft showed, the
   * stored draft is replaced and the call refuses, naming the rows: a person
   * issues what they looked at, not what changed underneath.
   */
  r.post("/:orgId/income-invoices/:invoiceId/issue", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;
    const stored = store.findInvoice(String(req.params.invoiceId));
    if (!stored || stored.orgId !== ctx.org.id || !stored.fromReceipts || stored.state === "DELETED") {
      return res.status(404).json({ error: "no such draft" });
    }
    if (stored.state !== "DRAFT") {
      return res.status(409).json({ error: `This invoice has already been issued${stored.issued ? ` as ${stored.issued.number}` : ""}.` });
    }
    const contact = store.findContact(stored.fromReceipts.contactId);
    const rule = contact?.orgId === ctx.org.id ? contact.payerRule : undefined;
    if (!rule) {
      return res.status(409).json({
        error: "The contact this draft was made for has no payer rule any more, so there is no tax line or recipient to issue it with. Nothing was issued.",
      });
    }

    let fresh: Invoice | undefined;
    try {
      fresh = planFor(ctx, stored.fromReceipts.month, new Date().toISOString()).drafts.find((d) => d.id === stored.id);
    } catch (err) {
      if (err instanceof IncomeInvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
    if (!fresh) throw new Error(`income draft ${stored.id} is missing from its own month's plan`);
    const changed = changedReceipts(stored, fresh);
    const ruleChanged = stored.fromReceipts.ruleUpdatedAt !== rule.updatedAt;
    const transactions = changed.map((id) =>
      [...stored.lines, ...fresh.lines].find((l) => l.receipt?.ledgerEntryId === id)?.receipt?.txHash.slice(0, 12) ?? id,
    );
    const [current] = writeDrafts([fresh]);
    if (changed.length || ruleChanged) {
      return res.status(409).json({
        error:
          (changed.length
            ? `The receipts behind this draft changed since it was collected (transaction${changed.length === 1 ? "" : "s"} ${transactions.join(", ")}…). `
            : "The payer rule was changed since this draft was collected. ") +
          "The draft has been updated and nothing was issued; look at it again.",
        changed,
        invoice: ownerInvoiceView(current),
      });
    }
    if (!current.lines.length) {
      return res.status(422).json({ error: "This draft has no receipts on it, so there is nothing to invoice." });
    }
    if (current.fromReceipts?.mismatchCents) {
      return res.status(422).json({
        error: `At the rule's VAT rate no net amount plus VAT equals the ${current.total} EUR received, so the invoice would differ from the money. It has not been issued.`,
        mismatchCents: current.fromReceipts.mismatchCents,
      });
    }

    // A month the wallets may not have delivered in full is issued only by
    // someone who has been told so, the way a compliance warning is accepted.
    const incomplete = current.fromReceipts?.syncWarnings ?? [];
    if (incomplete.length && req.body?.acceptWarnings !== true) {
      return res.status(409).json({
        error: "This month may be incomplete. Re-send with acceptWarnings: true to issue it anyway.",
        warnings: incomplete.map((message) => ({ severity: "warning", field: "receipts", message })),
      });
    }

    const answer = await issueOutgoing(ctx, issueBodyFor(current, stored.fromReceipts.month, rule, req.body ?? {}), current);
    res.status(answer.status).json(answer.body);
  }));

  return r;
}
