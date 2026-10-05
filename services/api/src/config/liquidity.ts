import { CHAIN_ID } from "./env.js";

const UNISWAP_V3_BY_CHAIN: Record<number, { factory: string; router: string; quoter: string }> = {
  8453: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
  84532: {
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  },
};
const UNISWAP_V3 = UNISWAP_V3_BY_CHAIN[CHAIN_ID] ?? UNISWAP_V3_BY_CHAIN[8453];

/**
 * Where the EURe<->USDC leg gets its liquidity.
 *
 * "fx-swapper" is the local mock: our own inventory at an owner-set rate, and
 * the only venue that works on hardhat. "rfq" is just-in-time liquidity from a
 * market maker (Bebop), priced by an executable quote.
 *
 * BEBOP_API_KEY is effectively required: ethereum and arbitrum answer every
 * unauthenticated request with UnknownError (checked with a USDC->WETH
 * control), and EURe is TokenNotSupported on the chains the public endpoint
 * serves. Request access via Bebop's contact form and set
 * BEBOP_CHAIN=ethereum before adding rfq to the venue list.
 */
export const LIQUIDITY = {
  /**
   * The default is a custody decision.
   *
   * Only venues that implement `safeSwapPlan` can be executed by the user's
   * Safe: one batch approves the venue and delivers the output straight to the
   * payout destination, so the orchestrator never holds the input. FxSwapper
   * cannot (its inventory is `onlyTrader`) and CoW refuses, so on either the
   * full amount is debited to the orchestrator, which swaps from there.
   *
   * `best` over LIQUIDITY_VENUES (default lifi,dex, both Safe-executable) is
   * the default, so the non-custodial path runs unless someone opts out.
   *
   * Local hardhat has neither LI.FI nor a seeded pool, so `_local-chain.ts`
   * pins fx-swapper for dev and the harnesses. Keep that opt-in local only.
   */
  PROVIDER: (process.env.LIQUIDITY_PROVIDER ?? "best") as "fx-swapper" | "rfq" | "cow" | "dex" | "lifi" | "best",
  // Bebop's chain slug, e.g. "polygon", "base", "ethereum".
  BEBOP_CHAIN: process.env.BEBOP_CHAIN ?? "polygon",
  BEBOP_BASE_URL: process.env.BEBOP_BASE_URL ?? "https://api.bebop.xyz",
  BEBOP_API_KEY: process.env.BEBOP_API_KEY ?? "",
  BEBOP_TIMEOUT_MS: Number(process.env.BEBOP_TIMEOUT_MS ?? 8_000),
  /** Settlement contracts a Bebop quote may name as call target or approval
   *  spender. A maker's calldata runs with our (or the user's) signature, so
   *  it is checked against this list, never trusted. Empty = RFQ execution
   *  refused. */
  BEBOP_CONTRACTS: (process.env.BEBOP_CONTRACTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Nominal EURe size used to probe an indicative rate for receipts. */
  PROBE_EUR: Number(process.env.LIQUIDITY_PROBE_EUR ?? 100),
  /** How long an indicative (display-only) rate may be reused. */
  INDICATIVE_TTL_MS: Number(process.env.LIQUIDITY_INDICATIVE_TTL_MS ?? 60_000),
  /**
   * CoW Protocol. Intent-based rather than RFQ: you sign an order and solvers
   * compete to fill it, so no inventory is carried on either side — which is
   * the reason it is here. Unlike Bebop it actually lists EURe, and it accepts
   * EIP-1271, so a Safe can sign the order itself.
   *
   * The API is per-network: "xdai" is Gnosis, where EURe liquidity is deepest
   * because Monerium is Gnosis-native.
   */
  COW_BASE_URL: process.env.COW_BASE_URL ?? "https://api.cow.fi",
  COW_NETWORK: process.env.COW_NETWORK ?? "xdai",
  COW_TIMEOUT_MS: Number(process.env.COW_TIMEOUT_MS ?? 15_000),
  /**
   * Uniswap v3, on-chain. The v3 interface is identical on Base Sepolia and
   * Base mainnet, so the path tested on the testnet is the path that ships.
   *
   * Defaults per chain (UniswapV3Factory, SwapRouter02, QuoterV2), verified
   * with eth_getCode; on Base Sepolia the router and quoter both report the
   * factory below (Oct 2026). Another chain falls back to the mainnet set,
   * which has no code there, so the DEX venue refuses rather than trades.
   */
  DEX_FACTORY: (process.env.DEX_FACTORY ?? UNISWAP_V3.factory) as `0x${string}`,
  DEX_ROUTER: (process.env.DEX_ROUTER ?? UNISWAP_V3.router) as `0x${string}`,
  DEX_QUOTER: (process.env.DEX_QUOTER ?? UNISWAP_V3.quoter) as `0x${string}`,
  /** Fee tiers probed, cheapest first. The deepest pool wins, not the first. */
  DEX_FEE_TIERS: (process.env.DEX_FEE_TIERS ?? "100,500,3000,10000")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
  /** Slippage floor written into the swap call as amountOutMinimum. */
  DEX_SLIPPAGE_BPS: BigInt(process.env.DEX_SLIPPAGE_BPS ?? 50),
  /**
   * How far the pool's implied EUR/USD may sit from the independent live mid
   * before we refuse to trade.
   *
   * This guard is the difference between a pool and a market maker. An RFQ
   * maker quotes a price it is willing to honour; an AMM pool is simply
   * whatever the last trade left behind, and anyone with capital can move a
   * thin one. Without this a skewed pool would let us settle a real transfer
   * at a garbage rate and report it as a market price.
   */
  DEX_MAX_MID_DEVIATION_BPS: BigInt(process.env.DEX_MAX_MID_DEVIATION_BPS ?? 300),
  /**
   * LI.FI, the production venue.
   *
   * EURe->USDC quotes were executable on Gnosis (1.1493), Base (1.1506) and
   * Polygon (1.1491) against a live mid of ~1.1511, routed through Nordstern
   * Finance / Fly / Bitget, venues a single Uniswap adapter would not reach.
   *
   * It cannot be exercised on a testnet: it lists Base Sepolia but answers
   * "No available quotes" even for WETH/USDC, which has real Uniswap depth
   * there. `dex` is the path we can test locally; this one ships. Keep both.
   */
  LIFI_BASE_URL: process.env.LIFI_BASE_URL ?? "https://li.quest",
  LIFI_API_KEY: process.env.LIFI_API_KEY ?? "",
  LIFI_TIMEOUT_MS: Number(process.env.LIFI_TIMEOUT_MS ?? 15_000),
  /** Fraction, LI.FI's own units: 0.005 = 50bps. */
  LIFI_SLIPPAGE: Number(process.env.LIFI_SLIPPAGE ?? 0.005),
  /** Chain to route on. The app chain; EURe exists on 1/100/137/8453/42161/59144. */
  LIFI_CHAIN_ID: Number(process.env.LIFI_CHAIN_ID ?? CHAIN_ID),
  /** Contracts a LI.FI route may call or be approved for (default: the LI.FI
   *  Diamond). Same reason as BEBOP_CONTRACTS: routing is delegated, the
   *  calldata is not. */
  LIFI_CONTRACTS: (process.env.LIFI_CONTRACTS ?? "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

  /**
   * Best execution. With more than one venue wired, picking one by config
   * settles at a worse price whenever the other is better. `best` quotes every
   * venue below in parallel and takes the largest out for the same in.
   */
  VENUES: (process.env.LIQUIDITY_VENUES ?? "lifi,dex")
    .split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * Who keeps positive slippage: the difference between what a venue quoted
   * and what it delivered.
   *
   * Default "user". The receipt reports marginBps measured between the live
   * mid and what we deliver; keeping surplus unrecorded would make that number
   * understate what we take. "treasury" records the amount on the transfer so
   * it can be reflected in the margin.
   */
  SURPLUS_POLICY: (process.env.LIQUIDITY_SURPLUS_POLICY ?? "user") as "user" | "treasury",
};

// Live mid-rate feed. Defaults to a free, key-less provider that publishes all
// three currencies we need against EUR. See rates.ts for why there is no stale
// fallback.
export const RATES = {
  URL: process.env.TRANSF_RATES_URL ?? "https://open.er-api.com/v6/latest/EUR",
  TTL_MS: Number(process.env.TRANSF_RATES_TTL_MS ?? 10 * 60 * 1000),
  TIMEOUT_MS: Number(process.env.TRANSF_RATES_TIMEOUT_MS ?? 8_000),
  /**
   * ECB reference rates (Frankfurter mirrors the ECB's daily fixing). Used to
   * VALUE a receipt for the books, never to price a trade: the ECB publishes
   * once per business day around 16:00 CET, so this is the day's reference
   * rate, not an intraday mid. The live mid above stays the execution check.
   */
  ECB_URL: process.env.TRANSF_ECB_RATES_URL ?? "https://api.frankfurter.dev/v1",
};

// FX configuration for the launch corridor (EUR -> KES cash pickup).
//
// Mid rates come live from rates.ts; a hardcoded constant goes stale while the
// receipt still claims a margin over the market rate. EUR->USD is whatever the
// liquidity venue executes at, read in fx.ts. Only our own pricing lives here.
export const FX = {
  SPREAD_BPS: 50, // our FX spread on the cash corridor
  /**
   * Fees are PER RAIL, and SEPA is free. Monerium charges nothing for the
   * redeem, so neither do we; the only fee in the product is on the cash
   * corridor (closed until a partner is live). Conversions carry no fee
   * either — the venue's rate is the whole price. Env-overridable so a fee
   * can be introduced without a deploy, and read through railFeeEur() so no
   * code path can pick up the wrong rail's number.
   */
  SEPA_FEE_EUR: Math.max(0, Number(process.env.SEPA_FEE_EUR ?? 0)),
  CASH_FEE_EUR: Math.max(0, Number(process.env.CASH_FEE_EUR ?? 0.99)),
  QUOTE_TTL_MS: 10 * 60 * 1000,
  DAILY_CAP_EUR: 2500,
  // Quote binding: max on-chain rate drift between quote and execution before the
  // transfer is rejected and refunded (bps).
  QUOTE_BINDING_BPS: 50,
};

/** The fixed fee for a rail, in EUR. Zero on SEPA. */
export const railFeeEur = (rail: string): number => (rail === "cash" ? FX.CASH_FEE_EUR : FX.SEPA_FEE_EUR);
