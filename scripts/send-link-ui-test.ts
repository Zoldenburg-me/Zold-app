/**
 * The app's bank payment for a send link, with a Zold fee: the link names what
 * arrives, so the prefilled debit is raised by the fee once and priced again,
 * the second quote delivers exactly the link amount, a raised debit over the
 * balance is refused before pricing, and an amount that delivers anything else
 * is refused before the debit. Around it: the "already sent" note is per person,
 * only the links this person made are offered, and an unreadable account list
 * says so instead of loading forever.
 *
 * Runs the real classic scripts in load order with a stub DOM. Offline.
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

const IBAN = "DE89370400440532013000";
const PAYEE_IBAN = "FR1420041010050500013M02606";
run(`refresh = () => {}; phGo = () => {}; Z = { ...Z, announce() {} };`);

/** A stub element: enough of the DOM for the bind code under test. */
const el = (extra: any = {}) => {
  const attrs = new Map<string, string>();
  const span = { textContent: "" };
  return { value: "", hidden: true, textContent: "", innerHTML: "", span, focus() {}, querySelector: () => span,
    setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null, ...extra };
};

/** A €11.45 link to pay, a SEPA fee of `fee`, and `balance` in the account. Binds the amount screen. */
const open = async (fee: number | number[], balance: number) => {
  const fees = JSON.stringify(Array.isArray(fee) ? fee : [fee]);
  run(`user = { id: "u1", kycStatus: "approved", iban: "${IBAN}", balanceEur: ${balance} };
    __quotes = []; __calls = [];
    api = async (p, b) => {
      __calls.push([p, b]);
      if (p !== "/api/quotes") throw new Error("unexpected call " + p);
      __quotes.push(b.sendEur);
      const fees = ${fees}, fee = fees[Math.min(__quotes.length, fees.length) - 1];
      return { id: "q" + __quotes.length, sendEur: b.sendEur, fixedFeeEur: fee, receiveEur: Math.round((b.sendEur - fee) * 100) / 100 };
    };
    phSend = { payee: { name: "Ana Lima", iban: "${PAYEE_IBAN}" }, amount: "11.45", reference: "Dinner", quote: null, transferId: null, error: null,
      sendLink: { orgId: "o1", id: "inv1", cents: 1145, iban: "${PAYEE_IBAN}", address: "" } };`);
  const input = el({ value: "11.45" }), next = el(), err = el(), quote = el(), ref = el(), form = el();
  const nodes: Record<string, any> = { "#ph-amount": input, "#ph-amt-next": next, "#ph-amount-err": err, "#ph-quote": quote, "#ph-ref": ref, "#ph-amt": form };
  run(`PH["send/amount"]`).bind({ querySelector: (s: string) => nodes[s] ?? el() }, "new");
  await new Promise((r) => setTimeout(r, 10));
  return { input, next, err, quote };
};

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("with a €0.99 fee, the €11.45 link is debited €12.44 and the quote delivers exactly €11.45", async () => {
  const { input, next, err, quote } = await open(0.99, 50);
  assert.deepEqual([...run(`__quotes`)], [11.45, 12.44], "priced once as filled in, then once with the fee added");
  assert.equal(input.value, "12.44");
  assert.equal(run(`phSend.amount`), "12.44");
  assert.equal(run(`phSend.quote.id`), "q2", "the second quote is the one reviewed");
  assert.equal(run(`phSend.quote.receiveEur`), 11.45);
  assert.equal(run(`Math.round(phSend.quote.receiveEur * 100)`), 1145);
  assert.match(quote.innerHTML, /11\.45/);
  assert.equal(next.span.textContent, "Review");
  assert.equal(next.getAttribute("aria-disabled"), null);
  assert.equal(err.hidden, true);
  run(`phSendLinkMatches(phSend.sendLink, { cents: Math.round(phSend.quote.receiveEur * 100), iban: phSend.payee.iban })`);
});

await t("when the raised debit is more than the balance, it is refused before a second quote", async () => {
  const { input, next, err } = await open(0.99, 12);
  assert.deepEqual([...run(`__quotes`)], [11.45], "no quote for the raised amount");
  assert.equal(input.value, "12.44");
  assert.equal(run(`phSend.quote`), null, "nothing to review");
  assert.equal(next.span.textContent, "More than your balance");
  assert.equal(next.getAttribute("aria-disabled"), "true");
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /You have €12\.00/);
});

await t("with no fee, the link amount is priced once and left as it is", async () => {
  const { input, next } = await open(0, 50);
  assert.deepEqual([...run(`__quotes`)], [11.45]);
  assert.equal(input.value, "11.45");
  assert.equal(run(`phSend.quote.receiveEur`), 11.45);
  assert.equal(next.span.textContent, "Review");
});

await t("a quote that delivers less than the link asks is refused before anything is created", async () => {
  await open(0.99, 50);
  run(`phSend.quote = { id: "q9", sendEur: 11.45, fixedFeeEur: 0.99, receiveEur: 10.46 }; __calls = [];`);
  const btn = el(), errEl = el();
  await run(`phSubmit`)(btn, errEl);
  assert.equal(errEl.hidden, false);
  assert.match(errEl.textContent, /This link asks for €11\.45 to arrive/);
  assert.match(errEl.textContent, /Nothing was sent/);
  assert.equal(run(`__calls.length`), 0, "no transfer was created");
});

await t("a fee that changed between the two quotes leaves Review off, with the reason", async () => {
  const { input, next, err, quote } = await open([0.99, 1.5], 50);
  assert.deepEqual([...run(`__quotes`)], [11.45, 12.44], "raised once, not chased");
  assert.equal(input.value, "12.44");
  assert.equal(run(`phSend.quote`), null, "nothing to review");
  assert.equal(next.span.textContent, "Not what the link asks");
  assert.equal(next.getAttribute("aria-disabled"), "true");
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /asks for €11\.45 to arrive, and this amount gets €10\.94 there/);
  assert.match(quote.innerHTML, /10\.94/, "what would arrive is still shown");
});

await t("a payment noted as sent for a link is kept per person on this device", () => {
  run(`localStorage.clear(); user = { id: "u1" }; phSendLinkPaidStore("inv1", { orgId: "o1", payment: { transferId: "t1" } })`);
  assert.ok(run(`localStorage.getItem("zold-send-link-paid:u1")`));
  run(`user = { id: "u2" }`);
  assert.deepEqual(JSON.parse(run(`JSON.stringify(phSendLinkPaid())`)), {}, "another account does not see it");
  run(`phSendLinkPaidStore("inv9", null)`);
  run(`user = { id: "u1" }`);
  assert.deepEqual(Object.keys(run(`phSendLinkPaid()`)), ["inv1"], "and cannot erase it");
  run(`user = null; phSendLinkPaidStore("inv2", { orgId: "o1" })`);
  assert.equal(run(`localStorage.getItem("zold-send-link-paid:")`), null, "signed out, nothing is kept");
});

await t("only the links this person made are listed to pay", async () => {
  run(`localStorage.clear(); user = { id: "u1" }; phSendLinksLoading = null; phCache.sendLinks = undefined;
    phLoadOrgs = async () => {};
    phCache.orgs = [{ id: "o1", type: "personal", memberId: "m1", capabilities: { invoices: { allowed: true } } }];
    api = async () => ({ invoices: [
      { id: "a", sendLink: {}, createdByMemberId: "m1", state: "SUBMITTED", total: "5.00" },
      { id: "b", sendLink: {}, createdByMemberId: "m2", state: "SUBMITTED", total: "6.00" },
      { id: "c", createdByMemberId: "m1", state: "SUBMITTED", total: "7.00" },
    ] });`);
  await run(`phLoadSendLinks()`);
  assert.deepEqual(JSON.parse(run(`JSON.stringify(phCache.sendLinks.list.map((i) => i.id))`)), ["a"]);
});

await t("when the account list cannot be read, the send-link screens say so instead of loading forever", async () => {
  run(`phSendLinksLoading = null; phCache.sendLinks = undefined; phLoadOrgs = async () => { throw new Error("offline"); };`);
  await run(`phLoadSendLinks()`);
  assert.equal(run(`phCache.sendLinks.error`), true);
  const html = run(`PH["send/link"].html("new")`).replace(/\s+/g, " ");
  assert.match(html, /could not be read just now/);
  assert.doesNotMatch(html, /Set up your personal space/);
  assert.doesNotMatch(html, /Loading/);
});

const LINKS = `[
  { id: "w", sendLink: { maxTotal: "20.00", note: "Taxi" }, createdByMemberId: "m1", state: "LINK_CREATED", total: "0.00", createdAt: "2026-11-12T08:00:00Z" },
  { id: "f", sendLink: { maxTotal: "13.00" }, createdByMemberId: "m1", state: "SUBMITTED", total: "11.45", supplier: { orgName: "Bob Example" }, lines: [{ description: "Dinner" }], createdAt: "2026-11-12T09:00:00Z" },
  { id: "p", sendLink: { maxTotal: "9.00" }, createdByMemberId: "m1", state: "PAID", total: "8.00", supplier: { orgName: "Cleo" }, lines: [{ description: "Cake" }], createdAt: "2026-11-11T09:00:00Z" },
]`;
const withLinks = async (list: string) => {
  run(`localStorage.clear(); user = { id: "u1", kycStatus: "approved", iban: "${IBAN}" }; phSendLinksLoading = null; phCache.sendLinks = undefined;
    phLoadOrgs = async () => {};
    phCache.orgs = [{ id: "o1", type: "personal", memberId: "m1", capabilities: { invoices: { allowed: true } } }];
    __reads = 0; api = async () => { __reads++; return { invoices: ${list} }; };`);
  await run(`phLoadSendLinks()`);
};

await t("the Send screen lists every send link this person made, newest first, with its state", async () => {
  await withLinks(LINKS);
  const html = run(`PH.send.html()`).replace(/\s+/g, " ");
  assert.match(html, /Your send links/);
  const order = ["Bob Example", "Taxi", "Cleo"].map((x) => html.indexOf(x));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], `newest first: ${order}`);
  assert.match(html, /Ready to pay/);
  assert.match(html, /Waiting for them/);
  assert.match(html, /Up to €20\.00/);
  assert.match(html, /#send\/link\/f/);
});

await t("a filled-in link is on Home at desktop width too, ready to pay", async () => {
  await withLinks(LINKS);
  run(`hist.length = 0; histLoaded = true;`);
  const html = run(`PH.home.desk.html()`).replace(/\s+/g, " ");
  assert.match(html, /Send links to pay/);
  assert.match(html, /Bob Example/);
});

await t("links are read again once the last read is 30 seconds old, so a link filled in elsewhere shows up", async () => {
  await withLinks(LINKS);
  assert.equal(run(`phSendLinksStale()`), false, "fresh after a read");
  run(`phSendLinksAt = Date.now() - 31000`);
  assert.equal(run(`phSendLinksStale()`), true, "old: read again");
  run(`phLoadOrgs = async () => { throw new Error("offline"); }`);
  await run(`phLoadSendLinks()`);
  assert.equal(run(`phSendLinksStale()`), false, "a failed read waits too, or every redraw would read again");
});

await t("a Send screen left open reads stale links again on the 5-second refresh", async () => {
  await withLinks(LINKS);
  run(`phSendLinksAt = Date.now() - 31000; __reads = 0;`);
  run(`PH.send.live()`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run(`__reads`), 1, "the refresh's live() read the links again");
  run(`PH.send.live()`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run(`__reads`), 1, "fresh again: no second read");
});

console.log(`\nsend-link-ui: ${pass} checks passed`);
