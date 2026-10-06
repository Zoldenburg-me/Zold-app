/**
 * A Safe operation of unknown outcome is reported without its cause.
 *
 * The cause is whatever the bundler client threw, and a viem HTTP error names
 * the URL it called — the bundler URL, which can carry an API key. Three
 * routes return the error's message to the browser and one stores it as a
 * deposit's reason, so the message is a fixed sentence plus the hash, and the
 * cause is logged on the server only.
 *
 * Run: npm run safe-op-uncertain:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { SafeOperationUncertainError } = await import("../services/api/src/wallet/candide.js");

const KEY_URL = "https://api.bundler.example/v3/84532/sk_live_SECRET123";
const cause = new Error(`HTTP request failed.\n\nURL: ${KEY_URL}\nRequest body: {"method":"eth_sendUserOperation"}`);
const hash = `0x${"ab".repeat(32)}`;
const err = new SafeOperationUncertainError(hash, cause);

assert.ok(!err.message.includes("SECRET123"), `the message carries the cause: ${err.message}`);
assert.ok(!err.message.includes("bundler.example"), `the message names the bundler URL: ${err.message}`);
assert.ok(!JSON.stringify({ error: err.message }).includes("SECRET123"));
assert.ok(err.message.includes(hash), "the message names the operation hash");
assert.equal(err.userOpHash, hash);
assert.equal(err.cause, cause, "the cause stays on the error for server-side logging");
console.log("   ok  the message is a fixed sentence plus the hash; the cause is kept, not shown");

const text = new SafeOperationUncertainError(hash, "no receipt");
assert.ok(!text.message.includes("no receipt"));
console.log("   ok  a string cause is not shown either");

// The server log gets the cause's name and short message, never a URL.
const { describeCause } = await import("../services/api/src/http/log-cause.js");
const { HttpRequestError, InternalRpcError } = await import("viem");
const viemHttp = new HttpRequestError({ url: KEY_URL, body: { method: "eth_sendUserOperation" }, status: 500 });
for (const c of [viemHttp, cause, new InternalRpcError(viemHttp), `failed at ${KEY_URL}`, { name: "X", shortMessage: `at ${KEY_URL}` }]) {
  const line = describeCause(c);
  assert.ok(!line.includes("SECRET123"), `the log line carries the key: ${line}`);
  assert.ok(!line.includes("bundler.example"), `the log line names the bundler URL: ${line}`);
  assert.ok(!/https?:\/\//.test(line), `the log line carries a URL: ${line}`);
}
assert.match(describeCause(viemHttp), /^HttpRequestError: HTTP request failed\./);
assert.equal(describeCause(undefined), "no cause");
console.log("   ok  describeCause logs name and short message with every URL redacted");

// Every path that logs this error's cause logs it through describeCause.
for (const file of ["routes/auth.ts", "routes/recovery-candide.ts", "routes/crypto-deposits.ts", "orchestrator.ts"]) {
  const src = readFileSync(new URL(`../services/api/src/${file}`, import.meta.url), "utf8");
  assert.match(src, /console\.error\([^;]*describeCause\(err\.cause\)\)/, `${file} does not log the cause server-side`);
  assert.doesNotMatch(src, /console\.error\([^;]*,\s*err\.cause\)/, `${file} logs the raw cause`);
}
console.log("   ok  auth, recovery-candide, crypto-deposits and the orchestrator log the cause redacted");

console.log("\nsafe-op-uncertain: 3/3 checks passed");
