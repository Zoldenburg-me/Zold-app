/**
 * The /guardian page and the Turnkey browser bundle, offline.
 *
 *  - vendor/turnkey.js is exactly what the pinned sources build (esbuild,
 *    @turnkey/indexed-db-stamper), its SHA-256 is the one recorded in the
 *    plan, it exports the stamper alone and makes no network call;
 *  - /guardian is served with a stricter CSP than the app (no inline
 *    script), never cached, and kept out of robots; its HTML has no inline
 *    script; /app's CSP is unchanged;
 *  - the login helpers: Google and Apple authorize URLs return an ID token in
 *    the fragment, with the nonce bound to the browser key and a one-time
 *    state that expires; a return with the wrong state, no stored state, an
 *    old state or a provider error is refused;
 *  - the flow, with the browser stubbed: start stores the state and leaves
 *    for the provider; the return strips the token from the address bar
 *    before anything else, sends it with the key it is bound to, drops that
 *    key, and finishes with the passkey-approved op.
 *
 * What it cannot prove: a real Google or Apple login, IndexedDB, or a
 * passkey. No browser runs here.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");
const { buildTurnkeyBundle, TURNKEY_BUNDLE } = await import("./build-turnkey-bundle.js");
const { createPageRouter } = await import("../services/api/src/routes/pages.js");
const { securityHeadersFor, CONTENT_SECURITY_POLICY } = await import("../services/api/src/http/policy.js");
const oauth = await import(pathToFileURL(path.join(PUB, "guardian/oauth.js")).href);
const page = await import(pathToFileURL(path.join(PUB, "guardian/main.js")).href);

let failed = 0;
let passed = 0;
const check = async (name: string, fn: () => unknown) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
console.log("bundle");

const committed = readFileSync(TURNKEY_BUNDLE, "utf8");

await check("vendor/turnkey.js is exactly what the pinned sources build", async () => {
  assert.equal(sha256(await buildTurnkeyBundle()), sha256(committed));
});

await check("its SHA-256 is the one recorded in docs/recovery-guardians-plan.md", () => {
  const plan = readFileSync(path.join(ROOT, "docs/recovery-guardians-plan.md"), "utf8");
  assert.ok(plan.includes(sha256(committed)), `record ${sha256(committed)} in the plan`);
});

await check("its banner names the version package-lock pins", () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const v = lock.packages["node_modules/@turnkey/indexed-db-stamper"].version;
  assert.ok(committed.startsWith(`/*! Zold vendor bundle: @turnkey/indexed-db-stamper@${v},`), committed.slice(0, 120));
});

await check("it exports the IndexedDB stamper alone and makes no network call", () => {
  assert.match(committed.trimEnd(), /export \{\s*IndexedDbStamper\s*\};$/);
  assert.doesNotMatch(committed, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
});

// ---------------------------------------------------------------------------
console.log("page");

const app = express();
app.use(securityHeadersFor(false));
app.use(createPageRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

try {
  await check("/guardian is served with no inline script allowed, and is never cached", async () => {
    const r = await fetch(`${base}/guardian`);
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(await r.text(), /<script type="module" src="\/guardian\/main\.js"><\/script>/);
  });

  await check("/guardian.html is not a second door to the page under the app's CSP", async () => {
    const r = await fetch(`${base}/guardian.html#id_token=x`, { redirect: "manual" });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/guardian");
  });

  await check("/app keeps the app's CSP", async () => {
    const r = await fetch(`${base}/app`);
    assert.equal(r.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  });

  await check("robots.txt keeps crawlers off /guardian", async () => {
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /^Disallow: \/guardian$/m);
  });
} finally {
  server.close();
}

await check("the page strips a returned token before it awaits anything, and claims nothing that has not run", () => {
  const src = readFileSync(path.join(PUB, "guardian/main.js"), "utf8");
  const boot = src.slice(src.indexOf("async function boot()"));
  assert.ok(boot.indexOf("history.replaceState") > -1 && boot.indexOf("history.replaceState") < boot.indexOf("await "), "replaceState runs before the first await in boot()");
  assert.doesNotMatch(src, /Adding (a guardian )?works/i);
  assert.match(src, /not yet run/i);
});

await check("guardian.html has no inline script and says noindex", () => {
  const html = readFileSync(path.join(PUB, "guardian.html"), "utf8");
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /\bsrc="/, tag);
  assert.doesNotMatch(html, /\son[a-z]+="/i, "no inline event handlers");
  assert.match(html, /<meta name="robots" content="noindex"/);
});

// ---------------------------------------------------------------------------
console.log("login helpers");

// Turnkey's example pair (docs.turnkey.com/authentication/social-logins).
const KEY = "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a"; // gitleaks:allow (public key from Turnkey's docs)
const NONCE = "1663bba492a323085b13895634a3618792c4ec6896f3c34ef3c26396df22ef82";
const ORIGIN = "https://zoldhq.example";

await check("the nonce is sha256 over the key's hex string, as Turnkey and the API compute it", async () => {
  assert.equal(await oauth.nonceFor(KEY), NONCE);
});

await check("a state is 32 random bytes of hex, new each time", () => {
  const a = oauth.newState();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, oauth.newState());
});

await check("Google: an ID token in the fragment, openid only, our client id, the nonce and the state", () => {
  const u = new URL(oauth.authorizeUrl("google", { clientId: "g.apps.googleusercontent.com", redirectUri: `${ORIGIN}/guardian`, nonce: NONCE, state: "s1" }));
  assert.equal(`${u.origin}${u.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), "g.apps.googleusercontent.com");
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/guardian`);
  assert.equal(u.searchParams.get("response_type"), "id_token");
  assert.equal(u.searchParams.get("scope"), "openid");
  assert.equal(u.searchParams.get("nonce"), NONCE);
  assert.equal(u.searchParams.get("state"), "s1");
  assert.equal(u.searchParams.get("prompt"), "select_account");
});

await check("Apple: the token in the fragment, no scope (so no name or email is asked for)", () => {
  const u = new URL(oauth.authorizeUrl("apple", { clientId: "com.zoldhq.signin", redirectUri: `${ORIGIN}/guardian`, nonce: NONCE, state: "s2" }));
  assert.equal(`${u.origin}${u.pathname}`, "https://appleid.apple.com/auth/authorize");
  assert.equal(u.searchParams.get("response_type"), "code id_token");
  assert.equal(u.searchParams.get("response_mode"), "fragment");
  assert.equal(u.searchParams.get("scope"), null);
  assert.equal(u.searchParams.get("nonce"), NONCE);
  assert.equal(u.searchParams.get("state"), "s2");
});

await check("an unknown provider is refused", () => {
  assert.throws(() => oauth.authorizeUrl("auth0", { clientId: "x", redirectUri: "x", nonce: "x", state: "x" }));
});

const T0 = 1_800_000_000_000;
const stored = (over: Record<string, unknown> = {}) => JSON.stringify({ state: "s1", provider: "google", at: T0, ...over });
const ret = (h: string, s: string | null, now = T0 + 1000) => oauth.readReturn(h, s, now);

await check("a return with the stored state gives the token and provider", () => {
  assert.deepEqual(ret("#id_token=tok.en.x&state=s1", stored()), { ok: true, provider: "google", idToken: "tok.en.x" });
});

await check("a return is refused: wrong state, none stored, older than ten minutes, a provider error, no token", () => {
  assert.equal(ret("#id_token=t&state=other", stored()).ok, false);
  assert.equal(ret("#id_token=t&state=s1", null).ok, false);
  assert.equal(ret("#id_token=t&state=s1", stored(), T0 + 10 * 60_000 + 1).ok, false);
  const err = ret("#error=access_denied&state=s1", stored());
  assert.equal(err.ok, false);
  assert.match(err.reason, /access_denied|cancel/i);
  assert.equal(ret("#state=s1", stored()).ok, false);
  assert.equal(ret("#id_token=t&state=s1", "{not json").ok, false);
});

await check("no fragment means no return to handle", () => {
  assert.equal(ret("", stored()), null);
  assert.equal(ret("#", stored()), null);
});

// ---------------------------------------------------------------------------
console.log("flow");

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
};
const fakeStamper = () => {
  const s = { key: null as string | null, calls: [] as string[] };
  return Object.assign(s, {
    async init() { s.calls.push("init"); },
    async resetKeyPair() { s.calls.push("reset"); s.key = KEY; },
    getPublicKey() { return s.key; },
    async clear() { s.calls.push("clear"); s.key = null; },
  });
};

await check("start: a fresh key, its nonce and a one-time state go to the provider; nothing else leaves", async () => {
  const storage = memoryStorage();
  const stamper = fakeStamper();
  let went = "";
  await page.startLogin("google", { stamper, storage, origin: ORIGIN, logins: { google: "g.apps.googleusercontent.com", apple: null }, go: (u: string) => (went = u), now: () => T0 });
  assert.deepEqual(stamper.calls, ["init", "reset"]);
  const u = new URL(went);
  assert.equal(u.searchParams.get("nonce"), NONCE);
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/guardian`);
  const s = JSON.parse(storage.getItem(oauth.OAUTH_STATE_KEY)!);
  assert.equal(s.state, u.searchParams.get("state"));
  assert.equal(s.provider, "google");
  assert.equal(s.at, T0);
});

await check("start: a provider without a client id is refused", async () => {
  await assert.rejects(page.startLogin("apple", { stamper: fakeStamper(), storage: memoryStorage(), origin: ORIGIN, logins: { google: "g", apple: null }, go: () => {}, now: () => T0 }));
});

const returnEnv = (over: Record<string, any> = {}) => {
  const storage = memoryStorage();
  storage.setItem(oauth.OAUTH_STATE_KEY, stored());
  const stamper = fakeStamper();
  stamper.key = KEY;
  const log: string[] = [];
  const calls: { path: string; body: any }[] = [];
  const answers: Record<string, any> = {
    "/api/recovery/turnkey/users/u1/guardians": { guardian: { turnkeySubOrgId: "sub-1", address: "0x1", status: "created" } },
    "/api/recovery/turnkey/users/u1/guardians/sub-1/add": { requestId: "r1", credentialId: "c1", rpId: "localhost", challenge: "ch", submitTo: "/api/recovery/turnkey/users/u1/ops/r1" },
    "/api/recovery/turnkey/users/u1/ops/r1": { guardian: { turnkeySubOrgId: "sub-1", address: "0x1", status: "active" } },
  };
  return {
    log, calls, storage, stamper,
    env: {
      hash: "#id_token=tok.en.x&state=s1",
      storage, stamper, userId: "u1", now: () => T0 + 1000,
      stripHash: () => log.push("strip"),
      beforePasskey: (g: any) => log.push(`show ${g.address}`),
      api: async (p: string, body: any) => {
        log.push(`api ${p}`);
        calls.push({ path: p, body });
        return answers[p];
      },
      passkeyGet: async (prep: any) => {
        log.push(`passkey ${prep.challenge}`);
        return { authenticatorData: "a", clientDataJSON: "c", signature: "s" };
      },
      ...over,
    },
  };
};

await check("return: strips the token first, sends it with its key, drops the key, then the passkey approves the op", async () => {
  const t = returnEnv();
  const r = await page.finishLogin(t.env);
  assert.equal(r.step, "done", JSON.stringify(r));
  assert.equal(r.guardian.status, "active");
  assert.equal(t.log[0], "strip", "the token leaves the address bar before anything else");
  assert.deepEqual(t.calls[0], { path: "/api/recovery/turnkey/users/u1/guardians", body: { oidcToken: "tok.en.x", publicKey: KEY } });
  assert.ok(t.stamper.calls.includes("clear"), "the key that bound the token is dropped");
  assert.deepEqual(t.log.slice(1), [
    "api /api/recovery/turnkey/users/u1/guardians",
    "api /api/recovery/turnkey/users/u1/guardians/sub-1/add",
    "show 0x1",
    "passkey ch",
    "api /api/recovery/turnkey/users/u1/ops/r1",
  ]);
  assert.deepEqual(t.calls[2].body, { authenticatorData: "a", clientDataJSON: "c", signature: "s" });
  assert.equal(t.storage.getItem(oauth.OAUTH_STATE_KEY), null, "the state is single use");
});

await check("return: a refused state calls no API and keeps no token", async () => {
  const t = returnEnv({ hash: "#id_token=tok.en.x&state=forged" });
  const r = await page.finishLogin(t.env);
  assert.equal(r.step, "error");
  assert.equal(t.calls.length, 0);
  assert.equal(t.log[0], "strip");
  assert.ok(t.stamper.calls.includes("clear"));
});

await check("return: the key is dropped even when the API refuses the token", async () => {
  const t = returnEnv({ api: async () => { throw Object.assign(new Error("login token refused"), { code: "BAD_OIDC_TOKEN" }); } });
  const r = await page.finishLogin(t.env);
  assert.equal(r.step, "error");
  assert.match(r.reason, /refused/);
  assert.ok(t.stamper.calls.includes("clear"));
});

await check("return: a passkey that is dismissed leaves the guardian created, to finish later", async () => {
  const t = returnEnv({ passkeyGet: async () => { throw new Error("The operation either timed out or was not allowed."); } });
  const r = await page.finishLogin(t.env);
  assert.equal(r.step, "created");
  assert.equal(r.guardian.turnkeySubOrgId, "sub-1");
  assert.ok(!t.calls.some((c) => c.path.includes("/ops/")));
});

await check("return: a login the chain already lists needs no passkey", async () => {
  const t = returnEnv();
  const api = t.env.api;
  t.env.api = async (p: string, body: any) => (p.endsWith("/add") ? { guardian: { turnkeySubOrgId: "sub-1", address: "0x1", status: "active" } } : api(p, body));
  const r = await page.finishLogin(t.env);
  assert.equal(r.step, "done");
  assert.ok(!t.log.some((l) => l.startsWith("passkey")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
