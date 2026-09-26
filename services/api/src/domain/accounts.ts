/**
 * The local-account registry: the one place that decides whether a currency
 * is live.
 *
 * An organisation holds an account denominated in the currency of a place,
 * with an identifier locals recognise (an IBAN in Germany, a sort code in the
 * UK, an M-Pesa number in Kenya) and a payout rail that settles there.
 *
 * Only EUR is live: Monerium issues the IBAN and EURe settles on chain. Every
 * other currency has `status: "gated"` and a `needs` line naming the partner
 * and the missing piece. A mock rail shows "payment successful" for money that
 * reached nobody, so liveness is computed here, not flagged per screen.
 *
 * To make a currency live: give it a provider adapter, then have its entry's
 * `mode` predicate ask that adapter whether it is configured. Do not flip a
 * boolean.
 */

import { MONERIUM, moneriumOAuthEnabled } from "../config.js";
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
  /** Whether we custody an on-chain token leg for this currency. ZCHF and
   *  cNGN tokens exist and are liquid, but we hold neither, so both are false. */
  tokenised: boolean;
  /**
   * A settlement token that exists for this currency, whether or not we use
   * it. Lets the UI show who issues it and what we still lack, without
   * implying we support it.
   *
   * Addresses were verified on chain (name/symbol/decimals read from the
   * contract). `backing` tells a holder what kind of instrument it is: e-money
   * with a redemption right against a licensed issuer differs from a
   * crypto-collateralised peg, even if both display as "CHF".
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
   * Whether the rail is usable in this deployment: "live" (open against the
   * real provider) or false. A predicate so it tracks configuration.
   */
  mode: () => "live" | false;
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
    // Open when a user can bring a Monerium account: by OAuth (an OAuth client
    // id) or with their own API keys (needs the encryption key that stores the
    // secret). App-level credentials alone open nothing for a user any more.
    mode: () => (moneriumOAuthEnabled() || Boolean(MONERIUM.tokenEncryptionKey) ? "live" : false),
    token: {
      symbol: "EURe",
      issuer: "Monerium EMI ehf — an e-money institution licensed by the Central Bank of Iceland",
      decimals: 18,
      // The chain the app runs on. Monerium's production /tokens also lists
      // ethereum, gnosis, polygon, arbitrum and linea.
      // From Monerium's own /tokens (production and sandbox), Sep 2026.
      contracts: {
        base: "0xbf6e2966A9C3D99C9E4D069E04f7Bdb9C8aa762C",
        "base-sepolia": "0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85",
      },
      backing:
        "Euro deposits held as e-money by a licensed issuer. This is the one instrument here that " +
        "carries a REDEMPTION RIGHT AT PAR against a named, regulated counterparty — EURe is an " +
        "e-money token under MiCA, not a collateral-backed peg. That difference is the reason this " +
        "column exists: it is what separates EURe from ZCHF, and neither label tells you on its own.",
    },
    needs: "a Monerium connection path (MONERIUM_OAUTH_CLIENT_ID and/or MONERIUM_TOKEN_ENCRYPTION_KEY)",
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
      "a Kenyan payout partner. dLocal and Yellow Card both cover KES and neither is contracted.",
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
      // four. Addresses came from a third-party listing and were checked
      // against the contracts.
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
      "account and API keys we have not requested.",
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
      "an Indian payout partner (dLocal is the candidate). A UPI rail without one would be a mock minting its own reference numbers, which is not to be built.",
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
      ...(mode === false ? { needs: c.needs } : {}),
      // Shown whether or not the rail is open: a currency with a liquid token
      // but no account is a different state from one with no token at all.
      ...(c.token ? { token: { ...c.token, heldByUs: c.tokenised } } : {}),
    };
  });
}

/**
 * The status a freshly requested account should take.
 *
 * A gated account is still created: the row records that the org asked for
 * it, and it moves to provisioning once the partner is wired. Refusing it
 * would lose the demand signal and show "you have no accounts".
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
