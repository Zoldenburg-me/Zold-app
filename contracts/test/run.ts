/**
 * Contract tests for OffchainResolver, end to end through the API's gateway
 * code.
 * Run: npm run test:contracts
 */
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http, namehash, parseAbi, toCoinType, toHex, type Hex } from "viem";
import { packetToBytes } from "viem/ens";
import { answerResolveCall, NO_RECORDS, signGatewayResponse } from "../../services/api/src/ens.js";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// A free port, so the suite never deploys against some other node that
// happens to be listening on a fixed one.
const PORT: number = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    if (!a || typeof a === "string") { s.close(); reject(new Error("no free port")); return; }
    const port = a.port;
    s.close(() => resolve(port));
  });
});
const RPC = `http://127.0.0.1:${PORT}`;

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

async function main() {
  let pass = 0;
  async function t(name: string, fn: () => Promise<void>) {
    await fn();
    pass++;
    console.log(`  ok ${name}`);
  }

  // ---- OffchainResolver + the gateway's signing, through a real CCIP-Read ----
  // viem follows the OffchainLookup revert to this server exactly as a wallet
  // would, and hands the signed answer back to resolveWithProof.
  const PAGE = "0x1111111111111111111111111111111111111111";
  const gatewayKey = pk.guardian;
  let gatewayExpiresIn = 300n;
  let gatewaySignWith: `0x${string}` = gatewayKey;
  const gateway = createHttpServer(async (req, res) => {
    const m = req.url?.match(/^\/gw\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]*)\.json$/);
    if (!m) { res.writeHead(404).end(); return; }
    const { result } = await answerResolveCall(m[2] as Hex, "zoldhq.com", async (handle) =>
      handle === "alice" ? { addresses: new Map([[toCoinType(8453), PAGE]]), texts: { url: "https://zoldhq.com/pay/alice" } } : NO_RECORDS);
    const block = await pub.getBlock();
    const data = await signGatewayResponse({ resolver: m[1].toLowerCase() as `0x${string}`, request: m[2] as Hex, result, expires: block.timestamp + gatewayExpiresIn, key: gatewaySignWith });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });
  const gatewayPort: number = await new Promise((r) => gateway.listen(0, "127.0.0.1", () => r((gateway.address() as any).port)));
  const resolver = await deploy("OffchainResolver", [`http://127.0.0.1:${gatewayPort}/gw/{sender}/{data}.json`, [guardianAddr]]);
  const profile = parseAbi([
    "function addr(bytes32 node) view returns (address)",
    "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
    "function text(bytes32 node, string key) view returns (string)",
  ]);
  const resolveFor = async (name: string, data: Hex) =>
    (await read(resolver, "resolve", [toHex(packetToBytes(name)), data])) as Hex;
  const unwrap = (type: string, raw: Hex) => decodeAbiParameters([{ type }], raw)[0];

  try {
    await t("ens: a handle resolves to its page address for the pay chain's coin type", async () => {
      const raw = await resolveFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("alice.zoldhq.com"), toCoinType(8453)] }));
      assert.equal(unwrap("bytes", raw), PAGE);
    });
    await t("ens: no Ethereum (coin type 60) address for a Base-only page", async () => {
      const raw = await resolveFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("alice.zoldhq.com")] }));
      assert.equal(unwrap("address", raw), "0x0000000000000000000000000000000000000000");
    });
    await t("ens: the url text record points at the page", async () => {
      const raw = await resolveFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "text", args: [namehash("alice.zoldhq.com"), "url"] }));
      assert.equal(unwrap("string", raw), "https://zoldhq.com/pay/alice");
    });
    await t("ens: an unknown handle resolves to nothing", async () => {
      const raw = await resolveFor("nobody.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("nobody.zoldhq.com"), toCoinType(8453)] }));
      assert.equal(unwrap("bytes", raw), "0x");
    });
    await t("ens: an answer signed by a key that is not a signer is refused", async () => {
      gatewaySignWith = pk.relayer;
      await expectRevert(
        resolveFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("alice.zoldhq.com"), toCoinType(8453)] })),
        "invalid signature",
        "foreign signer",
      );
      gatewaySignWith = gatewayKey;
    });
    await t("ens: an expired answer is refused", async () => {
      gatewayExpiresIn = -1n;
      await expectRevert(
        resolveFor("alice.zoldhq.com", encodeFunctionData({ abi: profile, functionName: "addr", args: [namehash("alice.zoldhq.com"), toCoinType(8453)] })),
        "signature expired",
        "expired answer",
      );
      gatewayExpiresIn = 300n;
    });
    await t("ens: an answer for one request does not verify for another", async () => {
      const request = encodeFunctionData({ abi: parseAbi(["function resolve(bytes,bytes)"]), functionName: "resolve", args: [toHex(packetToBytes("alice.zoldhq.com")), "0x"] });
      const block = await pub.getBlock();
      const signed = await signGatewayResponse({ resolver: resolver.address.toLowerCase() as `0x${string}`, request, result: encodeAbiParameters([{ type: "bytes" }], [PAGE]), expires: block.timestamp + 300n, key: gatewayKey });
      const other = encodeFunctionData({ abi: parseAbi(["function resolve(bytes,bytes)"]), functionName: "resolve", args: [toHex(packetToBytes("bob.zoldhq.com")), "0x"] });
      await expectRevert(read(resolver, "resolveWithProof", [signed, other]), "invalid signature", "replayed answer");
    });
    await t("ens: only the owner moves the gateway or the signers", async () => {
      await expectRevert(write("relayer", resolver, "setSigner", [relayerAddr, true]), "not owner", "stranger adds signer");
      await expectRevert(write("relayer", resolver, "setUrl", ["https://evil.example/{data}"]), "not owner", "stranger moves url");
      await write("deployer", resolver, "transferOwnership", [guardianAddr]);
      assert.equal(await read(resolver, "owner"), wallets.deployer.account.address, "not moved until accepted");
      await expectRevert(write("relayer", resolver, "acceptOwnership", []), "not pending owner", "stranger accepts");
      await write("guardian", resolver, "acceptOwnership", []);
      assert.equal(await read(resolver, "owner"), guardianAddr);
      assert.equal(await read(resolver, "supportsInterface", ["0x9061b923"]), true);
    });
  } finally {
    gateway.close();
  }

  console.log(`\n${pass} tests passed`);
}

const node = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/.bin/hardhat"), "node", "--port", String(PORT)],
  { cwd: ROOT, stdio: "ignore" },
);

try {
  await waitForRpc();
  await main();
} finally {
  node.kill();
}
