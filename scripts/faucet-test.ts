/**
 * Testnet faucet test — local hardhat chain, no network.
 *
 * Proves the money-safety properties, not just the happy path:
 *  - a deployed Safe gets exactly the configured grant from the FAUCET wallet
 *    (not the deployer), recorded with its tx hash;
 *  - a second call for the same account pays NOTHING (the synchronous claim);
 *  - a dry faucet answers FAUCET_DRY with the claim released, and a later
 *    top-up can fund the same account after all;
 *  - an account without a deployed Safe, an unknown user and a zero address
 *    are refused.
 *
 * What it cannot prove in-process: the real-money-chain refusal. CHAIN_ID is
 * frozen at first import, so it is checked in a child process started on
 * chain 8453, which must refuse to load the config at all.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FAUCET_TEST_RPC_PORT ?? 8554);
const RPC = `http://127.0.0.1:${PORT}`;
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
  console.log("1/6 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", String(PORT)]);
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });

  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, publicClient, writeAndWait, deployerWallet, faucetWallet } = await import("../services/api/src/chain.js");
  const { faucetEnabled, faucetFundSafe } = await import("../services/api/src/faucet.js");
  const { capabilities } = await import("../services/api/src/capabilities.js");
  initStore();
  assert.ok(faucetWallet, "faucet wallet missing");
  const faucetAddress = faucetWallet.account.address;

  const balanceOf = async (who: `0x${string}`) =>
    eur.fromWei((await publicClient.readContract({ address: addrs().eure, abi: abis.MockToken, functionName: "balanceOf", args: [who] })) as bigint);
  const mintToFaucet = (amount: number) =>
    writeAndWait(deployerWallet, { address: addrs().eure, abi: abis.MockToken, functionName: "mint", args: [faucetAddress, eur.toWei(amount)] });

  function addUser(name: string, opts: { address?: `0x${string}`; deployed?: boolean } = {}) {
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address: opts.address ?? (`0x${randomBytes(20).toString("hex")}` as `0x${string}`),
      iban: "",
      kycStatus: "pending",
      createdAt: new Date().toISOString(),
      ...(opts.deployed === false ? {} : { wallet: { type: "candide-safe", deployed: true } }),
    } as any;
    store.addUser(user);
    return user;
  }

  console.log("2/6 a deployed Safe gets exactly the grant, from the faucet wallet…");
  check("faucet is enabled on a local chain with a key and a grant", faucetEnabled());
  check("/api/health advertises the grant", capabilities().faucetEur === 50);
  check("the faucet wallet is not the deployer", faucetAddress.toLowerCase() !== deployerWallet.account.address.toLowerCase());
  await mintToFaucet(60);
  const deployerBefore = await balanceOf(deployerWallet.account.address);
  const alice = addUser("Faucet Alice");
  const a1 = await faucetFundSafe(alice.id);
  check("50 EURe arrived at the Safe", a1.ok && (await balanceOf(alice.address)) === 50);
  check("it came out of the faucet wallet", (await balanceOf(faucetAddress)) === 10 && (await balanceOf(deployerWallet.account.address)) === deployerBefore);
  const rec = store.findUser(alice.id)?.faucet;
  check("the grant is recorded with its tx hash", rec?.grantedEur === 50 && /^0x[0-9a-f]{64}$/i.test(rec?.txHash ?? ""));

  console.log("3/6 a second call pays nothing, a parallel pair pays once…");
  const a2 = await faucetFundSafe(alice.id);
  check("a repeat call is ALREADY_GRANTED", !a2.ok && a2.code === "ALREADY_GRANTED");
  check("the balance is unchanged after a repeat call", (await balanceOf(alice.address)) === 50);
  await mintToFaucet(200);
  const carol = addUser("Faucet Carol");
  const pair = await Promise.all([faucetFundSafe(carol.id), faucetFundSafe(carol.id)]);
  check("two parallel claims pay exactly once", pair.filter((r) => r.ok).length === 1 && (await balanceOf(carol.address)) === 50);

  console.log("4/6 a dry faucet refuses, and a top-up can retry…");
  // 210 - 50 (Carol) = 160 left; drain to below one grant.
  const dave = addUser("Faucet Dave"), erin = addUser("Faucet Erin"), finn = addUser("Faucet Finn");
  for (const u of [dave, erin, finn]) await faucetFundSafe(u.id);
  const bob = addUser("Faucet Bob");
  const b1 = await faucetFundSafe(bob.id);
  check("a dry faucet answers FAUCET_DRY and sends nothing", !b1.ok && b1.code === "FAUCET_DRY" && (await balanceOf(bob.address)) === 0);
  check("the claim was released so a retry stays possible", store.findUser(bob.id)?.faucet === undefined);
  await mintToFaucet(100);
  const b2 = await faucetFundSafe(bob.id);
  check("after a top-up the same account is funded", b2.ok && (await balanceOf(bob.address)) === 50);

  console.log("5/6 accounts without a Safe are refused…");
  const noSafe = addUser("No-Safe Nia", { deployed: false });
  const n = await faucetFundSafe(noSafe.id);
  check("an undeployed Safe answers NO_SAFE", !n.ok && n.code === "NO_SAFE" && store.findUser(noSafe.id)?.faucet === undefined);
  const u = await faucetFundSafe("no-such-user");
  check("an unknown user answers NO_SAFE", !u.ok && u.code === "NO_SAFE");
  const zero = addUser("Zero Zoe", { address: "0x0000000000000000000000000000000000000000" });
  const z = await faucetFundSafe(zero.id);
  check("a zero address is never funded", !z.ok && store.findUser(zero.id)?.faucet === undefined);

  console.log("6/6 a real-money chain refuses to start with a faucet key…");
  const real = spawnSync(process.execPath, [bin("tsx"), "-e", 'import("./services/api/src/config.ts").catch((e) => { console.error(e.message); process.exit(1); })'], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TRANSF_CHAIN_ID: "8453", LOCAL_HARNESS: "", TRANSF_DB_PATH: path.join(ROOT, "data/never-written.json") },
  });
  check("chain 8453 with FAUCET_KEY set fails at config load", real.status !== 0 && /testnet-only/.test(real.stderr), real.stderr.slice(-300));

  console.log(`\nFAUCET TEST PASSED — ${passed} checks: one grant per Safe from the faucet wallet, dry faucet refuses, real-money chain refuses`);
} finally {
  for (const c of children) c.kill();
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
}
