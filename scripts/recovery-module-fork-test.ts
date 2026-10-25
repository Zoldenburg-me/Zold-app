/**
 * Candide's deployed SocialRecoveryModule, on a fork of Base mainnet: does it
 * take a CONTRACT as a guardian, and does the grace period hold?
 *
 * This is the question a TOTP guardian depends on. Such a guardian is a
 * contract that calls `confirmRecovery` itself once its own check passes, so
 * the module must accept msg.sender == guardian contract — no ECDSA, no
 * EIP-1271. The deployed module is EIP-712 version "0.0.1"; Candide's GitHub
 * source is a different version, so this runs against the bytecode on Base,
 * not against the source.
 *
 * Each scenario deploys a fresh plain Safe 1.4.1 (one EOA owner standing in
 * for the passkey), enables the 3-day module and adds StubContractGuardian.
 * Every refusal is asserted by its revert reason, so a wrong address or a
 * disabled module cannot pass as "refused".
 *
 * Needs egress to a Base RPC: BASE_RPC_URL (default https://mainnet.base.org,
 * rate-limited; a keyed RPC is steadier), optional FORK_BLOCK (the default is
 * the latest block, because public RPCs prune old state). Part of
 * `npm run check:live`, not the offline check.
 *
 * Run: npm run recovery:fork:test
 */
import assert from "node:assert/strict";
import { freePort } from "./_free-port.js";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORK_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const FORK_BLOCK = process.env.FORK_BLOCK;
const BASE_CHAIN_ID = 8453;
const STARTUP_TIMEOUT_MS = 90_000;
const LOG_TAIL_LINES = 40;

const MODULE_3_DAYS: Address = "0x38275826E1933303E508433dD5f289315Da2541c";
const GRACE_SECONDS = 3n * 24n * 3600n;
const SAFE_SINGLETON_L2_141: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_PROXY_FACTORY_141: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

// The module's revert reasons, as the deployed bytecode returns them.
const NOT_GUARDIAN = "SM: sender not a guardian";
const STILL_PENDING = "SM: recovery period still pending";
const NO_RECOVERY = "SM: no ongoing recovery";

// Hardhat's default funded accounts; the fork funds them too.
const pk = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  eoaGuardian: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  stranger: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
type Signer = keyof typeof pk;
const NEW_OWNER: Address = "0x00000000000000000000000000000000000b0b01";
const OTHER_OWNER: Address = "0x0000000000000000000000000000000000000bad";

interface RecoveryRequest {
  guardiansApprovalCount: bigint;
  newThreshold: bigint;
  executeAfter: bigint;
  newOwners: readonly Address[];
}

const moduleAbi = parseAbi([
  "function confirmRecovery(address wallet, address[] newOwners, uint256 newThreshold, bool execute)",
  "function finalizeRecovery(address wallet)",
  "function cancelRecovery()",
  "function addGuardianWithThreshold(address guardian, uint256 threshold)",
  "function revokeGuardianWithThreshold(address prevGuardian, address guardian, uint256 threshold)",
  "function getRecoveryRequest(address wallet) view returns ((uint256 guardiansApprovalCount, uint256 newThreshold, uint64 executeAfter, address[] newOwners))",
  "function getRecoveryApprovals(address wallet, address[] newOwners, uint256 newThreshold) view returns (uint256)",
  "function getGuardians(address wallet) view returns (address[])",
  "function isGuardian(address wallet, address guardian) view returns (bool)",
  "function threshold(address wallet) view returns (uint256)",
  "function nonce(address wallet) view returns (uint256)",
]);
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function enableModule(address module)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

const PORT = await freePort();
const RPC = `http://127.0.0.1:${PORT}`;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** The revert reason of a failed call, or null if the failure was not an on-chain revert. */
function revertReason(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.reason ?? "" : null;
}

async function main(): Promise<void> {
  const chain = defineChain({
    id: Number(await rpc("eth_chainId")),
    name: "base-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = (k: Signer) =>
    createWalletClient({ account: privateKeyToAccount(pk[k]), chain, transport: http(RPC) });
  const ownerAddr = privateKeyToAccount(pk.owner).address;
  const eoaGuardianAddr = privateKeyToAccount(pk.eoaGuardian).address;

  async function send(who: Signer, address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const w = wallet(who);
    const { request, result } = await pub.simulateContract({ account: w.account, address, abi, functionName, args });
    const hash = await w.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${functionName} reverted`);
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    return { result, timestamp: block.timestamp };
  }
  const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<unknown> =>
    pub.readContract({ address, abi, functionName, args });
  const mod = (fn: string, args: unknown[] = []) => read(MODULE_3_DAYS, moduleAbi, fn, args);
  const request = async (safe: Address) => (await mod("getRecoveryRequest", [safe])) as RecoveryRequest;
  const lower = (list: readonly string[]) => list.map((a) => a.toLowerCase());
  const owners = async (safe: Address) => lower((await read(safe, safeAbi, "getOwners")) as Address[]);

  /** Passes only on an on-chain revert whose reason contains `reason`. */
  async function expectRevert(p: Promise<unknown>, reason: string, label: string): Promise<void> {
    try {
      await p;
    } catch (e: unknown) {
      const got = revertReason(e);
      assert.ok(got !== null, `${label}: expected a contract revert, got ${e instanceof BaseError ? e.shortMessage : String(e)}`);
      assert.ok(got.includes(reason), `${label}: expected "${reason}", got "${got}"`);
      return;
    }
    assert.fail(`${label}: did not revert`);
  }

  /** "accepted", or the revert reason; anything other than a revert is rethrown. */
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return "accepted";
    } catch (e: unknown) {
      const got = revertReason(e);
      if (got === null) throw e;
      return `reverted: ${got}`;
    }
  }

  async function mineAfter(seconds: bigint): Promise<void> {
    await rpc("evm_increaseTime", [Number(seconds)]);
    await rpc("evm_mine");
  }

  /** The Safe calls `to` with `data`, approved by its single owner sending the tx (v = 1). */
  async function safeExec(safe: Address, to: Address, data: Hex) {
    const signature = concat([pad(ownerAddr, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
    return send("owner", safe, safeAbi, "execTransaction", [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature]);
  }
  const moduleCall = (functionName: string, args: unknown[] = []): Hex =>
    encodeFunctionData({ abi: moduleAbi as Abi, functionName, args });

  let saltNonce = BigInt(Date.now());
  /** A fresh Safe owned by `owner`, with the 3-day module enabled and the given guardians. */
  async function newSafe(guardians: Address[], threshold: bigint): Promise<Address> {
    const initializer = encodeFunctionData({
      abi: safeAbi,
      functionName: "setup",
      args: [[ownerAddr], 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO],
    });
    const { result } = await send("owner", SAFE_PROXY_FACTORY_141, factoryAbi, "createProxyWithNonce", [
      SAFE_SINGLETON_L2_141, initializer, saltNonce++,
    ]);
    const safe = result as Address;
    await safeExec(safe, safe, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [MODULE_3_DAYS] }));
    for (let i = 0; i < guardians.length; i++) {
      // The module refuses a threshold above the guardian count, so raise it with the last one.
      const t = i === guardians.length - 1 ? threshold : 1n;
      await safeExec(safe, MODULE_3_DAYS, moduleCall("addGuardianWithThreshold", [guardians[i], t]));
    }
    return safe;
  }

  let pass = 0;
  async function t(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.log(`  FAIL ${name}`);
      throw e;
    }
    pass++;
    console.log(`  ok ${name}`);
  }

  for (const [label, address] of [
    ["3-day recovery module", MODULE_3_DAYS],
    ["Safe 1.4.1 L2 singleton", SAFE_SINGLETON_L2_141],
    ["Safe 1.4.1 proxy factory", SAFE_PROXY_FACTORY_141],
  ] as const) {
    const code = await pub.getCode({ address });
    assert.ok(code && code.length > 2, `${label} has no code at ${address} on the fork`);
  }

  const stubArtifact = JSON.parse(readFileSync(
    path.join(ROOT, "contracts/artifacts/contracts/src/test/StubContractGuardian.sol/StubContractGuardian.json"), "utf8",
  )) as { abi: Abi; bytecode: Hex };
  async function deployStub(): Promise<Address> {
    const w = wallet("operator");
    const hash = await w.deployContract({ abi: stubArtifact.abi, bytecode: stubArtifact.bytecode, args: [] });
    const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
    assert.ok(contractAddress, "stub guardian deployment returned no address");
    return contractAddress;
  }
  const stub = await deployStub();
  const confirmVia = (guardian: Address, safe: Address, newOwners: Address[], execute: boolean) =>
    send("operator", guardian, stubArtifact.abi, "confirm", [MODULE_3_DAYS, safe, newOwners, 1n, execute]);

  console.log("Contract guardian, threshold 1:");
  const safe = await newSafe([stub], 1n);

  await t("the Safe can add a contract as guardian", async () => {
    assert.equal(await mod("isGuardian", [safe, stub]), true);
    assert.equal(await mod("threshold", [safe]), 1n);
  });

  await t("a contract that is not a guardian is refused", async () => {
    const outsider = await deployStub();
    await expectRevert(confirmVia(outsider, safe, [NEW_OWNER], true), NOT_GUARDIAN, "outsider confirm");
    assert.equal((await request(safe)).executeAfter, 0n);
  });

  await t("an account that is not a guardian is refused", async () => {
    await expectRevert(
      send("stranger", MODULE_3_DAYS, moduleAbi, "confirmRecovery", [safe, [NEW_OWNER], 1n, true]),
      NOT_GUARDIAN,
      "stranger confirm",
    );
  });

  await t("the contract guardian alone starts recovery (execute=true)", async () => {
    assert.equal(await mod("nonce", [safe]), 0n);
    const { timestamp } = await confirmVia(stub, safe, [NEW_OWNER], true);
    // 0.0.1 moves the nonce when a request starts.
    assert.equal(await mod("nonce", [safe]), 1n);
    const req = await request(safe);
    assert.equal(req.guardiansApprovalCount, 1n);
    assert.deepEqual(lower(req.newOwners), [NEW_OWNER]);
    assert.equal(req.newThreshold, 1n);
    assert.equal(req.executeAfter - timestamp, GRACE_SECONDS, "grace period is not 3 days");
  });

  await t("a stranger's cancelRecovery does not touch the Safe's request", async () => {
    const before = await request(safe);
    // cancelRecovery acts on msg.sender's own wallet; the stranger has none pending.
    await expectRevert(send("stranger", MODULE_3_DAYS, moduleAbi, "cancelRecovery", []), NO_RECOVERY, "stranger cancel");
    assert.deepEqual(await request(safe), before);
  });

  await t("finalize inside the grace period is refused", async () => {
    await mineAfter(GRACE_SECONDS - 60n);
    await expectRevert(send("stranger", MODULE_3_DAYS, moduleAbi, "finalizeRecovery", [safe]), STILL_PENDING, "early finalize");
    assert.deepEqual(await owners(safe), [ownerAddr.toLowerCase()]);
  });

  await t("the owner (passkey) cancels during the grace period", async () => {
    await safeExec(safe, MODULE_3_DAYS, moduleCall("cancelRecovery"));
    const req = await request(safe);
    assert.equal(req.executeAfter, 0n);
    assert.equal(req.newOwners.length, 0);
    // The cancelled request's approvals are spent: the same confirmation does not count again.
    assert.equal(await mod("nonce", [safe]), 1n);
    assert.equal(await mod("getRecoveryApprovals", [safe, [NEW_OWNER], 1n]), 0n);
    await mineAfter(120n);
    await expectRevert(send("stranger", MODULE_3_DAYS, moduleAbi, "finalizeRecovery", [safe]), NO_RECOVERY, "finalize after cancel");
    assert.deepEqual(await owners(safe), [ownerAddr.toLowerCase()]);
  });

  await t("re-confirming after a cancel starts a new request with a fresh 3 days", async () => {
    const { timestamp } = await confirmVia(stub, safe, [NEW_OWNER], true);
    assert.equal(await mod("nonce", [safe]), 2n);
    const req = await request(safe);
    assert.equal(req.guardiansApprovalCount, 1n);
    assert.equal(req.executeAfter - timestamp, GRACE_SECONDS);
  });

  await t("after the grace period anyone finalizes and the owner is swapped", async () => {
    await mineAfter(GRACE_SECONDS + 1n);
    await send("stranger", MODULE_3_DAYS, moduleAbi, "finalizeRecovery", [safe]);
    assert.deepEqual(await owners(safe), [NEW_OWNER]);
    assert.equal(await read(safe, safeAbi, "getThreshold"), 1n);
  });

  console.log("A second confirmation while a request is pending (two guardians, threshold 1):");
  const safeB = await newSafe([stub, eoaGuardianAddr], 1n);

  await t("no guardian can replace the pending request's new owner or restart its clock", async () => {
    await confirmVia(stub, safeB, [NEW_OWNER], true);
    const pending = await request(safeB);
    await mineAfter(3600n);
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["same guardian", () => confirmVia(stub, safeB, [OTHER_OWNER], true)],
      ["other guardian", () =>
        send("eoaGuardian", MODULE_3_DAYS, moduleAbi, "confirmRecovery", [safeB, [OTHER_OWNER], 1n, true])],
    ];
    for (const [label, attempt] of attempts) {
      console.log(`     ${label}: ${await outcome(attempt())}`);
      const now = await request(safeB);
      assert.deepEqual(lower(now.newOwners), [NEW_OWNER], `${label}: the new owner was replaced`);
      assert.equal(now.executeAfter, pending.executeAfter, `${label}: the grace period was restarted`);
    }
  });

  console.log("Guardian removed during the grace period (two guardians, threshold 1):");

  /** The Safe revokes `guardian`, keeping threshold 1 for the guardian that remains. */
  async function revoke(safe: Address, guardian: Address): Promise<void> {
    const list = (await mod("getGuardians", [safe])) as Address[];
    const i = lower(list).indexOf(guardian.toLowerCase());
    assert.ok(i >= 0, "guardian is not in the list");
    const prev = i === 0 ? SENTINEL : list[i - 1];
    await safeExec(safe, MODULE_3_DAYS, moduleCall("revokeGuardianWithThreshold", [prev, guardian, 1n]));
    assert.equal(await mod("isGuardian", [safe, guardian]), false);
  }

  // In 0.0.1 a guardian change leaves a pending request alone: revoking the
  // guardian that started it does NOT stop it. Only cancelRecovery does, so a
  // "remove this guardian" control must cancel first.
  await t("revoking the guardian alone leaves its recovery pending, and it finalizes", async () => {
    const safeC = await newSafe([stub, eoaGuardianAddr], 1n);
    await confirmVia(stub, safeC, [NEW_OWNER], true);
    const pending = await request(safeC);
    await revoke(safeC, stub);
    assert.deepEqual(await request(safeC), pending);
    await mineAfter(GRACE_SECONDS + 1n);
    await send("stranger", MODULE_3_DAYS, moduleAbi, "finalizeRecovery", [safeC]);
    assert.deepEqual(await owners(safeC), [NEW_OWNER]);
  });

  await t("cancel, then revoke, stops it", async () => {
    const safeD = await newSafe([stub, eoaGuardianAddr], 1n);
    await confirmVia(stub, safeD, [NEW_OWNER], true);
    await safeExec(safeD, MODULE_3_DAYS, moduleCall("cancelRecovery"));
    await revoke(safeD, stub);
    await mineAfter(GRACE_SECONDS + 1n);
    await expectRevert(send("stranger", MODULE_3_DAYS, moduleAbi, "finalizeRecovery", [safeD]), NO_RECOVERY, "finalize after cancel+revoke");
    assert.deepEqual(await owners(safeD), [ownerAddr.toLowerCase()]);
    await expectRevert(confirmVia(stub, safeD, [NEW_OWNER], true), NOT_GUARDIAN, "revoked guardian confirms again");
  });

  console.log("Threshold 2 (contract guardian + EOA guardian):");
  const safe2 = await newSafe([stub, eoaGuardianAddr], 2n);

  await t("the contract guardian's confirmation alone does not start recovery", async () => {
    await confirmVia(stub, safe2, [NEW_OWNER], false);
    assert.equal(await mod("getRecoveryApprovals", [safe2, [NEW_OWNER], 1n]), 1n);
    assert.equal((await request(safe2)).executeAfter, 0n);
  });

  await t("the second guardian's confirmation starts it", async () => {
    const { timestamp } = await send("eoaGuardian", MODULE_3_DAYS, moduleAbi, "confirmRecovery", [safe2, [NEW_OWNER], 1n, true]);
    const req = await request(safe2);
    assert.equal(req.guardiansApprovalCount, 2n);
    assert.equal(req.executeAfter - timestamp, GRACE_SECONDS);
  });

  console.log(`\n${pass} passed`);
}

const compile = spawnSync(process.execPath, [path.join(ROOT, "node_modules/.bin/hardhat"), "compile"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

const forkArgs = ["--fork", FORK_URL, ...(FORK_BLOCK ? ["--fork-block-number", FORK_BLOCK] : [])];
const node = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/.bin/hardhat"), "node", "--port", String(PORT), ...forkArgs],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
// Keep the node's recent output; it is printed only when something fails.
const nodeLog: string[] = [];
for (const stream of [node.stdout, node.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    nodeLog.push(...chunk.split("\n").filter(Boolean));
    nodeLog.splice(0, Math.max(0, nodeLog.length - LOG_TAIL_LINES));
  });
}
const nodeExited = new Promise<never>((_, reject) => {
  node.once("error", (e) => reject(new Error(`could not start hardhat node: ${e.message}`)));
  node.once("exit", (code, signal) => reject(new Error(`hardhat node exited (code ${code}, signal ${signal})`)));
});
nodeExited.catch(() => undefined);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    node.kill();
    process.exit(130);
  });
}

/** Resolves once OUR forked node answers; rejects if it exits first or never comes up. */
async function waitForForkedNode(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const poll = async (): Promise<void> => {
    while (Date.now() < deadline) {
      try {
        // hardhat_metadata names the forked chain, so another process that took the port does not pass.
        const meta = (await rpc("hardhat_metadata")) as { forkedNetwork?: { chainId: number } };
        assert.equal(meta.forkedNetwork?.chainId, BASE_CHAIN_ID, "the node on the port is not a fork of Base");
        return;
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`forked hardhat node did not answer within ${STARTUP_TIMEOUT_MS / 1000}s`);
  };
  await Promise.race([poll(), nodeExited]);
}

try {
  await waitForForkedNode();
  await Promise.race([main(), nodeExited]);
} catch (e) {
  console.error(`\nhardhat node, last ${nodeLog.length} lines:\n${nodeLog.join("\n")}\n`);
  throw e;
} finally {
  node.kill();
}
