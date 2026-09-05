/**
 * Email/SMS recovery through Candide's guardian — enrolment and a full
 * lost-device recovery, against a stub recovery service.
 *
 * The stub speaks the SDK's wire shape (read from the SDK bundle, not
 * guessed): /v1/auth/register, /v1/auth/submit, /v1/auth/signature/request,
 * /v1/auth/signature/submit, /v1/config/getNetworkConfig and
 * /v1/recoveries/{create,execute,finalize}. It records every body so the
 * assertions can check what actually crossed the wire — the Safe-signed SIWE
 * statement, the new owner set, the guardian signature.
 *
 * Chain and bundler are simulated (ALLOW_SIMULATION): the property under test
 * is the state machine and its invariants, chiefly that the NEW passkey cannot
 * sign in until the recovery is finalized. The on-chain half (adding the
 * guardian, executing, finalizing) runs against Base Sepolia's 3-minute
 * module with a real Candide service URL, not here.
 *
 * Run: npm run recovery:candide:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3041);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const STUB_PORT = Number(process.env.TRANSF_STUB_PORT ?? 8561);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const bin = (n: string) => (n === "tsx" ? path.join(ROOT, "node_modules/tsx/dist/cli.mjs") : path.join(ROOT, "node_modules/.bin", n));

const MODULE = "0x949d01d424bE050D09C16025dd007CB59b3A8c66"; // Candide's 3-minute test module
const GUARDIAN = "0x00000000000000000000000000000000C0FFEE01";
const OTP = "246810";
const EMAIL = "recover.me@example.com";
const PHONE_RAW = "+49 151 1234567";
const PHONE = "+491511234567";

let token = "";
const children: ChildProcess[] = [];

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
  const credId = Buffer.from(`candide-recovery-${label}-${randomBytes(4).toString("hex")}`);
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
      attestation: b64url(enc(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x41, 0, true)]]))),
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

// --- the stub Candide recovery service ---------------------------------------

const seen = {
  registrations: [] as any[],
  submits: [] as any[],
  signatureRequests: [] as any[],
  signatureSubmits: [] as any[],
  creates: [] as any[],
  executes: [] as any[],
  finalizes: [] as any[],
  deletes: [] as any[],
  networkConfigCalls: 0,
};
const registered: { id: string; channel: string; target: string; challengeId: string }[] = [];
const pendingReg = new Map<string, { channel: string; target: string }>();
const sigRequests = new Map<string, { auths: { challengeId: string; channel: string; target: string; verified: boolean }[] }>();
let recoveryCounter = 0;

const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", STUB);
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    if (p === "/v1/config/getNetworkConfig") {
      seen.networkConfigCalls++;
      return send(200, {
        name: "hardhat", chainId: 31337, moduleAddress: MODULE,
        sponsorships: { execution: { enabled: true, rateLimit: { maxPerAccount: 5, period: 86400 } }, finalization: { enabled: true } },
        alertChannels: ["email", "sms"],
      });
    }
    if (p === "/v1/auth/register") {
      seen.registrations.push(body);
      if (!body.message?.includes(body.target) || !/^0x[0-9a-f]+$/i.test(body.signature ?? "")) {
        return send(200, { code: 400, message: "bad SIWE" });
      }
      const challengeId = `reg-chal-${registered.length + pendingReg.size + 1}`;
      pendingReg.set(challengeId, { channel: body.channel, target: body.target });
      return send(200, { challengeId });
    }
    if (p === "/v1/auth/submit") {
      seen.submits.push(body);
      const pending = pendingReg.get(body.challengeId);
      if (!pending) return send(200, { code: 404, message: "unknown challenge" });
      if (body.challenge !== OTP) return send(200, { code: 400, message: "invalid code" });
      pendingReg.delete(body.challengeId);
      const id = `reg-${registered.length + 1}`;
      registered.push({ id, ...pending, challengeId: body.challengeId });
      return send(200, { registrationId: id, guardianAddress: GUARDIAN });
    }
    if (p === "/v1/auth/delete") {
      seen.deletes.push(body);
      const i = registered.findIndex((r) => r.id === body.registrationId);
      if (i >= 0) registered.splice(i, 1);
      return send(200, { success: true });
    }
    if (p === "/v1/auth/signature/request") {
      seen.signatureRequests.push(body);
      const requestId = `sigreq-${seen.signatureRequests.length}`;
      const auths = registered.map((r, i) => ({ challengeId: `${requestId}-otp-${i + 1}`, channel: r.channel, target: r.target, verified: false }));
      sigRequests.set(requestId, { auths });
      return send(200, { requestId, requiredVerifications: auths.length, auths: auths.map(({ verified: _v, ...a }) => a) });
    }
    if (p === "/v1/auth/signature/submit") {
      seen.signatureSubmits.push(body);
      const r = sigRequests.get(body.requestId);
      const auth = r?.auths.find((a) => a.challengeId === body.challengeId);
      if (!r || !auth) return send(200, { code: 404, message: "unknown challenge" });
      if (body.challenge !== OTP) return send(200, { code: 400, message: "invalid code" });
      auth.verified = true;
      if (r.auths.every((a) => a.verified)) {
        return send(200, { success: true, signer: GUARDIAN, signature: `0x${"ab".repeat(65)}` });
      }
      return send(200, { success: true });
    }
    if (p === "/v1/recoveries/create") {
      seen.creates.push(body);
      const now = new Date().toISOString();
      return send(200, {
        id: `rec-${++recoveryCounter}`, emoji: "🦄🔑", account: body.account, newOwners: body.newOwners, newThreshold: body.newThreshold,
        chainId: body.chainId, nonce: "0x0", signatures: [body.signature], executeData: { sponsored: true }, finalizeData: { sponsored: true },
        status: "PENDING", discoverable: true, createdAt: now, updatedAt: now,
      });
    }
    if (p === "/v1/recoveries/execute") { seen.executes.push(body); return send(200, { success: true }); }
    if (p === "/v1/recoveries/finalize") { seen.finalizes.push(body); return send(200, { success: true }); }
    send(404, { code: 404, message: `unhandled ${p}` });
  });
});

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

function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL], [`stub :${STUB_PORT}`, `${STUB}/v1/config/getNetworkConfig`]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

try {
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));

  console.log("1/4 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRANSF_RPC_URL: RPC_URL } }).status, 0, "deploy failed");

  console.log("2/4 API with a stub Candide recovery service…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
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
    CANDIDE_COSIGNER_ENABLED: "0",
    CANDIDE_RECOVERY_GUARDIAN_ADDRESS: "",
    CANDIDE_RECOVERY_MODULE_ADDRESS: MODULE,
    RECOVERY_SERVICE_URL: STUB,
    RECOVERY_SIMULATED_GRACE_SECONDS: "2",
    RECOVERY_SWEEP_MS: "3600000",
    ALLOW_SIMULATION: "1",
    KYC_AUTO_APPROVE: "1",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  const health = await call("/api/health");
  assert.equal(health.data.capabilities?.emailSmsRecovery, true, "capability must be published when the service URL is set");

  console.log("3/4 enrolment: email + SMS channels, then the guardian on the Safe…");
  const created = await call("/api/users", { name: "Recovery Rosa", email: EMAIL, country: "DE" });
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
    if (deploy.data.challenge) {
      const submitted = await call(deploy.data.submitTo, await passkey.assert(deploy.data.challenge));
      assert.ok(submitted.status < 300, JSON.stringify(submitted.data));
    }
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.passkeySafe?.status, "active", "the passkey Safe must be active before enrolment");
  }
  const safeAddress: string = (await call(`/api/users/${userId}`)).data.address;

  await t("recovery reports available with no channels and no guardian", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.available, true);
    assert.equal(r.data.guardianStatus, "none");
    assert.deepEqual(r.data.channels, []);
    assert.equal(r.data.gracePeriodSeconds, 180, "the 3-minute module's grace period");
  });

  await t("a malformed phone number is refused before it reaches Candide", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide/channels`, { channel: "sms", target: "12345" });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /international format/);
    assert.equal(seen.registrations.length, 0);
  });

  let emailReg: any;
  await t("registering an email returns a Safe-message challenge over the SIWE statement", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide/channels`, { channel: "email", target: EMAIL.toUpperCase() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.credentialId, passkey.credentialId);
    assert.match(r.data.message, new RegExp(EMAIL), "the statement names the (normalised) target");
    assert.match(r.data.message, /via email/);
    assert.match(r.data.message, new RegExp(safeAddress, "i"), "SIWE is for the Safe, not an EOA");
    assert.equal(r.data.target, "re••••••••@example.com");
    assert.equal(seen.registrations.length, 0, "nothing reaches Candide before the owner signs");
    emailReg = r.data;
  });

  await t("the passkey-signed statement is registered with Candide as an EIP-1271 Safe signature", async () => {
    const r = await call(emailReg.submitTo, await passkey.assert(emailReg.challenge));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.otpSent, true);
    assert.equal(seen.registrations.length, 1);
    const sent = seen.registrations[0];
    assert.equal(sent.account.toLowerCase(), safeAddress.toLowerCase());
    assert.equal(sent.channel, "email");
    assert.equal(sent.target, EMAIL);
    assert.equal(sent.message, emailReg.message, "the very statement the passkey signed");
    assert.match(sent.signature, /^0x[0-9a-f]{200,}$/i, "a Safe contract signature, not a 65-byte EOA one");
    emailReg = { ...emailReg, ...r.data };
  });

  await t("a wrong code is refused and the registration survives for a retry", async () => {
    const r = await call(emailReg.submitTo, { otp: "000000" });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, /not accepted|invalid code/);
  });

  await t("the right code records the channel and Candide's guardian, not yet on the Safe", async () => {
    const r = await call(emailReg.submitTo, { otp: OTP });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.recovery.guardianAddress, GUARDIAN);
    assert.equal(r.data.recovery.guardianStatus, "pending_setup");
    assert.equal(r.data.recovery.channels.length, 1);
    assert.equal(r.data.next, "guardian");
    assert.equal(r.data.recovery.channels[0].target, "re••••••••@example.com", "the channel target is masked");
    assert.equal(r.data.passkeySafe.candideRecovery.channels[0].target, "re••••••••@example.com", "…on the account payload too");
  });

  await t("a lost-device recovery cannot start while the guardian is not on the Safe", async () => {
    const r = await call("/api/recovery/candide", { email: EMAIL }, undefined, "");
    assert.equal(r.status, 404);
  });

  await t("adding the guardian is a user-signed Safe operation that enables the module", async () => {
    const prep = await call(`/api/users/${userId}/recovery/candide/guardian`, {});
    assert.equal(prep.status, 201, JSON.stringify(prep.data));
    assert.equal(prep.data.enablesModule, true);
    assert.equal(prep.data.guardianAddress, GUARDIAN);
    const done = await call(prep.data.submitTo, await passkey.assert(prep.data.challenge));
    assert.equal(done.status, 201, JSON.stringify(done.data));
    assert.equal(done.data.recovery.guardianStatus, "active");
  });

  await t("a phone number is normalised and registered as a second channel", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide/channels`, { channel: "sms", target: PHONE_RAW });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.message, new RegExp(PHONE.replace("+", "\\+")));
    const signed = await call(r.data.submitTo, await passkey.assert(r.data.challenge));
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    const verified = await call(signed.data.submitTo, { otp: OTP });
    assert.equal(verified.status, 201, JSON.stringify(verified.data));
    assert.equal(verified.data.recovery.channels.length, 2);
    assert.equal(verified.data.recovery.guardianStatus, "active", "the guardian is already on the Safe");
    assert.equal(verified.data.next, null);
    assert.equal(seen.registrations[1].target, PHONE);
  });

  await t("the same channel cannot be registered twice", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide/channels`, { channel: "email", target: EMAIL });
    assert.equal(r.status, 409);
  });

  console.log("4/4 recovery from a device with no passkey…");
  const newPasskey = await makePasskey("replacement");
  let recovery: any;

  await t("an unknown email gets a generic refusal", async () => {
    const r = await call("/api/recovery/candide", { email: "nobody@example.com" }, undefined, "");
    assert.equal(r.status, 404);
  });

  await t("starting recovery names the channels (masked) and issues a passkey registration challenge", async () => {
    const r = await call("/api/recovery/candide", { email: EMAIL }, undefined, "");
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, "PASSKEY_PENDING");
    assert.equal(r.data.channels.length, 2);
    assert.ok(!r.text.includes(EMAIL) && !r.text.includes(PHONE), "targets are masked on the public surface");
    assert.ok(r.data.registerChallenge, "a WebAuthn registration challenge bound to this recovery");
    assert.equal(r.data.userHandle, userId);
    recovery = r.data;
  });

  await t("starting again returns the same open recovery rather than a second one", async () => {
    const r = await call("/api/recovery/candide", { email: EMAIL }, undefined, "");
    assert.equal(r.status, 200);
    assert.equal(r.data.id, recovery.id);
  });

  await t("registering the new passkey asks Candide for OTPs on every channel with the new owner set", async () => {
    const r = await call(recovery.submitTo, newPasskey.register(recovery.registerChallenge), undefined, "");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "OTP_PENDING");
    assert.equal(r.data.candide.auths.length, 2);
    assert.equal(r.data.candide.newPasskeyRegistered, true);
    assert.ok(!r.text.includes("attestation"), "the new credential is not on the public surface");
    const req = seen.signatureRequests[0];
    assert.equal(req.account.toLowerCase(), safeAddress.toLowerCase());
    assert.equal(req.newOwners.length, 1, "passkey-only Safe: one new owner");
    assert.match(req.newOwners[0], /^0x[0-9a-fA-F]{40}$/);
    assert.equal(req.newThreshold, 1);
    recovery = r.data;
  });

  await t("the new passkey cannot sign in before the recovery is finalized", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    const r = await call("/api/passkey/login", await newPasskey.assert(challenge.data.challenge), undefined, "");
    assert.equal(r.status, 404, JSON.stringify(r.data));
  });

  await t("one verified channel is not enough — nothing executes", async () => {
    const r = await call(`/api/recovery/candide/${recovery.id}/otp`, { challengeId: recovery.candide.auths[0].challengeId, otp: OTP }, undefined, "");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "OTP_PENDING");
    assert.equal(r.data.candide.auths[0].verified, true);
    assert.equal(seen.creates.length, 0);
  });

  await t("a wrong code on the second channel is refused", async () => {
    const r = await call(`/api/recovery/candide/${recovery.id}/otp`, { challengeId: recovery.candide.auths[1].challengeId, otp: "999999" }, undefined, "");
    assert.equal(r.status, 400);
    assert.equal(seen.creates.length, 0);
  });

  await t("the last channel verified: Candide signs, the recovery is created and executed, the grace period starts", async () => {
    const r = await call(`/api/recovery/candide/${recovery.id}/otp`, { challengeId: recovery.candide.auths[1].challengeId, otp: OTP }, undefined, "");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "GRACE_PERIOD");
    assert.ok(r.data.candide.finalizeAfter);
    assert.ok(seen.networkConfigCalls >= 1, "the module Candide recovers through was read");
    assert.equal(seen.creates.length, 1);
    assert.equal(seen.creates[0].signer, GUARDIAN);
    assert.match(seen.creates[0].signature, /^0xabab/);
    assert.deepEqual(seen.creates[0].newOwners, seen.signatureRequests[0].newOwners);
    assert.equal(seen.executes.length, 1);
    recovery = r.data;
  });

  await t("finalizing inside the grace period is refused", async () => {
    const r = await call(`/api/recovery/candide/${recovery.id}/finalize`, {}, undefined, "");
    assert.equal(r.status, 425, JSON.stringify(r.data));
    assert.equal(seen.finalizes.length, 0);
  });

  await new Promise((r) => setTimeout(r, 2500));

  await t("after the grace period, finalization binds the new passkey and signs this browser in", async () => {
    const r = await call(`/api/recovery/candide/${recovery.id}/finalize`, {}, undefined, "");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, "FINALIZED");
    assert.equal(seen.finalizes.length, 1);
    assert.equal(seen.finalizes[0].id, "rec-1");
    assert.ok(r.data.account?.sessionToken, "a session for the recovering browser");
    assert.equal(r.data.account.id, userId);
    token = r.data.account.sessionToken;
  });

  await t("the lost device's sessions are revoked and its spending key unbound", async () => {
    const old = await call(`/api/users/${userId}`, undefined, undefined, oldToken);
    assert.equal(old.status, 401, JSON.stringify(old.data));
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.status, 200);
    assert.equal(me.data.authorizerAddress, undefined);
  });

  await t("the new passkey signs in; the old one no longer does", async () => {
    const c1 = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    const ok = await call("/api/passkey/login", await newPasskey.assert(c1.data.challenge), undefined, "");
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.id, userId);
    const c2 = await call("/api/webauthn/challenge", { purpose: "login" }, undefined, "");
    const gone = await call("/api/passkey/login", await passkey.assert(c2.data.challenge), undefined, "");
    assert.equal(gone.status, 404);
  });

  await t("the Safe plan now carries the new passkey's public key", async () => {
    const me = await call(`/api/users/${userId}`);
    const x = `0x${Buffer.from(newPasskey.jwk.x!, "base64url").toString("hex")}`;
    assert.equal(me.data.passkeySafe.passkeyPublicKey.x.toLowerCase(), x.toLowerCase());
    assert.equal(me.data.passkeySafe.candideRecovery.guardianStatus, "active", "the channels survive the recovery");
  });

  await t("removing a channel is a Safe-signed request to Candide", async () => {
    const info = await call(`/api/users/${userId}/recovery/candide`);
    const sms = info.data.channels.find((c: any) => c.channel === "sms");
    const prep = await call(`/api/users/${userId}/recovery/candide/channels/${sms.registrationId}`, undefined, "DELETE");
    assert.equal(prep.status, 201, JSON.stringify(prep.data));
    assert.match(prep.data.message, new RegExp(sms.registrationId));
    const done = await call(prep.data.submitTo, await newPasskey.assert(prep.data.challenge));
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.recovery.channels.length, 1);
    assert.equal(seen.deletes[0].registrationId, sms.registrationId);
  });

  await t("cancel refuses when the module holds no pending recovery", async () => {
    const r = await call(`/api/users/${userId}/recovery/candide/cancel`, {});
    assert.equal(r.status, 409);
  });

  console.log(`\nCANDIDE RECOVERY TEST PASSED — ${pass}/${pass}`);
  console.log("NOT covered here: the on-chain half (module enable, guardian add, execute, finalize against the real 3-minute");
  console.log("module) and a real OTP — those need RECOVERY_SERVICE_URL from Candide and a Base Sepolia Safe.");
} finally {
  for (const c of children) c.kill("SIGTERM");
  stub.close();
}
