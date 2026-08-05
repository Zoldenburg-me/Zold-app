/**
 * Crypto in — USDC forwarded from a payment page into the merchant Safe.
 *
 * The funding story until now was one-directional: euros arrive by SEPA and
 * Monerium issues EURe to the user's Safe. A crypto-native user holding USDC had
 * no way in at all. This watches payment-page deposit addresses for inbound
 * USDC and settles into the merchant Safe, so a corridor payout can be funded
 * from crypto without the user first finding a bank.
 *
 * Three separable steps, deliberately:
 *
 *   detect  — read Transfer logs addressed to the merchant Safe (this file)
 *   sweep   — legacy EURe-settlement path, moving merchant Safe USDC to the
 *             executor so a venue can trade it
 *   convert — swap USDC->EURe into the merchant Safe
 *
 * They are split because only the middle one needs Candide's bundler, which no
 * hardhat node provides. Detection and conversion are therefore testable
 * locally and the sweep is not — the same seam the Safe-funded transfer path
 * has, for the same reason.
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
import {
  abis,
  addrs,
  eur,
  usd,
  publicClient,
  safeEurBalance,
  orchestratorAddress,
} from "../chain.js";
import { liquidityProvider } from "../liquidity.js";
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

/** The one step name that means "this deposit's tokens reached the
 *  orchestrator". Shared by the producer and the resumability check so the two
 *  cannot drift apart. */
export const SWEEP_STEP = "safe.transfer(usdc->orchestrator)";

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
 * Get Safe-held USDC to the executor, which is who the venues trade with today.
 *
 * Returns the step to record, or null if the tokens were already there — the
 * resumable case, where a previous run moved them and died before crediting.
 *
 * Candide Forwarding Address deposits route into the merchant's Safe. The next
 * The API no longer holds merchant Safe owner keys, so this refuses until the
 * settlement path has a Safe-native UserOp or strict policy delegate.
 */
async function sweepToOrchestrator(
  user: User,
  amount: bigint,
  deposit: CryptoDeposit,
): Promise<{ step: string; hash: string } | null> {
  /**
   * Resumability is decided by THIS deposit's own record, not by a balance.
   *
   * Checking `orchestrator holds >= amount` looked equivalent and is not: the
   * orchestrator's USDC is working capital for in-flight transfers, not
   * earmarked. A deposit arriving while a transfer held USDC there would skip
   * its own sweep, convert somebody else's tokens, credit the depositor, and
   * leave the transfer short — with the deposit still sitting in the user's
   * Safe. The step we recorded is the only thing that actually means "these
   * euros already moved".
   */
  if (deposit.txs.some((x) => x.step === SWEEP_STEP)) return null;

  const page = user.paymentPage;
  if (!page) throw new Error("account has no payment page");
  const code = await publicClient.getBytecode({ address: user.address });
  if (!code || code === "0x") {
    throw new Error(
      `merchant Safe ${user.address} is not deployed, so the forwarded USDC cannot be moved ` +
        `— it is still yours at that address, but this chain cannot convert it`,
    );
  }
  throw new Error("merchant Safe settlement requires Safe-native UserOps or a configured allowance module");
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

  const amount = BigInt(deposit.amountUnits);
  const txs: CryptoDeposit["txs"] = [...deposit.txs];

  try {
    const page = user.paymentPage;
    if (!page?.autoConvert) throw new Error("payment page has auto-settlement switched off");
    if (user.kycStatus !== "approved") throw new Error("account is not KYC-approved");
    const amountUsdc = deposit.amountUsdc ?? 0;
    if (amountUsdc < CRYPTO_IN.minUsdc) {
      throw new Error(
        `below the ${CRYPTO_IN.minUsdc} USDC floor — left as USDC rather than converted to dust`,
      );
    }
    if (page.settlementAsset === "USDC") {
      return store.updateCryptoDeposit(deposit.id, {
        state: "CONVERTED",
        creditedUsdc: amountUsdc,
        settlementAsset: "USDC",
        txs,
        reason: undefined,
      });
    }

    const sweep = await sweepToOrchestrator(user, amount, deposit);
    if (sweep) txs.push(sweep);

    const provider = liquidityProvider();
    const quoteId = `crypto-in-${deposit.id}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const quote = await provider.quote("USDC_TO_EURE", amount, quoteId, expiresAt);
    const venueRate = await assertRateSane(quote.rate);

    const before = eur.toWei(await safeEurBalance(user.address));
    const execution = await provider.execute(quote, user.address);
    txs.push(...execution.txs);
    const after = eur.toWei(await safeEurBalance(user.address));

    const receivedWei = after - before;
    if (receivedWei <= 0n) {
      throw new Error("the swap delivered no EURe to the merchant Safe — refusing to settle");
    }
    if (receivedWei < quote.minOut) {
      throw new Error(
        `swap delivered ${eur.fromWei(receivedWei)} EURe, under the ${eur.fromWei(quote.minOut)} ` +
          `minimum the quote guaranteed — left for review`,
      );
    }

    const creditedEur = eur.fromWei(receivedWei);
    console.log(
      `crypto-in: converted ${amountUsdc} USDC to €${creditedEur} for ${user.name} ` +
        `via ${quote.provider} at ${venueRate.toFixed(4)}`,
    );
    return store.updateCryptoDeposit(deposit.id, {
      state: "CONVERTED",
      creditedEur,
      settlementAsset: "EURE",
      provider: quote.provider,
      rate: venueRate,
      txs,
      reason: undefined,
    });
  } catch (err: any) {
    const reason = String(err?.shortMessage ?? err?.message ?? err);
    console.warn(`crypto-in: refusing deposit ${deposit.txHash}#${deposit.logIndex}: ${reason}`);
    return store.updateCryptoDeposit(deposit.id, { state: "REFUSED", reason, txs });
  }
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
