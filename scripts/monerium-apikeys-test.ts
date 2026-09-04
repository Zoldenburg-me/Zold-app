/**
 * Monerium own-API-keys connector test.
 *
 * A user pastes the client id + secret of an app created in THEIR Monerium
 * account. The server must prove the pair against Monerium before storing it,
 * keep the secret encrypted and out of every response, and then run
 * activation and deposit polling on that credential — because the user's
 * profile, IBAN and orders are invisible to the app's own keys.
 *
 * The stub Monerium here issues a token ONLY for the one known id/secret pair
 * and answers every other endpoint only to that token. The API is started
 * with NO app secret at all, so if anything below still worked on the app's
 * credentials it would fail here with a 401 from the stub.
 *
 * What this cannot prove: that a real Monerium app's client-credentials token
 * carries the same scope as the account owner's session (their docs say it
 * does; one run against api.monerium.dev with real keys settles it).
 *
 * Run: npm run monerium:apikeys:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3001);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const STUB_PORT = Number(process.env.TRANSF_STUB_PORT ?? 8549);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ENC_KEY = "test-monerium-token-encryption-key-32b";
const bin = (n: string) => (n === "tsx" ? path.join(ROOT, "node_modules/tsx/dist/cli.mjs") : path.join(ROOT, "node_modules/.bin", n));

const USER_CLIENT_ID = "usr_app_" + randomBytes(6).toString("hex");
const USER_SECRET = "usr_secret_" + randomBytes(16).toString("hex");
const USER_TOKEN = "user-token-" + randomBytes(8).toString("hex");
const PROFILE_ID = "profile-own-account";
const EXISTING_IBAN = "DE89370400440532013000";
const APP_IBAN = "IS140159260076545510730339";
const DEPOSIT_EUR = "42.5";
const COSIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const COSIGNER_ADDRESS = privateKeyToAccount(COSIGNER_KEY).address;

let token = "";
const children: ChildProcess[] = [];

/** What the stub saw, so assertions can inspect the real protocol exchange. */
const seen = {
  tokenGrants: [] as { clientId: string; secretOk: boolean; grant: string }[],
  bearers: new Set<string>(),
  unauthorised: 0,
  linkedAddress: "",
  linkSignature: "",
  ibanRequestedFor: "",
  orderReadsByProfile: [] as (string | null)[],
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
function clientData(type: string, challenge: string) {
  return b64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));
}

async function makePasskey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = enc(new Map<number, any>([
    [1, 2], [3, -7], [-1, 1],
    [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)],
  ]));
  const credId = Buffer.from("monerium-apikeys-passkey-001");
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
  return {
    credentialId: b64url(credId),
    register: (challenge: string) => ({
      credentialId: b64url(credId),
      attestation: b64url(enc(new Map<string, any>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData(0x41, 0, true)],
      ]))),
      clientDataJSON: clientData("webauthn.create", challenge),
    }),
    assert: async (challenge: string, count: number) => {
      const clientDataJSON = clientData("webauthn.get", challenge);
      const authenticatorData = authData(0x05, count);
      const raw = Buffer.from(await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        Buffer.concat([authenticatorData, sha256(unb64url(clientDataJSON))]),
      ));
      return {
        credentialId: b64url(credId),
        authenticatorData: b64url(authenticatorData),
        clientDataJSON,
        signature: b64url(rawToDer(raw)),
      };
    },
  };
}

/* A stub that plays both Monerium and the Candide RPC. The RPC half only has
 * to answer eth_getCode so `activate` believes the Safe is already deployed. */
const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", STUB);
  const auth = req.headers.authorization ?? "";

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (raw.includes("eth_getCode")) {
      return send(200, { jsonrpc: "2.0", id: 1, result: "0x6080604052" });
    }
    // Public, unauthenticated — the EURe token list the deploy/mirror consults.
    if (url.pathname === "/tokens") return send(200, []);

    if (url.pathname === "/auth/token") {
      const body = new URLSearchParams(raw);
      const clientId = body.get("client_id") ?? "";
      const secretOk = clientId === USER_CLIENT_ID && body.get("client_secret") === USER_SECRET;
      seen.tokenGrants.push({ clientId, secretOk, grant: body.get("grant_type") ?? "" });
      if (!secretOk) return send(401, { error: "invalid_client", message: "unknown client or bad secret" });
      return send(200, { access_token: USER_TOKEN, expires_in: 3600, token_type: "Bearer" });
    }

    // Everything below belongs to the user's account and answers ONLY to the
    // token minted for the user's own keys.
    if (auth !== `Bearer ${USER_TOKEN}`) {
      seen.unauthorised++;
      return send(401, { error: "unauthorized" });
    }
    seen.bearers.add(auth.slice(7));

    if (url.pathname === "/auth/context") return send(200, { userId: "monerium-owner-1", email: "owner@example.com" });
    if (url.pathname === "/profiles") return send(200, { profiles: [{ id: PROFILE_ID, kind: "personal", state: "approved" }] });

    if (url.pathname.startsWith("/addresses/")) {
      const addr = decodeURIComponent(url.pathname.slice("/addresses/".length)).toLowerCase();
      if (seen.linkedAddress && addr === seen.linkedAddress.toLowerCase()) {
        return send(200, { address: seen.linkedAddress, chain: "sepolia", profile: PROFILE_ID });
      }
      return send(404, { error: "address not linked" });
    }
    if (url.pathname === "/addresses") {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.linkedAddress = body.address ?? "";
        seen.linkSignature = body.signature ?? "";
        return send(201, { address: body.address, chain: body.chain, profile: body.profile });
      }
      return send(200, { addresses: seen.linkedAddress ? [{ address: seen.linkedAddress, chain: "sepolia", profile: PROFILE_ID }] : [] });
    }

    if (url.pathname === "/ibans") {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.ibanRequestedFor = body.address ?? "";
        return send(201, { iban: APP_IBAN, address: body.address });
      }
      const list: any[] = [{ iban: EXISTING_IBAN, address: "0x00000000000000000000000000000000000000ff", profile: PROFILE_ID }];
      if (seen.ibanRequestedFor) list.push({ iban: APP_IBAN, address: seen.ibanRequestedFor, profile: PROFILE_ID });
      return send(200, { ibans: list });
    }

    // A processed issue order (a SEPA deposit that minted EURe) appears on the
    // user's account once their app IBAN exists — visible on THEIR token only.
    const order = seen.ibanRequestedFor
      ? {
          id: "order-own-account-1",
          kind: "issue",
          amount: DEPOSIT_EUR,
          currency: "eur",
          address: seen.ibanRequestedFor,
          chain: "sepolia",
          state: "processed",
          meta: { state: "processed" },
        }
      : null;
    if (url.pathname === "/orders") {
      seen.orderReadsByProfile.push(url.searchParams.get("profile"));
      return send(200, { orders: order ? [order] : [] });
    }
    if (url.pathname.startsWith("/orders/")) {
      return order ? send(200, order) : send(404, { error: "no such order" });
    }
    send(404, { error: "unhandled: " + url.pathname });
  });
});

async function call(pathname: string, body?: any, method?: string) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    method: method ?? (body ? "POST" : "GET"),
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers,
    redirect: "manual",
  });
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

for (const [name, url] of [
  [`api :${API_PORT}`, `${API}/api/health`],
  [`chain :${RPC_PORT}`, RPC_URL],
  [`stub :${STUB_PORT}`, `${STUB}/tokens`],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

try {
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));

  console.log("1/3 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(
    spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TRANSF_RPC_URL: RPC_URL } }).status,
    0,
    "deploy failed",
  );

  console.log("2/3 API with NO app secret — only a user's own keys can reach the stub…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    TRANSF_API_PORT: String(API_PORT),
    TRANSF_RPC_URL: RPC_URL,
    PORT: String(API_PORT),
    RP_ID: "localhost",
    WEBAUTHN_ORIGINS: `${API},http://localhost:${API_PORT}`,
    MONERIUM_CLIENT_ID: "stub-app-without-secret",
    MONERIUM_CLIENT_SECRET: "",
    MONERIUM_BASE_URL: STUB,
    MONERIUM_AUTH_URL: `${STUB}/auth`,
    MONERIUM_REDIRECT_URI: `${API}/api/monerium/oauth/callback`,
    MONERIUM_TOKEN_ENCRYPTION_KEY: ENC_KEY,
    MONERIUM_POLL_MS: "1000",
    CANDIDE_CHAIN_ID: "31337",
    CANDIDE_RPC_URL: RPC_URL,
    CANDIDE_COSIGNER_ENABLED: "0",
    CANDIDE_COSIGNER_ADDRESS: COSIGNER_ADDRESS,
    CANDIDE_COSIGNER_KEY: COSIGNER_KEY,
    CANDIDE_ALLOWANCE_MODULE_ADDRESS: "0x691f59471Bfd2B7d639DCF74671a2d648ED1E331",
    CANDIDE_RECOVERY_GUARDIAN_ADDRESS: "",
    ALLOW_SIMULATION: "1",
    KYC_AUTO_APPROVE: "0",
    MG_ANCHOR_DOMAIN: "",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("3/3 driving the connector…");

  await t("health advertises the connector and which Monerium environment keys must come from", async () => {
    const h = await call("/api/health");
    assert.equal(h.data.capabilities.moneriumApiKeys, true);
    assert.equal(h.data.capabilities.sandbox, false, "no app secret: the deployment itself is in mock mode");
    assert.ok(["sandbox", "production", "custom"].includes(h.data.capabilities.moneriumEnvironment));
    assert.equal(h.data.capabilities.moneriumHost, `127.0.0.1:${STUB_PORT}`);
  });

  const created = await call("/api/users", { name: "Own Account Tester", country: "DE" });
  assert.equal(created.status, 201);
  const userId = created.data.id;
  token = created.data.sessionToken;
  assert.equal(created.data.kycStatus, "pending");
  const passkey = await makePasskey();

  await t("malformed input is refused before Monerium is asked", async () => {
    const r = await call(`/api/users/${userId}/monerium/api-keys`, { clientId: "x", clientSecret: "short" });
    assert.equal(r.status, 400);
    assert.equal(seen.tokenGrants.length, 0, "nothing should have reached the stub");
  });

  await t("a wrong secret is refused by Monerium and NOTHING is stored", async () => {
    const r = await call(`/api/users/${userId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: "usr_secret_definitely_wrong" });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.match(r.data.error, /rejected these credentials/);
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.monerium, undefined, "a refused credential must leave no connection behind");
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes("clientSecretEnc"), "a refused secret must not be written, even encrypted");
  });

  await t("the right keys are verified against Monerium and connected", async () => {
    const r = await call(`/api/users/${userId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: USER_SECRET, label: "my sandbox app" });
    assert.equal(r.status, 201, `connect failed: ${r.text}`);
    assert.equal(r.data.monerium.method, "api_keys");
    assert.equal(r.data.monerium.apiKeys.clientId, USER_CLIENT_ID);
    assert.equal(r.data.monerium.apiKeys.label, "my sandbox app");
    assert.equal(r.data.monerium.apiKeys.accountEmail, "owner@example.com");
    assert.ok(r.data.monerium.apiKeys.verifiedAt, "verification time should be recorded");
    assert.equal(r.data.monerium.profileId, PROFILE_ID);
    assert.equal(r.data.funding.mode, "sandbox", "an account on real Monerium is not in mock mode");
    assert.equal(r.data.kycStatus, "pending", "connecting keys is not identity approval");
    assert.ok(seen.tokenGrants.some((g) => g.clientId === USER_CLIENT_ID && g.secretOk && g.grant === "client_credentials"));
  });

  await t("the secret is encrypted at rest — plaintext never touches db.json", async () => {
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes(USER_SECRET), "client secret found in plaintext in db.json");
    assert.ok(db.includes("clientSecretEnc"), "expected an encrypted secret field");
  });

  await t("no endpoint returns the secret or even its ciphertext", async () => {
    const me = await call(`/api/users/${userId}`);
    assert.ok(!me.text.includes(USER_SECRET), "secret leaked to the client");
    assert.ok(!me.text.includes("clientSecretEnc"), "ciphertext leaked to the client");
    assert.ok(!me.text.includes(USER_TOKEN), "bearer token leaked to the client");
    assert.equal(me.data.monerium.apiKeys.clientId, USER_CLIENT_ID, "the client id is fine to show");
  });

  await t("accounts are read on the user's own token, not the app's", async () => {
    const r = await call(`/api/users/${userId}/monerium/accounts`);
    assert.equal(r.status, 200, `accounts failed: ${r.text}`);
    assert.ok(r.data.ibans.some((i: any) => i.iban === EXISTING_IBAN), "expected the account's pre-existing IBAN");
    assert.deepEqual([...seen.bearers], [USER_TOKEN], "only the user's token should ever reach the stub");
    assert.ok(!seen.tokenGrants.some((g) => g.clientId === "stub-app-without-secret"), "the app's credentials must not be tried");
  });

  await t("the user still cannot quote — connecting is not approval", async () => {
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" });
    assert.equal(r.status, 409);
  });

  await t("passkey Safe is activated before Monerium linking", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    assert.equal(challenge.status, 200);
    const registered = await call(`/api/users/${userId}/passkey`, passkey.register(challenge.data.challenge));
    assert.equal(registered.status, 201, `passkey registration failed: ${registered.data.error ?? ""}`);
    let activated = await call(`/api/users/${userId}/passkey-safe/deployment`, {});
    assert.ok([200, 201].includes(activated.status), `passkey Safe activation failed: ${activated.data.error ?? ""}`);
    if (activated.data.requestId) {
      const assertion = await passkey.assert(activated.data.challenge, 1);
      const submitRes = await call(activated.data.submitTo, assertion);
      assert.equal(submitRes.status, 201, `passkey Safe deployment submission failed: ${submitRes.data.error ?? ""}`);
      activated = submitRes;
    }
    assert.equal(activated.data.passkeySafe.status, "active");
  });

  await t("activate links the Safe and requests the app IBAN under the user's own credentials", async () => {
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    const approval = await passkey.assert(start.data.challenge, 1);
    const r = await call(`/api/users/${userId}/monerium/activate`, {
      profileId: PROFILE_ID,
      linkSignatureRequestId: start.data.requestId,
      ...approval,
    });
    assert.equal(r.status, 200, `activate failed: ${r.data.error ?? ""}`);
    assert.equal(seen.linkedAddress.toLowerCase(), start.data.address.toLowerCase(), "must link the app's Safe address");
    assert.ok(seen.linkSignature.startsWith("0x"));
    assert.equal(seen.ibanRequestedFor.toLowerCase(), start.data.address.toLowerCase());
    assert.equal(r.data.iban, APP_IBAN);
    assert.equal(r.data.kycStatus, "approved", "an address-matched IBAN on the user's own account approves it, as with OAuth");
    assert.equal(r.data.funding.status, "active");
    assert.equal(seen.unauthorised, 0, "no call reached the stub without the user's token");
  });

  await t("a deposit on the user's account is polled on their credentials and credited locally", async () => {
    let balance = 0;
    for (const s = Date.now(); Date.now() - s < 20_000; ) {
      const me = await call(`/api/users/${userId}`);
      balance = Number(me.data.balanceEur ?? 0);
      if (balance >= Number(DEPOSIT_EUR)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(balance >= Number(DEPOSIT_EUR), `deposit was not credited within 20s (balance ${balance})`);
    assert.ok(seen.orderReadsByProfile.includes(PROFILE_ID), "orders should be read scoped to the user's profile");
    assert.ok(seen.orderReadsByProfile.includes(null), "and unscoped, for the account's default profile");
    assert.equal(seen.unauthorised, 0);
  });

  await t("removing the keys drops them from the store and closes the connection", async () => {
    const r = await call(`/api/users/${userId}/monerium/api-keys`, undefined, "DELETE");
    assert.equal(r.status, 200, `remove failed: ${r.text}`);
    assert.equal(r.data.monerium, undefined);
    assert.equal(r.data.iban, APP_IBAN, "the IBAN Monerium issued still exists and stays recorded");
    assert.match(r.data.funding.detail ?? "", /keys removed/);
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes("clientSecretEnc"), "encrypted secret should be dropped on removal");
    const again = await call(`/api/users/${userId}/monerium/api-keys`, undefined, "DELETE");
    assert.equal(again.status, 409, "removing twice is a mistake worth naming");
  });

  await t("without keys or an app secret the account's Monerium calls refuse rather than pretend", async () => {
    const r = await call(`/api/users/${userId}/monerium/accounts`);
    assert.ok(r.status >= 400, "reading accounts with no credential must fail");
    assert.equal(seen.unauthorised, 0, "and must not have guessed at the stub with a made-up token");
  });

  console.log(`\nMONERIUM API-KEYS TEST PASSED — ${pass}/${pass}: keys verified before storage, secret encrypted, activation + deposit polling on the user's own credentials`);
  console.log("note: a real Monerium app's client-credentials token against api.monerium.dev is still");
  console.log("      needed to prove it carries the account owner's scope (profiles, ibans, orders).");
} finally {
  for (const c of children) c.kill();
  stub.close();
}
