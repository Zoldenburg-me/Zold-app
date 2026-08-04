/**
 * Crypto in — USDC arriving at a payment page settles into the user's Safe.
 *
 * Detection runs against a real chain: USDC really moves on-chain to a watched
 * address, and the poller reads the Transfer log it emits. Conversion is real
 * too — the swap settles EURe into the Safe.
 *
 * The middle step is what cannot run here. Moving tokens out of a user's Safe
 * needs Candide's bundler and paymaster, and no hardhat node has either; a
 * local account address is a counterfactual Safe with no code at all. So the
 * conversion cases seed the state a completed sweep leaves behind — the
 * deposit carrying SWEEP_STEP, the tokens with the orchestrator — and the
 * un-swept case is exercised for real, because refusing an undeployed Safe is
 * exactly what should happen.
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
  console.log("1/8 chain + deploy…");
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
  const { convertDeposit, pollCryptoDepositsOnce, SWEEP_STEP } = await import(
    "../services/api/src/adapters/crypto-deposits.js"
  );
  const { smartAccountFor } = await import("../services/api/src/wallet/candide.js");
  initStore();

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
    opts: { autoConvert?: boolean; kyc?: string; settlementAsset?: "EURE" | "USDC" } = {},
  ) {
    const key = generatePrivateKey();
    const pageKey = generatePrivateKey();
    const pageOwner = privateKeyToAccount(pageKey).address;
    const now = new Date().toISOString();
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address: privateKeyToAccount(key).address,
      ownerAddress: privateKeyToAccount(key).address,
      privateKey: key,
      iban: "",
      kycStatus: opts.kyc ?? "approved",
      paymentPage: {
        handle: name.toLowerCase().replace(/\s+/g, "-"),
        depositAddress: smartAccountFor(pageOwner).accountAddress,
        depositPrivateKey: pageKey,
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

  const sendUsdc = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet, {
      address: addrs().usdc,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, usd.toUnits(amount)],
    });

  /** The state a completed sweep leaves: tokens with the orchestrator, the
   *  step on the deposit's own record. */
  async function seedSweptDeposit(user: any, amountUsdc: number) {
    await sendUsdc(orchestratorAddress, amountUsdc);
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
      txs: [{ step: SWEEP_STEP, hash: `0x${"11".repeat(32)}` }],
      detectedAt: now,
      updatedAt: now,
    });
  }

  console.log("2/8 nobody opted in — the chain is not even read…");
  {
    const before = store.cryptoDepositCursor(31337);
    const n = await pollCryptoDepositsOnce();
    check("no watched users means no work", n === 0);
    check("and no cursor is written", store.cryptoDepositCursor(31337) === before);
  }

  console.log("3/8 a real inbound transfer is detected and attributed…");
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
    // No page Safe is deployed locally, so this is the honest refusal — the
    // money is still the user's, at the page address.
    check("an undeployed Safe is refused, not converted", d.state === "REFUSED", d.state);
    check(
      "and the reason says the money is still theirs",
      /no deployed Safe/.test(d.reason ?? "") && /still yours/.test(d.reason ?? ""),
      d.reason ?? "",
    );
    check("nothing was settled", (await safeBalanceOf(ann.address)) === 0);
  }

  console.log("4/8 a swept deposit converts and becomes spendable EUR…");
  const bo = addUser("Crypto Bo");
  {
    const seeded = await seedSweptDeposit(bo, 100);
    const d = await convertDeposit(seeded);
    check("it converted", d.state === "CONVERTED", `${d.state} (${d.reason ?? ""})`);
    // 100 USDC at 1.1379 EUR/USD is ~87.88 EURe.
    check(
      "the credit is the euro value, not the dollar number",
      d.creditedEur! > 87 && d.creditedEur! < 89,
      `€${d.creditedEur}`,
    );
    check(
      "the venue and rate are recorded for the receipt",
      d.provider === "fx-swapper" && Math.abs(d.rate! - MID) < 0.01,
      `${d.provider} @ ${d.rate}`,
    );
    check(
      "the swap and the credit are both on the record",
      d.txs.some((x) => x.step.includes("usdc-eure")) &&
        !d.txs.some((x) => x.step.includes("vault")),
      d.txs.map((x) => x.step).join(","),
    );
    const bal = await safeBalanceOf(bo.address);
    check("the balance is spendable in the Safe", Math.abs(bal - d.creditedEur!) < 0.001, `€${bal}`);
  }

  console.log("5/8 the same deposit is never credited twice…");
  {
    const d = store.cryptoDeposits.find((x) => x.userId === bo.id)!;
    const balBefore = await safeBalanceOf(bo.address);
    const again = await convertDeposit(d);
    check("converting an already-converted deposit is a no-op", again.state === "CONVERTED");
    check("the balance did not move", (await safeBalanceOf(bo.address)) === balBefore, `€${balBefore}`);

    // Rewind the cursor so the poller re-reads Ann's original log.
    const countBefore = store.cryptoDeposits.length;
    store.setCryptoDepositCursor(31337, 0n);
    const n = await pollCryptoDepositsOnce();
    check("re-reading the same log records nothing new", n === 0, `got ${n}`);
    check("and no duplicate row appears", store.cryptoDeposits.length === countBefore);
  }

  console.log("6/8 dust is left alone, opt-outs are not watched…");
  {
    const dusty = addUser("Dusty");
    const d = await convertDeposit(await seedSweptDeposit(dusty, 0.25));
    check("a sub-floor deposit is refused", d.state === "REFUSED", d.state);
    check("and says why in words", /floor/.test(d.reason ?? ""), d.reason ?? "");
    check("nothing was credited for it", !d.creditedEur);

    const optedOut = addUser("Holds USDC", { autoConvert: false });
    await sendUsdc(optedOut.paymentPage.depositAddress, 50);
    await pollCryptoDepositsOnce();
    check(
      "an opted-out account is not watched at all",
      !store.cryptoDeposits.some((x) => x.userId === optedOut.id),
    );
    check("and keeps a zero EUR balance", (await safeBalanceOf(optedOut.address)) === 0);
  }

  console.log("7/8 a venue price off the market is refused…");
  {
    const cass = addUser("Cass");
    const seeded = await seedSweptDeposit(cass, 100);
    // The swapper still posts 1.1379; tell the rate feed the market is at 1.40.
    pinMid(1.4);
    const d = await convertDeposit(seeded);
    pinMid(MID);
    check("a rate far off the mid is refused", d.state === "REFUSED", d.state);
    check(
      "and the reason names the drift",
      /bps from the live mid/.test(d.reason ?? ""),
      d.reason ?? "",
    );
    check("no euros were settled at the bad price", (await safeBalanceOf(cass.address)) === 0);
  }

  console.log("8/8 a USDC-settled page does not turn the payment into euros…");
  {
    const dana = addUser("Crypto Dana", { settlementAsset: "USDC" });
    const seeded = await seedSweptDeposit(dana, 25);
    const d = await convertDeposit(seeded);
    check("it records the USDC settlement target", d.state === "CONVERTED" && d.settlementAsset === "USDC", d.state);
    check("it does not credit euro balance", (await safeBalanceOf(dana.address)) === 0);
    check("the USDC amount is recorded", d.creditedUsdc === 25, `${d.creditedUsdc}`);
  }

  console.log(`\ncrypto deposits: ${passed}/${passed} checks passed`);
} finally {
  for (const c of children) c.kill();
}
