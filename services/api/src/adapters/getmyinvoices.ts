/**
 * GetMyInvoices (accounts API v3): the document inbox the accountant reads
 * documents from, and the bank account they take lines from.
 *
 * Read from the published OpenAPI document (api.getmyinvoices.com/accounts/
 * v3/doc/api.json, Sep 2026): authentication is an `X-API-KEY` header, every
 * call needs a distinctive `User-Agent`, documents are created with
 * `POST /documents` (file as base64) and listed with
 * `GET /documents?documentNumberFilter=`, and — contrary to the two npm
 * clients — bank transactions CAN be created:
 * `POST /bankAccounts/{uid}/transactions` takes bookingDate, valueDate,
 * description, amount, currencyCode, clientIban and paymentPartnerName.
 * So bank lines have two doors: a GetMyInvoices bank account by API, or
 * Lexware's own CSV import. Which one the accountant wants is open.
 *
 * Idempotent by construction: before an upload the document number is
 * looked up, and a hit is returned rather than re-uploaded. The key is never
 * logged and never appears in an error.
 */
import { GETMYINVOICES } from "../config.js";

export interface GmiConfig {
  apiKey: string;
  /** Product name plus the account id, as their docs ask. */
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GmiApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GmiApiError";
  }
}

export interface GmiAccount {
  name?: string;
  organization?: string;
  accountId?: string | number | null;
  email?: string;
  hasBankingAccess?: boolean;
  apiKeyType?: string;
  currency?: string;
  timezone?: string;
}

export interface GmiBankAccount {
  bankAccountUid: number;
  accountType?: string;
  name?: string;
  currencyCode?: string;
  iban?: string;
  connectionStatus?: string;
}

export interface GmiDocumentRecord {
  documentUid: number;
  documentNumber?: string;
  documentType?: string;
  documentDate?: string;
  grossAmount?: string | number;
  paymentStatus?: string;
  [k: string]: unknown;
}

export type GmiDocumentType = "SALES_INVOICE" | "INCOMING_INVOICE" | "PAYMENT_RECEIPT" | "RECEIPT" | "STATEMENT" | "MISC";

export interface GmiDocumentUpload {
  fileName: string;
  /** The bytes; encoded here, never by the caller. */
  file: Buffer;
  documentType: GmiDocumentType;
  documentNumber: string;
  documentDate: string; // Y-m-d
  documentDueDate?: string;
  netAmount?: string;
  grossAmount: string;
  currency: string;
  paymentMethod?: "bank_transfer" | "online_payment" | "other";
  paymentStatus?: "Paid" | "Partially" | "Not paid" | "Unknown";
  paidAt?: string; // Y-m-d
  note?: string;
  tags?: string[];
  companyId?: number;
  runOCR?: boolean;
}

export interface GmiBankTransaction {
  bookingDate: string;
  valueDate: string;
  description: string;
  amount: number;
  currencyCode: string;
  clientIban?: string;
  paymentPartnerName?: string;
  tags?: string[];
}

export class GetMyInvoicesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GmiConfig) {
    if (!cfg.apiKey) throw new Error("GetMyInvoices: no API key");
    this.baseUrl = (cfg.baseUrl ?? GETMYINVOICES.BASE_URL).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? GETMYINVOICES.TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call<T>(method: "GET" | "POST" | "PUT", path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          "X-API-KEY": this.cfg.apiKey,
          "User-Agent": this.cfg.userAgent,
          "x-application": "Zold",
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) {
      throw new GmiApiError(0, `GetMyInvoices unreachable: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    if (!res.ok || data?.success === false) {
      // Their error body names the problem; the key is never part of it.
      const detail = String(data?.detail ?? data?.message ?? data?.error ?? res.statusText).slice(0, 200);
      throw new GmiApiError(res.status, `GetMyInvoices ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return data as T;
  }

  account(): Promise<GmiAccount> {
    return this.call<GmiAccount>("GET", "/account");
  }

  async bankAccounts(): Promise<GmiBankAccount[]> {
    const r = await this.call<{ records?: GmiBankAccount[] }>("GET", "/bankAccounts");
    return Array.isArray(r.records) ? r.records : [];
  }

  async findDocumentsByNumber(documentNumber: string): Promise<GmiDocumentRecord[]> {
    const r = await this.call<{ records?: GmiDocumentRecord[] | Record<string, GmiDocumentRecord> }>("GET", "/documents", {
      documentNumberFilter: documentNumber,
      archivedFilter: "1",
      perPage: "50",
    });
    const list = Array.isArray(r.records) ? r.records : r.records ? Object.values(r.records) : [];
    // The filter is a search; keep only exact matches.
    return list.filter((d) => String(d.documentNumber ?? "") === documentNumber);
  }

  uploadDocument(doc: GmiDocumentUpload): Promise<{ success: boolean; documentUid: number }> {
    const { file, ...rest } = doc;
    return this.call("POST", "/documents", undefined, { ...rest, fileContent: file.toString("base64"), runOCR: doc.runOCR ?? false });
  }

  /**
   * Upload unless a document with this number is already there. Returns
   * what happened, so the caller can record it and a re-run is a no-op.
   */
  async pushDocument(doc: GmiDocumentUpload): Promise<{ outcome: "uploaded" | "exists"; documentUid: number }> {
    const existing = await this.findDocumentsByNumber(doc.documentNumber);
    if (existing.length) return { outcome: "exists", documentUid: existing[0].documentUid };
    const r = await this.uploadDocument(doc);
    return { outcome: "uploaded", documentUid: r.documentUid };
  }

  addBankTransaction(bankAccountUid: number, tx: GmiBankTransaction): Promise<{ success: boolean }> {
    return this.call("POST", `/bankAccounts/${bankAccountUid}/transactions`, undefined, tx);
  }
}

/** The User-Agent their docs ask for: product name plus the account id. */
export function gmiUserAgent(accountId?: string | number | null): string {
  return `Zold bookkeeping export/1.0${accountId ? ` (account ${accountId})` : ""}`;
}
