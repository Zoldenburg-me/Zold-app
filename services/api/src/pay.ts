/**
 * Payment pages — a shareable handle that resolves to a page-scoped deposit
 * address someone can pay.
 *
 * The page shows a handle, the address, a QR code, and the chain and token it
 * expects. No amount field and no wallet connection: the payer's wallet does
 * both.
 *
 * Not private, and the page says so. The page has its own deposit address so
 * unrelated transfers into the user's main wallet do not trigger its
 * settlement rule, but it is one public address per handle, visible to anyone
 * with the handle on a block explorer.
 *
 * Security: `publicPayee` is an allowlist naming the fields that go out. The
 * account object next to it holds an IBAN, an email, a KYC decision, a Travel
 * Rule profile and a private key. Don't switch to a redaction list; it would
 * leak the next field somebody adds.
 */
import type { User } from "./store.js";

/** 3-30 characters, lowercase alphanumeric and internal hyphens. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;

/**
 * Handles the product needs for itself, or that would mislead.
 *
 * Route names are here because a payment page lives at `/pay/:handle` and
 * shares an origin with the app; a handle called `settings` invites a
 * convincing phish. `0x` prefixes are refused separately: a handle that looks
 * like an address is a trap when the page's whole job is showing an address.
 */
const RESERVED = new Set([
  "about", "account", "accounts", "admin", "api", "app", "assets", "blog", "checkout",
  "contact", "dashboard", "docs", "faq", "favicon", "health", "help", "home", "index",
  "landing", "legal", "login", "logout", "me", "new", "pay", "payment", "payments",
  "privacy", "qr", "rates", "robots", "root", "security", "settings", "signup",
  "sitemap", "static", "status", "support", "terms", "transfer", "transfers", "user",
  "users", "www", "zold", "zoldenburg",
]);

/**
 * Names a handle may not impersonate: us, staff roles, partners, and
 * well-known people. A handle sits next to a deposit address, so one that
 * reads as any of these collects money on borrowed trust. Not complete and
 * cannot be; these are the names a phish reaches for first.
 *
 * Checked when a handle is claimed, never when one is looked up: a page that
 * exists keeps working if a later list would have refused it.
 */

/** Refused anywhere, including inside a longer handle (`zold-support`,
 *  `zoldpay`, `vitalikbuterin`). Only words long or rare enough that a hit is
 *  almost always the name itself — `admin` does also catch `badminton`. */
const BLOCKED_ANYWHERE = [
  "zold", "support", "admin",
  "monerium", "gnosis", "bebop", "uniswap", "cowswap", "moonpay", "shopify",
  "sevdesk", "lexware", "coinbase", "binance", "metamask",
  "vitalik", "buterin", "satoshi", "nakamoto", "elonmusk", "changpeng", "saylor",
];

/** Refused as the whole handle or as one hyphen-separated part, not inside a
 *  longer word: `iron` blocks `iron-pay` but not `ironing`, and `lifi` would
 *  otherwise block `amplifier`. */
const BLOCKED_AS_WORD = new Set([
  "iron", "lifi", "safe", "base", "circle", "bridge", "mony", "eure", "usdc", "zusd",
  "stellar", "elon", "musk", "sbf",
]);

/** Digits swapped in for letters (`z0ld`, `adm1n`, `5upport`). `1` stands for
 *  both `i` and `l`, so it is folded both ways. */
const LOOKALIKE_DIGITS: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

function lookalikeFoldings(text: string): string[] {
  const folded = text.replace(/[034578]/g, (d) => LOOKALIKE_DIGITS[d]);
  return [folded.replace(/1/g, "i"), folded.replace(/1/g, "l")];
}

/** The blocked name a handle impersonates, or undefined. Expects a handle that
 *  already passed `HANDLE_RE`. */
export function impersonatedName(handle: string): string | undefined {
  for (const compact of lookalikeFoldings(handle.replace(/-/g, ""))) {
    const inside = BLOCKED_ANYWHERE.find((word) => compact.includes(word));
    if (inside) return inside;
    if (BLOCKED_AS_WORD.has(compact)) return compact;
  }
  for (const part of handle.split("-")) {
    const word = lookalikeFoldings(part).find((folded) => BLOCKED_AS_WORD.has(folded));
    if (word) return word;
  }
  return undefined;
}

export class HandleError extends Error {}

/**
 * Validate and canonicalise a requested handle.
 *
 * Case is folded rather than rejected — someone typing `Alice` means `alice`,
 * and two handles differing only in case would be one phishing the other.
 */
export function normaliseHandle(raw: unknown): string {
  if (typeof raw !== "string") throw new HandleError("handle must be a string");
  const handle = raw.trim().toLowerCase();
  // Letters from other scripts (Cyrillic "а", Greek "ο", fullwidth "ｚ") can
  // render identically to latin ones, so `zоld` with a Cyrillic о would pass
  // every list below. Refused with its own message, not folded.
  if (/[^\x00-\x7f]/.test(handle)) {
    throw new HandleError(
      "handle may only use the latin letters a-z, numbers and hyphens — letters from other alphabets can look identical",
    );
  }
  if (handle.length < 3 || handle.length > 30) {
    throw new HandleError("handle must be between 3 and 30 characters");
  }
  if (handle.startsWith("0x")) {
    throw new HandleError("handle cannot start with 0x — it would read as an address");
  }
  if (!HANDLE_RE.test(handle)) {
    throw new HandleError(
      "handle may use lowercase letters, numbers and hyphens, and cannot begin or end with a hyphen",
    );
  }
  // ENSIP-15 refuses "--" in the third and fourth place (the "xn--" punycode
  // prefix), and a handle is also an ENS name, `<handle>.zoldhq.com`.
  if (handle.slice(2, 4) === "--") {
    throw new HandleError("handle cannot have two hyphens as its third and fourth characters");
  }
  if (RESERVED.has(handle)) throw new HandleError(`"${handle}" is reserved`);
  const impersonated = impersonatedName(handle);
  if (impersonated) {
    throw new HandleError(`handle cannot contain "${impersonated}" — it would read as someone else's page`);
  }
  return handle;
}

/** Optional display name shown on the page.
 *
 *  Not defaulted to `user.name`: on a KYC-approved account that is a real
 *  legal name, and the page is at a guessable URL. Absent means the page shows
 *  the handle alone. */
export function normaliseDisplayName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new HandleError("displayName must be a string");
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > 40) throw new HandleError("displayName must be 40 characters or fewer");
  return name || undefined;
}

export interface PublicPayee {
  handle: string;
  displayName?: string;
  address: `0x${string}`;
  chainId: number;
  token: { symbol: string; address: `0x${string}`; decimals: number };
  supportedTokens?: {
    chainId: number;
    chainName?: string;
    symbol: string;
    address: `0x${string}`;
    decimals: number;
    minAmount?: string;
    feeBps?: number;
  }[];
  settlementAsset: "EURE" | "USDC";
  autoConvert: boolean;
}

/**
 * The only projection of an account that may be served unauthenticated.
 *
 * An allowlist by construction: it names what goes out. Adding a field here
 * should feel like a decision, because it is one.
 */
export function publicPayee(
  user: User,
  chain: { chainId: number; token: { symbol: string; address: `0x${string}`; decimals: number } },
): PublicPayee {
  const page = user.paymentPage;
  if (!page?.handle) {
    throw new HandleError("account has no payment handle");
  }
  return {
    handle: page.handle,
    ...(page.displayName ? { displayName: page.displayName } : {}),
    address: page.depositAddress,
    chainId: chain.chainId,
    token: chain.token,
    // Only a list read from the forwarder's routes: an older page stored a
    // hard-coded EURe + USDC, and Candide strands what its routes do not list.
    ...(page.routesReadAt && page.supportedTokens?.length ? { supportedTokens: page.supportedTokens } : {}),
    settlementAsset: page.settlementAsset,
    autoConvert: page.autoConvert,
  };
}

/**
 * EIP-681 request URI, for an "open in wallet" link.
 *
 * Not used in the QR code. Wallet support for EIP-681 is uneven, but every
 * wallet can scan a bare address, so the QR carries the address and the page
 * states the chain and token in text.
 */
export function paymentUri(payee: PublicPayee, amount?: number): string {
  const base = `ethereum:${payee.token.address}@${payee.chainId}/transfer?address=${payee.address}`;
  if (amount === undefined || !(amount > 0)) return base;
  const units = BigInt(Math.round(amount * 10 ** payee.token.decimals));
  return `${base}&uint256=${units}`;
}

/** What a stranger may read about an organisation's payment page: its name and
 *  the bank details of its euro account. An allowlist, like publicPayee: no
 *  member, no backing account, no balance. The BIC is Monerium's as reported,
 *  left out when unknown rather than guessed. `holder` is the name Monerium has
 *  for the profile, which is what the payer's bank checks the IBAN against. */
export interface PublicOrgPayee {
  kind: "organisation";
  handle: string;
  displayName: string;
  bank: { holder: string; iban: string; bic?: string };
}

export function publicOrgPayee(
  org: { name: string; legalName?: string; paymentPage?: { handle: string; displayName?: string } },
  account: { identifier: { iban?: string; bic?: string } },
  holder?: string,
): PublicOrgPayee {
  const page = org.paymentPage;
  const iban = account.identifier.iban;
  if (!page?.handle || !iban) throw new HandleError("organisation has no payment page");
  return {
    kind: "organisation",
    handle: page.handle,
    displayName: page.displayName || org.legalName || org.name,
    bank: {
      holder: holder || org.legalName || org.name,
      iban: iban.replace(/\s+/g, ""),
      ...(account.identifier.bic ? { bic: account.identifier.bic } : {}),
    },
  };
}
