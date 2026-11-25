/**
 * Signup as a chat (public/app/onboarding.js, OB_ASK): which question comes
 * next on each path, which answers are refused, what a tapped chip reopens,
 * what switching account type keeps, the body the account is created with,
 * and Home's "Where you live" questions.
 *
 * Runs the real classic scripts in a vm with a stub DOM. What this cannot
 * show: the screens, the animations, or a click on them. Offline.
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
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
};
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0 },
  location: { pathname: "/app", search: "", hash: "", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: () => Promise.reject(new Error("no network in this test")),
  document: {
    getElementById: () => stub, querySelector: () => stub, querySelectorAll: () => [], addEventListener() {}, createElement: () => stub,
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["ui.js", "app/core.js", "app/recovery.js", "app/monerium.js", "narwhal/narwhal.js", "app/onboarding.js"]) {
  vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
}
const run = (code: string) => vm.runInContext(code, ctx);

const EMPTY = { type: null, given: "", family: "", email: "", legalName: "", social: null, country: "", usPerson: null, companyUsNexus: null, residenceFor: null };
const reset = (over: any = {}, u: any = null, screen: string | null = null) => {
  ctx.__d = { ...EMPTY, ...over }; ctx.__u = u; ctx.__s = screen;
  run("Object.assign(obDraft, __d); obChatEdit = null; obEmailInUse = false; user = __u; obScreen = __s");
};
const next = (p: string) => run(`obChatKey("${p}")`);
const draft = () => JSON.parse(run("JSON.stringify(obDraft)"));
// Answer the current question as the chat bar would, or by a tapped choice.
const say = (v: string) => { ctx.__v = v; return run(`(() => { const k = obChatKey(obPath()); const r = OB_ASK[k].take(__v); if (typeof r !== "string") obSaveDraft(r); return r; })()`); };
const tap = (label: string) => { ctx.__l = label; run(`(() => { const k = obChatKey(obPath()); obSaveDraft(OB_ASK[k].choices().find((o) => o.label === __l).patch); })()`); };
const pick = (field: string, code: string) => run(`obSaveDraft({ ${field}: "${code}" })`);

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${name}`); };

test("personal signup asks a name and an email, then nothing", () => {
  reset({ type: "individual" });
  const seen: string[] = [];
  seen.push(next("p")); say("Miriam Zoldenburg");
  seen.push(next("p")); say("miriam@example.com");
  assert.deepEqual(seen, ["fullName", "email"]);
  assert.equal(next("p"), null);
  assert.equal(run('OB["p-about"].done()'), true);
});

test("a refused answer is a message and saves nothing", () => {
  reset({ type: "individual" });
  assert.equal(typeof say(""), "string");
  assert.equal(draft().given, "");
  say("Miriam Zoldenburg");
  assert.equal(typeof say("not-an-email"), "string");
  assert.equal(draft().email, "");
  assert.equal(next("p"), "email");
});

test("business signup adds only the company's name", () => {
  reset({ type: "company" });
  const seen: string[] = [];
  seen.push(next("b")); say("Miriam Zoldenburg");
  seen.push(next("b")); say("m@example.com");
  seen.push(next("b")); assert.equal(typeof say("X"), "string"); say("Lindner Holzbau GmbH");
  assert.deepEqual(seen, ["fullName", "email", "legalName"]);
  assert.equal(next("b"), null);
  assert.equal(run('OB["b-about"].done()'), true);
});

test("every answered chip reopens its own question", () => {
  reset({ type: "company", given: "Miriam Z", email: "m@example.com", legalName: "L GmbH" });
  for (const k of ["fullName", "email", "legalName"]) {
    ctx.__k = k; run("obChatEdit = __k");
    assert.equal(next("b"), k);
  }
  // A key from another order is ignored.
  run('obChatEdit = "country"');
  assert.equal(next("b"), null);
});

test("switching account type keeps the name and email", () => {
  reset({ type: "company", given: "Miriam Zoldenburg", email: "m@example.com", legalName: "L GmbH" });
  run('obPickType("individual")');
  assert.equal(next("p"), null);
  assert.equal(run("obSignupBody().name"), "Miriam Zoldenburg");
});

test("the body the account is created with: no country, no US answers", () => {
  reset({ type: "individual", given: "Miriam Zoldenburg", email: "m@example.com" });
  assert.deepEqual(JSON.parse(run("JSON.stringify(obSignupBody())")), {
    name: "Miriam Zoldenburg", email: "m@example.com", accountType: "individual", consents: [{ kind: "zold_terms" }],
  });
  reset({ type: "company", given: "Miriam Zoldenburg", email: "m@example.com", legalName: "L GmbH" });
  assert.deepEqual(JSON.parse(run("JSON.stringify(obSignupBody())")), {
    name: "Miriam Zoldenburg", email: "m@example.com", accountType: "company", companyName: "L GmbH", consents: [{ kind: "zold_terms" }],
  });
});

test("the Terms are accepted on the sign-in step, where the account is made", () => {
  reset({ type: "individual", given: "Miriam Zoldenburg", email: "m@example.com" });
  assert.match(run("obTermsLine()"), /you accept the .*\/legal.*\/privacy/);
  reset({}, { id: "u1", accountType: "individual" });
  assert.equal(run("obTermsLine()"), "");
});

{
  // Home's "Where you live": asked of an account that exists, sent as one body.
  const undecided = (accountType: string) => ({ id: "u1", accountType, segment: { value: "UNDECIDED", capabilities: ["safe"] } });
  // Answers another account left in this tab are dropped, not shown.
  reset({ country: "FR", usPerson: true, residenceFor: "someone-else" }, undecided("individual"));
  run("enterResidence()");
  assert.deepEqual([draft().country, draft().usPerson, draft().residenceFor], ["", null, "u1"]);
  assert.equal(run("obScreen"), "residence");
  assert.equal(run("obGuard('residence')"), "residence");
  assert.equal(run("obPath()"), "pr");
  const seen: string[] = [];
  seen.push(next("pr")); pick("country", "DE");
  seen.push(next("pr")); tap("No");
  assert.deepEqual(seen, ["country", "usPerson"]);
  assert.equal(next("pr"), null);

  reset({ residenceFor: "u1" }, undecided("company"), "residence");
  seen.length = 0;
  seen.push(next("br")); pick("country", "AT");
  seen.push(next("br")); tap("No");
  seen.push(next("br")); tap("Yes");
  assert.deepEqual(seen, ["country", "companyUsNexus", "usPerson"]);
  run("__realApi = api; __realFinish = obFinish");
  ctx.__posts = [];
  run(`api = async (url, body) => { __posts.push({ url, body }); return { segment: { value: "EU_FULL" } }; }; globalThis.renderUser = (u) => { user = u; }; obFinish = () => {}`);
  await run("obSendResidence(document.createElement('button'))");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.__posts)), [{ url: "/api/users/u1/residence", body: { country: "AT", usAnswers: { usPerson: true, companyUsNexus: false } } }]);
  assert.equal(run("user.segment.value"), "EU_FULL");
  // Decided: the screen is not offered again.
  assert.notEqual(run("obGuard('residence')"), "residence");
  run("api = __realApi; delete globalThis.renderUser; obFinish = __realFinish; user = null; obScreen = null");
  n++; console.log("  ok  where you live: country, then the US questions, sent once as one body");
}

test("a typed country: exact name, code, or the start of exactly one name", () => {
  assert.equal(run('obCountryFrom("Germany")'), "DE");
  assert.equal(run('obCountryFrom("de")'), "DE");
  assert.equal(run('obCountryFrom("germ")'), "DE");
  assert.equal(run('obCountryFrom("a")'), null);
  assert.equal(run('obCountryFrom("")'), null);
  assert.equal(run('obFlag("DE")'), "\u{1F1E9}\u{1F1EA}");
});

console.log(`signup chat: ${n} passed`);
