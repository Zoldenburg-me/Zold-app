/**
 * Crypto in — USDC arriving at a payment page settles into the user's Safe.
 *
 * Detection runs against a real chain: USDC really moves on-chain to a watched
 * address, and the poller reads the Transfer log it emits. Conversion is real
 * too — the swap settles EURe into the Safe.
 *
 * The middle step is what cannot run here. The swap is now a user-signed batch
 * out of the user's own Safe, which needs Candide's bundler and paymaster, and
 * no hardhat node has either. So these seed the INPUT — USDC arrived, the row
 * is DETECTED — drive the poller for real, and then exercise
 * settleConvertedDeposit directly with EURe minted into the Safe to stand in
 * for the batch having landed.
 *
 * A TRAP THIS TEST FELL INTO, worth not repeating: it used to seed a deposit
 * already carrying SWEEP_STEP with the tokens at the orchestrator — the OUTPUT
 * of the step under test. That made sweepToOrchestrator take its "already
 * swept" early return, so it never reached the `throw` sitting at the end of
 * it since FP4 removed API-held owner keys. The suite stayed green for months
 * while auto-convert was dead code in production. Seed the input, never the
 * output.
 *
 * Run: npm run crypto:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8552";
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
const children: ChildProcess[] = [];
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
  console.log("1/9 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8552"]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, usd, orchestratorAddress, publicClient, writeAndWait, deployerWallet } =
    await import("../services/api/src/chain.js");
  const { convertDeposit, pollCryptoDepositsOnce, settleConvertedDeposit } = await import(
    "../services/api/src/adapters/crypto-deposits.js"
  );
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
        depositAddress: owner,
        recipientAddress: owner,
        forwarder: {
          provider: "local-safe",
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
    writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, eur.toWei(amount)],
    });

  const sendUsdc = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet, {
      address: addrs().usdc,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, usd.toUnits(amount)],
    });
  const sendEure = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, eur.toWei(amount)],
    });

  /** The state a completed sweep leaves: tokens with the orchestrator, the
   *  step on the deposit's own record. */
  /**
   * Seed a deposit in the state the POLLER would leave it: USDC has arrived at
   * the user's own address and the row is DETECTED. Deliberately no sweep row
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
      settlementAsset: user.paymentPage.settlementAsset,
      paymentAddress: user.paymentPage.depositAddress,
      state: "DETECTED",
      txs: [],
      detectedAt: now,
      updatedAt: now,
    });
  }

  console.log("2/9 nobody opted in — the chain is not even read…");
  {
    const before = store.cryptoDepositCursor(cursorKey);
    const n = await pollCryptoDepositsOnce();
    check("no watched users means no work", n === 0);
    check("and no cursor is written", store.cryptoDepositCursor(cursorKey) === before);
  }

  console.log("3/9 a real inbound transfer is detected and attributed…");
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
    // No Safe is deployed locally, so this is the honest refusal — the money
    // is still the user's, at the destination address.
    check("an undeployed Safe is refused, not converted", d.state === "REFUSED", d.state);
    // The wording moved deliberately: the refusal now comes from
    // safeDebitBlocker, the SAME check the send path uses, so a deposit can
    // never be judged convertible by a rule the send path disagrees with. It
    // used to be a second, hand-written "Safe is not deployed" string that
    // could drift. What must survive is the intent — say it is a Safe problem,
    // and reassure that the money has not gone anywhere.
    check(
      "and the reason says the money is still theirs",
      /Safe/.test(d.reason ?? "") && /still yours/.test(d.reason ?? ""),
      d.reason ?? "",
    );
    check("nothing was settled", (await safeBalanceOf(ann.address)) === 0);
  }

  console.log("4/9 a ready deposit parks for a signature, then settles what ARRIVED…");
  const bo = addUser("Crypto Bo", { withSafe: true });
  {
    /**
     * THIS STEP USED TO TEST A PATH THAT COULD NOT RUN.
     *
     * It called convertDeposit on a deposit seeded with a fake SWEEP_STEP row,
     * which made sweepToOrchestrator take its "already swept" early return and
     * never reach the `throw` that had sat at the end of it since FP4 removed
     * API-held owner keys. So the test manufactured the output of the one
     * broken step and stayed green for months while auto-convert was dead
     * code in production. Worth remembering when seeding intermediate state:
     * seed the INPUT, never the output of the thing under test.
     *
     * The swap is now a user-signed batch out of the user's own Safe, so the
     * poller can only park the deposit — and the crediting logic it used to
     * carry lives in settleConvertedDeposit, which is exercised directly here.
     */
    const parked = await convertDeposit(await seedReadyDeposit(bo, 100));
    check("the poller parks it rather than claiming to convert", parked.state === "DETECTED", parked.state);
    check(
      "and says a passkey signature is what is missing",
      /passkey/i.test(parked.reason ?? ""),
      parked.reason ?? "",
    );
    check("nothing is credited before the signature", !parked.creditedEur);

    // Simulate the signed batch having landed: EURe arrives in the user's own
    // Safe. settleConvertedDeposit credits the MEASURED delta, not the quote.
    const before = eur.toWei(await safeBalanceOf(bo.address));
    await mintEure(bo.address, 87.88);
    const d = await settleConvertedDeposit(
      parked, store.findUser(bo.id)!,
      { provider: "fx-swapper", rate: BigInt(Math.round(MID * 1e6)), minOut: eur.toWei(80) },
      before, [...parked.txs, { step: "safe.swap(usdc->eure)", hash: `0x${"22".repeat(32)}` }],
    );
    check("it settles once the swap has landed", d.state === "CONVERTED", `${d.state} (${d.reason ?? ""})`);
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

  console.log("5/9 the same deposit is never credited twice…");
  {
    const d = store.cryptoDeposits.find((x) => x.userId === bo.id && x.state === "CONVERTED")!;
    const balBefore = await safeBalanceOf(bo.address);
    const again = await convertDeposit(d);
    check("converting an already-converted deposit is a no-op", again.state === "CONVERTED");
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

  console.log("6/9 dust is left alone, direct Safe funding is only recorded…");
  {
    const dusty = addUser("Dusty", { withSafe: true });
    const d = await convertDeposit(await seedReadyDeposit(dusty, 0.25));
    check("a sub-floor deposit is refused", d.state === "REFUSED", d.state);
    check("and says why in words", /floor/.test(d.reason ?? ""), d.reason ?? "");
    check("nothing was credited for it", !d.creditedEur);

    const optedOut = addUser("Holds USDC", { autoConvert: false });
    await sendUsdc(optedOut.paymentPage.depositAddress, 50);
    await pollCryptoDepositsOnce();
    const direct = store.cryptoDeposits.find((x) => x.userId === optedOut.id);
    check(
      "an opted-out account records direct USDC without converting it",
      direct?.state === "CONVERTED" && direct.creditedUsdc === 50 && direct.settlementAsset === "USDC",
      JSON.stringify(direct),
    );
    check("and keeps a zero EUR balance", (await safeBalanceOf(optedOut.address)) === 0);
  }

  console.log("7/9 a venue price off the market is refused…");
  {
    const cass = addUser("Cass", { withSafe: true });
    const parked = await convertDeposit(await seedReadyDeposit(cass, 100));
    const before = eur.toWei(await safeBalanceOf(cass.address));
    await mintEure(cass.address, 87.88);
    // The rate the batch filled at is 1.1379; tell the feed the market is 1.40.
    pinMid(1.4);
    let refused = false;
    let reason = "";
    try {
      await settleConvertedDeposit(
        parked, store.findUser(cass.id)!,
        { provider: "fx-swapper", rate: BigInt(Math.round(MID * 1e6)), minOut: eur.toWei(80) },
        before, parked.txs,
      );
    } catch (err: any) {
      refused = true;
      reason = String(err?.message ?? err);
    }
    pinMid(MID);
    check("a rate far off the mid is refused", refused, reason || "it settled anyway");
    check("and the reason names the drift", /bps from the live mid/.test(reason), reason);
  }

  console.log("8/9 a USDC-settled page does not turn the payment into euros…");
  {
    const dana = addUser("Crypto Dana", { settlementAsset: "USDC" });
    const seeded = await seedReadyDeposit(dana, 25);
    const d = await convertDeposit(seeded);
    check("it records the USDC settlement target", d.state === "CONVERTED" && d.settlementAsset === "USDC", d.state);
    check("it does not credit euro balance", (await safeBalanceOf(dana.address)) === 0);
    check("the USDC amount is recorded", d.creditedUsdc === 25, `${d.creditedUsdc}`);
  }

  console.log("9/9 a direct EURe transfer to the Safe appears as funding activity…");
  {
    const eva = addUser("Crypto Eva", { autoConvert: false });
    await sendEure(eva.address, 30);
    await pollCryptoDepositsOnce();
    const d = store.cryptoDeposits.find((x) => x.userId === eva.id);
    check(
      "30 EURe was recorded from the chain log",
      d?.token === "EURE" && d.amountEur === 30 && d.creditedEur === 30 && d.state === "CONVERTED",
      JSON.stringify(d),
    );
  }

  console.log(`\ncrypto deposits: ${passed}/${passed} checks passed`);
} finally {
  for (const c of children) c.kill();
}
