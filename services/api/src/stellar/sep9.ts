/**
 * SEP-9 field shaping.
 *
 * SEP-9 is the shared vocabulary anchors use for customer data, but anchors
 * differ in HOW they want it and WHICH subset they accept. Two differences
 * bit us and are encoded here rather than assumed:
 *
 *  - `address_country_code` is ISO 3166-1 **alpha-3** ("DEU", "USA"), not the
 *    alpha-2 the rest of this app stores for a user's country.
 *  - MoneyGram documents exactly nine fields it reads, passed in the SEP-24
 *    interactive POST body. Stellar's test anchor instead wants them over
 *    SEP-12, and requires `email_address`, which MoneyGram does not list.
 *
 * So we keep one standard-shaped mapping and let each transport pick its
 * subset, instead of pretending one anchor's behaviour is the protocol.
 */

/**
 * ISO 3166-1 alpha-2 -> alpha-3, for the corridors this app serves plus the
 * common senders. Deliberately partial: an unknown code returns undefined and
 * the field is omitted, because transmitting a *wrong* country on a money
 * transmission is worse than omitting an optional one. Extend as corridors
 * open.
 */
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  AE: "ARE", AR: "ARG", AT: "AUT", AU: "AUS", BD: "BGD", BE: "BEL", BG: "BGR",
  BR: "BRA", CA: "CAN", CH: "CHE", CI: "CIV", CL: "CHL", CM: "CMR", CN: "CHN",
  CO: "COL", CY: "CYP", CZ: "CZE", DE: "DEU", DK: "DNK", DO: "DOM", EE: "EST",
  EG: "EGY", ES: "ESP", ET: "ETH", FI: "FIN", FR: "FRA", GB: "GBR", GH: "GHA",
  GR: "GRC", GT: "GTM", HK: "HKG", HR: "HRV", HU: "HUN", ID: "IDN", IE: "IRL",
  IL: "ISR", IN: "IND", IS: "ISL", IT: "ITA", JP: "JPN", KE: "KEN", KR: "KOR",
  LK: "LKA", LT: "LTU", LU: "LUX", LV: "LVA", MA: "MAR", MT: "MLT", MX: "MEX",
  MY: "MYS", NG: "NGA", NL: "NLD", NO: "NOR", NP: "NPL", NZ: "NZL", PE: "PER",
  PH: "PHL", PK: "PAK", PL: "POL", PT: "PRT", RO: "ROU", RS: "SRB", RW: "RWA",
  SA: "SAU", SE: "SWE", SG: "SGP", SI: "SVN", SK: "SVK", SN: "SEN", TH: "THA",
  TN: "TUN", TR: "TUR", TZ: "TZA", UA: "UKR", UG: "UGA", US: "USA", VN: "VNM",
  ZA: "ZAF", ZM: "ZMB", ZW: "ZWE",
};

/** Normalise a country to SEP-9's alpha-3, or undefined if we cannot be sure. */
export function toAlpha3(code?: string): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(c)) return c;
  if (/^[A-Z]{2}$/.test(c)) return ALPHA2_TO_ALPHA3[c];
  return undefined;
}

/**
 * The exact fields MoneyGram documents for the SEP-24 interactive POST body.
 * Anything outside this list is dropped for that transport — sending fields an
 * anchor has not documented is how an integration starts guessing.
 */
export const MONEYGRAM_SEP9_FIELDS = [
  "first_name",
  "last_name",
  "mobile_number",
  "birth_date",
  "address",
  "city",
  "postal_code",
  "address_country_code",
  "state_or_province",
] as const;

/** `state_or_province` is ISO-3166-2 (e.g. "US-MN") and only for these. */
const SUBDIVISION_COUNTRIES = new Set(["USA", "CAN", "MEX"]);

/** Keep only what a given anchor documents, dropping empties. */
export function pickFields(
  fields: Record<string, string | undefined>,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowed) {
    const v = fields[name];
    if (typeof v === "string" && v.trim() !== "") out[name] = v.trim();
  }
  return out;
}

/**
 * MoneyGram's subset, with its own constraints applied: subdivisions only for
 * the three countries that use them, so we never send "DE-BE".
 */
export function moneygramSep9(fields: Record<string, string | undefined>): Record<string, string> {
  const picked = pickFields(fields, MONEYGRAM_SEP9_FIELDS);
  if (picked.state_or_province && !SUBDIVISION_COUNTRIES.has(picked.address_country_code ?? "")) {
    delete picked.state_or_province;
  }
  return picked;
}
