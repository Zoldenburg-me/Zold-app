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
const BUSINESS_PROFILE_ID = "profile-own-business";
// A Monerium profile has ONE IBAN. This account's personal profile already
// has one, pointed at a wallet outside Zold, so POST /ibans answers 304 and
// the only way to fund the Safe is to MOVE that IBAN (PATCH /ibans/{iban}).
const EXISTING_IBAN = "DE89370400440532013000";
const OLD_ADDRESS = "0x00000000000000000000000000000000000000ff";
const OLD_CHAIN = "gnosis";
// The business profile's IBAN: on the user's own connection, but not under
// the profile the Safe is linked to, so it must not be movable from here.
const BUSINESS_IBAN = "DE02120300000000202051";
// On nobody's profile that this connection can see.
const FOREIGN_IBAN = "DE02500105170137075030";
const DEPOSIT_EUR = "42.5";

let token = "";
const children: ChildProcess[] = [];

/** What the stub saw, so assertions can inspect the real protocol exchange. */
const seen = {
  tokenGrants: [] as { clientId: string; secretOk: boolean; grant: string }[],
  bearers: new Set<string>(),
  unauthorised: 0,
  linkedAddress: "",
  linkSignature: "",
  linkedProfile: "",
  ibanRequestedFor: "",
  ibanRequestAnswered: 0,
  patches: [] as { iban: string; address: string; chain: string }[],
  orderReadsByProfile: [] as (string | null)[],
  /** Which of the login's two profiles GET /profiles lists. */
  profilesShown: "both" as "both" | "corporate" | "personal",
};

/** The account's IBANs as Monerium holds them; PATCH moves one. */
const ibans = [
  { iban: EXISTING_IBAN, bic: "MONEDEFF", profile: PROFILE_ID, address: OLD_ADDRESS, chain: OLD_CHAIN },
  { iban: BUSINESS_IBAN, bic: "MONEDEFF", profile: BUSINESS_PROFILE_ID, address: "0x00000000000000000000000000000000000000ee", chain: OLD_CHAIN },
];
const compact = (v: string) => v.replace(/\s+/g, "").toUpperCase();
const safeHoldsIban = () =>
  Boolean(seen.linkedAddress) &&
  ibans.some((i) => i.iban === EXISTING_IBAN && i.address.toLowerCase() === seen.linkedAddress.toLowerCase());

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
    if (url.pathname === "/profiles") {
      // Corporate first, so "the first approved profile" would pick the
      // wrong one for a personal account: only the signup kind may decide.
      const all = [
        { id: BUSINESS_PROFILE_ID, kind: "corporate", state: "approved" },
        { id: PROFILE_ID, kind: "personal", state: "approved" },
      ];
      return send(200, { profiles: all.filter((p) =>
        seen.profilesShown === "both" || p.kind === seen.profilesShown) });
    }

    if (url.pathname.startsWith("/addresses/")) {
      const addr = decodeURIComponent(url.pathname.slice("/addresses/".length)).toLowerCase();
      if (seen.linkedAddress && addr === seen.linkedAddress.toLowerCase()) {
        return send(200, { address: seen.linkedAddress, chain: "sepolia", profile: seen.linkedProfile || PROFILE_ID });
      }
      return send(404, { error: "address not linked" });
    }
    if (url.pathname === "/addresses") {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.linkedAddress = body.address ?? "";
        seen.linkSignature = body.signature ?? "";
        seen.linkedProfile = body.profile ?? PROFILE_ID;
        return send(201, { address: body.address, chain: body.chain, profile: body.profile });
      }
      return send(200, { addresses: seen.linkedAddress ? [{ address: seen.linkedAddress, chain: "sepolia", profile: PROFILE_ID }] : [] });
    }

    if (url.pathname === "/ibans") {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.ibanRequestedFor = body.address ?? "";
        // One IBAN per profile: Monerium answers 304 (no body) when the
        // profile the address is linked under already has one.
        if (ibans.some((i) => i.profile === (seen.linkedProfile || PROFILE_ID))) {
          seen.ibanRequestAnswered = 304;
          res.writeHead(304);
          return res.end();
        }
        seen.ibanRequestAnswered = 201;
        return send(201, { address: body.address });
      }
      return send(200, { ibans });
    }
    if (url.pathname.startsWith("/ibans/") && req.method === "PATCH") {
      const iban = compact(decodeURIComponent(url.pathname.slice("/ibans/".length)));
      const body = JSON.parse(raw || "{}");
      seen.patches.push({ iban, address: body.address ?? "", chain: body.chain ?? "" });
      const rec = ibans.find((i) => i.iban === iban);
      if (!rec) return send(404, { message: "IBAN not found" });
      // Monerium moves an IBAN only to an address linked under its profile.
      const linkedUnder = seen.linkedAddress.toLowerCase() === String(body.address ?? "").toLowerCase() ? seen.linkedProfile : "";
      if (linkedUnder !== rec.profile) return send(400, { message: "address is not linked to the IBAN's profile" });
      rec.address = body.address;
      rec.chain = body.chain;
      return send(202, {});
    }

    // A processed issue order (a SEPA deposit that minted EURe) appears on the
    // user's account once their IBAN pays into the Safe — visible on THEIR token only.
    const order = safeHoldsIban()
      ? {
          id: "order-own-account-1",
          kind: "issue",
          amount: DEPOSIT_EUR,
          currency: "eur",
          address: seen.linkedAddress,
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
const failed: string[] = [];
/* A failing case is reported and the run goes on, so one run shows every case
 * that fails (the move-IBAN cases were each shown failing before the route
 * existed). The process still exits non-zero on any failure. */
const t = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${label}`);
  } catch (err: any) {
    failed.push(label);
    console.log(`  FAIL  ${label}\n        ${String(err?.message ?? err).split("\n")[0]}`);
  }
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
    MONERIUM_CHAIN: "sepolia", // the stub issues on sepolia; the chain filter must see the same name
    MONERIUM_AUTH_URL: `${STUB}/auth`,
    MONERIUM_REDIRECT_URI: `${API}/api/monerium/oauth/callback`,
    MONERIUM_TOKEN_ENCRYPTION_KEY: ENC_KEY,
    MONERIUM_POLL_MS: "1000",
    CANDIDE_CHAIN_ID: "31337",
    CANDIDE_RPC_URL: RPC_URL,
    // Blank on purpose: a passkey-only Safe links to Monerium with no
    // co-signer key at all.
    CANDIDE_ALLOWANCE_MODULE_ADDRESS: "0x691f59471Bfd2B7d639DCF74671a2d648ED1E331",
    CANDIDE_RECOVERY_GUARDIAN_ADDRESS: "",
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
    assert.equal(h.data.capabilities.sandbox, true, "deposits are always real Monerium transfers now — there is no mock mode");
    assert.ok(["sandbox", "production", "custom"].includes(h.data.capabilities.moneriumEnvironment));
    assert.equal(h.data.capabilities.moneriumHost, `127.0.0.1:${STUB_PORT}`);
  });

  const created = await call("/api/users", { name: "Own Account Tester", email: "own.keys@example.com", country: "DE" });
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

  await t("a personal account whose Monerium login has only a company profile is refused, and NOTHING is stored", async () => {
    seen.profilesShown = "corporate";
    try {
      const r = await call(`/api/users/${userId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: USER_SECRET });
      assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);
      assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISSING");
      assert.match(r.data.error, /personal, so it uses your personal profile/);
      assert.match(r.data.error, /support@zoldhq\.com/);
      const me = await call(`/api/users/${userId}`);
      assert.equal(me.data.monerium, undefined, "a refused connect must leave no connection behind");
      assert.ok(!readFileSync(process.env.TRANSF_DB_PATH!, "utf8").includes("clientSecretEnc"), "a refused secret must not be written");
    } finally {
      seen.profilesShown = "both";
    }
  });

  await t("the right keys are verified against Monerium and connected", async () => {
    const r = await call(`/api/users/${userId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: USER_SECRET, label: "my sandbox app" });
    assert.equal(r.status, 201, `connect failed: ${r.text}`);
    assert.equal(r.data.monerium.method, "api_keys");
    assert.equal(r.data.monerium.apiKeys.clientId, USER_CLIENT_ID);
    assert.equal(r.data.monerium.apiKeys.label, "my sandbox app");
    assert.equal(r.data.monerium.apiKeys.accountEmail, "owner@example.com");
    assert.ok(r.data.monerium.apiKeys.verifiedAt, "verification time should be recorded");
    assert.equal(r.data.monerium.profileId, PROFILE_ID, "a personal account uses its personal profile, though a corporate one is listed first");
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
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "sepa" });
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

  let count = 1;
  /** A fresh passkey assertion for a move, from its own link-signature start. */
  const moveCeremony = async (iban: string) => {
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: PROFILE_ID, purpose: "move-iban", iban });
    assert.equal(start.status, 201, `link-signature start failed: ${start.text}`);
    assert.equal(start.data.submitTo, `/api/users/${userId}/monerium/move-iban`);
    return { requestId: start.data.requestId, ...(await passkey.assert(start.data.challenge, ++count)) };
  };
  let safeAddress = "";

  await t("the company profile on the same login cannot be named at activation", async () => {
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: BUSINESS_PROFILE_ID });
    assert.equal(start.status, 409, `expected 409, got ${start.status}: ${start.text}`);
    assert.equal(start.data.code, "MONERIUM_PROFILE_NOT_CONNECTED");
    assert.equal(seen.linkedAddress, "", "nothing may be linked under the other profile");
  });

  await t("activate on a profile that already has an IBAN answers IBAN_EXISTS_ELSEWHERE, not an error", async () => {
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    safeAddress = start.data.address;
    const approval = await passkey.assert(start.data.challenge, count);
    const r = await call(`/api/users/${userId}/monerium/activate`, {
      profileId: PROFILE_ID,
      linkSignatureRequestId: start.data.requestId,
      ...approval,
    });
    assert.equal(seen.linkedAddress.toLowerCase(), safeAddress.toLowerCase(), "must link the app's Safe address");
    assert.ok(seen.linkSignature.startsWith("0x"));
    assert.equal(seen.ibanRequestAnswered, 304, "the stub must have answered the IBAN request with 304");
    assert.equal(r.status, 409, `expected 409 IBAN_EXISTS_ELSEWHERE, got ${r.status}: ${r.text}`);
    assert.equal(r.data.code, "IBAN_EXISTS_ELSEWHERE");
    assert.equal(r.data.existing.iban, EXISTING_IBAN);
    assert.equal(r.data.existing.address.toLowerCase(), OLD_ADDRESS);
    assert.equal(r.data.existing.chain, OLD_CHAIN);
    assert.equal(r.data.existing.profileId, PROFILE_ID);
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.iban, "", "an IBAN attributed to another address is never this account's");
    assert.equal(me.data.kycStatus, "pending");
    assert.match(me.data.funding.detail ?? "", /already has an IBAN/);
    assert.equal(seen.patches.length, 0, "activate never moves an IBAN");
    assert.equal(seen.unauthorised, 0, "no call reached the stub without the user's token");
  });

  await t("move-iban refuses without the typed confirmation", async () => {
    const ceremony = await moveCeremony(EXISTING_IBAN);
    for (const confirm of [undefined, "", "move", "yes"]) {
      const r = await call(`/api/users/${userId}/monerium/move-iban`, { iban: EXISTING_IBAN, ...(confirm === undefined ? {} : { confirm }), ...ceremony });
      assert.equal(r.status, 400, `confirm=${JSON.stringify(confirm)}: expected 400, got ${r.status}: ${r.text}`);
      assert.match(r.data.error, /MOVE/);
    }
    assert.equal(seen.patches.length, 0);
  });

  await t("move-iban refuses without a fresh passkey assertion", async () => {
    const none = await call(`/api/users/${userId}/monerium/move-iban`, { iban: EXISTING_IBAN, confirm: "MOVE" });
    assert.equal(none.status, 409, `no assertion: ${none.text}`);
    assert.match(none.data.error, /fresh passkey/);
    // An activation challenge is not a move approval.
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    const activation = { requestId: start.data.requestId, ...(await passkey.assert(start.data.challenge, ++count)) };
    const wrongPurpose = await call(`/api/users/${userId}/monerium/move-iban`, { iban: EXISTING_IBAN, confirm: "MOVE", ...activation });
    assert.equal(wrongPurpose.status, 409, `activation challenge: ${wrongPurpose.text}`);
    // A move approved for one IBAN does not move another.
    const other = await moveCeremony(BUSINESS_IBAN);
    const wrongIban = await call(`/api/users/${userId}/monerium/move-iban`, { iban: EXISTING_IBAN, confirm: "MOVE", ...other });
    assert.equal(wrongIban.status, 409, `ceremony for another IBAN: ${wrongIban.text}`);
    // Single use.
    const ceremony = await moveCeremony(FOREIGN_IBAN);
    await call(`/api/users/${userId}/monerium/move-iban`, { iban: FOREIGN_IBAN, confirm: "MOVE", ...ceremony });
    const replay = await call(`/api/users/${userId}/monerium/move-iban`, { iban: FOREIGN_IBAN, confirm: "MOVE", ...ceremony });
    assert.equal(replay.status, 409, `replayed ceremony: ${replay.text}`);
    assert.match(replay.data.error, /fresh passkey/);
    assert.equal(seen.patches.length, 0);
  });

  await t("move-iban refuses an IBAN that is not on the Safe's profile", async () => {
    for (const iban of [FOREIGN_IBAN, BUSINESS_IBAN]) {
      const r = await call(`/api/users/${userId}/monerium/move-iban`, { iban, confirm: "MOVE", ...(await moveCeremony(iban)) });
      assert.equal(r.status, 409, `${iban}: expected 409, got ${r.status}: ${r.text}`);
      assert.equal(r.data.code, "IBAN_NOT_ON_PROFILE", `${iban}: ${r.text}`);
    }
    assert.equal(seen.patches.length, 0, "nothing may be moved");
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.iban, "");
    assert.equal(me.data.kycStatus, "pending");
  });

  await t("move-iban moves the IBAN to the Safe and approves the account on Monerium's re-read", async () => {
    const r = await call(`/api/users/${userId}/monerium/move-iban`, {
      iban: "de89 3704 0044 0532 0130 00", // as typed; the stored value comes from Monerium's re-read
      confirm: "MOVE",
      ...(await moveCeremony(EXISTING_IBAN)),
    });
    assert.equal(r.status, 200, `move failed: ${r.text}`);
    assert.deepEqual(seen.patches, [{ iban: EXISTING_IBAN, address: safeAddress, chain: "sepolia" }], "PATCH must carry the Safe address and MONERIUM.chain");
    assert.equal(r.data.iban, EXISTING_IBAN);
    assert.equal(r.data.kycStatus, "approved", "Monerium now attributes the IBAN to this Safe");
    assert.equal(r.data.funding.status, "active");
    const move = r.data.moneriumIbanMoves?.[0];
    assert.ok(move, "the move is recorded on the user");
    assert.equal(move.iban, EXISTING_IBAN);
    assert.equal(move.fromAddress.toLowerCase(), OLD_ADDRESS);
    assert.equal(move.fromChain, OLD_CHAIN);
    assert.equal(move.toAddress.toLowerCase(), safeAddress.toLowerCase());
    assert.equal(move.profileId, PROFILE_ID);
    assert.ok(move.requestedAt && move.confirmedAt, "request and confirmation times are recorded");
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
    assert.equal(r.data.iban, EXISTING_IBAN, "the IBAN Monerium attributes to the Safe still exists and stays recorded");
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

  // A company signing up on a Monerium login that holds both profiles.
  const company = await call("/api/users", {
    name: "Own Keys GmbH", email: "company.keys@example.com", country: "DE", accountType: "company",
    companyIncorporationCountry: "DE", usAnswers: { usPerson: false, companyUsNexus: false },
  });
  assert.equal(company.status, 201, `company signup failed: ${company.text}`);
  const companyId = company.data.id;
  token = company.data.sessionToken;

  await t("a company account whose Monerium login has only a personal profile is refused, and nothing is stored", async () => {
    seen.profilesShown = "personal";
    try {
      const r = await call(`/api/users/${companyId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: USER_SECRET });
      assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);
      assert.equal(r.data.code, "MONERIUM_PROFILE_KIND_MISSING");
      assert.match(r.data.error, /for a company, so it uses your company's profile/);
      assert.equal((await call(`/api/users/${companyId}`)).data.monerium, undefined);
    } finally {
      seen.profilesShown = "both";
    }
  });

  await t("a company account uses its corporate profile and never the personal one on the same login", async () => {
    const r = await call(`/api/users/${companyId}/monerium/api-keys`, { clientId: USER_CLIENT_ID, clientSecret: USER_SECRET });
    assert.equal(r.status, 201, `connect failed: ${r.text}`);
    assert.equal(r.data.monerium.profileId, BUSINESS_PROFILE_ID);
    assert.equal(r.data.funding.moneriumProfileId, BUSINESS_PROFILE_ID);
  });

  if (failed.length) {
    console.log(`\nMONERIUM API-KEYS TEST FAILED — ${failed.length} case(s):\n  - ${failed.join("\n  - ")}`);
    process.exitCode = 1;
  } else console.log(`\nMONERIUM API-KEYS TEST PASSED — ${pass}/${pass}: keys verified before storage, secret encrypted, activation + deposit polling on the user's own credentials`);
  console.log("note: a real Monerium app's client-credentials token against api.monerium.dev is still");
  console.log("      needed to prove it carries the account owner's scope (profiles, ibans, orders).");
} finally {
  for (const c of children) c.kill();
  stub.close();
}
