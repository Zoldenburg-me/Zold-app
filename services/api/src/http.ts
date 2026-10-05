/**
 * One timeout for outbound calls to partners.
 *
 * Node's global `fetch` has no default timeout, so an upstream that accepts
 * the connection and never answers hangs the caller forever. These callers
 * matter: Monerium's redeem is the SEPA payout leg, Candide's bundler is every
 * Safe debit, Bridge is the cash rail's exit, and Shopify's Admin API marks
 * orders paid. A hung call holds an Express handler open, and inside a sweep
 * the tick never completes, so the next never runs and the queue stops with
 * no error.
 *
 * rates.ts and the liquidity venues set their own shorter bounds, since a
 * quote must fail fast. This is the default for everything else.
 *
 * A timeout raises `TimeoutError`, which every call site treats as the partner
 * being unavailable, like a 5xx.
 */
import { envNumber } from "./config.js";

/**
 * Validated at boot like the CRYPTO_IN_* numbers: `AbortSignal.timeout` throws
 * a RangeError on NaN or a fraction, so a typo here ("30s") would otherwise
 * surface as every Monerium, Bridge and Candide call failing at the moment it
 * is made, several layers from the cause.
 */
export const PARTNER_TIMEOUT_MS = envNumber("PARTNER_HTTP_TIMEOUT_MS", 30_000, { min: 1, integer: true });

/** `AbortSignal.timeout(PARTNER_TIMEOUT_MS)`, named so a call site reads as a
 *  deliberate bound rather than a magic number. */
export const partnerTimeout = (ms = PARTNER_TIMEOUT_MS): AbortSignal => AbortSignal.timeout(ms);
