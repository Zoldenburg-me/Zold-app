import { envNumber, IS_LOCAL_CHAIN } from "./env.js";

/**
 * Payment requests (pay links) — an amount somebody asked to be paid.
 *
 * The crypto leg quotes a USDC amount from the live EUR/USD mid and the payee
 * is credited whatever the conversion actually delivers, so the quote carries a
 * small allowance for venue spread. It is a stated allowance, not a hidden
 * margin: the public page prints it, and the request records the mid it was
 * derived from.
 */
/** Tries at telling a merchant a request is paid before the sweep stops retrying. */
export const RESOLVE_MAX_ATTEMPTS = 10;

export const PAYMENT_REQUESTS = {
  /** How long a quoted USDC amount stays the amount to pay. After this the
   *  public page re-quotes; every amount ever quoted still matches a deposit. */
  quoteTtlMs: envNumber("PAY_REQUEST_QUOTE_TTL_MS", 15 * 60_000, { min: 1 }),
  /** Allowance added to the USDC amount so the EURe delivered after the swap
   *  covers the euro amount asked for. Basis points. */
  cryptoAllowanceBps: envNumber("PAY_REQUEST_CRYPTO_ALLOWANCE_BPS", 50, { min: 0, max: 10_000 }),
  /** A deposit this close under a quoted amount still settles the request in
   *  full — wallets round, and a cent short is not a dispute. Basis points. */
  underpayToleranceBps: envNumber("PAY_REQUEST_UNDERPAY_TOLERANCE_BPS", 50, { min: 0, max: 10_000 }),
  /** Below this share of a quoted amount a deposit is not attributed to the
   *  request at all; it stays an ordinary deposit on the account. */
  partialFloorBps: envNumber("PAY_REQUEST_PARTIAL_FLOOR_BPS", 2_000, { min: 0, max: 10_000 }),
  /** Above the quote by more than this, not attributed either. Basis points. */
  overpayCapBps: envNumber("PAY_REQUEST_OVERPAY_CAP_BPS", 1_000, { min: 0 }),
  /** Default lifetime of a link created from the app. */
  defaultTtlMs: envNumber("PAY_REQUEST_DEFAULT_TTL_MS", 7 * 24 * 60 * 60_000, { min: 1 }),
  /** Lifetime of a request opened for a merchant checkout session. */
  checkoutTtlMs: envNumber("PAY_REQUEST_CHECKOUT_TTL_MS", 60 * 60_000, { min: 1 }),
  /** Quotes kept per request; the oldest are dropped once exceeded. */
  maxQuotes: envNumber("PAY_REQUEST_MAX_QUOTES", 24, { min: 1, integer: true }),
  /** How often expiry and our-own-transfer matching run. */
  sweepMs: envNumber("PAY_REQUEST_SWEEP_MS", 60_000, { min: 1_000 }),
} as const;

/**
 * Crypto in: USDC arriving at a payment-page deposit address, settled for the
 * owning account.
 *
 * Per-page opt-in (`User.paymentPage.autoConvert`) decides WHO is watched;
 * these settings decide how. The kill switch exists because this path can
 * credit e-money off an on-chain event, so an operator needs to be able to stop
 * it without a deploy.
 */
export const CRYPTO_IN = {
  enabled: process.env.CRYPTO_IN_ENABLED !== "0",
  pollMs: envNumber("CRYPTO_IN_POLL_MS", 15_000, { min: 250 }),
  /**
   * Below this, converting costs more than it delivers — a dust transfer would
   * be eaten by the swap and leave the user with a confusing €0.00 credit. Left
   * in place and recorded rather than converted.
   */
  minUsdc: envNumber("CRYPTO_IN_MIN_USDC", 1, { min: 0 }),
  /**
   * How far the venue's rate may sit from the live mid before we refuse.
   *
   * Same check as the quote binding: the FxSwapper's rate is one we set, so
   * without an independent mid we could credit e-money at a price no market
   * would give.
   */
  maxDriftBps: envNumber("CRYPTO_IN_MAX_DRIFT_BPS", 100, { min: 0 }),
  /**
   * Blocks to wait before treating a deposit as real. A reorg that unwinds the
   * incoming transfer after we have settled it leaves a false receipt. Zero on
   * hardhat, where a mined block is final and waiting would just hang the tests.
   */
  confirmations: envNumber("CRYPTO_IN_CONFIRMATIONS", IS_LOCAL_CHAIN ? 0 : 2, { min: 0 }),
  /** Cap on a single getLogs span. sepolia.base.org and mainnet.base.org
   *  refuse more than 1,000 blocks; a stricter RPC is met by halving
   *  (log-range.ts). The cursor catches up over several ticks instead. */
  maxBlockSpan: BigInt(envNumber("CRYPTO_IN_MAX_BLOCK_SPAN", 1_000, { min: 1 })),
  /** How far back a fresh install looks: 5,000 Base blocks is under 3 hours. */
  firstLookbackBlocks: BigInt(envNumber("CRYPTO_IN_FIRST_LOOKBACK_BLOCKS", 5_000, { min: 1 })),
  /** Windows per tick: 20 × 1,000 Base blocks is about 11 hours of chain. */
  windowsPerTick: envNumber("CRYPTO_IN_WINDOWS_PER_TICK", 20, { min: 1, integer: true }),
  /**
   * One-shot rescan: on boot the scanner rewinds to just before this block and
   * reads forward again, picking up deposits it passed without recording.
   * Recording is keyed on (txHash, logIndex), so a re-read records nothing
   * twice. Applied once per value; a restart with it still set does not rewind
   * again. Unset means no rescan.
   */
  rescanFromBlock: process.env.CRYPTO_IN_RESCAN_FROM_BLOCK
    ? BigInt(envNumber("CRYPTO_IN_RESCAN_FROM_BLOCK", 0, { min: 0, integer: true }))
    : undefined,
  /** The furthest back a rescan may start. Every maxBlockSpan blocks is one
   *  getLogs call; 100,000 Base blocks is about 2.3 days of chain. */
  maxRescanBlocks: BigInt(envNumber("CRYPTO_IN_MAX_RESCAN_BLOCKS", 100_000, { min: 1, integer: true })),
};
