/**
 * "Copy all" / "Copy details" in the app's account details: a copy is seen
 * as well as heard (the label reads Copied, then goes back), and a failed
 * copy says so without claiming success (gap report L3).
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

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
run(`user = { id: "u1", name: "Kim", iban: "DE89370400440532013000" }; phCache.bic = "COBADEFFXXX";
  __said = []; window.Z = { ...Z, announce: (m) => __said.push(m) }; __timers = []; setTimeout = (f) => __timers.push(f);`);
const bind = (clipboard: any) => {
  ctx.navigator.clipboard = clipboard;
  const label: any = { textContent: "Copy all", dataset: {} };
  const btn: any = { querySelector: () => label };
  ctx.__root = { querySelector: (sel: string) => (sel === "#ph-det-copy" ? btn : null) };
  run("phBindDetails(__root)");
  return { btn, label };
};

await t("a copy shows Copied on the button and says it, then the label comes back", async () => {
  let copied = "";
  const { btn, label } = bind({ writeText: async (s: string) => { copied = s; } });
  await btn.onclick();
  assert.match(copied, /DE89/);
  assert.equal(label.textContent, "Copied");
  assert.equal(run("__said.at(-1)"), "Copied");
  run("__timers.forEach((f) => f())");
  assert.equal(label.textContent, "Copy all");
});

await t("two clicks inside 1.5 s still end on the original label", async () => {
  const { btn, label } = bind({ writeText: async () => {} });
  run("__timers = []");
  await btn.onclick();
  await btn.onclick();
  run("__timers.forEach((f) => f())");
  assert.equal(label.textContent, "Copy all");
});

await t("a refused copy says to copy by hand and never shows Copied", async () => {
  const { btn, label } = bind({ writeText: async () => { throw new Error("denied"); } });
  await btn.onclick();
  assert.equal(label.textContent, "Copy all");
  assert.match(String(run("__said.at(-1)")), /Could not copy/);
});

console.log(`\nAPP COPY UI TEST PASSED — ${pass}/${pass}`);
