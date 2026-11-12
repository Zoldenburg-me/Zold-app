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
 * Zold adds each statement line to a manual bank account the organisation
 * picked there, and assigns the line's Beleg to it, so the accountant sees
 * the payment with its document attached.
 *
 * Idempotent by construction: before an upload the document number is
 * looked up, and a hit is returned rather than re-uploaded. The key is never
 * logged and never appears in an error.
 *
 * An upload that times out or loses its connection may still have landed
 * (a live push, 2026-10-03, had three of four do exactly that, without their
 * tags). So such an upload is never reported failed and never retried: the
 * number is looked up again, and the answer is "uploaded" (tags may be
 * missing) or "unknown".
 */
import { GETMYINVOICES } from "../config.js";
import { redactedMessage } from "../http/log-cause.js";

export interface GmiConfig {
  apiKey: string;
  /** Product name plus the account id, as their docs ask. */
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Waits before each re-lookup after an upload that did not answer; their
   *  index may lag the upload. */
  relookupDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}

export type GmiPushResult =
  | { outcome: "uploaded" | "exists"; documentUid: number; verifiedAfterTimeout?: true; tagsMayBeMissing?: true; error?: string }
  | { outcome: "unknown"; error: string };

export class GmiApiError extends Error {
  /** `errors[]` from their body, where they give it: code 127 "Transaction
   *  Record Already Exist." names the existing transactionUid. */
  public errors: { code?: number; detail?: string; transactionUid?: number }[] = [];
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

export interface GmiBankTransactionRecord {
  transactionUid: number;
  bookingDate?: string;
  description?: string;
  amount?: number;
}

export interface GmiBankLineResult {
  outcome: "added" | "exists" | "unknown";
  transactionUid?: number;
  /** The Beleg is attached to the line in GetMyInvoices. */
  assigned?: boolean;
  error?: string;
}

export class GetMyInvoicesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly relookupDelaysMs: number[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GmiConfig) {
    if (!cfg.apiKey) throw new Error("GetMyInvoices: no API key");
    this.baseUrl = (cfg.baseUrl ?? GETMYINVOICES.BASE_URL).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? GETMYINVOICES.TIMEOUT_MS;
    this.uploadTimeoutMs = cfg.uploadTimeoutMs ?? GETMYINVOICES.UPLOAD_TIMEOUT_MS;
    this.relookupDelaysMs = cfg.relookupDelaysMs ?? [1000, 3000, 6000];
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, query?: Record<string, string>, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new GmiApiError(0, `GetMyInvoices unreachable: ${redactedMessage(e).slice(0, 160)}`);
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
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      const detail = String(data?.detail ?? data?.message ?? data?.error ?? errors[0]?.detail ?? res.statusText).slice(0, 200);
      const err = new GmiApiError(res.status, `GetMyInvoices ${method} ${path} failed (${res.status}): ${detail}`);
      err.errors = errors;
      throw err;
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
    return this.call("POST", "/documents", undefined, { ...rest, fileContent: file.toString("base64"), runOCR: doc.runOCR ?? false }, this.uploadTimeoutMs);
  }

  /** For tests and scripts only; no route deletes. They answer 415 unless
   *  the DELETE carries a JSON content type and a `{}` body. */
  deleteDocument(documentUid: number): Promise<{ success: boolean }> {
    return this.call("DELETE", `/documents/${documentUid}`, undefined, {});
  }

  /**
   * Upload unless a document with this number is already there. Returns
   * what happened, so the caller can record it and a re-run is a no-op.
   *
   * A refusal (4xx) throws. An upload that got no answer (timeout, dropped
   * connection: status 0) or a 5xx may have landed, so it is never retried
   * blind: the number is looked up again, and the result is "uploaded" with
   * `verifiedAfterTimeout` if it is there, else "unknown".
   */
  async pushDocument(doc: GmiDocumentUpload): Promise<GmiPushResult> {
    const existing = await this.findDocumentsByNumber(doc.documentNumber);
    if (existing.length) return { outcome: "exists", documentUid: existing[0].documentUid };
    try {
      const r = await this.uploadDocument(doc);
      return { outcome: "uploaded", documentUid: r.documentUid };
    } catch (err) {
      if (!(err instanceof GmiApiError) || (err.status !== 0 && err.status < 500)) throw err;
      for (const wait of this.relookupDelaysMs) {
        await new Promise((r) => setTimeout(r, wait));
        try {
          const found = await this.findDocumentsByNumber(doc.documentNumber);
          if (found.length) {
            return { outcome: "uploaded", documentUid: found[0].documentUid, verifiedAfterTimeout: true, ...(doc.tags?.length ? { tagsMayBeMissing: true as const } : {}), error: err.message };
          }
        } catch {
          // A failed lookup is not an answer; try the next one.
        }
      }
      return { outcome: "unknown", error: err.message };
    }
  }

  async addBankTransaction(bankAccountUid: number, tx: GmiBankTransaction): Promise<number> {
    const r = await this.call<{ meta_data?: { transactionUid?: number } }>("POST", `/bankAccounts/${bankAccountUid}/transactions`, undefined, tx);
    const uid = Number(r.meta_data?.transactionUid);
    if (!Number.isInteger(uid) || uid <= 0) throw new GmiApiError(502, "GetMyInvoices added the transaction but returned no transactionUid");
    return uid;
  }

  /** Lines of one bank account whose description carries `marker`, on one
   *  booking day. The text filter is a search; matches are kept exact. */
  async findBankTransactions(bankAccountUid: number, marker: string, day: string): Promise<GmiBankTransactionRecord[]> {
    const r = await this.call<{ records?: GmiBankTransactionRecord[] | Record<string, GmiBankTransactionRecord> }>("GET", `/bankAccounts/${bankAccountUid}/transactions`, {
      textFilter: marker, startDateFilter: day, endDateFilter: day, limit: "50",
    });
    // An object keyed by transactionUid, as the live API answers (2026-10-03);
    // an array, as their spec reads.
    const list = Array.isArray(r.records) ? r.records : r.records ? Object.values(r.records) : [];
    return list.filter((t) => String(t.description ?? "").includes(marker));
  }

  async assignedDocumentUids(bankAccountUid: number, transactionUid: number): Promise<number[]> {
    const r = await this.call<{ records?: { documentUid?: number }[] | Record<string, { documentUid?: number }> }>("GET", `/bankAccounts/${bankAccountUid}/transactions/${transactionUid}/assign`);
    const list = Array.isArray(r.records) ? r.records : r.records ? Object.values(r.records) : [];
    return list.map((d) => Number(d.documentUid)).filter((n) => Number.isInteger(n));
  }

  assignDocument(bankAccountUid: number, transactionUid: number, documentUid: number): Promise<unknown> {
    return this.call("POST", `/bankAccounts/${bankAccountUid}/transactions/${transactionUid}/assign`, undefined, { documentUid });
  }

  /**
   * The bank line for one Beleg, once, with the Beleg assigned to it.
   *
   * `marker` (the Beleg code) is in the description, and is what makes a
   * re-send find the line instead of adding it twice. An add that got no
   * answer may have landed, so it is looked up again rather than retried.
   */
  async pushBankLine(bankAccountUid: number, tx: GmiBankTransaction, marker: string, documentUid?: number): Promise<GmiBankLineResult> {
    let transactionUid: number | undefined = (await this.findBankTransactions(bankAccountUid, marker, tx.bookingDate))[0]?.transactionUid;
    let outcome: GmiBankLineResult["outcome"] = transactionUid ? "exists" : "added";
    if (!transactionUid) {
      try {
        transactionUid = await this.addBankTransaction(bankAccountUid, tx);
      } catch (err) {
        // Their own guard: an identical line is refused with code 127 and the
        // uid of the one already there. That is the line, found.
        const same = err instanceof GmiApiError ? err.errors.find((e) => e.code === 127 && Number.isInteger(e.transactionUid)) : undefined;
        if (same) {
          transactionUid = same.transactionUid!;
          outcome = "exists";
        } else if (!(err instanceof GmiApiError) || (err.status !== 0 && err.status < 500)) throw err;
        for (const wait of transactionUid ? [] : this.relookupDelaysMs) {
          await new Promise((r) => setTimeout(r, wait));
          transactionUid = (await this.findBankTransactions(bankAccountUid, marker, tx.bookingDate).catch(() => []))[0]?.transactionUid;
          if (transactionUid) break;
        }
        if (!transactionUid) return { outcome: "unknown", error: redactedMessage(err) };
      }
    }
    if (!documentUid) return { outcome, transactionUid, assigned: false };
    const already = await this.assignedDocumentUids(bankAccountUid, transactionUid).catch(() => [] as number[]);
    if (!already.includes(documentUid)) await this.assignDocument(bankAccountUid, transactionUid, documentUid);
    return { outcome, transactionUid, assigned: true };
  }
}

/** The User-Agent their docs ask for: product name plus the account id. */
export function gmiUserAgent(accountId?: string | number | null): string {
  return `Zold bookkeeping export/1.0${accountId ? ` (account ${accountId})` : ""}`;
}
