/**
 * The Monerium soft limit (adapters/monerium-limit.ts): calls are spaced at
 * MONERIUM_MAX_RPS, a call past it waits rather than being refused, a timeout
 * still ends a call stuck in the queue, and nothing reaches Monerium around it.
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

await check("every call to Monerium goes through the limiter", () => {
  for (const f of ["monerium-client.ts", "monerium-tokens.ts"]) {
    const src = readFileSync(new URL(`../services/api/src/adapters/${f}`, import.meta.url), "utf8");
    assert.equal(/(?<![A-Za-z])fetch\(/.test(src), false, `${f} calls fetch directly`);
    assert.match(src, /moneriumFetch\(/, `${f} should use moneriumFetch`);
  }
});

console.log(`\nMONERIUM RATE LIMIT TEST PASSED — ${passed} checks`);
console.log("NOT PROVEN HERE: Monerium's real limit. 40/s held for one 5 s burst on the sandbox (2026-10-04); production is untested.");
