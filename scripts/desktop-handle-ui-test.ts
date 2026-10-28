/**
 * The desktop app's handle form (public/app/send.js): a new handle brings
 * its new ENS name, or none, so the account card never offers the old name
 * after a rename. The API sends ensName with the claim only where Home
 * shows a name (users/public-user.ts; covered in ens:test).
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screen in a browser, or the claim route itself (it needs
 * a deployed Safe on chain). Offline.
 *
 *   npm run desktop:handle:test
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
const elements: Record<string, any> = { "handle-input": { value: "" }, "btn-handle": {} };
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
    // The handle form's input and button are real objects, so the click handler send.js attaches can be called.
    getElementById: (id: string) => elements[id] ?? stub,
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
let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
const claim = async (answer: unknown) => {
  run(`__answer = ${JSON.stringify(answer)}; api = async () => __answer;`);
  elements["handle-input"].value = "erika-new";
  await elements["btn-handle"].onclick();
};
const base = { id: "u1", name: "Erika", address: SAFE, passkeySafe: { status: "active", address: SAFE } };

await t("a renamed handle replaces the name", async () => {
  run(`user = ${JSON.stringify({ ...base, ensName: "erika.zoldhq.com", paymentPage: { handle: "erika" } })};`);
  await claim({ handle: "erika-new", paymentPage: { handle: "erika-new" }, ensName: "erika-new.zoldhq.com" });
  assert.equal(run("user.ensName"), "erika-new.zoldhq.com");
  assert.equal(run("user.paymentPage.handle"), "erika-new");
});

await t("an answer without a name clears the old one", async () => {
  run(`user = ${JSON.stringify({ ...base, ensName: "erika.zoldhq.com", paymentPage: { handle: "erika" } })};`);
  await claim({ handle: "erika-new", paymentPage: { handle: "erika-new" } });
  assert.equal(run("user.ensName"), undefined, "no name is shown rather than the old handle's");
});

console.log(`desktop handle: ${pass} passed`);
