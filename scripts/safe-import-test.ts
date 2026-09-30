/**
 * Importing an existing Safe (wallet/safe-import.ts, routes/safe-import.ts):
 * every check confirm runs, against canned chain answers, and the routes'
 * refusals. Offline — no RPC, no bundler; the store is a temp file.
 *
 * What this cannot show: that a real Safe with these reads accepts a
 * passkey-signed UserOperation, or that Monerium accepts its link signature.
 * docs/status.md records what ran on Base Sepolia.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  toHex,
} from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Before config.ts is read: a real chain id (no harness), and a throwaway db.
process.env.TRANSF_CHAIN_ID = "84532";
process.env.CANDIDE_CHAIN_ID = "84532";
process.env.KYC_AUTO_APPROVE = "0";
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "safe-import-")), "db.json");

const {
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  SAFE_4337_MODULE,
  SAFE_L2_V141_SINGLETON,
  SafeImportRefusal,
  checkSafeForImport,
  execTransactionByOwner,
  ownerChangeTransaction,
  passkeyVerifierAddress,
  verifierDeploymentTransaction,
} = await import("../services/api/src/wallet/safe-import.js");
const { accountForPlan, passkeyAccountAddress } = await import("../services/api/src/wallet/candide.js");

type Hex = `0x${string}`;
const SAFE = getAddress("0x5afe00000000000000000000000000000000beef") as Hex;
const EOA = getAddress("0xe0a0000000000000000000000000000000000001") as Hex;
const OTHER = getAddress("0x0ade000000000000000000000000000000000002") as Hex;
const STRANGER_MODULE = getAddress("0xbad0000000000000000000000000000000000003") as Hex;
const GUARD = getAddress("0x6a4d000000000000000000000000000000000004") as Hex;
const SENTINEL = "0x0000000000000000000000000000000000000001";
const ZERO = "0x0000000000000000000000000000000000000000";
const PK = { x: 0x1111111111111111111111111111111111111111111111111111111111111111n, y: 0x2222222222222222222222222222222222222222222222222222222222222222n };
const VERIFIER = passkeyVerifierAddress(PK.x, PK.y);

const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function balanceOf(address) view returns (uint256)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
]);

interface Chain {
  code: Record<string, Hex>;
  singleton: Hex;
  fallback: Hex;
  guard: Hex;
  owners: Hex[];
  threshold: bigint;
  modules: Hex[];
  next: Hex;
  eth: Record<string, bigint>;
  tokens: Record<string, bigint>;
  failOn?: string;
}
const word = (a: string) => toHex(BigInt(a), { size: 32 });
function goodChain(): Chain {
  return {
    code: { [SAFE.toLowerCase()]: "0x6080", [VERIFIER.toLowerCase()]: "0x6080" },
    singleton: SAFE_L2_V141_SINGLETON,
    fallback: SAFE_4337_MODULE,
    guard: ZERO,
    owners: [VERIFIER, EOA],
    threshold: 1n,
    modules: [SAFE_4337_MODULE],
    next: SENTINEL,
    eth: {},
    tokens: {},
  };
}
function readerFor(c: Chain) {
  const fail = (m: string) => {
    if (c.failOn === m) throw new Error(`${m} failed (503): upstream`);
  };
  return {
    async getCode(a: Hex) {
      fail("eth_getCode");
      return c.code[a.toLowerCase()] ?? "0x";
    },
    async getBalance(a: Hex) {
      fail("eth_getBalance");
      return c.eth[a.toLowerCase()] ?? 0n;
    },
    async getStorageAt(_a: Hex, slot: Hex) {
      fail("eth_getStorageAt");
      if (BigInt(slot) === 0n) return word(c.singleton);
      if (slot === FALLBACK_HANDLER_SLOT) return word(c.fallback);
      if (slot === GUARD_SLOT) return word(c.guard);
      return toHex(0n, { size: 32 });
    },
    async call(to: Hex, data: Hex) {
      fail("eth_call");
      const d = decodeFunctionData({ abi: safeAbi, data });
      switch (d.functionName) {
        case "getOwners": return encodeFunctionResult({ abi: safeAbi, functionName: "getOwners", result: c.owners });
        case "getThreshold": return encodeFunctionResult({ abi: safeAbi, functionName: "getThreshold", result: c.threshold });
        case "getModulesPaginated": return encodeFunctionResult({ abi: safeAbi, functionName: "getModulesPaginated", result: [c.modules, c.next] });
        case "balanceOf": return encodeFunctionResult({ abi: safeAbi, functionName: "balanceOf", result: c.tokens[`${to}:${(d.args[0] as string)}`.toLowerCase()] ?? 0n });
      }
      throw new Error(`unexpected call ${d.functionName}`);
    },
  };
}

let pass = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  pass++;
  console.log(`  ok  ${name}`);
}
async function refusedWith(c: Chain, code: string) {
  await assert.rejects(checkSafeForImport(readerFor(c), SAFE, VERIFIER), (e: any) => e instanceof SafeImportRefusal && e.code === code);
}

// ---- the confirm checks -----------------------------------------------------

await check("the addresses are the ones SafeMultiChainSigAccountV1 deploys", () => {
  assert.equal(SAFE_L2_V141_SINGLETON, "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
  assert.equal(SAFE_4337_MODULE, "0x22939E839e3c0F479B713eAF95e0df128554AEAd");
  assert.equal(FALLBACK_HANDLER_SLOT, "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5");
  assert.equal(GUARD_SLOT, "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8");
  assert.equal(VERIFIER, getAddress(passkeyAccountAddress(PK)), "the verifier is the one Zold signs with");
});
await check("a good Safe passes (verifier + the EOA, threshold 1)", async () => {
  const s = await checkSafeForImport(readerFor(goodChain()), SAFE, VERIFIER);
  assert.deepEqual(s.owners, [VERIFIER, EOA]);
});
await check("the verifier alone passes", async () => {
  await checkSafeForImport(readerFor({ ...goodChain(), owners: [VERIFIER] }), SAFE, VERIFIER);
});
await check("an extra module is refused", () => refusedWith({ ...goodChain(), modules: [SAFE_4337_MODULE, STRANGER_MODULE] }, "EXTRA_MODULES"));
await check("a module list longer than one page is refused", () => refusedWith({ ...goodChain(), next: STRANGER_MODULE }, "EXTRA_MODULES"));
await check("threshold 2 is refused", () => refusedWith({ ...goodChain(), threshold: 2n }, "THRESHOLD_NOT_ONE"));
await check("a wrong singleton is refused", () =>
  refusedWith({ ...goodChain(), singleton: getAddress("0x41675C099F32341bf84BFc5382aF534df5C7461a") as Hex }, "WRONG_SINGLETON"));
await check("a verifier with no code is reported so confirm can deploy it", () =>
  refusedWith({ ...goodChain(), code: { [SAFE.toLowerCase()]: "0x6080" } }, "VERIFIER_NO_CODE"));
await check("a third owner is refused", () => refusedWith({ ...goodChain(), owners: [VERIFIER, EOA, OTHER] }, "TOO_MANY_OWNERS"));
await check("the verifier must be an owner", () => refusedWith({ ...goodChain(), owners: [EOA] }, "VERIFIER_NOT_OWNER"));
await check("the 4337 module must be enabled", () => refusedWith({ ...goodChain(), modules: [] }, "MODULE_4337_DISABLED"));
await check("the fallback handler must be the 4337 module", () =>
  refusedWith({ ...goodChain(), fallback: getAddress("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99") as Hex }, "WRONG_FALLBACK_HANDLER"));
await check("a guard is refused", () => refusedWith({ ...goodChain(), guard: GUARD }, "GUARD_SET"));
await check("an address with no code is refused", () => refusedWith({ ...goodChain(), code: {} }, "NO_CODE"));
await check("an RPC failure is an error, never a pass", async () => {
  for (const m of ["eth_getCode", "eth_getStorageAt", "eth_call"]) {
    await assert.rejects(checkSafeForImport(readerFor({ ...goodChain(), failOn: m }), SAFE, VERIFIER), (e: any) => !(e instanceof SafeImportRefusal));
  }
});

// ---- the owner change the EOA sends -------------------------------------------

await check("add: addOwnerWithThreshold(verifier, 1), the EOA stays", () => {
  const c = ownerChangeTransaction({ safe: SAFE, owners: [EOA], threshold: 1, verifier: VERIFIER, mode: "add" });
  assert.equal(c.to, SAFE);
  assert.equal(c.value, 0n);
  const d = decodeFunctionData({ abi: safeAbi, data: c.data as Hex });
  assert.deepEqual([d.functionName, d.args], ["addOwnerWithThreshold", [VERIFIER, 1n]]);
  assert.deepEqual(c.resultOwners, [VERIFIER, EOA]);
});
await check("swap: swapOwner(sentinel, EOA, verifier) removes the EOA", () => {
  const c = ownerChangeTransaction({ safe: SAFE, owners: [EOA], threshold: 1, verifier: VERIFIER, mode: "swap" });
  const d = decodeFunctionData({ abi: safeAbi, data: c.data as Hex });
  assert.deepEqual([d.functionName, d.args], ["swapOwner", [SENTINEL, EOA, VERIFIER]]);
  assert.deepEqual(c.resultOwners, [VERIFIER]);
  const second = ownerChangeTransaction({ safe: SAFE, owners: [OTHER, EOA], threshold: 1, verifier: VERIFIER, mode: "swap", replace: EOA });
  assert.deepEqual(decodeFunctionData({ abi: safeAbi, data: second.data as Hex }).args, [OTHER, EOA, VERIFIER], "prevOwner is the list predecessor");
});
await check("no change leaves 3 owners or a threshold other than 1", () => {
  assert.throws(() => ownerChangeTransaction({ safe: SAFE, owners: [EOA, OTHER], threshold: 1, verifier: VERIFIER, mode: "add" }), /at most 2/);
  assert.throws(() => ownerChangeTransaction({ safe: SAFE, owners: [EOA, OTHER], threshold: 2, verifier: VERIFIER, mode: "swap", replace: EOA }), /threshold/);
  assert.throws(() => ownerChangeTransaction({ safe: SAFE, owners: [VERIFIER, EOA], threshold: 1, verifier: VERIFIER, mode: "add" }), /already an owner/);
});
await check("the owner's direct execTransaction carries a pre-validated signature", () => {
  const change = ownerChangeTransaction({ safe: SAFE, owners: [EOA], threshold: 1, verifier: VERIFIER, mode: "add" });
  const exec = execTransactionByOwner(SAFE, EOA, change);
  const d = decodeFunctionData({ abi: safeAbi, data: exec.data });
  assert.equal(d.functionName, "execTransaction");
  const [to, value, data, operation, , , , gasToken, refund, sig] = d.args as unknown as any[];
  assert.deepEqual([to, value, data, operation, gasToken, refund], [SAFE, 0n, change.data, 0, ZERO, ZERO]);
  assert.equal(sig, `0x${EOA.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01`);
});
await check("the verifier deployment is a factory call, not a Safe call", () => {
  const t = verifierDeploymentTransaction(PK.x, PK.y);
  assert.notEqual(t.to.toLowerCase(), SAFE.toLowerCase());
  assert.equal(t.value, 0n);
});

// ---- the routes ----------------------------------------------------------------

const express = (await import("express")).default;
const { store } = await import("../services/api/src/store.js");
const { createSafeImportRouter } = await import("../services/api/src/routes/safe-import.js");
const { webauthnOwnerToStore, smartAccountForPasskey } = await import("../services/api/src/wallet/candide.js");

const planAddress = smartAccountForPasskey(PK).accountAddress as Hex;
const makeUser = (id: string, over: any = {}) => {
  store.addUser({
    id,
    name: id,
    email: `${id}@example.test`,
    country: "DE",
    kycStatus: "pending",
    iban: "",
    address: planAddress,
    passkey: { credentialId: `cred-${id}`, publicKey: { alg: "ES256", jwk: {} }, signCount: 0, createdAt: new Date().toISOString() },
    passkeySafe: { address: planAddress, status: "planned", threshold: 1, passkeyPublicKey: webauthnOwnerToStore(PK), createdAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    ...over,
  } as any);
  return store.findUser(id)!;
};

let chain = goodChain();
let deployed: unknown[] = [];
const app = express();
app.use(express.json());
app.use("/api", createSafeImportRouter({
  requireUserSession: () => true,
  reader: () => readerFor(chain),
  deployVerifier: async (o) => {
    deployed.push(o);
    return undefined; // the test never relays; confirm must then refuse
  },
}));
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const post = async (p: string, body: unknown) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};

await check("prepare returns the verifier and both owner changes, and stores nothing", async () => {
  makeUser("u1");
  chain = { ...goodChain(), owners: [EOA] };
  const before = JSON.stringify(store.findUser("u1"));
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verifier, VERIFIER);
  assert.equal(r.body.verifierDeployed, true);
  assert.equal(r.body.deployVerifier, null);
  const add = decodeFunctionData({ abi: safeAbi, data: r.body.ownerChange.add.data });
  assert.deepEqual(add.args, [VERIFIER, 1n]);
  assert.equal(decodeFunctionData({ abi: safeAbi, data: r.body.ownerChange.swap.data }).functionName, "swapOwner");
  assert.equal(JSON.stringify(store.findUser("u1")), before, "prepare must not touch the account");
});
await check("prepare refuses a Safe confirm would refuse anyway", async () => {
  chain = { ...goodChain(), owners: [EOA], modules: [SAFE_4337_MODULE, STRANGER_MODULE] };
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.deepEqual([r.status, r.body.code], [409, "EXTRA_MODULES"]);
});
await check("confirm before the owner change binds nothing", async () => {
  chain = { ...goodChain(), owners: [EOA] };
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.deepEqual([r.status, r.body.code], [409, "VERIFIER_NOT_OWNER"]);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("confirm on an RPC failure binds nothing", async () => {
  chain = { ...goodChain(), failOn: "eth_call" };
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.deepEqual([r.status, r.body.code], [502, "RPC_FAILED"]);
  assert.equal(store.findUser("u1")!.address, planAddress);
});
await check("confirm tries the verifier deployment, and refuses when it cannot send it", async () => {
  chain = { ...goodChain(), code: { [SAFE.toLowerCase()]: "0x6080" } };
  deployed = [];
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.deepEqual([r.status, r.body.code], [409, "VERIFIER_NO_CODE"]);
  assert.equal(deployed.length, 1);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("funds at the planned address refuse the import", async () => {
  chain = { ...goodChain(), eth: { [planAddress.toLowerCase()]: 1n } };
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "PLAN_HAS_FUNDS");
  chain = { ...goodChain(), tokens: { [`0x036CbD53842c5426634e7929541eC2318f3dCF7e:${planAddress}`.toLowerCase()]: 1n } };
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "PLAN_HAS_FUNDS");
});
await check("a deployed own Safe is never replaced", async () => {
  chain = goodChain();
  chain.code[planAddress.toLowerCase()] = "0x6080";
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "SAFE_DEPLOYED");
});
await check("confirm binds a good Safe as imported, never as recovered", async () => {
  chain = goodChain();
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = store.findUser("u1")!;
  assert.equal(u.address, SAFE);
  assert.equal(u.passkeySafe!.address, SAFE);
  assert.equal(u.passkeySafe!.status, "active");
  assert.equal(u.passkeySafe!.threshold, 1);
  assert.ok(u.passkeySafe!.importedAt);
  assert.equal(u.passkeySafe!.recoveredAt, undefined);
  assert.equal(u.passkeySafe!.previousAddress, planAddress);
  // The signing path builds the account from the stored address.
  assert.equal(accountForPlan(u.passkeySafe as any).account.accountAddress.toLowerCase(), SAFE.toLowerCase());
});
await check("an active account can never import again", async () => {
  assert.equal((await post("/users/u1/safe/import/prepare", { address: SAFE })).body.code, "SAFE_ACTIVE");
});
await check("a Safe bound to one account cannot be bound to another", async () => {
  makeUser("u2");
  chain = goodChain();
  assert.equal((await post("/users/u2/safe/import/confirm", { address: SAFE })).body.code, "ADDRESS_IN_USE");
});
server.close();

await check("the router is mounted and the plan type carries importedAt", () => {
  const server = readFileSync(path.join(ROOT, "services/api/src/server.ts"), "utf8");
  assert.match(server, /app\.use\("\/api", createSafeImportRouter\(/);
  const candide = readFileSync(path.join(ROOT, "services/api/src/wallet/candide.ts"), "utf8");
  assert.match(candide, /if \(plan\.recoveredAt \|\| plan\.importedAt\)/, "an imported Safe is built from its address");
  assert.ok(!/cosigner/i.test(readFileSync(path.join(ROOT, "services/api/src/routes/safe-import.ts"), "utf8")));
});

console.log(`safe-import: ${pass} ok`);
process.exit(0);
