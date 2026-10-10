/**
 * The onboarding branch that brings in a company's existing Safe
 * (public/app/onboarding.js, monerium.js): which accounts are offered the
 * choice, that no path deploys the account's own Safe while an import is in
 * progress on this device, and that an imported Safe skips the recovery step.
 *
 * Runs the real classic scripts in a vm with a stub DOM and a recorded `api`.
 * What this cannot show: the screens in a browser, a real passkey ceremony
 * (passkeyAssertion is stubbed), or a
 * Safe{Wallet} transaction. Offline.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");

// Anything the scripts touch that this test does not look at.
const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : stub),
  set: () => true,
  apply: () => stub,
});
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
};
const obRoot = { innerHTML: "", querySelector: () => stub, querySelectorAll: () => [], contains: () => false };
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0 },
  location: { pathname: "/app", search: "", hash: "", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: () => Promise.reject(new Error("no network in this test")),
  document: {
    getElementById: (id: string) => (id === "ob-root" ? obRoot : stub),
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

// Every API call, and the answer the test chooses for it.
const calls: { path: string; body: any }[] = [];
let answer: (path: string, body: any) => any = () => ({});
ctx.__api = async (p: string, body: any) => {
  calls.push({ path: p, body });
  return answer(p, body);
};
run(`
  api = (...a) => __api(...a);
  renderUser = (u) => { user = u; };
  issueAppIban = async () => false;
`);

const PLAN = "0x00000000000000000000000000000000000000a1";
const SAFE = "0x5afe00000000000000000000000000000000beef";
const VERIFIER = "0x7e71f1e700000000000000000000000000000001";
const EOA = "0xe0a0000000000000000000000000000000000001";
const company = (over: any = {}) => ({
  id: "u-co", name: "Mira", email: "m@example.test", accountType: "company", kycStatus: "pending",
  passkey: { credentialId: "cred" },
  passkeySafe: { address: PLAN, status: "planned", threshold: 1, passkeyPublicKey: {} },
  ...over,
});
const setUser = (u: any) => { ctx.__u = u; run("user = __u"); };
const setCaps = (c: any) => { ctx.__c = c; run("caps = { ...caps, ...__c }"); };
const screen = () => run("obScreen");
const deployed = () => calls.some((c) => c.path.includes("/passkey-safe/deployment"));

let pass = 0;
async function check(name: string, fn: () => unknown) {
  calls.length = 0;
  ctx.localStorage.removeItem("zold-safe-import");
  run("obImport = null; obSetup = null; obScreen = null");
  await fn();
  pass++;
  console.log(`  ok  ${name}`);
}

await check("an eligible company account with a passkey is offered the choice, never b-passkey", () => {
  setCaps({ safeImport: true });
  setUser(company());
  assert.equal(run("obNextAfterAccount()"), "b-safe-choice");
  assert.equal(run('obGuard("b-passkey")'), "b-safe-choice");
  assert.equal(run('obGuard("b-safe-choice")'), "b-safe-choice");
});
await check("no choice without the capability, for a personal account, or once the Safe is active", () => {
  setCaps({ safeImport: false });
  setUser(company());
  assert.equal(run("obNextAfterAccount()"), "b-passkey");
  assert.equal(run('obGuard("b-safe-choice")'), "b-passkey", "the screen itself is refused too");
  setCaps({ safeImport: true });
  setUser(company({ accountType: "individual" }));
  assert.equal(run("obNextAfterAccount()"), "p-passkey");
  setUser(company({ passkeySafe: { address: PLAN, status: "active" } }));
  assert.notEqual(run('obGuard("b-safe-choice")'), "b-safe-choice");
});
await check("an import started on this device resumes at confirm, for that user only", () => {
  setCaps({ safeImport: true });
  setUser(company());
  run(`setSafeImportFlag("${SAFE}")`);
  assert.equal(run("obNextAfterAccount()"), "b-import-confirm");
  assert.equal(run('obGuard("b-passkey")'), "b-import-confirm");
  setUser(company({ id: "someone-else" }));
  assert.equal(run("obNextAfterAccount()"), "b-safe-choice", "another login on this browser ignores the flag");
  ctx.localStorage.setItem("zold-safe-import", "{not json");
  assert.equal(run("safeImportFlag()"), null, "a broken flag reads as none");
});
await check("b-passkey's button stops after the passkey for an eligible company: no deployment", async () => {
  setCaps({ safeImport: true });
  setUser(company());
  run("obGo('b-passkey')");
  assert.equal(screen(), "b-safe-choice");
  run("obScreen = 'b-passkey'");
  await run("obCreateAccount(document.createElement('button'))");
  assert.equal(screen(), "b-safe-choice");
  assert.ok(calls.some((c) => c.path === "/api/orgs"), "obCreateAccount ran past its early returns");
  assert.ok(!deployed(), JSON.stringify(calls));
});
await check("with an import in progress nothing deploys, even where the capability is off", async () => {
  setUser(company());
  run(`setSafeImportFlag("${SAFE}")`);
  setCaps({ safeImport: false });
  await assert.rejects(run("finishPasskeySafeSetup()"), /existing Safe/);
  await run("obCreateAccount(document.createElement('button'))");
  await run("finishDashboardSmartWallet()");
  assert.ok(!deployed(), JSON.stringify(calls));
  setCaps({ safeImport: true });
});
await check("Home hides Finish smart wallet while an import is in progress", () => {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { classList: { on: new Set<string>(), toggle(c: string, on: boolean) { if (on) this.on.add(c); else this.on.delete(c); } }, textContent: "" });
  const prev = ctx.document.getElementById;
  ctx.document.getElementById = (id: string) => (id === "ob-root" ? obRoot : el(id));
  try {
    setUser(company({ kycStatus: "approved", funding: { mode: "sandbox" } }));
    run("renderFundingActions()");
    assert.ok(!el("btn-finish-safe").classList.on.has("hidden"), "without an import the button shows");
    run(`setSafeImportFlag("${SAFE}")`);
    run("renderFundingActions()");
    assert.ok(el("btn-finish-safe").classList.on.has("hidden"));
    assert.ok(!el("btn-finish-import").classList.on.has("hidden"));
  } finally {
    ctx.document.getElementById = prev;
  }
});

const prepared = (over: any = {}) => ({
  safeAddress: SAFE, chainId: 84532, owners: [EOA], threshold: 1, verifier: VERIFIER, verifierDeployed: true, alreadyOwner: false,
  deployVerifier: null,
  ownerChange: {
    add: { to: SAFE, value: "0", data: "0x0d582f13", resultOwners: [VERIFIER, EOA], txBuilder: { fileName: "f.json", json: "{}\n" } },
    swap: { to: SAFE, value: "0", data: "0xe318b52b", resultOwners: [VERIFIER], txBuilder: { fileName: "f.json", json: "{}\n" } },
  },
  ...over,
});

await check("the address screen calls prepare and sets the flag only on an answer", async () => {
  setUser(company());
  run("obGo('b-import-address')");
  assert.equal(screen(), "b-import-address");
  answer = () => prepared();
  ctx.__p = await run(`obPrepareImport("${SAFE}")`);
  assert.equal(calls[0].path, "/api/users/u-co/safe/import/prepare");
  assert.deepEqual(JSON.parse(ctx.localStorage.getItem("zold-safe-import")), { userId: "u-co", address: SAFE });
  run("obRender()");
  assert.match(obRoot.innerHTML, /Is this your Safe\?/);
  assert.match(obRoot.innerHTML, /Base Sepolia/);
  assert.match(obRoot.innerHTML, /1 of 1/);
});
await check("refusals read as sentences, never as the server's text alone", () => {
  for (const code of ["NO_CODE", "WRONG_SINGLETON", "EXTRA_MODULES", "THRESHOLD_NOT_ONE", "TOO_MANY_OWNERS", "SAFE_DEPLOYED", "PLAN_HAS_FUNDS", "ADDRESS_IN_USE", "RPC_FAILED", "VERIFIER_NOT_OWNER", "STEP_UP_REQUIRED", "STEP_UP_INVALID", "SAFE_CHANGED"]) {
    ctx.__e = { code, message: "raw server text" };
    const s = run("obImportSentence(__e)");
    assert.ok(!s.includes("raw server text"), code);
  }
  ctx.__e = { code: "SOMETHING_NEW", message: "raw server text" };
  assert.match(run("obImportSentence(__e)"), /^Zold couldn’t check this Safe \(Raw server text\)\.$/);
});
await check("sign: Add is the default; Swap only when not refused, with a warning; no file without an answer", () => {
  setUser(company());
  ctx.__p = prepared();
  run("obImport = { address: __p.safeAddress, prepared: __p }; obGo('b-import-sign')");
  assert.equal(screen(), "b-import-sign");
  assert.equal(run("obImport.mode"), "add");
  assert.match(obRoot.innerHTML, /Download for Safe\{Wallet\}/);
  assert.match(obRoot.innerHTML, /value="swap"/);
  assert.match(obRoot.innerHTML, /1 of 2/);
  ctx.__p = prepared({ ownerChange: { add: prepared().ownerChange.add, swap: { refused: "name the one to replace" } } });
  run("obImport = { address: __p.safeAddress, prepared: __p }; obRender()");
  assert.doesNotMatch(obRoot.innerHTML, /value="swap"/);
  ctx.__p = prepared({ ownerChange: { add: { refused: "x" }, swap: { refused: "y" } } });
  run("obImport = { address: __p.safeAddress, prepared: __p }; obRender()");
  assert.doesNotMatch(obRoot.innerHTML, /Download/);
  run("obImport = null");
  assert.equal(run('obGuard("b-import-sign")'), "b-import-address", "no prepare answer, no sign screen");
});
await check("confirm: check, then approve with the passkey after the other owner is shown; 201 binds, clears the flag and never deploys", async () => {
  setCaps({ safeImport: true, zoldenburgRecovery: true, emailSmsRecovery: true });
  setUser(company());
  ctx.__p = prepared();
  run(`setSafeImportFlag("${SAFE}"); obImport = { address: "${SAFE}", prepared: __p }; obGo('b-import-confirm')`);
  assert.equal(screen(), "b-import-confirm");
  assert.doesNotMatch(obRoot.innerHTML, /imported/i, "nothing says imported before confirm");
  const btn: any = { querySelector: () => ({ textContent: "" }), getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  const handlers: Record<string, any> = {};
  const root = { querySelector: (sel: string) => (sel === "#btn-import-confirm" ? (handlers.confirm ??= {}) : null) };
  run("OB['b-import-confirm'].bind")(root);
  // The owner change is not on chain yet: prepare names no approval.
  answer = () => prepared();
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.deepEqual(calls.map((c) => c.path), ["/api/users/u-co/safe/import/prepare"]);
  assert.equal(run("obImport.notYet"), true);
  assert.equal(screen(), "b-import-confirm");
  assert.doesNotMatch(obRoot.innerHTML, /Approve with Face ID/);
  // On chain now: the check shows the other owner before anything is approved.
  const ready = prepared({ owners: [VERIFIER, EOA], otherOwners: [EOA], alreadyOwner: true, ownerChange: null, approval: { challenge: "Y2hhbGxlbmdl", rpId: "localhost" } });
  answer = () => ready;
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.ok(!calls.some((c) => c.path.endsWith("/confirm")), "checking never confirms");
  assert.match(obRoot.innerHTML, /Approve with Face ID/);
  assert.match(obRoot.innerHTML, new RegExp(`This Safe has another owner: <span[^>]*>${EOA}</span>`));
  run("passkeyAssertion = async (challenge) => ({ credentialId: 'cred', challenge })");
  answer = (p, body) => {
    assert.equal(p, "/api/users/u-co/safe/import/confirm");
    // JSON: the body was built in the vm's realm.
    assert.deepEqual(JSON.parse(JSON.stringify(body)), { address: SAFE, stepUp: { credentialId: "cred", challenge: "Y2hhbGxlbmdl" } }, "the approval prepare issued, spent on confirm");
    return company({ address: SAFE, passkeySafe: { address: SAFE, status: "active", threshold: 1, importedAt: "2026-10-01T00:00:00Z", previousAddress: PLAN } });
  };
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.equal(run("user.passkeySafe.address"), SAFE);
  assert.equal(run("safeImportFlag()"), null);
  assert.equal(screen(), "monerium", "an imported Safe skips the recovery step");
  assert.ok(!deployed());
});
await check("confirm: an owner already, but a Safe Zold can't bind, says why and offers no approval", async () => {
  setUser(company());
  run(`setSafeImportFlag("${SAFE}"); obImport = { address: "${SAFE}", prepared: null }; obScreen = 'b-import-confirm'`);
  const btn: any = { querySelector: () => ({ textContent: "" }), getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  // bind() itself asks prepare again when nothing is prepared yet.
  answer = () => prepared({ owners: [VERIFIER, EOA], otherOwners: [EOA], alreadyOwner: true, ownerChange: null, threshold: 2, approval: null });
  const handlers: Record<string, any> = {};
  run("OB['b-import-confirm'].bind")({ querySelector: (sel: string) => (sel === "#btn-import-confirm" ? (handlers.confirm ??= {}) : null) });
  run("obShowErr = (e) => { __lastErr = e; }; var __lastErr = null");
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.equal(run("__lastErr.message"), run('obImportSentence({ code: "THRESHOLD_NOT_ONE" })'));
  assert.equal(run("obImport.notYet"), true);
  assert.doesNotMatch(obRoot.innerHTML, /Approve with Face ID/);
});
await check("confirm: a refused approval is dropped, and the next click checks again", async () => {
  setUser(company());
  ctx.__p = prepared({ owners: [VERIFIER], otherOwners: [], alreadyOwner: true, ownerChange: null, approval: { challenge: "c2", rpId: "localhost" } });
  run(`setSafeImportFlag("${SAFE}"); obImport = { address: "${SAFE}", prepared: __p }; obGo('b-import-confirm')`);
  assert.match(obRoot.innerHTML, /only owner/);
  const btn: any = { querySelector: () => ({ textContent: "" }), getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  const handlers: Record<string, any> = {};
  run("OB['b-import-confirm'].bind")({ querySelector: (sel: string) => (sel === "#btn-import-confirm" ? (handlers.confirm ??= {}) : null) });
  run("passkeyAssertion = async (challenge) => ({ credentialId: 'cred', challenge })");
  answer = () => { throw Object.assign(new Error("changed"), { code: "SAFE_CHANGED", status: 409 }); };
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.equal(run("obImport.prepared.approval"), null);
  assert.doesNotMatch(obRoot.innerHTML, /Approve with Face ID/);
  answer = () => prepared();
  calls.length = 0;
  await handlers.confirm.onclick({ currentTarget: btn });
  assert.deepEqual(calls.map((c) => c.path), ["/api/users/u-co/safe/import/prepare"]);
});
await check("Use a new account instead clears the flag and returns to the choice", () => {
  setCaps({ safeImport: true });
  setUser(company());
  run(`setSafeImportFlag("${SAFE}")`);
  const link: any = {};
  run("obBindNewAccountLink")({ querySelector: (sel: string) => (sel === "#btn-import-new" ? link : null) });
  link.onclick();
  assert.equal(run("safeImportFlag()"), null);
  assert.equal(screen(), "b-safe-choice");
  assert.ok(!deployed());
});
await check("recovery: offered to a Safe Zold deployed, held back from an imported one", () => {
  setCaps({ zoldenburgRecovery: true, emailSmsRecovery: true });
  setUser(company({ passkeySafe: { address: PLAN, status: "active" } }));
  assert.equal(run("obNextAfterAccount()"), "recovery");
  setUser(company({ passkeySafe: { address: SAFE, status: "active", importedAt: "2026-10-01T00:00:00Z" } }));
  assert.equal(run("obNextAfterAccount()"), "monerium");
  assert.notEqual(run('obGuard("recovery")'), "recovery");
  assert.notEqual(run('obGuard("recovery-email")'), "recovery-email");
});

await check("a segment without a Safe (India collections) never asks to deploy one", async () => {
  setCaps({ safeImport: true, zoldenburgRecovery: true, emailVerification: false });
  const india = { segment: { value: "IN_COLLECTIONS", capabilities: ["xflow_collections"] } };
  setUser(company({ accountType: "individual", ...india }));
  assert.equal(run("needsPasskeySafeSetup()"), false);
  assert.equal(run("obNextAfterAccount()"), null, "no Monerium either: straight to the app, whose Home names the gate");
  assert.notEqual(run('obGuard("p-passkey")'), "p-passkey");
  await run("finishPasskeySafeSetup()");
  assert.ok(!deployed(), "the server refuses this deployment with 403 CAPABILITY_UNAVAILABLE");
  // An account with the capability still deploys, and one that predates
  // segmentation is read as having everything.
  setUser(company({ accountType: "individual", segment: { value: "EU_FULL", capabilities: ["monerium", "safe"] } }));
  assert.equal(run("needsPasskeySafeSetup()"), true);
  setUser(company({ accountType: "individual" }));
  assert.equal(run("needsPasskeySafeSetup()"), true);
});

console.log(`safe-import-ui: ${pass} ok`);
