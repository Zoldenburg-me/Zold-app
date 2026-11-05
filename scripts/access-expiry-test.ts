/**
 * An /api answer Zold did not write (Cloudflare Access on app.zoldhq.com, once
 * its session has expired) reloads the page once, so the gate can show its
 * login, and never signs the person out. Zold's own 401 still lands on sign-in.
 *
 * Runs the real scripts with a stubbed fetch: /app's classic scripts in a vm,
 * /business's modules on this global. Access itself is not exercised.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");
const read = (f: string) => readFileSync(path.join(PUB, f), "utf8");

const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : stub),
  set: () => true,
  apply: () => stub,
});
const store = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
};

const response = (status: number, body: string, type: string | null, extra: object = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  type: "basic",
  headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? type : null) },
  json: async () => JSON.parse(body),
  text: async () => body,
  ...extra,
});
const HTML = "<!doctype html><title>Sign in</title>";
const FOREIGN: Record<string, () => any> = {
  "a 401 with an HTML page": () => response(401, HTML, "text/html"),
  "a 401 with no body": () => response(401, "", null),
  "a 401 with JSON that has no error": () => response(401, "{}", "application/json"),
  "a 403 with an HTML page": () => response(403, HTML, "text/html"),
  "a 200 with an HTML page": () => response(200, HTML, "text/html"),
  "an opaque redirect": () => response(0, "", null, { type: "opaqueredirect" }),
};
const zold401 = () => response(401, JSON.stringify({ error: "session expired" }), "application/json; charset=utf-8");

const PENDING = Symbol("pending");
const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then((v) => ({ value: v }), (e) => ({ error: e })),
    new Promise((r) => setTimeout(() => r(PENDING), 20)),
  ]);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── /app ───────────────────────────────────────────────────────────────────
let answer: () => any = zold401;
let reloads = 0;
// The 5 s wait for a reload that the page may refuse: held, so a test decides when it ends.
const held: (() => void)[] = [];
const holdingTimeout = (real: typeof setTimeout) => (fn: () => void, ms?: number) => (ms === 5000 ? (held.push(fn), 0) : real(fn, ms));
const endGateWaits = () => { for (const fn of held.splice(0)) fn(); };
const calls: any[] = [];
const ctx: any = {
  console, setTimeout: holdingTimeout(setTimeout), clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  AbortController,
  addEventListener() {}, removeEventListener() {}, scrollTo() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, onLine: true },
  location: { pathname: "/app", search: "", hash: "", href: "http://test/app", assign() {}, replace() {}, reload: () => { reloads++; } },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: async (url: string, init: any) => { calls.push({ url, init }); return answer(); },
  document: {
    hidden: false,
    getElementById: () => stub, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => stub, body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of [
  "ui.js", "app/core.js", "app/dashboard.js", "app/transactions.js", "app/profile.js", "app/recovery.js", "app/monerium.js",
  "app/onboarding.js", "app/send.js", "app/signers.js", "app/phone.js", "app/phone-home.js", "app/phone-activity.js",
  "app/phone-send.js", "app/phone-add.js", "app/phone-getpaid.js", "app/phone-more.js", "app/settings.js", "app/desktop.js",
  "app/errors.js",
]) vm.runInContext(read(f), ctx, { filename: f });
const run = (code: string) => vm.runInContext(code, ctx);

/** A fresh page load: new script state (the in-page flag) over the same tab's sessionStorage. */
function reloadUi() {
  vm.runInContext(read("ui.js"), ctx, { filename: "ui.js" });
  run(`Z = window.Z;`);
}
function freshTab() {
  ctx.sessionStorage.clear();
  ctx.document.activeElement = null;
  held.length = 0;
  ctx.localStorage.setItem("zold-session", "tok");
  run(`sessionToken = "tok";`);
  reloads = 0;
  reloadUi();
}
// What resumeSession ends on, without drawing the real screens.
let landed: string | null = null;
run(`obSocialReturn = async () => {}; obStart = () => globalThis.__land("sign-in"); errShow = (k) => globalThis.__land("state:" + k);`);
ctx.__land = (where: string) => { landed = where; };
const resume = () => { landed = null; return run(`resumeSession(Promise.resolve())`); };
const sessionKept = () => ctx.localStorage.getItem("zold-session") === "tok" && run(`sessionToken`) === "tok";

for (const [name, foreign] of Object.entries(FOREIGN)) {
  await check(`/app: ${name} reloads once and keeps the session; the next load does not reload again`, async () => {
    freshTab();
    answer = foreign;
    assert.equal(await settled(resume()), PENDING, "nothing paints while the reload runs");
    assert.equal(reloads, 1);
    assert.equal(landed, null);
    assert.ok(sessionKept());

    // The gate let the page through and still answers /api: no loop, and a screen.
    reloadUi();
    await resume();
    assert.equal(reloads, 1, "no second reload");
    assert.equal(landed, "state:offline");
    assert.ok(sessionKept());
  });
}

await check("/app: every call asks not to follow redirects, or a cross-origin login reads as offline", async () => {
  freshTab();
  answer = zold401;
  calls.length = 0;
  await run(`api("/api/session")`).catch(() => {});
  assert.equal(calls[0].init.redirect, "manual");
});

await check("/app: calls in flight at the same moment reload once, and none of them throws", async () => {
  freshTab();
  answer = FOREIGN["an opaque redirect"];
  const all = await Promise.all([settled(run(`api("/api/session")`)), settled(run(`api("/api/orgs")`))]);
  assert.deepEqual(all, [PENDING, PENDING]);
  assert.equal(reloads, 1);
});

await check("/app: a minute later a new expiry reloads again", async () => {
  freshTab();
  ctx.sessionStorage.setItem("zold-gate-reload", `1:${Date.now() - 61000}`);
  answer = FOREIGN["an opaque redirect"];
  assert.equal(await settled(run(`api("/api/session")`)), PENDING);
  assert.equal(reloads, 1);
});

await check("/app: with no sessionStorage it cannot count reloads, so it does not reload", async () => {
  freshTab();
  const real = ctx.sessionStorage;
  ctx.sessionStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  answer = FOREIGN["an opaque redirect"];
  const got: any = await settled(run(`api("/api/session")`));
  ctx.sessionStorage = real;
  assert.equal(reloads, 0);
  assert.equal(got.error?.offline, true);
});

const opaque = FOREIGN["an opaque redirect"];
const unspent = () => ctx.sessionStorage.getItem("zold-gate-reload") === null;

await check("/app: a poll waits while a write is on its way: no reload, guard unspent, and the next poll reloads", async () => {
  freshTab();
  let answerWrite: (r: any) => void = () => {};
  answer = () => new Promise((r) => { answerWrite = r; });
  const write = run(`api("/api/transfers/t1/authorize", { sig: "x" })`);
  await new Promise((r) => setTimeout(r, 5));
  answer = opaque;
  const poll: any = await settled(run(`api("/api/session")`));
  assert.equal(poll.error?.offline, true, "the poll fails as offline");
  assert.equal(reloads, 0, "the write's answer is not thrown away");
  assert.ok(unspent());
  answerWrite(response(200, "{}", "application/json"));
  await write;
  assert.equal(await settled(run(`api("/api/session")`)), PENDING);
  assert.equal(reloads, 1);
});

await check("/app: a foreign answer to a write never reloads, and says to check first", async () => {
  freshTab();
  for (const name of ["a 403 with an HTML page", "a 200 with an HTML page", "an opaque redirect"]) {
    answer = FOREIGN[name];
    const e: any = await run(`api("/api/orgs", { name: "x" })`).catch((x: any) => x);
    assert.match(e.message, /check before you try it again/);
    assert.equal(e.offline, true);
  }
  assert.equal(reloads, 0);
  assert.ok(unspent());
});

await check("/app: an open passkey prompt holds the reload until it closes", async () => {
  freshTab();
  let close: () => void = () => {};
  run(`Z`).holdReload(new Promise<void>((r) => { close = r; }));
  answer = opaque;
  assert.equal(((await settled(run(`api("/api/session")`))) as any).error?.offline, true);
  assert.equal(reloads, 0);
  assert.ok(unspent());
  close();
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(await settled(run(`api("/api/session")`)), PENDING);
  assert.equal(reloads, 1);
});

await check("/app: every passkey prompt site holds the reload", async () => {
  assert.match(read("app/core.js"), /Z\.holdReload\(prompt\)/);
  const device = read("device.js");
  assert.equal(device.match(/navigator\.credentials\.get\(/g)?.length, 1, "device.js has one way to ask");
  assert.match(device, /holdReload\?\.\(prompt\)/);
});

await check("/app: a poll while someone types does not reload; once they leave the field it does", async () => {
  freshTab();
  ctx.document.activeElement = { closest: (s: string) => (s.includes("input") ? {} : null) };
  answer = opaque;
  assert.equal(((await settled(run(`api("/api/session")`))) as any).error?.offline, true);
  assert.equal(reloads, 0);
  ctx.document.activeElement = { closest: () => null };
  assert.equal(await settled(run(`api("/api/session")`)), PENDING);
  assert.equal(reloads, 1);
});

await check("/app: a failed check shows the offline bar's state, so frozen numbers are explained", async () => {
  freshTab();
  ctx.document.activeElement = { closest: () => ({}) };
  answer = opaque;
  const seen: boolean[] = [];
  ctx.__seen = (on: boolean) => seen.push(on);
  run(`{ const real = setReachable; setReachable = (on) => { globalThis.__seen(on); real(on); }; }`);
  await run(`api("/api/session")`).catch(() => {});
  assert.deepEqual(seen, [false]);
});

await check("/app: if the page refuses to leave, the call ends in an offline error and later calls do not hang", async () => {
  freshTab();
  answer = opaque;
  const first = run(`api("/api/session")`);
  assert.equal(await settled(first), PENDING);
  assert.equal(reloads, 1, "location.reload() ran, and the person clicked Stay");
  endGateWaits();
  assert.equal(((await settled(first)) as any).error?.offline, true);
  const later: any = await settled(run(`api("/api/session")`));
  assert.equal(later.error?.offline, true, "inside the minute: an answer, not a hang");
  answer = () => response(200, "{}", "application/json");
  await run(`api("/api/session")`);
});

await check("/app: three reloads an hour at most, and Zold answering some paths does not reset that", async () => {
  freshTab();
  answer = opaque;
  const later = (ms: number) => {
    const [n, at] = (ctx.sessionStorage.getItem("zold-gate-reload") || "0:0").split(":");
    if (n !== "0") ctx.sessionStorage.setItem("zold-gate-reload", `${n}:${Number(at) - ms}`);
  };
  for (let minute = 0; minute < 10; minute++) {
    reloadUi();
    later(61000);
    answer = () => response(200, "{}", "application/json");
    await run(`api("/api/health")`);
    answer = opaque;
    void run(`api("/api/session")`).catch(() => {});
    await new Promise((r) => setTimeout(r, 2));
    endGateWaits();
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(reloads, 3);

  reloadUi();
  later(3600000);
  assert.equal(await settled(run(`api("/api/session")`)), PENDING);
  assert.equal(reloads, 4, "an hour later a new expiry gets its reload");
});

for (const status of [404, 429]) {
  await check(`/app: an HTML ${status} at start-up keeps the session and draws a screen`, async () => {
    freshTab();
    answer = () => response(status, HTML, "text/html");
    await resume();
    assert.equal(reloads, 0);
    assert.equal(landed, "state:error");
    assert.ok(sessionKept());
  });
}

await check("/app: Zold's own 401 lands on sign-in with no reload", async () => {
  freshTab();
  answer = zold401;
  await resume();
  assert.equal(reloads, 0);
  assert.equal(landed, "sign-in");
  assert.equal(ctx.localStorage.getItem("zold-session"), null);
});

await check("/app: a proxy's HTML 502 and a 204 are not reloads", async () => {
  freshTab();
  answer = () => response(502, HTML, "text/html");
  const e: any = await run(`api("/api/session")`).catch((x: any) => x);
  assert.equal(e.status, 502);
  answer = () => response(204, "", null);
  await run(`api("/api/session")`);
  assert.equal(reloads, 0);
});

await check("/app: a service worker offline 503 is not a reload", async () => {
  freshTab();
  answer = () => ({
    ...response(503, JSON.stringify({ error: "offline" }), "application/json"),
    headers: { get: (k: string) => ({ "content-type": "application/json", "x-zold-offline": "1" } as any)[k.toLowerCase()] ?? null },
  });
  await resume();
  assert.equal(reloads, 0);
  assert.equal(landed, "state:offline");
  assert.ok(sessionKept());
});

// ── /business ──────────────────────────────────────────────────────────────
const g: any = globalThis;
const shown: Record<string, { classList: { remove: () => void }; remove: () => void; hidden: boolean; gone: boolean }> = {};
const section = (id: string) => (shown[id] ||= {
  hidden: true, gone: false,
  classList: { remove() { shown[id].hidden = false; } },
  remove() { shown[id].gone = true; },
});
let bizReloads = 0;
let bizAnswer: (url?: string) => any = zold401;
const bizInits: any[] = [];
const ls = store();
const ss = store();
ls.setItem("zold-session", "tok");
Object.assign(g, {
  window: g, localStorage: ls, sessionStorage: ss,
  setTimeout: holdingTimeout(setTimeout),
  requestAnimationFrame: (fn: () => void) => fn(),
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  history: { pushState() {}, replaceState() {}, state: null },
  location: { pathname: "/business", search: "", hash: "", href: "http://test/business", reload: () => { bizReloads++; } },
  document: {
    hidden: false, title: "",
    querySelector: (s: string) => (["#signed-out", "#no-answer", "#no-orgs", "#app"].includes(s) ? section(s) : s === "#toast" ? stub : null),
    getElementById: () => null, querySelectorAll: () => [], createElement: () => stub, body: stub, documentElement: stub,
    addEventListener() {},
  },
  fetch: async (url: string, init: any) => {
    bizInits.push(init);
    return url === "/api/health" ? response(200, "{}", "application/json") : bizAnswer(url);
  },
});
Object.defineProperty(g, "navigator", { value: { userAgent: "test", language: "en", maxTouchPoints: 0, onLine: true }, configurable: true });
// business/core.js keeps the Z it imports with, so a "new page load" swaps what this one points at.
let realZ: any;
const bizLoadUi = () => {
  vm.runInThisContext(read("ui.js"), { filename: "ui.js" });
  realZ = g.Z;
  g.Z = new Proxy({}, { get: (_t, k) => realZ[k] });
};
bizLoadUi();
const biz = (f: string) => pathToFileURL(path.join(PUB, "business", f)).href;
await import(biz("core.js"));
const shell = await import(biz("shell.js"));

function bizFresh() {
  ss.clear();
  bizReloads = 0;
  for (const k of Object.keys(shown)) delete shown[k];
  bizLoadUi();
}
const visible = () => Object.keys(shown).filter((k) => !shown[k].hidden);

for (const [name, foreign] of Object.entries(FOREIGN)) {
  await check(`/business: ${name} reloads once, and the next load draws a screen, not nothing`, async () => {
    bizFresh();
    bizAnswer = foreign;
    assert.equal(await settled(shell.boot()), PENDING);
    assert.equal(bizReloads, 1);
    assert.deepEqual(visible(), []);

    bizLoadUi();
    await shell.boot();
    assert.equal(bizReloads, 1, "no second reload");
    assert.deepEqual(visible(), ["#no-answer"]);
  });
}

await check("/business: Zold's own 401 is the signed-out screen, with no reload", async () => {
  bizFresh();
  bizAnswer = zold401;
  await shell.boot();
  assert.equal(bizReloads, 0);
  assert.deepEqual(visible(), ["#signed-out"]);
});

await check("/business: every call asks not to follow redirects", async () => {
  assert.ok(bizInits.length > 0);
  assert.ok(bizInits.every((i) => i.redirect === "manual"));
});

await check("/business: the organisation list arrives, then the organisation fails: a screen, not an empty page", async () => {
  for (const fail of [() => response(502, HTML, "text/html"), () => { throw new TypeError("Failed to fetch"); }]) {
    bizFresh();
    bizAnswer = (url) => (url === "/api/orgs"
      ? response(200, JSON.stringify({ organisations: [{ id: "o1", type: "business", role: "owner", name: "A" }] }), "application/json")
      : url === "/api/orgs/o1" ? fail() : response(200, "{}", "application/json"));
    await shell.boot();
    assert.deepEqual(visible(), ["#no-answer"]);
  }
});

await check("/business: a server that does not answer draws a screen too", async () => {
  bizFresh();
  bizAnswer = () => response(502, HTML, "text/html");
  await shell.boot();
  assert.equal(bizReloads, 0);
  assert.deepEqual(visible(), ["#no-answer"]);
});

console.log(`access expiry: ${passed} checks passed`);
process.exit(0);
