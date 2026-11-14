/**
 * Signup as a chat (public/app/onboarding.js, OB_ASK): which question comes
 * next on each path, which answers are refused, what a tapped chip reopens,
 * what switching account type keeps, and the body the account is created with.
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

const EMPTY = { type: null, given: "", family: "", email: "", country: "", usPerson: null, companyUsNexus: null,
  legalName: "", tradingName: "", noTrading: false, incorp: "", terms: false, authorised: false, social: null };
const reset = (over: any = {}) => { ctx.__d = { ...EMPTY, ...over }; run("Object.assign(obDraft, __d); obChatEdit = null; obEmailInUse = false"); };
const next = (p: "p" | "b") => run(`obChatKey("${p}")`);
const draft = () => JSON.parse(run("JSON.stringify(obDraft)"));
// Answer the current question as the chat bar would, or by a tapped choice.
const say = (v: string) => { ctx.__v = v; return run(`(() => { const k = obChatKey(obPath()); const r = OB_ASK[k].take(__v); if (typeof r !== "string") obSaveDraft(r); return r; })()`); };
const tap = (label: string) => { ctx.__l = label; run(`(() => { const k = obChatKey(obPath()); obSaveDraft(OB_ASK[k].choices().find((o) => o.label === __l).patch); })()`); };
const pick = (field: string, code: string) => run(`obSaveDraft({ ${field}: "${code}" })`);

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${name}`); };

test("personal path: one question at a time, in order, then nothing", () => {
  reset({ type: "individual" });
  const seen: string[] = [];
  seen.push(next("p")); say("Miriam");
  seen.push(next("p")); say("Zoldenburg");
  seen.push(next("p")); say("miriam@example.com");
  seen.push(next("p")); pick("country", "DE");
  seen.push(next("p")); tap("No");
  seen.push(next("p")); tap("I accept the Terms");
  assert.deepEqual(seen, ["given", "family", "email", "country", "usPerson", "terms"]);
  assert.equal(next("p"), null);
  assert.equal(run('OB["p-about"].done()'), true);
});

test("a refused answer is a message and saves nothing", () => {
  reset({ type: "individual" });
  assert.equal(typeof say(""), "string");
  assert.equal(draft().given, "");
  say("Miriam"); say("Zoldenburg");
  assert.equal(typeof say("not-an-email"), "string");
  assert.equal(draft().email, "");
  assert.equal(next("p"), "email");
});

test("business path order; 'No other name' answers the trading name and leaves a chip", () => {
  reset({ type: "company" });
  const seen: string[] = [];
  seen.push(next("b")); assert.equal(typeof say("X"), "string"); say("Lindner Holzbau GmbH");
  seen.push(next("b")); assert.equal(typeof say(""), "string"); tap("No other name");
  seen.push(next("b")); pick("incorp", "DE");
  seen.push(next("b")); say("Miriam Zoldenburg");
  seen.push(next("b")); pick("country", "AT");
  seen.push(next("b")); say("m@example.com");
  seen.push(next("b")); tap("No");
  seen.push(next("b")); tap("No");
  seen.push(next("b")); tap("Yes, I’m authorised");
  seen.push(next("b")); tap("I accept the Terms");
  assert.deepEqual(seen, ["legalName", "tradingName", "incorp", "fullName", "country", "email", "companyUsNexus", "usPerson", "authorised", "terms"]);
  assert.equal(next("b"), null);
  assert.equal(run('OB["b-about"].done()'), true);
  assert.equal(run("OB_ASK.tradingName.chip()"), "No other name");
  // Its chip reopens it, and a typed name replaces the choice.
  run('obChatEdit = "tradingName"');
  assert.equal(next("b"), "tradingName");
  say("Lindner Holz");
  assert.deepEqual([draft().tradingName, draft().noTrading], ["Lindner Holz", false]);
});

test("every answered chip reopens its own question", () => {
  reset({ type: "individual", given: "Miriam", family: "Z", email: "m@example.com", country: "DE", usPerson: false, terms: true });
  for (const k of ["given", "family", "email", "country", "usPerson", "terms"]) {
    ctx.__k = k; run("obChatEdit = __k");
    assert.equal(next("p"), k);
  }
  // A key from the other path is ignored.
  run('obChatEdit = "legalName"');
  assert.equal(next("p"), null);
});

test("business to personal asks first and last name again; consents are asked again", () => {
  reset({ type: "company", legalName: "L GmbH", noTrading: true, incorp: "DE", given: "Miriam Zoldenburg", family: "",
    country: "DE", email: "m@example.com", companyUsNexus: false, usPerson: false, authorised: true, terms: true });
  run('obPickType("individual")');
  const d = draft();
  assert.deepEqual([d.type, d.given, d.family, d.terms, d.authorised], ["individual", "", "", false, false]);
  assert.equal(next("p"), "given");
  say("Miriam"); say("Zoldenburg");
  assert.equal(run("obSignupBody().name"), "Miriam Zoldenburg");
});

test("personal to business keeps the name as the full name", () => {
  reset({ type: "individual", given: "Miriam", family: "Zoldenburg", terms: true });
  run('obPickType("company")');
  assert.equal(run("OB_ASK.fullName.done()"), true);
  assert.equal(run("obFullName()"), "Miriam Zoldenburg");
  assert.equal(draft().terms, false);
  // Picking the same type again changes nothing.
  run('obSaveDraft({ terms: true }); obPickType("company")');
  assert.equal(draft().terms, true);
});

test("the body the account is created with", () => {
  reset({ type: "individual", given: "Miriam", family: "Zoldenburg", email: "m@example.com", country: "DE", usPerson: false, terms: true });
  assert.deepEqual(JSON.parse(run("JSON.stringify(obSignupBody())")), {
    name: "Miriam Zoldenburg", email: "m@example.com", country: "DE", accountType: "individual",
    usAnswers: { usPerson: false }, consents: [{ kind: "zold_terms" }],
  });
});

test("a typed country: exact name, code, or the start of exactly one name", () => {
  assert.equal(run('obCountryFrom("Germany")'), "DE");
  assert.equal(run('obCountryFrom("de")'), "DE");
  assert.equal(run('obCountryFrom("germ")'), "DE");
  assert.equal(run('obCountryFrom("a")'), null);
  assert.equal(run('obCountryFrom("")'), null);
  assert.equal(run('obFlag("DE")'), "\u{1F1E9}\u{1F1EA}");
});

console.log(`signup chat: ${n} passed`);
