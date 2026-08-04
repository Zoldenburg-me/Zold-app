/**
 * FP5 quote-to-execution binding test.
 *
 * RemitVault removal makes local full-remittance execution require a deployed
 * Safe, which a hardhat-only test does not have. This pins the remaining
 * invariant directly: a quote records the rate it was priced against, and the
 * executor refuses if the live on-chain rate has moved past tolerance.
 *
 * Own port. Run: npm run fp5:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { loadDeployments } from "../services/api/src/config.js";
import { eur } from "../services/api/src/chain.js";
import { assertQuoteRateBinding } from "../services/api/src/orchestrator.js";
import { initStore, store, type Quote, type Transfer } from "../services/api/src/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC).port || "8545";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const ENV = {
  ...process.env,
  MONERIUM_CLIENT_ID: "",
  MONERIUM_CLIENT_SECRET: "",
  MG_ANCHOR_DOMAIN: "",
  TRANSF_RPC_URL: RPC,
};
const children: ChildProcess[] = [];
const bg = (c: string, a: string[]) => {
  const p = spawn(c, a, { cwd: ROOT, stdio: "ignore", env: ENV });
  children.push(p);
  return p;
};

try {
  console.log("1/3 chain + deploy...");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
  {
    const s = Date.now();
    while (Date.now() - s < 30_000) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  assert.equal(
    spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...ENV, TIMELOCK_DELAY_SECONDS: "0" },
    }).status,
    0,
  );
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  initStore();

  console.log("2/3 quote records the locked rate...");
  const now = new Date().toISOString();
  const quote: Quote = {
    id: "q-fp5",
    userId: "u-fp5",
    rail: "cash",
    status: "OPEN",
    sendEur: 100,
    fixedFeeEur: 1,
    fxRate: 1,
    receiveKes: 12950,
    receiveEur: 0,
    midRate: 1,
    marginBps: 0,
    effectiveRate: 1,
    lockedSwapRate: "1151100",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
  };
  store.addQuote(quote);
  const transfer: Transfer = {
    id: "t-fp5",
    userId: "u-fp5",
    quoteId: quote.id,
    rail: "cash",
    recipientName: "Recipient",
    recipientPhone: "+254700000000",
    state: "CREATED",
    sendEur: 100,
    receiveKes: 12950,
    fundingSource: "safe",
    txs: [],
    auth: {
      to: "0x0000000000000000000000000000000000000002",
      amountWei: eur.toWei(100).toString(),
      destination: `0x${"cd".repeat(32)}`,
      deadline: Math.floor(Date.now() / 1000) + 900,
    },
    createdAt: now,
    updatedAt: now,
  };
  await assertQuoteRateBinding(transfer);

  console.log("3/3 moving the on-chain FX rate past tolerance...");
  const dep = createWalletClient({
    account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
    chain: hardhat,
    transport: http(RPC),
  });
  const second = createWalletClient({
    account: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
    chain: hardhat,
    transport: http(RPC),
  });
  const { swapper, timelock } = loadDeployments();
  assert.ok(timelock, "deployments.json should record the AdminTimelock address");
  const setRate = encodeFunctionData({
    abi: [{ type: "function", name: "setRate", stateMutability: "nonpayable", inputs: [{ name: "_rate", type: "uint256" }], outputs: [] }] as const,
    functionName: "setRate",
    args: [900_000n],
  });
  const tlAbi = [
    { type: "function", name: "queue", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "confirm", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
    { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bytes" }] },
    { type: "function", name: "operationId", stateMutability: "pure", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  ] as const;
  const salt = keccak256(toHex("fp5-rate-move"));
  const opId = await pub.readContract({ address: timelock, abi: tlAbi, functionName: "operationId", args: [swapper, 0n, setRate, salt] });
  const send = async (w: typeof dep, fn: "queue" | "confirm" | "execute", args: any[]) => {
    const { request } = await pub.simulateContract({ account: w.account, address: timelock, abi: tlAbi, functionName: fn as any, args: args as any });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract(request) });
  };
  await send(dep, "queue", [swapper, 0n, setRate, salt]);
  await send(second, "confirm", [opId]);
  await send(dep, "execute", [opId]);

  await assert.rejects(
    () => assertQuoteRateBinding(transfer),
    /FX rate moved since quote/i,
  );

  console.log("\nFP5 BINDING TEST PASSED — moved rates are refused before settlement");
} finally {
  for (const c of children) c.kill();
}
