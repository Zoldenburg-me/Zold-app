/**
 * The app when the server could not read the balance from the chain.
 *
 * GET /api/session and the other responses that carry a balance leave
 * `balanceEur` and `safeBalanceEur` out when the chain read fails
 * (shownBalances, chain.ts). The app must then say the balance is
 * unavailable, never draw €0.00 for a Safe that may hold money, and refuse
 * to price a send it cannot check against the balance.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screens in a browser. Offline.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");

const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : stub),
  set: () => true,
  apply: () => stub,
});
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, platform: "test" },
  location: { pathname: "/app", search: "", hash: "", host: "zold.test", origin: "https://zold.test", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: storage(),
  sessionStorage: storage(),
  fetch: () => Promise.reject(new Error("no network in this test")),
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

const SAFE = "0x1111111111111111111111111111111111111111";
const base = {
  id: "u1", name: "Erika Muster", kycStatus: "approved", address: SAFE,
  passkey: { credentialId: "cred" }, passkeySafe: { status: "active", address: SAFE },
};
const unread = { ...base };
const funded = { ...base, balanceEur: 12.5, safeBalanceEur: 12.5 };
const setUser = (u: any) => run(`user = ${JSON.stringify(u)}; caps = { ...caps, sandbox: true }; capsLoaded = true;`);

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
const flat = (html: string) => html.replace(/\s+/g, " ");

await t("knownBalance: a number the server sent, or null when it sent none", () => {
  assert.equal(run(`knownBalance({ balanceEur: 12.5 })`), 12.5);
  assert.equal(run(`knownBalance({ balanceEur: 0 })`), 0, "a measured zero stays zero");
  assert.equal(run(`knownBalance({ safeBalanceEur: 3 })`), 3);
  assert.equal(run(`knownBalance({})`), null);
  assert.equal(run(`knownBalance(null)`), null);
});

await t("phone Home: an unread balance says so and draws no €0.00", () => {
  setUser(unread);
  const html = flat(run("PH.home.html()"));
  assert.match(html, /Balance unavailable/);
  assert.doesNotMatch(html, /<span class="z-balance__cur">€<\/span>0<span class="z-balance__cents">\.00/);
});

await t("desktop Home: an unread balance says so and draws no €0.00", () => {
  setUser(unread);
  const html = flat(run("phDeskBalance(user)"));
  assert.match(html, /Balance unavailable/);
  assert.doesNotMatch(html, /<span class="z-balance__cur">€<\/span>0<span class="z-balance__cents">\.00/);
});

await t("a read balance is drawn as before", () => {
  setUser(funded);
  const html = flat(run("PH.home.html()"));
  assert.match(html, /<span class="z-balance__cur">€<\/span>12<span class="z-balance__cents">\.50<\/span>/);
  assert.doesNotMatch(html, /Balance unavailable/);
});

await t("send: an unread balance is not 'Available €0.00', and no amount is priced against it", () => {
  setUser(unread);
  assert.equal(run("phAmountRefusal(5)").label, "Balance unavailable");
  assert.match(run("phAmountRefusal(5)").error, /could not be read/);
  assert.match(run("phAvailableText()"), /Balance unavailable/);
  setUser(funded);
  assert.equal(run("phAmountRefusal(5)"), null);
  assert.equal(run("phAmountRefusal(20)").label, "More than your balance");
  assert.match(run("phAvailableText()"), /Available €12\.50/);
});

console.log(`\n${pass} passed`);
