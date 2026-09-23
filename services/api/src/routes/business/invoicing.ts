/**
 * Issuing invoices: the org's issuer profile, the compliance check, and the
 * document itself.
 *
 * NOT TAX ADVICE, and the app says so on every screen that touches this. What
 * the code guarantees is narrower: it cannot produce a document missing a
 * mandatory field, and cannot show tax the issuer does not owe.
 *
 * THE RULE SET COMES FROM THE ISSUER'S COUNTRY, not the customer's. German
 * paragraphs are quoted only under DE, the VAT Directive article under EU, and
 * nothing under GENERIC — citing "§ 14 Abs. 4 UStG" at an Indian entity would
 * be confidently wrong. Every report carries its verification level so `ok`
 * never claims more coverage than we have.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../../store.js";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SERIES,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  checkCompliance,
  fromCents,
  normaliseVatId,
  reasonForRuleSet,
  taxNumberLooksValid,
  vatIdLooksValid,
  vatNoteFor,
  } from "../../domain/invoicing.js";
import { EU_MEMBER_STATES, validateCustomReason } from "../../domain/jurisdictions.js";
import { newLinkToken } from "../../domain/invoices.js";
import { ibanChecksumValid, normaliseIban } from "../../domain/contacts.js";
import type { Organisation } from "../../domain/types.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import {
  customReasonsOf, draftDueDate, draftFrom, issuerParty,
  jurisdictionOf, str, withConversion, } from "./shared.js";

/** Resolving the org and the caller's role for a request — injected so this
 *  module cannot acquire its own way of deciding who is calling. */
export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

export function createInvoicingRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/invoicing/profile", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;

    const inv = ctx.org.invoicing ?? {};
    const jur = jurisdictionOf(ctx.org);
    const custom = customReasonsOf(ctx.org);
    res.json({
      profile: {
        ...inv,
        display: { ...DEFAULT_DISPLAY, ...(inv.display ?? {}) },
        numberSeries: inv.numberSeries ?? DEFAULT_SERIES,
        customReasons: custom,
      },
      // Prefill: who the issuer is, straight off the organisation.
      issuer: issuerParty(ctx.org),
      jurisdiction: jur,
      reference: {
        // Only the reasons this jurisdiction actually offers. A Swedish entity
        // must not be shown "§ 19 UStG Kleinunternehmerregelung".
        exemptionReasons: jur.reasons
          .map((id) => EXEMPTION_REASONS[id as keyof typeof EXEMPTION_REASONS])
          .filter(Boolean)
          // Labels and citations follow the rule set, not the author's country.
          .map((r) => reasonForRuleSet(r, jur.ruleSet)),
        customReasons: custom,
        // Germany is the only place we assert which rates are legal.
        vatRates: jur.ruleSet === "DE" ? [19, 7] : null,
        displayOptions: Object.keys(DEFAULT_DISPLAY),
        simplifiedLimitCents: jur.simplifiedLimitCents ?? null,
        euMemberStates: EU_MEMBER_STATES,
      },
      disclaimer: jur.disclaimer,
      notVerified: jur.notVerified,
    });
  });

  r.patch("/:orgId/invoicing/profile", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    const b = req.body ?? {};
    const next = { ...(ctx.org.invoicing ?? {}) } as NonNullable<Organisation["invoicing"]>;

    if (typeof b.vatId === "string") {
      const v = normaliseVatId(b.vatId);
      if (v && !vatIdLooksValid(v)) {
        return res.status(400).json({
          error: `${b.vatId} does not look like a VAT ID. A German one is DE followed by nine digits.`,
          field: "vatId",
        });
      }
      next.vatId = v || undefined;
    }
    if (typeof b.taxNumber === "string") {
      const t = b.taxNumber.trim();
      if (t && !taxNumberLooksValid(t)) {
        return res.status(400).json({
          error: `${t} does not look like a Steuernummer (10 to 13 digits).`,
          field: "taxNumber",
        });
      }
      next.taxNumber = t || undefined;
    }
    if (typeof b.smallBusiness === "boolean") next.smallBusiness = b.smallBusiness;
    if (b.defaultVatRate !== undefined) {
      // Any plausible percentage: 19 is German, 23 Polish, 25 Swedish. WHICH
      // rates are legal is checked per jurisdiction at issue, not here.
      const rate = Number(b.defaultVatRate);
      if (b.defaultVatRate === null || b.defaultVatRate === "") next.defaultVatRate = undefined;
      else if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res
          .status(400)
          .json({ error: `${b.defaultVatRate} is not a VAT percentage.`, field: "defaultVatRate" });
      } else next.defaultVatRate = rate;
    }
    for (const k of ["registerCourt", "registerNumber", "managingDirector", "paymentTermsNote", "footerNote"] as const) {
      if (typeof b[k] === "string") next[k] = b[k].trim() || undefined;
    }
    if (typeof b.paymentTermsDays === "number" && b.paymentTermsDays >= 0) {
      next.paymentTermsDays = Math.round(b.paymentTermsDays);
    }
    if (b.language === "de" || b.language === "en") next.language = b.language;
    if (b.bank && typeof b.bank === "object") {
      const iban = typeof b.bank.iban === "string" ? normaliseIban(b.bank.iban) : undefined;
      if (iban && !ibanChecksumValid(iban)) {
        return res.status(400).json({ error: `${iban} is not a valid IBAN.`, field: "bank.iban" });
      }
      const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      next.bank = {
        holder: text(b.bank.holder) || undefined,
        iban: iban || undefined,
        bic: text(b.bank.bic).toUpperCase().replace(/\s+/g, "") || undefined,
        bankName: text(b.bank.bankName) || undefined,
      };
    }
    if (b.numberSeries && typeof b.numberSeries === "object") {
      const prefix = String(b.numberSeries.prefix ?? DEFAULT_SERIES.prefix);
      const nextNo = Number(b.numberSeries.next ?? DEFAULT_SERIES.next);
      if (!Number.isInteger(nextNo) || nextNo < 1) {
        return res.status(400).json({ error: "The next invoice number must be a positive integer." });
      }
      next.numberSeries = {
        prefix,
        next: nextNo,
        padding: Math.min(10, Math.max(1, Number(b.numberSeries.padding ?? DEFAULT_SERIES.padding))),
      };
    }
    if (b.display && typeof b.display === "object") {
      const display: Record<string, boolean> = { ...(next.display as Record<string, boolean> | undefined) };
      for (const key of Object.keys(DEFAULT_DISPLAY)) {
        if (typeof b.display[key] === "boolean") display[key] = b.display[key];
      }
      next.display = display;
    }
    if (Array.isArray(b.customReasons)) {
      try {
        next.customReasons = b.customReasons.slice(0, 20).map(validateCustomReason);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message, field: "customReasons" });
      }
    }
    if (Array.isArray(b.customFields)) {
      next.customFields = b.customFields
        .slice(0, 12)
        .map((f: Record<string, unknown>) => ({
          label: String(f.label ?? "").trim().slice(0, 60),
          value: String(f.value ?? "").trim().slice(0, 200),
        }))
        .filter((f: { label: string }) => f.label);
    }

    const org = store.updateOrganisation(ctx.org.id, { invoicing: next });
    res.json({ profile: org.invoicing, issuer: issuerParty(org) });
  });

  /**
   * Dry-run the compliance check without issuing anything.
   *
   * The editor calls this as the user types, so the missing-field list appears
   * while it can still be fixed rather than at the moment of issuing.
   */
  r.post("/:orgId/invoicing/check", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    try {
      // Converted here too, or the live panel would show a missing-euro-amount
      // error against every foreign-currency draft while it is being typed.
      const draft = await withConversion(draftFrom(ctx.org, req.body ?? {}));
      const report = checkCompliance(draft, jurisdictionOf(ctx.org), customReasonsOf(ctx.org));
      res.json({
        ...report,
        preview: {
          number: draft.number,
          totals: report.totals,
          currency: draft.currency ?? SETTLEMENT_CURRENCY,
          ...(draft.conversion ? { conversion: draft.conversion } : {}),
        },
      });
    } catch (err) {
      if (err instanceof InvoiceComplianceError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * Issue an outgoing invoice.
   *
   * Refuses on any compliance ERROR. Warnings can be accepted, but the
   * acceptance is recorded on the document — "we told you and you said yes" is
   * only meaningful if it is written down.
   */
  r.post("/:orgId/invoicing/issue", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    let draft;
    try {
      draft = await withConversion(draftFrom(ctx.org, req.body ?? {}));
    } catch (err) {
      if (err instanceof InvoiceComplianceError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    const report = checkCompliance(draft, jurisdictionOf(ctx.org), customReasonsOf(ctx.org));
    if (!report.ok) {
      return res.status(422).json({
        error: `This invoice is missing ${report.errors.length} thing(s) German law requires. It has not been issued.`,
        ...report,
      });
    }
    if (report.warnings.length && req.body?.acceptWarnings !== true) {
      return res.status(409).json({
        error: "There are warnings on this invoice. Re-send with acceptWarnings: true to issue it anyway.",
        ...report,
      });
    }

    const series = ctx.org.invoicing?.numberSeries ?? DEFAULT_SERIES;
    // §14 Abs. 4 Nr. 4: one number, once. A caller may supply its own number,
    // so uniqueness is checked against what this org has issued rather than
    // assumed from the series.
    if (store.invoicesOf(ctx.org.id).some((i) => i.issued?.number === draft.number)) {
      return res.status(409).json({ error: `Invoice number ${draft.number} has already been issued.` });
    }
    const numberSupplied = typeof req.body?.number === "string" && req.body.number.trim() !== "";
    const now = new Date();
    const { token, hash } = newLinkToken();
    const display: Record<string, boolean> = {
      ...DEFAULT_DISPLAY,
      ...(ctx.org.invoicing?.display as Record<string, boolean> | undefined),
    };

    const invoice = store.addInvoice({
      id: `inv_${randomUUID()}`,
      direction: "outgoing",
      orgId: ctx.org.id,
      linkTokenHash: hash,
      state: "SUBMITTED", // issued and locked; nothing for a supplier to fill in
      lines: report.totals.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPriceNet,
        amount: fromCents(l.netCents),
      })),
      currency: draft.currency ?? SETTLEMENT_CURRENCY,
      total: fromCents(report.totals.grossCents),
      dueDate: draftDueDate(ctx.org, draft.issueDate!),
      supplier: {
        orgName: draft.issuer.name ?? ctx.org.name,
        email: ctx.org.email ?? "",
        invoiceNumber: draft.number!,
      },
      issued: {
        number: draft.number!,
        issueDate: draft.issueDate!,
        supplyDate: draft.supplyDate,
        supplyPeriod: draft.supplyPeriod,
        issuer: draft.issuer,
        recipient: draft.recipient,
        vatTreatment: draft.treatment,
        vatNote: vatNoteFor(draft.treatment, ctx.org.invoicing?.language ?? "de"),
        netCents: report.totals.netCents,
        vatCents: report.totals.vatCents,
        grossCents: report.totals.grossCents,
        buckets: report.totals.buckets,
        // The document's own currency, and its settlement-currency restatement
        // at the rate that was live when it was issued. Frozen, never re-derived.
        currency: draft.currency ?? SETTLEMENT_CURRENCY,
        ...(draft.conversion ? { conversion: draft.conversion } : {}),
        purchaseOrder: str(req.body?.purchaseOrder),
        paymentTerms: str(req.body?.paymentTerms) ?? ctx.org.invoicing?.paymentTermsNote,
        notes: str(req.body?.notes),
        display,
        customFields: ctx.org.invoicing?.customFields,
        language: ctx.org.invoicing?.language ?? "de",
        acceptedWarnings: report.warnings.map((w) => `${w.field}: ${w.message}`),
        // Frozen with the document: which rules ran, and how far they went.
        jurisdiction: report.jurisdiction,
      },
      submittedAt: now.toISOString(),
      createdByMemberId: ctx.member.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // Burn the number only once the invoice exists: §14 Abs. 4 Nr. 4 wants each
    // number assigned once, and advancing before the write would leave a gap
    // pointing at an invoice that was never issued.
    if (!numberSupplied) {
      store.updateOrganisation(ctx.org.id, {
        invoicing: { ...(ctx.org.invoicing ?? {}), numberSeries: { ...series, next: series.next + 1 } },
      });
    }

    res.status(201).json({
      invoice: { ...invoice, linkTokenHash: undefined },
      linkToken: token,
      linkPath: `/invoice/${token}`,
      warnings: report.warnings,
    });
  });

  // ── Chart of accounts ─────────────────────────────────────────────────────

  return r;
}
