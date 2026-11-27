/**
 * /business: signing out, a cached page, and a payment whose submit is refused.
 *
 * - Sign out ends the session on the server (DELETE /api/session with the
 *   token), clears the session, the contact cache and unsent invoice drafts
 *   from this browser even when that call fails, and loads /business.
 * - A page restored from the back-forward cache reloads unless the stored
 *   session is the one it loaded with.
 * - New payment: the draft is created, the submit is refused: the screen goes
 *   to Drafts and says so, and the draft was posted once. Two payees, each
 *   with its own amount and note, are posted as the two lines of one draft.
 * - New payment: Add a contact from a form with payees entered keeps them,
 *   their amounts and notes, and the account picked; the form's own handlers
 *   add a ticked contact, keep what is typed, and remove a payee.
 *
 * Runs the real modules on this global with a stub DOM and a stubbed fetch.
 * What this cannot show: a real browser's back-forward cache, or keepalive
 * surviving the page load. Offline.
 *
 *   npm run business:signout-send:test
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
const m = new Map<string, string>();
// Own keys are the stored ones, as on a real Storage: signOut lists them with Object.keys.
const ls: any = new Proxy({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, String(v)),
  removeItem: (k: string) => void m.delete(k),
}, {
  ownKeys: () => [...m.keys()],
  getOwnPropertyDescriptor: (_t, k) => (m.has(String(k)) ? { enumerable: true, configurable: true, value: m.get(String(k)) } : undefined),
});
const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, statusText: "", type: "basic",
  headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify(body),
});

const g: any = globalThis;
const toastEl = { className: "", textContent: "", classList: { add() {} } };
const errEl = { textContent: "" };
const FORM: Record<string, unknown> = {
  "#toast": toastEl,
  "#send-err": errEl,
  '#send-form input[name="contact"]:checked': { value: "c1" },
  '#send-form input[name="account"]:checked': { value: "a1" },
};
/** New payment's picked payees, as send.js draws them: one row each. */
const payeeRow = (contactId: string, amount: string, note = "") => ({
  dataset: { line: contactId },
  querySelector: (s: string) => (s === '[data-lf="amount"]' ? { value: amount, focus() {} } : s === '[data-lf="note"]' ? { value: note } : null),
});
let payees = [payeeRow("c1", "250")];
const handlers: Record<string, (e: any) => void> = {};
const calls: { url: string; init: any }[] = [];
let answer: (url: string, init: any) => any = () => json(200, {});
let reloads = 0;
const assigned: string[] = [];
ls.setItem("zold-session", "tok");
Object.assign(g, {
  window: g, localStorage: ls, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  requestAnimationFrame: (fn: () => void) => fn(),
  addEventListener: (type: string, fn: (e: any) => void) => { handlers[type] = fn; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  history: { pushState() {}, replaceState() {}, state: null },
  location: { pathname: "/business", search: "", hash: "", href: "http://test/business", reload: () => { reloads++; }, assign: (u: string) => { assigned.push(u); } },
  document: {
    hidden: false, title: "",
    querySelector: (s: string) => FORM[s] ?? null,
    getElementById: () => null, querySelectorAll: (s: string) => (s === "#send-lines [data-line]" ? payees : []), createElement: () => stub, body: stub, documentElement: stub,
    addEventListener() {},
  },
  fetch: async (url: string, init: any) => { calls.push({ url, init }); return answer(url, init); },
});
Object.defineProperty(g, "navigator", { value: { userAgent: "test", language: "en", maxTouchPoints: 0, onLine: true }, configurable: true });
vm.runInThisContext(readFileSync(path.join(PUB, "ui.js"), "utf8"), { filename: "ui.js" });

const biz = (f: string) => pathToFileURL(path.join(PUB, "business", f)).href;
const core = await import(biz("core.js"));
const { ACTIONS } = await import(biz("actions.js"));
const { ap } = await import(biz("screens.js"));

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await check("New payment: a refused submit lands on Drafts and says the draft was saved; the draft is posted once", async () => {
  core.setOrg({ id: "o1", role: "owner", paymentReview: { required: true } });
  core.setView("send", { push: false });
  answer = (url, init) => {
    if (url === "/api/orgs/o1/contacts") return json(200, { contacts: [{ id: "c1", name: "Kessler", bankAccounts: [{ id: "b1", iban: "DE89370400440532013000", holderName: "Kessler GmbH" }] }] });
    if (url === "/api/orgs/o1/drafts" && init.method === "POST") return json(200, { draft: { id: "d1" } });
    if (url === "/api/orgs/o1/drafts/d1/submit") return json(409, { error: "No one else can approve it." });
    throw new Error(`unexpected call: ${init?.method || "GET"} ${url}`);
  };
  await ACTIONS["send-create"]();
  const posts = calls.filter((c) => c.url === "/api/orgs/o1/drafts" && c.init.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body).lines[0].destination, { kind: "bank", bankAccountId: "b1", displayName: "Kessler GmbH" });
  assert.equal(core.view, "payments");
  assert.equal(ap.tab, "drafts");
  assert.equal(toastEl.className, "bad");
  assert.match(toastEl.textContent, /Saved as a draft, but not submitted: No one else can approve it\./);
  assert.equal(errEl.textContent, "");
});

await check("New payment with two payees: one draft, one line each, built from the address book", async () => {
  core.setOrg({ id: "o1", role: "owner", paymentReview: { required: false } });
  core.setView("send", { push: false });
  payees = [payeeRow("c2", "1200,50", "October"), payeeRow("c1", "80")];
  calls.length = 0;
  answer = (url, init) => {
    if (url === "/api/orgs/o1/contacts") return json(200, { contacts: [
      { id: "c1", name: "Kessler", bankAccounts: [{ id: "b1", iban: "DE89370400440532013000", holderName: "Kessler GmbH" }] },
      { id: "c2", name: "Weber", bankAccounts: [{ id: "b2", iban: "FR1420041010050500013M02606" }] },
    ] });
    if (url === "/api/orgs/o1/drafts" && init.method === "POST") return json(200, { draft: { id: "d2" } });
    throw new Error(`unexpected call: ${init?.method || "GET"} ${url}`);
  };
  await ACTIONS["send-create"]();
  const posts = calls.filter((c) => c.url === "/api/orgs/o1/drafts" && c.init.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    source: { kind: "account", accountId: "a1" },
    lines: [
      { contactId: "c2", destination: { kind: "bank", bankAccountId: "b2", displayName: "Weber" }, asset: "EUR", amount: "1200.50", note: "October" },
      { contactId: "c1", destination: { kind: "bank", bankAccountId: "b1", displayName: "Kessler GmbH" }, asset: "EUR", amount: "80" },
    ],
  });
  assert.equal(core.view, "payments");
  assert.equal(ap.tab, "drafts");
  assert.equal(errEl.textContent, "");
});

await check("New payment: a payee with no amount saves nothing and says whose", async () => {
  payees = [payeeRow("c1", "80"), payeeRow("c2", "")];
  calls.length = 0;
  answer = (url) => {
    if (url === "/api/orgs/o1/contacts") return json(200, { contacts: [
      { id: "c1", name: "Kessler", bankAccounts: [{ id: "b1", iban: "DE89370400440532013000" }] },
      { id: "c2", name: "Weber", bankAccounts: [{ id: "b2", iban: "FR1420041010050500013M02606" }] },
    ] });
    throw new Error(`unexpected call: ${url}`);
  };
  core.setView("send", { push: false });
  assert.equal(await ACTIONS["send-create"](), "keep");
  assert.match(errEl.textContent, /for Weber/);
  assert.equal(calls.filter((c) => c.url.endsWith("/drafts")).length, 0);
  errEl.textContent = "";
  payees = [payeeRow("c1", "250")];
});

await check("New payment: Add a contact keeps the payees entered, and the form's handlers add, keep and remove", async () => {
  const { sendState } = await import(biz("send.js"));
  const { RENDER } = await import(biz("views.js"));
  const o1 = { id: "o1", role: "owner", paymentReview: { required: false }, capabilities: { "transfers.drafts": { allowed: true } } };
  core.setOrg(o1);
  core.setView("send", { push: false });
  const saved = [
    { id: "c1", name: "Kessler", bankAccounts: [{ id: "b1", iban: "DE89370400440532013000" }] },
    { id: "c2", name: "Weber", bankAccounts: [{ id: "b2", iban: "FR1420041010050500013M02606" }] },
  ];
  answer = (url, init) => {
    if (url === "/api/orgs/o1/contacts" && init?.method === "POST") {
      saved.push({ id: "c3", name: "Brandt", bankAccounts: [{ id: "b3", iban: "NL91ABNA0417164300" }] });
      return json(200, { contact: saved[2] });
    }
    if (url === "/api/orgs/o1/contacts") return json(200, { contacts: saved });
    if (url === "/api/orgs/o1/accounts") return json(200, { accounts: [
      { id: "a0", status: "active", backingUserId: "u1", label: "Main" },
      { id: "a1", status: "active", backingUserId: "u1", label: "Second" },
    ] });
    return json(200, {});
  };
  // The form as it stands when Add a contact is pressed.
  payees = [payeeRow("c1", "80", "October"), payeeRow("c2", "12,5")];
  // The shell's redraw after a dialog needs a whole page, so closing the
  // dialog leaves it nothing to draw; the form's own render is called below.
  const dlg: Record<string, any> = {
    "#dlg-body": { innerHTML: "" }, "#dlg": { showModal() {}, close() { core.setOrg(null); } }, "#dlg-cancel": {}, "#dlg-ok": { disabled: false }, "#dlg-err": { textContent: "" },
    "#d-name": { value: "Brandt" }, "#d-email": { value: "" }, "#d-iban": { value: "NL91ABNA0417164300" }, "#d-holder": { value: "" }, "#d-country": { value: "" },
  };
  Object.assign(FORM, dlg);
  ACTIONS["new-contact"]();
  await dlg["#dlg-ok"].onclick();
  assert.equal(dlg["#dlg-err"].textContent, "");
  for (const k of Object.keys(dlg)) delete FORM[k];
  core.setOrg(o1);
  assert.deepEqual(sendState.rows, [{ contactId: "c1", amount: "80", note: "October" }, { contactId: "c2", amount: "12,5", note: "" }]);
  assert.equal(sendState.contactId, "c3");
  assert.equal(sendState.accountId, "a1");

  // The redraw: every payee is back with what was typed, the new contact after them.
  const out = await RENDER.send();
  const ticked = (id: string) => new RegExp(`name="contact" value="${id}" checked`).test(out.html);
  assert.ok(ticked("c1") && ticked("c2") && ticked("c3"));
  assert.match(out.html, /name="account" value="a1" checked/, "the account picked stays picked");
  const on: Record<string, (e: any) => void> = {};
  const el: Record<string, any> = {
    "#send-form": { addEventListener: (t: string, fn: (e: any) => void) => { on[t] = fn; }, querySelector: () => null },
    "#send-summary": { innerHTML: "" }, "#send-lines": { innerHTML: "" }, "#send-max": { textContent: "" },
  };
  const picks = ["c1", "c2", "c3"].map((value) => ({ name: "contact", value, checked: true, disabled: false }));
  const box = { querySelector: (s: string) => el[s] ?? null, querySelectorAll: (s: string) => (s.startsWith("#send-contacts") ? picks : []) };
  out.bind(box);
  const lines = () => [...el["#send-lines"].innerHTML.matchAll(/data-line="(\w+)"[\s\S]*?data-lf="amount"[^>]* value="([^"]*)"[\s\S]*?data-lf="note"[^>]* value="([^"]*)"/g)].map((x) => x.slice(1));
  assert.deepEqual(lines(), [["c1", "80", "October"], ["c2", "12,5", ""], ["c3", "", ""]]);
  assert.deepEqual(sendState.rows, [], "carried once: a later New payment starts empty");
  assert.match(el["#send-summary"].innerHTML, /3 payees/);

  // Typing an amount, unticking one contact, removing another with its button.
  on.input({ target: { closest: () => ({ dataset: { line: "c3" } }), dataset: { lf: "amount" }, value: "7" } });
  picks[1].checked = false;
  on.change({ target: picks[1] });
  assert.deepEqual(lines(), [["c1", "80", "October"], ["c3", "7", ""]]);
  on.click({ target: { closest: () => ({ dataset: { drop: "c1" } }) } });
  assert.deepEqual(lines(), [["c3", "7", ""]]);
  assert.equal(picks[0].checked, false, "the removed payee's box is unticked");
  picks[0].checked = true;
  on.change({ target: picks[0] });
  assert.deepEqual(lines(), [["c3", "7", ""], ["c1", "", ""]]);

  // A payee who lost their IBAN while Add a contact was open is still in the
  // form with what was typed, marked, and removable: never dropped unseen.
  saved[1].bankAccounts = [];
  sendState.rows = [{ contactId: "c1", amount: "80", note: "" }, { contactId: "c2", amount: "125", note: "rent" }];
  (await RENDER.send()).bind(box);
  assert.deepEqual(lines(), [["c1", "80", ""], ["c2", "125", "rent"], ["c3", "", ""]]);
  assert.match(el["#send-lines"].innerHTML, /Weber[\s\S]*?No IBAN saved: remove to save/);
  on.click({ target: { closest: () => ({ dataset: { drop: "c2" } }) } });
  assert.deepEqual(lines(), [["c1", "80", ""], ["c3", "", ""]]);
  // A New payment opened after that carries no payee from before; the contact
  // added last is still ticked, with nothing typed (sendState.contactId).
  (await RENDER.send()).bind(box);
  assert.deepEqual(lines(), [["c3", "", ""]]);
  payees = [payeeRow("c1", "250")];
});

const pageshow = (persisted: boolean) => handlers.pageshow({ persisted });

await check("a cached page is shown again only to the session it loaded with", () => {
  assert.equal(typeof handlers.pageshow, "function");
  pageshow(true);
  assert.equal(reloads, 0, "same session: no reload");
  pageshow(false);
  ls.setItem("zold-session", "someone-else");
  pageshow(false);
  assert.equal(reloads, 0, "an ordinary load never reloads");
  pageshow(true);
  assert.equal(reloads, 1, "another person signed in: reload");
  ls.setItem("zold-session", "tok");
});

await check("sign out asks the server to end the session and clears this browser, drafts included, even when the server never hears it", async () => {
  ls.setItem("zoll-contacts", "[]");
  ls.setItem("zold-web-invoice-draft:o1", "{}");
  ls.setItem("zold-web-invoice-draft:o2", "{}");
  ls.setItem("zold-org", "o1");
  calls.length = 0;
  answer = () => { throw new TypeError("Failed to fetch"); };
  core.signOut();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/session");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(calls[0].init.keepalive, true);
  assert.deepEqual(Object.keys(ls), ["zold-org"]);
  assert.equal(core.token, null);
  assert.deepEqual(assigned, ["/business"]);
});

await check("Back after sign out reloads instead of showing the old page", () => {
  reloads = 0;
  pageshow(true);
  assert.equal(reloads, 1);
});

console.log(`\nbusiness sign out and send: ${passed} checks passed`);
process.exit(0);
