/**
 * The recovery strip on every app screen (public/app/phone-home.js phRecBar,
 * phRecoveryCheck): what it says for a recovery on chain, for a Zoldenburg
 * request nobody signed, and for a check that failed; that "It was me" hides
 * only the recovery it was pressed for; that the account poll's check redraws
 * the strip without a full render; and that /business reads again on a timer.
 *
 * Runs the real classic scripts in a vm with a stub DOM and a recorded `api`.
 * What this cannot show: the strip in a browser, or a real cancel (the
 * passkey-signed `cancelRecovery`, covered by recovery:test). Offline.
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
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
// The strip's container: the one element this test reads.
const bar: any = { textContent: "", dataset: {} as Record<string, string> };
Object.defineProperty(bar, "innerHTML", {
  get() { return bar._h ?? ""; },
  set(v: string) { bar._h = v; bar.textContent = v.replace(/<[^>]+>/g, ""); },
});
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, platform: "test" },
  location: { pathname: "/app", search: "", hash: "", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: () => Promise.reject(new Error("no network in this test")),
  document: {
    hidden: false,
    getElementById: (id: string) => (id === "ph-recbar" ? bar : stub),
    querySelector: () => stub, querySelectorAll: () => [], createElement: () => stub, addEventListener() {},
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
const load = (f: string) => vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
load("ui.js");
// Z is frozen; a copy whose announce records what a screen reader would hear.
ctx.__announced = [] as string[];
ctx.Z = { ...ctx.Z, announce: (m: string) => ctx.__announced.push(m) };
for (const f of ["app/core.js", "app/recovery.js", "app/monerium.js", "app/phone.js", "app/phone-home.js"]) load(f);
const run = (code: string) => vm.runInContext(code, ctx);

// The guardian routes' answers, and every path asked.
const calls: string[] = [];
let answers: Record<string, any> = {};
ctx.__api = async (p: string) => {
  calls.push(p);
  const a = Object.entries(answers).find(([k]) => p.endsWith(k))?.[1];
  if (a instanceof Error) throw a;
  return a ?? {};
};
const renders: string[] = [];
ctx.__render = () => renders.push(String(run("phRoute?.name")));
ctx.__go = (n: string) => renders.push(`go:${n}`);
run(`api = (p) => __api(p); phRender = () => __render(); phGo = (n) => __go(n);
  caps = { zoldenburgRecovery: true, emailSmsRecovery: false };
  user = { id: "u1", passkeySafe: { status: "active" } };`);

const route = (name: string) => run(`phRoute = { name: ${JSON.stringify(name)}, arg: null }`);
const setRec = (v: any) => { ctx.__rec = v; run("phRec = __rec"); };
const executeAfter = Math.floor(Date.UTC(2026, 9, 13, 9, 0) / 1000);
const chain = { newOwners: ["0xabc"], newThreshold: 1, executeAfter };
const request = { id: "rq1", status: "REVIEW_PENDING", requestedAt: "2026-10-10T08:00:00Z", zoldenburg: { reference: "ZR-7" } };

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("nothing read yet, or nothing under way: no strip", () => {
  route("send");
  setRec(null);
  assert.equal(run("phRecBar()"), "");
  setRec({ none: true });
  assert.equal(run("phRecBar()"), "");
});

await t("a recovery on chain: the strip says when it completes and links to the alert", () => {
  route("activity");
  setRec({ chain, request: null, method: null });
  const html = run("phRecBar()");
  assert.match(html, /Someone is moving your account to a new phone/);
  assert.match(html, /unless you cancel/);
  assert.match(html, /href="#recovery-alert"/);
  assert.match(html, /z-banner--alert/);
});

await t("a Zoldenburg request nobody signed: the strip says nothing is signed yet", () => {
  route("send");
  setRec({ chain: null, request, method: "Zoldenburg ID check" });
  assert.match(run("phRecBar()"), /Nothing has been signed yet/);
});

await t("a failed check is shown, never taken as none", () => {
  route("more");
  setRec({ failed: true });
  const html = run("phRecBar()");
  assert.match(html, /couldn’t check for a recovery/);
  assert.match(html, /Check now/);
});

await t("not on the alert screen itself", () => {
  route("recovery-alert");
  setRec({ chain, request: null, method: null });
  assert.equal(run("phRecBar()"), "");
});

await t("\"It was me\" hides that recovery only; a different one shows again", () => {
  route("home");
  setRec({ chain, request: null, method: null });
  run(`sessionStorage.setItem(PH_REC_SEEN, phRecSig(phRec))`);
  assert.equal(run("phRecBar()"), "");
  setRec({ chain: { ...chain, executeAfter: executeAfter + 60 }, request: null, method: null });
  assert.notEqual(run("phRecBar()"), "");
  // A failed check is never hidden by an earlier "It was me".
  setRec({ failed: true });
  assert.notEqual(run("phRecBar()"), "");
  run("sessionStorage.clear()");
});

await t("the poll's check fills the strip on any screen, without a full render, and announces it once", async () => {
  route("send");
  setRec(null);
  bar.innerHTML = ""; bar.dataset = {};
  renders.length = 0; ctx.__announced.length = 0; calls.length = 0;
  answers = { "/recovery/zoldenburg": { active: true, onChain: { pendingRecovery: chain }, requests: [] } };
  run("phRecReadAt = 0");
  await run("phRecoveryCheck()");
  assert.deepEqual(calls, ["/api/users/u1/recovery/zoldenburg"]);
  assert.match(bar.innerHTML, /Someone is moving your account/);
  assert.deepEqual(renders, [], "the open screen is not redrawn (a sheet or a half-typed form survives)");
  assert.equal(ctx.__announced.length, 1);
  // The same answer a minute later changes nothing and says nothing again.
  run("phRecReadAt = 0");
  await run("phRecoveryCheck()");
  assert.equal(ctx.__announced.length, 1);
});

await t("the check asks at most once a minute unless forced", async () => {
  calls.length = 0;
  await run("phRecoveryCheck()");
  assert.equal(calls.length, 0);
  await run("phRecoveryCheck({ force: true })");
  assert.equal(calls.length, 1);
});

await t("the recovery ends: the strip goes", async () => {
  answers = { "/recovery/zoldenburg": { active: true, onChain: { pendingRecovery: null }, requests: [] } };
  await run("phRecoveryCheck({ force: true })");
  assert.equal(bar.innerHTML, "");
});

await t("a guardian route that fails shows the couldn't-check strip", async () => {
  answers = { "/recovery/zoldenburg": new Error("503") };
  await run("phRecoveryCheck({ force: true })");
  assert.match(bar.innerHTML, /couldn’t check/);
});

await t("from Home, a recovery found still opens the alert", async () => {
  route("home");
  renders.length = 0;
  answers = { "/recovery/zoldenburg": { active: true, onChain: { pendingRecovery: null }, requests: [request] } };
  await run("phRecoveryCheck({ force: true })");
  assert.deepEqual(renders, ["go:recovery-alert"]);
});

await t("every screen's render carries the strip's container, and the account poll asks", () => {
  const src = readFileSync(path.join(PUB, "app/phone.js"), "utf8");
  assert.match(src, /<div id="ph-recbar" class="z-recbar">\$\{phRecBar\(\)\}<\/div>/);
  const poll = readFileSync(path.join(PUB, "app/monerium.js"), "utf8");
  assert.match(poll, /async function refresh\(\)[\s\S]*?phRecoveryCheck\(\)/);
});

await t("/business reads again on a timer and when the tab comes back", () => {
  const src = readFileSync(path.join(PUB, "business/shell.js"), "utf8");
  assert.match(src, /setInterval\(\(\) => \{ if \(!document\.hidden\) readRecoveryNow\(\); \}, RECOVERY_READ_MS\)/);
  assert.match(src, /visibilitychange[\s\S]*?readRecoveryNow\(\)/);
  assert.doesNotMatch(src, /\$\("#plan-banner"\)\.innerHTML = /, "every paint goes through paintBanner");
});

console.log(`recovery-alert-ui: ${pass} ok`);
