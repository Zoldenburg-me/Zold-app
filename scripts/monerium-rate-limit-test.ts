/**
 * The Monerium soft limit (adapters/monerium-limit.ts): reads are spaced at
 * MONERIUM_MAX_RPS, a read past it waits rather than being refused, writes skip
 * the queue, a timeout still ends a call stuck in it, and nothing reaches
 * Monerium around it.
 * Offline: global fetch is stubbed.
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.MONERIUM_MAX_RPS = "40";
const { MONERIUM } = await import("../services/api/src/config/monerium.js");
const { slotScheduler, moneriumFetch } = await import("../services/api/src/adapters/monerium-limit.js");

let passed = 0;
const check = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  console.log(`   ok  ${name}`);
};

await check("the default is 40 requests a second", () => {
  assert.equal(MONERIUM.maxRequestsPerSecond, 40);
});

await check("a burst is spaced 25 ms apart at 40/s, and an idle limiter does not delay", () => {
  const wait = slotScheduler(40);
  const burst = Array.from({ length: 80 }, () => wait(1_000));
  assert.deepEqual(burst.slice(0, 4), [0, 25, 50, 75]);
  assert.equal(burst[79], 79 * 25, "the 80th call of a burst waits just under 2 s");
  assert.equal(wait(10_000), 0, "after the queue drains, a call goes at once");
});

await check("calls past the limit wait for their slot; none is refused", async () => {
  const realFetch = globalThis.fetch;
  const sentAt: number[] = [];
  globalThis.fetch = (async () => {
    sentAt.push(Date.now());
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await new Promise((r) => setTimeout(r, 100)); // let any earlier slot pass
    const res = await Promise.all(Array.from({ length: 20 }, () => moneriumFetch("https://api.monerium.dev/auth/context")));
    assert.ok(res.every((r) => r.status === 200), "every call went through");
    const span = sentAt[sentAt.length - 1] - sentAt[0];
    assert.ok(span >= 19 * 25 - 10, `20 calls at 40/s span about 475 ms, took ${span} ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("a call whose timeout fires while it waits is refused without reaching Monerium", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await new Promise((r) => setTimeout(r, 100));
    const queue = Array.from({ length: 40 }, () => moneriumFetch("https://api.monerium.dev/auth/context"));
    const late = moneriumFetch("https://api.monerium.dev/auth/context", { signal: AbortSignal.timeout(50) });
    await assert.rejects(late, /abort|timeout/i);
    await Promise.all(queue);
    assert.equal(calls, 40, "the timed-out call never went out");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("a write (POST) goes out at once, even behind a full queue of reads", async () => {
  const realFetch = globalThis.fetch;
  const sent: { method: string; at: number }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", at: Date.now() });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    const reads = Array.from({ length: 40 }, () => moneriumFetch("https://api.monerium.dev/orders"));
    await moneriumFetch("https://api.monerium.dev/orders", { method: "POST", body: "{}" });
    const post = sent.find((s) => s.method === "POST")!;
    assert.ok(post.at - start < 50, `the POST waited ${post.at - start} ms behind reads`);
    assert.ok(sent.filter((s) => s.method === "GET").length < 40, "reads were still queued when the POST went");
    await Promise.all(reads);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("every call to Monerium goes through the limiter", () => {
  for (const f of ["monerium-client.ts", "monerium-tokens.ts"]) {
    const src = readFileSync(new URL(`../services/api/src/adapters/${f}`, import.meta.url), "utf8");
    assert.equal(/(?<![A-Za-z])fetch\(/.test(src), false, `${f} calls fetch directly`);
    assert.match(src, /moneriumFetch\(/, `${f} should use moneriumFetch`);
  }
});

const { refusalAlarm, routeForLog } = await import("../services/api/src/adapters/monerium-refusals.js");

await check("a burst of 401/403 from Monerium warns once, at the threshold, and again only after a quiet window", () => {
  const warned: string[] = [];
  const alarm = refusalAlarm({ threshold: 5, windowMs: 60_000, warn: (m) => warned.push(m) });
  for (let i = 0; i < 4; i++) alarm.record(401, "GET", "https://api.monerium.dev/profiles", 1_000 + i);
  assert.equal(warned.length, 0, "four refusals are not a burst");
  alarm.record(403, "GET", "https://api.monerium.dev/orders", 1_010);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /5 refusals \(401\/403\) from Monerium in 60 s/);
  for (let i = 0; i < 10; i++) alarm.record(401, "GET", "https://api.monerium.dev/profiles", 2_000 + i);
  assert.equal(warned.length, 1, "one warning per burst");
  for (let i = 0; i < 5; i++) alarm.record(401, "POST", "https://api.monerium.dev/auth/token", 200_000 + i);
  assert.equal(warned.length, 2, "a later burst warns again");
});

await check("only 401 and 403 count; refusals spread out over time never add up to a burst", () => {
  const warned: string[] = [];
  const alarm = refusalAlarm({ threshold: 3, windowMs: 1_000, warn: (m) => warned.push(m) });
  for (const s of [200, 400, 404, 429, 500, 503]) alarm.record(s, "GET", "https://api.monerium.dev/x", 10);
  for (let i = 0; i < 10; i++) alarm.record(401, "GET", "https://api.monerium.dev/x", i * 2_000);
  assert.equal(warned.length, 0);
});

await check("the warning names the route with ids, IBANs and the query removed, never a credential", () => {
  assert.equal(routeForLog("https://api.monerium.dev/ibans/DE89370400440532013000?token=abc"), "/ibans/:id");
  assert.equal(routeForLog("https://api.monerium.dev/profiles/3f2c1a9e-0b1d-4c55-9a0e-1d2c3b4a5f60/addresses"), "/profiles/:id/addresses");
  assert.equal(routeForLog("not a url"), "(unparsed)");
  const warned: string[] = [];
  const alarm = refusalAlarm({ threshold: 1, windowMs: 1_000, warn: (m) => warned.push(m) });
  alarm.record(401, "PATCH", "https://api.monerium.dev/ibans/DE89370400440532013000?client_secret=fake", 0);
  assert.match(warned[0], /PATCH \/ibans\/:id \(401\)/);
  assert.ok(!warned[0].includes("DE89") && !warned[0].includes("fake"));
});

await check("every Monerium response passes through the alarm", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warned: string[] = [];
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  console.warn = (m: string) => warned.push(m);
  try {
    for (let i = 0; i < 5; i++) await moneriumFetch("https://api.monerium.dev/auth/token", { method: "POST" });
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  assert.equal(warned.filter((m) => m.includes("401/403")).length, 1);
});

console.log(`\nMONERIUM RATE LIMIT TEST PASSED — ${passed} checks`);
console.log("NOT PROVEN HERE: Monerium's real limit. 40/s held for one 5 s burst on the sandbox (2026-10-04); production is untested.");
