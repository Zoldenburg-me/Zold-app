/**
 * Importing an existing Safe (wallet/safe-import.ts, routes/safe-import.ts):
 * every check confirm runs, against canned chain answers, and the routes'
 * refusals. Offline — no RPC, no bundler; the store is a temp file.
 *
 * What this cannot show: that a real Safe with these reads accepts a
 * passkey-signed UserOperation, or that Monerium accepts its link signature.
 * docs/status.md records what ran on Base Sepolia.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  toHex,
} from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Before config.ts is read: _local-chain pinned 31337; the harness goes back
// off because the routes refuse under it. No chain is read (the reader and the
// token list are canned), so nothing depends on a deployments.json entry.
process.env.LOCAL_HARNESS = "0";
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
const SAFE_B = getAddress("0x5afe00000000000000000000000000000000b0b0") as Hex;
const EOA = getAddress("0xe0a0000000000000000000000000000000000001") as Hex;
const OTHER = getAddress("0x0ade000000000000000000000000000000000002") as Hex;
const EURE = getAddress("0xe00e000000000000000000000000000000000005") as Hex;
const USDC = getAddress("0x05dc000000000000000000000000000000000006") as Hex;
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
  /** The owners every read after a request's first one sees: a change landing mid-request. */
  ownersLater?: Hex[];
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
  let ownerReads = 0;
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
        case "getOwners": {
          const owners = ownerReads++ > 0 && c.ownersLater ? c.ownersLater : c.owners;
          return encodeFunctionResult({ abi: safeAbi, functionName: "getOwners", result: owners });
        }
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
const { issueChallenge, stepUpBinding, verifyRegistration } = await import("../services/api/src/webauthn.js");
const { SECURITY } = await import("../services/api/src/config.js");

// A P-256 passkey, registered and asserted the way a browser would.
const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
function cbor(v: any): Buffer {
  const head = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}
function derOf(raw: Buffer) {
  const int = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0x02, b.length + 1, 0]), b]) : Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const r = int(raw.subarray(0, 32)); const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}
const ORIGIN = SECURITY.origins.find((o: string) => o.startsWith("http://localhost"))!;
const clientData = (type: string, challenge: string) => b64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));
async function makePasskey(userId: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const credId = randomBytes(16);
  const authData = (flags: number, count: number, att = false) => {
    const base = Buffer.alloc(37); sha256(SECURITY.rpId).copy(base, 0); base[32] = flags; base.writeUInt32BE(count, 33);
    if (!att) return base;
    const cred = Buffer.alloc(18 + credId.length); cred.writeUInt16BE(credId.length, 16); credId.copy(cred, 18);
    return Buffer.concat([base, cred, cose]);
  };
  const attestation = b64url(cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, 0, true)]])));
  const reg = verifyRegistration(attestation, clientData("webauthn.create", issueChallenge("register", userId)), SECURITY.rpId, SECURITY.origins, userId);
  let count = 0;
  /** A user-verified assertion over `challenge`. */
  const sign = async (challenge: string) => {
    count += 1;
    const cd = clientData("webauthn.get", challenge);
    const ad = authData(0x05, count);
    const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([ad, sha256(Buffer.from(cd, "base64url"))])));
    return { credentialId: reg.credentialId, authenticatorData: b64url(ad), clientDataJSON: cd, signature: b64url(derOf(raw)) };
  };
  return {
    stored: { credentialId: reg.credentialId, publicKey: reg.key, signCount: 0, rpId: SECURITY.rpId, createdAt: new Date().toISOString() },
    sign,
    /** The generic step-up for `action`, as /api/webauthn/challenge issues it. */
    stepUp: (action: string) => sign(issueChallenge("step_up", stepUpBinding(userId, action))),
  };
}
const keys = new Map<string, Awaited<ReturnType<typeof makePasskey>>>();

const planAddress = smartAccountForPasskey(PK).accountAddress as Hex;
const makeUser = async (id: string, over: any = {}) => {
  const key = await makePasskey(id);
  keys.set(id, key);
  store.addUser({
    id,
    name: id,
    email: `${id}@example.test`,
    country: "DE",
    kycStatus: "pending",
    iban: "",
    address: planAddress,
    passkey: key.stored,
    passkeySafe: { address: planAddress, status: "planned", threshold: 1, passkeyPublicKey: webauthnOwnerToStore(PK), createdAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    ...over,
  } as any);
  return store.findUser(id)!;
};

const CREATED_AT = 1_790_000_000_000;
let chain = goodChain();
let deployed: unknown[] = [];
const app = express();
app.use(express.json());
app.use("/api", createSafeImportRouter({
  requireUserSession: () => true,
  reader: () => readerFor(chain),
  tokens: () => [EURE, USDC],
  now: () => CREATED_AT,
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
/** Prepare, then approve the import with the passkey over the challenge prepare names. */
const approveImport = async (id: string, address: Hex = SAFE) => {
  const p = await post(`/users/${id}/safe/import/prepare`, { address });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(p.body.approval?.challenge, "prepare names the approval once the verifier is an owner");
  return keys.get(id)!.sign(p.body.approval.challenge);
};

await check("prepare returns the verifier and both owner changes, and stores nothing", async () => {
  await makeUser("u1");
  chain = { ...goodChain(), owners: [EOA] };
  const before = JSON.stringify(store.findUser("u1"));
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verifier, VERIFIER);
  assert.equal(r.body.verifierDeployed, true);
  assert.equal(r.body.deployVerifier, null);
  assert.equal(r.body.approval, null, "no approval before the verifier is an owner: the owners will still change");
  const add = decodeFunctionData({ abi: safeAbi, data: r.body.ownerChange.add.data });
  assert.deepEqual(add.args, [VERIFIER, 1n]);
  assert.equal(decodeFunctionData({ abi: safeAbi, data: r.body.ownerChange.swap.data }).functionName, "swapOwner");
  assert.equal(JSON.stringify(store.findUser("u1")), before, "prepare must not touch the account");
});
// The script reads the chain over JSON-RPC: serve it the same canned chain.
const rpc = express();
rpc.use(express.json());
rpc.post("/", async (req, res) => {
  const { id, method, params } = req.body;
  const r = readerFor(chain);
  const result =
    method === "eth_chainId" ? "0x14a34" :
    method === "eth_getCode" ? await r.getCode(params[0]) :
    method === "eth_getStorageAt" ? await r.getStorageAt(params[0], params[1]) :
    method === "eth_getBalance" ? toHex(await r.getBalance(params[0])) :
    method === "eth_call" ? await r.call(params[0].to, params[0].data) : null;
  res.json({ jsonrpc: "2.0", id, result });
});
const rpcServer = await new Promise<import("node:http").Server>((r) => { const s = rpc.listen(0, "127.0.0.1", () => r(s)); });
const rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;
const outDir = mkdtempSync(path.join(tmpdir(), "safe-import-tx-"));
const scriptFile = async (extra: string[]) => {
  const out = path.join(outDir, `${extra.join("_").replace(/[^a-z0-9]/gi, "")}.json`);
  await promisify(execFile)(process.execPath, [
    path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "scripts/safe-import-owner-tx.ts",
    "--chain", "84532", "--safe", SAFE, "--rpc", rpcUrl, "--out", out, "--created-at", String(CREATED_AT), ...extra,
  ], { cwd: ROOT });
  return readFileSync(out, "utf8");
};

await check("the downloaded Transaction Builder file is the script's, byte for byte", async () => {
  chain = { ...goodChain(), owners: [EOA] };
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const mode of ["add", "swap"] as const) {
    const file = r.body.ownerChange[mode].txBuilder;
    assert.equal(file.fileName, `safe-import-${SAFE}-84532.json`);
    assert.equal(file.json, await scriptFile(["--verifier", VERIFIER, "--mode", mode]), `${mode}: route and script differ`);
    const batch = JSON.parse(file.json);
    assert.equal(batch.transactions.length, 1);
    assert.equal(batch.transactions[0].data, r.body.ownerChange[mode].data);
    assert.match(batch.meta.checksum, /^0x[0-9a-f]{64}$/);
  }
});
await check("with no verifier on chain yet, both files deploy it first", async () => {
  chain = { ...goodChain(), owners: [EOA], code: { [SAFE.toLowerCase()]: "0x6080" } };
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.body.verifierDeployed, false);
  const file = r.body.ownerChange.add.txBuilder.json;
  assert.equal(file, await scriptFile(["--x", toHex(PK.x), "--y", toHex(PK.y), "--mode", "add"]));
  const batch = JSON.parse(file);
  assert.deepEqual(batch.transactions.map((t: any) => t.to), [r.body.deployVerifier.to, SAFE]);
});
await check("a refused mode carries no file", async () => {
  chain = { ...goodChain(), owners: [EOA, OTHER] };
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.ok(r.body.ownerChange.add.refused);
  assert.equal(r.body.ownerChange.add.txBuilder, undefined);
  assert.ok(r.body.ownerChange.swap.refused, "swap with two owners needs --replace; the route refuses it");
});
rpcServer.close();
await check("safeImport capability: on with a real chain, off under the harness, where the routes say NO_CHAIN", async () => {
  const { capabilities } = await import("../services/api/src/capabilities.js");
  const { HARNESS } = await import("../services/api/src/config.js");
  assert.equal(capabilities().safeImport, true);
  HARNESS.enabled = true;
  try {
    assert.equal(capabilities().safeImport, false);
    chain = { ...goodChain(), owners: [EOA] };
    assert.equal((await post("/users/u1/safe/import/prepare", { address: SAFE })).body.code, "NO_CHAIN");
  } finally {
    HARNESS.enabled = false;
  }
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
  const unapproved = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.deepEqual([unapproved.status, unapproved.body.code], [401, "STEP_UP_REQUIRED"]);
  assert.equal(deployed.length, 0, "nothing is relayed before the passkey approves");
  const stepUp = await approveImport("u1");
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp });
  assert.deepEqual([r.status, r.body.code], [409, "VERIFIER_NO_CODE"]);
  assert.equal(deployed.length, 1);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
  // The approval was spent on that attempt: sending it again is refused.
  chain = goodChain();
  const replay = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp });
  assert.deepEqual([replay.status, replay.body.code], [401, "STEP_UP_INVALID"]);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("funds at the planned address refuse the import", async () => {
  chain = { ...goodChain(), eth: { [planAddress.toLowerCase()]: 1n } };
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "PLAN_HAS_FUNDS");
  for (const token of [EURE, USDC]) {
    chain = { ...goodChain(), tokens: { [`${token}:${planAddress}`.toLowerCase()]: 1n } };
    assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "PLAN_HAS_FUNDS");
  }
});
await check("a new account's zero address is not read as its funds", async () => {
  store.updateUser("u1", { address: ZERO as Hex });
  chain = { ...goodChain(), eth: { [ZERO]: 10n ** 21n } };
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  store.updateUser("u1", { address: planAddress });
});
await check("a deployed own Safe is never replaced", async () => {
  chain = goodChain();
  chain.code[planAddress.toLowerCase()] = "0x6080";
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE })).body.code, "SAFE_DEPLOYED");
});
await check("prepare names the Safe's other owner with the approval", async () => {
  chain = goodChain();
  const r = await post("/users/u1/safe/import/prepare", { address: SAFE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.otherOwners, [EOA]);
  assert.match(r.body.approval.challenge, /^[A-Za-z0-9_-]{43}$/);
});
await check("confirm with no passkey approval binds nothing", async () => {
  chain = goodChain();
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE });
  assert.deepEqual([r.status, r.body.code], [401, "STEP_UP_REQUIRED"]);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
  assert.equal(store.findUser("u1")!.address, planAddress);
});
await check("an approval for another action is refused", async () => {
  chain = goodChain();
  for (const action of ["authorizer.bind", "safe.import"]) {
    const r = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp: await keys.get("u1")!.stepUp(action) });
    assert.deepEqual([r.status, r.body.code], [401, "STEP_UP_INVALID"], action);
  }
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("an approval for Safe A cannot bind Safe B", async () => {
  chain = goodChain();
  chain.code[SAFE_B.toLowerCase()] = "0x6080";
  const stepUp = await approveImport("u1", SAFE);
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE_B, stepUp });
  assert.deepEqual([r.status, r.body.code], [401, "STEP_UP_INVALID"]);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("owners changed between prepare and confirm: refused", async () => {
  chain = goodChain();
  const stepUp = await approveImport("u1");
  chain = { ...goodChain(), owners: [VERIFIER, OTHER] };
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp });
  assert.deepEqual([r.status, r.body.code], [401, "STEP_UP_INVALID"]);
  chain = goodChain();
  const t = await approveImport("u1");
  chain = { ...goodChain(), threshold: 1n, owners: [VERIFIER] };
  assert.equal((await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp: t })).body.code, "STEP_UP_INVALID", "a removed owner is a change too");
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("owners changed after the approval is checked: refused", async () => {
  chain = goodChain();
  const stepUp = await approveImport("u1");
  chain = { ...goodChain(), ownersLater: [VERIFIER, OTHER] };
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp });
  assert.deepEqual([r.status, r.body.code], [409, "SAFE_CHANGED"]);
  assert.equal(store.findUser("u1")!.passkeySafe!.status, "planned");
});
await check("confirm binds a good Safe as imported, never as recovered", async () => {
  chain = goodChain();
  const stepUp = await approveImport("u1");
  const r = await post("/users/u1/safe/import/confirm", { address: SAFE, stepUp });
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
  await makeUser("u2");
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
