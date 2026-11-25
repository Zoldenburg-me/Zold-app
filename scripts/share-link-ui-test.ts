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
import { readdirSync, readFileSync } from "node:fs";
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
// Tests that need to count opens stub openShare; this puts the real one back.
run("__realOpenShare = openShare; __realMobileNav = mobileNav;");

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

await t("a company login opens the composer from Business: #share-compose/ is in its allowed set", () => {
  run(`user = { id: "c1", name: "Acme GmbH", accountType: "company" }; __opened = []; __left = 0;
    phCompanyLeave = () => { __left++; };`);
  ctx.location.hash = "#share-compose/t9";
  replaced.length = 0;
  run("phStart()");
  assert.deepEqual([...run("__opened")], ["t9"], "the company's composer opened for that payment");
  assert.equal(run("__left"), 0, "the company login was not sent back to /business");
  assert.equal(replaced[0], "/app#share-compose/t9");
  // Business → Statements links here; the link must be the route the app opens.
  const views = readFileSync(path.join(PUB, "business/views.js"), "utf8");
  const href = views.match(/href="\/app(#share-compose\/)\$\{encodeURIComponent\(t\.id\)\}"/);
  assert.ok(href, "Business → Statements links /app#share-compose/<id>");
  assert.equal(run(`phParse("#share-compose/t9").name`), "share-compose");
  ctx.location.hash = "";
  run(`user = { id: "u1", name: "Erika Muster", accountType: "personal" };`);
});

await t("an old #share/<id> reached while the app is open (Back, a pasted hash) also loses #share/", () => {
  run(`__opened = [];`);
  ctx.location.hash = "#share/t2";
  replaced.length = 0;
  run(`phOpen(phParse(location.hash))`);
  assert.deepEqual([...run("__opened")], ["t2"]);
  assert.deepEqual(replaced, ["/app#share-compose/t2"]);
  ctx.location.hash = "";
});

await t("no file in public/ links the old #share/ name", () => {
  assert.equal(run(`phHref("share-compose", "t1")`), "#share-compose/t1");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|html)$/.test(e.name) ? [path.join(d, e.name)] : []);
  const files = walk(PUB);
  assert.ok(files.length > 20, "the walk found the app's files");
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // A link is a string or an href; phone.js still names the old route in
    // a comment and the regex that rewrites it.
    assert.doesNotMatch(src, /phHref\("share",|["'`]#share\/|href="[^"]*#share\//, `${path.relative(PUB, f)} still links the old #share/ name`);
  }
});

await t("no link yet: nothing to send is shown, the button only creates one, and there is no Share yet", () => {
  ctx.navigator.share = async () => {};
  run(`mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false, loaded: true }; paintShare();`);
  assert.ok(hidden("m-share-out"));
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.ok(hidden("m-share-native"), "Share waits for a link, so its tap can open the sheet at once");
  assert.match(el("m-share-foot").textContent, /Nothing is public until you create the link/);
  delete ctx.navigator.share;
});

await t("Create link creates it and shows it, and copies nothing (the tap's activation is spent on the request)", async () => {
  const copied: string[] = [];
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  ctx.navigator.share = async () => {};
  run(`announce = () => {}; __posts = []; api = async (p, body) => { __posts.push(p); return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)} }; };`);
  await el("m-share-copy").onclick();
  assert.deepEqual([...run("__posts")], ["/api/transfers/t1/share"]);
  assert.deepEqual(copied, []);
  assert.ok(!hidden("m-share-out"));
  assert.equal(el("m-share-url").textContent, URL_R);
  assert.equal(el("m-share-copy").textContent, "Copy link");
  assert.ok(!hidden("m-share-native"), "Share appears once there is a link");
  delete ctx.navigator.share;
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
  await el("m-share-copy").onclick();
  assert.deepEqual(copied, [URL_R]);
  assert.equal(el("m-share-copy").textContent, "Link copied");
});

await t("Share opens the sheet in the same tick as the tap, with the /r/ link and no request first", () => {
  const shared: any[] = [];
  ctx.navigator.share = async (d: any) => void shared.push(d);
  run(`__posts = [];`);
  void el("m-share-native").onclick();
  // Nothing awaited: transient activation from the tap is still there.
  assert.equal(shared.length, 1, "navigator.share was called synchronously from the click");
  assert.equal(shared[0].url, URL_R);
  assert.deepEqual([...run("__posts")], []);
  delete ctx.navigator.share;
});

await t("closing the share sheet is not an error; a sheet that fails says to use Copy, and copies nothing itself", async () => {
  const copied: string[] = [];
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  el("m-share-err").classList.add("hidden");
  ctx.navigator.share = async () => { const e = new Error("closed"); e.name = "AbortError"; throw e; };
  await el("m-share-native").onclick();
  assert.deepEqual(copied, []);
  assert.ok(hidden("m-share-err"));
  ctx.navigator.share = async () => { const e = new Error("no activation"); e.name = "NotAllowedError"; throw e; };
  await el("m-share-native").onclick();
  assert.ok(!hidden("m-share-err"), "the failure is shown");
  assert.match(el("m-share-err").textContent, /Copy link/);
  assert.deepEqual(copied, [], "no clipboard write without a fresh tap");
  delete ctx.navigator.share;
});

await t("an expired link is never shown, copied or shared: the composer keeps the choices and offers a new link", async () => {
  const shared: any[] = [];
  const copied: string[] = [];
  ctx.navigator.share = async (d: any) => void shared.push(d);
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  // The API answers an expired share with 404 { expired, fields }.
  run(`mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, busy: false };
    api = async (p, body, method) => { if (method === "GET") throw Object.assign(new Error("the link for this payment has expired"), { status: 404, fromZold: true, body: { expired: true, fields: { sender: "full", route: true } } });
      __posts.push(p); return { url: "https://zold.test/r/fresh-slug-xyz", expiresAt: ${JSON.stringify(EXPIRES)} }; }; __posts = [];`);
  await run("renderShareScreen()");
  assert.equal(run("mShare.link"), null);
  assert.equal(run("mShare.fields.sender"), "full", "the sender's last choices are kept");
  assert.equal(run("mShare.fields.route"), true);
  assert.ok(hidden("m-share-out"));
  assert.ok(hidden("m-share-native"));
  assert.ok(hidden("m-share-revoke"));
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.match(el("m-share-foot").textContent, /expired/i);
  await el("m-share-copy").onclick();
  assert.deepEqual([...run("__posts")], ["/api/transfers/t1/share"]);
  assert.equal(el("m-share-url").textContent, "https://zold.test/r/fresh-slug-xyz");
  assert.deepEqual(copied, []);
  assert.deepEqual(shared, []);
  delete ctx.navigator.share;
});

await t("a link that expires while the composer is open stops being offered", () => {
  ctx.navigator.share = async () => {};
  const past = new Date(Date.now() - 1000).toISOString();
  run(`mShare = { ...mShare, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(past)} }; paintShare();`);
  assert.ok(hidden("m-share-out"));
  assert.ok(hidden("m-share-native"));
  assert.equal(el("m-share-url").textContent, "");
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.match(el("m-share-foot").textContent, /expired/i);
  delete ctx.navigator.share;
});

await t("Create link and the controls are refused until the saved choices load; the link then carries exactly what is shown", async () => {
  // The expired link withheld the recipient; the screen paints defaults
  // (recipient: full) first and only learns that from the GET.
  run(`openShare = (id) => { mShare = { transferId: id, fields: { ...SHARE_DEFAULTS }, link: null, expiresAt: null, expired: false, busy: false, loaded: false }; };
    openShare("t1"); __posts = []; __bodies = []; __gate = new Promise((r) => { __releaseGet = r; });
    api = async (p, body, method) => {
      if (method === "GET") { await __gate; throw Object.assign(new Error("expired"), { status: 404, fromZold: true, body: { expired: true, fields: { recipient: "hidden" } } }); }
      __posts.push(p); __bodies.push(body); return { url: "https://zold.test/r/fresh", expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };`);
  const pending = run("renderShareScreen()");
  assert.equal(el("m-share-copy").disabled, true, "Create link is disabled while the saved choices load");
  await el("m-share-copy").onclick();
  await run(`setShare("sender", "full")`);
  assert.deepEqual([...run("__posts")], [], "nothing is published with the defaults");
  assert.equal(run("mShare.fields.sender"), "last", "a control change before load is refused");
  run("__releaseGet()");
  await pending;
  assert.equal(el("m-share-copy").disabled, false);
  assert.equal(run("mShare.fields.recipient"), "hidden");
  await el("m-share-copy").onclick();
  assert.equal(run("__bodies[0].recipient"), "hidden", "the link carries the choices the preview shows");
  assert.deepEqual({ ...run("__bodies[0]") }, { ...run("mShare.fields") });
});

await t("the same holds for a live link: Create link before the GET cannot widen it", async () => {
  run(`openShare("t1"); __posts = []; __gate = new Promise((r) => { __releaseGet = r; });
    api = async (p, body, method) => {
      if (method === "GET") { await __gate; return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { recipient: "hidden" } }; }
      __posts.push(p); return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };`);
  const pending = run("renderShareScreen()");
  assert.equal(el("m-share-copy").disabled, true);
  await el("m-share-copy").onclick();
  assert.deepEqual([...run("__posts")], []);
  run("__releaseGet()");
  await pending;
  assert.equal(run("mShare.link"), URL_R);
  assert.equal(run("mShare.fields.recipient"), "hidden");
});

await t("a failed load keeps Create link disabled and says so", async () => {
  run(`openShare("t1"); __posts = []; api = async (p, body, method) => { if (method === "GET") throw Object.assign(new Error("offline"), { status: 0 }); __posts.push(p); return {}; };`);
  el("m-share-err").classList.add("hidden");
  await run("renderShareScreen()");
  assert.equal(el("m-share-copy").disabled, true);
  assert.ok(!hidden("m-share-err"));
  await el("m-share-copy").onclick();
  assert.deepEqual([...run("__posts")], []);
});

await t("a settings change on a live link is an edit: it never asks for a new link, and an edit refused as expired leaves none", async () => {
  run(`mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true };
    __bodies = []; api = async (p, body) => { __bodies.push(body); throw Object.assign(new Error("this link has expired"), { status: 409, body: { expired: true, fields: body } }); };`);
  await run(`setShare("route", true)`);
  assert.equal(run("__bodies[0].edit"), true, "the autosave says it is an edit");
  assert.equal(run("mShare.link"), null, "the dead link is dropped");
  assert.equal(run("mShare.expired"), true);
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.ok(hidden("m-share-out"));
});

await t("Copy and Share check expiry at the tap, even if the screen has not redrawn", async () => {
  const shared: any[] = [];
  const copied: string[] = [];
  ctx.navigator.share = async (d: any) => void shared.push(d);
  ctx.navigator.clipboard = { writeText: async (s: string) => void copied.push(s) };
  const past = new Date(Date.now() - 1000).toISOString();
  run(`__posts = []; api = async (p) => { __posts.push(p); return {}; };
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(past)}, expired: false, busy: false, loaded: true };`);
  await el("m-share-native").onclick();
  assert.deepEqual(shared, [], "the dead link is not shared");
  run(`mShare = { ...mShare, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(past)}, expired: false };`);
  await el("m-share-copy").onclick();
  assert.deepEqual(copied, [], "the dead link is not copied");
  assert.deepEqual([...run("__posts")], [], "and no new link is made by that tap");
  assert.equal(run("mShare.link"), null);
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.match(el("m-share-foot").textContent, /expired/i);
  delete ctx.navigator.share;
});

const URL_B = "https://zold.test/r/receiptB999";
/* Receipt A's live link has a gated autosave in flight; the sender goes Back
   and opens receipt B, whose live link withholds the recipient. */
const openAThenB = async (answerA: string) => {
  // The real openShare and navigation, not a test's stub: B must get a fresh
  // composer object and the share screen, as a tap on its receipt does.
  run(`openShare = __realOpenShare; __navs = []; mobileNav = (v) => { __navs.push(v); };`);
  run(`__bodies = []; __gateA = new Promise((r) => { __releaseA = r; });
    api = async (p, body, method) => {
      if (method === "GET") return { url: ${JSON.stringify(URL_B)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { recipient: "hidden" } };
      __bodies.push({ p, body }); await __gateA; ${answerA} };
    mShare = { transferId: "tA", fields: { ...SHARE_DEFAULTS, recipient: "full" }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true };`);
  const saving = run(`setShare("route", true)`);
  const a = run("mShare");
  run(`openShare("tB")`);
  assert.notEqual(run("mShare"), a, "B gets a fresh composer");
  assert.equal(run("mShare.loaded"), false, "B's controls wait for B's saved choices");
  assert.deepEqual([...run("__navs")], ["share"], "the share screen is opened");
  await run("renderShareScreen()");
  assert.equal(run("mShare.link"), URL_B);
  run("__releaseA()");
  await saving;
};

await t("a save for receipt A that lands after receipt B opened leaves B's link and choices alone", async () => {
  await openAThenB(`return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body };`);
  assert.equal(run("mShare.transferId"), "tB");
  assert.equal(run("mShare.link"), URL_B, "B still offers its own link");
  assert.equal(el("m-share-url").textContent, URL_B, "and Send this link shows it");
  assert.equal(run("mShare.fields.recipient"), "hidden", "B's choices are not A's");
  assert.equal(run("mShare.fields.route"), false);
  // The next change on B goes to B, with B's choices.
  run(`__releaseA = () => {}; __gateA = Promise.resolve();`);
  await run(`setShare("showRate", false)`);
  const last = run("__bodies[__bodies.length - 1]");
  assert.equal(last.p, "/api/transfers/tB/share");
  assert.equal(last.body.recipient, "hidden", "B's live link is not widened");
});

await t("an expired answer for receipt A does not drop receipt B's live link", async () => {
  await openAThenB(`throw Object.assign(new Error("this link has expired"), { status: 409, body: { expired: true, fields: body } });`);
  assert.equal(run("mShare.link"), URL_B);
  assert.equal(run("mShare.expired"), false);
  assert.ok(!hidden("m-share-out"));
});

await t("a load error is cleared once a later load succeeds", async () => {
  run(`openShare("t1"); api = async () => { throw Object.assign(new Error("offline"), { status: 0 }); };`);
  el("m-share-err").classList.add("hidden");
  await run("renderShareScreen()");
  assert.ok(!hidden("m-share-err"));
  run(`openShare("t1"); api = async () => ({ url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: {} });`);
  await run("renderShareScreen()");
  assert.ok(hidden("m-share-err"), "the old warning is gone above working controls");
});

await t("every radio and switch renders disabled until the saved choices load, and enabled after", async () => {
  run(`openShare("t1"); __gate = new Promise((r) => { __releaseGet = r; });
    api = async () => { await __gate; return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: {} }; };`);
  const pending = run("renderShareScreen()");
  const radios = () => el("m-share-groups").innerHTML.match(/<input type="radio"[^>]*>/g) || [];
  const switches = () => el("m-share-toggles").innerHTML.match(/<button [^>]*role="switch"[^>]*>/g) || [];
  assert.equal(radios().length, run("SHARE_GROUPS.reduce((n, g) => n + g.options.length, 0)"));
  assert.equal(switches().length, run("SHARE_TOGGLES.length"));
  for (const c of [...radios(), ...switches()]) assert.match(c, / disabled[ >/]/, `${c} is disabled before load`);
  run("__releaseGet()");
  await pending;
  for (const c of [...radios(), ...switches()]) assert.doesNotMatch(c, / disabled[ >/]/, `${c} is enabled after load`);
});

await t("a second change made while the first save is in flight is kept on screen and saved after it", async () => {
  run(`__bodies = []; __gates = []; api = async (p, body) => { __bodies.push({ ...body }); await new Promise((r) => __gates.push(r));
      return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true };`);
  const first = run(`setShare("route", true)`);
  await run(`setShare("showRate", false)`);
  assert.equal(run("__bodies.length"), 1, "one save at a time");
  run("__gates[0]()");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(run("mShare.fields.showRate"), false, "the second tap does not revert when the first save lands");
  assert.equal(run("__bodies.length"), 2, "the second change is saved next");
  assert.equal(run("__bodies[1].showRate"), false);
  assert.equal(run("__bodies[1].route"), true);
  assert.equal(run("__bodies[1].edit"), true);
  run("__gates[1]()");
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(run("mShare.busy"), false);
  assert.equal(run("mShare.fields.showRate"), false);
  assert.equal(run("mShare.fields.route"), true);
});

await t("a failed edit shows what the live link still carries, says so, and drops the queued change", async () => {
  run(`mobileNav = __realMobileNav; __bodies = []; __gates = [];
    api = async (p, body) => { __bodies.push({ ...body }); if (__bodies.length === 1) await new Promise((r) => __gates.push(r)); throw Object.assign(new Error("server unavailable"), { status: 503 }); };
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS, recipient: "full" }, published: { ...SHARE_DEFAULTS, recipient: "full" }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true };
    hist.length = 0; hist.push({ id: "t1", rail: "sepa", recipientName: "Max Mustermann" });`);
  el("m-share-err").classList.add("hidden");
  const first = run(`setShare("route", true)`);
  // Queued while the first save is in flight: hide the recipient.
  await run(`setShare("recipient", "hidden")`);
  assert.match(el("m-share-preview").innerHTML, /Recipient<\/span><span class="v">withheld/, "the tap is drawn at once");
  run("__gates[0]()");
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(run("__bodies.length"), 1, "the queued change is not sent after a failure");
  assert.equal(run("mShare.again"), false);
  assert.equal(run("mShare.fields.recipient"), "full", "the screen shows what the live link still carries");
  assert.equal(run("mShare.fields.route"), false);
  assert.match(el("m-share-preview").innerHTML, /Recipient<\/span><span class="v">Max Mustermann/, "the preview names the recipient the link still shows");
  assert.ok(!hidden("m-share-err"), "the failure is shown, not swallowed");
  assert.match(el("m-share-err").textContent, /not saved/i);
  assert.match(el("m-share-err").textContent, /server unavailable/);
  assert.equal(run("mShare.link"), URL_R, "the link itself is still live");
  run("hist.length = 0;");
});

await t("after a save lands, a later failed edit reverts to that save, not to the load", async () => {
  run(`__n = 0; api = async (p, body) => { if (__n++ === 0) return { url: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; throw Object.assign(new Error("offline"), { status: 0 }); };
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, published: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true };`);
  await run(`setShare("recipient", "hidden")`);
  await run(`setShare("route", true)`);
  assert.equal(run("mShare.fields.recipient"), "hidden", "the saved narrowing stays");
  assert.equal(run("mShare.fields.route"), false, "the failed change is undone");
});

console.log(`\nSHARE LINK UI TEST PASSED — ${pass}/${pass}`);
