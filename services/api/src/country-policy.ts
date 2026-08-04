export type MoneriumResidencyTier = "low" | "medium" | "high" | "restricted" | "prohibited";

export interface CountryBlock {
  code: string;
  reason: "monerium_prohibited_residency" | "monerium_unsupported_residency";
  message: string;
}

const MONERIUM_RESIDENCY_TIERS: Record<string, MoneriumResidencyTier> = Object.fromEntries([
  ...["AX", "AL", "AD", "AQ", "AG", "AR", "AW", "AU", "AT", "BE", "BZ", "BM", "BQ", "BW", "BV", "IO", "BN", "BI", "CA", "KY", "CL", "CX", "CC", "CK", "CR", "HR", "CW", "CY", "CZ", "DK", "DM", "EC", "ER", "FK", "FO", "FI", "FR", "GF", "PF", "TF", "GE", "DE", "GI", "GR", "GL", "GD", "GP", "GG", "HM", "VA", "IS", "IE", "IM", "IL", "IT", "JP", "JE", "JO", "KI", "LI", "LU", "MO", "MK", "MV", "MH", "MQ", "MU", "YT", "FM", "MD", "MN", "ME", "MS", "NR", "NL", "NC", "NZ", "NU", "NF", "MP", "NO", "OM", "PY", "PE", "PN", "PT", "RE", "BL", "SH", "LC", "MF", "PM", "VC", "SM", "SC", "SG", "SX", "SK", "SI", "GS", "KR", "ES", "SD", "SJ", "SE", "CH", "TW", "TK", "TN", "TV", "GB", "UM", "UY"].map((code) => [code, "low"] as const),
  ...["AS", "AI", "AZ", "BS", "BH", "BD", "BT", "BR", "CV", "CO", "DO", "EG", "SV", "EE", "ET", "FJ", "GM", "GH", "GU", "GT", "GY", "HN", "HK", "HU", "IN", "ID", "KG", "LT", "MW", "MY", "MT", "MX", "MA", "PK", "PW", "PL", "QA", "RO", "RW", "KN", "WS", "ST", "SA", "LK", "TH", "TL", "TO", "TR", "TC", "VI", "ZM", "ZW"].map((code) => [code, "medium"] as const),
  ...["BB", "BJ", "KH", "CN", "KM", "DJ", "SZ", "GA", "GN", "GW", "LV", "LS", "LR", "MG", "MR", "NI", "NE", "PH", "CG", "SL", "SB", "SR", "TJ", "TG", "TM", "AE"].map((code) => [code, "high"] as const),
  ...["BG", "MC"].map((code) => [code, "restricted"] as const),
  ...["AF", "DZ", "AO", "AM", "BY", "BO", "BA", "BF", "CM", "CF", "TD", "CI", "CU", "CD", "GQ", "HT", "IR", "IQ", "JM", "KZ", "KE", "KW", "LA", "LB", "LY", "ML", "MZ", "MM", "NA", "NP", "NG", "KP", "PS", "PA", "PG", "PR", "RU", "SN", "RS", "ZA", "SS", "SY", "TZ", "TT", "UG", "UA", "US", "UZ", "VU", "VE", "VN", "VG", "YE"].map((code) => [code, "prohibited"] as const),
]);

const COUNTRY_ALIASES: Record<string, string> = {
  DPRK: "KP",
  "NORTH KOREA": "KP",
  PALESTINE: "PS",
  PALASTINE: "PS",
  "PALESTINIAN TERRITORIES": "PS",
  "STATE OF PALESTINE": "PS",
  "TURKEY": "TR",
  TURKIYE: "TR",
  "TÜRKIYE": "TR",
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  USA: "US",
};

const regionNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

for (const code of Object.keys(MONERIUM_RESIDENCY_TIERS)) {
  const name = regionNames?.of(code);
  if (name) COUNTRY_ALIASES[name.toUpperCase()] = code;
}

export function normaliseCountryCode(country: string): string {
  const trimmed = country.trim().toUpperCase();
  if (COUNTRY_ALIASES[trimmed]) return COUNTRY_ALIASES[trimmed];
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export function moneriumResidencyTier(country: string): MoneriumResidencyTier | null {
  return MONERIUM_RESIDENCY_TIERS[normaliseCountryCode(country)] ?? null;
}

export function countryBlock(country: string): CountryBlock | null {
  const code = normaliseCountryCode(country);
  const tier = MONERIUM_RESIDENCY_TIERS[code];
  if (!tier) {
    return {
      code,
      reason: "monerium_unsupported_residency",
      message: "Zold is available only in Monerium-supported countries.",
    };
  }
  if (tier === "prohibited") {
    return {
      code,
      reason: "monerium_prohibited_residency",
      message: "Zold is not available in this country under Monerium's current country policy.",
    };
  }
  return null;
}

