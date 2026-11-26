/**
 * The share composer and the link it produces (board #129).
 *
 * `#share-compose/<transferId>` is the sender's own screen: it needs their
 * session. The link a recipient opens is the /r/<slug> URL the composer
 * produces. So the composer must show that URL as its result, with Copy and
 * Share buttons, and its own address must not read as a share link: an old
 * `#share/<id>` still opens it and the address bar is rewritten.
 *
 * A link once sent never changes: a choice changed while a link is live
 * offers "Make new link", which makes a new link and turns the old one off.
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
const URL_NEW = "https://zold.test/r/newlink777";
const live = (over = "") => run(`announce = (m) => { __said = m; }; __said = ""; __posts = []; __bodies = []; __dels = 0;
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, published: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true, revokes: 0 ${over} };
    hist.length = 0; hist.push({ id: "t1", rail: "sepa", recipientName: "Max Mustermann" }); paintShare();`);

await t("a change on a live link sends nothing: the link keeps what it shows and the button offers a new link", async () => {
  ctx.navigator.share = async () => {};
  live();
  run(`api = async (p, body, method) => { __posts.push({ p, body, method }); return {}; };`);
  await run(`setShare("route", true)`);
  assert.deepEqual([...run("__posts")], [], "a sent link is never edited");
  assert.equal(el("m-share-copy").textContent, "Make new link");
  assert.ok(hidden("m-share-out"), "the old URL is not offered beside choices it does not carry");
  assert.ok(hidden("m-share-native"));
  assert.match(el("m-share-foot").textContent, /earlier choices[\s\S]*stops working/);
  assert.ok(!hidden("m-share-revoke"), "the live link can still be turned off");
  await run(`setShare("route", false)`);
  assert.equal(el("m-share-copy").textContent, "Copy link", "back to the live link's choices: it is offered again");
  assert.ok(!hidden("m-share-out"));
  delete ctx.navigator.share;
});

await t("Make new link publishes the screen's choices as a new link, with no edit flag, and says the old one stops", async () => {
  live();
  run(`api = async (p, body) => { __bodies.push({ ...body }); return { url: ${JSON.stringify(URL_NEW)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };`);
  await run(`setShare("recipient", "hidden")`);
  await el("m-share-copy").onclick();
  assert.equal(run("__bodies.length"), 1);
  assert.equal(run("__bodies[0].edit"), undefined, "a create, never an edit");
  assert.equal(run("__bodies[0].recipient"), "hidden");
  assert.equal(run("mShare.link"), URL_NEW);
  assert.equal(el("m-share-url").textContent, URL_NEW);
  assert.equal(el("m-share-copy").textContent, "Copy link");
  assert.match(run("__said"), /old link no longer works/);
  assert.doesNotMatch(readFileSync(path.join(PUB, "app/transactions.js"), "utf8"), /edit: true/, "the composer never sends an edit");
});

await t("a new link Zold refuses leaves the live link as it was and says so", async () => {
  live();
  el("m-share-err").classList.add("hidden");
  run(`api = async () => { throw Object.assign(new Error("that choice is not allowed"), { status: 422, fromZold: true }); };`);
  await run(`setShare("route", true)`);
  await el("m-share-copy").onclick();
  assert.equal(run("mShare.link"), URL_R, "the live link is unchanged");
  assert.equal(run("mShare.published.route"), false);
  assert.equal(run("mShare.loaded"), true);
  assert.ok(!hidden("m-share-err"));
  assert.match(el("m-share-err").textContent, /that choice is not allowed/);
  assert.equal(el("m-share-copy").textContent, "Make new link", "the choices stay for another try");
});

/* The route writes before it replies, so an answer that never arrived (or a
   gateway's 5xx) says nothing about which link is live. */
await t("a new link whose reply is lost re-reads which link is live and shows it", async () => {
  live();
  el("m-share-err").classList.add("hidden");
  run(`__gets = 0; api = async (p, body, method) => {
      if (method === "GET") { __gets++; return { url: ${JSON.stringify(URL_NEW)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { ...SHARE_DEFAULTS, route: true } }; }
      throw Object.assign(new Error("bad gateway"), { status: 502, fromZold: false }); };`);
  await run(`setShare("route", true)`);
  await el("m-share-copy").onclick();
  assert.equal(run("__gets"), 1);
  assert.equal(run("mShare.loaded"), true);
  assert.equal(run("mShare.link"), URL_NEW, "the new link the server made is the one offered");
  assert.equal(run("mShare.fields.route"), true);
  assert.equal(el("m-share-copy").textContent, "Copy link");
  assert.match(el("m-share-err").textContent, /link that is live/);
});

await t("a lost reply whose re-read fails keeps the composer locked and offers no link", async () => {
  ctx.navigator.share = async () => {};
  live();
  run(`api = async () => { throw Object.assign(new Error("offline"), { offline: true }); };`);
  await run(`setShare("route", true)`);
  await el("m-share-copy").onclick();
  assert.equal(run("mShare.loaded"), false);
  assert.match(el("m-share-err").textContent, /could not confirm which link is live/i);
  assert.ok(hidden("m-share-out"));
  assert.equal(el("m-share-url").textContent, "");
  assert.ok(hidden("m-share-native"));
  assert.equal(el("m-share-copy").disabled, true);
  for (const c of el("m-share-groups").innerHTML.match(/<input type="radio"[^>]*>/g) || []) assert.match(c, / disabled[ >/]/);
  assert.match(el("m-share-foot").textContent, /not confirmed/i);
  assert.doesNotMatch(el("m-share-foot").textContent, /^Live/);
  delete ctx.navigator.share;
});

await t("Turn this link off is refused while a new link is being made", async () => {
  live();
  run(`__gate = new Promise((r) => { __release = r; });
    api = async (p, body, method) => { if (method === "DELETE") { __dels++; return {}; } await __gate; return { url: ${JSON.stringify(URL_NEW)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };`);
  await run(`setShare("route", true)`);
  const making = el("m-share-copy").onclick();
  assert.equal(el("m-share-revoke").disabled, true);
  await el("m-share-revoke").onclick();
  assert.equal(run("__dels"), 0, "no turn-off that could land before the new link");
  run("__release()");
  await making;
  assert.equal(run("mShare.link"), URL_NEW);
  assert.equal(el("m-share-revoke").disabled, false);
});

await t("a new link for receipt A that lands after receipt B opened leaves B's link and choices alone", async () => {
  run(`openShare = __realOpenShare; mobileNav = () => {};`);
  live(`, transferId: "tA"`);
  run(`__gateA = new Promise((r) => { __releaseA = r; });
    api = async (p, body, method) => {
      if (method === "GET") return { url: ${JSON.stringify(URL_B)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { recipient: "hidden" } };
      await __gateA; return { url: ${JSON.stringify(URL_NEW)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };`);
  await run(`setShare("route", true)`);
  const making = el("m-share-copy").onclick();
  run(`openShare("tB")`);
  await run("renderShareScreen()");
  run("__releaseA()");
  await making;
  assert.equal(run("mShare.transferId"), "tB");
  assert.equal(run("mShare.link"), URL_B, "B still offers its own link");
  assert.equal(el("m-share-url").textContent, URL_B);
  assert.equal(run("mShare.fields.recipient"), "hidden", "B's choices are not A's");
  assert.equal(run("mShare.fields.route"), false);
});

await t("turning receipt A's link off leaves receipt B locked until B's own choices load", async () => {
  run(`openShare = __realOpenShare; mobileNav = () => {}; __posts = [];
    __delA = new Promise((r) => { __releaseDel = r; }); __getB = new Promise((r) => { __releaseGetB = r; });
    api = async (p, body, method) => {
      if (method === "DELETE") { await __delA; return {}; }
      if (method === "GET") { await __getB; return { url: ${JSON.stringify(URL_B)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { recipient: "hidden" } }; }
      __posts.push({ p, body }); return { url: ${JSON.stringify(URL_B)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };
    mShare = { transferId: "tA", fields: { ...SHARE_DEFAULTS }, published: { ...SHARE_DEFAULTS }, link: ${JSON.stringify(URL_R)}, expiresAt: ${JSON.stringify(EXPIRES)}, expired: false, busy: false, loaded: true, revokes: 0 };`);
  const revoking = el("m-share-revoke").onclick();
  run(`openShare("tB")`);
  const loadingB = run("renderShareScreen()");
  run("__releaseDel()");
  await revoking;
  assert.equal(run("mShare.transferId"), "tB");
  assert.equal(run("mShare.loaded"), false, "A's reply does not unlock B");
  assert.equal(el("m-share-copy").disabled, true);
  run("announce = () => {};");
  await el("m-share-copy").onclick();
  assert.equal(run("__posts.length"), 0, "Create link sends nothing for B yet");
  run("__releaseGetB()");
  await loadingB;
  assert.equal(run("mShare.loaded"), true);
  assert.equal(run("mShare.link"), URL_B, "B keeps its live link");
  assert.equal(run("mShare.fields.recipient"), "hidden", "with B's choices");
});

/* A new link's reply is lost, so the composer re-reads which link is live.
   The sender turns the link off before that read answers: the read started
   while a link was on, so its URL is a revoked one and must not be offered. */
await t("a confirmation read that lands after Turn this link off does not offer the revoked link", async () => {
  live();
  run(`__getGate = new Promise((r) => { __releaseGet = r; }); __gets = 0;
    api = async (p, body, method) => {
      if (method === "DELETE") return {};
      if (method === "GET") { __gets++; await __getGate; return { url: ${JSON.stringify(URL_NEW)}, expiresAt: ${JSON.stringify(EXPIRES)}, fields: { ...SHARE_DEFAULTS } }; }
      throw Object.assign(new Error("Zold’s answer didn’t arrive."), { offline: true }); };`);
  el("m-share-err").classList.add("hidden");
  await run(`setShare("route", true)`);
  const making = el("m-share-copy").onclick();
  for (let i = 0; i < 20 && run("__gets") === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(run("__gets"), 1, "(the confirmation read is waiting)");
  await el("m-share-revoke").onclick();
  run("__releaseGet()");
  await making;
  assert.equal(run("mShare.link"), null, "the revoked link is not brought back");
  assert.ok(hidden("m-share-out"));
  assert.equal(el("m-share-url").textContent, "");
  assert.equal(el("m-share-copy").textContent, "Create link");
  assert.doesNotMatch(el("m-share-err").textContent, /link that is live/, "nothing claims a live link");
  run("hist.length = 0;");
});

/* A change tapped while Create link is in flight would be undone by the
   create's answer (the screen adopts what was published). The choices are
   locked until the link exists instead. */
await t("while Create link is in flight the choices are locked, and the link carries what the screen shows", async () => {
  run(`__createGate = new Promise((r) => { __releaseCreate = r; }); __posts = [];
    api = async (p, body) => { __posts.push({ ...body }); await __createGate; return { url: "https://zold.test/r/fresh-slug-xyz", expiresAt: ${JSON.stringify(EXPIRES)}, fields: body }; };
    announce = () => {};
    mShare = { transferId: "t1", fields: { ...SHARE_DEFAULTS }, published: null, link: null, expiresAt: null, expired: false, busy: false, loaded: true, revokes: 0 };
    paintShare();`);
  const creating = el("m-share-copy").onclick();
  for (const c of el("m-share-groups").innerHTML.match(/<input type="radio"[^>]*>/g) || []) assert.match(c, / disabled[ >/]/, `${c} is locked while creating`);
  for (const c of el("m-share-toggles").innerHTML.match(/<button [^>]*role="switch"[^>]*>/g) || []) assert.match(c, / disabled[ >/]/);
  assert.equal(el("m-share-copy").disabled, true);
  await run(`setShare("recipient", "hidden")`);
  assert.equal(run("mShare.fields.recipient"), run("SHARE_DEFAULTS.recipient"), "a tap while creating changes nothing");
  run("__releaseCreate()");
  await creating;
  assert.equal(run("__posts.length"), 1);
  assert.equal(run("mShare.fields.recipient"), run("__posts[0].recipient"), "the screen shows what the link was created with");
  for (const c of el("m-share-groups").innerHTML.match(/<input type="radio"[^>]*>/g) || []) assert.doesNotMatch(c, / disabled[ >/]/);
  assert.equal(el("m-share-copy").disabled, false);
});

console.log(`\nSHARE LINK UI TEST PASSED — ${pass}/${pass}`);
