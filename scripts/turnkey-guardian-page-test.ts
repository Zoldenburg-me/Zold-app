/**
 * The /guardian page and the Turnkey browser bundle, offline.
 *
 *  - vendor/turnkey.js is exactly what the pinned sources build (esbuild,
 *    @turnkey/indexed-db-stamper), its SHA-256 is the one recorded in the
 *    plan, it exports the two stampers and the OTP encryption alone and
 *    makes no network call;
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
 *    key, and finishes with the passkey-approved op;
 *  - approving a recovery: Turnkey's sign_raw_payload is stamped by the
 *    browser key, sends the digest with its 0x unhashed, and is polled until
 *    complete; the page refuses a login that is not the request's guardian
 *    before anything is signed, and drops the key whatever happens;
 *  - only /guardian's CSP may reach Turnkey's API.
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
const { securityHeadersFor, CONTENT_SECURITY_POLICY, guardianPageCsp } = await import("../services/api/src/http/policy.js");
const signer = await import(pathToFileURL(path.join(PUB, "guardian/turnkey-sign.js")).href);
const oauth = await import(pathToFileURL(path.join(PUB, "guardian/oauth.js")).href);
const approve = await import(pathToFileURL(path.join(PUB, "recovery/approve.js")).href);
const flow = await import(pathToFileURL(path.join(PUB, "recovery/flow.js")).href);
const page = await import(pathToFileURL(path.join(PUB, "guardian/main.js")).href);
const logins = await import(pathToFileURL(path.join(PUB, "guardian/logins.js")).href);

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

await check("its banner names the versions package-lock pins", () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const pins = ["@turnkey/indexed-db-stamper", "@turnkey/webauthn-stamper", "@turnkey/crypto"].map((p) => `${p}@${lock.packages[`node_modules/${p}`].version}`);
  assert.ok(committed.startsWith(`/*! Zold vendor bundle: ${pins.join(", ")},`), committed.slice(0, 200));
});

await check("it exports the two stampers and the OTP encryption alone, and makes no network call", () => {
  assert.match(committed.trimEnd(), /export \{\s*IndexedDbStamper,\s*WebauthnStamper,\s*encryptOtpCodeToBundle\s*\};$/);
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
  await check("the app's own code revalidates on every load; pinned vendor files keep their cache", async () => {
    for (const p of ["/app.css", "/ui.css", "/app/settings.js", "/recovery/main.js", "/guardian/main.js", "/sw.js"]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("cache-control"), "no-cache", p);
    }
    const v = await fetch(`${base}/vendor/turnkey.js`);
    assert.equal(v.status, 200);
    assert.notEqual(v.headers.get("cache-control"), "no-cache");
  });

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

  await check("/recovery is served like /guardian: no inline script, never cached, its own module", async () => {
    for (const p of ["/recovery", "/recovery/"]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      const csp = r.headers.get("content-security-policy") ?? "";
      assert.match(csp, /script-src 'self'(;|$)/, p);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, p);
      assert.equal(r.headers.get("cache-control"), "no-store", p);
      assert.match(await r.text(), /<script type="module" src="\/recovery\/main\.js"><\/script>/, p);
    }
    const old = await fetch(`${base}/recovery.html`, { redirect: "manual" });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get("location"), "/recovery");
  });

  await check("/app keeps the app's CSP", async () => {
    const r = await fetch(`${base}/app`);
    assert.equal(r.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  });

  await check("robots.txt keeps crawlers off /guardian", async () => {
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    assert.match(robots, /^Disallow: \/guardian$/m);
    assert.match(robots, /^Disallow: \/recovery$/m);
  });
} finally {
  server.close();
}

await check("both pages strip a returned token before they await anything", () => {
  for (const f of ["guardian/main.js", "recovery/main.js"]) {
    const src = readFileSync(path.join(PUB, f), "utf8");
    const boot = src.slice(src.indexOf("async function boot()"));
    assert.ok(boot.indexOf("history.replaceState") > -1 && boot.indexOf("history.replaceState") < boot.indexOf("await "), `${f}: replaceState runs before the first await in boot()`);
  }
});

await check("guardian.html and recovery.html have no inline script and say noindex", () => {
  for (const f of ["guardian.html", "recovery.html"]) {
    const html = readFileSync(path.join(PUB, f), "utf8");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /\bsrc="/, `${f}: ${tag}`);
    assert.doesNotMatch(html, /\son[a-z]+="/i, `${f}: no inline event handlers`);
    assert.match(html, /<meta name="robots" content="noindex"/, f);
  }
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
  await oauth.startLogin("google", { stamper, storage, origin: ORIGIN, logins: { google: "g.apps.googleusercontent.com", apple: null }, go: (u: string) => (went = u), now: () => T0 });
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
  await assert.rejects(oauth.startLogin("apple", { stamper: fakeStamper(), storage: memoryStorage(), origin: ORIGIN, logins: { google: "g", apple: null }, go: () => {}, now: () => T0 }));
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

// ---------------------------------------------------------------------------
console.log("approving a recovery");

await check("only /guardian's CSP adds Turnkey's API, and only when given", () => {
  assert.match(guardianPageCsp("https://api.turnkey.com"), /connect-src 'self' https:\/\/api\.turnkey\.com(;|$)/);
  assert.match(guardianPageCsp(), /connect-src 'self'(;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'(;|$)/);
});

const DIGEST = `0x${"ab".repeat(32)}`;
const stampingStamper = () => {
  const stamped: string[] = [];
  return { stamped, stamp: async (body: string) => { stamped.push(body); return { stampHeaderName: "X-Stamp", stampHeaderValue: `stamp-of-${stamped.length}` }; } };
};
const turnkeyFetch = (answers: any[]) => {
  const calls: { url: string; headers: any; body: any }[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.shift();
    return { ok: a.ok ?? true, status: a.status ?? 200, json: async () => a.body };
  };
  return { calls, fn };
};
const completed = { activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", result: { signRawPayloadResult: { r: "11".repeat(32), s: "22".repeat(32), v: "01" } } } };

await check("sign_raw_payload: the digest with its 0x, hex encoding, no extra hash, stamped by the browser key", async () => {
  const st = stampingStamper();
  const tf = turnkeyFetch([{ body: completed }]);
  const sig = await signer.signRawPayload({ stamper: st, baseUrl: "https://api.turnkey.com", organizationId: "sub-1", signWith: "0xG", payload: DIGEST, fetchImpl: tf.fn, now: () => 1234 });
  assert.deepEqual(sig, { r: "11".repeat(32), s: "22".repeat(32), v: "01" });
  assert.equal(tf.calls[0].url, "https://api.turnkey.com/public/v1/submit/sign_raw_payload");
  assert.deepEqual(tf.calls[0].body, {
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", timestampMs: "1234", organizationId: "sub-1",
    parameters: { signWith: "0xG", payload: DIGEST, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
  });
  assert.equal(tf.calls[0].headers["X-Stamp"], "stamp-of-1");
  assert.equal(st.stamped[0], JSON.stringify(tf.calls[0].body), "the stamp covers exactly the body sent");
});

await check("sign_raw_payload: a pending activity is polled through get_activity until complete", async () => {
  const tf = turnkeyFetch([{ body: { activity: { id: "act-2", status: "ACTIVITY_STATUS_PENDING" } } }, { body: completed }]);
  const sig = await signer.signRawPayload({ stamper: stampingStamper(), baseUrl: "https://t", organizationId: "sub-1", signWith: "0xG", payload: DIGEST, fetchImpl: tf.fn, sleep: async () => {} });
  assert.equal(sig.v, "01");
  assert.equal(tf.calls[1].url, "https://t/public/v1/query/get_activity");
  assert.deepEqual(tf.calls[1].body, { organizationId: "sub-1", activityId: "act-2" });
});

await check("sign_raw_payload: with pollActivity, a pending activity is read through it and stamped once", async () => {
  const st = stampingStamper();
  const tf = turnkeyFetch([{ body: { activity: { id: "act-3", status: "ACTIVITY_STATUS_PENDING" } } }]);
  const polled: string[] = [];
  const sig = await signer.signRawPayload({ stamper: st, baseUrl: "https://t", organizationId: "sub-1", signWith: "0xG", payload: DIGEST, fetchImpl: tf.fn, sleep: async () => {},
    pollActivity: async (id: string) => { polled.push(id); return completed; } });
  assert.equal(sig.v, "01");
  assert.deepEqual(polled, ["act-3"]);
  assert.equal(st.stamped.length, 1, "a passkey stamper prompts once");
});

await check("sign_raw_payload: failed, rejected, refused, endless or malformed answers throw", async () => {
  const run = (answers: any[], payload = DIGEST) =>
    signer.signRawPayload({ stamper: stampingStamper(), baseUrl: "https://t", organizationId: "o", signWith: "0xG", payload, fetchImpl: turnkeyFetch(answers).fn, sleep: async () => {}, poll: { tries: 2, delayMs: 0 } });
  await assert.rejects(run([{ body: { activity: { id: "a", status: "ACTIVITY_STATUS_FAILED" } } }]), /did not sign/);
  await assert.rejects(run([{ body: { activity: { id: "a", status: "ACTIVITY_STATUS_REJECTED" } } }]), /did not sign/);
  await assert.rejects(run([{ ok: false, status: 401, body: { message: "unauthorized" } }]), /refused/);
  const pending = { body: { activity: { id: "a", status: "ACTIVITY_STATUS_PENDING" } } };
  await assert.rejects(run([pending, pending, pending, pending]), /too long/);
  await assert.rejects(run([{ body: { activity: { id: "a", status: "ACTIVITY_STATUS_COMPLETED", result: {} } } }]), /without a signature/);
  await assert.rejects(run([], "0x1234"), /32 bytes/);
});

await check("return: blocked storage, or an answer without a guardian, ends in an error, not a throw", async () => {
  const blocked = returnEnv();
  blocked.env.storage = { getItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); }, setItem() {} };
  const r = await page.finishLogin(blocked.env);
  assert.equal(r?.step, "error");
  const empty = returnEnv();
  const api = empty.env.api;
  empty.env.api = async (p: string, b: any) => (p.endsWith("/guardians") ? {} : api(p, b));
  assert.equal((await page.finishLogin(empty.env)).step, "error");
  assert.equal((await page.finishAdd(undefined, empty.env)).step, "error", "Finish on a row that has gone");
});

// ---- the 1 € bank step and the Zoldenburg op on /guardian -------------------
const enrol = await import(pathToFileURL(path.join(PUB, "guardian/enrolment.js")).href);

await check("bank step: no transfer details before the IBAN is active; then they read as the person's own money", () => {
  const e = { available: true, armed: false, minimumEur: 1 };
  const noIban = enrol.enrolmentHtml(e, { ibanReady: false });
  assert.doesNotMatch(noIban, /data-enrol="new"/);
  assert.match(noIban, /href="\/app#monerium-settings">Get my Zold IBAN/, "the next step is the IBAN, as a button");
  const ready = enrol.enrolmentHtml(e, { ibanReady: true });
  assert.match(ready, /data-enrol="new">Confirm my bank account/);
  assert.match(ready, /nothing is charged/i, "reads as the user's own money, not a fee");
  // The step leads: its line and its button come before the explanation.
  for (const html of [noIban, ready]) {
    assert.ok(html.indexOf("g-step") < html.indexOf("z-btn--primary"), "the step line, then its button");
    assert.ok(html.indexOf("z-btn--primary") < html.indexOf("Why 1 €?"), "the why folds away below the button");
    assert.match(html, /<details class="g-why">/);
  }
  assert.match(enrol.enrolmentHtml({ available: false }), /isn’t open yet/);
  assert.equal(enrol.enrolmentHtml(undefined), "");
});

await check("bank step: the code's details show only for the code this page issued, escaped", () => {
  const e = { available: true, armed: false, minimumEur: 1, codeIssuedAt: "2026-10-11T10:00:00Z", codeExpiresAt: "2026-10-18T10:00:00Z" };
  const issued = { codeIssuedAt: e.codeIssuedAt, memo: "ZOLD <b>X</b>", payTo: { iban: "DE00 TEST", name: "Ada" } };
  const mine = enrol.enrolmentHtml(e, { ibanReady: true, issued });
  assert.match(mine, /ZOLD &lt;b&gt;X&lt;\/b&gt;/);
  assert.match(mine, /I sent it — check now/);
  const stale = enrol.enrolmentHtml(e, { ibanReady: true, issued: { ...issued, codeIssuedAt: "2026-10-01T00:00:00Z" } });
  assert.doesNotMatch(stale, /ZOLD/, "a code replaced since, on another device, is not shown");
  assert.match(stale, /valid until/);
  const armed = enrol.enrolmentHtml({ available: true, armed: true, minimumEur: 1, bankAccountLast4: "1234" });
  assert.match(armed, /ending 1234 is confirmed/);
});

await check("bank step: a new code needs a passkey step-up for exactly that action", async () => {
  const calls: any[] = [];
  const r = await enrol.issueEnrolmentCode({
    userId: "u 1",
    stepUp: async (action: string) => ({ approved: action }),
    api: async (p: string, b: any) => { calls.push([p, b]); return { memo: "M" }; },
  });
  assert.equal(r.memo, "M");
  assert.deepEqual(calls, [["/api/users/u%201/recovery/zoldenburg/enrolment", { stepUp: { approved: "recovery.enrolment" } }]]);
});

await check("bank step: armed, a waiting code, and Monerium's last answer (escaped, only while a code waits)", () => {
  const armed = enrol.enrolmentHtml({ available: true, armed: true, minimumEur: 1, bankAccountLast4: "1234" });
  assert.match(armed, /Changed banks\?/);
  assert.match(armed, /data-enrol="new"/);
  const armedWaiting = enrol.enrolmentHtml({ available: true, armed: true, minimumEur: 1, bankAccountLast4: "1234", codeIssuedAt: "a", codeExpiresAt: "2026-10-18T10:00:00Z", lastCheck: { reason: "<i>x" } });
  assert.doesNotMatch(armedWaiting, /Changed banks/);
  assert.match(armedWaiting, /check now/);
  assert.match(armedWaiting, /role="status">&lt;i&gt;x/);
  assert.doesNotMatch(enrol.enrolmentHtml({ available: true, armed: true, minimumEur: 1, bankAccountLast4: "1", lastCheck: { reason: "STALE-ANSWER" } }), /STALE-ANSWER/, "no answer shown with no code waiting");
});

await check("bank step: a refused step-up issues no code; check asks the check route", async () => {
  const calls: any[] = [];
  const api = async (p: string, b: any) => { calls.push([p, b]); return {}; };
  await assert.rejects(enrol.issueEnrolmentCode({ api, userId: "u1", stepUp: async () => { throw new Error("cancelled"); } }));
  assert.equal(calls.length, 0);
  await enrol.checkEnrolment({ api, userId: "u1" });
  assert.deepEqual(calls, [["/api/users/u1/recovery/zoldenburg/enrolment/check", {}]]);
});

await check("bank step: a check clears the shown code only once confirmed with none waiting", () => {
  const issued = { memo: "M" };
  const done = enrol.afterCheck({ armed: true }, issued);
  assert.equal(done.issued, null);
  assert.match(done.message.text, /confirmed/);
  assert.equal(enrol.afterCheck({ armed: true, codeIssuedAt: "a" }, issued).issued, issued, "re-enrolling: the new code still waits");
  assert.equal(enrol.afterCheck({ armed: false }, issued).issued, issued);
  assert.equal(enrol.afterCheck({ armed: false }, issued).message, null);
});

const fakeButton = (text: string) => ({ textContent: text, attrs: {} as Record<string, string>,
  getAttribute(k: string) { return this.attrs[k] ?? null; }, setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } });

await check("adding Zoldenburg: after the passkey the button says it is working and is read out; a second click does nothing", async () => {
  const btn = fakeButton("Choose Zoldenburg");
  const announced: string[] = [];
  let during: any = null, submits = 0;
  const api = async (p: string) => {
    if (p.endsWith("/ops/x")) {
      submits++;
      during = { text: btn.textContent, busy: btn.getAttribute("aria-disabled") };
      await second();
      return {};
    }
    return { challenge: "c", credentialId: "k", submitTo: "/api/users/u1/recovery/zoldenburg/ops/x" };
  };
  const click = page.oneAtATime(btn, () => page.zoldenburgOp(true, btn, { api, userId: "u1", passkeyGet: async () => ({}), announce: (m: string) => announced.push(m) }));
  const second = click;
  await click();
  assert.equal(submits, 1, "the click during the operation did nothing");
  assert.match(during.text, /^Adding Zoldenburg to your wallet…/);
  assert.equal(during.busy, "true", "aria-disabled, so it keeps focus");
  assert.ok(announced.some((m) => /^Adding Zoldenburg to your wallet/.test(m)), "read out, not only drawn");
  assert.equal(btn.textContent, "Choose Zoldenburg");
  assert.equal(btn.getAttribute("aria-disabled"), null);
});

await check("one action at a time on the page: a second button's click while the first runs does nothing", async () => {
  const lock = { busy: false };
  const a = fakeButton("Check"), b = fakeButton("New code");
  let runs = 0, release: () => void = () => {};
  const first = page.oneAtATime(a, () => { runs++; return new Promise<void>((r) => { release = r; }); }, lock);
  const second = page.oneAtATime(b, async () => { runs++; }, lock);
  const pending = first();
  await second();
  assert.equal(runs, 1, "the other button waited");
  release();
  await pending;
  await second();
  assert.equal(runs, 2, "free again once the first is done");
});

const approveEnv = (over: Record<string, any> = {}) => {
  const storage = memoryStorage();
  storage.setItem(oauth.OAUTH_STATE_KEY, stored());
  const stamper = fakeStamper();
  stamper.key = KEY;
  const log: string[] = [];
  const calls: { path: string; body: any; headers: any }[] = [];
  const answers: Record<string, any> = {
    "/api/recovery/turnkey/login": { session: "jwt", subOrgId: "sub-1", address: "0xG" },
    "/api/recovery/turnkey/requests/rq1/digest": { digest: DIGEST },
    "/api/recovery/turnkey/requests/rq1/signature": { id: "rq1", status: "GRACE_PERIOD" },
  };
  return {
    log, calls, stamper,
    env: {
      hash: "#id_token=tok.en.x&state=s1", storage, stamper, now: () => T0 + 1000,
      recovery: { requestId: "rq1", secret: "sec" }, turnkeyApi: "https://api.turnkey.com",
      stripHash: () => log.push("strip"),
      api: async (p: string, body: any, headers: any = {}) => {
        log.push(`api ${p}`);
        calls.push({ path: p, body, headers });
        return answers[p];
      },
      sign: async (args: any) => {
        log.push(`sign ${args.organizationId} ${args.signWith} ${args.payload}`);
        return { r: "11", s: "22", v: "01" };
      },
      ...over,
    },
  };
};

await check("approve: strip, Turnkey session with the bound key, digest, sign with that sub-org, relay, drop the key", async () => {
  const t = approveEnv();
  const r = await approve.finishApprove(t.env);
  assert.equal(r.step, "approved", JSON.stringify(r));
  assert.equal(r.request.status, "GRACE_PERIOD");
  assert.deepEqual(t.log, [
    "strip",
    "api /api/recovery/turnkey/login",
    "api /api/recovery/turnkey/requests/rq1/digest",
    `sign sub-1 0xG ${DIGEST}`,
    "api /api/recovery/turnkey/requests/rq1/signature",
  ]);
  assert.deepEqual(t.calls[0].body, { oidcToken: "tok.en.x", publicKey: KEY });
  assert.equal(t.calls[1].headers["x-recovery-secret"], "sec");
  assert.deepEqual(t.calls[2].body, { r: "11", s: "22", v: "01" });
  assert.equal(t.calls[2].headers["x-recovery-secret"], "sec");
  assert.ok(t.stamper.calls.includes("clear"));
});

await check("approve: a login that is not the request's guardian is refused by the API and named in plain words", async () => {
  const t = approveEnv();
  const api = t.env.api;
  t.env.api = async (p: string, b: any, h: any) => {
    if (p.endsWith("/login")) return { session: "jwt", subOrgId: "sub-OTHER", address: "0xO" };
    if (p.endsWith("/signature")) throw Object.assign(new Error("this signature is not from the guardian on the account"), { code: "WRONG_SIGNER" });
    return api(p, b, h);
  };
  const r = await approve.finishApprove(t.env);
  assert.equal(r.step, "error");
  assert.match(r.reason, /different login from your backup login/);
  assert.ok(t.log.includes(`sign sub-OTHER 0xO ${DIGEST}`), "it signs with the login's own key, which the API refuses");
  assert.ok(t.stamper.calls.includes("clear"));
});

await check("approve: blocked storage ends in an error, not a throw", async () => {
  const t = approveEnv();
  t.env.storage = { getItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); }, setItem() {} };
  const r = await approve.finishApprove(t.env);
  assert.equal(r?.step, "error");
  assert.equal(t.calls.length, 0);
});

await check("approve: a refused state or a refused signature ends in an error, key dropped", async () => {
  const forged = approveEnv({ hash: "#id_token=tok.en.x&state=forged" });
  assert.equal((await approve.finishApprove(forged.env)).step, "error");
  assert.equal(forged.calls.length, 0);
  assert.ok(forged.stamper.calls.includes("clear"));
  const refused = approveEnv();
  const api = refused.env.api;
  refused.env.api = async (p: string, b: any, h: any) => {
    if (p.endsWith("/signature")) throw new Error("this signature is not from the guardian on the account");
    return api(p, b, h);
  };
  const r = await approve.finishApprove(refused.env);
  assert.equal(r.step, "error");
  assert.match(r.reason, /not from the guardian/);
  assert.ok(refused.stamper.calls.includes("clear"));
});

// ---------------------------------------------------------------------------
console.log("/recovery flow");

await check("a login started on /recovery comes back to /recovery", async () => {
  let went = "";
  await oauth.startLogin("google", { stamper: fakeStamper(), storage: memoryStorage(), origin: ORIGIN, logins: { google: "g.apps.googleusercontent.com" }, returnPath: "/recovery", go: (u: string) => (went = u), now: () => T0 });
  assert.equal(new URL(went).searchParams.get("redirect_uri"), `${ORIGIN}/recovery`);
});

await check("guardians are tried in order — codes, Zoldenburg, Google/Apple — only those the deployment offers", () => {
  assert.deepEqual(flow.routesFor({ emailSmsRecovery: true, zoldenburgRecovery: true, turnkeyGuardians: true }).map((r: any) => r.mode), ["candide", "zoldenburg", "turnkey"]);
  assert.deepEqual(flow.routesFor({ turnkeyGuardians: true }).map((r: any) => r.path), ["/api/recovery/turnkey/requests"]);
  assert.deepEqual(flow.routesFor({}), []);
});

await check("start falls through on 404 to the next guardian, and stops on any other refusal", async () => {
  const tried: string[] = [];
  const api = async (p: string, body: any) => {
    tried.push(p);
    if (!p.includes("turnkey")) throw Object.assign(new Error("recovery not found"), { status: 404 });
    return { id: "rq1", status: "PASSKEY_PENDING", body };
  };
  const r = await flow.startRecovery("a@b.c", { api, caps: { emailSmsRecovery: true, zoldenburgRecovery: true, turnkeyGuardians: true }, secret: "sec" });
  assert.equal(r.mode, "turnkey");
  assert.deepEqual(tried, ["/api/recovery/candide", "/api/recovery/zoldenburg", "/api/recovery/turnkey/requests"]);
  assert.deepEqual(r.request.body, { email: "a@b.c", recoverySecret: "sec" });
  const busy = async () => { throw Object.assign(new Error("in progress"), { status: 409, code: "RECOVERY_IN_PROGRESS" }); };
  await assert.rejects(flow.startRecovery("a@b.c", { api: busy, caps: { emailSmsRecovery: true, zoldenburgRecovery: true } }), /in progress/);
  await assert.rejects(flow.startRecovery("a@b.c", { api, caps: {} }), /isn’t available/);
});

await check("each state opens its screen; an ended request goes back to the email step", () => {
  const cases: [string, string, string][] = [
    ["candide", "PASSKEY_PENDING", "passkey"], ["candide", "OTP_PENDING", "codes"], ["zoldenburg", "REVIEW_PENDING", "zoldenburg"],
    ["turnkey", "REVIEW_PENDING", "approve"], ["turnkey", "GRACE_PERIOD", "wait"], ["zoldenburg", "FINALIZED", "done"],
    ["turnkey", "CANCELED", "email"], ["candide", "EXPIRED", "email"],
  ];
  for (const [mode, status, screen] of cases) assert.equal(flow.screenFor(mode, { status }), screen, `${mode} ${status}`);
  assert.equal(flow.screenFor("turnkey", null), "email");
  assert.match(flow.endedText({ status: "CANCELED" }), /stopped/);
});

await check("request paths and the waiting period, per guardian", () => {
  assert.equal(flow.requestPath("turnkey", "rq1", "/finalize"), "/api/recovery/turnkey/requests/rq1/finalize");
  assert.equal(flow.requestPath("zoldenburg", "rq1"), "/api/recovery/zoldenburg/rq1");
  assert.equal(flow.finalizeAfter({ turnkey: { finalizeAfter: "2026-10-13T09:00:00Z" } })?.toISOString(), "2026-10-13T09:00:00.000Z");
  assert.equal(flow.finalizeAfter({}), null);
  assert.equal(flow.currentAuth({ candide: { auths: [{ verified: true }, { verified: false }] } }), 1);
});

await check("the secret is kept per email, in the same place /app kept it", () => {
  const st = memoryStorage();
  assert.equal(flow.SECRET_KEY, "zold-recovery-secret");
  flow.saveFor(st, flow.SECRET_KEY, "A@B.c", "sec");
  assert.equal(flow.savedFor(st, flow.SECRET_KEY, "a@b.C"), "sec");
  flow.saveFor(st, flow.SECRET_KEY, "a@b.c", "");
  assert.equal(flow.savedFor(st, flow.SECRET_KEY, "a@b.c"), "");
});

// ---------------------------------------------------------------------------
console.log("/guardian changes");

await check("a guardian change: prepare, passkey, submit; an answer without a challenge needed no op", async () => {
  const calls: string[] = [];
  const api = async (p: string, body: any) => {
    calls.push(`${p} ${JSON.stringify(body)}`);
    return p.endsWith("/ops/r1") ? { ok: true } : { challenge: "ch", credentialId: "c", rpId: "localhost", submitTo: "/api/x/ops/r1" };
  };
  const r = await page.runPasskeyOp("/api/users/u1/recovery/zoldenburg", { acknowledged: true }, { api, passkeyGet: async () => ({ signature: "s" }) });
  assert.deepEqual(r, { ok: true, result: { ok: true } });
  assert.deepEqual(calls, ['/api/users/u1/recovery/zoldenburg {"acknowledged":true}', '/api/x/ops/r1 {"signature":"s"}']);
  const none = await page.runPasskeyOp("/api/x/remove", {}, { api: async () => ({ removed: true }), passkeyGet: async () => { throw new Error("not asked"); } });
  assert.deepEqual(none, { ok: true, result: { removed: true } });
});

await check("a guardian change: a dismissed passkey or a refusal changes nothing and says so", async () => {
  const api = async () => ({ challenge: "ch", submitTo: "/x" });
  const dismissed = await page.runPasskeyOp("/p", {}, { api, passkeyGet: async () => { throw new Error("NotAllowedError"); } });
  assert.equal(dismissed.ok, false);
  assert.match(dismissed.reason, /cancelled/);
  const refused = await page.runPasskeyOp("/p", {}, { api: async () => { throw new Error("remove your backup login first — one guardian at a time"); }, passkeyGet: async () => ({}) });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /one guardian at a time/);
});

console.log("email and passkey logins");

await check("the email login signature is Turnkey's own message, signed raw by the token's key", async () => {
  const token = `h.${Buffer.from(JSON.stringify({ id: "tok-1", public_key: "02ab", contact: "m@example.com" })).toString("base64url")}.s`;
  const signed: unknown[] = [];
  const sig = await logins.emailLoginSignature({ sign: async (m: string, f: string) => (signed.push([m, f]), "r||s") }, token);
  const message = '{"login":{"publicKey":"02ab"},"tokenId":"tok-1","type":"USAGE_TYPE_LOGIN"}';
  assert.deepEqual(signed, [[message, "raw"]]);
  assert.deepEqual(sig, { publicKey: "02ab", scheme: "CLIENT_SIGNATURE_SCHEME_API_P256", message, signature: "r||s" });
});

await check("an email code is sealed with a fresh key, and only the sealed bundle reaches our API", async () => {
  const posted: any[] = [];
  const stamper = { init: async () => {}, resetKeyPair: async () => {}, getPublicKey: () => "03cd" };
  const api = async (p: string, body: any) => (posted.push([p, body]), { verificationToken: "tok" });
  await assert.rejects(logins.emailCodeToToken({ api, stamper, encrypt: async () => "x", otp: {}, code: "12a456" }), /6 digits/);
  const tok = await logins.emailCodeToToken({ api, stamper, encrypt: async (code: string, target: string, key: string) => `sealed(${code},${target},${key})`, otp: { otpId: "o1", otpEncryptionTargetBundle: "T" }, code: "123456" });
  assert.equal(tok, "tok");
  assert.deepEqual(posted, [["/api/recovery/turnkey/email/verify", { otpId: "o1", encryptedOtpBundle: "sealed(123456,T,03cd)" }]]);
  assert.ok(!JSON.stringify(posted).includes('"123456"'), "the plain code is never sent");
});

await check("a recovery passkey comes back in Turnkey's attestation shape", async () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7);
  const credentials = { create: async (o: any) => {
    assert.equal(o.publicKey.rp.id, "zoldhq.com");
    assert.deepEqual(o.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
    return { rawId: new Uint8Array([1, 2]).buffer, response: { clientDataJSON: new Uint8Array([3]).buffer, attestationObject: new Uint8Array([4]).buffer, getTransports: () => ["internal", "hybrid", "smoke-signal"] } };
  } };
  const r = await logins.createGuardianPasskey({ credentials, rpId: "zoldhq.com", random: bytes });
  assert.equal(r.challenge, Buffer.from(bytes(32)).toString("base64url"));
  assert.deepEqual(r.attestation, { credentialId: "AQI", clientDataJson: "Aw", attestationObject: "BA", transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL", "AUTHENTICATOR_TRANSPORT_HYBRID"] });
});

await check("a passkey proves itself with a stamped whoami on the parent org", async () => {
  const stamper = { stamp: async (body: string) => ({ stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: JSON.stringify({ credentialId: "cred-9", body }) }) };
  const r = await logins.passkeyWhoami(stamper, "org-parent");
  assert.equal(r.credentialId, "cred-9");
  assert.equal(r.whoami.body, JSON.stringify({ organizationId: "org-parent" }));
  assert.equal(JSON.parse(r.whoami.stamp).body, r.whoami.body, "the stamp covers exactly the body relayed");
});

await check("approving: a pending signature is polled through the API with the login's sub-org", async () => {
  const seen: any[] = [];
  const api = async (p: string, body?: any) => { seen.push([p, body]); return p.endsWith("/digest") ? { digest: `0x${"11".repeat(32)}` } : { status: "GRACE_PERIOD" }; };
  await approve.approveWith({ stamper: {}, api, recovery: { requestId: "r1", secret: "s" }, turnkeyApi: "https://t",
    login: async () => ({ subOrgId: "sub-1", address: "0xabc" }), sign: async (o: any) => { await o.pollActivity("act-1"); return { r: "1", s: "2", v: "0" }; } });
  assert.ok(seen.some(([p, b]) => p === "/api/recovery/turnkey/activity" && b.subOrgId === "sub-1" && b.activityId === "act-1"));
});

await check("approving with a passkey: its stamper has no key to clear, and that is fine", async () => {
  const api = async (p: string) => (p.endsWith("/digest") ? { digest: `0x${"11".repeat(32)}` } : { status: "GRACE_PERIOD" });
  const r = await approve.approveWith({ stamper: {}, api, recovery: { requestId: "r1", secret: "s" }, turnkeyApi: "https://api.turnkey.com",
    login: async () => ({ subOrgId: "sub-1", address: "0xabc" }), sign: async () => ({ r: "1", s: "2", v: "0" }) });
  assert.deepEqual(r, { step: "approved", request: { status: "GRACE_PERIOD" } });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
