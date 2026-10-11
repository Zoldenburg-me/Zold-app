/**
 * Money in, opened from Activity (app/phone-activity.js PH.in, and its
 * desktop drawer in app/desktop.js).
 *
 * Every Activity row opens what happened to that money: a bank transfer's
 * payer and reference, a crypto deposit's sender, what it is held as, the
 * conversion and its measured euros, and links to both transactions on the
 * chain explorer. A held USDC deposit offers "Convert to euros"; a converted
 * one does not.
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
const SENDER = "0x2222222222222222222222222222222222222222";
const ARRIVE = `0x${"ab".repeat(32)}`;
const CONV = `0x${"cd".repeat(32)}`;
run(`user = ${JSON.stringify({ id: "u1", name: "Erika Muster", kycStatus: "approved", address: SAFE })}; capsLoaded = true;`);
const rows = [
  { kind: "funding", id: "dep-usdc", at: "2026-10-11T21:04:00Z", chainId: 8453, token: "USDC", txHash: ARRIVE, from: SENDER, arrivedAt: "2026-10-11T21:03:50Z",
    amountUsdc: 1, amountEur: 0.86, holding: "converted", creditedEur: 0.89, conversionTxHash: CONV, convertedAt: "2026-10-11T21:42:00Z", detectedAt: "2026-10-11T21:04:00Z", updatedAt: "2026-10-11T21:42:00Z" },
  { kind: "funding", id: "dep-held", at: "2026-10-10T10:00:00Z", chainId: 8453, token: "USDC", txHash: ARRIVE, amountUsdc: 5, holding: "held", detectedAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z" },
  { kind: "bank_in", id: "ord-1", at: "2026-10-09T10:00:00Z", amountEur: 120, counterpartyName: "Anna Payer", memo: "Rent October" },
];
run(`hist.splice(0, hist.length, ...${JSON.stringify(rows)}); histLoaded = true; histLoadFailed = false;`);
const flat = (html: string) => html.replace(/\s+/g, " ");

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("every money-in row in Activity opens its own detail, not Add money", () => {
  const html = flat(run("PH.activity.html(null)"));
  for (const id of ["dep-usdc", "dep-held", "ord-1"]) assert.ok(html.includes(`href="#in/${id}"`), `row ${id} links to #in/${id}`);
  assert.ok(!html.includes(`href="#add/wallet"`));
});

await t("a converted USDC deposit says what it became, with both transactions on Basescan", () => {
  const html = flat(run(`PH.in.html("dep-usdc")`));
  assert.match(html, /\+1\.00 USDC|\+\$1\.00/);
  assert.match(html, /CONVERTED/);
  assert.match(html, /Converted to €0\.89, now in your account as euros\./);
  assert.match(html, /Converted to<\/dt>.*<strong>€0\.89<\/strong>/);
  assert.ok(html.includes(`https://basescan.org/tx/${ARRIVE}`), "arrival on the explorer");
  assert.ok(html.includes(`https://basescan.org/tx/${CONV}`), "conversion on the explorer");
  assert.ok(html.includes("0x2222…2222"), "the sender, shortened");
  assert.doesNotMatch(html, /Convert to euros<\/span>/, "nothing left to convert");
});

await t("a held USDC deposit offers the conversion", () => {
  const html = flat(run(`PH.in.html("dep-held")`));
  assert.match(html, /Held as digital dollars/);
  assert.ok(html.includes(`href="#convert/dep-held"`));
});

await t("a bank transfer in shows the payer and the reference", () => {
  const html = flat(run(`PH.in.html("ord-1")`));
  assert.match(html, /\+€120\.00/);
  assert.match(html, /from Anna Payer/);
  assert.match(html, /Rent October/);
  assert.match(html, /Bank transfer \(SEPA\)/);
});

await t("an id that is not money in on this account says so", () => {
  assert.match(flat(run(`PH.in.html("nope")`)), /This payment is not on your account\./);
});

await t("the desktop drawer is registered for money in", () => {
  assert.equal(typeof run("PH.in.desk.bind"), "function");
  assert.equal(run(`phSideActive("in")`), "activity");
});

console.log(`\n${pass} passed, 0 failed`);
