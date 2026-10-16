/**
 * The EPC QR payload ("GiroCode", EPC069-12 version 002): what a European
 * banking app scans to prefill a SEPA credit transfer. No amount leaves the
 * field empty for the payer to type. The trailing "information" line is
 * optional and omitted.
 *
 * shortcut: qr.ts encodes level L up to version 6 (134 bytes) where EPC069-12
 * asks for level M; bank apps read level L, but no banking app has scanned one
 * yet. Extend qr.ts past version 6 at level M if one refuses it.
 */
import { QR_MAX_BYTES } from "./qr.js";
import { normalizeIban, SEPA_REMITTANCE_MAX } from "./sepa.js";

const EPC_NAME_MAX = 70;
const EPC_AMOUNT_MAX = 999_999_999.99;

/** A payload that cannot be encoded as given. Never shortened instead: a cut
 *  beneficiary name fails Verification of Payee, so the page shows no QR. */
export class EpcQrError extends Error {}

export function epcQrPayload(p: { name: string; iban: string; bic?: string; amountEur?: number; remittance: string }): string {
  if (p.amountEur !== undefined && !(p.amountEur >= 0.01 && p.amountEur <= EPC_AMOUNT_MAX)) {
    throw new EpcQrError(`an EPC QR amount is 0.01 to ${EPC_AMOUNT_MAX} EUR`);
  }
  const name = p.name.replace(/\s+/g, " ").trim();
  if (!name || [...name].length > EPC_NAME_MAX) throw new EpcQrError(`an EPC QR beneficiary name is 1 to ${EPC_NAME_MAX} characters`);
  const remittance = p.remittance.replace(/\s+/g, " ").trim();
  if (remittance.length > SEPA_REMITTANCE_MAX) throw new EpcQrError(`EPC QR remittance is at most ${SEPA_REMITTANCE_MAX} characters`);
  const amount = p.amountEur === undefined ? "" : `EUR${p.amountEur.toFixed(2)}`;
  const payload = ["BCD", "002", "1", "SCT", p.bic ?? "", name, normalizeIban(p.iban), amount, "", "", remittance].join("\n");
  if (new TextEncoder().encode(payload).length > QR_MAX_BYTES) throw new EpcQrError("the bank details are too long for the QR encoder");
  return payload;
}
