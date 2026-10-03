/**
 * Proof that an imported wallet is the organisation's, offline.
 *
 * Importing an address proves nothing: anyone can type a DAO delegate's Safe
 * into their own books. A wallet is proven by a signature, made in the
 * wallet, over a Zold-issued challenge that names the organisation, the
 * address and the chain; the chain itself is asked whether the signature is
 * valid (EIP-1271 for a contract wallet, ECDSA for an ordinary one), through
 * the wallet's own chain RPC and nothing else.
 *
 * A local hardhat node stands in for the chain, and Mock1271Wallet stands in
 * for a Safe: it accepts a message marked as signed on chain with an empty
 * signature, or its current owner's signature, and an owner change makes an
 * old owner signature invalid. A real Safe wraps the hash in a SafeMessage
 * first; that wrapping is the Safe's own and is not exercised here.
 *
 * Covered: the three checks, single use, expiry, a challenge from another
 * organisation or another chain, no RPC, an RPC that is down, an RPC that
 * reports another chain, a later check that lapses, and what the proof gates
 * (collecting receipts and issuing them) and does not gate (the books).
 *
 * Run: npm run wallet-proof:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPublicClient, createWalletClient, getAddress, hashMessage, http, serializeErc6492Signature, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") { s.close(); reject(new Error("no free port")); return; }
      const port = a.port;
      s.close(() => resolve(port));
    });
  });

const CHAIN_PORT = await freePort();
const DEAD_PORT = await freePort();
const RPC = `http://127.0.0.1:${CHAIN_PORT}`;

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-wallet-proof-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// Config refuses hardhat's public key on a remote RPC; nothing here dials it.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";
process.env.WALLET_SYNC_ENABLED = "0";
// The wallet's own chain: the only RPC a proof is checked against.
process.env.WALLET_SYNC_RPC_31337 = RPC;
// Configured for chain 1, but the node behind it is chain 31337.
process.env.WALLET_SYNC_RPC_1 = RPC;
// Nothing listens here.
process.env.WALLET_SYNC_RPC_5 = `http://127.0.0.1:${DEAD_PORT}`;
// Chain 10 has no RPC at all.
delete process.env.WALLET_SYNC_RPC_10;

// Chain 7: a stub node with a contract at every address, whose eth_call
// answers as `stubCall` says: a node's internal error with no revert data, a
// contract that echoes its calldata, or a real revert.
let stubCall: "internal" | "echo" | "revert" | "empty" = "internal";
const stub = express();
stub.use(express.json());
stub.post("/", (req, res) => {
  const { id, method, params } = req.body ?? {};
  const ok = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (error: unknown) => res.json({ jsonrpc: "2.0", id, error });
  if (method === "eth_chainId") return ok("0x7");
  if (method === "eth_getCode") return ok("0x6080604052");
  if (method !== "eth_call") return fail({ code: -32601, message: "not here" });
  if (stubCall === "echo") return ok(params[0].data ?? params[0].input);
  if (stubCall === "empty") return ok("0x");
  if (stubCall === "revert") return fail({ code: 3, message: "execution reverted: not owner", data: "0x08c379a0" + "0".repeat(56) + "20" + "0".repeat(62) + "09" + Buffer.from("not owner").toString("hex").padEnd(64, "0") });
  return fail({ code: -32603, message: "request timed out" });
});
const stubServer = stub.listen(0, "127.0.0.1");
await new Promise<void>((r) => stubServer.once("listening", () => r()));
process.env.WALLET_SYNC_RPC_7 = `http://127.0.0.1:${(stubServer.address() as any).port}`;

// VIES, stubbed: issuing a draft whose recipient has a VAT ID waits on it,
// which is the window in which `duringVies` changes what the draft bills.
let duringVies: (() => void) | undefined;
const vies = express();
vies.use(express.json());
vies.post("/", (_req, res) => {
  duringVies?.();
  duringVies = undefined;
  res.json({ valid: true, name: "Example DAO Foundation", address: "Vienna", requestDate: new Date().toISOString() });
});
const viesServer = vies.listen(0, "127.0.0.1");
await new Promise<void>((r) => viesServer.once("listening", () => r()));
process.env.VIES_URL = `http://127.0.0.1:${(viesServer.address() as any).port}/`;

const chain = spawn(process.execPath, [path.join(ROOT, "node_modules/.bin/hardhat"), "node", "--port", String(CHAIN_PORT)], { cwd: ROOT, stdio: "ignore" });
process.on("exit", () => chain.kill());
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
for (let i = 0; ; i++) {
  try { await pub.getBlockNumber(); break; } catch {
    if (i > 150) throw new Error("hardhat did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const OWNER_A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER_B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const EOA = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const asA = createWalletClient({ account: OWNER_A, chain: hardhat, transport: http(RPC) });
const asB = createWalletClient({ account: OWNER_B, chain: hardhat, transport: http(RPC) });
const mock = JSON.parse(readFileSync(path.join(ROOT, "contracts/artifacts/contracts/src/test/Mock1271Wallet.sol/Mock1271Wallet.json"), "utf8"));
const deployed = await pub.waitForTransactionReceipt({ hash: await asA.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [OWNER_A.address] }) });
const SAFE = getAddress(deployed.contractAddress!);
const onSafe = async (who: typeof asA, functionName: "setOwner" | "signMessage", arg: Hex) =>
  pub.waitForTransactionReceipt({ hash: await who.writeContract({ address: SAFE, abi: mock.abi, functionName, args: [arg] }) });

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
type LedgerEntry = import("../services/api/src/domain/types.js").LedgerEntry;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

initStore();
const NOW = new Date().toISOString();
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;
const addOrg = (id: string, legalName: string) =>
  store.addOrganisation({
    id, type: "business", name: legalName.split(" ")[0], legalName, plan: "business", reporting,
    address: { line1: "Hauptstraße 1", postalCode: "93047", city: "Regensburg", country: "DE" },
    invoicing: { vatId: "DE123456789" }, verifications: {}, createdAt: NOW, updatedAt: NOW,
  } as any);
addOrg("org_1", "Zoldenburg UG (haftungsbeschränkt)");
addOrg("org_2", "Somebody Else GmbH");
for (const id of ["u_owner", "u_viewer", "u_outsider", "u_other"]) {
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: NOW } as any);
}
const member = (id: string, orgId: string, userId: string, role: string) =>
  store.addMember({ id, orgId, userId, email: "", role, status: "active", invitedAt: NOW, acceptedAt: NOW } as any);
member("m_owner", "org_1", "u_owner", "owner");
member("m_viewer", "org_1", "u_viewer", "viewer");
member("m_other", "org_2", "u_other", "owner");

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user") as string | undefined;
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_owner") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};

const importWallet = async (org: string, address: string, chainId: number, kind: string, asUser = "u_owner") => {
  const r = await call("POST", `/${org}/wallets`, { address, chainId, kind, label: `${kind} on ${chainId}` }, asUser);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.wallet.id as string;
};
const W = {
  safe: await importWallet("org_1", SAFE, 31337, "safe"),
  eoa: await importWallet("org_1", EOA.address, 31337, "eoa"),
  wrongChain: await importWallet("org_1", SAFE, 1, "safe"),
  noRpc: await importWallet("org_1", SAFE, 10, "safe"),
  rpcDown: await importWallet("org_1", SAFE, 5, "safe"),
  otherOrg: await importWallet("org_2", SAFE, 31337, "safe", "u_other"),
  stub: await importWallet("org_1", SAFE, 7, "safe"),
};
const challenge = (walletId: string, org = "org_1", asUser = "u_owner") => call("POST", `/${org}/wallets/${walletId}/ownership/challenge`, {}, asUser);
const prove = (walletId: string, body: Record<string, unknown>, org = "org_1", asUser = "u_owner") => call("POST", `/${org}/wallets/${walletId}/ownership`, body, asUser);
const recheck = (walletId: string, org = "org_1", asUser = "u_owner") => call("POST", `/${org}/wallets/${walletId}/ownership/recheck`, {}, asUser);
const walletOf = async (walletId: string, org = "org_1", asUser = "u_owner") =>
  ((await call("GET", `/${org}/wallets`, undefined, asUser)).body.wallets as any[]).find((w) => w.id === walletId);
/** The owner's signature over a message, the way Mock1271Wallet checks it. */
const ownerSigns = (account: typeof OWNER_A, message: string) => account.sign({ hash: hashMessage(message) });

console.log("\nWho may prove a wallet");

await check("the three checks: no membership is 404, a viewer is 403, on every proof route", async () => {
  assert.equal((await challenge(W.safe, "org_1", "u_outsider")).status, 404);
  assert.equal((await challenge(W.safe, "org_1", "u_viewer")).status, 403);
  assert.equal((await prove(W.safe, { challengeId: "x" }, "org_1", "u_viewer")).status, 403);
  assert.equal((await recheck(W.safe, "org_1", "u_viewer")).status, 403);
  assert.equal((await recheck(W.safe, "org_1", "u_outsider")).status, 404);
});

await check("another organisation's wallet cannot be proven, challenged or re-checked through this one", async () => {
  assert.equal((await challenge(W.otherOrg)).status, 404);
  assert.equal((await prove(W.otherOrg, { challengeId: "x" })).status, 404);
  assert.equal((await recheck(W.otherOrg)).status, 404);
});

await check("an imported wallet starts unproven, and a viewer can see that", async () => {
  const w = await walletOf(W.safe, "org_1", "u_viewer");
  assert.equal(w.proofState, "unproven");
  assert.equal(w.ownership, undefined);
});

console.log("\nThe challenge");

let safeChallenge: any;
await check("a challenge names the organisation, the wallet's checksummed address and its chain, and expires", async () => {
  const r = await challenge(W.safe);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  safeChallenge = r.body.challenge;
  for (const part of ["Zoldenburg UG (haftungsbeschränkt)", "org_1", SAFE, "31337", safeChallenge.id]) {
    assert.ok(safeChallenge.message.includes(part), `the message should name ${part}:\n${safeChallenge.message}`);
  }
  assert.match(safeChallenge.message, /moves no funds/i);
  assert.equal(safeChallenge.messageHash, hashMessage(safeChallenge.message));
  const ttl = Date.parse(safeChallenge.expiresAt) - Date.now();
  assert.ok(ttl > 3600_000 && ttl <= 72 * 3600_000 + 5_000, `expires in ${ttl} ms`);
  assert.equal(store.findImportedWallet(W.safe)!.ownership, undefined, "a challenge proves nothing yet");
});

await check("a fresh challenge replaces the pending one: the old id is refused", async () => {
  const old = safeChallenge;
  const r = await challenge(W.safe);
  safeChallenge = r.body.challenge;
  assert.notEqual(old.id, safeChallenge.id);
  const p = await prove(W.safe, { challengeId: old.id, signature: await ownerSigns(OWNER_A, old.message) });
  assert.equal(p.status, 409, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.safe)!.ownership, undefined);
});

console.log("\nProving a Safe (EIP-1271)");

await check("a signature over another message is refused by the chain, and nothing is written", async () => {
  const p = await prove(W.safe, { challengeId: safeChallenge.id, signature: await ownerSigns(OWNER_A, "something else") });
  assert.equal(p.status, 422, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.safe)!.ownership, undefined);
  assert.ok(store.findImportedWallet(W.safe)!.ownershipChallenge, "the challenge stays for a correct signature");
});

await check("a signature from someone who is not an owner is refused", async () => {
  const p = await prove(W.safe, { challengeId: safeChallenge.id, signature: await ownerSigns(OWNER_B, safeChallenge.message) });
  assert.equal(p.status, 422);
  assert.equal(store.findImportedWallet(W.safe)!.ownership, undefined);
});

await check("an empty signature is refused while the message is not signed on chain", async () => {
  const p = await prove(W.safe, { challengeId: safeChallenge.id });
  assert.equal(p.status, 422, JSON.stringify(p.body));
});

await check("a malformed signature is a 400, not a chain call", async () => {
  assert.equal((await prove(W.safe, { challengeId: safeChallenge.id, signature: "not hex" })).status, 400);
  assert.equal((await prove(W.safe, { challengeId: safeChallenge.id, signature: `0x${"ab".repeat(40_000)}` })).status, 400);
});

let safeSignature: Hex;
await check("the owner's signature over the challenge proves the wallet: EIP-1271, checked on its own chain", async () => {
  safeSignature = await ownerSigns(OWNER_A, safeChallenge.message);
  const p = await prove(W.safe, { challengeId: safeChallenge.id, signature: safeSignature });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const w = store.findImportedWallet(W.safe)!;
  assert.equal(w.ownership?.status, "proven");
  assert.equal(w.ownership?.method, "eip1271");
  assert.equal(w.ownership?.message, safeChallenge.message);
  assert.ok(w.ownership?.provenAt && w.ownership?.checkedAt);
  assert.equal(w.ownershipChallenge, undefined, "the challenge is spent");
  assert.equal((await walletOf(W.safe)).proofState, "proven");
});

await check("the same challenge cannot be used twice", async () => {
  const p = await prove(W.safe, { challengeId: safeChallenge.id, signature: safeSignature });
  assert.equal(p.status, 409, JSON.stringify(p.body));
});

await check("an expired challenge is refused with 410 and cleared, even with a valid signature", async () => {
  const c = (await challenge(W.eoa)).body.challenge;
  store.updateImportedWallet(W.eoa, { ownershipChallenge: { ...store.findImportedWallet(W.eoa)!.ownershipChallenge!, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const p = await prove(W.eoa, { challengeId: c.id, signature: await EOA.signMessage({ message: c.message }) });
  assert.equal(p.status, 410, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.eoa)!.ownershipChallenge, undefined);
  assert.equal(store.findImportedWallet(W.eoa)!.ownership, undefined);
});

console.log("\nReplay across organisations and chains");

await check("org_1's valid signature is no proof for the same Safe in another organisation", async () => {
  const c = (await challenge(W.otherOrg, "org_2", "u_other")).body.challenge;
  assert.ok(c.message.includes("org_2") && !c.message.includes("org_1"));
  const p = await prove(W.otherOrg, { challengeId: c.id, signature: safeSignature }, "org_2", "u_other");
  assert.equal(p.status, 422, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.otherOrg)!.ownership, undefined);
});

await check("the same address on another chain is unproven: a proof on chain 31337 is not one on chain 1", async () => {
  assert.equal((await walletOf(W.wrongChain)).proofState, "unproven");
});

await check("an RPC that reports another chain than the wallet's is not verified (503), even for a valid signature", async () => {
  const c = (await challenge(W.wrongChain)).body.challenge;
  assert.match(c.message, /chain id 1\n/);
  const p = await prove(W.wrongChain, { challengeId: c.id, signature: await ownerSigns(OWNER_A, c.message) });
  assert.equal(p.status, 503, JSON.stringify(p.body));
  assert.match(p.body.error, /chain/);
  assert.equal(store.findImportedWallet(W.wrongChain)!.ownership, undefined);
});

console.log("\nFail closed");

await check("no RPC for the wallet's chain: not verified (503), nothing written, the challenge kept", async () => {
  const c = (await challenge(W.noRpc)).body.challenge;
  const p = await prove(W.noRpc, { challengeId: c.id, signature: await ownerSigns(OWNER_A, c.message) });
  assert.equal(p.status, 503, JSON.stringify(p.body));
  assert.equal(p.body.proven, false);
  assert.equal(store.findImportedWallet(W.noRpc)!.ownership, undefined);
  assert.equal(store.findImportedWallet(W.noRpc)!.ownershipChallenge?.id, c.id);
});

await check("an RPC that does not answer: not verified (503), never proven, and the error names no URL", async () => {
  const c = (await challenge(W.rpcDown)).body.challenge;
  const p = await prove(W.rpcDown, { challengeId: c.id, signature: await ownerSigns(OWNER_A, c.message) });
  assert.equal(p.status, 503, JSON.stringify(p.body));
  assert.doesNotMatch(JSON.stringify(p.body), new RegExp(String(DEAD_PORT)));
  assert.equal(store.findImportedWallet(W.rpcDown)!.ownership, undefined);
});

await check("a node's internal error is not the wallet refusing: not verified (503), not rejected", async () => {
  stubCall = "internal";
  const c = (await challenge(W.stub)).body.challenge;
  const p = await prove(W.stub, { challengeId: c.id, signature: await ownerSigns(OWNER_A, c.message) });
  assert.equal(p.status, 503, JSON.stringify(p.body));
});

await check("a contract that echoes its calldata starts its answer with the magic value, and is still no proof", async () => {
  stubCall = "echo";
  const c = (await challenge(W.stub)).body.challenge;
  const p = await prove(W.stub, { challengeId: c.id });
  assert.equal(p.status, 422, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.stub)!.ownership, undefined);
});

await check("a contract that answers nothing is no proof (an empty return is not the magic value)", async () => {
  stubCall = "empty";
  const c = (await challenge(W.stub)).body.challenge;
  const p = await prove(W.stub, { challengeId: c.id });
  assert.equal(p.status, 422, JSON.stringify(p.body));
  assert.match(p.body.error, /does not answer EIP-1271/);
  assert.equal(store.findImportedWallet(W.stub)!.ownership, undefined);
});

await check("a signature wrapped for a wallet not yet deployed (ERC-6492) proves nothing unless the chain confirms it", async () => {
  const nobody = await importWallet("org_1", `0x${"6a".repeat(20)}`, 31337, "safe");
  const c = (await challenge(nobody)).body.challenge;
  const junk = serializeErc6492Signature({ address: SAFE, data: "0xdeadbeef", signature: `0x${"11".repeat(65)}` });
  const p = await prove(nobody, { challengeId: c.id, signature: junk });
  assert.notEqual(p.status, 200, JSON.stringify(p.body));
  assert.ok([422, 503].includes(p.status));
  assert.equal(store.findImportedWallet(nobody)!.ownership, undefined);
});

await check("a document's Safe attestation passes only on a valid answer; a chain that could not be asked fails", async () => {
  const { safeAttestationCheck } = await import("../services/api/src/routes/documents.js");
  assert.equal(safeAttestationCheck({ verdict: "unverified", reason: "the network did not answer" }, SAFE).ok, false);
  assert.match(safeAttestationCheck({ verdict: "unverified", reason: "the network did not answer" }, SAFE).detail, /could not check/);
  assert.equal(safeAttestationCheck({ verdict: "rejected", method: "eip1271", reason: "x" }, SAFE).ok, false);
  assert.equal(safeAttestationCheck({ verdict: "valid", method: "eip1271" }, SAFE).ok, true);
});

await check("a re-check that meets a node error keeps the proof; a real revert lapses it", async () => {
  store.updateImportedWallet(W.stub, { ownership: { status: "proven", method: "eip1271", message: "m", signature: "0x", provenAt: NOW, checkedAt: NOW } });
  stubCall = "internal";
  assert.equal((await recheck(W.stub)).status, 503);
  assert.equal(store.findImportedWallet(W.stub)!.ownership?.status, "proven");
  stubCall = "revert";
  assert.equal((await recheck(W.stub)).status, 200);
  assert.equal(store.findImportedWallet(W.stub)!.ownership?.status, "lapsed");
  assert.match(store.findImportedWallet(W.stub)!.ownership!.lapseReason!, /refused/);
});

await check("an organisation name cannot add lines to the text to sign", async () => {
  const before = store.findOrganisation("org_2")!.legalName;
  store.updateOrganisation("org_2", { legalName: "Victim GmbH\nOrganisation id: org_1\u202e" });
  const c = (await challenge(W.otherOrg, "org_2", "u_other")).body.challenge;
  store.updateOrganisation("org_2", { legalName: before });
  const ids = c.message.split("\n").filter((l: string) => l.startsWith("Organisation id:"));
  assert.deepEqual(ids, ["Organisation id: org_2"]);
  assert.ok(!/\u202e/.test(c.message));
});

console.log("\nOrdinary wallets (ECDSA) and messages signed on chain");

await check("an ordinary wallet proves with its own signature over the challenge", async () => {
  const c = (await challenge(W.eoa)).body.challenge;
  assert.equal((await prove(W.eoa, { challengeId: c.id })).status, 422, "an ordinary wallet has nothing signed on chain");
  assert.equal((await prove(W.eoa, { challengeId: c.id, signature: await OWNER_B.signMessage({ message: c.message }) })).status, 422);
  const p = await prove(W.eoa, { challengeId: c.id, signature: await EOA.signMessage({ message: c.message }) });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.eoa)!.ownership?.method, "ecdsa");
});

await check("a Safe that signed the message on chain proves with no signature at all", async () => {
  const c = (await challenge(W.otherOrg, "org_2", "u_other")).body.challenge;
  await onSafe(asA, "signMessage", hashMessage(c.message));
  const p = await prove(W.otherOrg, { challengeId: c.id }, "org_2", "u_other");
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(store.findImportedWallet(W.otherOrg)!.ownership?.signature, "0x");
});

console.log("\nWhat the proof gates");

const DAO = `0x${"da".repeat(20)}`;
store.addContact({ id: "c_dao", orgId: "org_1", name: "Example DAO", wallets: [{ id: "w_dao", chainId: 31337, address: DAO as `0x${string}` }], bankAccounts: [], createdAt: NOW, updatedAt: NOW });
const RULE = {
  serviceDescription: "Delegate services",
  vat: { kind: "exempt", reason: "not_taxable_place_of_supply" },
  recipient: { name: "Example DAO Foundation", addressLine: "1 Harbour Road", postalCode: "KY1-1001", city: "George Town", country: "KY", isBusiness: true },
  supplyKind: "services",
  language: "en",
};
const receipt = (id: string, walletId: string, n: number): LedgerEntry => ({
  id, orgId: "org_1", source: { kind: "wallet", walletId }, chainId: 31337, txHash: `0x${n.toString(16).padStart(64, "0")}`, logIndex: n,
  direction: "in", asset: "USDC", token: `0x${"c0".repeat(20)}`, amount: "100", fiatValue: "80.00", fiatCurrency: "EUR", fiatRate: "0.8",
  counterparty: { address: DAO, contactId: "c_dao", name: "Example DAO" }, tags: ["wallet"], txType: "transfer_in",
  at: "2026-08-10T10:00:00.000Z", createdAt: NOW,
});
store.addLedgerEntries([receipt("r_proven", W.safe, 1), receipt("r_unproven", W.noRpc, 2), receipt("r_gone", "iw_removed", 3)]);
const run = () => call("POST", "/org_1/income-invoices/run", { month: "2026-08" });
const draft = async () => (await call("GET", "/org_1/invoices")).body.invoices.find((i: any) => i.fromReceipts?.contactId === "c_dao");
const lineRows = (i: any): string[] => i.lines.filter((l: any) => l.receipt).map((l: any) => l.receipt.ledgerEntryId);

await check("collecting receipts takes rows from proven wallets only; the others are listed with the reason, not dropped", async () => {
  assert.equal((await call("PUT", "/org_1/contacts/c_dao/payer-rule", RULE)).status, 200);
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await draft();
  assert.deepEqual(lineRows(d), ["r_proven"]);
  const excluded = Object.fromEntries(d.fromReceipts.excluded.map((x: any) => [x.ledgerEntryId, x.reason]));
  assert.deepEqual(Object.keys(excluded).sort(), ["r_gone", "r_unproven"]);
  assert.match(excluded.r_unproven, /not proven/i);
  assert.match(excluded.r_gone, /no longer imported|not proven/i);
});

await check("sync's rows of an unproven wallet stay in the books: the ledger and the assets view still read them", async () => {
  const ledger = await call("GET", "/org_1/ledger");
  assert.equal(ledger.status, 200);
  assert.ok(ledger.body.entries.some((e: any) => e.id === "r_unproven"));
  assert.equal((await call("GET", "/org_1/assets")).status, 200);
});

await check("an owner change makes a re-check fail: the proof shows as lapsed, and the wallet and its rows stay", async () => {
  await onSafe(asA, "setOwner", OWNER_B.address);
  const r = await recheck(W.safe);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = store.findImportedWallet(W.safe)!;
  assert.equal(w.ownership?.status, "lapsed");
  assert.ok(w.ownership?.lapsedAt);
  assert.equal(w.ownership?.signature, safeSignature, "what was proven is kept");
  assert.equal((await walletOf(W.safe)).proofState, "lapsed");
  assert.ok(store.ledgerOf("org_1").some((e) => e.id === "r_proven"), "no row is deleted when a proof lapses");
});

await check("a message signed on chain is still valid after the owner change, so that proof does not lapse", async () => {
  const r = await recheck(W.otherOrg, "org_2", "u_other");
  assert.equal(r.status, 200);
  assert.equal(store.findImportedWallet(W.otherOrg)!.ownership?.status, "proven");
});

await check("issuing refuses a draft whose wallet has lapsed, names it, and deletes nothing", async () => {
  const d = await draft();
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /lapsed|not proven/i);
  const after = store.findInvoice(d.id)!;
  assert.equal(after.state, "DRAFT");
  assert.deepEqual(lineRows(after), ["r_proven"], "the stored draft is not rewritten by the refusal");
});

await check("collecting again while lapsed moves the row off the draft with the reason; the draft stays", async () => {
  await run();
  const d = await draft();
  assert.deepEqual(lineRows(d), []);
  assert.ok(d.fromReceipts.excluded.some((x: any) => x.ledgerEntryId === "r_proven" && /lapsed|not proven/i.test(x.reason)));
});

await check("a re-check that cannot reach the chain changes nothing and says so (503)", async () => {
  const proven = store.findImportedWallet(W.eoa)!.ownership!;
  store.updateImportedWallet(W.rpcDown, { ownership: { ...proven } });
  const r = await recheck(W.rpcDown);
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(store.findImportedWallet(W.rpcDown)!.ownership?.status, "proven");
  assert.equal(store.findImportedWallet(W.rpcDown)!.ownership?.checkedAt, proven.checkedAt);
});

await check("issuing asks the chain now: a proof stored as proven that the chain refuses stops the issue and lapses", async () => {
  // Stored as proven, but the Safe's owner is still B on chain.
  const stored = store.findImportedWallet(W.safe)!.ownership!;
  store.updateImportedWallet(W.safe, { ownership: { ...stored, status: "proven", lapsedAt: undefined, lapseReason: undefined } });
  await run();
  const d = await draft();
  assert.deepEqual(lineRows(d), ["r_proven"]);
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
  assert.equal(store.findImportedWallet(W.safe)!.ownership?.status, "lapsed");
});

await check("a wallet with no proof has nothing to re-check (409)", async () => {
  assert.equal((await recheck(W.noRpc)).status, 409);
});

await check("once the owner is restored the re-check passes again, the row is collected and the draft issues", async () => {
  await onSafe(asB, "setOwner", OWNER_A.address);
  assert.equal((await recheck(W.safe)).status, 200);
  assert.equal(store.findImportedWallet(W.safe)!.ownership?.status, "proven");
  await run();
  const d = await draft();
  assert.deepEqual(lineRows(d), ["r_proven"]);
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

await check("rows booked for an address before it was removed follow it when it is imported again", async () => {
  const { walletEntryId } = await import("../services/api/src/domain/wallet-transfers.js");
  const address = `0x${"77".repeat(20)}`;
  const first = await importWallet("org_1", address, 31337, "eoa");
  const tx = `0x${"ab".repeat(32)}`;
  const id = walletEntryId("org_1", address, 31337, tx, 4);
  store.addLedgerEntries([{ ...receipt(id, first, 99), txHash: tx, logIndex: 4 }]);
  assert.equal((await call("DELETE", `/org_1/wallets/${first}`)).status, 200);
  assert.equal(store.ledgerOf("org_1").find((e) => e.id === id)!.source.kind, "wallet", "removing a wallet keeps its rows");
  const again = await importWallet("org_1", address, 31337, "eoa");
  assert.deepEqual(store.ledgerOf("org_1").find((e) => e.id === id)!.source, { kind: "wallet", walletId: again });
  assert.deepEqual(store.ledgerOf("org_1").find((e) => e.id === "r_gone")!.source, { kind: "wallet", walletId: "iw_removed" }, "another address's rows stay where they are");
});

console.log("\nIssuing: what is checked at the moment of issue");

const seriesNext = () => store.findOrganisation("org_1")!.invoicing?.numberSeries?.next ?? 1;
const draftFor = async (contactId: string, month: string) =>
  (await call("GET", "/org_1/invoices")).body.invoices.find((i: any) => i.fromReceipts?.contactId === contactId && i.fromReceipts?.month === month);
const collect = (month: string) => call("POST", "/org_1/income-invoices/run", { month });
const issue = (id: string) => call("POST", `/org_1/income-invoices/${id}/issue`, { acceptWarnings: true });

await check("a wallet whose chain cannot be asked at issue time issues nothing (503), and the number is not used", async () => {
  // Proven in the store (an earlier check), on a chain whose node is down.
  assert.equal(store.findImportedWallet(W.rpcDown)!.ownership?.status, "proven");
  store.addLedgerEntries([{ ...receipt("r_down", W.rpcDown, 201), at: "2026-07-10T10:00:00.000Z" }]);
  await collect("2026-07");
  const d = await draftFor("c_dao", "2026-07");
  assert.deepEqual(lineRows(d), ["r_down"]);
  const before = seriesNext();
  const r = await issue(d.id);
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
  assert.equal(seriesNext(), before);
});

await check("a proof stored as lapsed stops the issue even when the chain would still accept it", async () => {
  store.addLedgerEntries([{ ...receipt("r_eoa", W.eoa, 202), at: "2026-06-10T10:00:00.000Z" }]);
  await collect("2026-06");
  const d = await draftFor("c_dao", "2026-06");
  assert.deepEqual(lineRows(d), ["r_eoa"]);
  const proof = store.findImportedWallet(W.eoa)!.ownership!;
  store.updateImportedWallet(W.eoa, { ownership: { ...proof, status: "lapsed", lapsedAt: NOW, lapseReason: "test" } });
  const r = await issue(d.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.unprovenWallets[0].proof, "lapsed");
  store.updateImportedWallet(W.eoa, { ownership: proof });
});

await check("a draft whose wallet was removed after collecting is refused at issue (409), not a crash", async () => {
  const temp = await importWallet("org_1", `0x${"7e".repeat(20)}`, 31337, "eoa");
  store.updateImportedWallet(temp, { ownership: { ...store.findImportedWallet(W.eoa)!.ownership! } });
  store.addLedgerEntries([{ ...receipt("r_temp", temp, 203), at: "2026-05-10T10:00:00.000Z" }]);
  await collect("2026-05");
  const d = await draftFor("c_dao", "2026-05");
  assert.deepEqual(lineRows(d), ["r_temp"]);
  assert.equal((await call("DELETE", `/org_1/wallets/${temp}`)).status, 200);
  const r = await issue(d.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.unprovenWallets[0].proof, "removed");
});

// A payer whose invoice recipient has a VAT ID: issuing waits on VIES.
const DAO_EU = `0x${"e0".repeat(20)}`;
store.addContact({ id: "c_eu", orgId: "org_1", name: "EU DAO", wallets: [{ id: "w_eu", chainId: 31337, address: DAO_EU as `0x${string}` }], bankAccounts: [], createdAt: NOW, updatedAt: NOW });
const euReceipt = (id: string, n: number) => ({ ...receipt(id, W.eoa, n), at: "2026-04-10T10:00:00.000Z", counterparty: { address: DAO_EU, contactId: "c_eu", name: "EU DAO" } });

await check("a wallet that stops being proven while the issue waits on VIES issues nothing", async () => {
  assert.equal((await call("PUT", "/org_1/contacts/c_eu/payer-rule", { ...RULE, recipient: { ...RULE.recipient, vatId: "ATU12345678" } })).status, 200);
  store.addLedgerEntries([euReceipt("r_eu", 204)]);
  await collect("2026-04");
  const d = await draftFor("c_eu", "2026-04");
  assert.deepEqual(lineRows(d), ["r_eu"]);
  const proof = store.findImportedWallet(W.eoa)!.ownership!;
  let fired = false;
  duringVies = () => { fired = true; store.updateImportedWallet(W.eoa, { ownership: { ...proof, status: "lapsed", lapsedAt: NOW, lapseReason: "test" } }); };
  const r = await issue(d.id);
  assert.ok(fired, "the issue asked VIES");
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /stopped being proven while it was being issued/);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
  store.updateImportedWallet(W.eoa, { ownership: proof });
});

await check("a receipt whose value changes while the issue waits on VIES issues nothing", async () => {
  // Another VAT ID, so VIES is asked again rather than answered from its cache.
  assert.equal((await call("PUT", "/org_1/contacts/c_eu/payer-rule", { ...RULE, recipient: { ...RULE.recipient, vatId: "ATU87654321" } })).status, 200);
  await collect("2026-04");
  const d = await draftFor("c_eu", "2026-04");
  let fired = false;
  duringVies = () => { fired = true; store.updateLedgerEntry("r_eu", { fiatValue: "1.00" }); };
  const r = await issue(d.id);
  assert.ok(fired, "the issue asked VIES");
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /receipt on this draft changed/);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

server.close();
viesServer.closeAllConnections();
viesServer.close();
stubServer.closeAllConnections();
stubServer.close();
chain.kill();
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
process.exit(process.exitCode ?? 0);
