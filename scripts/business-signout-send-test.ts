/**
 * /business: signing out, a cached page, and a payment whose submit is refused.
 *
 * - Sign out ends the session on the server (DELETE /api/session with the
 *   token), clears the session, the contact cache and unsent invoice drafts
 *   from this browser even when that call fails, and loads /business.
 * - A page restored from the back-forward cache reloads unless the stored
 *   session is the one it loaded with.
 * - New payment: the draft is created, the submit is refused: the screen goes
 *   to Drafts and says so, and the draft was posted once.
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
  "#d-amt": { value: "250", focus() {} },
  "#d-note": { value: "" },
  '#send-form input[name="contact"]:checked': { value: "c1" },
  '#send-form input[name="account"]:checked': { value: "a1" },
};
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
    getElementById: () => null, querySelectorAll: () => [], createElement: () => stub, body: stub, documentElement: stub,
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
