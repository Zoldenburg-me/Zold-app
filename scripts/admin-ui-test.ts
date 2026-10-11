/**
 * The admin dashboard's API client (public/admin/core.js), run as the
 * browser runs it: the real passkey.js and core.js in one script context,
 * with the DOM, storage, WebAuthn and fetch stubbed and recorded.
 *
 * - a change asks the server for a bound challenge, has the passkey sign it,
 *   and sends the answer with the change; a read or a ceremony asks nothing;
 * - with only the read-only token, a change is refused before any request;
 * - a 401 OPERATOR_SIGN_IN ends the session and says so; a 401 from Access
 *   leaves the session alone.
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

const elements: Record<string, any> = { operatorToken: { value: "" }, authPill: { className: "" }, authText: { textContent: "" } };
interface Call { path: string; method: string; headers: Record<string, string>; body?: string }
const calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
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
    return { status: a.status, ok: a.status < 400, json: async () => a.body };
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

await check("with only the read-only token, a change is refused before any request", async () => {
  run("setOperatorSession('')");
  elements.operatorToken.value = "read-only-token-for-the-ui-test-0123";
  await assert.rejects(run("api('/api/admin/orgs/o1/plan', { method: 'POST', body: '{}' })"), (e: any) => e.status === 403);
  assert.equal(calls.length, 0);
  elements.operatorToken.value = "";
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

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nadmin ui: all checks passed");
