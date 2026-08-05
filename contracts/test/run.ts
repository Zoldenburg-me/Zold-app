/**
 * Contract tests for the remaining on-chain contracts after RemitVault removal.
 * Run: npm run test:contracts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RPC = "http://127.0.0.1:8546";

const pk = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  guardian: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
const wallets = {
  deployer: createWalletClient({ account: privateKeyToAccount(pk.deployer), chain: hardhat, transport: http(RPC) }),
  relayer: createWalletClient({ account: privateKeyToAccount(pk.relayer), chain: hardhat, transport: http(RPC) }),
  guardian: createWalletClient({ account: privateKeyToAccount(pk.guardian), chain: hardhat, transport: http(RPC) }),
};
const relayerAddr = wallets.relayer.account.address;
const guardianAddr = wallets.guardian.account.address;

const E = (v: string) => parseUnits(v, 18);
const U = (v: string) => parseUnits(v, 6);

function artifact(name: string) {
  const p = path.join(ROOT, "contracts/artifacts/contracts/src", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function deploy(name: string, args: any[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallets.deployer.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress!, abi };
}

type Deployed = Awaited<ReturnType<typeof deploy>>;

async function write(w: keyof typeof wallets, c: Deployed, functionName: string, args: any[]) {
  const { request } = await pub.simulateContract({
    account: wallets[w].account,
    address: c.address,
    abi: c.abi,
    functionName,
    args,
  });
  const hash = await wallets[w].writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
}

async function read(c: Deployed, functionName: string, args: any[] = []) {
  return pub.readContract({ address: c.address, abi: c.abi, functionName, args });
}

async function expectRevert(p: Promise<unknown>, contains: string, label: string) {
  await assert.rejects(p, (e: any) => {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    assert.ok(msg.includes(contains), `${label}: expected ${contains}, got ${msg}`);
    return true;
  });
}

async function waitForRpc(timeout = 30_000) {
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("hardhat node did not start");
}

async function mineAfter(seconds: number) {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [seconds] }),
  });
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
  });
}

async function main() {
  let pass = 0;
  async function t(name: string, fn: () => Promise<void>) {
    await fn();
    pass++;
    console.log(`  ok ${name}`);
  }

  const eure = await deploy("MockToken", ["Monerium EUR emoney (mock)", "EURe", 18]);
  const usdc = await deploy("MockToken", ["USD Coin (mock)", "USDC", 6]);
  const swapper = await deploy("FxSwapper", [eure.address, usdc.address, 1_080_000n]);
  const bridge = await deploy("BridgeEscrow", [usdc.address]);
  const timelock = await deploy("AdminTimelock", [[wallets.deployer.account.address, relayerAddr, guardianAddr], 2, 1n]);

  await write("deployer", swapper, "setTrader", [relayerAddr, true]);
  await write("deployer", bridge, "setOrchestrator", [relayerAddr, true]);
  await write("deployer", eure, "mint", [relayerAddr, E("1000")]);
  await write("deployer", usdc, "mint", [swapper.address, U("1000")]);
  await write("deployer", eure, "mint", [swapper.address, E("1000")]);

  console.log("FxSwapper:");
  await t("relayer can swap EURe to USDC", async () => {
    await write("relayer", eure, "approve", [swapper.address, E("10")]);
    await write("relayer", swapper, "swapExactIn", [E("10"), U("10"), relayerAddr]);
    assert.equal(await read(usdc, "balanceOf", [relayerAddr]), U("10.8"));
  });

  await t("relayer can reverse swap USDC to EURe", async () => {
    await write("relayer", usdc, "approve", [swapper.address, U("10.8")]);
    await write("relayer", swapper, "swapReverseExactIn", [U("10.8"), E("9.9"), relayerAddr]);
    const balance = (await read(eure, "balanceOf", [relayerAddr])) as bigint;
    assert.ok(balance >= E("999.9"));
  });

  await t("non-trader cannot swap inventory", () =>
    expectRevert(
      write("guardian", swapper, "swapExactIn", [E("1"), U("1"), guardianAddr]),
      "not trader",
      "public swapper access",
    ),
  );

  await t("pause blocks swaps", async () => {
    await write("deployer", swapper, "setPaused", [true]);
    await expectRevert(
      write("relayer", swapper, "swapExactIn", [E("1"), U("1"), relayerAddr]),
      "paused",
      "swap while paused",
    );
    await write("deployer", swapper, "setPaused", [false]);
  });

  console.log("BridgeEscrow:");
  await t("lock pulls USDC and records amount", async () => {
    const tid = keccak256(toHex("t1"));
    await write("deployer", usdc, "mint", [relayerAddr, U("5")]);
    await write("relayer", usdc, "approve", [bridge.address, U("5")]);
    await write("relayer", bridge, "lockForPayout", [tid, U("5"), "stellar", "mgi:+254700"]);
    assert.equal(await read(bridge, "lockedAmount", [tid]), U("5"));
    assert.equal(await read(bridge, "totalLocked"), U("5"));
  });

  await t("non-relayer cannot lock", () =>
    expectRevert(
      write("guardian", bridge, "lockForPayout", [keccak256(toHex("bad")), U("1"), "stellar", "x"]),
      "not orchestrator",
      "bridge role",
    ),
  );

  await t("release returns a locked payout to its refund target", async () => {
    const tid = keccak256(toHex("refund"));
    await write("deployer", usdc, "mint", [relayerAddr, U("5")]);
    await write("relayer", usdc, "approve", [bridge.address, U("5")]);
    await write("relayer", bridge, "lockForPayout", [tid, U("5"), "stellar", "refund"]);
    const before = (await read(usdc, "balanceOf", [relayerAddr])) as bigint;
    await write("relayer", bridge, "release", [tid, relayerAddr]);
    const after = (await read(usdc, "balanceOf", [relayerAddr])) as bigint;
    assert.equal(after - before, U("5"));
  });

  console.log("AdminTimelock:");
  await t("timelock can own remaining admin contracts", async () => {
    await write("deployer", swapper, "transferOwnership", [timelock.address]);
    assert.equal(String(await read(swapper, "owner")).toLowerCase(), timelock.address.toLowerCase());
  });

  await t("re-added owner must re-confirm before a stale operation can execute", async () => {
    const staleSetDelay = encodeFunctionData({
      abi: timelock.abi,
      functionName: "setDelay",
      args: [9n],
    });
    const staleSalt = keccak256(toHex("stale-confirmation"));
    await write("guardian", timelock, "queue", [timelock.address, 0n, staleSetDelay, staleSalt]);
    await write("relayer", timelock, "confirm", [
      await read(timelock, "operationId", [timelock.address, 0n, staleSetDelay, staleSalt]),
    ]);

    const removeGuardian = encodeFunctionData({
      abi: timelock.abi,
      functionName: "removeOwner",
      args: [guardianAddr],
    });
    const removeSalt = keccak256(toHex("remove-guardian"));
    const removeId = await read(timelock, "operationId", [timelock.address, 0n, removeGuardian, removeSalt]);
    await write("deployer", timelock, "queue", [timelock.address, 0n, removeGuardian, removeSalt]);
    await write("relayer", timelock, "confirm", [removeId]);
    await mineAfter(2);
    await write("deployer", timelock, "execute", [removeId]);

    const addGuardian = encodeFunctionData({
      abi: timelock.abi,
      functionName: "addOwner",
      args: [guardianAddr],
    });
    const addSalt = keccak256(toHex("readd-guardian"));
    const addId = await read(timelock, "operationId", [timelock.address, 0n, addGuardian, addSalt]);
    await write("deployer", timelock, "queue", [timelock.address, 0n, addGuardian, addSalt]);
    await write("relayer", timelock, "confirm", [addId]);
    await mineAfter(2);
    await write("deployer", timelock, "execute", [addId]);

    const staleId = await read(timelock, "operationId", [timelock.address, 0n, staleSetDelay, staleSalt]);
    assert.equal(await read(timelock, "liveConfirmations", [staleId]), 1);
    await expectRevert(
      write("deployer", timelock, "execute", [staleId]),
      "not enough confirmations",
      "stale timelock confirmation",
    );
    await write("guardian", timelock, "confirm", [staleId]);
    assert.equal(await read(timelock, "liveConfirmations", [staleId]), 2);
    await write("deployer", timelock, "execute", [staleId]);
    assert.equal(await read(timelock, "delay"), 9n);
  });

  console.log(`\n${pass} tests passed`);
}

const node = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/.bin/hardhat"), "node", "--port", "8546"],
  { cwd: ROOT, stdio: "ignore" },
);

try {
  await waitForRpc();
  await main();
} finally {
  node.kill();
}
