/**
 * Issuing invoices: the org's issuer profile, the compliance check, and the
 * document itself.
 *
 * Not tax advice; the app says so on every screen that touches this. The code
 * guarantees only that a document has every mandatory field and shows no tax
 * the issuer does not owe.
 *
 * The rule set comes from the issuer's country. German paragraphs are quoted
 * only under DE, the VAT Directive article under EU, and nothing under GENERIC
 * ("§ 14 Abs. 4 UStG" is wrong for an Indian entity). Every report carries its
 * verification level so `ok` claims no more coverage than we have.
 */
import express from "express";
import { store } from "../../store.js";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SERIES,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  SETTLEMENT_CURRENCY,
  checkCompliance,
  invoiceDueDate,
  invoiceLanguage,
  normaliseVatId,
  reasonForRuleSet,
  taxNumberLooksValid,
  vatIdLooksValid,
  } from "../../domain/invoicing.js";
import { EU_MEMBER_STATES, validateCustomReason } from "../../domain/jurisdictions.js";
import { VAT_ID_FORMATS, vatIdShape } from "../../domain/vat-ids.js";
import { cachedVatCheck, checkVatId } from "../../adapters/vies.js";
import { ibanChecksumValid, normaliseIban } from "../../domain/contacts.js";
import type { Organisation } from "../../domain/types.js";
import { issueOutgoing } from "./issue-outgoing.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { verifyPasskeyStepUp } from "../auth.js";
import { wrap } from "../util.js";
import { auditEntry } from "../../audit.js";
import {
  accountBankOf, customReasonsOf, draftDueDate, draftFrom, invoiceBankOf, issuerParty, issuerSuggestions,
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
      // Prefill: who the issuer is, straight off the organisation, and what
      // else Zold knows that the form can offer.
      issuer: issuerParty(ctx.org),
      suggested: issuerSuggestions(ctx.org, ctx.userId),
      // What invoices print (`profile.bank` when it names an IBAN, else the
      // account's), and the account's own, which is the one payments match on.
      invoiceBank: invoiceBankOf(ctx.org),
      accountBank: accountBankOf(ctx.org),
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
        // Per-country VAT ID shapes, so the form checks a number as it is typed.
        vatIdFormats: VAT_ID_FORMATS,
      },
      disclaimer: jur.disclaimer,
      notVerified: jur.notVerified,
    });
  });

  /**
   * Everything an invoice prints. The payout IBAN is where customers send the
   * money, so changing it takes an owner or admin and a fresh passkey
   * approval, and is audited with the old and new last four characters. The
   * rest of the profile needs only invoices.manage.
   */
  r.patch("/:orgId/invoicing/profile", wrap(async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    const b = req.body ?? {};
    const next = { ...(ctx.org.invoicing ?? {}) } as NonNullable<Organisation["invoicing"]>;
    let ibanChange: { oldLast4: string | null; newLast4: string | null } | undefined;

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
      const was = ctx.org.invoicing?.bank?.iban;
      if ((iban || undefined) !== was) {
        if (!requirePermission(ctx, res, "org.update")) return;
        const user = store.findUser(ctx.userId);
        if (!user) return res.status(401).json({ error: "no such user" });
        if (!(await verifyPasskeyStepUp(user, b, res, "org.invoice-iban.change"))) return;
        ibanChange = { oldLast4: was ? was.slice(-4) : null, newLast4: iban ? iban.slice(-4) : null };
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
    if (ibanChange) {
      store.audit(auditEntry("org.invoice_iban_changed", { orgId: org.id, memberId: ctx.member.id, ...ibanChange }, ctx.userId));
    }
    res.json({ profile: org.invoicing, issuer: issuerParty(org) });
  }));

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
      // What VIES already said about this number; this route runs on every
      // keystroke and never asks VIES itself (POST …/vat-check does).
      const known = draft.recipient.vatId ? cachedVatCheck(draft.recipient.vatId) : undefined;
      if (known) draft.recipientVatCheck = known;
      const language = invoiceLanguage(req.body?.language, ctx.org.invoicing?.language);
      const dueDate = invoiceDueDate(req.body?.dueDate, draft.issueDate!, draftDueDate(ctx.org, draft.issueDate!));
      const report = checkCompliance(draft, jurisdictionOf(ctx.org), customReasonsOf(ctx.org));
      res.json({
        ...report,
        preview: {
          number: draft.number,
          language,
          ...(dueDate ? { dueDate } : {}),
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
   * Look a customer's VAT ID up in VIES. Called when the field is left, not
   * per keystroke; the answer is kept a day (adapters/vies.ts), so the live
   * check and the issue reuse it. The org's own VAT ID goes along as the
   * requester, which makes VIES return a consultation number.
   */
  r.post("/:orgId/invoicing/vat-check", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    const raw = typeof req.body?.vatId === "string" ? req.body.vatId.slice(0, 40) : "";
    if (!raw.trim()) return res.status(400).json({ error: "vatId is required." });
    const shape = vatIdShape(raw);
    if (!shape.ok) return res.status(200).json({ shape, check: null });
    const check = await checkVatId(raw, ctx.org.invoicing?.vatId);
    res.json({ shape, check });
  });

  /** Issue an outgoing invoice (issue-outgoing.ts). */
  r.post("/:orgId/invoicing/issue", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    const answer = await issueOutgoing(ctx, req.body ?? {});
    res.status(answer.status).json(answer.body);
  });

  // ── Chart of accounts ─────────────────────────────────────────────────────

  return r;
}
