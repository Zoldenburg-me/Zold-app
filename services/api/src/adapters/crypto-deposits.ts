/**
 * Crypto in: USDC forwarded from a payment page into the merchant Safe.
 *
 * SEPA plus Monerium EURe is the main way in; this watches payment-page
 * deposit addresses for inbound USDC so a corridor payout can be funded from
 * crypto without a bank.
 *
 *   detect  - read Transfer logs addressed to the watched addresses (this file)
 *   convert - a user-signed batch swaps USDC->EURe into the merchant Safe;
 *             settleConvertedDeposit records what arrived
 *
 * Only the swap needs Candide's bundler, which hardhat lacks, so detection and
 * settlement are testable locally and the swap is not.
 *
 * Limits:
 * - Nothing converts without `user.paymentPage.autoConvert`.
 * - It watches the page's configured forwarding recipient. In production that
 *   should be the merchant Safe via Candide's forwarding address, not an
 *   API-held payment-page owner key.
 * - Deposits are recorded for every account; the KYC gate sits in front of
 *   the user-signed conversion to e-money.
 * - The sending address is not screened. Source of funds for an unsolicited
 *   transfer belongs with a compliance provider.
 */
import { randomUUID } from "node:crypto";
import { CHAIN_ID, CRYPTO_IN } from "../config.js";
import { store, type CryptoDeposit, type User } from "../store.js";
import { addrs, eur, usd, publicClient } from "../chain.js";
import { balanceAfterWrite } from "../liquidity.js";
import { safeDebitBlocker } from "../orchestrator.js";
import { midRates } from "../rates.js";
import { attributeDepositToRequest, noteDepositSettled } from "../routes/payment-requests.js";
import { buildCryptoSettlement, withSettlement } from "../domain/invoices.js";

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
 *   cursor past the transfer for good. Page auto-convert stays approved-only
 *   because conversion is a credit decision.
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
 * Returns undefined when no rate is available (rates.ts has no stale
 * fallback). The deposit is then recorded without a receipt value and can be
 * valued later; a made-up rate would put a wrong figure in the books.
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
    if (!page) throw new Error("this account has no payment page");
    const blocker = depositConversionBlocker(user, deposit);
    // Settling in USDC, or auto-settlement off, completes the deposit as USDC:
    // the forwarder has already delivered it to the Safe. Marking it REFUSED
    // would show a fault to a payee whose link was paid in full.
    if (page.settlementAsset === "USDC" || !page.autoConvert) {
      const settled = store.updateCryptoDeposit(deposit.id, {
        state: "CONVERTED",
        creditedUsdc: deposit.amountUsdc ?? 0,
        settlementAsset: "USDC",
        txs,
        reason: undefined,
      });
      /**
       * Record it on the invoice even though nothing converted. Settling in
       * USDC is still an event the books need: the receivable is discharged
       * and an asset is acquired at its euro value on receipt. Only the
       * disposal has not happened yet, so the row carries no conversion and no
       * realised gain — absent, not zero, because zero would be a claim.
       * Leaving this out meant the default configuration (auto-convert off)
       * wrote no invoice settlement at all.
       */
      if (settled.invoiceId) recordInvoiceSettlement(settled);
      noteDepositSettled(settled);
      return settled;
    }
    if (blocker) throw new Error(blocker);

    /**
     * The swap is not performed here. Moving the user's USDC needs a
     * UserOperation their passkey signed, and this poller runs unattended.
     * "Auto-convert" means detected automatically and converted on approval;
     * the reason text tells the user a signature is pending.
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
): Promise<CryptoDeposit> {
  const { venue: venueRate, mid: midRate } = await assertRateSane(quote.rate);
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
  const settled = store.updateCryptoDeposit(deposit.id, {
    state: "CONVERTED",
    creditedEur,
    settlementAsset: "EURE",
    provider: quote.provider,
    rate: venueRate,
    midRate,
    ...(realisedGainEur === undefined ? {} : { realisedGainEur }),
    txs,
    reason: undefined,
  });
  if (settled.invoiceId) recordInvoiceSettlement(settled);
  noteDepositSettled(settled);
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
  store.updateInvoice(invoice.id, {
    settlements: withSettlement(invoice.settlements, buildCryptoSettlement(deposit)),
  });
}


/**
 * One scan of the chain for inbound USDC, followed by conversion of whatever
 * is new.
 *
 * The cursor advances once every log in the window is recorded, whether or not
 * it converted. An unconverted deposit is a REFUSED row someone can act on; an
 * unrecorded one behind the cursor is never seen again.
 */
let scanning = false;

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
    return await scanCryptoDeposits();
  } finally {
    scanning = false;
  }
}

async function scanCryptoDeposits(): Promise<number> {
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
      const directSafeFunding = match.source === "safe" || token.token === "EURE";
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
      });
      if (recorded.id === depositId) fresh.push(recorded);
    }
  }

  store.setCryptoDepositCursor(cursorKey, toBlock);

  // Does this money pay a link? Decided BEFORE conversion, because whether a
  // deposit is asked-for changes what happens to it when auto-convert is off.
  for (const deposit of fresh) {
    try {
      attributeDepositToRequest(deposit);
      /**
       * A deposit straight to the Safe is written CONVERTED, so its conversion
       * has already been and gone by the time attribution hands it an invoice.
       * Record here rather than let that case silently lose its settlement.
       */
      const linked = store.findCryptoDeposit(deposit.txHash, deposit.logIndex);
      if (linked?.state === "CONVERTED" && linked.invoiceId) recordInvoiceSettlement(linked);
    } catch (err: any) {
      console.error(`crypto-in: could not attribute deposit ${deposit.id} to a request: ${err?.message ?? err}`);
    }
  }

  for (const stale of fresh) {
    const deposit = store.cryptoDeposits.find((d) => d.id === stale.id) ?? stale;
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
 * REFUSED deposits are skipped: they are below the floor or not opted in, and
 * retrying them would hit the venue on every tick.
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
