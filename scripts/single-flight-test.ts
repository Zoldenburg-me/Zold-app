/**
 * Sweeps are single-flight (services/api/src/single-flight.ts): a tick held
 * open past its interval makes the next tick do nothing, and every sweep
 * server.ts schedules goes through it.
 *
 * Offline.  npm run single-flight:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { singleFlight } from "../services/api/src/single-flight.js";

let runs = 0;
let letGo!: () => void;
const sweep = singleFlight("test-sweep", async () => {
  runs++;
  await new Promise<void>((r) => (letGo = r));
  return runs;
});
const first = sweep();
assert.equal(await sweep(), undefined, "a tick while the last one runs does nothing");
assert.equal(await singleFlight("test-sweep", async () => 99)(), undefined, "the flag is the job's, whatever wraps it");
assert.equal(await singleFlight("other-sweep", async () => 7)(), 7, "another job runs");
letGo();
assert.equal(await first, 1);
const again = sweep();
letGo();
assert.equal(await again, 2, "once it has finished, the next tick runs");
const failing = singleFlight("failing-sweep", async () => {
  throw new Error("tick failed");
});
await assert.rejects(failing(), /tick failed/);
await assert.rejects(failing(), /tick failed/, "a tick that threw releases the flag");
console.log("ok - a tick held open past its interval makes the next one do nothing; a finished or failed tick frees the job");

// Every interval in server.ts runs a single-flight job or a sweep with its
// own flag. The pollers keep theirs (`busy`, adapters/crypto-deposits.ts and
// adapters/monerium-sandbox.ts), and the verifier sweep has `sweeping`.
const server = readFileSync(path.resolve(import.meta.dirname, "../services/api/src/server.ts"), "utf8");
const ticks = [...server.matchAll(/setInterval\(\s*([\s\S]*?),\s*[\w.* ]+\)\.unref\(\)/g)].map((m) => m[1].replace(/\s+/g, " "));
assert.ok(ticks.length >= 12, `found ${ticks.length} intervals`);
const singleFlightNames = new Set([...server.matchAll(/const (\w+) = singleFlight\(/g)].map((m) => m[1]));
const runners = new Map([...server.matchAll(/const (run\w+) = (?:async )?\(\) =>\s*(?:\{\s*try \{ await )?(\w+)\(/g)].map((m) => [m[1], m[2]]));
const bare: string[] = [];
for (const tick of ticks) {
  const called = /^(\w+)$/.test(tick) ? runners.get(tick) : /(?:^|\s)(\w+)\(\)/.exec(tick)?.[1];
  if (!called || !singleFlightNames.has(called)) bare.push(tick.slice(0, 80));
}
assert.deepEqual(bare, [], "every interval in server.ts is single-flight");
console.log(`ok - all ${ticks.length} intervals in server.ts run single-flight jobs`);
