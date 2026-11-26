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
import { balanceAfterWrite, deliveredFromReceipt, tokenTransfers, TRANSFER_EVENT } from "../liquidity.js";
import { safeDebitBlocker } from "../orchestrator.js";
import { walletBlocker } from "../domain/wallet-tier.js";
import { midRates, referenceRate } from "../rates.js";
import { attributeDepositToRequest, noteDepositSettled } from "../routes/payment-requests.js";
import { buildCryptoSettlement, settlementRef, settlementUpdate } from "../domain/invoices.js";
import { writeStatementLines } from "../bookkeeping/writer.js";
import { readLogWindow } from "../log-range.js";
import { conversionOutputs } from "../transfers/conversion-outputs.js";
import { conversionReverted } from "../transfers/activity.js";
import { userOperationOutcome } from "../wallet/candide.js";
import { someSeq } from "../seq.js";


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
 *   page entry wins.
 * - A page is watched whatever its auto-convert setting. The scanner skips a
 *   forwarder's second hop (page address to Safe) as already recorded, so an
 *   unwatched page with auto-convert off recorded a payment nowhere. What
 *   happens to the money is decided by holdingOnArrival, not by watching.
 * - Direct Safe funding is recorded for all accounts, approved or not. A
 *   pending account's Safe can already receive, and skipping it moves the
 *   cursor past the transfer for good.
 */
async function watchedAddresses(): Promise<WatchedAddress[]> {
  const seen = new Set<string>();
  const out: WatchedAddress[] = [];
  for (const user of (await store.list("users"))) {
    const add = (address: `0x${string}`, source: WatchedAddress["source"]) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || /^0x0{40}$/i.test(address)) return;
      const key = address.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ user, address, source });
    };
    if (user.paymentPage?.depositAddress) add(user.paymentPage.depositAddress, "payment-page");
    add(user.address, "safe");
  }
  return out;
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
/** USDC units of this deposit not yet converted: all of it, less any
 *  partial fills. */
export function unconvertedUnits(deposit: CryptoDeposit): bigint {
  const swapped = (deposit.partials ?? []).reduce((n, p) => n + BigInt(p.conversion.amountInUnits ?? "0"), 0n);
  const left = BigInt(deposit.amountUnits) - swapped;
  return left > 0n ? left : 0n;
}

/**
 * Did a swap of this deposit execute that is not recorded as a fill? Then its
 * USDC is spent, whatever became of the result. Each partial fill accounts for
 * one executed swap step; a row from before `partials` that carries a
 * conversion counts as executed too.
 */
function unrecordedSwap(deposit: CryptoDeposit): boolean {
  const executed = deposit.txs.filter((t) => t.step === "safe.swap(usdc->eure)").length;
  return executed > (deposit.partials?.length ?? 0) || (!!deposit.conversion && deposit.holding !== "converted");
}

export function depositConversionBlocker(user: User, deposit: CryptoDeposit): string | null {
  if (deposit.token !== "USDC") return `only ${usdToken().symbol} deposits can be converted`;
  if (deposit.holding === "converted") return "this deposit has already been converted to EURe";
  if (deposit.holding === "unconfirmed") {
    if (conversionReverted(deposit)) {
      return "a conversion of this deposit was included on chain but reverted, so nothing was converted — it is being checked before it can be converted again";
    }
    return "a conversion of this deposit was sent and may still land — it has to be checked on chain before it can be converted again";
  }
  // Written before the swap was submitted and never cleared: the process
  // stopped before the outcome was recorded, so the swap may have landed.
  if (deposit.conversionIntent) {
    return "a conversion of this deposit was started and its outcome was not recorded — it has to be checked on chain before it can be converted again";
  }
  if (deposit.holding === "none") return "this deposit is already in your settlement currency, so there is nothing to convert";
  // Refused after the swap executed (it delivered nothing, or less than the
  // floor): that USDC is spent, and a second swap would spend other USDC.
  // Only a refusal before or without an executed swap can be retried.
  if (deposit.holding === "refused" && unrecordedSwap(deposit)) {
    return "a swap of this deposit went through and is under review — it cannot be converted again";
  }
  const identity = walletBlocker(user);
  if (identity) return identity;
  const amountUsdc = usd.fromUnits(unconvertedUnits(deposit));
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
      `${safeBlocker}. Your ${amountUsdc} ${usdToken().symbol} is still yours at ${user.address} — ` +
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
  const need = unconvertedUnits(deposit);
  const have = (await publicClient.readContract({
    address: addrs().usdc,
    abi: abis.MockToken,
    functionName: "balanceOf",
    args: [user.address as `0x${string}`],
  })) as bigint;
  if (have >= need) return null;
  return (
    `your account holds ${usd.fromUnits(have)} ${usdToken().symbol}, less than the ${usd.fromUnits(need)} ${usdToken().symbol} of this ` +
    "deposit still to convert — it may have been spent. Nothing was prepared."
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
export async function settleOnArrival(deposit: CryptoDeposit): Promise<CryptoDeposit> {
  return store.tx(async () => {
    if (deposit.settledAt) return deposit;
    // The owner's row is the lock every writer of a deposit's money takes:
    // a link made while this settles is seen here, or sees this.
    const user = await store.lockUser(deposit.userId);
    if (!user) throw new Error(`unknown user for crypto deposit ${deposit.id}`);
    // `settledAt` is set once, on the stored row: a second settle finds it set.
    const settled = await store.settleCryptoDeposit(deposit.id, (row) => ({
      // A migrated row may already know its holding (held, refused); only a
      // fresh one is decided here.
      ...(row.holding === "awaiting_approval" || row.holding === undefined
        ? holdingOnArrival(user, row)
        : {}),
      ...(row.token === "USDC" && row.holding !== "converted" ? { creditedUsdc: row.amountUsdc ?? 0 } : {}),
    }));
    if (!settled) return (await store.list("cryptoDeposits")).find((d) => d.id === deposit.id) ?? deposit;
    if (settled.invoiceId) await recordInvoiceSettlement(settled);
    await noteDepositSettled(settled);
    return settled;
  });
}


/**
 * USDC a swap took from the Safe, read from the swap's own Transfer logs.
 * That is what left, not what the quote asked for; a balance delta would also
 * count a payment that arrived in the same block. A transfer to the paymaster
 * is gas paid in USDC, not swap input. Undefined when there is no receipt to
 * read.
 */
export async function usdcSwappedIn(
  txHash: string | undefined,
  userOpHash: string | null | undefined,
  safe: string,
  paymaster: string | null | undefined,
): Promise<bigint | undefined> {
  const transfers = await tokenTransfers(txHash, addrs().usdc, userOpHash);
  return transfers
    ?.filter((t) => t.from === safe.toLowerCase() && (!paymaster || t.to !== paymaster.toLowerCase()))
    .reduce((n, t) => n + t.value, 0n);
}

/**
 * EURe a swap delivered to the Safe, read from the swap's own Transfer logs.
 * EURe from any other transaction (a SEPA mint, a payment) is the scanner's
 * to book as its own deposit; the Safe moving EURe to itself delivers
 * nothing. The log indexes are what the scanner leaves out as conversion
 * output; any other EURe log in the same transaction is money in. Undefined
 * when there is no receipt to read.
 */
export async function eureSwappedOut(
  txHash: string | undefined,
  userOpHash: string | null | undefined,
  safe: string,
): Promise<{ wei: bigint; logIndexes: number[] } | undefined> {
  return deliveredFromReceipt(txHash, addrs().eure, safe, userOpHash);
}

/**
 * Record the result of a conversion the user signed and the API submitted.
 *
 * The credited amount is measured from the swap transaction's EURe Transfer
 * logs into the Safe, not copied from the quote (a swap that did not revert
 * may still deliver less) and not taken from the balance delta (EURe from
 * another transaction in the same window is the scanner's to book). The
 * signed floor is checked against that logged amount. The delta is only a
 * reconciliation check: more than logged is recorded on the conversion for
 * the reconciler, less than logged means EURe left the Safe mid-swap and the
 * conversion is left for review.
 *
 * Runs after the swap executed, so it must not throw on anything but a
 * failure to read the chain (no receipt is one): the caller has already
 * marked the row `unconfirmed` and leaves it there if this throws.
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
  // The rate was checked against the mid before the swap was submitted. After
  // it, a feed outage must not lose the record of a swap that happened: the
  // mid is recorded when there is one and left out when there is not.
  const venueRate = Number(quote.rate) / 1e6;
  const midRate = await midRates().then((r) => r.eur.USD, () => undefined);
  const swapTx = conversion?.txHash;
  const output = await eureSwappedOut(swapTx, conversion?.userOpHash, user.address);
  if (swapTx === undefined || output === undefined) throw new Error("the swap has no transaction receipt to measure what arrived");
  const receivedWei = output.wei;
  // Whatever happens below, the swap step names the logs that were its own
  // output, so the scanner books every other EURe log in the bundle.
  const stepped = (outputLogIndexes: number[]) =>
    txs.map((t) => (t.step === "safe.swap(usdc->eure)" && t.hash.toLowerCase() === swapTx.toLowerCase() ? { ...t, outputLogIndexes } : t));
  txs = stepped(output.logIndexes);
  // Wait for a read that shows the logged output, so a replica that has seen
  // an earlier inflow but not the swap does not read as EURe leaving.
  const after = await balanceAfterWrite(addrs().eure, user.address as `0x${string}`, balanceBeforeWei, balanceBeforeWei + receivedWei);
  const deltaWei = after - balanceBeforeWei;

  if (receivedWei <= 0n) {
    return await store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason: "the swap delivered no EURe to your account — nothing has been credited",
      txs,
    });
  }
  // The scanner read this transaction before the conversion was recorded and
  // booked its output as money in. Crediting it as well would book it twice;
  // the scanner's row stays the one record of that EURe until reviewed.
  if ((await someSeq(output.logIndexes, async (i) => await store.findCryptoDeposit(CHAIN_ID, swapTx, i)))) {
    return await store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason: "what the swap delivered was already recorded as a deposit — left for review rather than credited twice",
      txs: stepped([]),
    });
  }
  if (deltaWei < receivedWei) {
    return await store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason:
        `the swap delivered €${eur.fromWei(receivedWei)}, but the account's balance shows only €${eur.fromWei(deltaWei)} more ` +
        "— EURe may have left the account while it ran, or the balance read is behind; left for review rather than credited",
      txs,
    });
  }
  if (receivedWei < quote.minOut) {
    return await store.updateCryptoDeposit(deposit.id, {
      holding: "refused",
      reason:
        `the swap delivered €${eur.fromWei(receivedWei)}, under the €${eur.fromWei(quote.minOut)} ` +
        "floor your signature guaranteed — left for review rather than credited",
      txs,
    });
  }

  const filledEur = eur.fromWei(receivedWei);
  const remaining = unconvertedUnits(deposit);
  const amountInUnits = BigInt(conversion?.amountInUnits ?? remaining.toString());
  const leftover = remaining - amountInUnits;
  const rates = { provider: quote.provider, rate: venueRate, ...(midRate ? { midRate } : {}) };
  // More arrived than the swap delivered: another transaction's EURe, which
  // the scanner books as its own deposit. Kept for the reconciler, not credited.
  const otherInflowWei = deltaWei - receivedWei;
  const recorded = {
    ...(conversion ?? {}),
    amountInUnits: amountInUnits.toString(),
    ...(otherInflowWei > 0n ? { otherInflowWei: otherInflowWei.toString() } : {}),
  };
  console.log(
    `crypto-in: converted ${usd.fromUnits(amountInUnits)} USDC to EUR ${filledEur} for user ${user.id} ` +
      `via ${quote.provider} at ${venueRate.toFixed(4)}` + (leftover > 0n ? ` (${usd.fromUnits(leftover)} USDC left held)` : ""),
  );

  /**
   * A partial fill: the swap took less than was held. The rest stays held and
   * can be converted later; this fill is kept as a partial with its share of
   * the receipt value, which its own disposal line books.
   */
  if (leftover > 0n) {
    const receiptPortionEur = deposit.receipt
      ? Number((BigInt(Math.round(deposit.receipt.amountEur * 100)) * amountInUnits) / BigInt(deposit.amountUnits)) / 100
      : undefined;
    // Appended on the stored row (§2 rule 2): a partial recorded meanwhile
    // stays, and what is left is counted from the stored partials.
    const leftOn = (d: CryptoDeposit) => {
      const left = unconvertedUnits(d) - amountInUnits;
      return left > 0n ? left : 0n;
    };
    const held = (await store.patchCryptoDeposit(deposit.id, (d) => ({
      holding: "held",
      partials: [
        ...(d.partials ?? []),
        {
          creditedEur: filledEur,
          ...(receiptPortionEur === undefined ? {} : { receiptPortionEur }),
          ...rates,
          conversion: recorded,
        },
      ],
      creditedUsdc: usd.fromUnits(leftOn(d)),
      leftoverUnits: leftOn(d).toString(),
      txs,
      reason: `part of it converted; ${usd.fromUnits(leftOn(d))} ${usdToken().symbol} is still held and can be converted any time`,
    })))!;
    await writeStatementLines();
    return held;
  }

  /**
   * The deposit was settled on arrival; this records the disposal. The invoice
   * and pay-link rows are rewritten in place under the same ref (the receipt
   * value they were paid at does not change), and the statement writer adds
   * the disposal line — never a second receipt. The credit sums the partials
   * stored on the row (§2 rule 2).
   */
  const settled = (await store.patchCryptoDeposit(deposit.id, (d) => {
    const creditedEur = Math.round((filledEur + (d.partials ?? []).reduce((n, p) => n + p.creditedEur, 0)) * 100) / 100;
    /**
     * The realised gain over every conversion of this deposit: what arrived
     * minus its value at receipt. Recorded once, now, and never recomputed from
     * a later rate. Near zero when conversion follows receipt promptly (the tax
     * reason to convert promptly).
     *
     * Absent, not zero, when the receipt could not be valued.
     */
    const realisedGainEur =
      deposit.receipt
        ? Math.round((creditedEur - deposit.receipt.amountEur) * 100) / 100
        : undefined;
    return {
      holding: "converted",
      creditedEur,
      creditedUsdc: undefined,
      settlementAsset: "EURE",
      ...rates,
      ...(realisedGainEur === undefined ? {} : { realisedGainEur }),
      conversion: recorded,
      leftoverUnits: undefined,
      txs,
      reason: undefined,
    };
  }))!;
  if (settled.invoiceId) await recordInvoiceSettlement(settled);
  await noteDepositSettled(settled);
  await writeStatementLines();
  return settled;
}

/**
 * Clear the conversion intent of a row settling already moved off
 * `unconfirmed`, after a later write threw. A second failure leaves it set:
 * the row is then blocked (fail closed), as before.
 */
export async function clearSettledIntent(id: string): Promise<void> {
  try {
    await store.updateCryptoDeposit(id, { conversionIntent: undefined });
  } catch (err) {
    console.error(`crypto-in: deposit ${id}: conversion intent not cleared: ${describeCause(err)}`);
  }
}

/**
 * Resolve conversions whose submit was uncertain. The route parks such a row
 * with the userOpHash, which no EURe log carries, so the scanner could not
 * tell the swap's output from money in. Once the bundler has a receipt, the
 * swap step names the transaction (the scanner then leaves its output alone)
 * and the row is settled against its conversion intent, as the route would
 * have done. No receipt, or no answer: the row stays as it is. Included but
 * reverted: nothing converted, and the row stays unconfirmed for review.
 * Landed but not settled (no intent, or a failed read while settling): the
 * row is refused for review, never credited; a row settling already credited
 * keeps its credit. The step always carries the
 * swap's output log indexes, empty when the scanner booked them first.
 * Runs before a scan, so the step is on the row before its logs are read.
 */
export async function settleUnconfirmedConversions(outcome = userOperationOutcome): Promise<void> {
  for (const d of [...await store.list("cryptoDeposits")]) {
    const step = d.holding === "unconfirmed" ? d.txs.find((t) => t.step === "safe.swap(usdc->eure).unconfirmed") : undefined;
    if (!step) continue;
    const userOpHash = step.hash;
    let op: Awaited<ReturnType<typeof outcome>>;
    try {
      op = await outcome(userOpHash);
    } catch (err) {
      console.error(`crypto-in: deposit ${d.id}: receipt read for swap ${userOpHash} failed: ${describeCause(err)}`);
      continue;
    }
    if (!op) continue;
    const rest = d.txs.filter((t) => t !== step);
    if (!op.success) {
      await store.updateCryptoDeposit(d.id, {
        reason: `the swap ${userOpHash} was included but reverted — nothing was converted; it is being checked before it is offered again`,
        txs: [...rest, { step: "safe.swap(usdc->eure).reverted", hash: op.txHash }, { step: "userOperation", hash: userOpHash }],
      });
      continue;
    }
    const user = await store.findUser(d.userId);
    if (!user) continue;
    /**
     * The swap's own EURe logs, read before the step is rewritten. A swap
     * step never lands on the row without them: one without would make every
     * EURe log in the transaction conversion output, and EURe the scanner
     * already booked from it would drop out of the books. A failed read
     * leaves the row as it is, for the next poll.
     */
    let output: Awaited<ReturnType<typeof eureSwappedOut>>;
    try {
      output = await eureSwappedOut(op.txHash, userOpHash, user.address);
    } catch (err) {
      console.error(`crypto-in: deposit ${d.id}: output read for swap ${op.txHash} failed: ${describeCause(err)}`);
      continue;
    }
    if (!output) continue;
    // Output the scanner booked first stays its record, as settling would leave it.
    const booked = await someSeq(output.logIndexes, async (i) => await store.findCryptoDeposit(CHAIN_ID, op.txHash, i));
    const txs = [
      ...rest,
      { step: "safe.swap(usdc->eure)", hash: op.txHash, outputLogIndexes: booked ? [] : output.logIndexes },
      { step: "userOperation", hash: userOpHash },
    ];
    const intent = d.conversionIntent;
    // Without the signed quote there is no floor to settle against.
    if (!intent) {
      await store.updateCryptoDeposit(d.id, {
        holding: "refused",
        reason: "the swap went through, but its signed quote was not kept — nothing has been credited; it is being checked and will not be offered again",
        txs,
      });
      continue;
    }
    const executed = await store.updateCryptoDeposit(d.id, { reason: "the swap went through; recording what arrived", txs });
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: op.txHash as `0x${string}` });
      // The block before the swap: what the Safe held when it ran.
      const before = (await publicClient.readContract({
        address: addrs().eure, abi: abis.MockToken, functionName: "balanceOf", args: [user.address as `0x${string}`],
        blockNumber: receipt.blockNumber - 1n,
      })) as bigint;
      const asked = BigInt(intent.amountUnits);
      const took = await usdcSwappedIn(op.txHash, userOpHash, user.address, intent.paymaster);
      const amountIn = took === undefined || took <= 0n || took > asked ? asked : took;
      const at = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
        .then((b) => new Date(Number(b.timestamp) * 1000).toISOString(), () => undefined);
      await settleConvertedDeposit(
        executed, user,
        { provider: intent.quote.provider, rate: BigInt(intent.quote.rate), minOut: BigInt(intent.quote.minOut) },
        before, txs,
        { userOpHash, txHash: op.txHash, blockNumber: Number(receipt.blockNumber), ...(at ? { at } : {}), amountInUnits: amountIn.toString() },
      );
      await store.updateCryptoDeposit(d.id, { conversionIntent: undefined });
    } catch (err) {
      console.error(`crypto-in: deposit ${d.id}: swap ${op.txHash} executed but was not recorded: ${describeCause(err)}`);
      // Settling may have credited the row before the throw; that credit stands.
      // Its outcome is on record (settling writes holding, fill and txs in one
      // write), so the intent goes too, or the rest of a partial fill would be
      // blocked as an unrecorded outcome.
      if ((await store.list("cryptoDeposits")).find((x) => x.id === d.id)?.holding !== "unconfirmed") {
        await clearSettledIntent(d.id);
        continue;
      }
      await store.updateCryptoDeposit(d.id, {
        holding: "refused",
        reason: "the swap went through, but what arrived could not be recorded — nothing has been credited; it is being checked and will not be offered again",
      });
    }
  }
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
export async function recordInvoiceSettlement(deposit: CryptoDeposit): Promise<void> {
  if (!deposit.invoiceId || !(await store.findInvoice(deposit.invoiceId))) return;
  const s = buildCryptoSettlement(deposit);
  // Computed from the stored row; a converted deposit rewrites its own
  // settlement under the same ref (withSettlement), never adds a second.
  await store.settleInvoice(deposit.invoiceId, settlementRef(s), (row) => settlementUpdate(row, s), true);
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
/**
 * The getLogs width the RPC last answered (log-range.ts). Starting every
 * window at maxBlockSpan paid for the same refusals each time: on Alchemy's
 * free tier, seven per window.
 *
 * It grows back, doubling after GROW_AFTER windows in a row that the width
 * itself cut short, so one refusal cannot pin the scanner to tiny windows. A
 * caught-up scanner's windows end at the head, not at the width, so it never
 * probes and pays nothing for this.
 */
let logSpan = CRYPTO_IN.maxBlockSpan;
let fullWindows = 0;
const GROW_AFTER = 4;

const SCAN_CURSOR_KEY = () => `${CHAIN_ID}:safe-funding-v1`;
/** Where the last applied rescan started, kept beside the cursor it moved. */
const RESCAN_APPLIED_KEY = () => `${CHAIN_ID}:safe-funding-v1:rescan-applied`;

export type RescanState = "applied" | "already-applied" | "refused";

/** Whether the scan is keeping up, for /api/health. No error text: an RPC
 *  error can carry the RPC URL, and some providers put the key in it. */
export const cryptoInScan: {
  lastOkAt?: string;
  failingSince?: string;
  rescan?: { fromBlock: string; state: RescanState };
} = {};

export async function pollCryptoDepositsOnce(outcome = userOperationOutcome): Promise<number> {
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
      // Nothing watched asks the chain nothing, and still counts as a scan.
      if ((await watchedAddresses()).length > 0) {
        /**
         * One head per tick, not per window: a tick reads the chain up to where
         * it stood when the tick began, and the next tick goes on from there.
         *
         * cacheTime: 0 is load-bearing.
         *
         * viem caches getBlockNumber for its polling interval, so consecutive ticks
         * can read the same stale head. For a cursor-driven scanner that is not a
         * stale number, it is skipped blocks: the cursor is written from this value,
         * so a head that lags behind the chain moves the window past deposits that
         * were never scanned, and nothing ever goes back for them.
         */
        const head = await publicClient.getBlockNumber({ cacheTime: 0 });
        // After the head is read: a swap the bundler has no receipt for now
        // lands past it, outside this tick's window.
        await settleUnconfirmedConversions(outcome);
        for (let w = 0; w < CRYPTO_IN.windowsPerTick; w++) {
          const r = await scanCryptoDeposits(head);
          found += r.found;
          if (!r.more) break;
        }
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

async function scanCryptoDeposits(head: bigint): Promise<{ found: number; more: boolean }> {
  const watched = await watchedAddresses();
  if (watched.length === 0) return { found: 0, more: false };
  const cursorKey = SCAN_CURSOR_KEY();
  const safeHead = head - BigInt(CRYPTO_IN.confirmations);
  if (safeHead < 0n) return { found: 0, more: false };

  // A fresh install looks back one bounded window so a just-finished deposit
  // can still appear in Activity after the scanner deploys or restarts.
  const cursor = await store.cryptoDepositCursor(cursorKey);
  if (cursor === undefined) {
    // Read later in windows of maxBlockSpan, so it can be longer than one.
    const lookback = CRYPTO_IN.firstLookbackBlocks;
    await store.setCryptoDepositCursor(cursorKey, safeHead > lookback ? safeHead - lookback : 0n);
    return { found: 0, more: false };
  }
  if (safeHead <= cursor) return { found: 0, more: false };

  // Both tokens over one window, so the cursor moves past blocks read for both.
  const fromBlock = cursor + 1n;
  const tokens = [
    { token: "EURE" as const, address: addrs().eure },
    { token: "USDC" as const, address: addrs().usdc },
  ];
  // One getLogs naming both tokens, split by log.address below: a provider
  // that caps the range (Alchemy's free tier: 10 blocks) bills per call.
  const { toBlock, span, result: logs } = await readLogWindow(fromBlock, safeHead, logSpan, (from, to) =>
    publicClient.getLogs({
      address: tokens.map((t) => t.address),
      event: TRANSFER_EVENT,
      args: { to: watched.map((x) => x.address) },
      fromBlock: from,
      toBlock: to,
    }));
  if (span < logSpan) fullWindows = 0;
  logSpan = span;
  if (toBlock - fromBlock + 1n === span && span < CRYPTO_IN.maxBlockSpan && ++fullWindows >= GROW_AFTER) {
    logSpan = span * 2n < CRYPTO_IN.maxBlockSpan ? span * 2n : CRYPTO_IN.maxBlockSpan;
    fullWindows = 0;
  }
  const logsByToken = tokens.map((t) => logs.filter((l) => l.address.toLowerCase() === t.address.toLowerCase()));

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
      if ((await store.findCryptoDeposit(CHAIN_ID, txHash, logIndex))) continue;

      const pageMatch = matches.find((m) => m.source === "payment-page" && m.user.paymentPage?.autoConvert);
      const match = token.token === "USDC" && pageMatch ? pageMatch : matches[0];
      // The forwarder's second hop: page money already recorded when it
      // arrived at the deposit address, now landing on the owner's Safe.
      // Recording it again would double-count one payment.
      const ownPage = match.user.paymentPage?.depositAddress?.toLowerCase();
      if (match.source === "safe" && ownPage && ownPage !== to && from === ownPage) continue;
      const user = match.user;
      // A conversion's EURe output, or a failed transfer's reverse-swap
      // refund, is the user's money changing form, not money in
      // (transfers/activity.ts lists the same rule). Another EURe
      // log in the same bundle is money in. Read now, not before this scan's
      // awaits: a conversion settled meanwhile has named its output.
      if (token.token === "EURE" && conversionOutputs(await store.list("cryptoDeposits"), await store.list("transfers"))(txHash, logIndex, user.id)) continue;
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
      const recorded = await store.addCryptoDeposit({
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

  await store.setCryptoDepositCursor(cursorKey, toBlock);

  // Does this money pay a link? Decided BEFORE settlement, so the link's
  // invoice is on the deposit when the settlement is written.
  for (const deposit of fresh) {
    try {
      await attributeDepositToRequest(deposit);
    } catch (err: any) {
      console.error(`crypto-in: could not attribute deposit ${deposit.id} to a request: ${describeCause(err)}`);
    }
  }

  for (const stale of fresh) {
    const deposit = (await store.list("cryptoDeposits")).find((d) => d.id === stale.id) ?? stale;
    try {
      await settleOnArrival(deposit);
    } catch (err: any) {
      // Left without settledAt, so the next sweep writes it.
      console.error(`crypto-in: could not settle deposit ${deposit.id}: ${describeCause(err)}`);
    }
  }
  if (fresh.length) await writeStatementLines();
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
  for (const d of [...await store.list("cryptoDeposits")]) {
    if (d.settledAt) continue;
    try {
      // A crash between recording and attributing would otherwise settle the
      // deposit with no pay link, and nothing attributes it afterwards.
      await attributeDepositToRequest(d);
    } catch (err: any) {
      console.error(`crypto-in: could not attribute deposit ${d.id} to a request: ${describeCause(err)}`);
    }
    try {
      await settleOnArrival((await store.list("cryptoDeposits")).find((x) => x.id === d.id) ?? d);
      n++;
    } catch (err: any) {
      console.error(`crypto-in: could not settle deposit ${d.id}: ${describeCause(err)}`);
    }
  }
  if (n) await writeStatementLines();
  return n;
}

/**
 * Rewind the scan cursor to just before `fromBlock`, once per value.
 *
 * Never moves the cursor forward: a cursor already behind the block is left
 * where it is. Refuses a block past the chain head, or further back than
 * `maxBlocks` (each window is an RPC call); a refusal leaves the cursor alone
 * and is not recorded, so a corrected value applies on the next boot.
 */
export async function applyCryptoRescan(
  fromBlock: bigint | undefined = CRYPTO_IN.rescanFromBlock,
  maxBlocks: bigint = CRYPTO_IN.maxRescanBlocks,
): Promise<RescanState | undefined> {
  if (fromBlock === undefined) return undefined;
  const note = (state: RescanState) => {
    cryptoInScan.rescan = { fromBlock: fromBlock.toString(), state };
    return state;
  };
  if ((await store.cryptoDepositCursor(RESCAN_APPLIED_KEY())) === fromBlock) return note("already-applied");

  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  if (fromBlock > head || head - fromBlock > maxBlocks) {
    console.error(
      `crypto-in: refusing rescan from block ${fromBlock}: the head is ${head} and the limit is ` +
        `${maxBlocks} blocks back (CRYPTO_IN_MAX_RESCAN_BLOCKS). The cursor is unchanged.`,
    );
    return note("refused");
  }
  const target = fromBlock > 0n ? fromBlock - 1n : 0n;
  const cursor = await store.cryptoDepositCursor(SCAN_CURSOR_KEY());
  if (cursor === undefined || cursor > target) await store.setCryptoDepositCursor(SCAN_CURSOR_KEY(), target);
  await store.setCryptoDepositCursor(RESCAN_APPLIED_KEY(), fromBlock);
  console.log(`crypto-in: rescanning from block ${fromBlock} (cursor was ${cursor ?? "unset"}, head ${head})`);
  return note("applied");
}

export function startCryptoDepositPoller() {
  // One tick at a time: a slow partner or RPC must not stack a second pass
  // over the same rows on top of the first.
  let busy = false;
  // Set only once the rescan check returns: an RPC failure retries next tick.
  let rescanChecked = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!rescanChecked) {
        await applyCryptoRescan();
        rescanChecked = true;
      }
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
