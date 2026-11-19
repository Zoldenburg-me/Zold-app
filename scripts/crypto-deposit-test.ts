/**
 * Crypto in — USDC arriving at a payment page settles into the user's Safe.
 *
 * Detection runs against a real chain: USDC moves on-chain to a watched
 * address and the poller reads the Transfer log. Every deposit settles on
 * arrival; a USDC one is then held, or waits for the passkey, until converted.
 *
 * The swap itself cannot run here: it is a user-signed batch out of the
 * user's Safe, which needs Candide's bundler and paymaster, and hardhat has
 * neither. So these seed the input (USDC arrived, row not yet settled), drive
 * settlement, then call settleConvertedDeposit directly with EURe minted into
 * the Safe to stand in for the landed batch.
 *
 * Seed the input, never the output of the step under test: a fixture that
 * already carries the result lets an early return skip the code under test.
 *
 * Run: npm run crypto-deposit:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { hardhatNode } from "./_free-port.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Its own node on a port the OS assigns: a fixed one collides with a parallel run.
const chain = await hardhatNode(ROOT);
const RPC = chain.url;
process.env.TRANSF_RPC_URL = RPC;
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.MG_ANCHOR_DOMAIN = "";
// The swapper is seeded at this rate; pin the mid to match so the sanity check
// has a stable reference instead of asserting what the euro did overnight.
const MID = 1.1379;
const pinMid = (usd: number) =>
  (process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: usd, INR: 109.87, KES: 147.53 }));
pinMid(MID);
process.env.DEPLOY_EURUSD_RATE ??= String(Math.round(MID * 1e6));

const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const children: ChildProcess[] = [chain.child];
const bg = (cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: process.env });
  children.push(c);
  return c;
};

async function waitRpc(timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`   ok  ${label}`);
};

try {
  console.log("1/15 chain + deploy…");
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  const { encodeFunctionData } = await import("viem");
  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, usd, publicClient, writeAndWait, deployerWallet } =
    await import("../services/api/src/chain.js");
  const {
    applyCryptoRescan, assertRateSane, depositConversionBlocker, heldUsdcBlocker, pollCryptoDepositsOnce, settleConvertedDeposit,
    settleOnArrival, sweepPendingCryptoDeposits,
  } = await import("../services/api/src/adapters/crypto-deposits.js");
  initStore();
  const cursorKey = "31337:safe-funding-v1";

  const safeBalanceOf = async (who: `0x${string}`) =>
    eur.fromWei(
      (await publicClient.readContract({
        address: addrs().eure,
        abi: abis.MockToken,
        functionName: "balanceOf",
        args: [who],
      })) as bigint,
    );

  /** Each account gets its own address, as in production — deposits are
   *  attributed by address, so a shared one would attribute them wrongly. */
  function addUser(
    name: string,
    opts: {
      autoConvert?: boolean; kyc?: string; settlementAsset?: "EURE" | "USDC";
      /** Record an ACTIVE passkey Safe so safeDebitBlocker passes. No Safe can
       *  actually be deployed on hardhat (no bundler), and step 3 covers the
       *  undeployed case for real — this is for the cases about deposit
       *  handling, where Safe deployment is not what is under test. */
      withSafe?: boolean;
      /** A forwarder page: payers pay this address, and a second hop moves
       *  the money on to the Safe. Defaults to the Safe itself (local-safe). */
      depositAddress?: `0x${string}`;
    } = {},
  ) {
    const owner = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    const now = new Date().toISOString();
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address: owner,
      ...(opts.withSafe
        ? {
            passkey: { credentialId: `cred-${name}`, publicKey: { x: "0x1", y: "0x2" } },
            passkeySafe: { status: "active", address: owner },
          }
        : {}),
      iban: "",
      kycStatus: opts.kyc ?? "approved",
      paymentPage: {
        handle: name.toLowerCase().replace(/\s+/g, "-"),
        depositAddress: opts.depositAddress ?? owner,
        recipientAddress: owner,
        forwarder: {
          provider: opts.depositAddress ? "candide" : "local-safe",
          recipient: owner,
          destinationChainId: 31337,
          sourceChainIds: [31337],
          custodialWithdrawer: owner,
          active: true,
          activatedAt: now,
        },
        settlementAsset: opts.settlementAsset ?? "EURE",
        autoConvert: opts.autoConvert ?? true,
        createdAt: now,
        updatedAt: now,
      },
      createdAt: now,
    } as any;
    store.addUser(user);
    return user;
  }

  /** Stand in for the signed swap having landed: EURe arrives in the user's own
   *  Safe. The batch itself cannot run here — it needs Candide's bundler, and
   *  no hardhat node has one. */
  const mintEure = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet!, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, eur.toWei(amount)],
    });

  const sendUsdc = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet!, {
      address: addrs().usdc,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, usd.toUnits(amount)],
    });
  const sendEure = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet!, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, eur.toWei(amount)],
    });

  /** A transfer sent BY an address no test key controls: the forwarder's
   *  second hop, page address to Safe. Hardhat impersonates the sender. */
  const rpc = (method: string, params: unknown[]) =>
    fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((r) => r.json()).then((j: any) => {
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    });
  async function forwardUsdc(from: `0x${string}`, to: `0x${string}`, amount: number) {
    await rpc("hardhat_impersonateAccount", [from]);
    await rpc("hardhat_setBalance", [from, "0xDE0B6B3A7640000"]);
    const hash = await rpc("eth_sendTransaction", [{
      from,
      to: addrs().usdc,
      data: encodeFunctionData({ abi: abis.MockToken, functionName: "transfer", args: [to, usd.toUnits(amount)] }),
    }]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  /** The state a completed sweep leaves: tokens with the orchestrator, the
   *  step on the deposit's own record. */
  /**
   * Seed a deposit in the state the POLLER records it before settlement: USDC
   * has arrived at the user's own address and nothing has been settled. Deliberately no sweep row
   * and nothing at the orchestrator — seeding the output of the step under
   * test is what hid a dead code path here for months.
   */
  async function seedReadyDeposit(user: any, amountUsdc: number) {
    // Deliberately does NOT move real USDC. Nothing in the path under test
    // reads a USDC balance — parking reads the deposit row, and settling
    // measures the EURe delta — and sending to the user's own address would
    // make the poller see it as a second, real deposit on the next scan.
    const now = new Date().toISOString();
    return store.addCryptoDeposit({
      id: randomUUID(),
      userId: user.id,
      chainId: 31337,
      token: "USDC",
      txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0")}`,
      logIndex: 0,
      amountUnits: usd.toUnits(amountUsdc).toString(),
      amountUsdc,
      settlementAsset: "USDC",
      paymentAddress: user.paymentPage.depositAddress,
      holding: "awaiting_approval",
      txs: [],
      detectedAt: now,
      updatedAt: now,
    });
  }

  console.log("2/15 nobody opted in — the chain is not even read…");
  {
    const before = store.cryptoDepositCursor(cursorKey);
    const n = await pollCryptoDepositsOnce();
    check("no watched users means no work", n === 0);
    check("and no cursor is written", store.cryptoDepositCursor(cursorKey) === before);
  }

  console.log("3/15 a real inbound transfer is detected and attributed…");
  const ann = addUser("Crypto Ann");
  // The first poll only establishes the cursor: transfers from before the
  // account opted in are deliberately not swept up.
  await pollCryptoDepositsOnce();
  {
    await sendUsdc(ann.paymentPage.depositAddress, 100);
    const n = await pollCryptoDepositsOnce();
    check("the deposit was detected", n === 1, `detected ${n}`);
    const d = store.cryptoDeposits.find((x) => x.userId === ann.id)!;
    check("attributed to the right account", d.userId === ann.id);
    check("100 USDC recorded from the log", d.amountUsdc === 100, `${d.amountUsdc}`);
    check("it is settled on arrival", Boolean(d.settledAt));
    // No Safe is deployed locally, so it cannot ask for a signature: it is
    // held, and the money is still the user's at the destination address.
    check("an undeployed Safe holds it rather than asking for a signature", d.holding === "held", d.holding);
    // The reason comes from safeDebitBlocker, the check the send path uses,
    // so both paths agree on what is spendable. The assertion checks intent:
    // it names a Safe problem and says the money has not moved.
    check(
      "and the reason says the money is still theirs",
      /Safe/.test(d.reason ?? "") && /still yours/.test(d.reason ?? ""),
      d.reason ?? "",
    );
    check("nothing was settled", (await safeBalanceOf(ann.address)) === 0);
  }

  console.log("4/15 a ready deposit parks for a signature, then settles what ARRIVED…");
  const bo = addUser("Crypto Bo", { withSafe: true });
  {
    /**
     * The swap is a user-signed batch out of the user's own Safe, so the
     * poller can only park the deposit; the crediting logic lives in
     * settleConvertedDeposit, which is exercised directly here.
     */
    const parked = settleOnArrival(await seedReadyDeposit(bo, 100));
    check("it settles on arrival and waits for the signature", Boolean(parked.settledAt) && parked.holding === "awaiting_approval", parked.holding);
    check(
      "and says a passkey signature is what is missing",
      /passkey/i.test(parked.reason ?? ""),
      parked.reason ?? "",
    );
    check("nothing is credited before the signature", !parked.creditedEur);

    // Simulate the signed batch having landed: EURe arrives in the user's own
    // Safe. settleConvertedDeposit credits what the swap's logs MEASURED, not
    // the quote.
    const before = eur.toWei(await safeBalanceOf(bo.address));
    const swapTx = await mintEure(bo.address, 87.88);
    const d = await settleConvertedDeposit(
      parked, store.findUser(bo.id)!,
      { provider: "fx-swapper", rate: BigInt(Math.round(MID * 1e6)), minOut: eur.toWei(80) },
      before, [...parked.txs, { step: "safe.swap(usdc->eure)", hash: swapTx }], { txHash: swapTx },
    );
    check("it is converted once the swap has landed", d.holding === "converted" && d.settlementAsset === "EURE", `${d.holding} (${d.reason ?? ""})`);
    check("the held USDC figure is cleared, the received one kept", d.creditedUsdc === undefined && d.amountUsdc === 100);
    check(
      "the credit is the euro value that ARRIVED, not the dollar number",
      d.creditedEur! > 87 && d.creditedEur! < 89,
      `EUR ${d.creditedEur}`,
    );
    check(
      "the venue and rate are recorded for the receipt",
      d.provider === "fx-swapper" && Math.abs(d.rate! - MID) < 0.01,
      `${d.provider} @ ${d.rate}`,
    );
    check(
      "the swap is on the record and nothing swept anywhere",
      d.txs.some((x) => x.step.includes("usdc->eure")) &&
        !d.txs.some((x) => /vault|sweep|orchestrator/i.test(x.step)),
      d.txs.map((x) => x.step).join(","),
    );
    const bal = await safeBalanceOf(bo.address);
    check("the balance is spendable in the Safe", Math.abs(bal - 87.88) < 0.001, `EUR ${bal}`);
  }

  console.log("5/15 the same deposit is never credited twice…");
  {
    const d = store.cryptoDeposits.find((x) => x.userId === bo.id && x.holding === "converted")!;
    const balBefore = await safeBalanceOf(bo.address);
    const again = settleOnArrival(d);
    check("settling a converted deposit again is a no-op", again.holding === "converted" && again.settledAt === d.settledAt);
    check("and the blocker refuses a second conversion", /already been converted/.test(depositConversionBlocker(store.findUser(bo.id)!, d) ?? ""));
    check("the balance did not move", (await safeBalanceOf(bo.address)) === balBefore, `€${balBefore}`);

    // Catch up first: step 4 minted EURe into Bo's Safe to stand in for the
    // signed swap landing, and the poller records inbound EURe too (step 9).
    // Without this the rewind would find that transfer for the first time and
    // count it as new — which is correct behaviour, but not what this step is
    // asking about. The question here is whether a log already RECORDED gets
    // recorded twice.
    await pollCryptoDepositsOnce();
    // Rewind the cursor so the poller re-reads every log from genesis.
    const countBefore = store.cryptoDeposits.length;
    store.setCryptoDepositCursor(cursorKey, 0n);
    const n = await pollCryptoDepositsOnce();
    check("re-reading the same log records nothing new", n === 0, `got ${n}`);
    check("and no duplicate row appears", store.cryptoDeposits.length === countBefore);
  }

  console.log("6/15 dust is left alone, direct Safe funding is only recorded…");
  {
    const dusty = addUser("Dusty", { withSafe: true });
    const d = settleOnArrival(await seedReadyDeposit(dusty, 0.25));
    check("a sub-floor deposit is settled and held, not queued for a signature", d.holding === "held" && Boolean(d.settledAt), d.holding);
    check("and says why in words", /floor/.test(d.reason ?? ""), d.reason ?? "");
    check("nothing was credited for it", !d.creditedEur);

    const optedOut = addUser("Holds USDC", { autoConvert: false });
    await sendUsdc(optedOut.paymentPage.depositAddress, 50);
    await pollCryptoDepositsOnce();
    const direct = store.cryptoDeposits.find((x) => x.userId === optedOut.id);
    check(
      "an opted-out account settles direct USDC on arrival and holds it",
      Boolean(direct?.settledAt) && direct!.holding === "held" && direct!.creditedUsdc === 50 && direct!.settlementAsset === "USDC",
      JSON.stringify(direct),
    );
    check("and keeps a zero EUR balance", (await safeBalanceOf(optedOut.address)) === 0);
  }

  console.log("7/15 a venue price off the market is refused before the swap…");
  {
    // The convert route runs assertRateSane BEFORE it submits the signed swap
    // (routes/crypto-deposits.ts). That is where a mispriced venue is stopped.
    const venue = BigInt(Math.round(MID * 1e6));
    const ok = await assertRateSane(venue);
    check("a rate at the mid passes", Math.abs(ok.venue - MID) < 1e-6 && ok.mid === MID, `${ok.venue} vs ${ok.mid}`);

    // Tell the feed the market is 1.40 while the venue still fills at 1.1379.
    pinMid(1.4);
    try {
      let reason = "";
      try {
        await assertRateSane(venue);
      } catch (err: any) {
        reason = String(err?.message ?? err);
      }
      check("a rate far off the mid is refused", reason !== "", "it passed");
      check("and the reason names the drift", /bps from the live mid/.test(reason), reason);

      // After the swap the EURe is already in the Safe: refusing then would
      // lose the record of a swap that happened. It is recorded, mid and all.
      const cass = addUser("Cass", { withSafe: true });
      const parked = settleOnArrival(await seedReadyDeposit(cass, 100));
      const before = eur.toWei(await safeBalanceOf(cass.address));
      const swapTx = await mintEure(cass.address, 87.88);
      const d = await settleConvertedDeposit(
        parked, store.findUser(cass.id)!,
        { provider: "fx-swapper", rate: venue, minOut: eur.toWei(80) },
        before, parked.txs, { txHash: swapTx },
      );
      check(
        "a swap that already landed is recorded with the mid it was checked against",
        d.holding === "converted" && d.midRate === 1.4 && Math.abs(d.rate! - MID) < 1e-6,
        `${d.holding} rate=${d.rate} mid=${d.midRate}`,
      );
    } finally {
      pinMid(MID);
    }
  }

  console.log("8/15 a USDC-settled page does not turn the payment into euros…");
  {
    const dana = addUser("Crypto Dana", { settlementAsset: "USDC" });
    const seeded = await seedReadyDeposit(dana, 25);
    const d = settleOnArrival(seeded);
    check("it is settled with nothing to convert", Boolean(d.settledAt) && d.holding === "none" && d.settlementAsset === "USDC", d.holding);
    check("and the blocker says so", /already in your settlement currency/.test(depositConversionBlocker(dana, d) ?? ""));
    check("it does not credit euro balance", (await safeBalanceOf(dana.address)) === 0);
    check("the USDC amount is recorded", d.creditedUsdc === 25, `${d.creditedUsdc}`);
  }

  console.log("9/15 a direct EURe transfer to the Safe appears as funding activity…");
  {
    const eva = addUser("Crypto Eva", { autoConvert: false });
    await sendEure(eva.address, 30);
    await pollCryptoDepositsOnce();
    const d = store.cryptoDeposits.find((x) => x.userId === eva.id);
    check(
      "30 EURe was recorded from the chain log",
      d?.token === "EURE" && d.amountEur === 30 && d.creditedEur === 30 && d.holding === "none" && Boolean(d.settledAt),
      JSON.stringify(d),
    );
  }

  console.log("10/15 held USDC converts later; spent USDC is refused before a quote…");
  {
    const hal = addUser("Held Hal", { withSafe: true, autoConvert: false });
    await sendUsdc(hal.paymentPage.depositAddress, 40);
    await pollCryptoDepositsOnce();
    const held = store.cryptoDeposits.find((x) => x.userId === hal.id)!;
    check("with auto-convert off it is settled and held, no signature asked", held.holding === "held" && Boolean(held.settledAt) && !held.reason, `${held.holding} ${held.reason ?? ""}`);
    check("a held deposit has no blocker", depositConversionBlocker(store.findUser(hal.id)!, held) === null);
    check("and the Safe still holds its USDC", (await heldUsdcBlocker(store.findUser(hal.id)!, held)) === null);
    const before = eur.toWei(await safeBalanceOf(hal.address));
    const swapTx = await mintEure(hal.address, 35.1);
    const settledAt = held.settledAt;
    const d = await settleConvertedDeposit(
      held, store.findUser(hal.id)!,
      { provider: "fx-swapper", rate: BigInt(Math.round(MID * 1e6)), minOut: eur.toWei(34) },
      before, [{ step: "safe.swap(usdc->eure)", hash: swapTx }], { txHash: swapTx },
    );
    check("converted later, at the measured output", d.holding === "converted" && Math.abs(d.creditedEur! - 35.1) < 0.001, `${d.holding} ${d.creditedEur}`);
    check("its settlement time is the arrival, not the conversion", d.settledAt === settledAt);

    // Seeded without moving USDC: the Safe holds only Hal's 40 (the stand-in
    // swap above minted EURe and burned nothing), less than this 60, as if spent.
    const spent = settleOnArrival(await seedReadyDeposit(hal, 60));
    const why = await heldUsdcBlocker(store.findUser(hal.id)!, spent);
    check("a deposit whose USDC is no longer in the Safe is refused in words", /holds 40 USDC, less than the 60 USDC/.test(why ?? "") && /may have been spent/.test(why ?? ""), why ?? "none");
  }

  console.log("11/15 the sweep settles what was missed, once, and leaves held deposits alone…");
  {
    const gil = addUser("Sweep Gil", { withSafe: true });
    const missed = await seedReadyDeposit(gil, 12);
    const n = await sweepPendingCryptoDeposits();
    const after = store.cryptoDeposits.find((x) => x.id === missed.id)!;
    check("an unsettled row is settled by the sweep", n === 1 && Boolean(after.settledAt) && after.holding === "awaiting_approval", `${n} ${after.holding}`);
    const stamp = after.updatedAt;
    const again = await sweepPendingCryptoDeposits();
    check("a second sweep touches nothing", again === 0 && store.cryptoDeposits.find((x) => x.id === missed.id)!.updatedAt === stamp);
  }

  console.log("12/15 a forwarder page with auto-convert off records the payment once…");
  {
    // Seen on a live page: auto-convert off, no open payment request, payment
    // to the forwarder address. The page was not watched, and the forwarder's
    // second hop into the Safe is skipped as already recorded — so it was
    // recorded nowhere.
    const page = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    const fay = addUser("Forward Fay", { withSafe: true, autoConvert: false, depositAddress: page });
    await sendUsdc(page, 20);
    await pollCryptoDepositsOnce();
    await forwardUsdc(page, fay.address, 20);
    await pollCryptoDepositsOnce();
    const rows = store.cryptoDeposits.filter((x) => x.userId === fay.id);
    check("the payment is recorded exactly once", rows.length === 1, `${rows.length} rows`);
    const d = rows[0];
    check(
      "at the page address it was paid to, settled and held as USDC",
      d?.paymentAddress?.toLowerCase() === page.toLowerCase() && d.amountUsdc === 20 &&
        Boolean(d.settledAt) && d.holding === "held",
      JSON.stringify(d),
    );
  }

  console.log("13/15 a rescan records what the cursor passed, once…");
  {
    // A payment the scanner passed without recording: it reached an address
    // that was not watched yet. The cursor moves past it, and nothing goes back.
    const page = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    await sendUsdc(page, 15);
    const paidAt = await publicClient.getBlockNumber({ cacheTime: 0 });
    await pollCryptoDepositsOnce();
    const gus = addUser("Rescan Gus", { withSafe: true, autoConvert: false, depositAddress: page });
    await pollCryptoDepositsOnce();
    check("without a rescan the passed payment stays unrecorded", !store.cryptoDeposits.some((x) => x.userId === gus.id));

    await rpc("evm_mine", []); // so the payment is at least one block back
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    const cursorBefore = store.cryptoDepositCursor(cursorKey);
    check("a block past the head is refused", (await applyCryptoRescan(head + 5n, 1_000n)) === "refused");
    check("a block further back than the limit is refused", (await applyCryptoRescan(paidAt, 0n)) === "refused");
    check("and a refusal leaves the cursor alone", store.cryptoDepositCursor(cursorKey) === cursorBefore);

    const total = store.cryptoDeposits.length;
    check("a rescan from the payment's block is applied", (await applyCryptoRescan(paidAt, 1_000n)) === "applied");
    check("it rewinds to just before that block", store.cryptoDepositCursor(cursorKey) === paidAt - 1n);
    await pollCryptoDepositsOnce();
    const rows = store.cryptoDeposits.filter((x) => x.userId === gus.id);
    check(
      "the passed payment is recorded, at its page, held",
      rows.length === 1 && rows[0].amountUsdc === 15 && rows[0].holding === "held" && Boolean(rows[0].settledAt),
      JSON.stringify(rows),
    );
    check("and nothing already recorded is recorded again", store.cryptoDeposits.length === total + 1, `${store.cryptoDeposits.length - total} new`);

    const caughtUp = store.cryptoDepositCursor(cursorKey);
    check("the same value on the next boot does not rewind again", (await applyCryptoRescan(paidAt, 1_000n)) === "already-applied");
    check("so the cursor stays where the scan left it", store.cryptoDepositCursor(cursorKey) === caughtUp);
  }

  console.log("14/15 EURe from another transaction during the swap is booked once…");
  {
    // The conversion credits what the swap's own Transfer logs delivered to
    // the Safe. A SEPA mint landing between the before and after balance reads
    // is booked by the scanner as its own deposit, so crediting the balance
    // delta would book it twice.
    const quote = { provider: "fx-swapper", rate: BigInt(Math.round(MID * 1e6)), minOut: eur.toWei(80) };
    const ida = addUser("Mid-swap Ida", { withSafe: true });
    const parked = settleOnArrival(await seedReadyDeposit(ida, 100));
    const before = eur.toWei(await safeBalanceOf(ida.address));
    const swapTx = await mintEure(ida.address, 87.88);
    await sendEure(ida.address, 30);
    const d = await settleConvertedDeposit(
      parked, store.findUser(ida.id)!, quote, before,
      [...parked.txs, { step: "safe.swap(usdc->eure)", hash: swapTx }], { txHash: swapTx },
    );
    await pollCryptoDepositsOnce();
    const inflows = store.cryptoDeposits.filter((x) => x.userId === ida.id && x.token === "EURE");
    check("the mint is booked once, as its own deposit", inflows.length === 1 && inflows[0].creditedEur === 30, JSON.stringify(inflows));
    check("the conversion credits only what its own logs delivered", d.holding === "converted" && d.creditedEur === 87.88, `${d.holding} ${d.creditedEur}`);
    check(
      "the books add up to what the Safe holds",
      Math.abs(d.creditedEur! + inflows[0].creditedEur! - (await safeBalanceOf(ida.address))) < 0.001,
    );
    check("the other money is recorded on the conversion for the reconciler", d.conversion?.otherInflowWei === eur.toWei(30).toString(), JSON.stringify(d.conversion));
    const { reconcile } = await import("../services/api/src/reconcile.js");
    const found = (await reconcile()).findings.filter((f) => f.kind === "CONVERSION_OVERLAP" && f.address === ida.address);
    check("and the reconciler reports it", found.length === 1 && found[0].amountEur === 30, JSON.stringify(found));

    // The signed floor holds against the logged output, not a delta another
    // inflow inflated past it.
    const jo = addUser("Floor Jo", { withSafe: true });
    const joParked = settleOnArrival(await seedReadyDeposit(jo, 100));
    const joBefore = eur.toWei(await safeBalanceOf(jo.address));
    const thin = await mintEure(jo.address, 20);
    await sendEure(jo.address, 70);
    const under = await settleConvertedDeposit(
      joParked, store.findUser(jo.id)!, quote, joBefore,
      [...joParked.txs, { step: "safe.swap(usdc->eure)", hash: thin }], { txHash: thin },
    );
    check("a swap under the floor is refused although the delta clears it", under.holding === "refused" && !under.creditedEur && /floor/.test(under.reason ?? ""), `${under.holding} ${under.reason ?? ""}`);

    // Less arrived than the logs show: EURe left the Safe mid-swap. Nothing is
    // credited and the USDC is not offered again; a person looks at it.
    const kai = addUser("Outflow Kai", { withSafe: true });
    const kaiParked = settleOnArrival(await seedReadyDeposit(kai, 100));
    await mintEure(kai.address, 50);
    const kaiBefore = eur.toWei(await safeBalanceOf(kai.address));
    const out = await mintEure(kai.address, 87.88);
    await rpc("hardhat_impersonateAccount", [kai.address]);
    await rpc("hardhat_setBalance", [kai.address, "0xDE0B6B3A7640000"]);
    await publicClient.waitForTransactionReceipt({
      hash: await rpc("eth_sendTransaction", [{
        from: kai.address,
        to: addrs().eure,
        data: encodeFunctionData({ abi: abis.MockToken, functionName: "transfer", args: [`0x${"5e".repeat(20)}`, eur.toWei(40)] }),
      }]),
    });
    const short = await settleConvertedDeposit(
      kaiParked, store.findUser(kai.id)!, quote, kaiBefore,
      [...kaiParked.txs, { step: "safe.swap(usdc->eure)", hash: out }], { txHash: out },
    );
    check("a delta under the logged output is left for review, nothing credited", short.holding === "refused" && !short.creditedEur && /review/.test(short.reason ?? ""), `${short.holding} ${short.reason ?? ""}`);
    check("and the deposit is not offered for conversion again", /under review/.test(depositConversionBlocker(store.findUser(kai.id)!, short) ?? ""));
    await pollCryptoDepositsOnce();
    const kaiIn = store.cryptoDeposits.filter((x) => x.userId === kai.id && x.token === "EURE");
    check("the refused swap's output is never booked as money in", !kaiIn.some((x) => x.txHash === out) && kaiIn.length === 1, JSON.stringify(kaiIn.map((x) => x.amountEur)));

    // The scanner reads the swap before it is settled. With the executed
    // swap on the row (the route writes it before settling), the output is
    // left alone and settling credits it once.
    const lea = addUser("Settling Lea", { withSafe: true });
    const leaParked = settleOnArrival(await seedReadyDeposit(lea, 100));
    const leaBefore = eur.toWei(await safeBalanceOf(lea.address));
    const leaTx = await mintEure(lea.address, 87.88);
    const leaTxs = [...leaParked.txs, { step: "safe.swap(usdc->eure)", hash: leaTx }];
    store.updateCryptoDeposit(leaParked.id, { holding: "unconfirmed", txs: leaTxs });
    await pollCryptoDepositsOnce();
    check("a scan before settling books nothing from the swap", !store.cryptoDeposits.some((x) => x.userId === lea.id && x.token === "EURE"));
    const leaD = await settleConvertedDeposit(store.cryptoDeposits.find((x) => x.id === leaParked.id)!, store.findUser(lea.id)!, quote, leaBefore, leaTxs, { txHash: leaTx });
    check("and settling credits it once", leaD.holding === "converted" && leaD.creditedEur === 87.88, `${leaD.holding} ${leaD.creditedEur}`);

    // Without that record the scanner books the output first; settling then
    // refuses to credit it again and leaves it for review.
    const max = addUser("Raced Max", { withSafe: true });
    const maxParked = settleOnArrival(await seedReadyDeposit(max, 100));
    const maxBefore = eur.toWei(await safeBalanceOf(max.address));
    const maxTx = await mintEure(max.address, 87.88);
    await pollCryptoDepositsOnce();
    const raced = await settleConvertedDeposit(maxParked, store.findUser(max.id)!, quote, maxBefore,
      [...maxParked.txs, { step: "safe.swap(usdc->eure)", hash: maxTx }], { txHash: maxTx });
    check("output the scanner already booked is not credited twice", raced.holding === "refused" && !raced.creditedEur && /already recorded as a deposit/.test(raced.reason ?? ""), `${raced.holding} ${raced.reason ?? ""}`);
    const { withoutConversionOutputs } = await import("../services/api/src/transfers/activity.js");
    check("and the scanner's row stays the one record of that EURe",
      withoutConversionOutputs(store.cryptoDeposits.filter((x) => x.userId === max.id), []).filter((x) => x.token === "EURE").length === 1);

    // The route's uncertain submit parks the row with the userOpHash, which no
    // EURe log carries. The poll resolves it to the transaction first, so the
    // swap's output is not booked as money in and the deposit is credited once.
    const { ENTRYPOINT_V9 } = await import("abstractionkit");
    const realReceipt = publicClient.getTransactionReceipt;
    /** The bundle's own UserOperationEvent, which a deployer mint lacks. */
    const opOfTx = new Map<string, string>();
    (publicClient as any).getTransactionReceipt = async (args: { hash: `0x${string}` }) => {
      const r = await realReceipt(args);
      const op = opOfTx.get(args.hash.toLowerCase());
      if (!op) return r;
      const event = { ...r.logs[0], address: ENTRYPOINT_V9, data: "0x", logIndex: r.logs.length,
        topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", op] };
      return { ...r, logs: [...r.logs, event] };
    };
    const parkUncertain = async (name: string) => {
      const user = addUser(name, { withSafe: true });
      const parked = settleOnArrival(await seedReadyDeposit(user, 100));
      const op = `0x${randomBytes(32).toString("hex")}`;
      store.updateCryptoDeposit(parked.id, {
        holding: "unconfirmed",
        conversionIntent: {
          at: new Date().toISOString(), amountUnits: parked.amountUnits, safeAddress: user.address,
          quote: { provider: quote.provider, rate: quote.rate.toString(), minOut: quote.minOut.toString() },
        },
        txs: [...parked.txs, { step: "safe.swap(usdc->eure).unconfirmed", hash: op }],
      });
      return { user, id: parked.id, op, row: () => store.cryptoDeposits.find((x) => x.id === parked.id)! };
    };
    const eureOf = (userId: string) => store.cryptoDeposits.filter((x) => x.userId === userId && x.token === "EURE");

    const noa = await parkUncertain("Uncertain Noa");
    await pollCryptoDepositsOnce(async () => null);
    check("an unresolved userOp leaves the deposit unconfirmed", noa.row().holding === "unconfirmed" && noa.row().txs.some((t) => t.step.endsWith(".unconfirmed")));
    const noaTx = await mintEure(noa.user.address, 87.88);
    opOfTx.set(noaTx.toLowerCase(), noa.op);
    const lands = async (h: string) => (h === noa.op ? { success: true, txHash: noaTx } : null);
    await pollCryptoDepositsOnce(lands);
    check("once it resolves, the swap's output is not booked as a deposit", eureOf(noa.user.id).length === 0, JSON.stringify(eureOf(noa.user.id)));
    const noaD = noa.row();
    check("and the deposit is credited what the swap delivered", noaD.holding === "converted" && noaD.creditedEur === 87.88, `${noaD.holding} ${noaD.creditedEur} ${noaD.reason ?? ""}`);
    check("its swap step names the transaction and the logs it delivered",
      noaD.txs.some((t) => t.step === "safe.swap(usdc->eure)" && t.hash === noaTx && t.outputLogIndexes?.length === 1), JSON.stringify(noaD.txs));
    check("and the intent is cleared", noaD.conversionIntent === undefined);
    await pollCryptoDepositsOnce(lands);
    check("a later poll changes nothing", eureOf(noa.user.id).length === 0 && noa.row().creditedEur === 87.88 && noa.row().txs.length === noaD.txs.length);

    // Included but reverted: nothing converted, and nothing is guessed. The
    // row waits for a person; EURe that does arrive is money in.
    const ota = await parkUncertain("Reverted Ota");
    await mintEure(ota.user.address, 12);
    const otaTx = `0x${randomBytes(32).toString("hex")}`;
    await pollCryptoDepositsOnce(async (h) => (h === ota.op ? { success: false, txHash: otaTx } : null));
    const otaD = ota.row();
    check("a reverted userOp is left unconfirmed for review", otaD.holding === "unconfirmed" && /reverted/.test(otaD.reason ?? "") && !otaD.creditedEur && otaD.txs.some((t) => t.step === "safe.swap(usdc->eure).reverted" && t.hash === otaTx), `${otaD.holding} ${otaD.reason ?? ""}`);
    check("and is not offered for conversion again", /may still land/.test(depositConversionBlocker(store.findUser(ota.user.id)!, otaD) ?? ""));
    check("other EURe in its user's Safe is booked as money in", eureOf(ota.user.id).length === 1 && eureOf(ota.user.id)[0].creditedEur === 12);

    // The bundler lags: the scanner books the swap's output as money in while
    // the op is unresolved, and the op resolves after. That row stays the one
    // record of the EURe; the USDC row is left for review, not credited.
    const userEure = (userId: string) => withoutConversionOutputs(store.cryptoDeposits.filter((x) => x.userId === userId), []).filter((x) => x.token === "EURE");
    const lateResolve = async (name: string, opts: { intent: boolean }) => {
      const u = await parkUncertain(name);
      if (!opts.intent) store.updateCryptoDeposit(u.id, { conversionIntent: undefined });
      const tx = await mintEure(u.user.address, 87.88);
      opOfTx.set(tx.toLowerCase(), u.op);
      await pollCryptoDepositsOnce(async () => null);
      const bookedFirst = eureOf(u.user.id).length === 1;
      await pollCryptoDepositsOnce(async (h) => (h === u.op ? { success: true, txHash: tx } : null));
      return { ...u, tx, bookedFirst };
    };
    const lateChecks = async (label: string, u: Awaited<ReturnType<typeof lateResolve>>, reason: RegExp) => {
      const d = u.row();
      check(`${label}: the scanner booked the output while the op was unresolved`, u.bookedFirst);
      check(`${label}: exactly one EURe deposit, kept in the books`,
        eureOf(u.user.id).length === 1 && userEure(u.user.id).length === 1 && userEure(u.user.id)[0].txHash === u.tx,
        JSON.stringify(eureOf(u.user.id)));
      check(`${label}: the USDC row is refused for review, nothing credited`,
        d.holding === "refused" && !d.creditedEur && reason.test(d.reason ?? ""), `${d.holding} ${d.creditedEur} ${d.reason ?? ""}`);
      check(`${label}: its swap step names the transaction and claims none of its logs`,
        d.txs.some((t) => t.step === "safe.swap(usdc->eure)" && t.hash === u.tx && t.outputLogIndexes?.length === 0)
          && !d.txs.some((t) => t.step.endsWith(".unconfirmed")), JSON.stringify(d.txs));
      check(`${label}: not offered for conversion again`, depositConversionBlocker(store.findUser(u.user.id)!, d) !== null);
      await pollCryptoDepositsOnce(async () => null);
      check(`${label}: a later poll changes nothing`, userEure(u.user.id).length === 1 && u.row().holding === "refused" && u.row().txs.length === d.txs.length);
    };
    const lia = await lateResolve("Late Lia", { intent: true });
    await lateChecks("booked first, then resolved", lia, /already recorded as a deposit/);
    check("and it is under review", /under review/.test(depositConversionBlocker(store.findUser(lia.user.id)!, lia.row()) ?? ""));

    // A row parked before the intent was kept (#163) has no floor to settle
    // against. Its swap landed long ago and the scanner booked the output.
    const leo = await lateResolve("Legacy Leo", { intent: false });
    await lateChecks("no intent, booked first", leo, /signed quote was not kept/);
    check("and it is under review", /under review/.test(depositConversionBlocker(store.findUser(leo.user.id)!, leo.row()) ?? ""));

    // No intent, resolved before the scanner reached it: the output is the
    // swap's, named by log index, and never booked as money in.
    const lou = await parkUncertain("Legacy Lou");
    store.updateCryptoDeposit(lou.id, { conversionIntent: undefined });
    const louTx = await mintEure(lou.user.address, 87.88);
    opOfTx.set(louTx.toLowerCase(), lou.op);
    await pollCryptoDepositsOnce(async (h) => (h === lou.op ? { success: true, txHash: louTx } : null));
    const louD = lou.row();
    check("no intent, resolved first: refused for review, nothing credited",
      louD.holding === "refused" && !louD.creditedEur && /under review/.test(depositConversionBlocker(store.findUser(lou.user.id)!, louD) ?? ""),
      `${louD.holding} ${louD.reason ?? ""}`);
    check("and its step names the swap's output logs, which are not booked",
      louD.txs.some((t) => t.step === "safe.swap(usdc->eure)" && t.hash === louTx && t.outputLogIndexes?.length === 1) && eureOf(lou.user.id).length === 0,
      JSON.stringify(louD.txs));

    // Settling throws (a non-archive RPC refusing the balance at the block
    // before the swap) after the scanner booked the output: refused for
    // review, and the booked EURe stays in the books.
    const realRead = publicClient.readContract;
    const lex = await parkUncertain("Archiveless Lex");
    const lexTx = await mintEure(lex.user.address, 87.88);
    opOfTx.set(lexTx.toLowerCase(), lex.op);
    await pollCryptoDepositsOnce(async () => null);
    const lexBooked = eureOf(lex.user.id).length === 1;
    (publicClient as any).readContract = async (args: any) => {
      if (args.blockNumber !== undefined && args.functionName === "balanceOf") throw new Error("missing trie node");
      return realRead(args);
    };
    try {
      await pollCryptoDepositsOnce(async (h) => (h === lex.op ? { success: true, txHash: lexTx } : null));
    } finally {
      (publicClient as any).readContract = realRead;
    }
    await lateChecks("settling throws", { ...lex, tx: lexTx, bookedFirst: lexBooked }, /could not be recorded/);
    (publicClient as any).getTransactionReceipt = realReceipt;
  }

  console.log("15/15 a reverse-swap refund is not also booked as a deposit…");
  {
    // The real compensation path, with the venue's execute standing in for a
    // maker: an EURe Transfer from an address that is not our swapper (the
    // scanner skips that one by sender), so the output looks like any payment.
    const orch = await import("../services/api/src/orchestrator.js");
    const { FxSwapperLiquidityProvider } = await import("../services/api/src/liquidity/fx-swapper.js");
    const { buildActivity } = await import("../services/api/src/transfers/activity.js");
    const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
    const maker = `0x${"7a".repeat(20)}` as `0x${string}`;
    const payer = `0x${"7b".repeat(20)}` as `0x${string}`;
    await sendEure(maker, 1000);
    await sendEure(payer, 1000);
    for (const who of [maker, payer]) {
      await rpc("hardhat_impersonateAccount", [who]);
      await rpc("hardhat_setBalance", [who, "0xDE0B6B3A7640000"]);
    }
    const eureTransfer = (from: `0x${string}`, to: `0x${string}`, amount: number) =>
      rpc("eth_sendTransaction", [{
        from,
        to: addrs().eure,
        data: encodeFunctionData({ abi: abis.MockToken, functionName: "transfer", args: [to, eur.toWei(amount)] }),
      }]) as Promise<`0x${string}`>;
    /** What execute does on this run: the maker's delivery, plus optionally
     *  someone else's EURe to the same Safe in the same block. */
    let venue: {
      deliverEur: number; coInflowEur?: number; outflowEur?: number; deliverTo?: `0x${string}`; noSwapStep?: boolean;
      swapHash?: `0x${string}`; coHash?: `0x${string}`;
    };
    const realExecute = FxSwapperLiquidityProvider.prototype.execute;
    FxSwapperLiquidityProvider.prototype.execute = async function (quote, to) {
      const sameBlock = venue.coInflowEur || venue.outflowEur;
      if (sameBlock) await rpc("evm_setAutomine", [false]);
      venue.swapHash = await eureTransfer(maker, venue.deliverTo ?? to!, venue.deliverEur);
      if (venue.coInflowEur) venue.coHash = await eureTransfer(payer, to!, venue.coInflowEur);
      if (venue.outflowEur) venue.coHash = await eureTransfer(to!, payer, venue.outflowEur);
      if (sameBlock) {
        await rpc("evm_mine", []);
        await rpc("evm_setAutomine", [true]);
      }
      await publicClient.waitForTransactionReceipt({ hash: venue.swapHash });
      if (venue.coHash) await publicClient.waitForTransactionReceipt({ hash: venue.coHash });
      return {
        quote,
        amountOut: eur.toWei(venue.deliverEur),
        txs: venue.noSwapStep ? [] : [{ step: "liquidity.fx-swapper.usdc-eure", hash: venue.swapHash }],
      };
    };

    /** A cash transfer the user's Safe funded: debited, swapped to USDC, then failed. */
    const failedTransfer = (user: any) => {
      const now = new Date().toISOString();
      const id = randomUUID();
      store.addTransfer({
        id, userId: user.id, quoteId: randomUUID(), rail: "cash", recipientName: "R", recipientPhone: "+254700000000",
        state: "FAILED", error: "forced failure", sendEur: 30, receiveKes: 1000, fundingSource: "safe", usdcOut: 30,
        txs: [{ step: orch.DEBIT_STEP.safe, hash: `0x${"11".repeat(32)}` }, { step: "liquidity.fx-swapper.eure-usdc", hash: `0x${"22".repeat(32)}` }],
        createdAt: now, updatedAt: now,
      } as any);
      return id;
    };
    const eureIn = (user: any) => store.cryptoDeposits.filter((x) => x.userId === user.id && x.token === "EURE");
    const activityFunding = (user: any) =>
      buildActivity({
        transfers: store.transfers.filter((t) => t.userId === user.id),
        deposits: store.cryptoDeposits.filter((x) => x.userId === user.id),
        issues: [],
      }).filter((r: any) => r.kind === "funding" && r.token === "EURE");
    const bookIn = (user: any) =>
      projectStatementLines({
        orgId: "o", accountId: "a", userId: user.id, safeAddress: user.address, timeZone: "UTC",
        transfers: store.transfers.filter((t) => t.userId === user.id),
        deposits: store.cryptoDeposits.filter((x) => x.userId === user.id),
        issueOrders: [], sweeps: [], invoices: [], paymentRequests: [], swapsHaveExecuted: false,
      }).filter((l) => l.statement?.event === "eure_in");

    try {
      // Delivers the whole send back, so no fee leg runs: the refund is the swap's output alone.
      const rae = addUser("Refunded Rae", { withSafe: true });
      await pollCryptoDepositsOnce();
      venue = { deliverEur: 30 };
      const done = await orch.compensateTransfer(failedTransfer(rae));
      check("the reverse swap refunds", done.state === "REFUNDED", `${done.state} ${done.error ?? ""}`);
      check("by exactly what its Transfer log delivered", done.refund?.amountEur === 30, `${done.refund?.amountEur}`);
      const swapStep = done.txs.find((x) => x.hash === venue.swapHash) as any;
      check("and the swap step names the log it delivered", Array.isArray(swapStep?.outputLogIndexes) && swapStep.outputLogIndexes.length === 1, JSON.stringify(swapStep));
      await pollCryptoDepositsOnce();
      check("the scanner does not book the refund as money in", eureIn(rae).length === 0, JSON.stringify(eureIn(rae).map((x) => x.amountEur)));
      check("activity shows no EURe deposit for it", activityFunding(rae).length === 0);
      check("and the books have no money-in line for it", bookIn(rae).length === 0);

      // Someone else's EURe lands in the same block: it is money in, and not refund.
      const cas = addUser("Co-inflow Cas", { withSafe: true });
      await pollCryptoDepositsOnce();
      venue = { deliverEur: 30, coInflowEur: 12.5 };
      const co = await orch.compensateTransfer(failedTransfer(cas));
      check("with a co-inflow in the same block the reverse swap still refunds", co.state === "REFUNDED", `${co.state} ${co.error ?? ""}`);
      check("the refund is the swap's output, not the balance delta", co.refund?.amountEur === 30, `${co.refund?.amountEur}`);
      await pollCryptoDepositsOnce();
      const casIn = eureIn(cas);
      check("the co-inflow is booked as a deposit, alone", casIn.length === 1 && casIn[0].txHash === venue.coHash && casIn[0].amountEur === 12.5, JSON.stringify(casIn.map((x) => [x.txHash, x.amountEur])));
      check("activity shows the co-inflow once", activityFunding(cas).length === 1);
      check("and the books carry it as the one money-in line", bookIn(cas).length === 1 && bookIn(cas)[0].statement!.amountCents === 1250);

      // The venue reported no swap transaction: there is no receipt to measure,
      // so nothing is guessed from the balance.
      const noa = addUser("Unmeasured Noa", { withSafe: true });
      await pollCryptoDepositsOnce();
      venue = { deliverEur: 30, noSwapStep: true };
      const blind = await orch.compensateTransfer(failedTransfer(noa));
      check("no swap receipt to read leaves the refund for review", blind.state === "MANUAL_REVIEW" && !blind.refund && /receipt/.test(blind.error ?? ""), `${blind.state} ${blind.error ?? ""}`);

      // The swap's logs deliver nothing to the Safe (the venue paid elsewhere):
      // whatever the Safe's balance did, nothing is refunded.
      const ira = addUser("Misdelivered Ira", { withSafe: true });
      await pollCryptoDepositsOnce();
      venue = { deliverEur: 30, deliverTo: payer, coInflowEur: 30 };
      const elsewhere = await orch.compensateTransfer(failedTransfer(ira));
      check("a swap that delivered no EURe to the Safe is left for review, even with EURe arriving", elsewhere.state === "MANUAL_REVIEW" && !elsewhere.refund && /no EURe/.test(elsewhere.error ?? ""), `${elsewhere.state} ${elsewhere.error ?? ""}`);

      // EURe leaves the Safe in the swap's block: the delta is under the logs.
      const ola = addUser("Spending Ola", { withSafe: true });
      await sendEure(ola.address, 20);
      await rpc("hardhat_impersonateAccount", [ola.address]);
      await rpc("hardhat_setBalance", [ola.address, "0xDE0B6B3A7640000"]);
      await pollCryptoDepositsOnce();
      venue = { deliverEur: 30, outflowEur: 15 };
      const short = await orch.compensateTransfer(failedTransfer(ola));
      check("a balance delta under the logged output is left for review", short.state === "MANUAL_REVIEW" && !short.refund && /balance shows only/.test(short.error ?? ""), `${short.state} ${short.error ?? ""}`);
      await pollCryptoDepositsOnce();
      check("and its output is still the refund's, not money in", !eureIn(ola).some((x) => x.txHash === venue.swapHash), JSON.stringify(eureIn(ola).map((x) => x.amountEur)));
    } finally {
      FxSwapperLiquidityProvider.prototype.execute = realExecute;
    }

    // The marker itself, for a scan that lands between the swap and its measurement.
    const { conversionOutputs } = await import("../services/api/src/transfers/conversion-outputs.js");
    const tx = `0x${"ab".repeat(32)}`;
    const reverse = (outputLogIndexes?: number[]) =>
      ({ userId: "u-r", txs: [{ step: "liquidity.dex.usdc-eure", hash: tx, ...(outputLogIndexes ? { outputLogIndexes } : {}) }] }) as any;
    const measured = conversionOutputs([], [reverse([3])]);
    check("a measured reverse swap marks only its own logs", measured(tx, 3, "u-r") && !measured(tx, 4, "u-r"));
    const unmeasured = conversionOutputs([], [reverse()]);
    check("an unmeasured one covers its transaction for that user only", unmeasured(tx, 9, "u-r") && !unmeasured(tx, 9, "u-other"));
    const forward = conversionOutputs([], [{ userId: "u-r", txs: [{ step: "liquidity.dex.eure-usdc", hash: tx }] } as any]);
    check("a forward swap marks nothing", !forward(tx, 0, "u-r"));
  }

  console.log(`\ncrypto deposits: ${passed}/${passed} checks passed`);
} finally {
  for (const c of children) c.kill();
}
