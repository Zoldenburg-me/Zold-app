/**
 * Monerium existing-account connect (OAuth) test.
 *
 * The connect flow lets a user who already has a Monerium account attach it
 * instead of repeating KYC. It ships as five endpoints and had no coverage
 * beyond "returns 503 when unconfigured" — so nothing proved the PKCE was
 * real, that tokens stay encrypted, or that activation actually issues an app
 * IBAN.
 *
 * This drives the whole loop against a stub Monerium. The stub is not a
 * pushover: it **verifies the PKCE challenge itself** (S256 of the verifier
 * presented at exchange must equal the challenge sent at start), so a flow
 * that only decorated the URL with a challenge would fail here.
 *
 * What this canNOT prove, and needs a real Monerium account in a browser:
 * that Monerium's authorize page accepts our client_id/redirect_uri
 * registration, and that its real token response matches this shape.
 *
 * Run: npm run monerium:oauth:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const STUB_PORT = Number(process.env.TRANSF_STUB_PORT ?? 8549);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ENC_KEY = "test-monerium-token-encryption-key-32b";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

const ACCESS_TOKEN = "stub-access-token-" + randomBytes(8).toString("hex");
const REFRESH_TOKEN = "stub-refresh-token-" + randomBytes(8).toString("hex");
const AUTH_CODE = "stub-auth-code";
const PROFILE_ID = "profile-existing-user";
const EXISTING_IBAN = "GB33BUKB20201555555555";
const APP_IBAN = "IS140159260076545510730339";

let token = "";
const children: ChildProcess[] = [];

/** What the stub saw, so assertions can inspect the real protocol exchange. */
const seen = {
  codeChallenge: "",
  codeVerifier: "",
  redirectUriAtStart: "",
  redirectUriAtExchange: "",
  grantTypes: [] as string[],
  linkedAddress: "",
  linkMessage: "",
  linkSignature: "",
  ibanRequestedFor: "",
  bearerTokens: [] as string[],
};

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

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
    if (url.startsWith("/profiles")) return send(200, { profiles: [{ id: PROFILE_ID, kind: "personal", state: "approved" }] });

    if (url.startsWith("/addresses")) {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.linkedAddress = body.address ?? "";
        seen.linkMessage = body.message ?? "";
        seen.linkSignature = body.signature ?? "";
        return send(201, { address: body.address, chain: body.chain, profile: body.profile });
      }
      return send(200, { addresses: seen.linkedAddress ? [{ address: seen.linkedAddress, chain: "sepolia" }] : [] });
    }

    if (url.startsWith("/ibans")) {
      if (req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        seen.ibanRequestedFor = body.address ?? "";
        return send(201, { iban: APP_IBAN, address: body.address });
      }
      // The user's pre-existing IBAN is on a DIFFERENT address; the app IBAN
      // only appears once activate has requested it.
      const list: any[] = [{ iban: EXISTING_IBAN, address: "0x00000000000000000000000000000000000000ff" }];
      if (seen.ibanRequestedFor) list.push({ iban: APP_IBAN, address: seen.ibanRequestedFor });
      return send(200, { ibans: list });
    }

    if (url.startsWith("/orders")) return send(200, { orders: [] });
    send(404, { error: "unhandled: " + url });
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
  return { status: res.status, data, location: res.headers.get("location") };
}

function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
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
    spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" }).status,
    0,
    "deploy failed",
  );

  console.log("2/3 API with a stub Monerium OAuth client…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    MONERIUM_CLIENT_ID: "stub-client",
    MONERIUM_CLIENT_SECRET: "stub-secret",
    MONERIUM_BASE_URL: STUB,
    MONERIUM_AUTH_URL: `${STUB}/auth`,
    MONERIUM_REDIRECT_URI: `${API}/api/monerium/oauth/callback`,
    MONERIUM_TOKEN_ENCRYPTION_KEY: ENC_KEY,
    MONERIUM_POLL_MS: "3600000",
    CANDIDE_RPC_URL: STUB,
    KYC_AUTO_APPROVE: "0", // the connect path is for pending users
    MG_ANCHOR_DOMAIN: "",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("3/3 driving the connect flow…");

  const created = await call("/api/users", { name: "Existing Monerium User", country: "DE" });
  assert.equal(created.status, 201);
  const userId = created.data.id;
  token = created.data.sessionToken;
  assert.equal(created.data.kycStatus, "pending", "connect path is for users who have not been approved yet");

  let redirectUrl = "";
  await t("connect/start returns an authorize URL with a real PKCE S256 challenge", async () => {
    const r = await call(`/api/users/${userId}/monerium/connect/start`, {});
    assert.equal(r.status, 201, `start failed: ${r.data.error ?? ""}`);
    redirectUrl = r.data.redirectUrl;
    const u = new URL(redirectUrl);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
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

  await t("a callback with an unknown state is refused", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=not-a-real-state&code=${AUTH_CODE}`, undefined, "GET");
    assert.equal(r.status, 400);
  });

  const state = new URL(redirectUrl).searchParams.get("state")!;

  await t("the callback exchanges the code and the stub's PKCE check passes", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`, undefined, "GET");
    assert.equal(r.status, 302, `callback did not redirect: ${JSON.stringify(r.data)}`);
    assert.match(r.location ?? "", /monerium=connected/);
    assert.equal(seen.grantTypes.includes("authorization_code"), true);
    assert.equal(s256(seen.codeVerifier), seen.codeChallenge, "PKCE pair must match");
    assert.equal(seen.redirectUriAtExchange, seen.redirectUriAtStart, "redirect_uri must match between start and exchange");
  });

  await t("tokens are encrypted at rest — plaintext never touches db.json", async () => {
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes(ACCESS_TOKEN), "access token found in plaintext in db.json");
    assert.ok(!db.includes(REFRESH_TOKEN), "refresh token found in plaintext in db.json");
    assert.ok(db.includes("accessTokenEnc"), "expected an encrypted access token field");
  });

  await t("the API never returns Monerium tokens to the client", async () => {
    const me = await call(`/api/users/${userId}`);
    const body = JSON.stringify(me.data);
    assert.ok(!body.includes(ACCESS_TOKEN) && !body.includes(REFRESH_TOKEN), "token leaked to the client");
    assert.ok(!body.includes("accessTokenEnc"), "even the ciphertext should not be exposed");
    assert.equal(me.data.monerium.profileId, PROFILE_ID, "connected profile should be visible");
  });

  await t("the state is single-use — replaying the callback is refused", async () => {
    const r = await call(`/api/monerium/oauth/callback?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`, undefined, "GET");
    assert.equal(r.status, 400, "a consumed OAuth state must not be reusable");
  });

  await t("accounts lists the user's existing Monerium IBANs", async () => {
    const r = await call(`/api/users/${userId}/monerium/accounts`);
    assert.equal(r.status, 200);
    assert.ok(r.data.ibans.some((i: any) => i.iban === EXISTING_IBAN), "expected the user's pre-existing IBAN");
    assert.equal(r.data.profiles[0].id, PROFILE_ID);
  });

  await t("the user still cannot quote — connecting is not approval", async () => {
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" });
    assert.equal(r.status, 409, "KYC must stay pending until an app IBAN is active");
  });

  await t("activate links the app Safe and requests a NEW app IBAN", async () => {
    const r = await call(`/api/users/${userId}/monerium/activate`, { profileId: PROFILE_ID });
    assert.equal(r.status, 200, `activate failed: ${r.data.error ?? ""}`);
    assert.equal(seen.linkedAddress.toLowerCase(), created.data.address.toLowerCase(), "must link the app's Safe address");
    assert.ok(seen.linkSignature.startsWith("0x"), "expected an ownership-declaration signature");
    assert.equal(seen.ibanRequestedFor.toLowerCase(), created.data.address.toLowerCase());
    assert.equal(r.data.iban, APP_IBAN, "funding should use the newly issued app IBAN");
    assert.notEqual(r.data.iban, EXISTING_IBAN, "the user's existing IBAN must never be silently moved");
  });

  await t("activation approves the account and opens funding", async () => {
    const me = await call(`/api/users/${userId}`);
    assert.equal(me.data.kycStatus, "approved");
    assert.equal(me.data.kyc.provider, "monerium");
    assert.equal(me.data.funding.status, "active");
    const q = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" });
    assert.equal(q.status, 201, `quote failed after activation: ${q.data.error ?? ""}`);
  });

  await t("disconnect clears the connection and closes funding again", async () => {
    const r = await call(`/api/users/${userId}/monerium/connect`, undefined, "DELETE");
    assert.equal(r.status, 200);
    assert.equal(r.data.monerium, undefined);
    const db = readFileSync(process.env.TRANSF_DB_PATH!, "utf8");
    assert.ok(!db.includes("accessTokenEnc"), "encrypted tokens should be dropped on disconnect");
  });

  console.log(`\nMONERIUM OAUTH TEST PASSED — ${pass}/${pass}: PKCE enforced, tokens encrypted, app IBAN issued`);
  console.log("note: a real Monerium account in a browser is still needed to prove the");
  console.log("      authorize page accepts our client_id/redirect_uri registration.");
} finally {
  for (const c of children) c.kill();
  stub.close();
}
