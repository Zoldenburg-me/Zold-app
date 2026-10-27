/**
 * The app's Send to a crypto wallet: the full resolved address is on screen
 * before anything is signed, Send waits for the "I checked" tick, and the
 * address shown is the one the server is told to pay (confirmedAddress).
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
const ADDR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
run(`user = { id: "u1", kycStatus: "approved", iban: "DE89370400440532013000" }; caps = { ...caps, ensLookup: true, chainId: 8453 };
  __calls = []; __went = [];
  phGo = (name, arg) => __went.push(name);
  refresh = () => {};
  safeExecutionAssertion = async (a) => ({ credentialId: "c", authenticatorData: "a", clientDataJSON: "j", signature: "s", from: a.safeExecution.challenge });`);

/** A stub element: enough of the DOM for the bind code under test. */
const el = (extra: any = {}) => {
  const attrs = new Map<string, string>();
  return { value: "", checked: false, hidden: true, textContent: "", dataset: {}, focus() {}, querySelector: () => el(),
    setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null, ...extra };
};

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("the Send screen offers the crypto wallet as a real row", () => {
  const html = flat(run(`PH.send.html()`));
  assert.match(html, /href="#send\/wallet"/);
  assert.match(html, /EURe or USDC to an ENS name or 0x address/);
});

await t("the check screen shows the name, the full address, the network and the amount", () => {
  run(`phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}", sent: null }`);
  const html = flat(run(`PH["send/wallet-check"].html()`));
  assert.match(html, /alice\.eth/);
  assert.match(html, /0x 5aAe b605 3F3E 94C9 b9A0 9f33 6694 35E7 Ef1B eAed/, "every character of the address, grouped");
  assert.match(html, /Base/);
  assert.match(html, /25\.5 USDC/);
  assert.match(html, /I checked this address with them/);
});

await t("Send stays off until the address is ticked as checked", () => {
  const btn = el(); const ok = el();
  run(`PH["send/wallet-check"]`).bind({ querySelector: (s: string) => (s === "#ph-wal-send" ? btn : s === "#ph-wal-ok" ? ok : el()) });
  assert.equal(btn.getAttribute("aria-disabled"), "true");
  ok.checked = true; ok.onchange();
  assert.equal(btn.getAttribute("aria-disabled"), null);
});

await t("sending posts the address shown as confirmedAddress, signs, then submits", async () => {
  run(`api = async (p, b) => { __calls.push([p, b]); return p.endsWith("/authorize") ? { id: "s1", state: "SENT", to: "${ADDR}", token: "USDC", amount: "25.5", txHash: "0xab" } : { id: "s1", safeExecution: { credentialId: "c", challenge: "ch" } }; }`);
  await run(`phWalletSubmit`)(el(), el());
  const calls = run(`__calls`);
  assert.equal(calls[0][0], "/api/users/u1/crypto-sends");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { to: "alice.eth", token: "USDC", amount: "25.5", confirmedAddress: ADDR });
  assert.equal(calls[1][0], "/api/crypto-sends/s1/authorize");
  assert.equal(calls[1][1].executionAssertion.from, "ch", "the passkey signs the challenge the server returned");
  assert.equal(run(`__went.at(-1)`), "send/wallet-done");
  assert.match(flat(run(`PH["send/wallet-done"].html()`)), /Sent.*0xab/);
});

await t("a refused send says why and moves nowhere", async () => {
  run(`__went = []; api = async () => { throw new Error("the address changed since you checked it — check it again"); }`);
  const err = el();
  await run(`phWalletSubmit`)(el(), err);
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /address changed/);
  assert.equal(run(`__went.length`), 0);
});

await t("a name is looked up and the resolved address goes to the check screen", async () => {
  run(`__calls = []; __went = []; api = async (p) => { __calls.push([p]); return { name: "alice.eth", address: "${ADDR}", chainId: 8453 }; }`);
  const fields: Record<string, any> = { "#ph-wal-to": el({ value: " Alice.eth " }), "#ph-wal-amount": el({ value: "10,5" }), "#ph-wal-token": el({ value: "EURE" }) };
  const form = el(); const next = el();
  const root = { querySelector: (s: string) => (s === "#ph-wal" ? form : s === "#ph-wal-next" ? next : fields[s] ?? el()), querySelectorAll: () => [] };
  run(`Z = { ...Z, setFieldError() {}, focusFirstError: () => false }`);
  run(`PH["send/wallet"]`).bind(root);
  await form.onsubmit({ preventDefault() {} });
  assert.equal(run(`__calls[0][0]`), "/api/ens/lookup?name=Alice.eth");
  assert.equal(run(`phWallet.address`), ADDR);
  assert.equal(run(`phWallet.amount`), "10.5");
  assert.equal(run(`__went.at(-1)`), "send/wallet-check");
});

console.log(`\nCRYPTO SEND UI TEST PASSED — ${pass}/${pass}`);
