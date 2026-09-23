/**
 * One timeout for outbound calls to partners.
 *
 * Node's global `fetch` has NO default timeout. An upstream that accepts the
 * connection and then never answers therefore hangs the caller forever, and
 * these callers are not background curiosities: Monerium's redeem is the SEPA
 * payout leg, Candide's bundler is every Safe debit, Bridge is the cash rail's
 * exit, Shopify's Admin API is how a paid order gets marked paid. A hung one
 * holds an Express handler open with no response, and inside a sweep it holds
 * that sweep's turn forever — the tick never completes, so the next one never
 * runs and the queue it was draining stops draining silently.
 *
 * rates.ts and the liquidity venues already bound their own calls, with their
 * own numbers, because a quote must fail fast. This is the default for
 * everything else: generous enough for a slow partner, finite.
 *
 * A timeout raises `TimeoutError`, which every one of these call sites already
 * treats as the partner being unavailable — the same path as a 5xx.
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
