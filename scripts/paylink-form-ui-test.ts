/**
 * The app's New payment link form when a way to pay is closed: the reason is
 * under the options, and with no payment page of its own, a link to set one
 * up (the gap report's M5: "crypto" was switched off with no reason).
 *
 * Runs the real classic scripts in load order with a stub DOM. Offline.
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

const flat = (html: string) => html.replace(/\s+/g, " ");
const form = (u: any, methods: any[]) => { run(`user = ${JSON.stringify(u)}; phCache.methods = ${JSON.stringify(methods)};`); return flat(run(`PH.link.html("new")`)); };
const NEEDS = "claim a payment page (Get paid → Your page in the app, or Settings → Payment page in Zold Business)";

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("no page of its own: digital dollars off, the reason under it, and a link to set the page up", () => {
  const html = form({ id: "u1", iban: "DE89370400440532013000" }, [
    { method: "crypto", available: false, needs: NEEDS }, { method: "bank", available: true }]);
  assert.match(html, /id="ph-lk-crypto"[^>]*disabled/);
  assert.match(html, /Digital dollars opens once you claim a payment page/);
  assert.match(html, /<a href="#get-paid\/page">Set up your page<\/a>/);
});

await t("a page but no IBAN: bank off with its reason, and no page link", () => {
  const html = form({ id: "u1", paymentPage: { handle: "kim" } }, [
    { method: "crypto", available: true }, { method: "bank", available: false, needs: "activate your IBAN with Monerium" }]);
  assert.match(html, /Bank transfer opens once you activate your IBAN with Monerium/);
  assert.doesNotMatch(html, /Set up your page/);
});

await t("everything open: no note", () => {
  const html = form({ id: "u1", paymentPage: { handle: "kim" } }, [{ method: "crypto", available: true }, { method: "bank", available: true }]);
  assert.doesNotMatch(html, /opens once you/);
});

console.log(`\nPAY LINK FORM UI TEST PASSED — ${pass}/${pass}`);
