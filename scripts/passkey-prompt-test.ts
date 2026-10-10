/**
 * Passkey prompts (public/app/core.js passkeyPrompt): one open at a time, and
 * a deadline closes the prompt in the browser, not only our wait for it. A
 * retry after a deadline that left the old prompt open got "A request is
 * already pending" from the browser (a tester on a Mac, 2026-10-07). A
 * password manager's own "already pending" refusal is asked again after a
 * pause, and only that refusal.
 *
 * Runs the real classic scripts in a vm with a fake navigator.credentials.
 * What this cannot show: a real browser's prompt. Offline.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

// A fake authenticator: each call records its options and waits to be
// answered, and rejects the way a browser does when its signal aborts.
type Call = { kind: string; options: any; resolve: (v: any) => void; reject: (e: any) => void };
const prompts: Call[] = [];
let coarse = false;
const credentials = {
  create: (options: any) => open("create", options),
  get: (options: any) => open("get", options),
};
function open(kind: string, options: any) {
  return new Promise((resolve, reject) => {
    prompts.push({ kind, options, resolve, reject });
    options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
  });
}

const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  AbortController,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: coarse }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, credentials },
  location: { pathname: "/app", search: "", hash: "", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: () => Promise.reject(new Error("no network in this test")),
  document: {
    getElementById: () => stub,
    querySelector: () => stub, querySelectorAll: () => [], addEventListener() {}, createElement: () => stub,
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["ui.js", "app/core.js", "app/recovery.js", "app/monerium.js", "app/onboarding.js"]) {
  vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
}
const run = (code: string) => vm.runInContext(code, ctx);
const tick = () => new Promise((r) => setTimeout(r, 0));
const ask = (kind: string, deadline = "") => run(`passkeyPrompt("${kind}", { challenge: new Uint8Array(1) }${deadline ? `, ${deadline}` : ""})`);

// A prompt nobody answers: the deadline rejects AND aborts the prompt itself.
{
  prompts.length = 0;
  const e = await ask("get", "20").then(() => null, (x: any) => x);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].options.signal, "the prompt is given an AbortSignal");
  assert.equal(prompts[0].options.signal.aborted, true, "the deadline closes the browser prompt");
  assert.equal(e?.code, "PASSKEY_NO_ANSWER");
  assert.match(e.message, /passkey prompt/i, "a computer is not told about a phone");
  assert.equal(prompts[0].options.publicKey.timeout, run("PASSKEY_TIMEOUT_MS"), "the browser's own timeout is the shared one");
}

// The phone wording names Face ID and the screen lock.
{
  coarse = true;
  const e = await ask("get", "5").catch((x: any) => x);
  assert.match(e.message, /Face ID/);
  coarse = false;
}

// A new prompt closes the one still open before it opens.
{
  prompts.length = 0;
  const first = ask("create").catch((e: any) => e);
  await tick();
  const second = ask("get");
  await tick();
  assert.equal(prompts[0].options.signal.aborted, true, "the earlier prompt is closed");
  assert.equal(prompts[1].options.signal.aborted, false);
  assert.equal((await first).name, "AbortError");
  prompts[1].resolve({ id: "cred" });
  assert.deepEqual(await second, { id: "cred" });
}

// An answered prompt returns the credential and is never aborted later.
{
  prompts.length = 0;
  const p = ask("get", "50");
  await tick();
  prompts[0].resolve({ id: "ok" });
  assert.deepEqual(await p, { id: "ok" });
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(prompts[0].options.signal.aborted, false, "no late abort after an answer");
}

// Cancel on the waiting overlay closes the browser prompt and says so plainly,
// not as the browser's AbortError.
{
  prompts.length = 0;
  const p = ask("get").catch((x: any) => x);
  await tick();
  run("passkeyUserCancel()");
  const e = await p;
  assert.equal(prompts[0].options.signal.aborted, true, "Cancel closes the browser prompt");
  assert.equal(e.code, "PASSKEY_CANCELLED");
  assert.match(e.message, /cancelled/i);
  assert.equal(run("passkeyUserCancel()"), undefined, "Cancel with nothing open does nothing");
}

// The overlay is a nicety: drawn at once against a stub DOM, the prompt still
// opens and answers.
{
  prompts.length = 0;
  const p = run(`passkeyPrompt("get", { challenge: new Uint8Array(1) }, PASSKEY_DEADLINE_MS, 0)`);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts.length, 1);
  prompts[0].resolve({ id: "drawn-or-not" });
  assert.deepEqual(await p, { id: "drawn-or-not" });
}

// A step around a prompt that runs out of time closes the open prompt too.
{
  prompts.length = 0;
  const e = await run(`withinPasskeyStep(passkeyPrompt("get", { challenge: new Uint8Array(1) }), 15 - PASSKEY_DEADLINE_MS, "took too long")`).catch((x: any) => x);
  assert.equal(e.message, "took too long");
  assert.equal(prompts[0].options.signal.aborted, true);
}

// A password manager that replaces navigator.credentials (LastPass) holds its
// previous request open for a moment after answering it, and refuses the next
// as "already pending" with nothing of ours open. That refusal opened nothing,
// so it is asked again after a pause instead of failing the step (create the
// passkey, then deploy the Safe at once; a tester, 2026-10-10).
const pending = (msg = "A request is already pending.") => Object.assign(new Error(msg), { name: "InvalidStateError" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 2000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
assert.equal(run("PASSKEY_PENDING_RETRY_MS"), 1500, "the production pause");
assert.equal(run("PASSKEY_PENDING_RETRIES"), 3, "the production cap");
try {
  run("PASSKEY_PENDING_RETRY_MS = 5");

  // Refused as pending, asked again with the same options and signal, answered.
  // Both spellings Chromium has used are retried, and so is create.
  for (const [kind, msg] of [["get", undefined], ["create", "A request is pending."]] as const) {
    prompts.length = 0;
    const p = ask(kind);
    await tick();
    prompts[0].reject(pending(msg));
    await waitFor(() => prompts.length === 2, "the retry");
    assert.equal(prompts[1].kind, kind);
    assert.equal(prompts[1].options.signal, prompts[0].options.signal, "the retry keeps the signal Cancel and the deadline reach");
    assert.equal(prompts[1].options.signal.aborted, false);
    assert.equal(prompts[1].options.publicKey.challenge, prompts[0].options.publicKey.challenge);
    assert.equal(prompts[1].options.publicKey.timeout, run("PASSKEY_TIMEOUT_MS"));
    prompts[1].resolve({ id: `after-pending-${kind}` });
    assert.deepEqual(await p, { id: `after-pending-${kind}` });
  }

  // Three retries, then the browser's own refusal, unwrapped.
  {
    prompts.length = 0;
    const p = ask("get").catch((x: any) => x);
    for (let i = 0; i < 4; i++) {
      await waitFor(() => prompts.length === i + 1, `attempt ${i + 1}`);
      prompts[i].reject(pending());
    }
    // Bounded: a loop with no cap would open a fifth prompt and wait on it.
    const e = await Promise.race([p, sleep(500).then(() => ({ name: "still asking after the cap" }))]);
    assert.equal(e.name, "InvalidStateError");
    assert.match(e.message, /already pending/);
    await sleep(30);
    assert.equal(prompts.length, 4, "no fifth attempt");
  }

  // Any other refusal is final: a cancel stays a cancel, and Chromium's other
  // InvalidStateError (a passkey already on this device) is not "pending".
  for (const err of [
    Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }),
    Object.assign(new Error("The user attempted to register an authenticator that contains one of the credentials already registered with the relying party."), { name: "InvalidStateError" }),
  ]) {
    prompts.length = 0;
    const p = ask("create").catch((x: any) => x);
    await tick();
    prompts[0].reject(err);
    assert.equal((await p).name, err.name);
    await sleep(30);
    assert.equal(prompts.length, 1, `${err.name} is not retried`);
  }

  // The pause is real: nothing is asked again before it ends.
  {
    run("PASSKEY_PENDING_RETRY_MS = 80");
    prompts.length = 0;
    const p = ask("get");
    await tick();
    prompts[0].reject(pending());
    await sleep(20);
    assert.equal(prompts.length, 1, "no retry before the pause ends");
    await waitFor(() => prompts.length === 2, "the retry after the pause");
    prompts[1].resolve({ id: "paused" });
    await p;
  }

  // Cancel, the deadline or a newer prompt during the pause: no prompt is
  // opened afterwards, and the caller hears why it ended.
  run("PASSKEY_PENDING_RETRY_MS = 150");
  {
    prompts.length = 0;
    const p = ask("get").catch((x: any) => x);
    await tick();
    prompts[0].reject(pending());
    await sleep(10);
    run("passkeyUserCancel()");
    assert.equal((await p).code, "PASSKEY_CANCELLED");
    await sleep(200);
    assert.equal(prompts.length, 1, "Cancel during the pause opens nothing after it");
  }
  {
    prompts.length = 0;
    const p = ask("get", "40").catch((x: any) => x);
    await tick();
    prompts[0].reject(pending());
    assert.equal((await p).code, "PASSKEY_NO_ANSWER");
    await sleep(200);
    assert.equal(prompts.length, 1, "the deadline during the pause opens nothing after it");
  }
  {
    prompts.length = 0;
    const old = ask("get").catch((x: any) => x);
    await tick();
    prompts[0].reject(pending());
    await sleep(10);
    const fresh = ask("create");
    assert.equal((await old).name, "AbortError", "the superseded prompt says aborted, not pending");
    await sleep(200);
    assert.equal(prompts.length, 2, "the old loop opens no prompt beside the new one");
    prompts[1].resolve({ id: "fresh" });
    assert.deepEqual(await fresh, { id: "fresh" });
  }
} finally {
  run("PASSKEY_PENDING_RETRY_MS = 1500");
}

// The browser's "already pending" refusal is told plainly, not as a raw message
// or as "already has a sign-in" (Chromium names it InvalidStateError).
{
  ctx.__e = Object.assign(new Error("A request is already pending."), { name: "InvalidStateError" });
  const m = run("obMessage(__e)");
  assert.doesNotMatch(m, /already has a Zold sign-in/);
  assert.match(m, /still open/);
}

// Desktop sign-up names what a computer offers, not Face ID on "this phone".
{
  run(`user = null`);
  for (const screen of ["p-passkey", "b-passkey"]) {
    coarse = false;
    const desk = run(`OB["${screen}"].html()`);
    assert.doesNotMatch(desk, /this phone/, `${screen} on a computer`);
    assert.doesNotMatch(desk, /Face ID/, `${screen} on a computer`);
    coarse = true;
    assert.match(run(`OB["${screen}"].html()`), /phone/, `${screen} on a phone`);
  }
  coarse = false;
}

// Every prompt in the app goes through passkeyPrompt: a direct call would open
// a prompt nothing can close.
{
  const dir = path.join(PUB, "app");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const direct = readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => /navigator\.credentials\.(get|create)\(|navigator\.credentials\[/.test(l));
    const allowed = f === "core.js" ? 1 : 0; // passkeyPrompt itself
    assert.equal(direct.length, allowed, `${f} calls navigator.credentials directly: ${direct.join(" | ")}`);
  }
}

console.log("passkey prompt: ok");
