/**
 * Crypto in: USDC forwarded from a payment page into the merchant Safe.
 *
 * SEPA plus Monerium EURe is the main way in; this watches payment-page
 * deposit addresses for inbound USDC so a corridor payout can be funded from
 * crypto without a bank.
 *
 *   detect  - read Transfer logs addressed to the watched addresses (this file)
 *   settle  - on arrival, whatever the asset: the invoice, the pay link and the
 *             books' receipt line (settleOnArrival)
 *   convert - later, and only with the user's passkey: a Safe batch swaps the
 *             held USDC to EURe; settleConvertedDeposit records what arrived
 *
 * Settled and converted are separate facts. The payer paid when the money
 * landed; whether the payee keeps it as USDC or swaps it is `holding`.
 *
 * Only the swap needs Candide's bundler, which hardhat lacks, so detection and
 * settlement are testable locally and the swap is not.
 *
 * Limits:
 * - Nothing converts without a passkey signature. `paymentPage.autoConvert`
 *   only decides whether a deposit asks for one (awaiting_approval) or is
 *   simply held until the user chooses to convert.
 * - It watches the page's configured forwarding recipient. In production that
 *   should be the merchant Safe via Candide's forwarding address, not an
 *   API-held payment-page owner key.
 * - Deposits are recorded for every account; the KYC gate sits in front of
 *   the user-signed conversion to e-money.
 * - The sending address is not screened. Source of funds for an unsolicited
 *   transfer belongs with a compliance provider.
 */
import { randomUUID } from "node:crypto";
import { usdToken } from "../usd-token.js";
import { CHAIN_ID, CRYPTO_IN } from "../config.js";
import { store, type CryptoDeposit, type User } from "../store.js";
import { describeCause } from "../http/log-cause.js";
import { abis, addrs, eur, usd, publicClient } from "../chain.js";
import { balanceAfterWrite } from "../liquidity.js";
import { safeDebitBlocker } from "../orchestrator.js";
import { walletBlocker } from "../domain/wallet-tier.js";
import { midRates, referenceRate } from "../rates.js";
import { attributeDepositToRequest, noteDepositSettled } from "../routes/payment-requests.js";
import { buildCryptoSettlement, settlementUpdate } from "../domain/invoices.js";
import { writeStatementLines } from "../bookkeeping/writer.js";
import { readLogWindow } from "../log-range.js";

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
 * - The zero address is never watched. Safe-less accounts hold 0x0, and
 *   watching it attributed every EURe burn (each redeem's Transfer to 0x0) to
 *   the first Safe-less account.
 * - One entry per address, and a page is watched at its deposit address (the
 *   one payers are told), not its recipient. Watching the recipient turned
 *   direct Safe USDC into page auto-convert and missed forwarder deposits.
 *   When the deposit address is the user's Safe (local-safe provider), the
 *   page entry wins: opting it into auto-convert is the owner's instruction.
 * - Direct Safe funding is recorded for all accounts, approved or not. A
 *   pending account's Safe can already receive, and skipping it moves the
 *   cursor past the transfer for good. Page auto-convert is watched for any
 *   account walletBlocker lets through: conversion is a swap the user signs
 *   from their own Safe, not a fiat rail.
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
    if (!walletBlocker(user) && user.paymentPage?.autoConvert && user.paymentPage.depositAddress) {
      add(user.paymentPage.depositAddress, "payment-page");
    }
    // A payment REQUEST (pay link) is an explicit ask for money at the page
    // address, so the page is watched while one is open whatever the
    // auto-convert setting says — otherwise a paid link would go unseen on a
    // forwarder address. What happens to the money is still decided below.
    if (user.paymentPage?.depositAddress && hasOpenCryptoRequest(user.id)) {
      add(user.paymentPage.depositAddress, "payment-page");
    }
    add(user.address, "safe");
  }
  return out;
}

function hasOpenCryptoRequest(userId: string): boolean {
  const now = Date.now();
  return store
    .paymentRequestsForUser(userId)
    .some((r) => r.state === "OPEN" && r.methods.includes("crypto") && Date.parse(r.expiresAt) > now);
}

/**
 * What a USDC deposit was worth in EUR when it arrived, with the rate's
 * provenance.
 *
 * Valued at the ECB reference rate for the day the chain says the money
 * arrived, which is what the books record. The ECB fixes once per business
 * day, so `rateAsOf` is the fixing day, not the block's minute — and on a
 * weekend, a holiday, or before the day's publication it is an earlier day
 * than the receipt. Stored as such rather than dressed up as intraday.
 *
 * Returns undefined when no rate is available (rates.ts has no stale
 * fallback). The deposit is then recorded without a receipt value and can be
 * valued later; a made-up rate would put a wrong figure in the books.
 */
export async function valueAtReceipt(
  amountUsdc: number,
  blockTimestamp?: string,
): Promise<CryptoDeposit["receipt"] | undefined> {
  try {
    const day = blockTimestamp ? blockTimestamp.slice(0, 10) : undefined;
    const r = await referenceRate("USD", day);
    if (!(r.rate > 0)) return undefined;
    return {
      amountEur: Math.round((amountUsdc / r.rate) * 100) / 100,
      rate: r.rate,
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
 * Refuse to convert at a rate too far from the live mid.
 *
 * The FxSwapper's rate is set by us, so on a local chain this is the only
 * check against crediting e-money at a mispriced rate. Same idea as the quote
 * binding, applied where the number becomes a balance.
 *
 * `rate` is the venue's EUR/USD (USDC units per 1 EURe, 6dp), matching what
 * FxSwapper.rate() posts and what the liquidity providers report.
 */
export async function assertRateSane(rate: bigint): Promise<{ venue: number; mid: number }> {
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
  return { venue, mid };
}

/** The currency this account settles in. A Safe with no payment page is a
 *  euro account: its IBAN and its books are in euro. */
export function settlementTarget(user: User): "EURE" | "USDC" {
  return user.paymentPage?.settlementAsset ?? "EURE";
}

/**
 * Can this deposit be converted, and if not, why in words the user can act on?
 *
 * Nothing sweeps anywhere: the swap is one user-signed batch out of the user's
 * own Safe, delivering EURe back into it. Held and refused deposits can be
 * converted at any time; only a converted one, or one already in the
 * settlement currency, cannot.
 */
export function depositConversionBlocker(user: User, deposit: CryptoDeposit): string | null {
  if (deposit.token !== "USDC") return `only ${usdToken().symbol} deposits can be converted`;
  if (deposit.holding === "converted") return "this deposit has already been converted to EURe";
  if (deposit.holding === "unconfirmed") {
    return "a conversion of this deposit was sent and may still land — it has to be checked on chain before it can be converted again";
  }
  if (deposit.holding === "none") return "this deposit is already in your settlement currency, so there is nothing to convert";
  // Refused after the swap executed (it delivered nothing, or less than the
  // floor): that USDC is spent, and a second swap would spend other USDC.
  // Only a refusal before or without an executed swap can be retried.
  if (deposit.holding === "refused" && deposit.txs.some((t) => t.step === "safe.swap(usdc->eure)")) {
    return "a swap of this deposit went through and is under review — it cannot be converted again";
  }
  const identity = walletBlocker(user);
  if (identity) return identity;
  const amountUsdc = deposit.amountUsdc ?? 0;
  if (amountUsdc < CRYPTO_IN.minUsdc) {
    const sym = usdToken().symbol;
    return `${amountUsdc} ${sym} is below the ${CRYPTO_IN.minUsdc} ${sym} floor — converting it would cost more than it delivers`;
  }
  /**
   * No Safe, nothing to sign with. safeDebitBlocker is the same check the send
   * path uses, so the two cannot drift.
   */
  const safeBlocker = safeDebitBlocker(user);
  if (safeBlocker) {
    return (
      `${safeBlocker}. Your ${deposit.amountUsdc ?? 0} ${usdToken().symbol} is still yours at ${user.address} — ` +
      "it simply cannot be converted until the account can sign."
    );
  }
  return null;
}

/**
 * Does the Safe still hold this deposit's USDC? A held deposit can sit for
 * months, and the user may have spent it in the meantime. Read from the chain
 * before a quote is taken, so the answer is a plain sentence rather than a
 * bundler revert after the passkey prompt.
 *
 * Per deposit: two held deposits over a balance that covers only one both
 * pass, and the second swap then fails at the bundler.
 */
export async function heldUsdcBlocker(user: User, deposit: CryptoDeposit): Promise<string | null> {
  const need = BigInt(deposit.amountUnits);
  const have = (await publicClient.readContract({
    address: addrs().usdc,
    abi: abis.MockToken,
    functionName: "balanceOf",
    args: [user.address as `0x${string}`],
  })) as bigint;
  if (have >= need) return null;
  return (
    `your account holds ${usd.fromUnits(have)} ${usdToken().symbol}, less than the ${usd.fromUnits(need)} ${usdToken().symbol} this ` +
    "deposit brought in — it may have been spent. Nothing was prepared."
  );
}

/** What becomes of a newly arrived asset: kept as is, held, or waiting for
 *  the user's signature to convert. */
function holdingOnArrival(user: User, deposit: CryptoDeposit): Pick<CryptoDeposit, "holding" | "reason"> {
  if (deposit.token !== "USDC" || settlementTarget(user) === "USDC") return { holding: "none", reason: undefined };
  const blocker = depositConversionBlocker(user, { ...deposit, holding: "held" });
  if (user.paymentPage?.autoConvert && !blocker) {
    return {
      holding: "awaiting_approval",
      reason:
        "ready to convert to EURe — approve it with your passkey. Nothing can move your funds " +
        "without that signature.",
    };
  }
  return { holding: "held", reason: blocker ?? undefined };
}

/**
 * Settle a deposit on arrival: the invoice it pays, the pay link it matched,
 * and (via the statement writer) the books' receipt line. Once per deposit,
 * keyed on `settledAt`; a later conversion updates these records in place
 * rather than settling again.
 *
 * The swap is not performed here. Moving the user's USDC needs a UserOperation
 * their passkey signed, and this runs unattended.
 */
export function settleOnArrival(deposit: CryptoDeposit): CryptoDeposit {
  if (deposit.settledAt) return deposit;
  const user = store.findUser(deposit.userId);
  if (!user) throw new Error(`unknown user for crypto deposit ${deposit.id}`);
  const settled = store.updateCryptoDeposit(deposit.id, {
    // A migrated row may already know its holding (held, refused); only a
    // fresh one is decided here.
    ...(deposit.holding === "awaiting_approval" || deposit.holding === undefined
      ? holdingOnArrival(user, deposit)
      : {}),
    ...(deposit.token === "USDC" && deposit.holding !== "converted" ? { creditedUsdc: deposit.amountUsdc ?? 0 } : {}),
    settledAt: new Date().toISOString(),
  });
  if (settled.invoiceId) recordInvoiceSettlement(settled);
  noteDepositSettled(settled);
  return settled;
}

/**
 * Record the result of a conversion the user signed and the API submitted.
 *
 * The credited amount is measured as the Safe's EURe balance delta, not copied
 * from the quote (a swap that did not revert may still deliver less). The
 * signed floor is checked against that delta too.
 */
export async function settleConvertedDeposit(
  deposit: CryptoDeposit,
  user: User,
  quote: { provider: string; rate: bigint; minOut: bigint },
  balanceBeforeWei: bigint,
  txs: CryptoDeposit["txs"],
  /** The chain's record of the swap (tx hash, block, gas), when the
   *  submitter had a receipt. Absent on the harness stand-ins. */
  conversion?: CryptoDeposit["conversion"],
): Promise<CryptoDeposit> {
  const { venue: venueRate, mid: midRate } = await assertRateSane(quote.rate);
  const after = await balanceAfterWrite(addrs().eure, user.address as `0x${string}`, balanceBeforeWei);
  const receivedWei = after - balanceBeforeWei;

  if (receivedWei <= 0n) {
    return store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason: "the swap delivered no EURe to your account — nothing has been credited",
      txs,
    });
  }
  if (receivedWei < quote.minOut) {
    return store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason:
        `the swap delivered €${eur.fromWei(receivedWei)}, under the €${eur.fromWei(quote.minOut)} ` +
        "floor your signature guaranteed — left for review rather than credited",
      txs,
    });
  }

  const creditedEur = eur.fromWei(receivedWei);
  /**
   * The realised gain: what arrived minus its value at receipt. Recorded once,
   * now, and never recomputed from a later rate. Near zero when conversion
   * follows receipt promptly (the tax reason to convert promptly).
   *
   * Absent, not zero, when the receipt could not be valued.
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
  const amountInUnits = conversion?.amountInUnits ?? deposit.amountUnits;
  const leftover = BigInt(deposit.amountUnits) - BigInt(amountInUnits);
  /**
   * The deposit was settled on arrival; this records the disposal. The invoice
   * and pay-link rows are rewritten in place under the same ref (the receipt
   * value they were paid at does not change), and the statement writer adds
   * the disposal line — never a second receipt.
   */
  const settled = store.updateCryptoDeposit(deposit.id, {
    holding: "converted",
    creditedEur,
    creditedUsdc: undefined,
    settlementAsset: "EURE",
    provider: quote.provider,
    rate: venueRate,
    midRate,
    ...(realisedGainEur === undefined ? {} : { realisedGainEur }),
    conversion: { ...(conversion ?? {}), amountInUnits },
    ...(leftover > 0n ? { leftoverUnits: leftover.toString() } : {}),
    txs,
    reason: undefined,
  });
  if (settled.invoiceId) recordInvoiceSettlement(settled);
  noteDepositSettled(settled);
  writeStatementLines();
  return settled;
}

/**
 * Write the payment back onto the invoice it settles.
 *
 * The invoice is the Beleg and the deposit the Zahlung; German bookkeeping
 * wants them tied, so an auditor sees which transaction arrived, which
 * converted it and how much euro landed.
 *
 * Appends: an invoice can be settled by more than one payment.
 */
export function recordInvoiceSettlement(deposit: CryptoDeposit): void {
  if (!deposit.invoiceId) return;
  const invoice = store.invoices.find((i) => i.id === deposit.invoiceId);
  if (!invoice) return;
  store.updateInvoice(invoice.id, settlementUpdate(invoice, buildCryptoSettlement(deposit)));
}


/**
 * One scan of the chain for inbound USDC and EURe, followed by settlement of
 * whatever is new.
 *
 * The cursor advances once every log in the window is recorded, whether or not
 * it settled. An unsettled deposit is picked up by the sweep; an unrecorded one
 * behind the cursor is never seen again.
 */
let scanning = false;

/** Whether the scan is keeping up, for /api/health. No error text: an RPC
 *  error can carry the RPC URL, and some providers put the key in it. */
export const cryptoInScan: { lastOkAt?: string; failingSince?: string } = {};

export async function pollCryptoDepositsOnce(): Promise<number> {
  if (!CRYPTO_IN.enabled) return 0;
  /**
   * One scan at a time.
   *
   * setInterval does not wait for an async tick to finish, and a scan is a
   * getBlockNumber, two getLogs over up to 5,000 blocks, a getBlock per
   * distinct block and a rate lookup per USDC log — comfortably longer than
   * the 15s default interval on a busy window or a slow RPC. Two overlapping
   * scans read the same cursor and rescan the same range; addCryptoDeposit is
   * idempotent so nothing is double-recorded any more, but doing the work
   * twice is still wasted RPC and wasted third-party rate calls.
   */
  if (scanning) return 0;
  scanning = true;
  try {
    // Several windows per tick, so a backlog (an outage, a fresh deploy)
    // catches up in minutes rather than one window every pollMs.
    let found = 0;
    try {
      for (let w = 0; w < CRYPTO_IN.windowsPerTick; w++) {
        const r = await scanCryptoDeposits();
        found += r.found;
        if (!r.more) break;
      }
    } catch (err) {
      cryptoInScan.failingSince ??= new Date().toISOString();
      throw err;
    }
    cryptoInScan.lastOkAt = new Date().toISOString();
    delete cryptoInScan.failingSince;
    return found;
  } finally {
    scanning = false;
  }
}

async function scanCryptoDeposits(): Promise<{ found: number; more: boolean }> {
  const watched = watchedAddresses();
  if (watched.length === 0) return { found: 0, more: false };
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
  if (safeHead < 0n) return { found: 0, more: false };

  // A fresh install looks back one bounded window so a just-finished deposit
  // can still appear in Activity after the scanner deploys or restarts.
  const cursor = store.cryptoDepositCursor(cursorKey);
  if (cursor === undefined) {
    // Read later in windows of maxBlockSpan, so it can be longer than one.
    const lookback = CRYPTO_IN.firstLookbackBlocks;
    store.setCryptoDepositCursor(cursorKey, safeHead > lookback ? safeHead - lookback : 0n);
    return { found: 0, more: false };
  }
  if (safeHead <= cursor) return { found: 0, more: false };

  // Both tokens over one window, so the cursor moves past blocks read for both.
  const fromBlock = cursor + 1n;
  const tokens = [
    { token: "EURE" as const, address: addrs().eure },
    { token: "USDC" as const, address: addrs().usdc },
  ];
  const { toBlock, result: logsByToken } = await readLogWindow(fromBlock, safeHead, CRYPTO_IN.maxBlockSpan, (from, to) =>
    Promise.all(tokens.map((t) => publicClient.getLogs({
      address: t.address,
      event: TRANSFER_EVENT,
      args: { to: watched.map((x) => x.address) },
      fromBlock: from,
      toBlock: to,
    }))));

  const byAddress = new Map<string, WatchedAddress[]>();
  for (const item of watched) {
    const key = item.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), item]);
  }
  const fresh: CryptoDeposit[] = [];
  for (const [i, token] of tokens.entries()) {
    const logs = logsByToken[i];

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
      if (token.token === "EURE" && from === (addrs().swapper ?? "").toLowerCase()) continue;
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
      /**
       * The acquisition value, stamped once at detection with the rate's
       * provenance and never recomputed. A later feed rate is not the value
       * at receipt.
       */
      const receipt =
        token.token === "USDC"
          ? await valueAtReceipt(
              usd.fromUnits(value),
              log.blockNumber != null ? blockTimes.get(log.blockNumber) : undefined,
            )
          : undefined;
      /**
       * addCryptoDeposit is idempotent on (txHash, logIndex) and returns the
       * row that already existed rather than a second one. Compare the id back
       * so a deposit another pass already recorded is not attributed to a
       * payment link or converted a second time.
       */
      const depositId = randomUUID();
      const recorded = store.addCryptoDeposit({
          id: depositId,
          userId: user.id,
          chainId: CHAIN_ID,
          token: token.token,
          txHash,
          logIndex,
          amountUnits: value.toString(),
          ...(/^0x[0-9a-f]{40}$/.test(from) ? { from: from as `0x${string}` } : {}),
          ...(log.blockNumber != null && blockTimes.has(log.blockNumber) ? { arrivedAt: blockTimes.get(log.blockNumber) } : {}),
          ...(token.token === "EURE" ? { amountEur: eur.fromWei(value), creditedEur: eur.fromWei(value) } : {}),
          ...(token.token === "USDC"
            ? {
                amountUsdc: usd.fromUnits(value),
                ...(receipt ? { receipt, amountEur: receipt.amountEur } : {}),
              }
            : {}),
          settlementAsset: token.token,
          paymentAddress: match.address,
          // Decided by settleOnArrival below, once attribution has run.
          holding: "awaiting_approval",
          txs: [],
          detectedAt: now,
          updatedAt: now,
      });
      if (recorded.id === depositId) fresh.push(recorded);
    }
  }

  store.setCryptoDepositCursor(cursorKey, toBlock);

  // Does this money pay a link? Decided BEFORE settlement, so the link's
  // invoice is on the deposit when the settlement is written.
  for (const deposit of fresh) {
    try {
      attributeDepositToRequest(deposit);
    } catch (err: any) {
      console.error(`crypto-in: could not attribute deposit ${deposit.id} to a request: ${describeCause(err)}`);
    }
  }

  for (const stale of fresh) {
    const deposit = store.cryptoDeposits.find((d) => d.id === stale.id) ?? stale;
    try {
      settleOnArrival(deposit);
    } catch (err: any) {
      // Left without settledAt, so the next sweep writes it.
      console.error(`crypto-in: could not settle deposit ${deposit.id}: ${describeCause(err)}`);
    }
  }
  if (fresh.length) writeStatementLines();
  return { found: fresh.length, more: toBlock < safeHead };
}

/**
 * Settle deposits recorded but not yet settled: a crash between recording and
 * settlement, or rows from before settlement happened on arrival.
 *
 * Only rows without `settledAt`, and each is settled once. Held, waiting and
 * refused deposits are not looked at again: converting one is the user's act.
 */
export async function sweepPendingCryptoDeposits(): Promise<number> {
  if (!CRYPTO_IN.enabled) return 0;
  let n = 0;
  for (const d of [...store.cryptoDeposits]) {
    if (d.settledAt) continue;
    try {
      settleOnArrival(d);
      n++;
    } catch (err: any) {
      console.error(`crypto-in: could not settle deposit ${d.id}: ${describeCause(err)}`);
    }
  }
  if (n) writeStatementLines();
  return n;
}

export function startCryptoDepositPoller() {
  // One tick at a time: a slow partner or RPC must not stack a second pass
  // over the same rows on top of the first.
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sweepPendingCryptoDeposits();
      await pollCryptoDepositsOnce();
    } catch (err: any) {
      console.error(`crypto-in poll failed: ${describeCause(err)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, CRYPTO_IN.pollMs);
  timer.unref();
  return timer;
}
