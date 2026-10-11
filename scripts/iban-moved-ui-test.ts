/**
 * The app when the account's IBAN was moved away at Monerium.
 *
 * The API takes the IBAN off the account and says where it went
 * (`moneriumIbanElsewhere`, verifyIbanBinding). The app must then say so on
 * Home (phone and desktop) and in the account details, never show the old
 * IBAN as the account's, and offer "Move IBAN back to Zold", which opens the
 * move dialog for that IBAN.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screens in a browser, or the move itself (the passkey
 * ceremony and PATCH are covered by monerium:apikeys:test). Offline.
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
const IBAN = "DE89370400440532013000";
const ELSEWHERE = { iban: IBAN, address: "0x00000000000000000000000000000000000000cc", chain: "base", profileId: "p1", seenAt: "2026-10-11T10:00:00Z" };
const base = {
  id: "u1", name: "Erika Muster", kycStatus: "approved", address: SAFE, balanceEur: 12,
  passkey: { credentialId: "cred" }, passkeySafe: { status: "active", address: SAFE },
  monerium: { method: "oauth", profileId: "p1", profiles: [{ id: "p1", kind: "personal", state: "approved" }] },
};
const movedAway = { ...base, iban: "", funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: "p1", detail: "IBAN ending 3000 now pays into another address at Monerium" }, moneriumIbanElsewhere: ELSEWHERE };
const active = { ...base, iban: IBAN, funding: { mode: "sandbox", status: "active", moneriumProfileId: "p1" } };
const setUser = (u: any) => run(`user = ${JSON.stringify(u)}; caps = { ...caps, sandbox: true }; capsLoaded = true;`);

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

const WARNING = /<strong>Your IBAN was moved to another app\.<\/strong> Payments to it no longer reach this account\./;
const flat = (html: string) => html.replace(/\s+/g, " ");

await t("moved away: phone Home warns and offers the move back; the old IBAN is not shown", () => {
  setUser(movedAway);
  assert.equal(run("ibanMovedAway(user)"), true);
  const html = flat(run("PH.home.html()"));
  assert.match(html, WARNING);
  assert.match(html, /id="ph-iban-back"[^>]*><span>Move IBAN back to Zold<\/span>/);
  assert.ok(!html.includes(IBAN) && !html.includes("3000</span>"), "the moved IBAN is not drawn as this account's");
  assert.match(html, /IBAN moved away/);
  assert.match(html, /id="ph-ck-iban-back"/, "the set-up row offers it too");
});

await t("moved away: the desktop balance card warns and offers the move back", () => {
  setUser(movedAway);
  const html = flat(run("phDeskBalance(user)"));
  assert.match(html, WARNING);
  assert.match(html, /id="ph-iban-back"/);
  assert.match(html, /Move IBAN back to Zold/);
  assert.doesNotMatch(html, /Verify your identity/);
});

await t("moved away: account details and the Profile pay card say it, not 'appears once verified'", () => {
  setUser(movedAway);
  const details = flat(run("phDetailsBody(user, null)"));
  assert.match(details, WARNING);
  assert.match(details, /id="ph-det-iban-back"/);
  assert.doesNotMatch(details, /appears here once Monerium has verified you/);
  run(`phPayVia = "bank"`);
  const pay = flat(run("phPayBody(user)"));
  assert.match(pay, /id="ph-pay-iban-back"/);
});

await t("the button opens the move dialog for the moved IBAN, on the connected profile", async () => {
  setUser(movedAway);
  run(`__moves = []; offerIbanMove = async (choices, profileId) => { __moves.push({ choices, profileId }); return null; };
    api = async () => user; renderUser = (u) => { __rendered = u; };`);
  const btn: any = {};
  const root = { querySelector: (sel: string) => (sel === "#ph-iban-back" ? btn : null) };
  ctx.__root = root;
  run("phBindIbanBack(__root)");
  assert.equal(typeof btn.onclick, "function");
  await btn.onclick();
  const moves = run("__moves");
  assert.equal(moves.length, 1);
  assert.equal(moves[0].profileId, "p1");
  assert.deepEqual(JSON.parse(JSON.stringify(moves[0].choices)), [{ iban: IBAN, address: ELSEWHERE.address, chain: "base", profileId: "p1" }]);
});

await t("Get your IBAN from a moved-away account goes straight to the move, not a new IBAN request", async () => {
  setUser(movedAway);
  run(`__moves = []; __calls = []; api = async (p) => { __calls.push(p); return user; };
    offerIbanMove = async (choices, profileId) => { __moves.push({ choices, profileId }); return null; };`);
  await run("issueAppIban()");
  assert.equal(run("__moves").length, 1);
  assert.ok(!run("__calls").some((p: string) => p.includes("link-signature/start") && !p.includes("move")), "no activation ceremony");
});

await t("an account whose IBAN is active shows no warning and its IBAN", () => {
  setUser(active);
  assert.equal(run("ibanMovedAway(user)"), false);
  const html = flat(run("PH.home.html()"));
  assert.doesNotMatch(html, /moved to another app/);
  assert.doesNotMatch(html, /ph-iban-back/);
  assert.match(html, /•••• 3000/);
});

await t("a pending account waiting for its first IBAN shows no move-back warning", () => {
  setUser({ ...base, kycStatus: "pending", iban: "", funding: { mode: "sandbox", status: "iban_pending" } });
  assert.equal(run("ibanMovedAway(user)"), false);
  assert.doesNotMatch(flat(run("PH.home.html()")), /moved to another app/);
});

console.log(`\nIBAN MOVED UI TEST PASSED — ${pass}/${pass}`);
