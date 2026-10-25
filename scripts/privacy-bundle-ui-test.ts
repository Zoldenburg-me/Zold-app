/**
 * The Privacy Bundle in the app (app/monerium.js renderPrivacyBundle, the
 * #bundle route in app/dashboard.js, the Settings row in app/settings.js).
 *
 * The offer (entry row, VPN/eSIM perks, plan buttons) shows only where
 * capabilities.privacyBundle is true. An account that already holds a
 * subscription keeps its status and its Cancel button either way.
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
/** An element whose class list and markup the test can read back. */
const element = () => {
  const classes = new Set<string>();
  return {
    innerHTML: "", textContent: "", className: "", onclick: null, dataset: {}, style: {}, scrollTop: 0,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)),
    },
    querySelector: () => element(),
    querySelectorAll: () => [],
    setAttribute() {}, appendChild() {}, addEventListener() {},
  };
};
const els = new Map<string, any>();
const fetched: string[] = [];
const el = (id: string) => els.get(id) ?? (els.set(id, element()), els.get(id));
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
  fetch: (url: string) => (fetched.push(String(url)), Promise.reject(new Error("no network in this test"))),
  scrollTo() {},
  document: {
    hidden: false,
    getElementById: el,
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

const CATALOG = {
  enabled: true,
  plans: [{ id: "travel-shield", name: "Travel Shield", priceEur: 9.99, esimGb: 3, esimRegion: "regional", vpnGb: 25, vpnDevices: 3, marginProtected: true }],
};
const PENDING = {
  planId: "travel-shield", status: "pending_fulfillment", startedAt: "2026-10-01T00:00:00Z", renewsAt: "2026-11-01T00:00:00Z",
  esim: { provider: "kokio", status: "pending", dataGb: 3, region: "regional" },
  vpn: { provider: "mysterium", status: "pending", bandwidthGb: 25, devices: 3 },
  usage: { esimGb: 0, vpnGb: 0, periodStartedAt: "2026-10-01T00:00:00Z" },
};
/** Render the bundle for one account and one deployment; the catalog fetch fails unless given. */
async function render(privacyBundle: unknown, live: boolean, catalog: unknown = null) {
  els.clear();
  fetched.length = 0;
  run(`user = ${JSON.stringify({ id: "u1", name: "Erika Muster", kycStatus: "approved", privacyBundle })};
    caps = { ...caps, privacyBundle: ${live} }; capsLoaded = true; privacyCatalog = ${JSON.stringify(catalog)};`);
  await run("renderPrivacyBundle()");
}
const hidden = (id: string) => el(id).classList.contains("hidden");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

await check("offer off, no subscription: nothing of the bundle is drawn", async () => {
  await render(undefined, false);
  for (const id of ["m-go-bundle", "privacy-card", "set-privacy-card", "m-perk-vpn", "m-perk-esim"]) assert.ok(hidden(id), id);
});

await check("offer off, a pending subscription keeps its status and Cancel, with no plan buttons", async () => {
  await render(PENDING, false, CATALOG);
  assert.ok(!hidden("m-go-bundle"));
  assert.ok(!hidden("privacy-card"));
  assert.ok(!hidden("privacy-status"));
  assert.match(el("privacy-status").innerHTML, /id="btn-privacy-cancel"/);
  assert.doesNotMatch(el("privacy-plans").innerHTML, /data-plan/);
  for (const id of ["set-privacy-card", "m-perk-vpn", "m-perk-esim"]) assert.ok(hidden(id), id);
  assert.deepEqual(fetched.filter((u) => u.includes("privacy-bundles")), [], "the catalog is not fetched while the offer is off");
});

await check("offer off, a canceled subscription is hidden like none", async () => {
  await render({ ...PENDING, status: "canceled" }, false);
  assert.ok(hidden("m-go-bundle"));
  assert.ok(hidden("privacy-card"));
});

await check("offer on, no subscription: the plans can be added", async () => {
  await render(undefined, true, CATALOG);
  assert.ok(!hidden("m-go-bundle"));
  assert.ok(!hidden("privacy-card"));
  assert.match(el("privacy-plans").innerHTML, /data-plan="travel-shield"/);
});

await check("#bundle lands on Plus where the offer is off and the account holds none, and stays for a subscriber", async () => {
  await render(undefined, false);
  run(`mobileNavLegacy("bundle")`);
  assert.equal(el("dashboard").dataset.msub, "plus");
  await render(PENDING, false);
  run(`mobileNavLegacy("bundle")`);
  assert.equal(el("dashboard").dataset.msub, "bundle");
});

await check("Settings shows a subscriber's bundle as awaiting setup, not active, while the offer is off", async () => {
  await render(PENDING, false);
  const html = run("PH.settings.html()");
  assert.match(html, /Zold Plus/);
  assert.match(html, /awaiting partner setup/);
  assert.doesNotMatch(html, /Privacy Bundle active/);
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nprivacy bundle ui: all checks passed");
