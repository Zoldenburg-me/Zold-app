/**
 * Monerium existing-account connect (OAuth) test.
 *
 * The connect flow (five endpoints) lets a user who already has a Monerium
 * account attach it without repeating KYC. This checks that PKCE works, that
 * tokens stay encrypted, and that activation issues an app IBAN.
 *
 * It drives the whole loop against a stub Monerium that verifies the PKCE
 * challenge itself (S256 of the verifier presented at exchange must equal the
 * challenge sent at start), so a flow that only adds a challenge to the URL
 * fails here.
 *
 * Not covered (needs a real Monerium account in a browser): whether Monerium's
 * authorize page accepts our client_id/redirect_uri registration, and whether
 * its real token response matches this shape.
 *
 * Run: npm run monerium:oauth:test
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

const ACCESS_TOKEN = "stub-access-token-" + randomBytes(8).toString("hex");
const REFRESH_TOKEN = "stub-refresh-token-" + randomBytes(8).toString("hex");
const AUTH_CODE = "stub-auth-code";
const PROFILE_ID = "profile-existing-user";
// The user's other profile, whose IBAN predates Zold and pays a wallet
// outside it. It is on the user's connection but not under the profile a
// Safe here is linked to, so it can be neither shown as this account's nor
// moved from it.
const BUSINESS_PROFILE_ID = "profile-existing-business";
const EXISTING_IBAN = "GB33BUKB20201555555555";
const APP_IBAN = "IS140159260076545510730339";
// A second IBAN on PROFILE_ID, as a sandbox test login can hold.
const SPARE_IBAN = "DE89370400440532013000";

let token = "";
const children: ChildProcess[] = [];

/** What the stub saw, so assertions can inspect the real protocol exchange. */
const seen = {
  codeChallenge: "",
  codeVerifier: "",
  redirectUriAtStart: "",
  redirectUriAtExchange: "",
  grantTypes: [] as string[],
  clientSecrets: [] as string[],
  linkedAddress: "",
  linkMessage: "",
  linkSignature: "",
  ibanRequestedFor: "",
  ibanRequestAnswers: [] as number[],
  // Monerium issues an IBAN some time after the request, as the sandbox does.
  ibanIssued: false,
  /** address (lowercase) -> the profile it was linked under */
  links: new Map<string, string>(),
  patches: [] as { iban: string; address: string; chain: string }[],
  // Whether an accepted PATCH shows on the next GET /ibans. When false, the
  // move is accepted but a re-read still shows the old address.
  patchSettles: true,
  pendingPatch: null as null | { iban: string; address: string; chain: string },
  bearerTokens: [] as string[],
  // The sandbox has answered 201 to POST /ibans for a profile that already
  // has its one IBAN on another address. False reproduces that.
  ibanPostRefusesSecond: true,
};

/** One IBAN per profile, as Monerium holds them. */
const ibanRecords: { iban: string; profile: string; address: string; chain: string }[] = [
  { iban: EXISTING_IBAN, profile: BUSINESS_PROFILE_ID, address: "0x00000000000000000000000000000000000000ff", chain: "gnosis" },
];
const compact = (v: string) => v.replace(/\s+/g, "").toUpperCase();
function currentIbans() {
  // The APP IBAN appears once activate has requested it and Monerium has issued it.
  if (seen.ibanRequestedFor && seen.ibanIssued && !ibanRecords.some((i) => i.iban === APP_IBAN)) {
    ibanRecords.push({ iban: APP_IBAN, profile: PROFILE_ID, address: seen.ibanRequestedFor, chain: "sepolia" });
  }
  if (seen.pendingPatch && seen.patchSettles) {
    const rec = ibanRecords.find((i) => i.iban === seen.pendingPatch!.iban)!;
    rec.address = seen.pendingPatch.address;
    rec.chain = seen.pendingPatch.chain;
    seen.pendingPatch = null;
  }
  return ibanRecords;
}

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
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

async function makePasskey(id = "monerium-oauth-passkey-0001") {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = enc(new Map<number, any>([
    [1, 2], [3, -7], [-1, 1],
    [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)],
  ]));
  const credId = Buffer.from(id);
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
        ["authData", authData(0x45, 0, true)],
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
 * to answer eth_getCode so `activate` believes the Safe is already deployed
 * and skips the real gasless deployment. */
const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) seen.bearerTokens.push(auth.slice(7));

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // --- Candide RPC half: eth_getCode says "already deployed" -------------
    if (raw.includes("eth_getCode")) {
      return send(200, { jsonrpc: "2.0", id: 1, result: "0x6080604052" });
    }

    if (url.startsWith("/auth/token")) {
      const body = new URLSearchParams(raw);
      const grant = body.get("grant_type") ?? "";
      seen.grantTypes.push(grant);
      seen.clientSecrets.push(body.get("client_secret") ?? "");
      if (grant === "authorization_code") {
        seen.codeVerifier = body.get("code_verifier") ?? "";
        seen.redirectUriAtExchange = body.get("redirect_uri") ?? "";
        // PKCE, enforced: the verifier must hash to the challenge from start.
        if (!seen.codeVerifier || s256(seen.codeVerifier) !== seen.codeChallenge) {
          return send(400, { error: "invalid_grant", detail: "PKCE verification failed" });
        }
        if (body.get("code") !== AUTH_CODE) return send(400, { error: "invalid_grant" });
        return send(200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (grant === "refresh_token") {
        return send(200, { access_token: ACCESS_TOKEN + "-refreshed", expires_in: 3600 });
      }
      // client_credentials (the app-level client) — the poller uses this.
      return send(200, { access_token: "app-token", expires_in: 3600 });
    }

    if (url.startsWith("/auth/context")) return send(200, { userId: "monerium-user-1", email: "user@example.com" });
    if (url.startsWith("/profiles")) {
      // Corporate first: a personal account must still get its personal
      // profile, chosen by kind, not by position.
      return send(200, { profiles: [
        { id: BUSINESS_PROFILE_ID, kind: "corporate", state: "approved" },
        { id: PROFILE_ID, kind: "personal", state: "approved" },
      ] });
    }

    if (url.startsWith("/addresses/")) {
      const addr = decodeURIComponent(url.slice("/addresses/".length)).toLowerCase();
      const profile = seen.links.get(addr);
      return profile ? send(200, { address: addr, profile, chains: ["sepolia"] }) : send(404, { message: "address not linked" });
    }
    if (url.startsWith("/addresses")) {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.linkedAddress = body.address ?? "";
        seen.linkMessage = body.message ?? "";
        seen.linkSignature = body.signature ?? "";
        seen.links.set(String(body.address ?? "").toLowerCase(), body.profile ?? PROFILE_ID);
        return send(201, { address: body.address, chain: body.chain, profile: body.profile });
      }
      return send(200, { addresses: [...seen.links].map(([address, profile]) => ({ address, profile, chain: "sepolia" })) });
    }

    if (url.startsWith("/ibans/") && req.method === "PATCH") {
      const iban = compact(decodeURIComponent(url.slice("/ibans/".length)));
      const body = JSON.parse(raw || "{}");
      seen.patches.push({ iban, address: body.address ?? "", chain: body.chain ?? "" });
      const rec = currentIbans().find((i) => i.iban === iban);
      if (!rec) return send(404, { message: "IBAN not found" });
      // Monerium moves an IBAN only to an address linked under its profile.
      if (seen.links.get(String(body.address ?? "").toLowerCase()) !== rec.profile) {
        return send(400, { message: "address is not linked to the IBAN's profile" });
      }
      seen.pendingPatch = { iban, address: body.address, chain: body.chain };
      return send(202, {});
    }
    if (url.startsWith("/ibans")) {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.ibanRequestedFor = body.address ?? "";
        // One IBAN per profile: 304, no body, when the address's profile has one.
        const profile = seen.links.get(String(body.address ?? "").toLowerCase());
        if (seen.ibanPostRefusesSecond && currentIbans().some((i) => i.profile === profile)) {
          seen.ibanRequestAnswers.push(304);
          res.writeHead(304);
          return res.end();
        }
        seen.ibanRequestAnswers.push(201);
        return send(201, { address: body.address });
      }
      return send(200, { ibans: currentIbans() });
    }

    if (url.startsWith("/orders")) return send(200, { orders: [] });
    send(404, { error: "unhandled: " + url });
  });
});

let connectCookie = "";
async function call(pathname: string, body?: any, method?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
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
  // The browser that starts a connect carries its nonce cookie to the callback.
  const setCookie = res.headers.get("set-cookie") ?? "";
  if (setCookie.startsWith("zold_monerium_connect=")) connectCookie = setCookie.split(";")[0];
  return { status: res.status, data, location: res.headers.get("location") };
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
  [`stub :${STUB_PORT}`, `${STUB}/profiles`],
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

  console.log("2/3 API with a stub Monerium OAuth client…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    TRANSF_API_PORT: String(API_PORT),
    TRANSF_RPC_URL: RPC_URL,
    PORT: String(API_PORT),
    RP_ID: "localhost",
    WEBAUTHN_ORIGINS: `${API},http://localhost:${API_PORT}`,
    MONERIUM_CLIENT_ID: "stub-client",
    MONERIUM_CLIENT_SECRET: "",
    MONERIUM_BASE_URL: STUB,
    MONERIUM_CHAIN: "sepolia", // the stub issues on sepolia; the chain filter must see the same name
    MONERIUM_AUTH_URL: `${STUB}/auth`,
    MONERIUM_REDIRECT_URI: `${API}/api/monerium/oauth/callback`,
    MONERIUM_TOKEN_ENCRYPTION_KEY: ENC_KEY,
    MONERIUM_POLL_MS: "3600000",
    CANDIDE_CHAIN_ID: "31337",
    CANDIDE_RPC_URL: RPC_URL,
    // Blank on purpose: a passkey-only Safe links to Monerium with no
    // co-signer key at all.
    CANDIDE_ALLOWANCE_MODULE_ADDRESS: "0x691f59471Bfd2B7d639DCF74671a2d648ED1E331",
    CANDIDE_RECOVERY_GUARDIAN_ADDRESS: "",
    KYC_AUTO_APPROVE: "0", // the connect path is for pending users
    MG_ANCHOR_DOMAIN: "",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("3/3 driving the connect flow…");

  const created = await call("/api/users", { name: "Existing Monerium User", email: "existing@example.com", country: "DE" });
  assert.equal(created.status, 201);
  const userId = created.data.id;
  token = created.data.sessionToken;
  assert.equal(created.data.kycStatus, "pending", "connect path is for users who have not been approved yet");
  const passkey = await makePasskey();

  await t("passkey Safe is activated before Monerium linking", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    assert.equal(challenge.status, 200);
    const registered = await call(`/api/users/${userId}/passkey`, passkey.register(challenge.data.challenge));
    assert.equal(registered.status, 201, `passkey registration failed: ${registered.data.error ?? ""}`);
    assert.ok(registered.data.passkeySafe?.address, "passkey registration should plan a Safe");
    let activated = await call(`/api/users/${userId}/passkey-safe/deployment`, {});
    assert.ok([200, 201].includes(activated.status), `passkey Safe activation failed: ${activated.data.error ?? ""}`);
    if (activated.data.requestId) {
      const assertion = await passkey.assert(activated.data.challenge, 1);
      const submitRes = await call(activated.data.submitTo, assertion);
      assert.equal(submitRes.status, 201, `passkey Safe deployment submission failed: ${submitRes.data.error ?? ""}`);
      activated = submitRes;
    }
    assert.equal(activated.data.passkeySafe.status, "active");
    assert.equal(activated.data.privateKey, undefined, "API must not expose private key material");
  });

  let redirectUrl = "";
  await t("connect/start returns an authorize URL with a real PKCE S256 challenge", async () => {
    const r = await call(`/api/users/${userId}/monerium/connect/start`, {});
    assert.equal(r.status, 201, `start failed: ${r.data.error ?? ""}`);
    redirectUrl = r.data.redirectUrl;
    const u = new URL(redirectUrl);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("email"), "existing@example.com", "Monerium's form is prefilled with the Zold signup email");
    seen.codeChallenge = u.searchParams.get("code_challenge") ?? "";
    seen.redirectUriAtStart = u.searchParams.get("redirect_uri") ?? "";
    assert.ok(seen.codeChallenge.length >= 43, "expected an S256 challenge");
    assert.ok(u.searchParams.get("state"), "expected an OAuth state");
  });

  await t("the code verifier never reaches the browser", async () => {
    assert.ok(!redirectUrl.includes("code_verifier"), "verifier must stay server-side");
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.moneriumConnect, undefined, "OAuth state must not be exposed to the client");
  });

  await t("a callback with an unknown state is refused, back to the app rather than as raw JSON", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=not-a-real-state&code=${AUTH_CODE}`, undefined, "GET");
    assert.equal(r.status, 302);
    assert.match(r.location ?? "", /\/app\?monerium=refused/);
  });

  const state = new URL(redirectUrl).searchParams.get("state")!;

  await t("a callback from a browser that did not start the connect is refused (login CSRF)", async () => {
    assert.ok(connectCookie, "connect/start must set the nonce cookie");
    const r = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`, undefined, "GET");
    assert.equal(r.status, 302, `expected the cookie-less callback to be refused: ${JSON.stringify(r.data)}`);
    assert.match(r.location ?? "", /monerium=refused/);
    assert.equal(seen.grantTypes.includes("authorization_code"), false, "no code exchange may happen without the nonce");
  });

  await t("the callback exchanges the code and the stub's PKCE check passes", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`, undefined, "GET", { cookie: connectCookie });
    assert.equal(r.status, 302, `callback did not redirect: ${JSON.stringify(r.data)}`);
    assert.match(r.location ?? "", /monerium=connected/);
    assert.equal(seen.grantTypes.includes("authorization_code"), true);
    assert.equal(seen.clientSecrets[0], "", "public PKCE OAuth clients must not require a client_secret");
    assert.equal(s256(seen.codeVerifier), seen.codeChallenge, "PKCE pair must match");
    assert.equal(seen.redirectUriAtExchange, seen.redirectUriAtStart, "redirect_uri must match between start and exchange");
  });

  await t("tokens are encrypted at rest — plaintext never touches db.json", async () => {
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes(ACCESS_TOKEN), "access token found in plaintext in db.json");
    assert.ok(!db.includes(REFRESH_TOKEN), "refresh token found in plaintext in db.json");
    const m = JSON.parse(db).users.find((u: any) => u.id === userId).monerium;
    assert.match(m.accessTokenEnc, /^v2\.t1\./, "the access token is v2 under the active key, bound to the user row");
    assert.match(m.refreshTokenEnc, /^v2\.t1\./, "the refresh token is v2 too");
  });

  await t("the API never returns Monerium tokens to the client", async () => {
    const me = await call(`/api/users/${userId}`);
    const body = JSON.stringify(me.data);
    assert.ok(!body.includes(ACCESS_TOKEN) && !body.includes(REFRESH_TOKEN), "token leaked to the client");
    assert.ok(!body.includes("accessTokenEnc"), "even the ciphertext should not be exposed");
    assert.equal(me.data.monerium.profileId, PROFILE_ID, "connected profile should be visible");
  });

  await t("the Monerium login's email is shown back, so a stale browser session is noticed", async () => {
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.monerium.accountEmail, "user@example.com", "the email from /auth/context should be on the projection");
  });

  await t("the state is single-use — replaying the callback is refused", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`, undefined, "GET", { cookie: connectCookie });
    assert.equal(r.status, 302, "a consumed OAuth state must not be reusable");
    assert.match(r.location ?? "", /monerium=refused/);
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.moneriumRefusal, undefined, "a replay must not mark the connected account refused");
  });

  await t("accounts lists the user's existing Monerium IBANs", async () => {
    const r = await call(`/api/users/${userId}/monerium/accounts`);
    assert.equal(r.status, 200);
    assert.ok(r.data.ibans.some((i: any) => i.iban === EXISTING_IBAN), "expected the user's pre-existing IBAN");
    assert.ok(r.data.profiles.some((p: any) => p.id === BUSINESS_PROFILE_ID), "the login's company profile is listed");
    assert.equal(r.data.profileId, PROFILE_ID, "but a personal account stays connected under its personal profile");
  });

  await t("the user still cannot quote — connecting is not approval", async () => {
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "sepa" });
    assert.equal(r.status, 409, "KYC must stay pending until an app IBAN is active");
  });

  await t("activate refuses without a fresh passkey Safe signature", async () => {
    const r = await call(`/api/users/${userId}/monerium/activate`, { profileId: PROFILE_ID });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /passkey Safe signature required/);
  });

  await t("activate refuses a finished signature in place of the passkey ceremony", async () => {
    const r = await call(`/api/users/${userId}/monerium/activate`, { profileId: PROFILE_ID, signature: `0x${"ab".repeat(65)}` });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /passkey Safe signature required/);
    assert.equal(seen.linkedAddress, "", "nothing was linked at Monerium");
  });

  await t("activate links the app Safe with a passkey Safe signature and requests a NEW app IBAN", async () => {
    const start = await call(`/api/users/${userId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    assert.equal(start.data.credentialId, passkey.credentialId);
    assert.equal(start.data.message, "I hereby declare that I am the address owner.");
    const approval = await passkey.assert(start.data.challenge, 2);
    const r = await call(`/api/users/${userId}/monerium/activate`, {
      profileId: PROFILE_ID,
      linkSignatureRequestId: start.data.requestId,
      ...approval,
    });
    assert.equal(r.status, 200, `activate failed: ${r.data.error ?? ""}`);
    assert.equal(seen.linkedAddress.toLowerCase(), start.data.address.toLowerCase(), "must link the app's Safe address");
    assert.ok(seen.linkSignature.startsWith("0x"), "expected an ownership-declaration signature");
    assert.equal(seen.ibanRequestedFor.toLowerCase(), start.data.address.toLowerCase());
    assert.equal(r.data.iban, "", "no IBAN until Monerium has issued one for this address");
    assert.notEqual(r.data.iban, EXISTING_IBAN, "the user's existing IBAN must never be silently moved");
    assert.equal(r.data.funding.status, "iban_pending");
    assert.equal(r.data.kycStatus, "pending", "a requested IBAN is not an issued one");
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes("privateKey"), "activation must not require storing user private key material");
  });

  await t("the IBAN Monerium issues later approves the account and opens funding", async () => {
    seen.ibanIssued = true;
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.iban, APP_IBAN, "funding should use the newly issued app IBAN");
    assert.equal(me.data.kycStatus, "approved");
    assert.equal(me.data.kyc.provider, "monerium");
    assert.equal(me.data.funding.status, "active");
    const q = await call("/api/quotes", { userId, sendEur: 25, rail: "sepa" });
    assert.equal(q.status, 201, `quote failed after activation: ${q.data.error ?? ""}`);
  });

  await t("disconnect needs the passkey, not just a session", async () => {
    const r = await call(`/api/users/${userId}/monerium/connect`, undefined, "DELETE");
    assert.equal(r.status, 401, JSON.stringify(r.data));
    assert.equal((await call(`/api/users/${userId}`)).data.monerium?.method, "oauth", "still connected");
  });

  await t("disconnect clears the connection and closes funding again", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "step_up", action: "monerium.disconnect" });
    const stepUp = await passkey.assert(challenge.data.challenge, 3);
    const r = await call(`/api/users/${userId}/monerium/connect`, { stepUp }, "DELETE");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.monerium, undefined);
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes("accessTokenEnc"), "encrypted tokens should be dropped on disconnect");
  });

  /*
   * A second Zold account for the same Monerium user. Its Safe links under
   * PROFILE_ID, which now has an IBAN (the first account's), so POST /ibans
   * answers 304 and the IBAN can only be moved.
   */
  const firstUser = { id: userId, token, address: seen.ibanRequestedFor };
  token = "";
  const second = await call("/api/users", { name: "Second Account", email: "second@example.com", country: "DE" });
  assert.equal(second.status, 201);
  const secondId = second.data.id;
  token = second.data.sessionToken;
  const passkey2 = await makePasskey("monerium-oauth-passkey-0002");
  let count2 = 1;

  await t("a second account deploys its Safe and connects the same Monerium user", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    const registered = await call(`/api/users/${secondId}/passkey`, passkey2.register(challenge.data.challenge));
    assert.equal(registered.status, 201, `passkey registration failed: ${registered.data.error ?? ""}`);
    let activated = await call(`/api/users/${secondId}/passkey-safe/deployment`, {});
    if (activated.data.requestId) {
      activated = await call(activated.data.submitTo, await passkey2.assert(activated.data.challenge, 1));
    }
    assert.equal(activated.data.passkeySafe?.status, "active", `Safe activation failed: ${activated.data.error ?? ""}`);
    const r = await call(`/api/users/${secondId}/monerium/connect/start`, {});
    const u = new URL(r.data.redirectUrl);
    seen.codeChallenge = u.searchParams.get("code_challenge") ?? "";
    const cb = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(u.searchParams.get("state")!)}&code=${AUTH_CODE}`, undefined, "GET", { cookie: connectCookie });
    assert.equal(cb.status, 302, `callback failed: ${JSON.stringify(cb.data)}`);
  });

  await t("activate answers IBAN_EXISTS_ELSEWHERE from the snapshot when POST /ibans answers 201", async () => {
    seen.ibanPostRefusesSecond = false;
    try {
      const start = await call(`/api/users/${secondId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
      assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
      const r = await call(`/api/users/${secondId}/monerium/activate`, {
        profileId: PROFILE_ID,
        linkSignatureRequestId: start.data.requestId,
        ...(await passkey2.assert(start.data.challenge, ++count2)),
      });
      assert.equal(seen.ibanRequestAnswers.at(-1), 201, "the stub must have answered 201");
      assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, "IBAN_EXISTS_ELSEWHERE");
      assert.equal(r.data.existing.iban, APP_IBAN);
      const me = await call(`/api/users/${secondId}`);
      assert.notEqual(me.data.funding?.status, "iban_pending", "an IBAN that will never come must not be awaited");
      assert.equal(me.data.kycStatus, "pending");
    } finally {
      seen.ibanPostRefusesSecond = true;
    }
  });

  let secondAddress = "";
  await t("activate answers IBAN_EXISTS_ELSEWHERE when the profile's one IBAN pays another address", async () => {
    const start = await call(`/api/users/${secondId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    secondAddress = start.data.address;
    const r = await call(`/api/users/${secondId}/monerium/activate`, {
      profileId: PROFILE_ID,
      linkSignatureRequestId: start.data.requestId,
      ...(await passkey2.assert(start.data.challenge, ++count2)),
    });
    assert.equal(seen.ibanRequestAnswers.at(-1), 304, "the stub must have answered 304");
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "IBAN_EXISTS_ELSEWHERE");
    assert.equal(r.data.existing.iban, APP_IBAN);
    assert.equal(r.data.existing.address.toLowerCase(), firstUser.address.toLowerCase());
    assert.equal(r.data.existing.chain, "sepolia");
    const me = await call(`/api/users/${secondId}`);
    assert.equal(me.data.iban, "", "another address's IBAN is never stored as this account's");
    assert.equal(me.data.kycStatus, "pending");
    assert.match(me.data.funding.detail ?? "", /already has an IBAN/);
  });

  const moveCeremony2 = async (iban: string) => {
    const start = await call(`/api/users/${secondId}/monerium/link-signature/start`, { profileId: PROFILE_ID, purpose: "move-iban", iban });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    return { requestId: start.data.requestId, ...(await passkey2.assert(start.data.challenge, ++count2)) };
  };

  await t("move-iban refuses without the typed confirmation", async () => {
    const r = await call(`/api/users/${secondId}/monerium/move-iban`, { iban: APP_IBAN, ...(await moveCeremony2(APP_IBAN)) });
    assert.equal(r.status, 400, `expected 400: ${JSON.stringify(r.data)}`);
    assert.equal(seen.patches.length, 0);
  });

  await t("move-iban refuses without a fresh passkey assertion", async () => {
    const r = await call(`/api/users/${secondId}/monerium/move-iban`, { iban: APP_IBAN, confirm: "MOVE" });
    assert.equal(r.status, 409, `expected 409: ${JSON.stringify(r.data)}`);
    assert.equal(seen.patches.length, 0);
  });

  await t("move-iban refuses the user's IBAN on another profile", async () => {
    const r = await call(`/api/users/${secondId}/monerium/move-iban`, { iban: EXISTING_IBAN, confirm: "MOVE", ...(await moveCeremony2(EXISTING_IBAN)) });
    assert.equal(r.status, 409, `expected 409: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "IBAN_NOT_ON_PROFILE");
    assert.equal(seen.patches.length, 0);
  });

  await t("a move Monerium accepts but a re-read does not confirm leaves the account pending", async () => {
    seen.patchSettles = false;
    const r = await call(`/api/users/${secondId}/monerium/move-iban`, { iban: APP_IBAN, confirm: "MOVE", ...(await moveCeremony2(APP_IBAN)) });
    assert.equal(r.status, 200, `move failed: ${JSON.stringify(r.data)}`);
    assert.deepEqual(seen.patches, [{ iban: APP_IBAN, address: secondAddress, chain: "sepolia" }], "PATCH must carry the Safe address and MONERIUM.chain");
    assert.equal(r.data.iban, "", "the re-read still shows the old address: nothing is this account's yet");
    assert.equal(r.data.kycStatus, "pending");
    assert.equal(r.data.funding.status, "iban_pending");
    assert.equal(r.data.moneriumIbanMoves?.[0]?.confirmedAt, undefined);
    const again = await call(`/api/users/${secondId}`);
    assert.equal(again.data.kycStatus, "pending", "polling before Monerium moves it changes nothing");
  });

  await t("once Monerium shows the IBAN on the Safe, the pending check approves and the first account lets go", async () => {
    seen.patchSettles = true;
    const me = await call(`/api/users/${secondId}`);
    assert.equal(me.data.iban, APP_IBAN);
    assert.equal(me.data.kycStatus, "approved");
    assert.equal(me.data.funding.status, "active");
    const move = me.data.moneriumIbanMoves?.[0];
    assert.equal(move?.fromAddress?.toLowerCase(), firstUser.address.toLowerCase());
    assert.equal(move?.fromChain, "sepolia");
    assert.equal(move?.profileId, PROFILE_ID);
    assert.ok(move?.confirmedAt, "the confirmation is recorded");
    token = firstUser.token;
    const first = await call(`/api/users/${firstUser.id}`);
    token = second.data.sessionToken;
    assert.equal(first.data.iban, "", "the first account no longer shows an IBAN that now pays another Safe");
  });

  /**
   * A profile holding several IBANs, none paying this Safe: activate offers
   * every one and preselects none; the user moves the one they pick.
   */
  ibanRecords.push({ iban: SPARE_IBAN, profile: PROFILE_ID, address: "0x00000000000000000000000000000000000000ee", chain: "sepolia" });
  token = "";
  const third = await call("/api/users", { name: "Third Account", email: "third@example.com", country: "DE" });
  assert.equal(third.status, 201);
  const thirdId = third.data.id;
  token = third.data.sessionToken;
  const passkey3 = await makePasskey("monerium-oauth-passkey-0003");
  let count3 = 1;
  let thirdAddress = "";

  await t("a third account deploys its Safe and connects the same Monerium user", async () => {
    const challenge = await call("/api/webauthn/challenge", { purpose: "register" });
    const registered = await call(`/api/users/${thirdId}/passkey`, passkey3.register(challenge.data.challenge));
    assert.equal(registered.status, 201, `passkey registration failed: ${registered.data.error ?? ""}`);
    let activated = await call(`/api/users/${thirdId}/passkey-safe/deployment`, {});
    if (activated.data.requestId) {
      activated = await call(activated.data.submitTo, await passkey3.assert(activated.data.challenge, 1));
    }
    assert.equal(activated.data.passkeySafe?.status, "active", `Safe activation failed: ${activated.data.error ?? ""}`);
    const r = await call(`/api/users/${thirdId}/monerium/connect/start`, {});
    const u = new URL(r.data.redirectUrl);
    seen.codeChallenge = u.searchParams.get("code_challenge") ?? "";
    const cb = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(u.searchParams.get("state")!)}&code=${AUTH_CODE}`, undefined, "GET", { cookie: connectCookie });
    assert.equal(cb.status, 302, `callback failed: ${JSON.stringify(cb.data)}`);
  });

  await t("activate on a profile with several IBANs offers each as a choice, none preselected", async () => {
    const start = await call(`/api/users/${thirdId}/monerium/link-signature/start`, { profileId: PROFILE_ID });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    thirdAddress = start.data.address;
    const r = await call(`/api/users/${thirdId}/monerium/activate`, {
      profileId: PROFILE_ID,
      linkSignatureRequestId: start.data.requestId,
      ...(await passkey3.assert(start.data.challenge, ++count3)),
    });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "IBAN_EXISTS_ELSEWHERE");
    assert.equal(r.data.existing, undefined, "with several IBANs none is offered as the one");
    assert.deepEqual(r.data.choices.map((c: any) => c.iban).sort(), [APP_IBAN, SPARE_IBAN].sort());
    assert.ok(r.data.choices.every((c: any) => c.profileId === PROFILE_ID));
    assert.ok(!r.data.choices.some((c: any) => c.iban === EXISTING_IBAN), "another profile's IBAN is never offered");
    const me = await call(`/api/users/${thirdId}`);
    assert.equal(me.data.iban, "");
    assert.equal(me.data.kycStatus, "pending");
  });

  await t("moving the picked IBAN approves the account with that IBAN", async () => {
    const start = await call(`/api/users/${thirdId}/monerium/link-signature/start`, { profileId: PROFILE_ID, purpose: "move-iban", iban: SPARE_IBAN });
    assert.equal(start.status, 201, `link-signature start failed: ${start.data.error ?? ""}`);
    const r = await call(`/api/users/${thirdId}/monerium/move-iban`, {
      iban: SPARE_IBAN,
      confirm: "MOVE",
      requestId: start.data.requestId,
      ...(await passkey3.assert(start.data.challenge, ++count3)),
    });
    assert.equal(r.status, 200, `move failed: ${JSON.stringify(r.data)}`);
    assert.deepEqual(seen.patches.at(-1), { iban: SPARE_IBAN, address: thirdAddress, chain: "sepolia" });
    assert.equal(r.data.iban, SPARE_IBAN);
    assert.equal(r.data.kycStatus, "approved");
  });

  if (failed.length) {
    console.log(`\nMONERIUM OAUTH TEST FAILED — ${failed.length} case(s):\n  - ${failed.join("\n  - ")}`);
    process.exitCode = 1;
  } else console.log(`\nMONERIUM OAUTH TEST PASSED — ${pass}/${pass}: PKCE enforced, tokens encrypted, app IBAN issued`);
  console.log("note: a real Monerium account in a browser is still needed to prove the");
  console.log("      authorize page accepts our client_id/redirect_uri registration.");
} finally {
  for (const c of children) c.kill();
  stub.close();
}
