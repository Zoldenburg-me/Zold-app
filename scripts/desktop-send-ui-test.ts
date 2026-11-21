/**
 * The desktop send flow (public/app/send.js) after a send that did not
 * complete:
 *  - MANUAL_REVIEW may have a payment in flight, so it never offers
 *    "Send another transfer"; it points to Transactions and support.
 *    REFUNDED and FAILED still do.
 *  - A cancelled passkey after the transfer was created, or a definite 410,
 *    400, 401 or 403 from /authorize (each refused before the claim, and
 *    Zold's own: a proxy's 4xx proves nothing), leaves the quote consumed:
 *    the next send must be priced again, not refused as "quote already
 *    consumed".
 *  - A SEPA payment polled into MANUAL_REVIEW or REFUNDED shows the same
 *    result panel as one that came back that way.
 *  - Any other /authorize failure may have gone out: no new price, no retry.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screen in a browser, or the routes themselves (the 410
 * is covered in redeem-window-test). Offline.
 *
 *   npm run desktop:send:test
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
/* Every element by id is a small real object, so classes, text and click
   handlers can be read back. */
const elements: Record<string, any> = {};
const el = (id: string) => (elements[id] ??= (() => {
  const cls = new Set<string>();
  const attrs = new Map<string, string>();
  return {
    id, value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
    classList: {
      add: (...c: string[]) => c.forEach((x) => cls.add(x)),
      remove: (...c: string[]) => c.forEach((x) => cls.delete(x)),
      toggle: (c: string, on?: boolean) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c), cls.has(c)),
      contains: (c: string) => cls.has(c),
    },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    appendChild() {}, insertAdjacentHTML() {}, scrollIntoView() {}, focus() {},
    querySelectorAll: () => [],
  };
})());
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

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
const hidden = (id: string) => el(id).classList.contains("hidden");

/* ---------- the result panel ---------- */

await t("MANUAL_REVIEW offers Transactions and support, never Send another transfer", () => {
  run(`revealRefund({ state: "REFUNDED", sendEur: 10, error: "refused: no" })`);
  assert.equal(hidden("btn-again"), false, "REFUNDED keeps Send another transfer");
  run(`revealRefund({ state: "MANUAL_REVIEW", sendEur: 10, error: "SEPA: order unconfirmed" })`);
  assert.equal(hidden("btn-again"), true, "a payment in review may be in flight");
  assert.equal(hidden("btn-check-activity"), false);
  assert.match(el("refund-note").innerHTML, /support@zoldhq\.com/);
  assert.doesNotMatch(el("refund-note").innerHTML, /will be contacted/);
  run(`revealRefund({ state: "FAILED", sendEur: 10, error: "payout: refused" })`);
  assert.equal(hidden("btn-again"), false, "a later FAILED result shows it again");
  assert.equal(hidden("btn-check-activity"), true);
});

await t("the page has the Check Transactions button send.js binds", () => {
  assert.match(readFileSync(path.join(PUB, "index.html"), "utf8"), /<button[^>]*id="btn-check-activity"/);
});

for (const state of ["MANUAL_REVIEW", "REFUNDED"]) {
  await t(`a SEPA payment polled into ${state} leaves "Awaiting SEPA settlement" for the result panel`, () => {
    run(`renderSepaResult({ state: "PAYOUT_SUBMITTED", rail: "sepa", sendEur: 10, sepa: { orderId: "o1" } })`);
    assert.equal(hidden("sepa-box"), false);
    el("refund-box").classList.add("hidden");
    run(`renderSepaResult({ state: "${state}", rail: "sepa", sendEur: 10, error: "SEPA: order unconfirmed", sepa: { orderId: "o1" } })`);
    assert.equal(hidden("sepa-box"), true);
    assert.equal(hidden("refund-box"), false);
    assert.equal(hidden("btn-again"), state === "MANUAL_REVIEW");
    if (state === "MANUAL_REVIEW") assert.match(el("refund-note").innerHTML, /support@zoldhq\.com/);
  });
}

await t("Check Transactions opens Transactions and starts a new send from the destination", () => {
  run(`revealRefund({ state: "MANUAL_REVIEW", sendEur: 10, error: "x" }); __views = []; switchView = (v) => __views.push(v); loadTransfers = () => {};`);
  el("step-quote").classList.add("hidden");
  el("btn-check-activity").onclick();
  assert.equal(run("JSON.stringify(__views)"), JSON.stringify(["transactions"]));
  assert.equal(hidden("refund-box"), true);
  assert.equal(hidden("step-progress"), true);
  assert.equal(hidden("step-quote"), false);
  assert.equal(hidden("send-dest"), false);
});

/* ---------- a send that did not complete ---------- */

const AUTH = "0x2222222222222222222222222222222222222222";
const DEST = "0x" + "ab".repeat(32);
const quoteFor = (id: string) => ({ id, rail: "sepa", sendEur: 25, receiveEur: 25, fixedFeeEur: 0, fxRate: 1, effectiveRate: 1 });
const cancelled = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

/** Price q1, fill in the recipient, and answer each call as `answers` says. */
function setUp(answers: { sign?: () => unknown; authorize?: () => unknown }) {
  ctx.__answers = answers;
  ctx.__quotes = [quoteFor("q2"), quoteFor("q3")];
  run(`
    user = { id: "u1", name: "Kim", kycStatus: "approved", passkey: { credentialId: "cred" } };
    dest = DESTS.find((d) => d.code === "EU");
    __calls = [];
    registerDeviceKey = async () => {};
    safeExecutionAssertion = async () => null;
    moneriumRedeemAssertion = async () => null;
    refresh = () => {}; addHistory = () => {}; playTimeline = () => {};
    api = async (p, body) => {
      __calls.push({ path: p, body });
      if (p === "/api/quotes") return __quotes.shift();
      if (p === "/api/transfers") return { id: "t-" + body.quoteId, authorization: { authorizer: "${AUTH}", typedData: { message: { destination: "${DEST}" } } } };
      if (p.endsWith("/authorize")) return __answers.authorize();
      throw new Error("unexpected call " + p);
    };
    selectOption(${JSON.stringify(quoteFor("q1"))});
  `);
  el("rec-name").value = "Erika Mustermann";
  el("rec-iban").value = "DE89370400440532013000";
}
run(`window.__deviceLibReady({
  deviceAddress: async () => "${AUTH}",
  destinationCommitment: () => "${DEST}",
  signTypedData: async () => __answers.sign ? __answers.sign() : "0xabcd",
})`);
const calls = () => JSON.parse(run("JSON.stringify(__calls.map((c) => c.path + (c.body?.quoteId ? ' ' + c.body.quoteId : '')))"));

await t("a passkey cancelled after the transfer was created prices the send again", async () => {
  setUp({ sign: () => { throw cancelled(); } });
  await el("btn-send").onclick();
  assert.deepEqual(calls(), ["/api/transfers q1", "/api/quotes"]);
  assert.equal(run("quote.id"), "q2");
  assert.equal(hidden("send-details"), false, "stays on the details, recipient kept");
  assert.equal(el("rec-iban").value, "DE89370400440532013000");
  assert.match(el("send-err").textContent, /cancelled/);
  assert.match(el("send-err").textContent, /Nothing was sent/);
  assert.match(el("send-err").textContent, /new price/);
  assert.equal(hidden("send-err"), false);
  // Sending again uses the new quote, never the consumed one.
  await el("btn-send").onclick();
  assert.deepEqual(calls().slice(2), ["/api/transfers q2", "/api/quotes"]);
});

await t("a definite 410 from /authorize prices the send again", async () => {
  setUp({ authorize: () => { throw Object.assign(new Error("This approval expired, so this payment was not sent."), { status: 410, fromZold: true }); } });
  await el("btn-send").onclick();
  assert.deepEqual(calls(), ["/api/transfers q1", "/api/transfers/t-q1/authorize", "/api/quotes"]);
  assert.equal(run("quote.id"), "q2");
  assert.match(el("send-err").textContent, /expired/);
  assert.match(el("send-err").textContent, /new price/);
  assert.deepEqual(run("JSON.stringify(__calls[2].body)"), JSON.stringify({ userId: "u1", rail: "sepa", sendEur: 25 }), "same rail and amount");
});

await t("the server answers 400, 401 and 403 on /authorize only before the claim", () => {
  const src = readFileSync(path.join(ROOT, "services/api/src/routes/transfers.ts"), "utf8");
  const afterClaim = src.slice(src.indexOf("store.claimAuthorization(transfer.id)"), src.indexOf("return router;"));
  assert.ok(afterClaim.length > 0);
  assert.doesNotMatch(afterClaim, /status\(40[013]\)/);
});

for (const [status, msg] of [
  [400, "signature required"],
  [401, "That passkey approval did not check out (bad). Start again."],
  [403, "passkey credential does not match this account"],
] as const) {
  await t(`a ${status} from /authorize was refused before the claim: nothing sent, priced again`, async () => {
    setUp({ authorize: () => { throw Object.assign(new Error(msg), { status, fromZold: true }); } });
    await el("btn-send").onclick();
    assert.deepEqual(calls(), ["/api/transfers q1", "/api/transfers/t-q1/authorize", "/api/quotes"]);
    assert.equal(run("quote.id"), "q2");
    assert.doesNotMatch(el("send-err").textContent, /may have gone out/);
    assert.match(el("send-err").textContent, /Nothing was sent/);
    assert.match(el("send-err").textContent, /new price/);
  });
}

for (const [what, err] of [
  ["a 502", () => Object.assign(new Error("Payout failed"), { status: 502 })],
  ["a 409", () => Object.assign(new Error("transfer is PAYOUT_SUBMITTED, expected CREATED"), { status: 409, fromZold: true })],
  ["a 410 Zold did not write (a proxy's)", () => Object.assign(new Error("Gone"), { status: 410, fromZold: false })],
  ["a 403 Zold did not write (a proxy's)", () => Object.assign(new Error("Forbidden"), { status: 403, fromZold: false })],
  ["a lost answer", () => Object.assign(new Error("you appear to be offline. Zold could not be reached"), { offline: true })],
] as const) {
  await t(`${what} from /authorize may have gone out: no new price, check Transactions`, async () => {
    setUp({ authorize: () => { throw err(); } });
    await el("btn-send").onclick();
    assert.deepEqual(calls(), ["/api/transfers q1", "/api/transfers/t-q1/authorize"]);
    assert.equal(run("quote.id"), "q1", "the consumed quote stays: the server refuses a second use");
    assert.match(el("send-err").textContent, /may have gone out/);
    assert.match(el("send-err").textContent, /Transactions/);
  });
}

await t("a failure before the transfer exists keeps the quote: nothing was consumed", async () => {
  setUp({});
  run(`registerDeviceKey = async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); }`);
  await el("btn-send").onclick();
  assert.deepEqual(calls(), []);
  assert.equal(run("quote.id"), "q1");
});

await t("no new price available: back to the destination, saying why", async () => {
  setUp({ sign: () => { throw cancelled(); } });
  ctx.__quotes = [];
  run(`const __api = api; api = async (p, b) => { if (p === "/api/quotes") { __calls.push({ path: p }); throw new Error("no rate, no quote"); } return __api(p, b); }`);
  await el("btn-send").onclick();
  assert.equal(run("quote"), null);
  assert.equal(hidden("send-dest"), false);
  assert.match(el("dest-err").textContent, /cancelled/);
  assert.match(el("dest-err").textContent, /no rate, no quote/);
});

console.log(`\n${pass} desktop send checks passed`);
