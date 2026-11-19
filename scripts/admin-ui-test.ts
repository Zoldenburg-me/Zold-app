/**
 * The admin dashboard's API client (public/admin/core.js), run as the
 * browser runs it: the real passkey.js and core.js in one script context,
 * with the DOM, storage, WebAuthn and fetch stubbed and recorded.
 *
 * - a change asks the server for a bound challenge, has the passkey sign it,
 *   and sends the answer with the change; a read or a ceremony asks nothing;
 * - signed out, nothing is sent;
 * - a 401 OPERATOR_SIGN_IN ends the session and says so; a 401 from Access
 *   leaves the session alone;
 * - an answer Zold did not write (an HTML 200, an empty 200, a body that is
 *   not JSON, a 401 with no { error }, a redirect) rejects, keeps the session
 *   and never marks the pill signed in, also through loadMe().
 *
 *   npm run admin:ui:test
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
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
};

const elements: Record<string, any> = { authPill: { className: "" }, authText: { textContent: "" } };
interface Call { path: string; method: string; headers: Record<string, string>; body?: string }
const calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown; type?: string; contentType?: string | null } = () => ({ status: 200, body: {} });
const events: string[] = [];
const buf = (s: string) => new TextEncoder().encode(s).buffer;

const ctx: any = {
  console, TextEncoder, btoa, atob, JSON, Promise, Uint8Array, Error, URLSearchParams,
  sessionStorage: storage(),
  localStorage: storage(),
  document: { getElementById: (id: string) => elements[id] ?? stub, addEventListener() {}, querySelectorAll: () => [] },
  navigator: {
    credentials: {
      get: async () => ({
        rawId: buf("cred-1"),
        response: { authenticatorData: buf("auth-data"), clientDataJSON: buf("client-data"), signature: buf("signature") },
      }),
    },
  },
  dispatchEvent: (e: { type: string }) => { events.push(e.type); return true; },
  Event: class { constructor(public type: string) {} },
  fetch: async (p: string, init: any = {}) => {
    const c: Call = { path: p, method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body };
    calls.push(c);
    const a = answer(c);
    const contentType = a.contentType === undefined ? "application/json" : a.contentType;
    return {
      status: a.status, ok: a.status >= 200 && a.status < 300, type: a.type ?? "basic",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => (a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body)),
    };
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["admin/passkey.js", "admin/core.js"]) vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
const run = (code: string) => vm.runInContext(code, ctx);

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  calls.length = 0;
  events.length = 0;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

await check("a change is approved with the passkey first, bound to its own method, path and body", async () => {
  run("setOperatorSession('zop_session')");
  answer = (c) => (c.path === "/api/admin/auth/step-up/challenge"
    ? { status: 200, body: { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "Y3JlZC0x" }] } }
    : { status: 200, body: { ok: true } });
  const body = JSON.stringify({ state: "FAILED", note: "checked" });
  await run(`api('/api/admin/transfers/t1/resolve-review', { method: 'POST', body: ${JSON.stringify(body)} })`);
  assert.deepEqual(calls.map((c) => c.path), ["/api/admin/auth/step-up/challenge", "/api/admin/transfers/t1/resolve-review"]);
  assert.deepEqual(JSON.parse(calls[0].body!), { method: "POST", path: "/api/admin/transfers/t1/resolve-review", body: JSON.parse(body) });
  const approval = JSON.parse(Buffer.from(calls[1].headers["X-Operator-Step-Up"], "base64url").toString());
  assert.equal(Buffer.from(approval.credentialId, "base64url").toString(), "cred-1");
  assert.equal(calls[1].body, body, "the change sends the body that was approved");
  assert.equal(calls[1].headers.Authorization, "Bearer zop_session");
});

await check("a read and a ceremony ask for no approval", async () => {
  answer = () => ({ status: 200, body: {} });
  await run("api('/api/admin/users')");
  await run("api('/api/admin/auth/logout', { method: 'POST', body: '{}' })");
  assert.deepEqual(calls.map((c) => c.path), ["/api/admin/users", "/api/admin/auth/logout"]);
  assert.ok(calls.every((c) => !("X-Operator-Step-Up" in c.headers)));
});

await check("signed out, neither a read nor a change is sent", async () => {
  run("setOperatorSession('')");
  await assert.rejects(run("api('/api/admin/users')"), (e: any) => e.status === 401);
  await assert.rejects(run("api('/api/admin/transfers/t1/resolve-review', { method: 'POST', body: '{}' })"), (e: any) => e.status === 401);
  assert.equal(calls.length, 0);
});

await check("a 401 from Access leaves the passkey session alone", async () => {
  run("setOperatorSession('zop_session')");
  answer = () => ({ status: 401, body: { error: "only through Access", code: "ACCESS_REQUIRED" } });
  await assert.rejects(run("api('/api/admin/users')"));
  assert.equal(run("operatorSession"), "zop_session");
  assert.deepEqual(events, []);
  assert.notEqual(run("rejectedToken"), "zop_session", "the background refresh keeps trying");
});

await check("a 401 OPERATOR_SIGN_IN ends the session and tells the page", async () => {
  answer = () => ({ status: 401, body: { error: "operator session expired", code: "OPERATOR_SIGN_IN" } });
  await assert.rejects(run("api('/api/admin/users')"));
  assert.equal(run("operatorSession"), "");
  assert.equal(ctx.sessionStorage.getItem("zold_operator_session"), null);
  assert.deepEqual(events, ["operator-session-ended"]);
});

const GATE_PAGE = { status: 200, body: "<html>Sign in</html>", contentType: "text/html; charset=utf-8" };

await check("a gate's HTML 200 to a read rejects, keeps the session and does not mark it signed in", async () => {
  run("setOperatorSession('zop_session'); rejectedToken = null; setAuth('none')");
  answer = () => GATE_PAGE;
  for (const p of ["/api/admin/auth/me", "/api/admin/users"]) {
    await assert.rejects(run(`api('${p}')`), (e: any) => e.foreign === true && /try again in a minute/.test(e.message));
  }
  assert.equal(elements.authText.textContent, "Signed out", "the pill is not set to signed in");
  assert.equal(run("operatorSession"), "zop_session");
  assert.equal(run("rejectedToken"), null, "the background refresh keeps trying");
  assert.deepEqual(events, []);
});

await check("an empty 200, or a page with no content-type, is not Zold's answer", async () => {
  run("setAuth('none')");
  for (const a of [
    { status: 200, body: "" },
    { status: 200, body: "  \n" },
    { status: 200, body: "", contentType: null },
    { status: 200, body: "<html>Sign in</html>", contentType: null },
    { status: 200, body: "<html>Sign in</html>" },
  ]) {
    answer = () => a;
    await assert.rejects(run("api('/api/admin/users')"), (e: any) => e.foreign === true && /try again in a minute/.test(e.message), JSON.stringify(a));
    await assert.rejects(run("authPost('/api/admin/auth/login/challenge')"), (e: any) => e.foreign === true && /check before/.test(e.message), JSON.stringify(a));
  }
  assert.equal(elements.authText.textContent, "Signed out", "the pill is not set to signed in");
  assert.equal(run("operatorSession"), "zop_session");
  answer = () => ({ status: 200, body: { id: "u1" }, contentType: null });
  assert.deepEqual({ ...(await run("api('/api/admin/users')")) }, { id: "u1" }, "Zold's JSON passes without a content-type");
});

await check("loadMe through a gate: the pill says Zold is unreachable, not signed in", async () => {
  run("setOperatorSession('zop_session'); operatorName = ''; setAuth('none')");
  for (const a of [GATE_PAGE, { status: 200, body: "" }]) {
    answer = () => a;
    await run("loadMe()");
    assert.equal(elements.authText.textContent, "Zold unreachable", JSON.stringify(a));
    assert.equal(run("operatorSession"), "zop_session");
  }
  answer = () => ({ status: 401, body: { error: "Cloudflare Access sign-in required", code: "ACCESS_REQUIRED" } });
  await run("loadMe()");
  assert.equal(elements.authText.textContent, "Unauthorized", "an Access refusal is not 'Signed in' either");
  answer = () => ({ status: 200, body: { operator: { name: "Ada" } } });
  await run("loadMe()");
  assert.equal(elements.authText.textContent, "Ada");
});

await check("a gate's answer to a write rejects and says to check before trying again", async () => {
  answer = (c) => (c.path === "/api/admin/auth/step-up/challenge"
    ? { status: 200, body: { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "Y3JlZC0x" }] } }
    : GATE_PAGE);
  await assert.rejects(run("api('/api/admin/transfers/t1/resolve-review', { method: 'POST', body: '{}' })"),
    (e: any) => e.foreign === true && /check before you try it again/.test(e.message));
  assert.equal(run("operatorSession"), "zop_session");
});

await check("a 401 or a redirect with no Zold body is the gate's, not a refusal", async () => {
  for (const a of [{ status: 401, body: {} }, { status: 0, body: {}, type: "opaqueredirect" }]) {
    answer = () => a;
    await assert.rejects(run("api('/api/admin/users')"), (e: any) => e.foreign === true);
  }
  assert.equal(run("operatorSession"), "zop_session");
  assert.equal(run("rejectedToken"), null);
  assert.notEqual(elements.authText.textContent, "Unauthorized");
});

await check("sign-in through a gate rejects instead of completing signed out", async () => {
  answer = () => GATE_PAGE;
  await assert.rejects(run("authPost('/api/admin/auth/login/challenge')"), (e: any) => e.foreign === true && /check before/.test(e.message));
  answer = () => ({ status: 200, body: { sessionToken: "zop_new" } });
  assert.equal((await run("authPost('/api/admin/auth/login', {})")).sessionToken, "zop_new", "Zold's own answer still passes");
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nadmin ui: all checks passed");
