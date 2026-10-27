/**
 * The account's Safe address is easy to find in the app: an open row in
 * Account details (label, full address, copy button, network), and on Your
 * page under what the page takes. It was inside a collapsed "Crypto wallet
 * address" block that users did not find.
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
const SAFE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const FWD = "0x1111111111111111111111111111111111111111";
run(`caps = { ...caps, chainId: 8453 };`);
const base = { id: "u1", name: "Kim Lee", kycStatus: "approved", address: SAFE, passkeySafe: { status: "active", address: SAFE } };

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("account details show the wallet address open, as its own copyable row, with the network", () => {
  const html = flat(run(`phDetailsBody(${JSON.stringify({ ...base, iban: "DE89370400440532013000" })}, "COBADEFFXXX")`));
  assert.doesNotMatch(html, /<details/, "nothing to expand");
  assert.match(html, /Wallet address \(Base\)/);
  assert.match(html, new RegExp(`data-z-copy="${SAFE}"`), "the copy button copies the full address");
  assert.match(html, new RegExp(`>${SAFE}<`), "the full checksummed address is on screen");
  assert.ok(html.indexOf("IBAN") < html.indexOf("Wallet address"), "after the bank rows");
});

await t("without an IBAN the wallet address is the account's details", () => {
  const html = flat(run(`phDetailsBody(${JSON.stringify({ ...base, kycStatus: "pending" })}, null)`));
  assert.match(html, /Wallet address \(Base\)/);
  assert.match(html, new RegExp(`data-z-copy="${SAFE}"`));
});

await t("no active Safe, no wallet row", () => {
  const html = flat(run(`phDetailsBody(${JSON.stringify({ ...base, iban: "DE89370400440532013000", passkeySafe: { status: "pending" } })}, null)`));
  assert.doesNotMatch(html, /Wallet address/);
});

await t("Your page shows the address payers pay, named as the wallet when it is the Safe", () => {
  const page = { handle: "kim", depositAddress: SAFE, supportedTokens: [{ symbol: "USDC", chainId: 8453, decimals: 6 }] };
  run(`user = ${JSON.stringify({ ...base, paymentPage: page })}`);
  const html = flat(run(`PH["get-paid/page"].html()`));
  assert.match(html, /USDC on Base/);
  assert.match(html, /Wallet address \(Base\)/);
  assert.match(html, new RegExp(`data-z-copy="${SAFE}"`));
  run(`user = ${JSON.stringify({ ...base, paymentPage: { ...page, depositAddress: FWD } })}`);
  const fwd = flat(run(`PH["get-paid/page"].html()`));
  assert.match(fwd, /Page address/, "a forwarder is the page's address, not called the wallet");
  assert.match(fwd, new RegExp(`data-z-copy="${FWD}"`));
});

console.log(`\nSAFE ADDRESS UI TEST PASSED — ${pass}/${pass}`);
