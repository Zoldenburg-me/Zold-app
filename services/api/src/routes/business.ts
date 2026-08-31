/**
 * /api/orgs/:orgId — the business surface: draft payments with approval,
 * invoices, chart of accounts, the ledger, reports and export.
 *
 * Plus the public, unauthenticated invoice-link endpoints, which are mounted
 * separately at /api/invoice-links because they are reached by a supplier who
 * has no account and no session.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "../store.js";
import {
  requireCapability,
  requirePermission,
  resolveOrg,
  type SessionResolver,
} from "./org-context.js";
import { can, limitsFor } from "../domain/plans.js";
import { FX } from "../config.js";
import { createQuote } from "../fx.js";
import { accountBalances } from "../chain.js";
import { CURRENCY_REGISTRY, accountIsSpendable } from "../domain/accounts.js";
import { canReviewDraft } from "../domain/roles.js";
import {
  CSV_MAX_BYTES,
  DraftError,
  activity,
  assertTransition,
  findDriftedLines,
  importCsv,
  isEditable,
  totalsByAsset,
  validateLine,
} from "../domain/drafts.js";
import {
  InvoiceError,
  assertDeletable,
  assertTransition as assertInvoiceTransition,
  hashToken,
  isOverdue,
  newLinkToken,
  supplierView,
  validateLines,
} from "../domain/invoices.js";
import { CoaError, applyRules, TX_TYPES, validateChartAccount } from "../domain/coa.js";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SERIES,
  EXEMPTION_REASONS,
  InvoiceComplianceError,
  checkCompliance,
  formatInvoiceNumber,
  fromCents,
  normaliseVatId,
  reasonForRuleSet,
  taxNumberLooksValid,
  vatIdLooksValid,
  vatNoteFor,
  type ExemptionReasonId,
  type InvoiceDraft,
  type VatTreatment,
} from "../domain/invoicing.js";
import { ibanChecksumValid, normaliseIban } from "../domain/contacts.js";
import {
  EU_MEMBER_STATES,
  jurisdictionFor,
  validateCustomReason,
  type CustomExemptionReason,
} from "../domain/jurisdictions.js";
import {
  LEDGER_EXPORT_COLUMNS,
  computeCostBasis,
  ledgerExportRows,
  monthlyBalances,
  positions,
  toCsv,
} from "../domain/ledger.js";
import type { DraftPayment, DraftState, Invoice, InvoiceParty, Organisation } from "../domain/types.js";


const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * The organisation as it must appear on an invoice it issues.
 *
 * This IS the prefill: §14 Abs. 4 Nr. 1 and 2 want the issuer's full name,
 * address and Steuernummer or USt-IdNr. on every invoice, so they are read off
 * the org rather than retyped per document. `legalName` wins over the trading
 * name, because the legal entity is what the tax office matches.
 */
function issuerParty(org: Organisation): InvoiceParty {
  return {
    name: org.legalName || org.name,
    addressLine: [org.address?.line1, org.address?.line2].filter(Boolean).join(", ") || undefined,
    postalCode: org.address?.postalCode,
    city: org.address?.city,
    country: org.address?.country,
    vatId: org.invoicing?.vatId,
    taxNumber: org.invoicing?.taxNumber,
    email: org.email,
  };
}

/**
 * Which rules apply to this organisation, from the country in its address.
 *
 * Resolved from the ENTITY's address rather than the customer's: an invoice is
 * governed by where the issuer is established, and a German company invoicing a
 * Swede still writes a German invoice.
 */
const jurisdictionOf = (org: Organisation) => jurisdictionFor(org.address?.country);

const customReasonsOf = (org: Organisation): CustomExemptionReason[] =>
  (org.invoicing?.customReasons ?? []) as CustomExemptionReason[];

/** Due date from the org's payment terms, so the field is not retyped either. */
function draftDueDate(org: Organisation, issueDate: string): string | undefined {
  const days = org.invoicing?.paymentTermsDays;
  if (!days && days !== 0) return undefined;
  const d = new Date(issueDate);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a draft from the request, filling the issuer from the organisation and
 * the VAT treatment from what the user chose.
 *
 * THE DEFAULT MATTERS: a Kleinunternehmer must never be handed a VAT rate by
 * default. Showing tax you do not owe makes you liable for it under §14c, and a
 * default is exactly where that would slip through unnoticed.
 */
function draftFrom(org: Organisation, body: Record<string, any>): InvoiceDraft {
  const inv = org.invoicing ?? {};
  const jur = jurisdictionFor(org.address?.country);
  const custom = customReasonsOf(org);
  const known = (id: string) =>
    jur.reasons.includes(id) || custom.some((c) => c.id === id);
  const wantsExempt =
    body.vat?.kind === "exempt" || (body.vat === undefined && inv.smallBusiness === true);

  let treatment: VatTreatment;
  if (wantsExempt) {
    // The small-business default is Germany's § 19 only where German rules
    // apply. Elsewhere the scheme exists but its citation and wording differ,
    // so the issuer picks it and supplies the note.
    const fallback = inv.smallBusiness
      ? jur.ruleSet === "DE"
        ? "kleinunternehmer"
        : jur.reasons.includes("small_business_national")
          ? "small_business_national"
          : undefined
      : undefined;
    const reason = (str(body.vat?.reason) ?? fallback) as string | undefined;
    if (!reason) {
      throw new InvoiceComplianceError(
        `Choosing not to charge VAT needs a reason. Available in ${jur.countryName}: ${jur.reasons.join(", ")}` +
          (custom.length ? `, plus your own: ${custom.map((c) => c.id).join(", ")}.` : "."),
      );
    }
    if (!known(reason)) {
      throw new InvoiceComplianceError(
        `"${reason}" is not available in ${jur.countryName}. Available: ${jur.reasons.join(", ")}` +
          (custom.length ? `, plus your own: ${custom.map((c) => c.id).join(", ")}.` : "."),
      );
    }
    const builtIn = EXEMPTION_REASONS[reason as ExemptionReasonId];
    if (builtIn?.requiresFreeText && !str(body.vat?.note)) {
      throw new InvoiceComplianceError(
        `"${builtIn.label}" has no wording we can supply — the note differs by country. ` +
          "Write the exemption and its legal basis; it has to appear on the invoice.",
      );
    }
    treatment = { kind: "exempt", reason, note: str(body.vat?.note) };
  } else {
    if (inv.smallBusiness) {
      throw new InvoiceComplianceError(
        jur.ruleSet === "DE"
          ? "This organisation is registered as a Kleinunternehmer (§ 19 UStG) and must not charge VAT. Turn that off in the invoicing profile first, or issue the invoice exempt."
          : "This organisation is registered under a small-business scheme and must not charge VAT. Turn that off in the invoicing profile first, or issue the invoice exempt.",
      );
    }
    // No default rate outside Germany: 19 is a German number, and quietly
    // applying it to a Polish or Swedish entity is exactly the wrongness this
    // jurisdiction split exists to remove.
    const raw = body.vat?.rate ?? inv.defaultVatRate ?? (jur.ruleSet === "DE" ? 19 : undefined);
    if (raw === undefined) {
      throw new InvoiceComplianceError(
        `Set the VAT rate you charge. Zold does not maintain a rate table for ${jur.countryName}, ` +
          "so it will not guess one.",
      );
    }
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      throw new InvoiceComplianceError(`${raw} is not a VAT percentage.`);
    }
    treatment = { kind: "standard", rate };
  }

  const issueDate = str(body.issueDate) ?? new Date().toISOString().slice(0, 10);
  const series = inv.numberSeries ?? DEFAULT_SERIES;

  const recipient: InvoiceParty = {
    name: str(body.recipient?.name),
    addressLine: str(body.recipient?.addressLine),
    postalCode: str(body.recipient?.postalCode),
    city: str(body.recipient?.city),
    country: str(body.recipient?.country)?.toUpperCase(),
    vatId: body.recipient?.vatId ? normaliseVatId(String(body.recipient.vatId)) : undefined,
    email: str(body.recipient?.email),
  };

  return {
    number: str(body.number) ?? formatInvoiceNumber(series, new Date(issueDate)),
    issueDate,
    supplyDate: str(body.supplyDate),
    supplyPeriod:
      body.supplyPeriod?.from && body.supplyPeriod?.to
        ? { from: String(body.supplyPeriod.from), to: String(body.supplyPeriod.to) }
        : undefined,
    issuer: { ...issuerParty(org), ...(body.issuerOverride ?? {}) },
    recipient,
    lines: Array.isArray(body.lines) ? body.lines : [],
    treatment,
    selfBilled: body.selfBilled === true,
  };
}

const badRequest = (res: express.Response, err: unknown) => {
  if (err instanceof DraftError || err instanceof InvoiceError || err instanceof CoaError) {
    res.status(400).json({ error: (err as Error).message });
    return true;
  }
  return false;
};

/**
 * Creating a transfer from a quote, injected from server.ts.
 *
 * Injected rather than imported so this router cannot acquire its own way of
 * building a transfer. One code path builds them, so one code path enforces the
 * balance check, the daily cap and the destination commitment.
 */
export type TransferFactory = (
  quote: Awaited<ReturnType<typeof createQuote>>,
  recipient: {
    recipientName: string;
    recipientPhone?: string;
    recipientIban?: string;
    reference?: string;
  },
) => Promise<
  | { ok: true; transfer: { id: string }; authorization: unknown }
  | { ok: false; status: number; body: any }
>;

export function createBusinessRouter(
  requireSession: SessionResolver,
  buildTransferFromQuote: TransferFactory,
): express.Router {
  const r = express.Router();
  const ctxOf = (req: express.Request, res: express.Response) =>
    resolveOrg(req, res, requireSession);

  const contactsById = (orgId: string) =>
    new Map(store.contactsOf(orgId).map((c) => [c.id, c] as const));

  /**
   * A draft's execution state, derived from the transfers it created.
   *
   * Derived rather than stored: the transfers are the truth. A draft row that
   * said EXECUTED while one of its transfers sat in MANUAL_REVIEW would be a
   * comfortable lie, and a background sweep to keep a copy honest is one more
   * thing to drift. Pure — it returns a view and writes nothing.
   */
  const withExecutionState = (draft: DraftPayment) => {
    if (draft.state !== "EXECUTING" || !draft.transferIds?.length) return draft;
    const transfers = draft.transferIds
      .map((id) => store.findTransfer(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));

    const summary = transfers.map((t) => ({ id: t.id, state: t.state }));
    const settled = transfers.filter((t) => t.state === "PAID");
    const stuck = transfers.filter((t) =>
      ["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state),
    );

    let state: DraftState = draft.state;
    if (transfers.length === draft.transferIds.length) {
      if (settled.length === transfers.length) state = "EXECUTED";
      else if (stuck.length) state = "FAILED";
    }
    return {
      ...draft,
      state,
      transfers: summary,
      ...(stuck.length
        ? {
            failureReason: `${stuck.length} of ${transfers.length} transfer(s) did not settle: ${stuck
              .map((t) => `${t.id.slice(0, 8)} ${t.state}`)
              .join(", ")}`,
          }
        : {}),
    };
  };

  /** Re-check a draft against the address book and park it if anything moved. */
  const reconcileDrift = (draft: DraftPayment): DraftPayment => {
    const drifted = findDriftedLines(draft, contactsById(draft.orgId));
    if (!drifted.length) return draft;
    return store.updateDraft(draft.id, {
      state: "INVALID_DATA",
      invalidLineIds: drifted,
      activity: [
        ...draft.activity,
        activity(
          "system",
          "invalid_data",
          `${drifted.length} line(s) point at a recipient that has changed since the draft was saved.`,
        ),
      ],
    });
  };

  // ── Draft payments ────────────────────────────────────────────────────────

  r.get("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.read")) return;
    const drafts = store.draftsOf(ctx.org.id);
    res.json({
      drafts: drafts.map((d) => ({ ...withExecutionState(d), totals: totalsByAsset(d) })),
    });
  });

  r.post("/:orgId/drafts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;

    const source = req.body?.source;
    if (
      !source ||
      (source.kind === "account" && !store.findAccount(String(source.accountId))) ||
      (source.kind === "wallet" && !store.findImportedWallet(String(source.walletId))) ||
      !["account", "wallet"].includes(source.kind)
    ) {
      return res
        .status(400)
        .json({ error: "A draft needs a funding source: an account or an imported wallet." });
    }

    try {
      const contacts = contactsById(ctx.org.id);
      const lines = (req.body?.lines ?? []).map((l: Record<string, unknown>) => ({
        id: `dl_${randomUUID()}`,
        ...validateLine(
          l as never,
          typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined,
        ),
      }));
      if (!lines.length) return res.status(400).json({ error: "A draft needs at least one line." });

      const now = new Date().toISOString();
      const draft = store.addDraft({
        id: `dft_${randomUUID()}`,
        orgId: ctx.org.id,
        source,
        state: "DRAFT",
        lines,
        createdByMemberId: ctx.member.id,
        activity: [activity(ctx.member.id, "created")],
        createdAt: now,
        updatedAt: now,
      });
      res.status(201).json({ draft, totals: totalsByAsset(draft) });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  r.patch("/:orgId/drafts/:draftId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    if (!isEditable(draft.state)) {
      return res.status(409).json({
        error: `A draft in ${draft.state} cannot be edited. Send it back to draft first.`,
      });
    }
    try {
      const contacts = contactsById(ctx.org.id);
      const lines = (req.body?.lines ?? draft.lines).map((l: Record<string, unknown>) => ({
        id: typeof l.id === "string" ? l.id : `dl_${randomUUID()}`,
        ...validateLine(
          l as never,
          typeof l.contactId === "string" ? contacts.get(l.contactId) : undefined,
        ),
      }));
      const updated = store.updateDraft(draft.id, {
        lines,
        // Re-pointing the lines is exactly how INVALID_DATA is resolved.
        state: "DRAFT",
        invalidLineIds: undefined,
        activity: [...draft.activity, activity(ctx.member.id, "edited")],
      });
      res.json({ draft: updated, totals: totalsByAsset(updated) });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /** Submit for review. Drift is checked here and again at execution. */
  r.post("/:orgId/drafts/:draftId/submit", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    if (!requireCapability(ctx, res, "transfers.approvals")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const checked = reconcileDrift(draft);
    if (checked.state === "INVALID_DATA") {
      return res.status(409).json({
        error:
          "Some recipients changed since this draft was saved. Re-point those lines before submitting.",
        draft: checked,
      });
    }
    try {
      assertTransition(checked.state, "PENDING_REVIEW");
      res.json({
        draft: store.updateDraft(draft.id, {
          state: "PENDING_REVIEW",
          activity: [...checked.activity, activity(ctx.member.id, "submitted_for_review")],
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /**
   * Review. Four eyes: the reviewer may not be the drafter, whatever the role —
   * otherwise review is a button the same person presses twice.
   */
  r.post("/:orgId/drafts/:draftId/review", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "transfers.approvals")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const verdict = canReviewDraft(ctx.member.role, ctx.member.id, draft.createdByMemberId);
    if (!verdict.allowed) return res.status(403).json({ error: verdict.reason });

    const approve = req.body?.approve !== false;
    try {
      if (!approve) {
        assertTransition(draft.state, "REJECTED");
        return res.json({
          draft: store.updateDraft(draft.id, {
            state: "REJECTED",
            rejectedReason: String(req.body?.reason ?? "").trim() || undefined,
            reviewedByMemberId: ctx.member.id,
            reviewedAt: new Date().toISOString(),
            activity: [...draft.activity, activity(ctx.member.id, "rejected", req.body?.reason)],
          }),
        });
      }
      const checked = reconcileDrift(draft);
      if (checked.state === "INVALID_DATA") {
        return res.status(409).json({
          error: "Some recipients changed since this draft was submitted.",
          draft: checked,
        });
      }
      assertTransition(checked.state, "REVIEWED");
      res.json({
        draft: store.updateDraft(draft.id, {
          state: "REVIEWED",
          reviewedByMemberId: ctx.member.id,
          reviewedAt: new Date().toISOString(),
          activity: [...checked.activity, activity(ctx.member.id, "reviewed")],
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  /**
   * Execute a reviewed draft: one transfer per line, each needing its own FP4
   * device signature.
   *
   * NOTHING MOVES HERE. This endpoint creates transfers and hands back the
   * authorizations the device must sign; a transfer with no signature can never
   * debit anything. That property is what makes the partial-failure path below
   * safe.
   *
   * The claim is synchronous — same shape as the transfer authorization claim,
   * and for the same reason: two parallel submissions of one draft must not
   * both pass the state check. Drift is re-checked immediately before, because
   * the gap between approval and execution is exactly where an address-book
   * edit lands.
   */
  r.post("/:orgId/drafts/:draftId/execute", async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "transfers.execute")) return;

    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    const checked = reconcileDrift(draft);
    if (checked.state === "INVALID_DATA") {
      return res.status(409).json({
        error: "Some recipients changed since this draft was approved. It has been held.",
        draft: checked,
      });
    }

    // An imported wallet is read-only: we build the transactions, its owner
    // signs them. Saying so is the point; silently doing nothing would not be.
    if (checked.source.kind === "wallet") {
      const wallet = store.findImportedWallet(checked.source.walletId);
      return res.status(200).json({
        unsigned: true,
        wallet: wallet
          ? { address: wallet.address, chainId: wallet.chainId, kind: wallet.kind }
          : null,
        lines: checked.lines,
        note:
          "This wallet was imported read-only — we hold no key for it. Sign these transactions in your own wallet; nothing has been submitted.",
      });
    }

    // ── Funding identity ──────────────────────────────────────────────────
    const account = store.findAccount(checked.source.accountId);
    if (!account || account.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "This draft's funding account no longer exists." });
    }
    const spendable = accountIsSpendable(account);
    if (!spendable.ok) return res.status(409).json({ error: spendable.reason });
    if (!account.backingUserId) {
      return res.status(409).json({
        error:
          "This account has no funding identity yet. Provisioning a Safe and a Monerium profile per organisation is not built — only accounts carried over from an existing personal account can be spent from today.",
      });
    }
    // Spending authority is a device key in one person's browser. A `payer` on
    // the org cannot sign for somebody else's key, and there is no server-side
    // authority to fall back on, so say that rather than failing later at
    // /authorize with something that reads like a bug.
    if (ctx.userId !== account.backingUserId) {
      return res.status(403).json({
        error:
          "Only the person holding this account's device key can authorise its payments. Your role permits sending, but the signature has to come from that device.",
      });
    }
    const user = store.findUser(account.backingUserId);
    if (!user) {
      return res.status(409).json({ error: "This account's funding identity is missing." });
    }

    // ── Plan every line BEFORE creating anything ──────────────────────────
    // A half-created batch consumes quotes and leaves transfers nobody asked
    // for, so every line is checked first and the whole draft is refused if any
    // one of them cannot be paid.
    const plans: { lineId: string; iban: string; name: string; sendEur: number }[] = [];
    const problems: { lineId: string; reason: string }[] = [];

    for (const line of checked.lines) {
      const d = line.destination;
      if (d.kind === "wallet") {
        problems.push({
          lineId: line.id,
          reason:
            "Paying a wallet from an issued account is not wired — that is a token-to-token payment, not a payout rail.",
        });
        continue;
      }
      const contact = line.contactId ? store.findContact(line.contactId) : undefined;
      const bank = contact?.bankAccounts.find((b) => b.id === d.bankAccountId);
      if (!bank) {
        problems.push({ lineId: line.id, reason: "The saved bank account is gone." });
        continue;
      }
      if (bank.currency !== "EUR" || !bank.iban) {
        const def = CURRENCY_REGISTRY[bank.currency];
        problems.push({
          lineId: line.id,
          reason: `${def?.name ?? bank.currency} payouts are not open: ${def?.needs ?? "no rail"}`,
        });
        continue;
      }
      const sendEur = Number(line.amount);
      // createQuote refuses these too, but refusing here keeps the whole batch
      // atomic instead of failing halfway through.
      if (!(sendEur > FX.FIXED_FEE_EUR)) {
        problems.push({
          lineId: line.id,
          reason: `€${line.amount} does not exceed the €${FX.FIXED_FEE_EUR} fee, so nothing would arrive.`,
        });
        continue;
      }
      if (sendEur > FX.DAILY_CAP_EUR) {
        problems.push({
          lineId: line.id,
          reason: `€${line.amount} is over the €${FX.DAILY_CAP_EUR} daily cap.`,
        });
        continue;
      }
      plans.push({ lineId: line.id, iban: bank.iban, name: bank.holderName, sendEur });
    }

    if (problems.length) {
      return res.status(422).json({
        error: `${problems.length} of ${checked.lines.length} line(s) cannot be paid. Nothing was created.`,
        problems,
      });
    }

    // Each line is its own transfer and therefore its own fixed fee. Checked
    // against the balance as a TOTAL: the per-transfer check inside
    // buildTransferFromQuote sees the full balance every time, so N lines that
    // each fit individually can still overdraw together.
    const totalEur = plans.reduce((s, p) => s + p.sendEur, 0);
    try {
      const balances = await accountBalances(user.address);
      if (balances.safeBalanceEur < totalEur) {
        return res.status(400).json({
          error: `This draft sends €${totalEur.toFixed(2)} in total but the account holds €${balances.safeBalanceEur.toFixed(2)}.`,
          totalEur,
          availableEur: balances.safeBalanceEur,
        });
      }
    } catch (err) {
      return res.status(502).json({
        error: `Could not read the account balance, so the batch was not started: ${(err as Error).message}`,
      });
    }

    // ── Claim, then create ────────────────────────────────────────────────
    // Which states may be sent from depends on the plan. An org WITH approvals
    // must go through review — that is what it bought. An org without them has
    // no review step at all, so requiring REVIEWED there would make every draft
    // permanently unsendable.
    const approvals = can(ctx.org, "transfers.approvals").allowed;
    const claimable: DraftState[] = approvals ? ["REVIEWED"] : ["DRAFT", "REVIEWED"];
    const claimed = store.claimDraftExecution(checked.id, claimable);
    if (!claimed) {
      return res.status(409).json({
        error: approvals
          ? `This draft is ${checked.state}. On your plan a payment must be reviewed by a second person before it can be sent.`
          : `This draft is ${checked.state} and cannot be sent from that state — it may already be executing.`,
      });
    }

    const authorizations: {
      lineId: string;
      transferId: string;
      recipient: string;
      sendEur: number;
      authorization: unknown;
    }[] = [];

    for (const plan of plans) {
      let built;
      try {
        const quote = await createQuote(user.id, { rail: "sepa", sendEur: plan.sendEur });
        built = await buildTransferFromQuote(quote, {
          recipientName: plan.name,
          recipientIban: plan.iban,
          reference: `${ctx.org.name} ${claimed.id.slice(0, 8)}`.slice(0, 140),
        });
      } catch (err) {
        built = { ok: false as const, status: 500, body: { error: (err as Error).message } };
      }

      if (!built.ok) {
        // Partial batch. The transfers already created sit in CREATED with no
        // signature, so no money can move through them — they simply expire.
        // The draft goes to FAILED rather than back to REVIEWED so that a retry
        // is a deliberate re-draft instead of a second batch on top of the
        // first.
        store.updateDraft(claimed.id, {
          state: "FAILED",
          transferIds: authorizations.map((a) => a.transferId),
          failureReason: `Line ${plan.lineId} could not be prepared: ${built.body?.error ?? "unknown"}`,
          activity: [
            ...claimed.activity,
            activity(
              ctx.member.id,
              "execution_failed",
              `${authorizations.length} transfer(s) were created and left unsigned; they expire without moving anything.`,
            ),
          ],
        });
        return res.status(built.status).json({
          error: `Line ${plan.lineId} could not be prepared, so the batch was stopped.`,
          detail: built.body?.error,
          createdButUnsigned: authorizations.map((a) => a.transferId),
          note: "Nothing moved. Transfers created before the failure carry no signature and expire unused.",
        });
      }

      authorizations.push({
        lineId: plan.lineId,
        transferId: built.transfer.id,
        recipient: plan.name,
        sendEur: plan.sendEur,
        authorization: built.authorization,
      });
    }

    const updated = store.updateDraft(claimed.id, {
      transferIds: authorizations.map((a) => a.transferId),
      activity: [
        ...claimed.activity,
        activity(
          ctx.member.id,
          "executing",
          `${authorizations.length} transfer(s) created, awaiting a device signature for each.`,
        ),
      ],
    });

    res.status(201).json({
      draft: updated,
      authorizations,
      totalEur,
      // Said plainly: the draft is not sent until every line is signed.
      note: `${authorizations.length} transfer(s) created. Each needs its own device signature — sign them and POST to each authorization's submitTo. Nothing has moved yet.`,
    });
  });

  /**
   * One draft, with its execution state derived from its transfers.
   *
   * Derived rather than stored: the transfers are the truth, and a draft row
   * that says EXECUTED while a transfer sits in MANUAL_REVIEW would be a
   * comfortable lie.
   */
  r.get("/:orgId/drafts/:draftId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.read")) return;
    const draft = store.findDraft(String(req.params.draftId));
    if (!draft || draft.orgId !== ctx.org.id) {
      return res.status(404).json({ error: "no such draft" });
    }
    res.json({ draft: withExecutionState(draft), totals: totalsByAsset(draft) });
  });

  /** Bulk import lines from a CSV. */
  r.post("/:orgId/drafts/import-csv", express.text({ type: "*/*", limit: CSV_MAX_BYTES }), (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "drafts.create")) return;
    if (!requireCapability(ctx, res, "transfers.bulkCsv")) return;

    const mapping = {
      recipientAddress: String(req.query.recipientAddress ?? "Recipient Address"),
      token: String(req.query.token ?? "Token"),
      amount: String(req.query.amount ?? "Amount"),
      recipientName: req.query.recipientName ? String(req.query.recipientName) : "Recipient Name",
      account: req.query.account ? String(req.query.account) : "Account",
      notes: req.query.notes ? String(req.query.notes) : "Notes",
      tags: req.query.tags ? String(req.query.tags) : "Tags",
    };
    try {
      const knownTags = new Set(
        store.ledgerOf(ctx.org.id).flatMap((e) => e.tags),
      );
      const result = importCsv(String(req.body ?? ""), mapping, {
        maxRows: limitsFor(ctx.org).bulkCsvRows,
        knownTags,
      });
      res.json({
        lines: result.lines,
        rejected: result.rejected,
        newTags: result.newTags,
        // Rejected rows are reported, never dropped silently: a bulk file that
        // quietly loses rows pays fewer people than the operator believes.
        summary: `${result.lines.length} row(s) ready, ${result.rejected.length} rejected.`,
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  // ── Invoices ──────────────────────────────────────────────────────────────

  r.get("/:orgId/invoices", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    res.json({
      invoices: store
        .invoicesOf(ctx.org.id)
        .filter((i) => i.state !== "DELETED")
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

  /** Mark an invoice settled outside the platform (manual reconciliation). */
  r.post("/:orgId/invoices/:invoiceId/reconcile", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
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
      next.bank = {
        holder: b.bank.holder?.trim() || undefined,
        iban: iban || undefined,
        bic: b.bank.bic?.toUpperCase().replace(/\s+/g, "") || undefined,
        bankName: b.bank.bankName?.trim() || undefined,
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
  r.post("/:orgId/invoicing/check", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.read")) return;
    try {
      const draft = draftFrom(ctx.org, req.body ?? {});
      const report = checkCompliance(draft, jurisdictionOf(ctx.org), customReasonsOf(ctx.org));
      res.json({ ...report, preview: { number: draft.number, totals: report.totals } });
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
  r.post("/:orgId/invoicing/issue", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "invoices")) return;
    if (!requirePermission(ctx, res, "invoices.manage")) return;

    let draft;
    try {
      draft = draftFrom(ctx.org, req.body ?? {});
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
      currency: "EUR",
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
    store.updateOrganisation(ctx.org.id, {
      invoicing: { ...(ctx.org.invoicing ?? {}), numberSeries: { ...series, next: series.next + 1 } },
    });

    res.status(201).json({
      invoice: { ...invoice, linkTokenHash: undefined },
      linkToken: token,
      linkPath: `/invoice/${token}`,
      warnings: report.warnings,
    });
  });

  // ── Chart of accounts ─────────────────────────────────────────────────────

  r.get("/:orgId/chart-of-accounts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.manage")) return;
    if (!requirePermission(ctx, res, "coa.read")) return;
    res.json({
      accounts: store.chartOf(ctx.org.id),
      rules: store.rulesOf(ctx.org.id),
      txTypes: TX_TYPES,
    });
  });

  r.post("/:orgId/chart-of-accounts", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.manage")) return;
    if (!requirePermission(ctx, res, "coa.manage")) return;
    try {
      const fields = validateChartAccount(req.body ?? {});
      if (store.chartOf(ctx.org.id).some((c) => c.code === fields.code)) {
        return res.status(409).json({ error: `Account code ${fields.code} is already in use.` });
      }
      res.status(201).json({
        account: store.addChartAccount({
          id: `coa_${randomUUID()}`,
          orgId: ctx.org.id,
          ...fields,
          archived: false,
          createdAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      if (badRequest(res, err)) return;
      throw err;
    }
  });

  r.post("/:orgId/account-rules", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.rules")) return;
    if (!requirePermission(ctx, res, "coa.manage")) return;

    const scope = String(req.body?.scope ?? "");
    if (!["default", "wallet", "asset", "contact"].includes(scope)) {
      return res
        .status(400)
        .json({ error: "Scope must be default, wallet, asset or contact." });
    }
    const accountCode = String(req.body?.accountCode ?? "");
    if (!store.chartOf(ctx.org.id).some((c) => c.code === accountCode)) {
      return res.status(400).json({ error: `No account with code ${accountCode}.` });
    }
    const direction = ["in", "out", "both"].includes(String(req.body?.direction))
      ? (String(req.body.direction) as "in" | "out" | "both")
      : "both";

    res.status(201).json({
      rule: store.addAccountRule({
        id: `rule_${randomUUID()}`,
        orgId: ctx.org.id,
        scope: scope as never,
        match: {
          txType: req.body?.txType ? String(req.body.txType) : undefined,
          walletId: req.body?.walletId ? String(req.body.walletId) : undefined,
          asset: req.body?.asset ? String(req.body.asset) : undefined,
          contactId: req.body?.contactId ? String(req.body.contactId) : undefined,
        },
        direction,
        accountCode,
        createdAt: new Date().toISOString(),
      }),
    });
  });

  /** Re-run the rules. Touches only rows a rule set before, never a human's. */
  r.post("/:orgId/account-rules/apply", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "coa.rules")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const { changed, entries } = applyRules(store.rulesOf(ctx.org.id), store.ledgerOf(ctx.org.id));
    store.replaceLedgerEntries(entries);
    res.json({
      changed,
      note: "Only automatically mapped rows were touched. Anything you categorised by hand was left alone.",
    });
  });

  // ── Ledger, assets, reports, export ───────────────────────────────────────

  r.get("/:orgId/ledger", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;

    let entries = store.ledgerOf(ctx.org.id);
    const { from, to, asset, direction, accountCode, tag } = req.query;
    if (from) entries = entries.filter((e) => e.at >= String(from));
    if (to) entries = entries.filter((e) => e.at <= String(to));
    if (asset) entries = entries.filter((e) => e.asset.toUpperCase() === String(asset).toUpperCase());
    if (direction) entries = entries.filter((e) => e.direction === direction);
    if (accountCode) entries = entries.filter((e) => e.accountCode === String(accountCode));
    if (tag) entries = entries.filter((e) => e.tags.includes(String(tag)));

    res.json({
      entries: entries.sort((a, b) => b.at.localeCompare(a.at)),
      total: entries.length,
    });
  });

  r.patch("/:orgId/ledger/:entryId", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "ledger.transactions")) return;
    if (!requirePermission(ctx, res, "ledger.categorise")) return;
    const entry = store.ledgerOf(ctx.org.id).find((e) => e.id === String(req.params.entryId));
    if (!entry) return res.status(404).json({ error: "no such transaction" });

    const patch: Record<string, unknown> = {};
    if (req.body?.accountCode !== undefined) {
      patch.accountCode = String(req.body.accountCode);
      // A human set it, so a later rule run must not overwrite it.
      patch.accountCodeAuto = false;
    }
    if (Array.isArray(req.body?.tags)) {
      if (!requireCapability(ctx, res, "ledger.tags")) return;
      patch.tags = req.body.tags.map(String);
    }
    if (typeof req.body?.note === "string") patch.note = req.body.note;
    res.json({ entry: store.updateLedgerEntry(entry.id, patch) });
  });

  r.get("/:orgId/assets", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "assets.costBasis")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const basis = computeCostBasis(store.ledgerOf(ctx.org.id));
    res.json({
      positions: positions(basis),
      disposals: basis.disposals,
      // Surfaced rather than folded into profit: an unmatched disposal usually
      // means history is missing, and booking it at zero cost overstates income.
      shortfalls: basis.shortfalls,
      costBasisMethod: ctx.org.reporting.costBasisMethod,
    });
  });

  r.get("/:orgId/reports/monthly-balance", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "reports.monthlyBalance")) return;
    if (!requirePermission(ctx, res, "reports.run")) return;

    const months = limitsFor(ctx.org).reportMonths;
    const earliest = new Date();
    earliest.setMonth(earliest.getMonth() - months);
    const floor = earliest.toISOString().slice(0, 7);
    const from = req.query.from ? String(req.query.from) : undefined;

    const rows = monthlyBalances(store.ledgerOf(ctx.org.id), {
      from: from && from > floor ? from : floor,
      to: req.query.to ? String(req.query.to) : undefined,
    });
    if (String(req.query.format) === "csv") {
      res.type("text/csv").attachment("monthly-balance.csv").send(toCsv(rows as never));
      return;
    }
    res.json({
      rows,
      // The ceiling is stated, so a short report reads as a plan limit rather
      // than as missing data.
      windowMonths: months,
      earliestMonth: floor,
    });
  });

  r.get("/:orgId/export/ledger.csv", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requireCapability(ctx, res, "export.ledger")) return;
    if (!requirePermission(ctx, res, "ledger.read")) return;
    const rows = ledgerExportRows(store.ledgerOf(ctx.org.id));
    res
      .type("text/csv")
      .attachment("transactions.csv")
      .send(toCsv(rows, [...LEDGER_EXPORT_COLUMNS]));
  });

  return r;
}

/**
 * The supplier's half of the invoice flow: no account, no wallet, no session.
 *
 * Mounted at /api/invoice-links and reached only with the one-time token. Every
 * response goes through supplierView(), which is an allowlist — a field added
 * to Invoice later must be chosen into it rather than leaking by default.
 */
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
      const supplied = String(req.header("x-invoice-password") ?? req.body?.password ?? "");
      if (!supplied || hashToken(supplied) !== invoice.linkPasswordHash) {
        res.status(401).json({ error: "This invoice link is password protected.", passwordRequired: true });
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
        payTo: req.body?.payTo,
        dueDate: typeof req.body?.dueDate === "string" ? req.body.dueDate : invoice.dueDate,
        submittedAt: new Date().toISOString(),
      });
      res.json({ invoice: supplierView(updated, payorName(updated), issuerExtras(updated)) });
    } catch (err) {
      if (err instanceof InvoiceError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  return r;
}
