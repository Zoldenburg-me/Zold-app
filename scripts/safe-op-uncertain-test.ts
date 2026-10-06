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

// Every route that answers with this error logs the cause on the server.
for (const file of ["auth.ts", "recovery-candide.ts", "crypto-deposits.ts"]) {
  const src = readFileSync(new URL(`../services/api/src/routes/${file}`, import.meta.url), "utf8");
  assert.match(src, /console\.error\([^;]*err\.cause\)/, `${file} does not log the cause server-side`);
}
console.log("   ok  auth, recovery-candide and crypto-deposits log the cause server-side");

console.log("\nsafe-op-uncertain: 3/3 checks passed");
