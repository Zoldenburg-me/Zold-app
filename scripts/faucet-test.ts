/**
 * Testnet faucet test — local hardhat chain, no network.
 *
 * Proves the money-safety properties, not just the happy path:
 *  - a new Safe gets exactly the configured grant, recorded with its tx hash;
 *  - a second call for the same account pays NOTHING (the synchronous claim);
 *  - a dry deployer skips with the claim released, and a later top-up can fund
 *    the same account after all;
 *  - an unknown user and a zero address are ignored.
 *
 * What it cannot prove in-process: the production-chain refusal. CHAIN_ID is
 * frozen at first import, so exercising REAL_MONEY_CHAINS needs a separate
 * process on a different chain id — noted rather than faked.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8554";
process.env.TRANSF_RPC_URL = RPC;
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.TESTNET_FAUCET_EUR = "50";

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
  console.log("1/5 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8554"]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, publicClient, writeAndWait, deployerWallet } = await import(
    "../services/api/src/chain.js"
  );
  const { faucetEnabled, faucetFundSafe } = await import("../services/api/src/faucet.js");
  initStore();

  const balanceOf = async (who: `0x${string}`) =>
    eur.fromWei(
      (await publicClient.readContract({
        address: addrs().eure,
        abi: abis.MockToken,
        functionName: "balanceOf",
        args: [who],
      })) as bigint,
    );

  function addUser(name: string, address?: `0x${string}`) {
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address: address ?? (`0x${randomBytes(20).toString("hex")}` as `0x${string}`),
      iban: "",
      kycStatus: "approved",
      createdAt: new Date().toISOString(),
    } as any;
    store.addUser(user);
    return user;
  }

  console.log("2/5 a new Safe gets exactly the grant, recorded…");
  check("faucet is enabled with TESTNET_FAUCET_EUR set on a local chain", faucetEnabled());
  // Give the deployer EURe to grant from — locally MockToken's owner mints;
  // on a testnet the operator funds the address instead.
  await writeAndWait(deployerWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [deployerWallet.account.address, eur.toWei(60)],
  });
  const alice = addUser("Faucet Alice");
  await faucetFundSafe(alice.id);
  check("50 EURe arrived at the new Safe", (await balanceOf(alice.address)) === 50);
  const rec = store.findUser(alice.id)?.faucet;
  check("the grant is recorded with its tx hash", rec?.grantedEur === 50 && /^0x[0-9a-f]{64}$/i.test(rec?.txHash ?? ""));

  console.log("3/5 a second call pays nothing…");
  await faucetFundSafe(alice.id);
  check("the balance is unchanged after a repeat call", (await balanceOf(alice.address)) === 50);

  console.log("4/5 a dry deployer skips, and a top-up can retry…");
  const bob = addUser("Faucet Bob");
  // 10 EURe left after Alice's grant — below the 50 grant.
  await faucetFundSafe(bob.id);
  check("nothing was sent from a dry deployer", (await balanceOf(bob.address)) === 0);
  check("the claim was released so a retry stays possible", store.findUser(bob.id)?.faucet === undefined);
  await writeAndWait(deployerWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [deployerWallet.account.address, eur.toWei(100)],
  });
  await faucetFundSafe(bob.id);
  check("after a top-up the same account is funded", (await balanceOf(bob.address)) === 50);

  console.log("5/5 junk inputs are ignored…");
  await faucetFundSafe("no-such-user");
  const zero = addUser("Zero Zoe", "0x0000000000000000000000000000000000000000");
  await faucetFundSafe(zero.id);
  check("a zero address is never funded", store.findUser(zero.id)?.faucet === undefined);

  console.log(`\nFAUCET TEST PASSED — ${passed}/8: one grant per Safe, dry deployer skips, junk ignored`);
} finally {
  for (const c of children) c.kill();
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
}
