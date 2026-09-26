/**
 * Accounting connectors: GetMyInvoices.
 *
 * The key is the organisation's own, pasted from their GetMyInvoices account,
 * proven against `GET /account` before it is stored, encrypted at rest and
 * never returned. `integrations.accounting` is a plan capability; the push
 * routes additionally need a connected key and answer 409 without one, so a
 * plan that includes the connector still cannot upload anywhere until an
 * owner has connected an account.
 *
 * Uploads are idempotent on the document number (the Beleg code), so a push
 * run twice uploads nothing twice.
 */
import express from "express";
import { MONERIUM } from "../../config.js";
import { decryptField, encryptField, EncryptionUnavailableError } from "../../crypto-at-rest.js";
import { store } from "../../store.js";
import { requireCapability, requirePermission, type OrgContext } from "../org-context.js";
import { GetMyInvoicesClient, GmiApiError, gmiUserAgent, type GmiDocumentUpload } from "../../adapters/getmyinvoices.js";
import { belegFileName, belegPdf, belegTitle, type BelegSnapshot } from "../../bookkeeping/beleg.js";
import { isMonth, linesInMonth } from "../../bookkeeping/statement.js";
import { statementLinesOf } from "../../bookkeeping/writer.js";
import { auditEntry } from "../../audit.js";
import type { Organisation } from "../../domain/types.js";

export interface OrgRoutes {
  ctxOf: (req: express.Request, res: express.Response) => OrgContext | undefined;
}

export const gmiAvailable = () => Boolean(MONERIUM.tokenEncryptionKey);

export function gmiClientFor(org: Organisation): GetMyInvoicesClient | null {
  const g = org.integrations?.getmyinvoices;
  if (!g) return null;
  return new GetMyInvoicesClient({
    apiKey: decryptField("getmyinvoices", MONERIUM.tokenEncryptionKey, g.apiKeyEnc),
    userAgent: gmiUserAgent(g.accountId),
  });
}

/** What the org may see about its connector. Never the key, in any form. */
export function publicIntegrations(org: Organisation) {
  const g = org.integrations?.getmyinvoices;
  return {
    getmyinvoices: g
      ? {
          connected: true,
          accountName: g.accountName,
          accountEmail: g.accountEmail,
          connectedAt: g.connectedAt,
          companyId: g.companyId,
        }
      : { connected: false, needs: gmiAvailable() ? "an API key from your GetMyInvoices account" : "the server's encryption key (MONERIUM_TOKEN_ENCRYPTION_KEY)" },
  };
}

/** The upload body for one Beleg: the accountant's inbox sees the document
 *  number, amounts, paid state and the transaction hashes as tags. */
export function belegUpload(snap: BelegSnapshot, code: string, issuedAt: string, companyId?: number): GmiDocumentUpload {
  const amount = Math.abs(snap.line.amountCents) / 100;
  const credit = snap.line.amountCents >= 0;
  const tags = [
    "zold",
    snap.line.event,
    ...snap.line.links.txHashes.map((h) => `tx:${h}`),
    ...(snap.line.links.invoiceNumber ? [`invoice:${snap.line.links.invoiceNumber}`] : []),
  ].slice(0, 20);
  return {
    fileName: belegFileName(snap, code),
    file: belegPdf(snap, code, issuedAt),
    documentType: credit ? "PAYMENT_RECEIPT" : "RECEIPT",
    documentNumber: code,
    documentDate: snap.line.valueDate,
    grossAmount: amount.toFixed(2),
    netAmount: amount.toFixed(2),
    currency: "EUR",
    paymentMethod: snap.receipt ? "online_payment" : "bank_transfer",
    paymentStatus: "Paid",
    paidAt: snap.receipt?.blockTime ? snap.receipt.blockTime.slice(0, 10) : snap.line.valueDate,
    note: [
      `${belegTitle(snap)} — ${snap.line.reference}`,
      snap.line.links.invoiceNumber ? `Invoice ${snap.line.links.invoiceNumber}` : undefined,
      ...snap.line.links.txHashes.map((h) => `tx ${h}`),
      snap.unexecutedNote,
    ].filter(Boolean).join("\n"),
    tags,
    ...(companyId ? { companyId } : {}),
    runOCR: false,
  };
}

export function createIntegrationRoutes(deps: OrgRoutes): express.Router {
  const { ctxOf } = deps;
  const r = express.Router();

  r.get("/:orgId/integrations", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.read")) return;
    res.json({ integrations: publicIntegrations(ctx.org), available: gmiAvailable() });
  });

  r.post("/:orgId/integrations/getmyinvoices", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "integrations.accounting")) return;
      if (!requirePermission(ctx, res, "org.update")) return;
      if (!gmiAvailable()) {
        return res.status(503).json({ error: "the server has no encryption key configured, so an API key cannot be stored — set MONERIUM_TOKEN_ENCRYPTION_KEY" });
      }
      const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
      if (apiKey.length < 16 || /\s/.test(apiKey)) return res.status(400).json({ error: "apiKey must be the key as shown in GetMyInvoices (Settings → API)" });
      const companyId = req.body?.companyId === undefined || req.body?.companyId === null || req.body?.companyId === "" ? undefined : Number(req.body.companyId);
      if (companyId !== undefined && !Number.isInteger(companyId)) return res.status(400).json({ error: "companyId must be a whole number" });

      let account;
      try {
        account = await new GetMyInvoicesClient({ apiKey, userAgent: gmiUserAgent() }).account();
      } catch (err: any) {
        if (err instanceof GmiApiError && err.status >= 400 && err.status < 500) {
          store.audit(auditEntry("partner.call_refused", { partner: "getmyinvoices", status: err.status, orgId: ctx.org.id }, ctx.userId));
          return res.status(400).json({ error: "GetMyInvoices did not accept that key" });
        }
        return res.status(503).json({ error: `GetMyInvoices could not be reached to verify the key: ${String(err?.message ?? err).slice(0, 160)}` });
      }
      let apiKeyEnc: string;
      try {
        apiKeyEnc = encryptField("getmyinvoices", MONERIUM.tokenEncryptionKey, apiKey);
      } catch (err) {
        if (err instanceof EncryptionUnavailableError) return res.status(503).json({ error: err.message });
        throw err;
      }
      const org = store.updateOrganisation(ctx.org.id, {
        integrations: {
          ...(ctx.org.integrations ?? {}),
          getmyinvoices: {
            apiKeyEnc,
            accountName: account.organization || account.name || undefined,
            accountEmail: account.email,
            ...(account.accountId ? { accountId: String(account.accountId) } : {}),
            connectedAt: new Date().toISOString(),
            connectedByMemberId: ctx.member.id,
            ...(companyId !== undefined ? { companyId } : {}),
          },
        },
      });
      store.audit(auditEntry("partner.credentials_connected", { partner: "getmyinvoices", orgId: org.id, account: account.organization ?? account.name }, ctx.userId));
      res.status(201).json({ integrations: publicIntegrations(org), account: { name: account.name, organization: account.organization, email: account.email, hasBankingAccess: account.hasBankingAccess } });
    } catch (err) {
      next(err);
    }
  });

  r.delete("/:orgId/integrations/getmyinvoices", (req, res) => {
    const ctx = ctxOf(req, res);
    if (!ctx) return;
    if (!requirePermission(ctx, res, "org.update")) return;
    if (!ctx.org.integrations?.getmyinvoices) return res.status(409).json({ error: "no GetMyInvoices key is connected" });
    const { getmyinvoices: _gone, ...rest } = ctx.org.integrations;
    const org = store.updateOrganisation(ctx.org.id, { integrations: rest });
    store.audit(auditEntry("partner.credentials_removed", { partner: "getmyinvoices", orgId: org.id }, ctx.userId));
    res.json({ integrations: publicIntegrations(org) });
  });

  /** Their bank accounts, so an operator can pick where lines should go. Read only. */
  r.get("/:orgId/integrations/getmyinvoices/bank-accounts", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "integrations.accounting")) return;
      if (!requirePermission(ctx, res, "ledger.read")) return;
      const client = gmiClientFor(ctx.org);
      if (!client) return res.status(409).json({ error: "connect a GetMyInvoices API key first" });
      res.json({ bankAccounts: await client.bankAccounts() });
    } catch (err) {
      if (err instanceof GmiApiError) return res.status(err.status >= 500 || err.status === 0 ? 503 : 400).json({ error: err.message });
      next(err);
    }
  });

  /**
   * Push a month's Belege. Each line must already have a Beleg (issued by
   * the export route); a line without one is reported, not uploaded, because
   * the document number IS the Beleg code and nothing else is stable enough
   * to dedupe on.
   */
  r.post("/:orgId/integrations/getmyinvoices/push", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      if (!ctx) return;
      if (!requireCapability(ctx, res, "integrations.accounting")) return;
      if (!requirePermission(ctx, res, "reports.run")) return;
      const client = gmiClientFor(ctx.org);
      if (!client) return res.status(409).json({ error: "connect a GetMyInvoices API key first" });
      const month = String(req.body?.month ?? "");
      if (!isMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
      const lines = linesInMonth(statementLinesOf(ctx.org.id), month);
      const results: { lineId: string; code?: string; outcome: "uploaded" | "exists" | "no-beleg" | "failed"; documentUid?: number; error?: string }[] = [];
      for (const line of lines) {
        const code = line.statement!.documentCode;
        const doc = code ? store.findDocumentByCode(code) : undefined;
        if (!doc || doc.snapshot.kind !== "beleg" || doc.revokedAt) {
          results.push({ lineId: line.id, outcome: "no-beleg" });
          continue;
        }
        try {
          const r = await client.pushDocument(belegUpload(doc.snapshot, doc.code, doc.createdAt, ctx.org.integrations?.getmyinvoices?.companyId));
          results.push({ lineId: line.id, code: doc.code, ...r });
        } catch (err: any) {
          results.push({ lineId: line.id, code: doc.code, outcome: "failed", error: String(err?.message ?? err).slice(0, 200) });
        }
      }
      store.audit(auditEntry("partner.documents_pushed", { partner: "getmyinvoices", orgId: ctx.org.id, month, uploaded: results.filter((x) => x.outcome === "uploaded").length, existing: results.filter((x) => x.outcome === "exists").length, failed: results.filter((x) => x.outcome === "failed").length }, ctx.userId));
      res.json({ month, results });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
