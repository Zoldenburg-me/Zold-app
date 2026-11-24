/**
 * The share composer and the link it produces (board #129).
 *
 * `#share-compose/<transferId>` is the sender's own screen: it needs their
 * session. The link a recipient opens is the /r/<slug> URL the composer
 * produces. So the composer must show that URL as its result, with Copy and
 * Share buttons, and its own address must not read as a share link: an old
 * `#share/<id>` still opens it and the address bar is rewritten.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screen in a browser, the OS share sheet, or the public
 * /r/ page (share-receipt tests cover the API). Offline.
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
/* An element whose class list and text this test reads; anything else it is
   asked for is the stub. */
const els = new Map<string, any>();
const el = (id: string) => {
  if (!els.has(id)) {
    const cls = new Set<string>();
    const own: any = {
      id, textContent: "", innerHTML: "", dataset: {},
      classList: { add: (c: string) => void cls.add(c), remove: (c: string) => void cls.delete(c), contains: (c: string) => cls.has(c), toggle: (c: string, on?: boolean) => { const v = on ?? !cls.has(c); if (v) cls.add(c); else cls.delete(c); return v; } },
      hasAttribute: () => true, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null,
    };
    els.set(id, new Proxy(own, { get: (t, k) => (k in t ? t[k] : stub), set: (t, k, v) => { t[k] = v; return true; } }));
  }
  return els.get(id);
};
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
const replaced: string[] = [];
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, platform: "test" },
  location: { pathname: "/app", search: "", hash: "", host: "zold.test", origin: "https://zold.test", assign() {}, replace() {} },
  history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url), pushState() {}, back() {} },
  localStorage: storage(),
  sessionStorage: storage(),
  fetch: () => Promise.reject(new Error("no network in this test")),
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
  "narwhal/narwhal.js", "app/onboarding.js", "app/send.js", "app/signers.js", "app/phone.js", "app/phone-home.js", "app/phone-activity.js",
  "app/phone-send.js", "app/phone-add.js", "app/phone-getpaid.js", "app/phone-more.js", "app/settings.js", "app/desktop.js",
]) load(f);
const run = (code: string) => vm.runInContext(code, ctx);

const URL_R = "https://zold.test/r/abcDEF123";
const EXPIRES = new Date(Date.now() + 30 * 86400000).toISOString();
let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
const hidden = (id: string) => el(id).classList.contains("hidden");

await t("an old #share/<id> link still opens the composer, and the address bar stops saying #share/", () => {
  run(`user = { id: "u1", name: "Erika Muster", accountType: "personal" }; __opened = [];
    openShare = (id) => { __opened.push(id); };`);
  assert.deepEqual({ ...run(`phParse("#share/t1")`) }, { name: "share-compose", arg: "t1" });
  ctx.location.hash = "#share/t1";
  replaced.length = 0;
  run("phStart()");
  assert.deepEqual([...run("__opened")], ["t1"], "the sender's composer opened for that payment");
  assert.equal(replaced[0], "/app#share-compose/t1");
  assert.ok(!replaced.some((u) => /#share\//.test(u)), "no #share/ left in the address bar");
  ctx.location.hash = "";
});

await t("the app's own Share buttons point at #share-compose/", () => {
  assert.equal(run(`phHref("share-compose", "t1")`), "#share-compose/t1");
  for (const f of ["app/phone-activity.js", "app/phone-send.js", "business/views.js"]) {
    const src = readFileSync(path.join(PUB, f), "utf8");
    assert.doesNotMatch(src, /phHref\("share",|#share\//, `${f} still links the old #share/ name`);
  }
});

await t("no link yet: nothing to send is shown, and the button says it creates one", () => {
  run(`mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false }; paintShare();`);
  assert.ok(hidden("m-share-out"));
  assert.equal(el("m-share-copy").textContent, "Create and copy link");
  assert.ok(hidden("m-share-native"), "no share sheet in this browser, no Share button");
  assert.match(el("m-share-foot").textContent, /Nothing is public until you create the link/);
});

await t("a live link is drawn as 'Send this link', with Copy, and Share where the browser has a share sheet", () => {
  ctx.navigator.share = async () => {};
  run(`mShare = { ...mShare, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)} }; paintShare();`);
  assert.ok(!hidden("m-share-out"));
  assert.equal(el("m-share-url").textContent, URL_R);
  assert.equal(el("m-share-copy").textContent, "Copy link");
  assert.ok(!hidden("m-share-native"));
  assert.match(el("m-share-foot").textContent, /^Live · expires in 30 days$/);
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  assert.match(html, /id="m-share-out"[\s\S]*?<h3 class="m-shhead">Send this link<\/h3>[\s\S]*?id="m-share-url"/);
  delete ctx.navigator.share;
});

await t("Copy copies the /r/ link", async () => {
  const copied: string[] = [];
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  run(`announce = () => {};`);
  await el("m-share-copy").onclick();
  assert.deepEqual(copied, [URL_R]);
  assert.equal(el("m-share-copy").textContent, "Link copied");
});

await t("Share with no link yet creates it first, then hands the /r/ link to the share sheet", async () => {
  const shared: any[] = [];
  ctx.navigator.share = async (d: any) => void shared.push(d);
  run(`mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false };
    __posts = []; api = async (p, body) => { __posts.push(p); return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)} }; };`);
  await el("m-share-native").onclick();
  assert.deepEqual([...run("__posts")], ["/api/transfers/t1/share"]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].url, URL_R);
  assert.equal(el("m-share-url").textContent, URL_R);
});

await t("closing the share sheet is not an error; a sheet that fails falls back to the clipboard", async () => {
  const copied: string[] = [];
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  el("m-share-err").classList.add("hidden");
  ctx.navigator.share = async () => { const e = new Error("closed"); e.name = "AbortError"; throw e; };
  await el("m-share-native").onclick();
  assert.deepEqual(copied, []);
  assert.ok(hidden("m-share-err"));
  ctx.navigator.share = async () => { throw new Error("NotAllowedError"); };
  await el("m-share-native").onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [URL_R]);
  delete ctx.navigator.share;
});

console.log(`\nSHARE LINK UI TEST PASSED — ${pass}/${pass}`);
