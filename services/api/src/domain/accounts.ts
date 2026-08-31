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
  /** Whether the settled currency has an on-chain token leg WE CUSTODY. This
   *  is about us, not about the token existing: ZCHF and cNGN are real and
   *  liquid and we hold neither, so both are false. */
  tokenised: boolean;
  /**
   * A settlement token that exists for this currency, whether or not we touch
   * it. Present so the product can SHOW a currency honestly — "this token is
   * real, here is who issues it, and here is what we still lack" — instead of
   * either hiding it or implying we support it.
   *
   * Addresses are VERIFIED ON CHAIN (name/symbol/decimals read from the
   * contract), not copied from a listing page. `backing` is the sentence that
   * matters most for a holder, because these differ in kind: e-money with a
   * redemption right against a licensed issuer is not the same instrument as a
   * crypto-collateralised peg, and a UI that renders both as "CHF" hides that.
   */
  token?: {
    symbol: string;
    issuer: string;
    decimals: number;
    /** chain -> verified contract address. */
    contracts: Record<string, string>;
    /** Where the supply actually is, when it is lopsided. */
    liquidityNote?: string;
    backing: string;
  };
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
    token: {
      symbol: "EURe",
      issuer: "Monerium EMI ehf — an e-money institution licensed by the Central Bank of Iceland",
      decimals: 18,
      // The chain the app runs on. Monerium's production /tokens also lists
      // ethereum, gnosis, polygon, arbitrum and linea.
      contracts: { "base-sepolia": "0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85" },
      backing:
        "Euro deposits held as e-money by a licensed issuer. This is the one instrument here that " +
        "carries a REDEMPTION RIGHT AT PAR against a named, regulated counterparty — EURe is an " +
        "e-money token under MiCA, not a collateral-backed peg. That difference is the reason this " +
        "column exists: it is what separates EURe from ZCHF, and neither label tells you on its own.",
    },
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
    code: "CHF",
    name: "Swiss franc",
    symbol: "CHF",
    decimals: 2,
    railName: "SIC / Swiss IBAN",
    identifierFields: ["iban"],
    countries: ["CH", "LI"],
    provider: "none",
    // We custody no ZCHF. The token is real; our holding of it is not.
    tokenised: false,
    mode: () => false as const,
    token: {
      symbol: "ZCHF",
      issuer: "Frankencoin — a decentralised protocol, not a company",
      decimals: 18,
      // Verified on Ethereum mainnet: name() "Frankencoin", symbol() "ZCHF",
      // decimals() 18, supply ~30.6M at the time of writing.
      contracts: { ethereum: "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB" },
      backing:
        "Crypto collateral, not francs in a bank. ZCHF is minted against collateral posted by " +
        "borrowers and held by the protocol, with the peg defended by auctions — so there is NO " +
        "issuer who owes a holder redemption at par. That is a different instrument from EURe, " +
        "which is e-money and carries a redemption right against a licensed issuer. Under MiCA it " +
        "is a crypto-asset rather than an e-money token, and the protocol argues some provisions " +
        "do not apply to it because it is decentralised — which is an argument, not a ruling.",
    },
    needs:
      "a Swiss account provider. The ZCHF token exists and is liquid, but a token is not an account: " +
      "nobody here issues a Swiss IBAN, there is no CHF on- or off-ramp wired, and we hold no ZCHF. " +
      "Frankencoin is a protocol rather than a counterparty, so there is also no partner to contract " +
      "with for the fiat leg — that would be a separate Swiss institution.",
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
    code: "NGN",
    name: "Nigerian naira",
    symbol: "₦",
    decimals: 2,
    railName: "NIP (NUBAN transfer)",
    identifierFields: ["nuban", "bankCode"],
    countries: ["NG"],
    provider: "yellowcard",
    tokenised: false,
    mode: () => false as const,
    token: {
      symbol: "cNGN",
      issuer: "Wrapped CBDC, under the Africa Stablecoin Consortium",
      decimals: 6,
      // Verified on chain: name() "cNGN", symbol() "cNGN", decimals() 6 on all
      // four. Addresses were taken from a third-party listing and then CHECKED
      // against the contracts, because a listing page is a claim.
      contracts: {
        base: "0x46C85152bFe9f96829aA94755D9f915F9B10EF5F",
        bnb: "0xa8AEA66B361a8d53e8865c62D142167Af28Af058",
        ethereum: "0x17CDB2a01e7a34CbB3DD4b83260B05d0274C8dab",
        polygon: "0x52828daa48C1a9A06F37500882b42daf0bE04C3B",
      },
      liquidityNote:
        "Supply is overwhelmingly on Base (~2.58bn) and BNB Chain (~699m); Ethereum (~137k) and " +
        "Polygon (~12.6k) are effectively empty. Base is also our app chain, so that is the only " +
        "deployment worth designing against.",
      backing:
        "Naira reserves, under Nigerian regulation — issued by Wrapped CBDC and overseen by the " +
        "Securities and Exchange Commission of Nigeria under the 2025 Investments and Securities " +
        "Act, with the Central Bank retaining payment-system oversight. That is a NIGERIAN " +
        "perimeter, not an EEA one: it says nothing about MiCA, and an EEA holder gets no EU " +
        "protection from it.",
    },
    needs:
      "a Nigerian payout partner and an issuer relationship. Yellow Card covers Nigeria — their largest "
      + "market — and is uncontracted. cNGN is real, regulated in Nigeria and " +
      "liquid on Base, but we hold none and have no way in or out: their API needs a merchant " +
      "account and API keys we have not requested. Note also that Bridge — our licensed transfer " +
      "seam — supports only USDC and EURC for EEA users under MiCA, so cNGN cannot move through it " +
      "for a European entity at all.",
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
  /**
   * A settlement token that exists for this currency, shown even when the rail
   * is closed. `heldByUs` is the field that stops this being a claim: it is
   * false for every token we do not custody, so a client rendering a token can
   * never imply a balance.
   */
  token?: {
    symbol: string;
    issuer: string;
    decimals: number;
    contracts: Record<string, string>;
    liquidityNote?: string;
    backing: string;
    heldByUs: boolean;
  };
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
      // Shown whether or not the rail is open. A currency whose token is real
      // and liquid but whose ACCOUNT does not exist is a genuinely different
      // state from one with no token at all, and flattening the two is how a
      // list of currencies stops carrying information.
      ...(c.token ? { token: { ...c.token, heldByUs: c.tokenised } } : {}),
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
