/**
 * Errors the caller caused or can act on, as the status and body they get.
 *
 * The global error handler (server.ts) asks here first. Anything not listed is
 * ours: a 500 with a reference (error-log.ts). Listed here only where the
 * error type itself says what happened. A plain TypeError is NOT mapped to a
 * 400, because that is how a bug in our own code would hide; bad input is
 * refused where it is read.
 */
import { MoneriumAccessError, MoneriumApiError } from "../adapters/monerium-client.js";
import { EncryptionUnavailableError } from "../crypto-at-rest.js";
import { PaymentRequestError } from "../payment-requests.js";
import { RateUnavailableError } from "../rates.js";
import { CoaError } from "../domain/coa.js";
import { ContactError } from "../domain/contacts.js";
import { DraftError } from "../domain/drafts.js";
import { InvoiceError } from "../domain/invoices.js";
import { InvoiceComplianceError } from "../domain/invoicing.js";
import { SegmentInputError } from "../domain/segments.js";
import { HandleError } from "../pay.js";

export interface KnownError {
  status: number;
  body: { error: string; code: string };
  /** Also kept in the error log: the cause is ours (config, a partner). */
  log: boolean;
}

export function knownError(err: unknown): KnownError | undefined {
  const e = err as { type?: unknown; status?: unknown; expose?: unknown; message?: unknown } | undefined;

  // express.json's own refusals: a body that is not JSON, or too large.
  if (typeof e?.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.expose) {
    return e.status === 413
      ? { status: 413, body: { error: "The request is too large.", code: "BODY_TOO_LARGE" }, log: false }
      : { status: 400, body: { error: "The request body is not valid JSON.", code: "BAD_JSON" }, log: false };
  }
  // The domain validators' own refusals: the input broke a rule, said in
  // words the caller can act on. Routes catch these themselves; this is the
  // net for one that does not.
  if (
    err instanceof InvoiceError || err instanceof InvoiceComplianceError || err instanceof DraftError ||
    err instanceof ContactError || err instanceof CoaError || err instanceof SegmentInputError || err instanceof HandleError
  ) {
    return { status: 400, body: { error: (err as Error).message, code: "INVALID_INPUT" }, log: false };
  }
  if (err instanceof PaymentRequestError) {
    return { status: err.status, body: { error: err.message, code: "PAYMENT_REQUEST" }, log: err.status >= 500 };
  }
  if (err instanceof RateUnavailableError) {
    return {
      status: 503,
      body: { error: "Live exchange rates are unavailable right now, so Zold will not quote. Try again in a minute.", code: "RATES_UNAVAILABLE" },
      log: true,
    };
  }
  if (err instanceof MoneriumAccessError || (err instanceof MoneriumApiError && err.status === 401)) {
    return {
      status: 409,
      body: { error: "Zold can no longer reach your Monerium account. Connect it again, then try once more.", code: "MONERIUM_NOT_CONNECTED" },
      log: false,
    };
  }
  if (err instanceof MoneriumApiError) {
    return err.status < 500
      ? { status: 409, body: { error: `Monerium refused this: ${err.message}`, code: "MONERIUM_REFUSED" }, log: true }
      : { status: 503, body: { error: "Monerium did not answer. Try again in a moment.", code: "MONERIUM_UNREACHABLE" }, log: true };
  }
  if (err instanceof EncryptionUnavailableError) {
    return {
      status: 503,
      body: { error: "This connection cannot be used right now. Zold has logged it; try again later or write to support@zoldhq.com.", code: "ENCRYPTION_UNAVAILABLE" },
      log: true,
    };
  }
  return undefined;
}
