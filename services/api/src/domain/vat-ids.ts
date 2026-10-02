/**
 * VAT identification numbers: what each country's looks like.
 *
 * A shape check only: it catches a typo or a missing country prefix while the
 * number is typed. Whether the number is registered, and to whom, is VIES's
 * answer for an EU number (adapters/vies.ts); Switzerland and the UK have
 * their own registers, which Zold does not query.
 *
 * Patterns are the body after the two-letter prefix, from the European
 * Commission's VIES format list, the Swiss UID register (CHE plus nine digits,
 * written "CHE-123.456.789 MWST") and HMRC (9 or 12 digits, or GD/HA plus three
 * for government and health bodies). Greece files under EL, Northern Ireland
 * under XI. Checksums are not verified.
 */

export interface VatIdFormat {
  /** The prefix the number is written with (EL for Greece, XI for Northern Ireland). */
  prefix: string;
  /** The country the prefix belongs to, ISO 3166 (GR for EL, GB for XI). */
  country: string;
  /** Regex source for the body after the prefix, anchored by the caller. */
  body: string;
  example: string;
  /** Checked in VIES (EU and XI). */
  vies: boolean;
}

const F = (prefix: string, country: string, body: string, example: string, vies = true): VatIdFormat =>
  ({ prefix, country, body, example, vies });

export const VAT_ID_FORMATS: Record<string, VatIdFormat> = Object.fromEntries([
  F("AT", "AT", "U\\d{8}", "ATU12345678"),
  F("BE", "BE", "[01]\\d{9}", "BE0123456789"),
  F("BG", "BG", "\\d{9,10}", "BG123456789"),
  F("CY", "CY", "\\d{8}[A-Z]", "CY12345678X"),
  F("CZ", "CZ", "\\d{8,10}", "CZ12345678"),
  F("DE", "DE", "\\d{9}", "DE123456789"),
  F("DK", "DK", "\\d{8}", "DK12345678"),
  F("EE", "EE", "\\d{9}", "EE123456789"),
  F("EL", "GR", "\\d{9}", "EL123456789"),
  F("ES", "ES", "[A-Z0-9]\\d{7}[A-Z0-9]", "ESX1234567X"),
  F("FI", "FI", "\\d{8}", "FI12345678"),
  F("FR", "FR", "[A-HJ-NP-Z0-9]{2}\\d{9}", "FR12345678901"),
  F("HR", "HR", "\\d{11}", "HR12345678901"),
  F("HU", "HU", "\\d{8}", "HU12345678"),
  F("IE", "IE", "\\d{7}[A-W][A-I]?|\\d[A-Z+*]\\d{5}[A-W]", "IE1234567WA"),
  F("IT", "IT", "\\d{11}", "IT12345678901"),
  F("LT", "LT", "\\d{9}|\\d{12}", "LT123456789"),
  F("LU", "LU", "\\d{8}", "LU12345678"),
  F("LV", "LV", "\\d{11}", "LV12345678901"),
  F("MT", "MT", "\\d{8}", "MT12345678"),
  F("NL", "NL", "\\d{9}B\\d{2}", "NL123456789B01"),
  F("PL", "PL", "\\d{10}", "PL1234567890"),
  F("PT", "PT", "\\d{9}", "PT123456789"),
  F("RO", "RO", "\\d{2,10}", "RO1234567890"),
  F("SE", "SE", "\\d{12}", "SE123456789001"),
  F("SI", "SI", "\\d{8}", "SI12345678"),
  F("SK", "SK", "\\d{10}", "SK1234567890"),
  F("XI", "GB", "\\d{9}|\\d{12}|GD\\d{3}|HA\\d{3}", "XI123456789"),
  F("CH", "CH", "E\\d{9}(?:MWST|TVA|IVA)?", "CHE-123.456.789 MWST", false),
  F("GB", "GB", "\\d{9}|\\d{12}|GD\\d{3}|HA\\d{3}", "GB123456789", false),
].map((f) => [f.prefix, f]));

/** The format a customer in `country` writes their VAT ID in. Greece is EL;
 *  the UK is GB (XI for Northern Ireland is accepted too, by its prefix). */
export function vatIdFormatFor(country: string | undefined): VatIdFormat | undefined {
  const c = (country ?? "").toUpperCase();
  return Object.values(VAT_ID_FORMATS).find((f) => f.country === c && f.prefix !== "XI");
}

export function normaliseVatId(v: string): string {
  return v.toUpperCase().replace(/[\s.\-/]/g, "");
}

export type VatIdShape =
  | { ok: true; prefix: string; country: string; number: string; vies: boolean }
  | { ok: false; reason: string; example?: string };

/** Read a VAT ID's shape: its prefix, its country, and whether the body fits. */
export function vatIdShape(raw: string): VatIdShape {
  const s = normaliseVatId(raw);
  const prefix = s.slice(0, 2);
  const f = VAT_ID_FORMATS[prefix];
  if (!f) {
    return { ok: false, reason: `${raw.trim() || "This"} does not start with a country prefix Zold knows (such as DE, FR, ATU…, CHE or GB).` };
  }
  const body = s.slice(2);
  if (!new RegExp(`^(?:${f.body})$`).test(body)) {
    return { ok: false, reason: `${raw.trim()} does not look like a VAT ID from ${f.country}. It is written like ${f.example}.`, example: f.example };
  }
  return { ok: true, prefix, country: f.country, number: body, vies: f.vies };
}

/** An EU VAT ID (VIES-checkable: the member states and XI), by shape. */
export function euVatIdLooksValid(raw: string): boolean {
  const s = vatIdShape(raw);
  return s.ok && s.vies;
}
