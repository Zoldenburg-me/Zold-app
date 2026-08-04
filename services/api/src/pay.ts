/**
 * Payment pages — a shareable handle that resolves to a page-scoped deposit
 * address someone can pay, in the shape of Fluidkey's `name.fkey.id`.
 *
 * The page is deliberately dull: a handle, the address, a QR code, and the
 * chain and token it expects. No amount field and no wallet connection, because
 * the payer's wallet already does both of those better than a web page can.
 *
 * NOT PRIVATE, and the page says so. This page has its own deposit address so
 * random transfers into the user's main wallet do not trigger the page's
 * settlement rule, but it is still one public address per handle. Anyone with
 * the handle can inspect that page address on a block explorer.
 *
 * WHAT A PUBLIC RESPONSE MAY CONTAIN is the security-relevant part of this
 * file. `publicPayee` is an allowlist, built by naming the four fields that go
 * out rather than by deleting the ones that must not. The account object next
 * to it holds an IBAN, an email, a KYC decision, a Travel Rule profile and a
 * private key; a redaction list would leak the next field somebody adds.
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
  if (RESERVED.has(handle)) throw new HandleError(`"${handle}" is reserved`);
  return handle;
}

/** Optional display name shown on the page.
 *
 *  NOT defaulted to `user.name`. That is whatever was typed at signup and on a
 *  KYC-approved account it is a real legal name; publishing it at a guessable
 *  URL because someone claimed a handle is not a choice we get to make for
 *  them. Absent means the page shows the handle alone. */
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
    if (!user.handle) throw new HandleError("account has no payment handle");
    return {
      handle: user.handle,
      ...(user.payDisplayName ? { displayName: user.payDisplayName } : {}),
      address: user.address,
      chainId: chain.chainId,
      token: chain.token,
      settlementAsset: user.autoConvert ? "EURE" : "USDC",
      autoConvert: !!user.autoConvert,
    };
  }
  return {
    handle: page.handle,
    ...(page.displayName ? { displayName: page.displayName } : {}),
    address: page.depositAddress,
    chainId: chain.chainId,
    token: chain.token,
    settlementAsset: page.settlementAsset,
    autoConvert: page.autoConvert,
  };
}

/**
 * EIP-681 request URI, for an "open in wallet" link.
 *
 * Kept OUT of the QR code on purpose. Wallet support for parsing EIP-681 is
 * uneven, while every wallet that scans anything can scan a bare address — so
 * the QR carries the address and the page states the chain and token in text.
 * A code that a payer's wallet cannot read is worse than one carrying less.
 */
export function paymentUri(payee: PublicPayee, amount?: number): string {
  const base = `ethereum:${payee.token.address}@${payee.chainId}/transfer?address=${payee.address}`;
  if (amount === undefined || !(amount > 0)) return base;
  const units = BigInt(Math.round(amount * 10 ** payee.token.decimals));
  return `${base}&uint256=${units}`;
}
