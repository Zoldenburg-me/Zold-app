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
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
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
  "narwhal/narwhal.js", "app/onboarding.js", "app/send.js", "app/signers.js", "app/phone.js", "app/phone-home.js", "app/phone-activity.js",
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
  const btn: any = { querySelector: (sel: string) => (sel === "span:not(.z-ic)" ? label : { textContent: "content_copy", dataset: {} }) };
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

// Copy a connected account reads on Home and the dashboard: only a pending
// account, which activates its own IBAN, is told to get one.
await t("a connected account under review is not told to get an IBAN", () => {
  const copy = (kycStatus: string) => run(`kycCopy(${JSON.stringify(kycStatus)}, { kycStatus: ${JSON.stringify(kycStatus)}, monerium: { connectedAt: "2026-11-19T00:00:00Z" } })`);
  assert.equal(copy("pending")[1], "Get your IBAN");
  assert.equal(copy("manual_review")[0], "MANUAL REVIEW");
  assert.doesNotMatch(copy("manual_review").join(" "), /IBAN/);
  assert.equal(copy("rejected")[0], "WALLET");
});

// Back from Monerium's sign-in (/app?monerium=connected) the API refuses an
// IBAN to an account under review (ibanActivationRefusal), so the app must not
// open "Switch on your IBAN" or offer Activate on Home. A pending one still does.
const connectedAs = (kycStatus: string) => ({
  id: "u2", name: "Kim", kycStatus, iban: "", address: "0x1111111111111111111111111111111111111111",
  passkey: { credentialId: "cred" }, passkeySafe: { status: "active", address: "0x1111111111111111111111111111111111111111" },
  monerium: { method: "oauth", connectedAt: "2026-11-19T00:00:00Z", profileId: "p1", profiles: [{ id: "p1", kind: "personal", state: "approved" }] },
  funding: { mode: "sandbox", status: kycStatus === "pending" ? "provisioning" : "kyc_pending", moneriumProfileId: "p1",
    detail: kycStatus === "pending" ? "smart wallet deployed — approve IBAN issuance with your passkey" : "Monerium is still reviewing this account, so there is no IBAN yet" },
});
const returnFromMonerium = async (u: any) => {
  ctx.location.search = "?monerium=connected";
  ctx.location.hash = "";
  run(`sessionToken = "tok"; __went = []; obSocialReturn = async () => {}; obShow = () => {};
    obGo = (n) => { __went.push(obGuard(n)); }; enterDashboard = () => { __went.push("home"); };
    renderUser = (u) => { user = u; }; api = async () => (${JSON.stringify(u)});`);
  await run("resumeSession(Promise.resolve())");
  ctx.location.search = "";
  return run("JSON.stringify(__went)");
};

await t("connected and under review: back from Monerium lands on Home, not on Switch on your IBAN", async () => {
  assert.equal(await returnFromMonerium(connectedAs("manual_review")), JSON.stringify(["home"]));
  assert.equal(await returnFromMonerium(connectedAs("pending")), JSON.stringify(["activate"]), "a pending account still activates");
});

await t("connected and under review: Home's IBAN row has no Activate, and its buttons never open the activate step", () => {
  run(`user = ${JSON.stringify(connectedAs("manual_review"))}; caps = { ...caps, sandbox: true }; capsLoaded = true;`);
  const home = run("PH.home.html()").replace(/\s+/g, " ");
  assert.doesNotMatch(home, /id="ph-ck-verify2"/);
  assert.doesNotMatch(home, />Activate</);
  assert.match(home, /Monerium is still reviewing this account\. No IBAN yet\./);
  run(`__went = []; obShow = () => {}; obGo = (n) => { __went.push(obGuard(n)); };`);
  run(`enterKycReview("Kim"); obGo("activate");`);
  assert.equal(run("JSON.stringify(__went)"), JSON.stringify(["monerium", "monerium"]));
  run(`user = ${JSON.stringify(connectedAs("pending"))};`);
  assert.match(run("PH.home.html()"), /id="ph-ck-verify2"/, "a pending account keeps Activate");
});

// Every other button that once led to the IBAN sign-in ("Verify your
// identity", Coming soon's Check) says the account is under review instead,
// and the Monerium screen itself no longer pitches "Get your IBAN".
// Not connected yet changes nothing: the API refuses the IBAN either way.
const unconnected = (kycStatus: string) => ({ ...connectedAs(kycStatus), monerium: undefined, funding: undefined });
await t("under review, connected or not: no entry point offers the IBAN sign-in", () => {
  const flat = (code: string) => String(run(code)).replace(/\s+/g, " ");
  for (const [who, u] of [["connected", connectedAs("manual_review")], ["not connected", unconnected("manual_review")]] as const) {
  run(`user = ${JSON.stringify(u)}; caps = { ...caps, sandbox: true, moneriumOAuth: true }; capsLoaded = true;
    phPayVia = "bank"; phCache.soon = [];`);
  const screens: Record<string, string> = {
    "desktop Home": flat("phDeskBalance(user)"),
    "account details": flat("phDetailsBody(user, null)"),
    "Get paid": flat("phPayBody(user)"),
    "Coming soon": flat("PH.soon.html()"),
    "Send": flat("JSON.stringify(phSendBlocked(user))"),
    "Monerium screen": flat("OB.monerium.title + ' ' + OB.monerium.html()"),
  };
  for (const [where, html] of Object.entries(screens)) {
    assert.doesNotMatch(html, /Verify your identity|Get your IBAN|ph-det-verify|ph-soon-iban|ph-send-verify|btn-monerium-existing|Continue with Monerium/, `${who}: ${where}`);
    assert.match(html, /Monerium is still reviewing this account/, `${who}: ${where}`);
  }
  // Home's checklist keeps the step's title, but no Start and no Activate.
  const home = flat("PH.home.html()");
  assert.doesNotMatch(home, /id="ph-ck-verify2?"/, `${who}: Home checklist`);
  assert.match(home, /Monerium is still reviewing this account/, `${who}: Home checklist`);
  }
  run(`user = ${JSON.stringify(unconnected("pending"))};`);
  assert.match(flat("PH.home.html()"), /id="ph-ck-verify"/, "a pending account not yet connected keeps Start");
  assert.match(flat("OB.monerium.title + ' ' + OB.monerium.html()"), /Get your IBAN.*Continue with Monerium/, "a pending account not yet connected keeps the sign-in");
  run(`user = ${JSON.stringify(connectedAs("pending"))};`);
  assert.match(flat("phDeskBalance(user)"), /Verify your identity/, "a pending account keeps its button");
  assert.match(flat("PH.soon.html()"), /id="ph-soon-iban"/, "a pending account keeps Check");
  assert.match(flat("OB.monerium.title + ' ' + OB.monerium.html()"), /Get your IBAN.*Continue with Monerium/, "a pending account keeps the sign-in");
});

// Not connected and under review, Home's checklist says it once (the IBAN
// row), and Settings → Monerium keeps the sign-in without promising an IBAN.
await t("not connected and under review: Home says it once, and Settings → Monerium promises no IBAN", () => {
  const flat = (code: string) => String(run(code)).replace(/\s+/g, " ");
  run(`user = ${JSON.stringify(unconnected("manual_review"))}; caps = { ...caps, sandbox: true, moneriumOAuth: true, moneriumApiKeys: true }; capsLoaded = true;`);
  const home = flat("PH.home.html()");
  assert.equal(home.split("Monerium is still reviewing this account").length - 1, 1, home);
  const els: Record<string, any> = {};
  const realGet = ctx.document.getElementById;
  ctx.document.getElementById = (id: string) => (els[id] ??= new Proxy({} as any, {
    get: (o, k) => (k in o ? o[k] : stub), set: (o, k, v) => { o[k] = v; return true; },
  }));
  try { run("renderMoneriumScreen()"); } finally { ctx.document.getElementById = realGet; }
  const lede = String(els["m-mon-lede"].textContent);
  assert.doesNotMatch(lede, /issues your IBAN/, lede);
  assert.match(lede, /Monerium is still reviewing this account/, lede);
  assert.match(String(els["m-mon-body"].innerHTML), /Continue with Monerium/, "the sign-in stays");
  run(`user = ${JSON.stringify(unconnected("pending"))};`);
  try { ctx.document.getElementById = (id: string) => els[id]; run("renderMoneriumScreen()"); } finally { ctx.document.getElementById = realGet; }
  assert.match(String(els["m-mon-lede"].textContent), /Monerium issues your IBAN/, "a pending account keeps the pitch");
});

// A conversion that reverted moved nothing: the screens say so, not "sent and
// not confirmed yet". One whose op may still land keeps that line.
await t("a reverted conversion is not described as sent and unconfirmed", () => {
  const row = (over: any) => ({ id: "dr", token: "USDC", holding: "unconfirmed", amountUsdc: 5, amountUnits: "5000000", detectedAt: "2026-11-19T00:00:00Z", txs: [], ...over });
  for (const [reverted, re] of [[true, /didn’t go through, so nothing was converted/], [false, /isn’t confirmed yet/]] as const) {
    run(`phCache.deposits = [${JSON.stringify(row(reverted ? { conversionReverted: true } : {}))}];`);
    const screen = String(run(`PH.convert.html("dr")`));
    assert.match(screen, re, `convert screen, reverted=${reverted}`);
    const story = String(run(`phInStory(${JSON.stringify(row(reverted ? { conversionReverted: true } : {}))})`));
    assert.match(story, reverted ? /did not go through, so nothing was converted/ : /not confirmed yet/, `activity, reverted=${reverted}`);
    if (reverted) assert.doesNotMatch(screen + story, /isn’t confirmed yet|not confirmed yet/);
  }
});

console.log(`\nAPP COPY UI TEST PASSED — ${pass}/${pass}`);
