/**
 * The recovery warning (Phase 0, docs/recovery-guardians-plan.md).
 *
 * /app (public/app/phone-home.js): the strip above every screen, redesigned
 * and older (#ph-recbar in index.html), what it says for each answer the
 * guardian routes can give, that a read that did not work is "couldn't
 * check" and never "none" (same rule as /business), that a failure keeps a
 * recovery an earlier read found, one read at a time, one announcement per
 * warning, the alert opening from Home only the first time and never over a
 * sheet, and the real refresh() and phOpen() driving it.
 *
 * /business (public/business/*.js, ES modules): the real readRecovery and
 * banner, the Access view, and the real minute timer.
 *
 * Runs the real scripts with a stub DOM and recorded API calls. What this
 * cannot show: the strip in a browser, or a real cancel (the passkey-signed
 * `cancelRecovery`, covered by recovery:test). Offline.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const el = () => {
  const e: any = { textContent: "", dataset: {} as Record<string, string>, hidden: true };
  Object.defineProperty(e, "innerHTML", {
    get() { return e._h ?? ""; },
    set(v: string) { e._h = v; e.textContent = v.replace(/<[^>]+>/g, ""); },
  });
  return e;
};

// ---------------------------------------------------------------- /app ----

const bar = el();
let sheetOpen = false;
const listeners: Record<string, (() => void)[]> = {};
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
  scrollTo() {},
  document: {
    hidden: false,
    getElementById: (id: string) => (id === "ph-recbar" ? bar : stub),
    // Only the sheet check reads a real answer here.
    querySelector: (sel: string) => (sel.includes(".z-scrim") ? (sheetOpen ? {} : null) : stub),
    querySelectorAll: () => [], createElement: () => stub,
    addEventListener: (t: string, f: () => void) => { (listeners[t] ||= []).push(f); },
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
const load = (f: string) => vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
load("ui.js");
// Z is frozen; a copy whose announce records what a screen reader would hear.
const announced: string[] = [];
ctx.Z = { ...ctx.Z, announce: (m: string) => announced.push(m) };
for (const f of ["app/core.js", "app/recovery.js", "app/monerium.js", "app/phone.js", "app/phone-home.js"]) load(f);
const run = (code: string) => vm.runInContext(code, ctx);

// Every API call, and the answer for each path suffix (an Error rejects;
// a function is called, and may return a promise).
const calls: string[] = [];
let answers: Record<string, any> = {};
ctx.__api = async (p: string) => {
  calls.push(p);
  const a = Object.entries(answers).find(([k]) => p.endsWith(k))?.[1];
  const v = typeof a === "function" ? await a() : a;
  if (v instanceof Error) throw v;
  return v ?? {};
};
const nav: string[] = [];
ctx.__render = () => nav.push(`render:${run("phRoute?.name")}`);
ctx.__go = (n: string) => nav.push(`go:${n}`);
run(`api = (p) => __api(p); phRender = () => __render(); phGo = (n) => __go(n); mobileNavLegacy = () => {};
  caps = { ...caps, zoldenburgRecovery: true, emailSmsRecovery: false }; capsLoaded = true;
  user = { id: "u1", passkeySafe: { status: "active" } };`);

const route = (name: string) => run(`phRoute = { name: ${JSON.stringify(name)}, arg: null }`);
const setCaps = (z: boolean, c: boolean, tk = false) => run(`caps = { ...caps, zoldenburgRecovery: ${z}, emailSmsRecovery: ${c}, turnkeyGuardians: ${tk} }`);
const reset = () => {
  run(`phRec = null; phRecReadAt = 0; phRecAnnounced = ""; phRecOpened = ""; sessionStorage.clear()`);
  bar.innerHTML = ""; bar.dataset = {}; bar.hidden = true;
  calls.length = 0; nav.length = 0; announced.length = 0; answers = {}; sheetOpen = false;
  setCaps(true, false);
};
const check = (force = true) => run(`phRecoveryCheck({ force: ${force} })`);
const executeAfter = Math.floor(Date.UTC(2026, 9, 13, 9, 0) / 1000);
const chain = { newOwners: ["0xabc"], newThreshold: 1, executeAfter };
const request = (status = "REVIEW_PENDING", id = "rq1") => ({ id, status, requestedAt: "2026-10-10T08:00:00Z", zoldenburg: { reference: "ZR-7" } });
const zOk = (over: any = {}) => ({ active: true, requests: [], onChain: { pendingRecovery: null, guardians: [] }, ...over });
const cOk = (over: any = {}) => ({ guardianStatus: "active", channels: [{ channel: "email" }], onChain: { pendingRecovery: null, guardians: [] }, ...over });
const state = () => run("phRec");

let pass = 0;
const t = async (name: string, fn: () => unknown) => { reset(); await fn(); pass++; console.log(`  ok  ${name}`); };

await t("nothing under way: no strip, and the strip stays hidden", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk() };
  await check();
  assert.equal(state().none, true);
  assert.equal(bar.innerHTML, "");
  assert.equal(bar.hidden, true);
});

await t("a recovery on chain: the strip says when it completes, links to the alert, and is announced", async () => {
  route("activity");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.match(bar.innerHTML, /Someone is moving your account to a new phone/);
  assert.match(bar.innerHTML, /It completes on .+ unless you cancel/);
  assert.match(bar.innerHTML, /href="#recovery-alert"/);
  assert.equal(bar.hidden, false);
  assert.equal(announced.length, 1);
});

await t("every open request status shows the strip; a finished one does not", async () => {
  route("send");
  for (const status of ["PASSKEY_PENDING", "OTP_PENDING", "KYC_PENDING", "REVIEW_PENDING"]) {
    answers = { "/recovery/zoldenburg": zOk({ requests: [request(status, status)] }) };
    await check();
    assert.match(bar.innerHTML, /Nothing has been signed yet/, status);
  }
  for (const status of ["CANCELED", "FINALIZED", "EXPIRED"]) {
    answers = { "/recovery/zoldenburg": zOk({ requests: [request(status, status)] }) };
    await check();
    assert.equal(state().none, true, status);
    assert.equal(bar.innerHTML, "", status);
  }
});

await t("a deployment with only email/SMS recovery reads the Candide route alone", async () => {
  route("send");
  setCaps(false, true);
  answers = { "/recovery/candide": cOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.deepEqual(calls, ["/api/users/u1/recovery/candide"]);
  assert.ok(state().chain);
  assert.match(state().method, /Email code/);
  assert.match(bar.innerHTML, /Someone is moving your account/);
});

const tkRequest = (status = "REVIEW_PENDING", id = "tk1") => ({ id, mode: "turnkey", status, requestedAt: "2026-10-10T08:00:00Z", turnkey: {} });
const tOk = (over: any = {}) => ({ requests: [], onChain: { pendingRecovery: null, guardians: [] }, ...over });

await t("a deployment with only Google/Apple guardians reads the Turnkey route alone, and shows an open request", async () => {
  route("send");
  setCaps(false, false, true);
  answers = { "/recovery/turnkey/requests": tOk({ requests: [tkRequest()] }) };
  await check();
  assert.deepEqual(calls, ["/api/users/u1/recovery/turnkey/requests"]);
  assert.equal(state().request?.id, "tk1");
  assert.match(state().method, /Google or Apple guardian/);
  assert.match(bar.innerHTML, /Nothing has been signed yet/);
});

await t("a recovery on chain found through the Turnkey route shows the strip", async () => {
  route("send");
  setCaps(true, false, true);
  answers = { "/recovery/zoldenburg": zOk(), "/recovery/turnkey/requests": tOk({ requests: [tkRequest("GRACE_PERIOD")], onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.ok(state().chain);
  assert.match(state().method, /Google or Apple guardian/);
  assert.match(bar.innerHTML, /Someone is moving your account/);
});

await t("couldn't check, never none: every way a read can fail", async () => {
  route("send");
  const cases = [
    ["Zoldenburg route down", true, false, { "/recovery/zoldenburg": new Error("503") }],
    ["Zoldenburg chain read failed (guardian or not)", true, false, { "/recovery/zoldenburg": { active: false, requests: [], onChainError: "rpc down" } }],
    ["Zoldenburg answer without its chain reading", true, false, { "/recovery/zoldenburg": { active: true, requests: [] } }],
    ["Candide route down", false, true, { "/recovery/candide": new Error("503") }],
    ["Candide chain read failed", false, true, { "/recovery/candide": cOk({ onChain: { error: "rpc down" } }) }],
    ["Candide active without its chain reading", false, true, { "/recovery/candide": cOk({ onChain: undefined }) }],
    ["one route fine, the other down", true, true, { "/recovery/zoldenburg": zOk(), "/recovery/candide": new Error("503") }],
    ["Turnkey route down", false, false, { "/recovery/turnkey/requests": new Error("503") }, true],
    ["Turnkey chain read failed", false, false, { "/recovery/turnkey/requests": { requests: [], onChainError: "rpc down" } }, true],
    ["Turnkey answer without its chain reading", false, false, { "/recovery/turnkey/requests": { requests: [] } }, true],
  ] as [string, boolean, boolean, Record<string, any>, boolean?][];
  for (const [name, z, c, a, tk] of cases) {
    run(`phRec = null`); bar.dataset = {};
    setCaps(z, c, Boolean(tk));
    answers = a;
    await check();
    assert.equal(state().failed, true, name);
    assert.match(bar.innerHTML, /couldn’t check for a recovery/, name);
  }
});

await t("a recovery found while the other guardian's read fails is still the recovery", async () => {
  route("send");
  setCaps(true, true);
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }), "/recovery/candide": new Error("503") };
  await check();
  assert.ok(state().chain);
  assert.match(bar.innerHTML, /Someone is moving your account/);
});

await t("a failed read keeps the recovery an earlier read found", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  answers = { "/recovery/zoldenburg": new Error("503") };
  await check();
  assert.ok(state().chain, "the known recovery stays");
  assert.equal(state().failed, true);
  assert.match(bar.innerHTML, /Someone is moving your account/, "not downgraded to couldn't check");
});

await t("capabilities never loaded: it asks /api/health again, and says it couldn't check if that fails", async () => {
  route("send");
  let healthAsked = 0;
  run(`capsLoaded = false; caps = { ...caps, zoldenburgRecovery: undefined, emailSmsRecovery: false }`);
  run(`obCapsChanged = () => {}; renderFundCard = () => {}`);
  ctx.fetch = () => { healthAsked++; return Promise.reject(new Error("down")); };
  await check();
  assert.equal(healthAsked, 1);
  assert.equal(state().failed, true);
  assert.match(bar.innerHTML, /couldn’t check/);
  // Health answers next time: the read goes ahead.
  ctx.fetch = async () => ({ json: async () => ({ capabilities: { zoldenburgRecovery: true, emailSmsRecovery: false }, realMoney: false }) });
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.equal(run("capsLoaded"), true);
  assert.ok(state().chain);
  ctx.fetch = () => Promise.reject(new Error("no network in this test"));
});

await t("no Safe, or no guardian here: nothing to find, and an earlier strip goes", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.notEqual(bar.innerHTML, "");
  setCaps(false, false);
  calls.length = 0;
  await check();
  assert.deepEqual(calls, []);
  assert.equal(state().none, true);
  assert.equal(bar.innerHTML, "");
});

await t("a bug inside the read shows couldn't check and asks again at the next poll", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  run(`__realUser = user; user = { get id() { throw new Error("boom"); } }`);
  await check();
  run(`user = __realUser`);
  assert.equal(state().failed, true);
  assert.equal(run("phRecReadAt"), 0, "not held back for a minute");
});

await t("one read at a time: a forced check while one is in flight shares it", async () => {
  route("send");
  let release!: () => void;
  answers = { "/recovery/zoldenburg": () => new Promise((r) => { release = () => r(zOk({ onChain: { pendingRecovery: chain, guardians: [] } })); }) };
  const first = check();
  await new Promise((r) => setImmediate(r));
  answers = { "/recovery/zoldenburg": zOk() };
  const second = check();
  assert.equal(first, second, "the same promise");
  release();
  await second;
  assert.equal(calls.length, 1, "one read");
  assert.ok(state().chain, "no older answer lands after a newer one");
});

await t("the check asks at most once a minute unless forced", async () => {
  answers = { "/recovery/zoldenburg": zOk() };
  await check();
  calls.length = 0;
  await check(false);
  assert.equal(calls.length, 0);
  await check(true);
  assert.equal(calls.length, 1);
});

await t("each warning is announced once, however often the person changes screen", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  assert.equal(announced.length, 1);
  // The real phOpen: a redesigned screen, the alert (strip hides), an older screen.
  run(`phOpen({ name: "activity", arg: null })`);
  run(`phOpen({ name: "recovery-alert", arg: null })`);
  assert.equal(bar.innerHTML, "", "not on the alert screen itself");
  run(`phOpen({ name: "signers", arg: null })`);
  assert.match(bar.innerHTML, /Someone is moving your account/, "on an older screen too");
  await check();
  assert.equal(announced.length, 1);
  // A different recovery is a new warning.
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: { ...chain, executeAfter: executeAfter + 60 }, guardians: [] } }) };
  await check();
  assert.equal(announced.length, 2);
});

await t("\"It was me\" hides that recovery only; a failed check is never hidden", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: chain, guardians: [] } }) };
  await check();
  run(`sessionStorage.setItem(PH_REC_SEEN, phRecSig(phRec))`);
  await check();
  assert.equal(bar.innerHTML, "");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: { ...chain, executeAfter: executeAfter + 60 }, guardians: [] } }) };
  await check();
  assert.notEqual(bar.innerHTML, "");
  run(`phRec = null`);
  answers = { "/recovery/zoldenburg": new Error("503") };
  await check();
  assert.match(bar.innerHTML, /couldn’t check/);
});

await t("from Home the alert opens the first time a recovery is found, not every minute, and never over a sheet", async () => {
  route("home");
  answers = { "/recovery/zoldenburg": zOk({ requests: [request()] }) };
  sheetOpen = true;
  await check();
  assert.deepEqual(nav, [], "a sheet is open over Home");
  sheetOpen = false;
  await check();
  assert.deepEqual(nav, ["go:recovery-alert"]);
  route("home");
  await check();
  assert.deepEqual(nav, ["go:recovery-alert"], "Back to Home is not undone a minute later");
});

await t("a chain time that is not a number: the warning shows without a date, and nothing throws", async () => {
  route("send");
  answers = { "/recovery/zoldenburg": zOk({ onChain: { pendingRecovery: { ...chain, executeAfter: "soon" }, guardians: [] } }) };
  await check();
  assert.match(bar.innerHTML, /completes after the waiting period unless you cancel/);
  route("recovery-alert");
  const html = run(`PH["recovery-alert"].html()`);
  assert.match(html, /completes after the waiting period/);
});

await t("the real account poll asks for the recovery state", async () => {
  run(`renderUser = () => {}; loadTransfers = async () => {}; loadRecoveryInfo = async () => {}; renderRecoveryInfo = () => {};
    phLoadDeposits = async () => {}; phRefresh = () => {};`);
  answers = { "/api/users/u1": { id: "u1", passkeySafe: { status: "active" } }, "/recovery/zoldenburg": zOk() };
  await run("refresh()");
  await run("phRecRun");
  assert.ok(calls.includes("/api/users/u1/recovery/zoldenburg"));
});

await t("the strip's container is on the page, outside the redesigned and the older screens", () => {
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  const at = html.indexOf('id="ph-recbar"');
  assert.ok(at > 0);
  assert.ok(at < html.indexOf('<section id="phone"') && at < html.indexOf('<section id="dashboard"'));
});

// ------------------------------------------------------------ /business ----

const g: any = globalThis;
const banner = el();
const intervals: { fn: () => void; ms: number }[] = [];
const bizListeners: Record<string, (() => void)[]> = {};
const bizAnnounced: string[] = [];
const ls = store();
Object.assign(g, {
  window: g, localStorage: ls, sessionStorage: store(),
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  history: { pushState() {}, replaceState() {}, state: null },
  location: { pathname: "/business", search: "", hash: "", href: "http://test/business" },
  Z: new Proxy({ announce: (m: string) => bizAnnounced.push(m) }, { get: (t: any, k) => (k in t ? t[k] : k === "icon" ? () => "" : stub) }),
  document: {
    hidden: false, title: "",
    querySelector: (s: string) => (s === "#plan-banner" ? banner : null),
    querySelectorAll: () => [], createElement: () => stub, body: stub, documentElement: stub,
    addEventListener: (t: string, f: () => void) => { (bizListeners[t] ||= []).push(f); },
  },
});
banner.querySelector = () => ({ textContent: banner.textContent });
ls.setItem("zold-session", "tok");
let bizAnswers: Record<string, any> = {};
const bizCalls: string[] = [];
g.fetch = async (url: string) => {
  bizCalls.push(url);
  const a = Object.entries(bizAnswers).find(([k]) => url.endsWith(k))?.[1];
  const v = typeof a === "function" ? a() : a;
  if (v instanceof Error) return { ok: false, status: 503, headers: new Map(), json: async () => ({ error: "down" }), text: async () => "down" };
  return { ok: true, status: 200, headers: new Map(), json: async () => v ?? {}, text: async () => JSON.stringify(v ?? {}) };
};
const realSetInterval = g.setInterval;
g.setInterval = (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return 0; };

const biz = (f: string) => pathToFileURL(path.join(PUB, "business", f)).href;
const core = await import(biz("core.js"));
const shell = await import(biz("shell.js"));
const navm = await import(biz("nav.js"));
const bizSettle = () => new Promise((r) => setTimeout(r, 20));

const me = { id: "u1", accountType: "person", passkeySafe: { status: "active" } };
const health = { capabilities: { zoldenburgRecovery: true, emailSmsRecovery: false } };
bizAnswers = { "/api/session": me, "/api/health": health, "/recovery/zoldenburg": zOk() };
await core.ensureMe();
core.setOrg({ id: "o1", type: "business", role: "owner", name: "Acme" });

await t("/business: a recovery on chain shows on every view, the Access view included", async () => {
  bizAnswers["/recovery/zoldenburg"] = zOk({ onChain: { pendingRecovery: chain, guardians: [] } });
  await core.readRecovery();
  assert.equal(core.recoveryPending, true);
  core.setView("access");
  assert.match(navm.planBanner(), /A recovery is under way on your sign-in/);
  core.setView("invoices");
  assert.match(navm.planBanner(), /A recovery is under way/);
});

await t("/business: an answer of an unexpected shape is couldn't check, never none", async () => {
  bizAnswers["/recovery/zoldenburg"] = { active: true, requests: [], onChain: { pendingRecovery: null, guardians: 5 } };
  await core.readRecovery();
  assert.equal(core.recoveryPending, false);
  assert.equal(core.recoveryUnknown, true);
  assert.match(navm.planBanner(), /couldn’t check for a recovery/);
});

await t("/business: the real minute timer reads again, paints only on change, and announces a new warning once", async () => {
  bizAnswers["/recovery/zoldenburg"] = zOk();
  shell.watchRecovery();
  shell.watchRecovery(); // a second start is ignored
  await bizSettle();
  const timers = intervals.filter((i) => i.ms === 60000);
  assert.equal(timers.length, 1, "one timer");
  assert.equal(banner.innerHTML.includes("recovery"), false);
  bizAnswers["/recovery/zoldenburg"] = zOk({ onChain: { pendingRecovery: chain, guardians: [] } });
  const before = bizCalls.length;
  timers[0].fn();
  await bizSettle();
  assert.ok(bizCalls.slice(before).some((u) => u.endsWith("/recovery/zoldenburg")));
  assert.match(banner.innerHTML, /A recovery is under way/);
  assert.equal(bizAnnounced.length, 1);
  timers[0].fn();
  await bizSettle();
  assert.equal(bizAnnounced.length, 1, "the same warning is not read out again");
  // Hidden tab: the timer does not read.
  g.document.hidden = true;
  const quiet = bizCalls.length;
  timers[0].fn();
  await bizSettle();
  assert.equal(bizCalls.length, quiet);
  g.document.hidden = false;
});

g.setInterval = realSetInterval;
console.log(`recovery-alert-ui: ${pass} ok`);
