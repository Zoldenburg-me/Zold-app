/**
 * The app's Monerium screen (#monerium-settings), the one Monerium screen a
 * company login may open from Business. It must offer the sign-in at
 * Monerium, not only the developer keys; show what an OAuth connection is
 * (login, profile and its kind); and a company that activates its IBAN lands
 * on Business → Accounts, where it connects that IBAN.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screen in a browser, or the OAuth round trip itself
 * (monerium:oauth:test covers the routes). Offline.
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

// The screen's own elements are plain objects to read back; the rest stay stubs.
const els: Record<string, any> = {};
ctx.__els = els;
ctx.document.getElementById = (id: string) => id.startsWith("m-mon-") ? (els[id] ||= { id, classList: { add() {}, remove() {}, contains: () => false } }) : stub;
const body = () => String(run(`__els["m-mon-body"].innerHTML`)).replace(/\s+/g, " ");
const show = (u: any, c: any) => { run(`user = ${JSON.stringify(u)}; caps = { ...caps, ...${JSON.stringify(c)} };`); run("renderMoneriumScreen()"); return body(); };

const company = { id: "c1", accountType: "company", kycStatus: "pending", funding: { mode: "sandbox", status: "kyc_pending" } };
const BOTH = { moneriumOAuth: true, moneriumApiKeys: true };

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("not connected: Continue with Monerium first, the keys as the developer option", () => {
  const html = show(company, BOTH);
  assert.match(html, /id="m-mon-oauth"[^>]*>Continue with Monerium</);
  assert.match(html, /choose Company/);
  assert.match(html, /Developer option: your own API keys/);
  assert.ok(html.indexOf("m-mon-oauth") < html.indexOf("m-mon-id"), "sign-in comes before the keys form");
});

await t("not connected, no OAuth client: the keys form alone, as before", () => {
  const html = show(company, { moneriumOAuth: false, moneriumApiKeys: true });
  assert.doesNotMatch(html, /m-mon-oauth/);
  assert.match(html, /id="m-mon-id"/);
});

await t("not connected, no key storage: the sign-in still shows", () => {
  const html = show(company, { moneriumOAuth: true, moneriumApiKeys: false });
  assert.match(html, /Continue with Monerium/);
  assert.doesNotMatch(html, /Unavailable/);
});

await t("a refused sign-in says why on the screen", () => {
  const html = show({ ...company, moneriumRefusal: { error: "That Monerium login has no company profile." } }, BOTH);
  assert.match(html, /no company profile/);
});

await t("connected by OAuth: login, profile and its kind; no keys form or Remove keys", () => {
  const html = show({ ...company, monerium: { method: "oauth", connectedAt: "2026-10-27T10:00:00Z", accountEmail: "kora@example.test", profileId: "p1",
    profiles: [{ id: "p1", name: "Kora Corp", kind: "corporate", state: "approved" }] } }, BOTH);
  assert.match(html, /Connected/);
  assert.match(html, /kora@example\.test/);
  assert.match(html, /Kora Corp \(Company\)/);
  assert.doesNotMatch(html, /m-mon-id|m-mon-remove|m-mon-oauth|Client id/);
  assert.match(String(run(`__els["m-mon-lede"].textContent`)), /signing in at Monerium/);
});

await t("connected by keys: the key rows and Remove keys, as before", () => {
  const html = show({ ...company, monerium: { method: "api_keys", connectedAt: "2026-10-27T10:00:00Z", profileId: "p1",
    apiKeys: { clientId: "cid-1", environment: "sandbox", host: "api.monerium.dev", verifiedAt: "2026-10-27T10:00:00Z" } } }, BOTH);
  assert.match(html, /cid-1/);
  assert.match(html, /m-mon-remove/);
  assert.doesNotMatch(html, /m-mon-oauth/);
});

await t("the button starts the connect with its own error slot, and stays off on its way to Monerium", async () => {
  show(company, BOTH);
  run(`__started = []; startMoneriumConnect = async (slot) => { __started.push(slot); return true; };`);
  await run(`__els["m-mon-oauth"].onclick()`);
  assert.deepEqual(JSON.parse(JSON.stringify(run("__started"))), ["m-mon-err"]);
  assert.equal(run(`__els["m-mon-oauth"].disabled`), true, "no second click while the page leaves");
});

await t("a failed connect switches the button back on", async () => {
  show(company, BOTH);
  run(`startMoneriumConnect = async () => undefined;`);
  await run(`__els["m-mon-oauth"].onclick()`);
  assert.equal(run(`__els["m-mon-oauth"].disabled`), false);
});

await t("Get your IBAN on this screen: a company that is then approved goes on to Business → Accounts", async () => {
  const oauthCo = { ...company, monerium: { method: "oauth", connectedAt: "2026-10-27T10:00:00Z", profileId: "p1", profiles: [{ id: "p1", kind: "corporate", state: "approved" }] } };
  show(oauthCo, BOTH);
  assert.match(body(), /id="m-mon-activate"/);
  run(`__went = []; location.assign = (u) => __went.push(u); __navs = [];
    mobileNav = (n) => __navs.push(n); issueAppIban = async () => { user = { ...user, kycStatus: "approved" }; };`);
  await run(`__els["m-mon-activate"].onclick()`);
  await run(`__els["m-mon-activate"].onclick()`);
  assert.deepEqual(JSON.parse(JSON.stringify(run("__went"))), ["/business?view=accounts"], "a second click runs nothing");
  assert.equal(run("__navs.length"), 0);
});

await t("a company that finishes activation goes to Business → Accounts; a plain finish to Business", () => {
  run(`user = ${JSON.stringify(company)}; __went = []; location.assign = (u) => __went.push(u);`);
  run(`obFinish("accounts"); obFinish();`);
  assert.deepEqual(JSON.parse(JSON.stringify(run("__went"))), ["/business?view=accounts", "/business"]);
});

console.log(`\nMONERIUM SCREEN UI TEST PASSED — ${pass}/${pass}`);
