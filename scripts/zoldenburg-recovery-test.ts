/**
 * Zoldenburg as recovery guardian — the pure parts, then the whole flow.
 *
 * PART 1 (in process): the EIP-712 typed data the operator's hardware wallet
 * signs hashes to what Candide's DEPLOYED module computes (a digest read from
 * Base Sepolia's module is pinned below); the wallet-JSON form hashes the same;
 * a signature from anyone but the guardian is refused; the relay calldata
 * executes; guardian removal lands the right threshold; Safe Cover links
 * decode to the recovery they name; stored secrets never reach a projection.
 *
 * PART 2 (hardhat + API under LOCAL_HARNESS): deployment adds NO guardian;
 * opt-in needs a passkey-signed operation and an acknowledgement; declining
 * needs one too; a lost device registers a new passkey and waits for review;
 * only the operator token reaches /admin/recoveries; a wrong signer or a
 * missing review note is refused; the new passkey cannot sign in until the
 * grace period ends and finalisation binds it; the old sessions die then.
 *
 * NOT covered: a real relay and finalisation on chain, and Safe Cover itself.
 * Those need a funded deployer, a Safe on Base (Sepolia) with the guardian,
 * and the operator's hardware wallet.
 *
 * Run: npm run recovery:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lzString from "lz-string";
import { decodeFunctionData, getAddress, hashTypedData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3043);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (n: string) => (n === "tsx" ? path.join(ROOT, "node_modules/tsx/dist/cli.mjs") : path.join(ROOT, "node_modules/.bin", n));

const MODULE = "0x949d01d424bE050D09C16025dd007CB59b3A8c66"; // Candide's 3-minute test module
const guardianKey = generatePrivateKey();
const guardian = privateKeyToAccount(guardianKey);
const impostor = privateKeyToAccount(generatePrivateKey());
const OPERATOR = `op-${randomBytes(16).toString("hex")}`;
const EMAIL = "zold.recover@example.com";
const IBAN_KEY = `iban-${randomBytes(24).toString("hex")}`;
// The same key in this process, so the key id written below is the API's own.
process.env.RECOVERY_IBAN_HMAC_KEY = IBAN_KEY;

process.env.CANDIDE_RECOVERY_GUARDIAN_ADDRESS = guardian.address;
process.env.CANDIDE_RECOVERY_MODULE_ADDRESS = MODULE;

let token = "";
const children: ChildProcess[] = [];
let pass = 0;
const t = async (label: string, fn: () => Promise<void> | void) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

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
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(enc(k), enc(val));
    return Buffer.concat(parts);
  }
  throw new Error("enc: unsupported");
}

function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

const ORIGIN = `http://localhost:${API_PORT}`;
const clientData = (type: string, challenge: string) =>
  b64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));

/** A software P-256 authenticator that produces real attestations and assertions. */
async function makePasskey(label: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = enc(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
  const credId = Buffer.from(`zoldenburg-recovery-${label}-${randomBytes(4).toString("hex")}`);
  const authData = (flags: number, count: number, includeAttestation = false) => {
    const base = Buffer.alloc(37);
    sha256("localhost").copy(base, 0);
    base[32] = flags;
    base.writeUInt32BE(count, 33);
    if (!includeAttestation) return base;
    const cred = Buffer.alloc(18 + credId.length);
    cred.writeUInt16BE(credId.length, 16);
    credId.copy(cred, 18);
    return Buffer.concat([base, cred, cose]);
  };
  let count = 0;
  return {
    credentialId: b64url(credId),
    jwk,
    register: (challenge: string) => ({
      credentialId: b64url(credId),
      attestation: b64url(enc(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, 0, true)]]))),
      clientDataJSON: clientData("webauthn.create", challenge),
    }),
    assert: async (challenge: string) => {
      count += 1;
      const clientDataJSON = clientData("webauthn.get", challenge);
      const authenticatorData = authData(0x05, count);
      const raw = Buffer.from(await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        Buffer.concat([authenticatorData, sha256(unb64url(clientDataJSON))]),
      ));
      return { credentialId: b64url(credId), authenticatorData: b64url(authenticatorData), clientDataJSON, signature: b64url(rawToDer(raw)) };
    },
  };
}


const G = await import("../services/api/src/recovery/zoldenburg-guardian.js");
const { publicRecoveryRequest } = await import("../services/api/src/recovery.js");
const { ibanKeyId } = await import("../services/api/src/recovery/enrolment-key.js");
const { SocialRecoveryModule } = await import("abstractionkit");

console.log("1/2 typed data, signatures, calldata");

await t("the typed data hashes to the digest Base Sepolia's deployed module computes", () => {
  // getRecoveryHash(0x11…11, [0x22…22], 1, 0) on 0x949d…8c66, chain 84532,
  // read with eth_call on 2026-09-29. The GitHub source names version 0.2.0;
  // the deployed contract hashes with 0.0.1.
  const td = G.recoveryTypedData({
    moduleAddress: MODULE,
    safeAddress: "0x1111111111111111111111111111111111111111",
    newOwners: ["0x2222222222222222222222222222222222222222"],
    newThreshold: 1,
    nonce: 0n,
    chainId: 84532,
  });
  assert.equal(G.recoveryDigest(td), "0x8acd235da647787d9376d7ca2a18cb09bad5d2255eb79c6648cadf541cfff183");
  assert.deepEqual(G.RECOVERY_EIP712_DOMAIN, { name: "Social Recovery Module", version: "0.0.1" });
});

const td = G.recoveryTypedData({
  moduleAddress: MODULE,
  safeAddress: "0x3333333333333333333333333333333333333333",
  newOwners: ["0x4444444444444444444444444444444444444444"],
  newThreshold: 1,
  nonce: 3n,
  chainId: 8453,
});
const digest = G.recoveryDigest(td);

await t("the wallet JSON (eth_signTypedData_v4) hashes to the same digest", () => {
  const w = G.typedDataForWallet(td);
  const { EIP712Domain: _d, ...types } = w.types;
  assert.equal(hashTypedData({ ...w, types } as any), digest);
  assert.equal(typeof w.message.nonce, "string", "uint256 travels as a decimal string");
});

await t("only the guardian's signature is accepted", async () => {
  const good = await guardian.signTypedData(td as any);
  assert.equal(await G.assertGuardianSignature(digest, good, guardian.address), good);
  const bad = await impostor.signTypedData(td as any);
  await assert.rejects(G.assertGuardianSignature(digest, bad, guardian.address), (e: any) => e.code === "WRONG_SIGNER");
  await assert.rejects(G.assertGuardianSignature(digest, "0x1234", guardian.address), (e: any) => e.code === "BAD_SIGNATURE");
  // A signature over a different recovery (another nonce) recovers to someone else.
  const other = await guardian.signTypedData({ ...td, message: { ...td.message, nonce: 4n } } as any);
  await assert.rejects(G.assertGuardianSignature(digest, other, guardian.address), (e: any) => e.code === "WRONG_SIGNER");
});

await t("a signature with v as 0/1 (as QR signers may return) is normalised to 27/28 for the module", async () => {
  const good = await guardian.signTypedData(td as any);
  const v = parseInt(good.slice(130), 16);
  const low = `${good.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
  assert.equal(await G.assertGuardianSignature(digest, low, guardian.address), good);
  await assert.rejects(G.assertGuardianSignature(digest, `${good.slice(0, 130)}05`, guardian.address), (e: any) => e.code === "BAD_SIGNATURE");
});

await t("the guardian-check message cannot pass as a recovery approval", () => {
  const check = G.guardianCheckTypedData("2026-09-29T10:00:00.000Z", 8453);
  assert.notEqual(check.domain.name, G.RECOVERY_EIP712_DOMAIN.name);
  assert.ok(!("verifyingContract" in check.domain));
});

await t("the relay calls multiConfirmRecovery with execute=true and the guardian's pair", async () => {
  const sig = await guardian.signTypedData(td as any);
  const tx = new SocialRecoveryModule(MODULE).createMultiConfirmRecoveryMetaTransaction(
    td.message.wallet, td.message.newOwners, 1, [{ signer: guardian.address, signature: sig }], true,
  );
  assert.equal(tx.to, MODULE);
  assert.equal((tx.data as string).slice(0, 10), "0x0728e1e7", "the deployed module's multiConfirmRecovery (no nonce argument)");
  const d = decodeFunctionData({
    abi: parseAbi(["function multiConfirmRecovery(address,address[],uint256,(address,bytes)[],bool)"]),
    data: tx.data as `0x${string}`,
  });
  assert.equal(d.args[0], td.message.wallet);
  assert.deepEqual(d.args[1], td.message.newOwners);
  assert.equal(d.args[4], true);
  assert.equal((d.args[3] as any)[0][0], guardian.address);
});

await t("removing Zoldenburg leaves threshold 1 with another guardian, 0 without", async () => {
  const abi = parseAbi(["function revokeGuardianWithThreshold(address,address,uint256)"]);
  const alone = await G.zoldenburgGuardianRemoveTransaction(td.message.wallet, MODULE, guardian.address, [guardian.address]);
  assert.equal(decodeFunctionData({ abi, data: alone.data as `0x${string}` }).args[2], 0n);
  const withOther = await G.zoldenburgGuardianRemoveTransaction(td.message.wallet, MODULE, guardian.address, [guardian.address, impostor.address]);
  assert.equal(decodeFunctionData({ abi, data: withOther.data as `0x${string}` }).args[2], 1n);
});

await t("a Safe Cover link decodes to exactly the recovery it names, and none is made for Base Sepolia", () => {
  const link = G.safeCoverRecoveryLink({ safeAddress: td.message.wallet, newOwners: td.message.newOwners, newThreshold: 1, chainId: 8453 })!;
  assert.match(link, /\/manage-recovery\/dashboard#/);
  const payload = JSON.parse(lzString.decompressFromEncodedURIComponent(link.split("#")[1])!);
  assert.deepEqual(payload, { s: td.message.wallet, o: td.message.newOwners, t: 1, c: "8453" });
  assert.equal(G.safeCoverRecoveryLink({ safeAddress: td.message.wallet, newOwners: td.message.newOwners, newThreshold: 1, chainId: 84532 }), null);
});

await t("the public projection drops the access hash and the new credential", () => {
  const pub = publicRecoveryRequest({
    id: "r1", userId: "u1", safeAddress: td.message.wallet, mode: "zoldenburg", status: "REVIEW_PENDING",
    requestedAt: "", expiresAt: "", recoveryDelayHours: 72, guardianAddress: guardian.address, recoveryModuleAddress: MODULE,
    reviewReason: "private note",
    factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" },
    zoldenburg: { accessHash: "deadbeef", reference: "ABCDE-12345", newPasskey: { credentialId: "c", publicKey: { jwk: {}, alg: "ES256" }, signCount: 0, rpId: "x", attestation: "att", createdAt: "" } },
  } as any);
  const text = JSON.stringify(pub);
  for (const secret of ["deadbeef", "attestation", "credentialId", "private note"]) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal((pub as any).zoldenburg.newPasskeyRegistered, true);
});

await t("source: no guardian key in the API, deployment adds no guardian, recovery installs only the new passkey", () => {
  const g = readFileSync(path.join(ROOT, "services/api/src/recovery/zoldenburg-guardian.ts"), "utf8");
  assert.ok(!/privateKeyToAccount|GUARDIAN_KEY|GUARDIAN_PRIVATE/.test(g), "the guardian key must never be held by the API");
  const plan = readFileSync(path.join(ROOT, "services/api/src/wallet/passkey-safe-plan.ts"), "utf8");
  assert.ok(!/recoveryGuardianAddress/.test(plan), "the deployment plan must not add a guardian on its own");
  const r = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-zoldenburg.ts"), "utf8");
  assert.ok(/const newOwners: `0x\$\{string\}`\[\] = \[passkeyAccountAddress\(owner\)\];/.test(r), "the recovery installs the new passkey as the only owner");
  const exec = r.slice(r.indexOf('"/admin/recoveries/:id/execute"'), r.indexOf('"/admin/recoveries/:id/sync"'));
  const i = (s: string) => exec.indexOf(s);
  assert.ok(i("adminRequest(req, res)") > 0, "execute is operator-only");
  assert.ok(i("typedDataFor(r)") > 0 && i("assertGuardianSignature(") > i("typedDataFor(r)") && i("relayRecovery(") > i("assertGuardianSignature("),
    "execute recomputes the digest from the chain, then checks the signer, and only then relays");
  assert.equal((r.match(/adminRequest\(req, res\)/g) ?? []).length, 5, "every by-id admin route goes through the operator check");
});

console.log("2/2 the flow, against the API under the local harness");
for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

async function call(pathname: string, body?: any, method?: string, bearer = token, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (body) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(API + pathname, { method: method ?? (body ? "POST" : "GET"), ...(body ? { body: JSON.stringify(body) } : {}), headers });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}
const op = (p: string, body: any = {}) => call(p, body, "POST", OPERATOR);
const opGet = (p: string) => call(p, undefined, "GET", OPERATOR);
function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}
/** A wallet signs strings for uint256; viem wants bigints. */
const fromWallet = (w: any) => {
  const { EIP712Domain: _d, ...types } = w.types;
  return { ...w, types, message: { ...w.message, newThreshold: BigInt(w.message.newThreshold), nonce: BigInt(w.message.nonce) } };
};

/** The API under test. Stopped and started again to arm an account the way
 *  a 1 € enrolment would: the harness has no Monerium to send the 1 €. */
let api: ChildProcess | undefined;
async function startApi() {
  api = bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    TRANSF_API_PORT: String(API_PORT),
    TRANSF_RPC_URL: RPC_URL,
    PORT: String(API_PORT),
    RP_ID: "localhost",
    WEBAUTHN_ORIGINS: `${API},http://localhost:${API_PORT}`,
    MONERIUM_CLIENT_ID: "",
    MONERIUM_CLIENT_SECRET: "",
    MG_ANCHOR_DOMAIN: "",
    CANDIDE_CHAIN_ID: "31337",
    CANDIDE_RPC_URL: RPC_URL,
    CANDIDE_RECOVERY_GUARDIAN_ADDRESS: guardian.address,
    CANDIDE_RECOVERY_MODULE_ADDRESS: MODULE,
    RECOVERY_SERVICE_URL: "",
    RECOVERY_SIMULATED_GRACE_SECONDS: "2",
    RECOVERY_SWEEP_MS: "3600000",
    KYC_OPERATOR_TOKEN: OPERATOR,
    LOCAL_HARNESS: "1",
    KYC_AUTO_APPROVE: "1",
    RECOVERY_IBAN_HMAC_KEY: IBAN_KEY,
  });
  for (const s = Date.now(); ; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    if (Date.now() - s > 30_000) throw new Error("API did not come up");
    await new Promise((r) => setTimeout(r, 300));
  }
}
/** Write an enrolment the way recovery/zoldenburg-enrolment.ts records one,
 *  with the API stopped: the harness has no Monerium to deliver the 1 €.
 *  zoldenburg-enrolment-test.ts covers how a real one gets there. */
async function armInDb(userId: string) {
  await stopApi();
  const dbPath = process.env.TRANSF_DB_PATH!;
  const db = JSON.parse(readFileSync(dbPath, "utf8"));
  db.users.find((x: any) => x.id === userId).zoldenburgEnrolment = {
    bankAccountHmac: createHash("sha256").update("harness-bank-account").digest("hex"),
    keyId: ibanKeyId(),
    bankAccountLast4: "3000",
    orderId: "harness-order",
    enrolledAt: new Date().toISOString(),
  };
  writeFileSync(dbPath, JSON.stringify(db), { mode: 0o600 });
  await startApi();
}
async function stopApi() {
  if (!api || api.exitCode !== null) return;
  const exited = new Promise((r) => api!.once("exit", r));
  api.kill("SIGTERM");
  await exited;
}

try {
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRANSF_RPC_URL: RPC_URL } }).status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  await startApi();

  const health = await call("/api/health");
  await t("the capability is published when a guardian address is configured", () => {
    assert.equal(health.data.capabilities?.zoldenburgRecovery, true);
  });

  const created = await call("/api/users", { name: "Guardian Greta", email: EMAIL, country: "DE" });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const userId: string = created.data.id;
  token = created.data.sessionToken;
  const oldToken = token;
  const passkey = await makePasskey("original");
  {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    const registered = await call(`/api/users/${userId}/passkey`, passkey.register(challenge.data.challenge));
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const deploy = await call(`/api/users/${userId}/passkey-safe/deployment`, {});
    assert.ok(deploy.status < 300, JSON.stringify(deploy.data));
    if (deploy.data.challenge) assert.ok((await call(deploy.data.submitTo, await passkey.assert(deploy.data.challenge))).status < 300);
  }

  await t("deployment adds no guardian: Zoldenburg is the user's choice", async () => {
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.passkeySafe?.status, "active");
    assert.equal(me.data.passkeySafe.recovery, undefined);
    assert.equal(me.data.passkeySafe.recoveryChoice, undefined);
    const screen = await call(`/api/users/${userId}/recovery/zoldenburg`);
    assert.equal(screen.data.active, false);
  });

  await t("a lost device cannot ask Zoldenburg about an account that did not opt in", async () => {
    const r = await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "");
    assert.equal(r.status, 404, JSON.stringify(r.data));
  });

  await t("adding and declining both need the acknowledgement", async () => {
    assert.equal((await call(`/api/users/${userId}/recovery/zoldenburg`, {})).data.code, "NOT_ACKNOWLEDGED");
    assert.equal((await call(`/api/users/${userId}/recovery/zoldenburg/decline`, {})).data.code, "NOT_ACKNOWLEDGED");
  });

  await t("declining records the choice", async () => {
    const r = await call(`/api/users/${userId}/recovery/zoldenburg/decline`, { acknowledged: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.choice.choice, "declined");
  });

  await t("adding Zoldenburg is a passkey-signed operation, and needs a session", async () => {
    assert.equal((await call(`/api/users/${userId}/recovery/zoldenburg`, { acknowledged: true }, undefined, "")).status, 401);
    const prep = await call(`/api/users/${userId}/recovery/zoldenburg`, { acknowledged: true });
    assert.equal(prep.status, 201, JSON.stringify(prep.data));
    assert.equal(prep.data.guardianAddress, guardian.address);
    const done = await call(prep.data.submitTo, await passkey.assert(prep.data.challenge));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.active, true);
    assert.equal(done.data.choice.choice, "zoldenburg");
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.passkeySafe.recovery.status, "active");
    assert.equal(me.data.passkeySafe.recovery.guardianAddress, guardian.address);
  });

  await t("declining is refused while Zoldenburg is the guardian", async () => {
    const r = await call(`/api/users/${userId}/recovery/zoldenburg/decline`, { acknowledged: true });
    assert.equal(r.data.code, "IS_GUARDIAN");
  });

  // ---- a request the owner did not make, and one the operator rejects ----
  await t("the owner, still holding the passkey, can cancel a request someone else opened", async () => {
    const start = await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "");
    assert.equal(start.status, 201, JSON.stringify(start.data));
    const screen = await call(`/api/users/${userId}/recovery/zoldenburg`);
    assert.equal(screen.data.requests.length, 1);
    const c = await call(`/api/users/${userId}/recovery/zoldenburg/requests/${start.data.id}/cancel`, {});
    assert.equal(c.status, 200, JSON.stringify(c.data));
    assert.equal(c.data.requests.length, 0);
  });

  const newPasskey = await makePasskey("replacement");
  let secret = "";
  let recoveryId = "";
  const rc = (p: string, body?: any, s = secret) => call(p, body, undefined, "", s ? { "x-recovery-secret": s } : {});

  await t("a lost device registers a new passkey and waits for review, with a reference to quote", async () => {
    const start = await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "");
    assert.equal(start.status, 201, JSON.stringify(start.data));
    secret = start.data.recoverySecret;
    recoveryId = start.data.id;
    assert.ok(secret && start.data.registerChallenge);
    assert.ok(!start.text.includes("accessHash"));
    const r = await rc(start.data.submitTo, newPasskey.register(start.data.registerChallenge));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "REVIEW_PENDING");
    assert.match(r.data.zoldenburg.reference, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
    assert.ok(!r.text.includes("attestation"));
  });

  await t("the id alone reads nothing; a second starter is refused once a passkey is registered", async () => {
    assert.equal((await rc(`/api/recovery/zoldenburg/${recoveryId}`, undefined, "")).status, 404);
    const again = await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "");
    assert.equal(again.status, 409);
    assert.equal(again.data.code, "RECOVERY_IN_PROGRESS");
    assert.ok(!again.text.includes(recoveryId));
  });

  await t("the new passkey cannot sign in while the request waits", async () => {
    const c = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    const r = await call("/api/passkey/login", await newPasskey.assert(c.data.challenge), undefined, "");
    assert.notEqual(r.status, 200, JSON.stringify(r.data));
  });

  await t("the guardian wallet check accepts the guardian, and refuses anyone else or a stale message", async () => {
    assert.equal((await call("/api/admin/recoveries/guardian-check/challenge", {})).status, 401);
    const c = await op("/api/admin/recoveries/guardian-check/challenge");
    assert.equal(c.status, 200, JSON.stringify(c.data));
    const { EIP712Domain: _d, ...types } = c.data.typedData.types;
    const msg = { ...c.data.typedData, types };
    const ok = await op("/api/admin/recoveries/guardian-check", { issuedAt: msg.message.issuedAt, signature: await guardian.signTypedData(msg) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const wrong = await op("/api/admin/recoveries/guardian-check", { issuedAt: msg.message.issuedAt, signature: await impostor.signTypedData(msg) });
    assert.equal(wrong.data.code, "WRONG_SIGNER");
    const staleAt = new Date(Date.now() - 3600_000).toISOString();
    const stale = await op("/api/admin/recoveries/guardian-check", {
      issuedAt: staleAt,
      signature: await guardian.signTypedData({ ...msg, message: { ...msg.message, issuedAt: staleAt } }),
    });
    assert.equal(stale.data.code, "STALE");
  });

  await t("until the 1 € from their bank arrives, the guardian is on chain but not armed", async () => {
    const screen = await call(`/api/users/${userId}/recovery/zoldenburg`);
    assert.equal(screen.data.active, true);
    assert.equal(screen.data.enrolment.available, true);
    assert.equal(screen.data.enrolment.armed, false);
  });

  await t("the operator cannot sign for an account that never sent its 1 €", async () => {
    const sr = await op(`/api/admin/recoveries/${recoveryId}/sign-request`);
    assert.equal(sr.status, 409, JSON.stringify(sr.data));
    assert.equal(sr.data.code, "NOT_ARMED");
    const ex = await op(`/api/admin/recoveries/${recoveryId}/execute`, { signature: "0x00", reviewNote: "Video call, matched Monerium profile" });
    assert.equal(ex.data.code, "NOT_ARMED");
    const sync = await op(`/api/admin/recoveries/${recoveryId}/sync`, { reviewNote: "Video call, matched Monerium profile" });
    assert.equal(sync.status, 409, JSON.stringify(sync.data));
    assert.equal(sync.data.code, "NOT_ARMED");
    const row = (await opGet("/api/admin/recoveries")).data.requests.find((x: any) => x.id === recoveryId);
    assert.equal(row.enrolment.armed, false);
  });

  await armInDb(userId);

  await t("enrolled: the operator sees the account armed, with the last 4 of the bank account", async () => {
    const row = (await opGet("/api/admin/recoveries")).data.requests.find((x: any) => x.id === recoveryId);
    assert.equal(row.enrolment.armed, true);
    assert.equal(row.enrolment.bankAccountLast4, "3000");
    assert.ok(!JSON.stringify(row).includes("bankAccountHmac"));
  });

  await t("/admin/recoveries needs the operator token; a user session is not enough", async () => {
    assert.equal((await call("/api/admin/recoveries")).status, 401);
    assert.equal((await call(`/api/admin/recoveries/${recoveryId}/execute`, { signature: "0x" })).status, 401);
    const list = await opGet("/api/admin/recoveries");
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const row = list.data.requests.find((x: any) => x.id === recoveryId);
    assert.equal(row.account.email, EMAIL, "the operator sees who to check");
    assert.equal(row.account.kycStatus, "approved");
    assert.equal(row.safeCoverLink, null, "no Safe Cover link on a chain it does not list");
    assert.ok(!list.text.includes("accessHash") && !list.text.includes("attestation"));
  });

  let typed: any;
  await t("the sign request hands out typed data that names this Safe and the new passkey's signer", async () => {
    const r = await op(`/api/admin/recoveries/${recoveryId}/sign-request`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    typed = r.data.typedData;
    assert.equal(r.data.guardianAddress, guardian.address);
    assert.equal(typed.primaryType, "ExecuteRecovery");
    assert.equal(typed.domain.verifyingContract, getAddress(MODULE));
    const me = await call(`/api/users/${userId}`);
    assert.equal(typed.message.wallet, getAddress(me.data.passkeySafe.address));
    assert.equal(typed.message.newOwners.length, 1);
    assert.equal(hashTypedData(fromWallet(typed)), r.data.digest);
  });

  await t("no review note, or a signature from anyone but the guardian, is refused", async () => {
    const good = await guardian.signTypedData(fromWallet(typed));
    const noNote = await op(`/api/admin/recoveries/${recoveryId}/execute`, { signature: good });
    assert.equal(noNote.data.code, "NO_REVIEW_NOTE");
    const bad = await op(`/api/admin/recoveries/${recoveryId}/execute`, { signature: await impostor.signTypedData(fromWallet(typed)), reviewNote: "Video call, matched Monerium profile" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, "WRONG_SIGNER");
  });

  await t("the guardian's signature executes: the waiting period starts, the review is recorded", async () => {
    const r = await op(`/api/admin/recoveries/${recoveryId}/execute`, {
      signature: await guardian.signTypedData(fromWallet(typed)),
      reviewNote: "Video call 29 Sep, matched name and DOB with the Monerium profile",
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "GRACE_PERIOD");
    assert.match(r.data.reviewedBy, /^operator:/);
    assert.ok(r.data.zoldenburg.finalizeAfter);
  });

  await t("reject is refused once the recovery is on chain (only the old passkey can stop it now)", async () => {
    const r = await op(`/api/admin/recoveries/${recoveryId}/reject`, { reason: "late" });
    assert.equal(r.status, 409);
  });

  await t("finalising before the grace period ends is refused", async () => {
    const r = await rc(`/api/recovery/zoldenburg/${recoveryId}/finalize`, {});
    assert.equal(r.status, 425, JSON.stringify(r.data));
  });

  await new Promise((r) => setTimeout(r, 2500));

  await t("after the grace period, finalisation binds the new passkey and hands out no session", async () => {
    assert.equal((await rc(`/api/recovery/zoldenburg/${recoveryId}/finalize`, {}, "")).status, 404);
    const r = await rc(`/api/recovery/zoldenburg/${recoveryId}/finalize`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "FINALIZED");
    assert.ok(!r.text.includes("sessionToken"));
  });

  await t("the new passkey signs in, the old one does not, and the old session is gone", async () => {
    const c1 = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    const ok = await call("/api/passkey/login", await newPasskey.assert(c1.data.challenge), undefined, "");
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.id, userId);
    token = ok.data.sessionToken;
    const c2 = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    assert.equal((await call("/api/passkey/login", await passkey.assert(c2.data.challenge), undefined, "")).status, 404);
    assert.equal((await call(`/api/users/${userId}`, undefined, undefined, oldToken)).status, 401);
    const me = await call(`/api/users/${userId}`);
    const x = `0x${Buffer.from(newPasskey.jwk.x!, "base64url").toString("hex")}`;
    assert.equal(me.data.passkeySafe.passkeyPublicKey.x.toLowerCase(), x.toLowerCase());
    assert.equal(me.data.passkeySafe.recovery.status, "active", "Zoldenburg stays guardian after a recovery");
  });

  await t("the operator can reject a request with a reason the person sees", async () => {
    const start = await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "");
    assert.equal(start.status, 201, JSON.stringify(start.data));
    const s2 = start.data.recoverySecret;
    const other = await makePasskey("third");
    await rc(start.data.submitTo, other.register(start.data.registerChallenge), s2);
    assert.equal((await op(`/api/admin/recoveries/${start.data.id}/reject`, {})).status, 400, "a reason is required");
    const r = await op(`/api/admin/recoveries/${start.data.id}/reject`, { reason: "We could not verify your identity." });
    assert.equal(r.data.status, "CANCELED");
    const seenByThem = await rc(`/api/recovery/zoldenburg/${start.data.id}`, undefined, s2);
    assert.equal(seenByThem.data.cancelReason, "We could not verify your identity.");
  });

  await t("removing Zoldenburg is a passkey-signed operation and records the decline", async () => {
    const prep = await call(`/api/users/${userId}/recovery/zoldenburg/remove`, {});
    assert.equal(prep.status, 201, JSON.stringify(prep.data));
    const done = await call(prep.data.submitTo, await newPasskey.assert(prep.data.challenge));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.active, false);
    assert.equal(done.data.choice.choice, "declined");
    assert.equal((await call("/api/recovery/zoldenburg", { email: EMAIL }, undefined, "")).status, 404);
    assert.equal((await call(`/api/users/${userId}/recovery/zoldenburg`)).data.enrolment.enrolledAt, undefined, "removal drops the enrolment");
  });

  await t("adding Zoldenburg again needs a new 1 €: an enrolment from before does not arm it", async () => {
    await armInDb(userId);
    assert.equal((await call(`/api/users/${userId}/recovery/zoldenburg`)).data.enrolment.armed, false, "no guardian, not armed");
    const prep = await call(`/api/users/${userId}/recovery/zoldenburg`, { acknowledged: true });
    assert.equal(prep.status, 201, JSON.stringify(prep.data));
    const done = await call(prep.data.submitTo, await newPasskey.assert(prep.data.challenge));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.active, true);
    assert.equal(done.data.enrolment.armed, false);
    assert.equal(done.data.enrolment.enrolledAt, undefined);
  });

  console.log(`\nZOLDENBURG RECOVERY TEST PASSED — ${pass}/${pass}`);
  console.log("NOT covered here: relaying and finalising on a real chain, and Safe Cover — they need a funded deployer,");
  console.log("a Base (Sepolia) Safe with the guardian, and the operator's hardware wallet.");
} finally {
  for (const c of children) c.kill("SIGTERM");
}
