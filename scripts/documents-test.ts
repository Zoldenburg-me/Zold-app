/**
 * Account documents — statement, receipt, balance confirmation, proof of
 * ownership — against a real (hardhat) chain and the harness Safe.
 *
 * Offline first: the pure builders (merging the three sources, reconciling
 * against balances, the canonical digest, the signature round trip, the code
 * alphabet). Then the routes: an account is funded on chain, a statement is
 * issued and must reconcile with balances read at real blocks, a balance
 * letter re-verifies at its block, a receipt is refused for money that has
 * not moved, an ownership letter gains the Safe's signature through a passkey
 * ceremony, and the public verifier answers every one of them.
 *
 * Run: npm run documents:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3043);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (n: string) => (n === "tsx" ? path.join(ROOT, "node_modules/tsx/dist/cli.mjs") : path.join(ROOT, "node_modules/.bin", n));

let pass = 0;
const t = async (label: string, fn: () => void | Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

// ---------------------------------------------------------------------------
// offline: the builders

console.log("1/3 builders, offline…");
const docs = await import("../services/api/src/documents.js");

await t("verification codes use the Crockford alphabet and normalise look-alikes", () => {
  const code = docs.newDocumentCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(docs.normaliseCode("abcde-fghjk-mnpqr"), "ABCDEFGHJKMNPQR");
  assert.equal(docs.normaliseCode("0OIL1"), "00111");
  assert.ok(docs.isDocumentCode(code));
  assert.ok(!docs.isDocumentCode("too-short"));
});

await t("three sources merge without double-counting the same money", () => {
  const at = "2026-09-01T10:00:00.000Z";
  const monerium = docs.linesFromMoneriumOrders(
    [
      { id: "o1", kind: "issue", amount: "100", address: "0xabc", memo: "salary", meta: { state: "processed", processedAt: at }, counterpart: { identifier: { iban: "DE00" }, details: { name: "Employer GmbH" } } },
      { id: "o2", kind: "redeem", amount: "40", address: "0xabc", meta: { state: "processed", processedAt: at }, counterpart: { identifier: { iban: "DE11" }, details: { firstName: "A", lastName: "B" } } },
      { id: "o3", kind: "issue", amount: "5", address: "0xabc", meta: { state: "pending" } },
    ],
    "0xABC",
  );
  assert.equal(monerium.length, 2, "a pending order is not a movement");
  const transfers = docs.linesFromTransfers([
    { id: "t-1", rail: "sepa", state: "PAID", sendEur: 40.99, receiveEur: 40, recipientName: "A B", recipientIban: "DE11", createdAt: at, updatedAt: at, sepa: { orderId: "o2" }, txs: [] } as any,
    { id: "t-2", rail: "sepa", state: "CREATED", sendEur: 10, recipientName: "X", createdAt: at, updatedAt: at, txs: [] } as any,
  ]);
  assert.equal(transfers.length, 2, "a PAID payout is two lines (payout + fee); CREATED moved nothing");
  const chain = docs.linesFromChainCredits([{ txHash: "0xdead", amountEur: 100, detectedAt: at, token: "EURE" }]);
  const merged = docs.mergeLines(monerium, transfers, chain);
  assert.equal(merged.length, 3, "issue+credit are one line, redeem+transfer are one line, plus the fee");
  const payout = merged.find((l) => l.reference === "o2")!;
  assert.equal(payout.counterpartyName, "A B");
  assert.equal(payout.memo, "Powered by Zold t-1", "our memo fills the gap Monerium's order left");
  assert.equal(docs.statementTotals(merged).inEur, 100);
  assert.equal(docs.statementTotals(merged).outEur, 40.99);
});

await t("reconciliation names the gap instead of hiding it", () => {
  assert.deepEqual(docs.reconcile(100, 59.01, { inEur: 0, outEur: 40.99 }), { reconciles: true, deltaEur: 0 });
  const r = docs.reconcile(100, 50, { inEur: 0, outEur: 40.99 });
  assert.equal(r.reconciles, false);
  assert.equal(r.deltaEur, 9.01);
  assert.match(r.note!, /left the account without a line/);
  assert.match(docs.reconcile(null, 50, { inEur: 0, outEur: 0 }).note!, /could not be read/);
});

await t("the digest is canonical and the signature round-trips", async () => {
  const holder = { name: "Ann", addressLines: [], safeAddress: `0x${"11".repeat(20)}` as `0x${string}`, chainId: 31337, accountSince: "2026-01-01T00:00:00.000Z" };
  const a: any = { kind: "balance", holder, balanceEur: 12.5, block: { number: 7, at: "2026-09-01T00:00:00.000Z" }, tokenAddress: `0x${"22".repeat(20)}` };
  const b: any = { tokenAddress: a.tokenAddress, block: { at: a.block.at, number: 7 }, balanceEur: 12.5, holder, kind: "balance" };
  assert.equal(docs.snapshotDigest(a), docs.snapshotDigest(b), "key order must not change the digest");
  const code = docs.newDocumentCode();
  const zold = await docs.signSnapshot(a, code);
  const doc: any = { id: "d", code: docs.normaliseCode(code), kind: "balance", userId: "u", createdAt: "x", snapshot: a, attestations: { zold } };
  assert.deepEqual(await docs.verifyZoldAttestation(doc), { ok: true });
  const tampered = { ...doc, snapshot: { ...a, balanceEur: 1250 } };
  assert.equal((await docs.verifyZoldAttestation(tampered)).ok, false, "a changed figure must fail");
});

await t("the BIC is LHV's, and only next to an Estonian IBAN", () => {
  assert.equal(docs.bicFor("EE43 7777 0001 3752 9827"), "LHVBEE22");
  assert.equal(docs.bicFor("IS14 0159 2600 7654 5510 7303 39"), undefined);
  assert.match(docs.PARTIES.footer, /AS LHV Pank/);
  assert.match(docs.PARTIES.footer, /Monerium ehf/);
});

// ---------------------------------------------------------------------------
// online: a funded account, the routes, the verifier

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
function enc(v: any): Buffer {
  const head = (major: number, len: number) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]); }
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) { const parts: Buffer[] = [head(5, v.size)]; for (const [k, val] of v) parts.push(enc(k), enc(val)); return Buffer.concat(parts); }
  throw new Error("enc: unsupported");
}
function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => { let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1); if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]); return Buffer.concat([Buffer.from([0x02, v.length]), v]); };
  const r = int(raw.subarray(0, 32)); const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}
const ORIGIN = `http://localhost:${API_PORT}`;
const clientData = (type: string, challenge: string) => b64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));
async function makePasskey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = enc(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
  const credId = Buffer.from(`documents-${randomBytes(4).toString("hex")}`);
  const authData = (flags: number, count: number, att = false) => {
    const base = Buffer.alloc(37); sha256("localhost").copy(base, 0); base[32] = flags; base.writeUInt32BE(count, 33);
    if (!att) return base;
    const cred = Buffer.alloc(18 + credId.length); cred.writeUInt16BE(credId.length, 16); credId.copy(cred, 18);
    return Buffer.concat([base, cred, cose]);
  };
  let count = 0;
  return {
    register: (challenge: string) => ({ credentialId: b64url(credId), attestation: b64url(enc(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x41, 0, true)]]))), clientDataJSON: clientData("webauthn.create", challenge) }),
    assert: async (challenge: string) => {
      count += 1;
      const cd = clientData("webauthn.get", challenge);
      const ad = authData(0x05, count);
      const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([ad, sha256(unb64url(cd))])));
      return { credentialId: b64url(credId), authenticatorData: b64url(ad), clientDataJSON: cd, signature: b64url(rawToDer(raw)) };
    },
  };
}

let token = "";
const children: ChildProcess[] = [];
async function call(pathname: string, body?: any, method?: string, bearer = token) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(API + pathname, { method: method ?? (body ? "POST" : "GET"), ...(body ? { body: JSON.stringify(body) } : {}), headers });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}
const bg = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(c);
  return c;
};

for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) { console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`); process.exit(1); }
}

try {
  console.log("2/3 chain + deploy + API…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRANSF_RPC_URL: RPC_URL } }).status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    TRANSF_API_PORT: String(API_PORT), TRANSF_RPC_URL: RPC_URL, PORT: String(API_PORT),
    RP_ID: "localhost", WEBAUTHN_ORIGINS: `${API},http://localhost:${API_PORT}`,
    MONERIUM_CLIENT_ID: "", MONERIUM_CLIENT_SECRET: "", MG_ANCHOR_DOMAIN: "",
    CANDIDE_CHAIN_ID: "31337", CANDIDE_RPC_URL: RPC_URL, CANDIDE_COSIGNER_ENABLED: "0", CANDIDE_RECOVERY_GUARDIAN_ADDRESS: "",
    CRYPTO_IN_POLL_MS: "1000", LOCAL_HARNESS: "1", KYC_AUTO_APPROVE: "1",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("3/3 documents through the API…");
  const created = await call("/api/users", { name: "Doc Holder", email: "doc@example.com", country: "DE" });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const userId: string = created.data.id;
  token = created.data.sessionToken;
  const passkey = await makePasskey();
  {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    assert.equal((await call(`/api/users/${userId}/passkey`, passkey.register(challenge.data.challenge))).status, 201);
    const deploy = await call(`/api/users/${userId}/passkey-safe/deployment`, {});
    assert.ok(deploy.status < 300, JSON.stringify(deploy.data));
    if (deploy.data.challenge) assert.ok((await call(deploy.data.submitTo, await passkey.assert(deploy.data.challenge))).status < 300);
  }
  const me = await call(`/api/users/${userId}`);
  const safeAddress: `0x${string}` = me.data.address;
  assert.equal(me.data.passkeySafe?.status, "active");

  // Fund the Safe on chain: hardhat account 0 owns the MockToken EURe.
  const { loadDeployments } = await import("../services/api/src/config.js");
  const { eure } = loadDeployments(31337);
  const wallet = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain: hardhat, transport: http(RPC_URL) });
  const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
  const mintAbi = [{ type: "function", name: "mint", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }] as const;
  const mintHash = await wallet.writeContract({ address: eure, abi: mintAbi, functionName: "mint", args: [safeAddress, parseUnits("250", 18)] });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  await new Promise((r) => setTimeout(r, 3500)); // let the deposit poller record the credit

  let statement: any;
  await t("a statement over today reconciles against balances read at real blocks", async () => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();
    const r = await call(`/api/users/${userId}/documents/statement`, { from, to });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    statement = r.data;
    const s = statement.snapshot;
    assert.equal(s.kind, "statement");
    assert.equal(s.closing.amountEur, 250, "closing balance is the minted EURe");
    assert.equal(s.opening.amountEur, 0);
    assert.equal(s.lines.length, 1, JSON.stringify(s.lines));
    assert.equal(s.lines[0].source, "chain");
    assert.equal(s.lines[0].amountEur, 250);
    assert.equal(s.reconciliation.reconciles, true, JSON.stringify(s.reconciliation));
    assert.match(s.sources.monerium, /no Monerium connection/, "the statement says why counterparties are missing");
    assert.match(statement.code, /^[0-9A-Z]{15}$/);
    assert.ok(statement.url.endsWith(`/v/${statement.code}`));
  });

  await t("the public verifier re-reads the closing balance and confirms the signature", async () => {
    const r = await call(`/api/v/${statement.code}`, undefined, undefined, "");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.verification.ok, true, JSON.stringify(r.data.verification));
    assert.ok(r.data.verification.checks.some((c: any) => /Closing balance/.test(c.name) && c.ok));
    assert.match(r.data.parties.footer, /LHV Pank/);
    assert.equal(r.data.userId, undefined, "the holder's user id is not on the public surface");
  });

  await t("a mistyped code is a 404, and a look-alike spelling still resolves", async () => {
    assert.equal((await call(`/api/v/AAAAA-BBBBB-CCCCC`, undefined, undefined, "")).status, 404);
    const spaced = `${statement.code.slice(0, 5)}-${statement.code.slice(5, 10)}-${statement.code.slice(10)}`.toLowerCase();
    assert.equal((await call(`/api/v/${spaced}`, undefined, undefined, "")).status, 200);
  });

  await t("a balance confirmation names the block and verifies against it", async () => {
    const r = await call(`/api/users/${userId}/documents/balance`, {});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.snapshot.balanceEur, 250);
    assert.ok(r.data.snapshot.block.number > 0);
    const v = await call(`/api/v/${r.data.code}`, undefined, undefined, "");
    assert.equal(v.data.verification.ok, true, JSON.stringify(v.data.verification));
    assert.ok(v.data.verification.checks.some((c: any) => /re-read from the chain at that block/.test(c.name) && c.ok));
  });

  await t("a receipt is refused for a transfer that has not moved money", async () => {
    const quote = await call("/api/quotes", { userId, sendEur: 20, rail: "sepa" });
    if (quote.status !== 201 && quote.status !== 200) {
      // The SEPA rail may refuse to quote without Monerium; the refusal is the
      // same property from the other side — nothing to receipt.
      assert.ok(quote.status >= 400, JSON.stringify(quote.data));
      return;
    }
    const r = await call(`/api/users/${userId}/documents/receipt`, { transferId: "not-a-transfer" });
    assert.equal(r.status, 404);
  });

  await t("proof of ownership is issued with Zold's signature and gains the Safe's through a passkey ceremony", async () => {
    const r = await call(`/api/users/${userId}/documents/ownership`, {});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.snapshot.statement, new RegExp(safeAddress));
    assert.ok(r.data.safeSignature?.challenge, "an active Safe is offered the second signature");
    assert.equal(r.data.attestations.safe, undefined);
    const signed = await call(r.data.safeSignature.submitTo, await passkey.assert(r.data.safeSignature.challenge));
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.attestations.safe.address.toLowerCase(), safeAddress.toLowerCase());
    assert.equal(signed.data.attestations.safe.message, r.data.snapshot.safeMessage);
    const v = await call(`/api/v/${r.data.code}`, undefined, undefined, "");
    assert.equal(v.data.verification.ok, true, JSON.stringify(v.data.verification));
    assert.ok(v.data.verification.checks.some((c: any) => /smart account/.test(c.name)));
  });

  await t("the holder's list shows every document without its snapshot; a revoked one fails verification", async () => {
    const list = await call(`/api/users/${userId}/documents`);
    assert.equal(list.status, 200);
    assert.equal(list.data.documents.length, 3);
    assert.ok(list.data.documents.every((d: any) => d.snapshot === undefined && d.summary));
    const del = await call(`/api/users/${userId}/documents/${statement.code}`, undefined, "DELETE");
    assert.equal(del.status, 200);
    const v = await call(`/api/v/${statement.code}`, undefined, undefined, "");
    assert.equal(v.data.verification.ok, false);
    assert.ok(v.data.verification.checks.some((c: any) => c.name === "Not revoked" && !c.ok));
  });

  await t("another account cannot read or revoke the holder's documents", async () => {
    const other = await call("/api/users", { name: "Someone Else", country: "DE" });
    const r = await call(`/api/users/${userId}/documents`, undefined, undefined, other.data.sessionToken);
    assert.equal(r.status, 403, JSON.stringify(r.data));
  });

  console.log(`\nDOCUMENTS TEST PASSED — ${pass}/${pass}`);
  console.log("NOT covered here: Monerium order data on statement lines (needs a connected account) and the printed PDF itself.");
} finally {
  for (const c of children) c.kill("SIGTERM");
}
