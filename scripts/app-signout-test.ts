/**
 * Signing out of /app ends the session on the server, not only in the browser.
 *
 * Runs the real classic scripts in load order with a stub DOM, against the
 * real auth router on an ephemeral port: after the Sign out button, the token
 * the browser held gets 401. A failed DELETE still clears this browser.
 * What this cannot show: keepalive surviving a real page reload. Offline.
 *
 *   npm run signout:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const express = (await import("express")).default;
const { initStore, store } = await import("../services/api/src/store.js");
const { issueSession, requireUserSession } = await import("../services/api/src/http/sessions.js");
const { createAuthRouter } = await import("../services/api/src/routes/auth.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");

initStore();
const app = express();
app.use(express.json());
app.use("/api", createAuthRouter({ requireUserSession }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const status = async (method: string, token: string) =>
  (await fetch(`${BASE}/api/session`, { method, headers: { authorization: `Bearer ${token}` } })).status;

// ── the app's scripts, with fetch pointed at the server above ───────────────
const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : stub),
  set: () => true,
  apply: () => stub,
});
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
const sent: { url: string; init: any; done: Promise<unknown> }[] = [];
let network = true;
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, platform: "test" },
  location: { pathname: "/app", search: "", hash: "", host: "zold.test", origin: "https://zold.test", assign() {}, replace() {}, reload() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: storage(),
  sessionStorage: storage(),
  fetch: (url: string, init: any) => {
    const done = network ? fetch(BASE + url, init) : Promise.reject(new TypeError("Failed to fetch"));
    sent.push({ url, init, done: done.catch(() => {}) });
    return done;
  },
  scrollTo() {},
  document: {
    hidden: false,
    getElementById: () => stub,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => stub,
    addEventListener() {},
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
const load = (f: string) => vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
load("ui.js");
for (const f of [
  "app/core.js", "app/dashboard.js", "app/transactions.js", "app/profile.js", "app/recovery.js", "app/monerium.js",
  "app/onboarding.js", "app/send.js", "app/signers.js", "app/phone.js", "app/phone-home.js", "app/phone-activity.js",
  "app/phone-send.js", "app/phone-add.js", "app/phone-getpaid.js", "app/phone-more.js", "app/settings.js", "app/desktop.js",
]) load(f);
const run = (code: string) => vm.runInContext(code, ctx);

const now = new Date().toISOString();
let n = 0;
/** A signed-in browser: a fresh account, its token in storage and in scope. */
function signIn() {
  n += 1;
  const id = `u_signout_${n}`;
  store.addUser({ id, name: `Person ${n}`, email: `s${n}@example.com`, country: "DE", kycStatus: "pending", createdAt: now, address: `0x${String(n).padStart(40, "b")}`, iban: "" } as any);
  const token = issueSession(id);
  ctx.localStorage.setItem("zold-session", token);
  ctx.localStorage.setItem("zoll-session", token);
  ctx.localStorage.setItem("zoll-contacts", JSON.stringify([{ id: "c1", name: "A", destination: "DE00" }]));
  run(`sessionToken = ${JSON.stringify(token)}; contacts = JSON.parse(localStorage.getItem("zoll-contacts"));`);
  return token;
}
const cleared = () => ["zold-session", "zoll-session", "zoll-contacts"].every((k) => ctx.localStorage.getItem(k) === null);

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

try {
  await t("Sign out revokes the token on the server: it gets 401 afterwards", async () => {
    const token = signIn();
    assert.equal(await status("GET", token), 200, "the session works before sign-out");
    sent.length = 0;
    run("signOut()");
    assert.equal(sent.length, 1, "one request on sign-out");
    assert.equal(sent[0].url, "/api/session");
    assert.equal(sent[0].init.method, "DELETE");
    assert.equal(sent[0].init.keepalive, true, "the DELETE must outlive the reload");
    assert.equal(sent[0].init.headers.authorization, `Bearer ${token}`);
    await sent[0].done;
    assert.equal(await status("GET", token), 401, "a copied token is dead after sign-out");
    assert.ok(cleared(), "session and the legacy contacts key are gone from storage");
    assert.equal(run("sessionToken"), null);
    assert.equal(run("contacts.length"), 0);
  });

  await t("no network: this browser is still signed out", async () => {
    const token = signIn();
    network = false;
    sent.length = 0;
    run("signOut()");
    await sent[0].done;
    network = true;
    assert.ok(cleared(), "storage is cleared even when the DELETE fails");
    assert.equal(run("sessionToken"), null);
    assert.equal(await status("GET", token), 200, "the DELETE never arrived, so the server still holds the session");
  });

  await t("signed out already: no request without a token", () => {
    run("sessionToken = null");
    sent.length = 0;
    run("signOut()");
    assert.equal(sent.length, 0);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed`);
