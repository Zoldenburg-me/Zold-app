/**
 * The offline bar (public/app/core.js api → setReachable) shows only when
 * the network failed, never because the API itself answered 503.
 *
 * The API answers 503 for a partner that is down or a closed rail, with a
 * JSON body; the service worker answers 503 with `x-zold-offline: 1` when it
 * could not reach us at all. Only the second is "offline".
 *
 * Runs the real classic scripts in a vm with a stubbed fetch and bar.
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
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
};

const hidden = new Set<string>(["hidden"]);
const bar = { classList: { toggle: (c: string, on: boolean) => void (on ? hidden.add(c) : hidden.delete(c)) } };
const barShown = () => !hidden.has("hidden");

let answer: () => Promise<any> = () => Promise.reject(new TypeError("Failed to fetch"));
const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  AbortController,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, onLine: true },
  location: { pathname: "/app", search: "", hash: "", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: store(),
  sessionStorage: store(),
  fetch: () => answer(),
  document: {
    getElementById: (id: string) => (id === "offline-bar" ? bar : stub),
    querySelector: () => stub, querySelectorAll: () => [], addEventListener() {}, createElement: () => stub,
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["ui.js", "app/core.js"]) {
  vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
}
const call = () => vm.runInContext(`api("/api/payment-page", { handle: "tony" })`, ctx).then(() => null, (e: any) => e);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await check("an API 503 with a JSON body (partner down) leaves the bar hidden", async () => {
  answer = async () => response(503, { error: "could not be set up just now", code: "FORWARDER_UNAVAILABLE" });
  const e = await call();
  assert.equal(e.status, 503);
  assert.equal(e.offline, false);
  assert.equal(barShown(), false);
});

await check("the service worker's 503 (x-zold-offline) shows the bar", async () => {
  answer = async () => response(503, { error: "offline" }, { "x-zold-offline": "1" });
  const e = await call();
  assert.equal(e.offline, true);
  assert.equal(barShown(), true);
});

await check("the next answer from the API hides it again", async () => {
  answer = async () => response(200, { ok: true });
  assert.equal(await call(), null);
  assert.equal(barShown(), false);
});

await check("a fetch that never reached anyone shows the bar", async () => {
  answer = () => Promise.reject(new TypeError("Failed to fetch"));
  const e = await call();
  assert.equal(e.offline, true);
  assert.equal(barShown(), true);
});

console.log(`\n${passed} passed, 0 failed`);
