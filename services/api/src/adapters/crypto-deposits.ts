/**
 * Crypto in — USDC forwarded from a payment page into the merchant Safe.
 *
 * Euros arrive by SEPA and Monerium issues EURe to the user's Safe; this is
 * the other way in. It watches payment-page deposit addresses for inbound
 * USDC and settles into the merchant Safe, so a corridor payout can be funded
 * from crypto without the user first finding a bank.
 *
 * Two separable steps, deliberately:
 *
 *   detect  — read Transfer logs addressed to the watched addresses (this file)
 *   convert — a USER-SIGNED batch swaps USDC->EURe into the merchant Safe;
 *             settleConvertedDeposit records what actually arrived
 *
 * Only the swap needs Candide's bundler, which no hardhat node provides, so
 * detection and settlement are testable locally and the swap is not — the
 * same seam the Safe-funded transfer path has, for the same reason.
 *
 * WHAT THIS DOES NOT DO
 * - It converts nothing without `user.paymentPage.autoConvert`.
 * - It watches the payment page's configured forwarding recipient. In
 *   production that should be the merchant Safe, reached through Candide's
 *   forwarding address rather than an API-held payment-page owner key.
 * - It credits nothing for an account that is not KYC-approved. The output is
 *   e-money, so the same gate that gates a SEPA deposit gates this.
 * - It does not screen the SENDING address. An unsolicited transfer from an
 *   unknown counterparty is a source-of-funds question that belongs with a
 *   compliance provider, and nothing here answers it.
 */
import { randomUUID } from "node:crypto";
import { CHAIN_ID, CRYPTO_IN } from "../config.js";
import { store, type CryptoDeposit, type User } from "../store.js";
import { addrs, eur, usd, publicClient } from "../chain.js";
import { balanceAfterWrite } from "../liquidity.js";
import { safeDebitBlocker } from "../orchestrator.js";
import { midRates } from "../rates.js";

/** The ERC-20 event, declared here rather than pulled from the mock's ABI —
 *  the real USDC emits the same signature and this path must not depend on our
 *  own token's artifact. */
const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

interface WatchedAddress {
  user: User;
  address: `0x${string}`;
  source: "payment-page" | "safe";
}

/** Accounts whose inbound transfers are recorded, either as direct Safe
 * funding or through page-scoped auto-settlement.
 *
 * Three rules, each learned from a mis-attribution that shipped:
 *
 * - The ZERO ADDRESS is never watched. Accounts without a deployed Safe hold
 *   0x0 as their address, and watching it attributed every EURe BURN (each
 *   redeem's Transfer to 0x0) to whichever Safe-less account came first — a
 *   €22.01 payout burn showed up as a deposit on an unrelated account.
 * - ONE entry per address, and the page is watched at its DEPOSIT address —
 *   the address payers are actually told — never at its recipient. Watching
 *   the recipient meant direct Safe USDC was reclassified as page
 *   auto-convert (converting money the owner chose to hold as USDC), while
 *   deposits at a real forwarder address were not watched at all. When the
 *   deposit address IS the user's Safe (the local-safe provider), the page
 *   entry wins on purpose: opting that address into auto-convert is the
 *   owner's explicit instruction for USDC arriving there.
 * - Direct Safe funding is recorded for EVERY account, not only approved
 *   ones. Recording is observation, not a credit decision: a pending
 *   account's Safe can already receive (the faucet funds it at deployment,
 *   before manual review lands), and skipping it meant the cursor moved past
 *   the transfer forever — the deposit never appeared even after approval.
 *   Page auto-convert stays approved-only: conversion IS a credit decision.
 */
function watchedAddresses(): WatchedAddress[] {
  const seen = new Set<string>();
  const out: WatchedAddress[] = [];
  for (const user of store.users) {
    const add = (address: `0x${string}`, source: WatchedAddress["source"]) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || /^0x0{40}$/i.test(address)) return;
      const key = address.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ user, address, source });
    };
    if (user.kycStatus === "approved" && user.paymentPage?.autoConvert && user.paymentPage.depositAddress) {
      add(user.paymentPage.depositAddress, "payment-page");
    }
    add(user.address, "safe");
  }
  return out;
}

/**
 * What a USDC deposit was worth in EUR when it arrived, with the provenance to
 * defend the number later.
 *
 * REFUSES rather than guessing. rates.ts has no stale fallback by design, and
 * a receipt valued at an invented rate is worse than one valued late: the
 * first is a wrong figure in the books, the second is a gap someone can fill.
 * A deposit whose rate could not be read is recorded without a receipt value
 * and can be valued on the next attempt.
 */
async function valueAtReceipt(
  amountUsdc: number,
  blockTimestamp?: string,
): Promise<CryptoDeposit["receipt"] | undefined> {
  try {
    const r = await midRates();
    const usdPerEur = r.eur.USD;
    if (!(usdPerEur > 0)) return undefined;
    return {
      amountEur: Math.round((amountUsdc / usdPerEur) * 100) / 100,
      rate: usdPerEur,
      rateProvider: r.provider,
      rateAsOf: r.asOf,
      ratedAt: new Date().toISOString(),
      ...(blockTimestamp ? { blockTimestamp } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Refuse to convert at a price the market would not give.
 *
 * The FxSwapper's rate is one WE set, so on a local chain this check is the
 * only thing standing between a mispriced swapper and e-money credited at a
 * fictional rate. Same discipline as FP5's quote binding, applied at the point
 * where the number becomes someone's balance.
 *
 * `rate` is the venue's EUR/USD (USDC units per 1 EURe, 6dp), matching what
 * FxSwapper.rate() posts and what the liquidity providers report.
 */
async function assertRateSane(rate: bigint): Promise<number> {
  const venue = Number(rate) / 1e6;
  if (!(venue > 0)) throw new Error("venue quoted a zero rate");
  const mid = (await midRates()).eur.USD;
  if (!(mid > 0)) throw new Error("no live EUR/USD mid to check the venue against");
  const driftBps = Math.abs(venue - mid) / mid * 10_000;
  if (driftBps > CRYPTO_IN.maxDriftBps) {
    throw new Error(
      `venue rate ${venue.toFixed(4)} is ${driftBps.toFixed(0)} bps from the live mid ` +
        `${mid.toFixed(4)} (cap ${CRYPTO_IN.maxDriftBps}) — refusing to convert at a price ` +
        `the market would not give`,
    );
  }
  return venue;
}

/**
 * Can this deposit be converted, and if not, why in words the user can act on?
 *
 * Nothing sweeps anywhere: the swap is one user-signed batch out of the user's
 * own Safe, delivering EURe back into it.
 */
export function depositConversionBlocker(user: User, deposit: CryptoDeposit): string | null {
  if (deposit.state === "CONVERTED") return "this deposit has already been settled";
  if (user.kycStatus !== "approved") return "your account is not approved for settlement yet";
  const page = user.paymentPage;
  if (!page) return "this account has no payment page";
  if (page.settlementAsset === "USDC") {
    return "your payment page settles in USDC, so there is nothing to convert";
  }
  const amountUsdc = deposit.amountUsdc ?? 0;
  if (amountUsdc < CRYPTO_IN.minUsdc) {
    return `${amountUsdc} USDC is below the ${CRYPTO_IN.minUsdc} USDC floor — converting it would cost more than it delivers`;
  }
  /**
   * No Safe, nothing to sign with. Without this check the deposit would sit at
   * DETECTED telling the user to approve it with a passkey that has no Safe
   * to act on. safeDebitBlocker is the same check the send path uses, so the
   * two cannot drift.
   */
  const safeBlocker = safeDebitBlocker(user);
  if (safeBlocker) {
    // Someone reading this has money sitting at an address they own and is
    // being told it cannot be converted; the first thing they need to know is
    // that it has not gone anywhere. Without that sentence a solvable state
    // reads as a loss.
    return (
      `${safeBlocker}. Your ${deposit.amountUsdc ?? 0} USDC is still yours at ${user.address} — ` +
      "it simply cannot be converted until the account can sign."
    );
  }
  return null;
}

/**
 * Convert one detected deposit and settle the euros.
 *
 * Ordering is the point. The swap sends EURe to the merchant Safe and the
 * settlement record is sized from the Safe's measured balance change, not from
 * `expectedOut`.
 */
export async function convertDeposit(deposit: CryptoDeposit): Promise<CryptoDeposit> {
  if (deposit.state === "CONVERTED") return deposit;
  const user = store.findUser(deposit.userId);
  if (!user) throw new Error(`unknown user for crypto deposit ${deposit.id}`);
  const txs: CryptoDeposit["txs"] = [...deposit.txs];

  try {
    const page = user.paymentPage;
    if (!page?.autoConvert) throw new Error("payment page has auto-settlement switched off");
    const blocker = depositConversionBlocker(user, deposit);
    // Settling in USDC is not a blocker, it is a DIFFERENT settlement — the
    // user chose to keep the asset, and that is a completed deposit, not a
    // refused one.
    if (page.settlementAsset === "USDC") {
      return store.updateCryptoDeposit(deposit.id, {
        state: "CONVERTED",
        creditedUsdc: deposit.amountUsdc ?? 0,
        settlementAsset: "USDC",
        txs,
        reason: undefined,
      });
    }
    if (blocker) throw new Error(blocker);

    /**
     * THE SWAP IS NOT PERFORMED HERE.
     *
     * Converting means moving the user's USDC, and the only thing that may do
     * that is a UserOperation their passkey signed. This poller runs with
     * nobody present, so it CANNOT convert — it can only establish that the
     * deposit is ready to be converted and wait for the account holder.
     *
     * So "auto-convert" means detected automatically and converted on
     * approval, and the deposit says so rather than sitting at DETECTED with
     * no explanation — a missing signature must not read like a fault.
     */
    return store.updateCryptoDeposit(deposit.id, {
      state: "DETECTED",
      reason:
        "ready to convert to EURe — approve it with your passkey. Nothing can move your funds " +
        "without that signature.",
      txs,
    });
  } catch (err: any) {
    const reason = String(err?.shortMessage ?? err?.message ?? err);
    console.warn(`crypto-in: refusing deposit ${deposit.txHash}#${deposit.logIndex}: ${reason}`);
    return store.updateCryptoDeposit(deposit.id, { state: "REFUSED", reason, txs });
  }
}

/**
 * Record the result of a conversion the USER signed and the API submitted.
 *
 * The credited amount is MEASURED as the Safe's EURe balance delta, never
 * copied from the quote: "the router did not revert" and "this much EURe
 * arrived" are different facts, and only the second one may be credited. The
 * signed floor is checked against the measured delta for the same reason.
 */
export async function settleConvertedDeposit(
  deposit: CryptoDeposit,
  user: User,
  quote: { provider: string; rate: bigint; minOut: bigint },
  balanceBeforeWei: bigint,
  txs: CryptoDeposit["txs"],
): Promise<CryptoDeposit> {
  const venueRate = await assertRateSane(quote.rate);
  const after = await balanceAfterWrite(addrs().eure, user.address as `0x${string}`, balanceBeforeWei);
  const receivedWei = after - balanceBeforeWei;

  if (receivedWei <= 0n) {
    return store.updateCryptoDeposit(deposit.id, {
      state: "REFUSED",
      reason: "the swap delivered no EURe to your account — nothing has been credited",
      txs,
    });
  }
  if (receivedWei < quote.minOut) {
    return store.updateCryptoDeposit(deposit.id, {
      state: "REFUSED",
      reason:
        `the swap delivered €${eur.fromWei(receivedWei)}, under the €${eur.fromWei(quote.minOut)} ` +
        "floor your signature guaranteed — left for review rather than credited",
      txs,
    });
  }

  const creditedEur = eur.fromWei(receivedWei);
  /**
   * The realised gain: what arrived, minus what it was worth at receipt.
   *
   * Recorded as a FACT at the moment it is known, never recomputed. A gain
   * re-derived later from whatever rate a feed reports then is not the gain
   * that occurred. Near zero when the conversion follows the receipt promptly,
   * which is the tax argument for converting promptly at all.
   *
   * Absent when the receipt could not be valued — an unknown basis yields an
   * unknown gain, and a zero would be a claim.
   */
  const realisedGainEur =
    deposit.receipt
      ? Math.round((creditedEur - deposit.receipt.amountEur) * 100) / 100
      : undefined;
  console.log(
    `crypto-in: converted ${deposit.amountUsdc ?? 0} USDC to EUR ${creditedEur} for ${user.name} ` +
      `via ${quote.provider} at ${venueRate.toFixed(4)}` +
      (realisedGainEur === undefined ? "" : ` (realised EUR ${realisedGainEur})`),
  );
  const settled = store.updateCryptoDeposit(deposit.id, {
    state: "CONVERTED",
    creditedEur,
    settlementAsset: "EURE",
    provider: quote.provider,
    rate: venueRate,
    ...(realisedGainEur === undefined ? {} : { realisedGainEur }),
    txs,
    reason: undefined,
  });
  if (settled.invoiceId) recordInvoiceSettlement(settled);
  return settled;
}

/**
 * Write the payment back onto the invoice it settles.
 *
 * The invoice is the Beleg and the deposit is the Zahlung; German bookkeeping
 * wants them tied, and an auditor asking "how was invoice 2026-001 paid?"
 * should get one thread: this transaction arrived, this one converted it, this
 * much euro landed. Reconstructing that later from timestamps and amounts is
 * guesswork dressed as reconciliation.
 *
 * Appends rather than replaces: an invoice can legitimately be settled by more
 * than one payment, and overwriting would erase the earlier ones.
 */
export function recordInvoiceSettlement(deposit: CryptoDeposit): void {
  if (!deposit.invoiceId) return;
  const invoice = store.invoices.find((i) => i.id === deposit.invoiceId);
  if (!invoice) return;
  const receiptTx = deposit.txHash;
  const conversionTx = deposit.txs.find((t) => t.step.includes("usdc->eure"))?.hash;
  const settlement = {
    depositId: deposit.id,
    receivedAsset: deposit.token,
    receivedAmount: deposit.token === "USDC" ? deposit.amountUsdc ?? 0 : deposit.amountEur ?? 0,
    receiptTxHash: receiptTx,
    ...(deposit.receipt ? { receiptAmountEur: deposit.receipt.amountEur, receiptRate: deposit.receipt.rate, receiptRateProvider: deposit.receipt.rateProvider } : {}),
    ...(conversionTx ? { conversionTxHash: conversionTx } : {}),
    ...(deposit.creditedEur === undefined ? {} : { creditedEur: deposit.creditedEur }),
    ...(deposit.realisedGainEur === undefined ? {} : { realisedGainEur: deposit.realisedGainEur }),
    at: new Date().toISOString(),
  };
  const existing = invoice.settlements ?? [];
  store.updateInvoice(invoice.id, {
    settlements: [...existing.filter((x) => x.depositId !== deposit.id), settlement],
  });
}

/**
 * One scan of the chain for inbound USDC, followed by conversion of whatever
 * is new.
 *
 * The cursor advances only after every log in the window has been RECORDED —
 * not after it has been converted. A deposit we saw but could not convert is a
 * REFUSED row someone can act on; a deposit we never recorded because the
 * cursor ran ahead is money that silently vanished.
 */
export async function pollCryptoDepositsOnce(): Promise<number> {
  if (!CRYPTO_IN.enabled) return 0;
  const watched = watchedAddresses();
  if (watched.length === 0) return 0;
  const cursorKey = `${CHAIN_ID}:safe-funding-v1`;

  /**
   * cacheTime: 0 is load-bearing.
   *
   * viem caches getBlockNumber for its polling interval, so consecutive ticks
   * can read the same stale head. For a cursor-driven scanner that is not a
   * stale number, it is skipped blocks: the cursor is written from this value,
   * so a head that lags behind the chain moves the window past deposits that
   * were never scanned, and nothing ever goes back for them.
   */
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const safeHead = head - BigInt(CRYPTO_IN.confirmations);
  if (safeHead < 0n) return 0;

  // A fresh install looks back one bounded window so a just-finished deposit
  // can still appear in Activity after the scanner deploys or restarts.
  const cursor = store.cryptoDepositCursor(cursorKey);
  if (cursor === undefined) {
    const lookback = CRYPTO_IN.maxBlockSpan;
    store.setCryptoDepositCursor(cursorKey, safeHead > lookback ? safeHead - lookback : 0n);
    return 0;
  }
  if (safeHead <= cursor) return 0;

  const fromBlock = cursor + 1n;
  const toBlock = safeHead - fromBlock + 1n > CRYPTO_IN.maxBlockSpan
    ? fromBlock + CRYPTO_IN.maxBlockSpan - 1n
    : safeHead;

  const byAddress = new Map<string, WatchedAddress[]>();
  for (const item of watched) {
    const key = item.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), item]);
  }
  const fresh: CryptoDeposit[] = [];
  for (const token of [
    { token: "EURE" as const, address: addrs().eure },
    { token: "USDC" as const, address: addrs().usdc },
  ]) {
    const logs = await publicClient.getLogs({
      address: token.address,
      event: TRANSFER_EVENT,
      args: { to: watched.map((x) => x.address) },
      fromBlock,
      toBlock,
    });

    // Block times for the window, one call per distinct block. The chain's
    // timestamp is when the money actually arrived; detection is a couple of
    // confirmations later. Recording both lets the Steuerberater decide which
    // instant counts rather than us deciding by omission.
    const blockTimes = new Map<bigint, string>();
    for (const bn of new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))) {
      try {
        const blk = await publicClient.getBlock({ blockNumber: bn });
        blockTimes.set(bn, new Date(Number(blk.timestamp) * 1000).toISOString());
      } catch { /* a missing block time is not worth failing a deposit over */ }
    }

    for (const log of logs) {
      const to = String(log.args.to ?? "").toLowerCase();
      const matches = byAddress.get(to) ?? [];
      if (!matches.length) continue; // not ours; the node filtered loosely
      const value = (log.args.value ?? 0n) as bigint;
      if (value <= 0n) continue;
      const from = String(log.args.from ?? "").toLowerCase();
      if (token.token === "EURE" && from === addrs().swapper.toLowerCase()) continue;
      const txHash = log.transactionHash!;
      const logIndex = Number(log.logIndex);
      if (store.findCryptoDeposit(txHash, logIndex)) continue;

      const pageMatch = matches.find((m) => m.source === "payment-page" && m.user.paymentPage?.autoConvert);
      const match = token.token === "USDC" && pageMatch ? pageMatch : matches[0];
      // The forwarder's second hop: page money already recorded when it
      // arrived at the deposit address, now landing on the owner's Safe.
      // Recording it again would double-count one payment.
      const ownPage = match.user.paymentPage?.depositAddress?.toLowerCase();
      if (match.source === "safe" && ownPage && ownPage !== to && from === ownPage) continue;
      const user = match.user;
      const now = new Date().toISOString();
      const directSafeFunding = match.source === "safe" || token.token === "EURE";
      /**
       * The acquisition value, stamped HERE — at detection, once, with the
       * rate's provenance — and never recomputed. A figure re-derived months
       * later from whatever the feed says then is not the value at receipt;
       * it is a guess wearing its clothes.
       */
      const receipt =
        token.token === "USDC"
          ? await valueAtReceipt(
              usd.fromUnits(value),
              log.blockNumber != null ? blockTimes.get(log.blockNumber) : undefined,
            )
          : undefined;
      fresh.push(
        store.addCryptoDeposit({
          id: randomUUID(),
          userId: user.id,
          chainId: CHAIN_ID,
          token: token.token,
          txHash,
          logIndex,
          amountUnits: value.toString(),
          ...(token.token === "EURE" ? { amountEur: eur.fromWei(value), creditedEur: eur.fromWei(value) } : {}),
          ...(token.token === "USDC"
            ? {
                amountUsdc: usd.fromUnits(value),
                ...(receipt ? { receipt, amountEur: receipt.amountEur } : {}),
                ...(directSafeFunding ? { creditedUsdc: usd.fromUnits(value) } : {}),
              }
            : {}),
          settlementAsset: directSafeFunding
            ? token.token
            : user.paymentPage?.settlementAsset ?? token.token,
          paymentAddress: match.address,
          state: directSafeFunding ? "CONVERTED" : "DETECTED",
          txs: [],
          detectedAt: now,
          updatedAt: now,
        }),
      );
    }
  }

  store.setCryptoDepositCursor(cursorKey, toBlock);

  for (const deposit of fresh) {
    if (deposit.state !== "DETECTED") continue;
    try {
      await convertDeposit(deposit);
    } catch (err: any) {
      // convertDeposit records its own refusals; reaching here means the
      // record itself could not be written.
      console.error(`crypto-in: could not settle deposit ${deposit.id}: ${err?.message ?? err}`);
    }
  }
  return fresh.length;
}

/**
 * Retry deposits left DETECTED by a crash between recording and conversion.
 *
 * Only DETECTED. A REFUSED deposit is a decision, not a transient failure, and
 * retrying it in a loop would hammer a venue over a deposit that is below the
 * floor or belongs to an account that has not opted in.
 */
export async function sweepPendingCryptoDeposits(): Promise<number> {
  if (!CRYPTO_IN.enabled) return 0;
  let n = 0;
  for (const d of [...store.cryptoDeposits]) {
    if (d.state !== "DETECTED") continue;
    if (d.token !== "USDC") continue;
    await convertDeposit(d);
    n++;
  }
  return n;
}

export function startCryptoDepositPoller() {
  const tick = async () => {
    try {
      await sweepPendingCryptoDeposits();
      await pollCryptoDepositsOnce();
    } catch (err: any) {
      console.error(`crypto-in poll failed: ${err?.message ?? err}`);
    }
  };
  void tick();
  const timer = setInterval(tick, CRYPTO_IN.pollMs);
  timer.unref();
  return timer;
}
