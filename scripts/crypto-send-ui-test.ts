/**
 * The app's Send to a crypto wallet: the full resolved address is on screen
 * before anything is signed, Send waits for the "I checked" tick, and the
 * address shown is the one the server is told to pay (confirmedAddress), and
 * once /authorize was sent an unknown outcome allows no second send.
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

const flat = (html: string) => html.replace(/\s+/g, " ");
const ADDR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
run(`user = { id: "u1", kycStatus: "approved", iban: "DE89370400440532013000" }; caps = { ...caps, ensLookup: true, chainId: 8453, cryptoSend: true };
  __calls = []; __went = [];
  phGo = (name, arg) => __went.push(name);
  refresh = () => {};
  safeExecutionAssertion = async (a) => ({ credentialId: "c", authenticatorData: "a", clientDataJSON: "j", signature: "s", from: a.safeExecution.challenge });`);

/** A stub element: enough of the DOM for the bind code under test. */
const el = (extra: any = {}) => {
  const attrs = new Map<string, string>();
  return { value: "", checked: false, hidden: true, textContent: "", dataset: {}, focus() {}, querySelector: () => el(),
    setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null, ...extra };
};

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };

await t("the Send screen offers the crypto wallet as a real row", () => {
  const html = flat(run(`PH.send.html()`));
  assert.match(html, /href="#send\/wallet"/);
  assert.match(html, /EURe or USDC to an ENS name or 0x address/);
});

await t("with the switch off, the row is the old soon row and the form does not open", () => {
  run(`caps = { ...caps, cryptoSend: false }`);
  const html = flat(run(`PH.send.html()`));
  assert.doesNotMatch(html, /href="#send\/wallet"/);
  assert.match(flat(run(`PH["send/wallet"].html()`)), /isn’t available here/);
  run(`caps = { ...caps, cryptoSend: true }`);
});

await t("the check screen shows the name, the full address, the network and the amount", () => {
  run(`phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}" }`);
  const html = flat(run(`PH["send/wallet-check"].html()`));
  assert.match(html, /alice\.eth/);
  assert.match(html, /0x 5aAe b605 3F3E 94C9 b9A0 9f33 6694 35E7 Ef1B eAed/, "every character of the address, grouped");
  assert.match(html, /Base/);
  assert.match(html, /25\.5 USDC/);
  assert.match(html, /I checked this address with them/);
});

await t("Send stays off until the address is ticked as checked", () => {
  const btn = el(); const ok = el();
  run(`PH["send/wallet-check"]`).bind({ querySelector: (s: string) => (s === "#ph-wal-send" ? btn : s === "#ph-wal-ok" ? ok : el()) });
  assert.equal(btn.getAttribute("aria-disabled"), "true");
  ok.checked = true; ok.onchange();
  assert.equal(btn.getAttribute("aria-disabled"), null);
});

await t("sending posts the address shown as confirmedAddress, signs, then submits", async () => {
  run(`api = async (p, b) => { __calls.push([p, b]); return p.endsWith("/authorize") ? { id: "s1", state: "SENT", to: "${ADDR}", token: "USDC", amount: "25.5", txHash: "0xab" } : { id: "s1", safeExecution: { credentialId: "c", challenge: "ch" } }; }`);
  await run(`phWalletSubmit`)(el(), el());
  const calls = run(`__calls`);
  assert.equal(calls[0][0], "/api/users/u1/crypto-sends");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { to: "alice.eth", token: "USDC", amount: "25.5", confirmedAddress: ADDR });
  assert.equal(calls[1][0], "/api/crypto-sends/s1/authorize");
  assert.equal(calls[1][1].executionAssertion.from, "ch", "the passkey signs the challenge the server returned");
  assert.equal(run(`__went.at(-1)`), "send/wallet-done");
  assert.match(flat(run(`PH["send/wallet-done"].html("s1")`)), /Sent.*0xab/, "the result is read from Activity by id");
});

await t("a crypto send is a row in Activity, phone and desktop, and opens its result", () => {
  run(`hist.splice(0, hist.length, { kind: "crypto_out", id: "s2", at: "2026-10-27T10:00:00Z", createdAt: "2026-10-27T10:00:00Z", name: "alice.eth", to: "${ADDR}", token: "EURE", amount: "12.5", state: "SENT", txHash: "0xcd" }); histLoaded = true;`);
  const row = flat(run(`phActivityRow(hist[0])`));
  assert.match(row, /alice\.eth/);
  assert.match(row, /−12\.50 EURe/);
  assert.match(row, /SENT/);
  assert.match(row, /href="#send\/wallet-done\/s2"/);
  assert.match(flat(run(`phDeskTxRow(hist[0])`)), /alice\.eth.*−12\.50 EURe/);
  assert.match(flat(run(`histRow(hist[0])`)), /alice\.eth/);
  assert.equal(run(`phFiltered("out", "alice").length`), 1, "found by name under Money out");
  assert.match(flat(run(`PH["send/wallet-done"].html("s2")`)), /Sent.*0xcd/);
});

await t("a refused send says why and moves nowhere", async () => {
  run(`__went = []; api = async () => { throw new Error("the address changed since you checked it — check it again"); }`);
  const err = el();
  await run(`phWalletSubmit`)(el(), err);
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /address changed/);
  assert.equal(run(`__went.length`), 0);
});

await t("a lost /authorize answer: no second send, and the screen says it can't confirm the payment", async () => {
  run(`phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}" }; __calls = []; __went = [];
    api = async (p, b) => { __calls.push([p, b]); if (p.endsWith("/authorize")) { const e = new Error("you appear to be offline. Zold could not be reached"); e.offline = true; throw e; } return { id: "s3", safeExecution: { credentialId: "c", challenge: "ch" } }; }`);
  const btn = el(); const ok = el({ checked: true }); const err = el();
  const root = { querySelector: (s: string) => (s === "#ph-wal-send" ? btn : s === "#ph-wal-ok" ? ok : s === "#ph-wal-err" ? err : el()) };
  run(`PH["send/wallet-check"]`).bind(root);
  const settle = () => new Promise((r) => setTimeout(r, 10));
  btn.onclick(); await settle();
  assert.equal(run(`__calls.length`), 2, "created, then /authorize was sent");
  btn.onclick(); await settle();
  ok.onchange();
  assert.equal(run(`__calls.length`), 2, "a second press makes no new send");
  assert.equal(btn.getAttribute("aria-disabled"), "true", "Send stays off");
  const html = flat(run(`PH["send/wallet-check"].html()`));
  assert.match(html, /We can’t confirm this payment/);
  assert.match(html, /id="ph-check-activity"/);
  assert.doesNotMatch(html, /id="ph-wal-send"/, "no Send button on the redrawn screen");
  assert.doesNotMatch(html, /Nothing was sent/);
});

await t("after a lost /authorize answer, going back to the form and checking the same address again offers no Send", async () => {
  run(`__went = []; api = async (p) => ({ name: "alice.eth", address: "${ADDR}", chainId: 8453 }); Z = { ...Z, setFieldError() {}, focusFirstError: () => false }`);
  const fields: Record<string, any> = { "#ph-wal-to": el({ value: "alice.eth" }), "#ph-wal-amount": el({ value: "25.5" }), "#ph-wal-token": el({ value: "USDC" }) };
  const form = el(); const next = el();
  run(`PH["send/wallet"]`).bind({ querySelector: (s: string) => (s === "#ph-wal" ? form : s === "#ph-wal-next" ? next : fields[s] ?? el()), querySelectorAll: () => [] });
  await form.onsubmit({ preventDefault() {} });
  assert.equal(run(`__went.at(-1)`), "send/wallet-check");
  const html = flat(run(`PH["send/wallet-check"].html()`));
  assert.match(html, /We can’t confirm this payment/);
  assert.doesNotMatch(html, /id="ph-wal-send"/);
  run(`__calls = []`);
  await run(`phWalletSubmit`)(el(), el());
  assert.equal(run(`__calls.length`), 0, "no new send");
});

await t("while /authorize waits, going back and sending again makes no second send, and the screen says it is waiting", async () => {
  run(`phUnconfirmed = false; __calls = []; __went = []; phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}" };
    api = (p, b) => { __calls.push([p, b]); if (p.endsWith("/authorize")) return new Promise(() => {}); if (p.startsWith("/api/ens/")) return Promise.resolve({ name: "alice.eth", address: "${ADDR}", chainId: 8453 }); return Promise.resolve({ id: "s7", safeExecution: { credentialId: "c", challenge: "ch" } }); }`);
  run(`phWalletSubmit`)(el(), el());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run(`__calls.length`), 2, "created, and /authorize is waiting");
  const fields: Record<string, any> = { "#ph-wal-to": el({ value: "alice.eth" }), "#ph-wal-amount": el({ value: "25.5" }), "#ph-wal-token": el({ value: "USDC" }) };
  const form = el(); const next = el();
  run(`PH["send/wallet"]`).bind({ querySelector: (s: string) => (s === "#ph-wal" ? form : s === "#ph-wal-next" ? next : fields[s] ?? el()), querySelectorAll: () => [] });
  await form.onsubmit({ preventDefault() {} });
  const html = flat(run(`PH["send/wallet-check"].html()`));
  assert.doesNotMatch(html, /id="ph-wal-send"/);
  assert.match(html, /Waiting for your last payment/);
  assert.doesNotMatch(html, /We can’t confirm|ph-check-activity/, "a reload now would drop the answer");
  await run(`phWalletSubmit`)(el(), el());
  assert.equal(run(`__calls.filter(([p]) => p.endsWith("/crypto-sends")).length`), 1, "no second create");
});

await t("once the waiting /authorize answers, Send is offered again", async () => {
  run(`phUnconfirmed = false; api = (p) => p.endsWith("/authorize") ? new Promise((r) => { globalThis.__answer = r; }) : Promise.resolve({ id: "s8", safeExecution: { credentialId: "c", challenge: "ch" } });`);
  const done = run(`phWalletSubmit`)(el(), el());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run(`phUnconfirmed`), "pending");
  ctx.__answer({ id: "s8", state: "SENT", to: ADDR, token: "USDC", amount: "25.5", txHash: "0xef" });
  await done;
  assert.equal(run(`phUnconfirmed`), false);
  assert.match(flat(run(`PH["send/wallet-check"].html()`)), /id="ph-wal-send"/);
});

for (const [name, fail] of [
  ["a Zold 5xx with a JSON body", `Object.assign(new Error("Something went wrong on our side."), { status: 500, body: { error: "Something went wrong on our side." } })`],
  ["the service worker's offline 503", `Object.assign(new Error("offline"), { status: 503, offline: true, body: { error: "offline" } })`],
  ["a 409 \"already submitted\" (it went out)", `Object.assign(new Error("this send was already submitted"), { status: 409, body: { error: "this send was already submitted" } })`],
] as const) {
  await t(`after /authorize, ${name} is unknown: no Send`, async () => {
    run(`phUnconfirmed = false; phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}" };
      api = async (p) => { if (p.endsWith("/authorize")) throw ${fail}; return { id: "s5", safeExecution: { credentialId: "c", challenge: "ch" } }; }`);
    await run(`phWalletSubmit`)(el(), el());
    assert.match(flat(run(`PH["send/wallet-check"].html()`)), /We can’t confirm this payment/);
  });
}

await t("a cancelled passkey prompt sends nothing and keeps Send", async () => {
  run(`phUnconfirmed = false; api = async () => ({ id: "s6", safeExecution: { credentialId: "c", challenge: "ch" } });
    const real = safeExecutionAssertion; safeExecutionAssertion = async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); }; globalThis.__realSea = real;`);
  const btn = el(); const err = el();
  await run(`phWalletSubmit`)(btn, err);
  run(`safeExecutionAssertion = globalThis.__realSea`);
  assert.match(err.textContent, /cancelled/);
  assert.equal(run(`Z.isDisabled`)(btn), false);
  assert.match(flat(run(`PH["send/wallet-check"].html()`)), /id="ph-wal-send"/);
});

await t("a refusal from Zold after /authorize was sent still lets the person fix it and send", async () => {
  run(`phUnconfirmed = false; phWallet = { to: "alice.eth", token: "USDC", amount: "25.5", name: "alice.eth", address: "${ADDR}" }; __calls = [];
    api = async (p, b) => { __calls.push([p, b]); if (p.endsWith("/authorize")) { const e = new Error("alice.eth now points to a different address — nothing was sent; check it and start again"); e.status = 409; e.body = { error: e.message, code: "ADDRESS_CHANGED" }; throw e; } return { id: "s4", safeExecution: { credentialId: "c", challenge: "ch" } }; }`);
  const btn = el(); const err = el();
  btn.setAttribute("aria-busy", "true"); btn.removeAttribute("aria-busy");
  await run(`phWalletSubmit`)(btn, err);
  assert.match(err.textContent, /different address/);
  assert.equal(run(`Z.isDisabled`)(btn), false, "the spinner is off and Send is live");
  assert.match(flat(run(`PH["send/wallet-check"].html()`)), /id="ph-wal-send"/);
});

await t("a name is looked up and the resolved address goes to the check screen", async () => {
  run(`__calls = []; __went = []; api = async (p) => { __calls.push([p]); return { name: "alice.eth", address: "${ADDR}", chainId: 8453 }; }`);
  const fields: Record<string, any> = { "#ph-wal-to": el({ value: " Alice.eth " }), "#ph-wal-amount": el({ value: "10,5" }), "#ph-wal-token": el({ value: "EURE" }) };
  const form = el(); const next = el();
  const root = { querySelector: (s: string) => (s === "#ph-wal" ? form : s === "#ph-wal-next" ? next : fields[s] ?? el()), querySelectorAll: () => [] };
  run(`Z = { ...Z, setFieldError() {}, focusFirstError: () => false }`);
  run(`PH["send/wallet"]`).bind(root);
  await form.onsubmit({ preventDefault() {} });
  assert.equal(run(`__calls[0][0]`), "/api/ens/lookup?name=Alice.eth");
  assert.equal(run(`phWallet.address`), ADDR);
  assert.equal(run(`phWallet.amount`), "10.5");
  assert.equal(run(`__went.at(-1)`), "send/wallet-check");
});

console.log(`\nCRYPTO SEND UI TEST PASSED — ${pass}/${pass}`);
