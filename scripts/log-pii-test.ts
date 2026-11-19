/**
 * Log lines mask personal data a provider's error echoes (#155): an email, an
 * IBAN, a phone. describeCause, redactedMessage, callFrames and describeError
 * all mask; amounts, block numbers, tx hashes, 0x addresses and order ids stay.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  callFrames,
  describeCause,
  describeError,
  maskEmail,
  maskIban,
  maskPhone,
  redactPii,
  redactedMessage,
} from "../services/api/src/http/log-cause.js";
import { urlForLog } from "../services/api/src/http/log-safe.js";

const RAW = "IBAN DE89 3704 0044 0532 0130 00 rejected for ada@example.com, +49 151 12345678";
const LEAKS = ["DE89 3704 0044 0532 0130 00", "DE89370400440532013000", "ada@example.com", "+49 151 12345678", "12345678"];
const MASKS = ["DE89…3000", "ad•@example.com", "+••••••••••678"];

function assertMasked(line: string, where: string): void {
  for (const leak of LEAKS) assert.ok(!line.includes(leak), `${where} leaks ${leak}: ${line}`);
  for (const mask of MASKS) assert.ok(line.includes(mask), `${where} lacks ${mask}: ${line}`);
}

assert.equal(maskEmail("ada@example.com"), "ad•@example.com");
assert.equal(maskEmail("a@example.com"), "a•@example.com");
assert.equal(maskIban("DE89 3704 0044 0532 0130 00"), "DE89…3000");
assert.equal(maskIban("NL91ABNA0417164300"), "NL91…4300");
assert.equal(maskPhone("+49 151 12345678"), "+••••••••••678");
console.log("   ok  maskEmail, maskIban and maskPhone keep only what identifies the kind");

const err = new Error(RAW);
assertMasked(describeCause(err), "describeCause");
assert.equal(describeCause(err), `Error: IBAN DE89…3000 rejected for ad•@example.com, +••••••••••678`);
assertMasked(redactedMessage(err), "redactedMessage");
assertMasked(redactedMessage(err, { keepHosts: true }), "redactedMessage keepHosts");
assertMasked(describeError(err), "describeError");
assertMasked(redactedMessage(RAW), "redactedMessage of a string");
console.log("   ok  the #155 example is masked through describeCause, redactedMessage and describeError");

// Compact and other-country IBANs; an email whose domain redactUrls already replaced.
assert.equal(redactPii("PATCH /ibans/DE89370400440532013000 refused"), "PATCH /ibans/DE89…3000 refused");
assert.equal(redactPii("FR14 2004 1010 0505 0001 3M02 606 unknown"), "FR14…2606 unknown");
assert.equal(describeCause(new Error("no account for bo.ross@mail.example.com")), "Error: no account for bo•••••@<host>");
assert.equal(redactPii("call +31612345678 or +44 20 7946 0958."), "call +••••••••678 or +•••••••••958.");
console.log("   ok  compact, spaced and non-German IBANs, multi-dot email domains and phones are masked");

// A stack frame keeps redacting its URL and masks what it carries.
const framed = new Error("boom");
framed.stack = [
  "Error: boom ada@example.com",
  "    at post (https://bundler.test/rpc/v3/8453/secret-key:12:5)",
  "    at check (file:///srv/app/ada@example.com/x.js:1:1)",
  "    at refuse (/srv/app/iban.ts:9:3) DE89370400440532013000",
].join("\n");
const frames = callFrames(framed);
assert.match(frames[0], /^at post \(<url>/);
assert.ok(frames.every((f) => !f.includes("secret-key") && !f.includes("ada@") && !f.includes("DE8937")), frames.join("\n"));
assert.ok(frames[2].includes("DE89…3000"), frames[2]);
assert.ok(!describeError(framed).includes("secret-key"));
console.log("   ok  a stack frame with a URL still redacts the URL, and masks the rest");

assert.equal(urlForLog("https://host.test/list?api-key=abc"), "https://host.test");
assert.equal(urlForLog("https://user:pw@host.test/k/abc"), "https://host.test");
console.log("   ok  urlForLog with an api key in the query or path returns the origin");

// Negatives: what a money log line is made of stays as written.
const tx = "0x" + "ab12".repeat(16);
const addr = "0x" + "De89".repeat(10);
const keep = [
  "fee 12.50 EUR, delivered 1234567.89",
  "block 12345678 at 1795048251",
  `tx ${tx} reverted`,
  `safe ${addr} has no owner`,
  "order 3f2a1c9e-4b7d-4e2a-9c1f-0d8e7b6a5f43 is pending",
  "order DE12 is pending",
  "balance delta +1000000000000000000 wei",
  "counterpart.identifier.iban is required",
  "2+2 = 4 and 10+12345678 lines",
];
for (const line of keep) {
  assert.equal(redactPii(line), line, `masked a non-PII line: ${line}`);
  assert.equal(redactedMessage(new Error(line)), line);
  // describeCause also replaces bare hosts, and a dotted field path reads as one.
  if (!line.includes("counterpart.")) assert.equal(describeCause(new Error(line)), `Error: ${line}`);
}
console.log("   ok  amounts, block numbers, tx hashes, 0x addresses and order ids are not masked");

// Masking runs after the line is cut to MAX_LOGGED, so a huge echoed body stays cheap.
const t0 = Date.now();
describeCause(new Error("DE89 ".repeat(50_000) + "a.".repeat(50_000) + "@" + "+1 ".repeat(50_000)));
redactedMessage(new Error("x".repeat(200_000) + "@"));
assert.ok(Date.now() - t0 < 1000, "masking a long message is bounded");
console.log("   ok  masking is bounded on a long message");

// The token-list warning logs the origin and a redacted message, not the raw URL or error.
const tokenLists = readFileSync(new URL("../services/api/src/wallet-sync/token-lists.ts", import.meta.url), "utf8");
assert.match(tokenLists, /console\.warn\(`token list \$\{urlForLog\(url\)\}: \$\{why\}/);
assert.match(tokenLists, /const why = e instanceof Error \? redactedMessage\(e\)/);
console.log("   ok  the token-list warning logs urlForLog(url) and redactedMessage(e)");

console.log("log-pii: ok");
