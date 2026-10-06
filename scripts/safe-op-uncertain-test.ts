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

// A host without a scheme carries the key just as well: Node's DNS and socket
// errors name the target bare, and some providers put the key in a subdomain.
for (const [raw, secret] of [
  ["getaddrinfo ENOTFOUND KEYSECRET.rpc.provider.io", "KEYSECRET"],
  ["getaddrinfo ENOTFOUND rpc.provider.io", "provider.io"],
  ["connect ECONNREFUSED 1.2.3.4:443", "1.2.3.4"],
  ["connect ECONNREFUSED 127.0.0.1:8545", "127.0.0.1"],
  ["request to host.tld/path/KEYSECRET failed", "KEYSECRET"],
  ["fetch failed at base-sepolia.g.alchemy.com/v2/KEYSECRET", "KEYSECRET"],
  ["socket hang up talking to node.example.com:8545", "node.example.com"],
] as const) {
  const line = describeCause(new Error(raw));
  assert.ok(!line.includes(secret), `the log line keeps ${secret}: ${line}`);
}
for (const plain of [
  "Error: The contract function \"transfer\" reverted. Details: insufficient balance.",
  "TransactionExecutionError: insufficient funds for gas * price + value.",
  "Error: refund failed, e.g. the Safe was empty. Retry later.",
  "Error: amount 12.50 EUR exceeds the cap of 1000.00 EUR",
]) {
  assert.equal(describeCause(plain), plain, "an ordinary sentence is logged as written");
}
console.log("   ok  describeCause redacts bare hosts, DNS and socket targets, and leaves sentences alone");

// Money-path logs of chain, bundler and RPC errors go through describeCause.
for (const [file, pattern] of [
  ["orchestrator.ts", /compensation failed for \$\{id\}: \$\{describeCause\(e\)\}/],
  ["orchestrator.ts", /sweep: compensation failed for \$\{t\.id\}: \$\{describeCause\(e\)\}/],
  ["server.ts", /Compensation sweep failed: \$\{describeCause\(e\)\}/],
  ["faucet.ts", /drip to \$\{to\} failed: \$\{describeCause\(err\)\}/],
  ["adapters/crypto-deposits.ts", /crypto-in poll failed: \$\{describeCause\(err\)\}/],
] as const) {
  const src = readFileSync(new URL(`../services/api/src/${file}`, import.meta.url), "utf8");
  assert.match(src, pattern, `${file} logs a raw error message`);
}
for (const file of ["orchestrator.ts", "faucet.ts", "adapters/crypto-deposits.ts", "routes/payment-page.ts", "routes/recovery-candide.ts", "routes/recovery-zoldenburg.ts"]) {
  const src = readFileSync(new URL(`../services/api/src/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(src, /console\.(error|warn)\([^;]*\$\{(e|err)\?\.message \?\? (e|err)\}/, `${file} still logs a raw error message`);
}
console.log("   ok  money-path chain and bundler errors are logged redacted");

{
  const { describeError, shortErrorForClient } = await import("../services/api/src/http/log-cause.js");
  for (const long of ["a-".repeat(50_000), "a.".repeat(50_000), `${"x-".repeat(40_000)}.example.io`]) {
    const t0 = Date.now();
    describeCause(new Error(long));
    describeError(new Error(long));
    assert.ok(Date.now() - t0 < 200, `redacting a ${long.length}-char line took ${Date.now() - t0} ms`);
  }
  console.log("   ok  a long hyphen or dot run is redacted in bounded time");

  const KEY = "key-in-path-not-real-0001";
  const viemErr = new HttpRequestError({ url: `https://bundler.example.io/rpc/${KEY}`, body: { method: "eth_sendUserOperation" } });
  const logged = describeError(viemErr);
  assert.ok(!logged.includes(KEY) && !logged.includes("bundler.example.io"), logged);
  assert.ok(!/Request body|URL:/.test(logged), `the message's URL and body lines reached the log: ${logged}`);
  assert.match(logged, /\n    at /, "the call frames are kept");
  console.log("   ok  a logged stack keeps its frames and drops the message's URL and body");

  const client = shortErrorForClient(viemErr);
  assert.ok(!client.includes(KEY), client);
  assert.equal(shortErrorForClient(new Error("Unexpected origin https://evil.example.io")), "Error: Unexpected origin <url>");
  assert.equal(shortErrorForClient(new Error("Unexpected RP ID hash for zoldhq.com")), "Error: Unexpected RP ID hash for zoldhq.com");
  console.log("   ok  the client message drops URLs and keeps a bare origin name");
}

for (const file of ["http/error-log.ts", "server.ts", "routes/recovery-candide.ts", "routes/recovery-zoldenburg.ts"]) {
  const src = readFileSync(new URL(`../services/api/src/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(src, /console\.error\([^;]*\.stack\b/, `${file} logs a raw stack`);
  assert.doesNotMatch(src, /json\(\{ error: (String\(\(err as any\)\?\.message|message\.slice)/, `${file} sends a raw error message to the client`);
}
console.log("   ok  route error logs and recovery 503s never carry a raw stack or message");

console.log("\nsafe-op-uncertain: 9/9 checks passed");
