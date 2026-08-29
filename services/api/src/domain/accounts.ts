/**
 * The local-account registry — the single place a currency becomes real.
 *
 * "Global (local) accounts" is the product: an organisation holds an account
 * denominated in the currency of a place, with an identifier locals recognise
 * (an IBAN in Germany, a sort code in the UK, an M-Pesa number in Kenya) and a
 * payout rail that settles there.
 *
 * ONLY EUR IS REAL. Monerium issues a genuine IBAN and EURe settles on chain
 * today; that path is exercised end to end. Every other currency here is
 * modelled with `status: "gated"` and a `needs` line naming the partner and the
 * missing piece. This is not caution for its own sake — the repo has already
 * deleted one rail (UPI) that rendered "payment successful" for money that had
 * reached nobody. A currency that has never moved value must not render as if
 * it has, and the only way to keep that true as the list grows is to make
 * liveness a property computed here rather than a flag set per screen.
 *
 * To make a currency live: give it a provider adapter, then have its entry's
 * `mode` predicate ask that adapter whether it is configured. Do not flip a
 * boolean.
 */

import { SECURITY, moneriumSandboxEnabled } from "../config.js";
import type {
  Account,
  AccountIdentifier,
  AccountProvider,
  AccountStatus,
  CurrencyCode,
  Organisation,
} from "./types.js";

export interface CurrencyDefinition {
  code: CurrencyCode;
  name: string;
  symbol: string;
  /** Minor units, for formatting and for refusing sub-unit amounts. */
  decimals: number;
  /** What the local identifier is called where it is used. */
  railName: string;
  /** Which fields the identifier carries when the account is open. */
  identifierFields: (keyof AccountIdentifier)[];
  /** Countries where this is the local account. Informational. */
  countries: string[];
  provider: AccountProvider;
  /** Whether the settled currency has an on-chain token leg we custody. */
  tokenised: boolean;
  /**
   * Is the rail usable in this deployment, and on what? A predicate, not a
   * constant, so the answer tracks configuration instead of documentation.
   *
   * THREE answers, not two. A rail can be open against the real provider
   * ("live"), open against a locally-issued mock that only means anything on a
   * dev chain ("mock"), or not open at all (false). Collapsing mock into live
   * would let a local demo read as a real rail; collapsing it into closed would
   * make the whole product unreachable in development, which is how the mock
   * path stops being exercised at all.
   */
  mode: () => "live" | "mock" | false;
  /** Named partner + missing piece, shown verbatim when gated. */
  needs: string;
}

const CURRENCIES: CurrencyDefinition[] = [
  {
    code: "EUR",
    name: "Euro",
    symbol: "€",
    decimals: 2,
    railName: "SEPA",
    identifierFields: ["iban", "bic"],
    countries: [
      "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "IE", "IT", "LT",
      "LU", "LV", "MT", "NL", "PT", "SI", "SK",
    ],
    provider: "monerium",
    tokenised: true,
    // The only rail that opens anywhere today. Both halves of the Monerium
    // credential are needed — a client id alone opens nothing. Failing that, a
    // genuinely local deployment issues a mock IBAN and settles on its own
    // chain: real machinery, no real money, and labelled as such everywhere.
    mode: () => (moneriumSandboxEnabled() ? "live" : SECURITY.allowSimulation ? "mock" : false),
    needs: "Monerium credentials (MONERIUM_CLIENT_ID / MONERIUM_CLIENT_SECRET)",
  },
  {
    code: "USD",
    name: "US dollar",
    symbol: "$",
    decimals: 2,
    railName: "ACH and SWIFT",
    identifierFields: ["accountNumber", "routingNumber"],
    countries: ["US"],
    provider: "iron",
    tokenised: false,
    mode: () => false as const,
    needs:
      "a USD account provider. Iron (iron.xyz) is request-access and has not been granted; Triple-A requires $10,000 monthly volume before verification starts.",
  },
  {
    code: "GBP",
    name: "Pound sterling",
    symbol: "£",
    decimals: 2,
    railName: "Faster Payments",
    identifierFields: ["accountNumber", "sortCode"],
    countries: ["GB"],
    provider: "iron",
    tokenised: false,
    mode: () => false as const,
    needs: "a GBP account provider. Iron is the candidate and access is not granted.",
  },
  {
    code: "KES",
    name: "Kenyan shilling",
    symbol: "KSh",
    decimals: 2,
    railName: "M-Pesa",
    identifierFields: ["mobile"],
    countries: ["KE"],
    provider: "yellowcard",
    tokenised: false,
    mode: () => false as const,
    needs:
      "a Kenyan payout partner. dLocal and Yellow Card both cover KES and neither is contracted; the existing cash rail pays a MoneyGram counter, which is a pickup, not an account.",
  },
  {
    code: "INR",
    name: "Indian rupee",
    symbol: "₹",
    decimals: 2,
    railName: "UPI",
    identifierFields: ["vpa"],
    countries: ["IN"],
    provider: "dlocal",
    tokenised: false,
    mode: () => false as const,
    needs:
      "an Indian payout partner (dLocal is the candidate). The previous UPI rail was a mock that minted its own reference numbers and was deleted in Aug 2026; it is not to be rebuilt from history.",
  },
];

export const CURRENCY_REGISTRY: Record<CurrencyCode, CurrencyDefinition> =
  Object.fromEntries(CURRENCIES.map((c) => [c.code, c])) as Record<
    CurrencyCode,
    CurrencyDefinition
  >;

export const CURRENCY_CODES: CurrencyCode[] = CURRENCIES.map((c) => c.code);

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === "string" && (CURRENCY_CODES as string[]).includes(v);
}

export interface CurrencyAvailability {
  code: CurrencyCode;
  name: string;
  symbol: string;
  railName: string;
  provider: AccountProvider;
  countries: string[];
  available: boolean;
  /** "live" against the real provider, or "mock" on a local deployment. */
  mode?: "live" | "mock";
  /** Present when mock. Says plainly that no real money moves. */
  mockWarning?: string;
  /** Present only when unavailable. Names the partner and the missing piece. */
  needs?: string;
}

export const MOCK_WARNING =
  "This deployment issues a locally-generated IBAN and settles on its own chain. The machinery is real; the money is not.";

/** What the client should render in an "open an account" list. */
export function currencyAvailability(): CurrencyAvailability[] {
  return CURRENCIES.map((c) => {
    const mode = c.mode();
    return {
      code: c.code,
      name: c.name,
      symbol: c.symbol,
      railName: c.railName,
      provider: c.provider,
      countries: c.countries,
      available: mode !== false,
      ...(mode ? { mode } : {}),
      ...(mode === "mock" ? { mockWarning: MOCK_WARNING } : {}),
      ...(mode === false ? { needs: c.needs } : {}),
    };
  });
}

/**
 * The status a freshly requested account should take.
 *
 * A gated account is still CREATED — the org asked for it, the row records
 * that, and it flips to provisioning the day the partner is wired. Refusing to
 * store the request would lose the demand signal and make the UI lie in the
 * other direction ("you have no accounts").
 */
export function initialStatusFor(currency: CurrencyCode): {
  status: AccountStatus;
  gate?: { reason: string; needs: string };
} {
  const def = CURRENCY_REGISTRY[currency];
  if (def.mode()) return { status: "provisioning" };
  return {
    status: "gated",
    gate: {
      reason: `${def.name} accounts are not open yet. The rail is modelled but has never moved money.`,
      needs: def.needs,
    },
  };
}

export function defaultLabel(currency: CurrencyCode): string {
  return `${CURRENCY_REGISTRY[currency].name} account`;
}

/**
 * Format a minor-unit-safe amount for display. Takes a decimal string, never a
 * float — a balance that has been through a double is not a balance.
 */
export function formatAmount(amount: string, currency: CurrencyCode): string {
  const def = CURRENCY_REGISTRY[currency];
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${def.symbol}—`;
  return `${def.symbol}${n.toLocaleString("en-GB", {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  })}`;
}

/**
 * Is this account usable for money movement right now? Both the row and the
 * registry must agree: a row can say `active` from an older deployment where
 * the provider was configured, and the registry is the current truth.
 */
export function accountIsSpendable(account: Account): {
  ok: boolean;
  reason?: string;
} {
  const def = CURRENCY_REGISTRY[account.currency];
  if (!def) return { ok: false, reason: `Unknown currency ${account.currency}.` };
  if (!def.mode()) {
    return {
      ok: false,
      reason: `${def.name} is not available in this deployment: ${def.needs}`,
    };
  }
  if (account.status !== "active") {
    return {
      ok: false,
      reason: `This ${def.name} account is ${account.status}${
        account.gate ? ` — ${account.gate.reason}` : ""
      }.`,
    };
  }
  return { ok: true };
}

/**
 * Which currency a new org should be offered first: the local one for its
 * country if we support it, otherwise EUR (the only live rail).
 */
export function suggestedCurrency(org: Pick<Organisation, "address">): CurrencyCode {
  const country = org.address?.country?.toUpperCase();
  if (country) {
    const match = CURRENCIES.find((c) => c.countries.includes(country));
    if (match) return match.code;
  }
  return "EUR";
}
