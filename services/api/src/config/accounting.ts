import { envNumber } from "./env.js";

/**
 * VIES, the EU's VAT number register (adapters/vies.ts). Public, no key. The
 * URL is overridable so tests can stand a stub in; `VIES_URL=off` turns the
 * lookup off, and every check then reads "unavailable".
 */
export const VIES = {
  url: process.env.VIES_URL ?? "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number",
  timeoutMs: Number(process.env.VIES_TIMEOUT_MS ?? 10_000),
} as const;

/** GetMyInvoices, the document inbox the accountant reads. The key is per
 *  organisation and encrypted at rest; nothing here holds one. */
export const GETMYINVOICES = {
  BASE_URL: process.env.GETMYINVOICES_BASE_URL ?? "https://api.getmyinvoices.com/accounts/v3",
  TIMEOUT_MS: envNumber("GETMYINVOICES_TIMEOUT_MS", 20_000, { min: 1000 }),
};
