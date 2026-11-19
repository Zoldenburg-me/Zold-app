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

// #203 L1: an IBAN is bounded by its country's length and its groups of four.
assert.equal(redactPii("IBAN DE89 3704 0044 0532 0130 00 INVALID"), "IBAN DE89…3000 INVALID");
assert.equal(redactPii("DE89 3704 0044 0532 0130 00 and more words"), "DE89…3000 and more words");
assert.equal(redactPii("BE68 5390 0754 7034 FAIL"), "BE68…7034 FAIL");
assert.equal(redactPii("NO93 8601 1117 947 closed"), "NO93…7947 closed");
assert.equal(redactPii("MT84 MALT 0110 0001 2345 MTLC AST0 01S rejected"), "MT84…001S rejected");
assert.equal(redactPii("(DE89370400440532013000)"), "(DE89…3000)");
for (const line of ["ref DE123456789012345 paid", "DE89370400440532013000ABC"]) {
  assert.equal(redactPii(line), line, `masked a non-IBAN: ${line}`);
}
console.log("   ok  an IBAN stops at its country's length; the next word and a short reference stay");

// #206: either case is an IBAN; one of the right shape that fails mod-97 is not.
assert.equal(redactPii("iban de89370400440532013000 refused"), "iban de89…3000 refused");
assert.equal(redactPii("iban De89 3704 0044 0532 0130 00 refused"), "iban De89…3000 refused");
assert.equal(redactPii("iban fr14 2004 1010 0505 0001 3m02 606 refused"), "iban fr14…2606 refused");
assert.equal(redactPii("iban GB82WEST12345698765432 refused"), "iban GB82…5432 refused");
for (const line of ["ref DE12345678901234567890 paid", "ref DE00 1234 5678 9012 3456 78 paid", "ref de88370400440532013000 paid"]) {
  assert.equal(redactPii(line), line, `masked a reference that fails mod-97: ${line}`);
}
console.log("   ok  an IBAN in any case is masked; a reference of an IBAN's shape that fails mod-97 stays");


// #203 L2: national, 00-prefixed and bracketed phones; plus-addressed, percent, uppercase and quoted emails.
const phones: Array<[string, string]> = [
  ["call +49 (0)30 1234567 now", "call +•••••••••567 now"],
  ["call 0049-30-1234567 now", "call +••••••••••567 now"],
  ["call 030/1234567 now", "call +•••••••567 now"],
  ["call (030) 123 4567 now", "call +•••••••567 now"],
  ["call +1 (555) 123-4567 now", "call +••••••••567 now"],
  ["(tel +49 151 12345678)", "(tel +••••••••••678)"],
  ["+49 151 12345678 1795048251 at", "+••••••••••678 1795048251 at"],
];
for (const [raw, want] of phones) assert.equal(redactPii(raw), want, raw);
const emails: Array<[string, string]> = [
  ["to ada+zold@example.com", "to ad••••••@example.com"],
  ["to foo%bar@example.com", "to fo•••••@example.com"],
  ["to ADA@EXAMPLE.COM.", "to AD•@EXAMPLE.COM."],
  ['to "ada@example.com" and <bo@sub.example.org>', 'to "ad•@example.com" and <b•@sub.example.org>'],
  ["to [ada.l@example.co.uk], (ada@example.com)", "to [ad•••@example.co.uk], (ad•@example.com)"],
];
for (const [raw, want] of emails) assert.equal(redactPii(raw), want, raw);
assert.equal(describeCause(new Error("to Ada.L+x@Mail.Example.COM")), "Error: to Ad•••••@<host>");
console.log("   ok  national, 00-prefixed and bracketed phones and plus, percent, uppercase and quoted emails are masked");

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
  "settled 2026-11-19T12:05:30Z, due 05-11-2026 and 05/11/2026",
  "order 000123456 and id 0301234567 and 0.0012345678 ETH",
  "amount 1,234,567.89 EUR, nonce 00042",
  "hash 0xdeadbeef00491234567890 and uuid 0049abcd-3012-4567-8901-234567890123",
  "v0.12.3 at 12:00, 3 of 10 - 1234567 left",
];
for (const line of keep) {
  assert.equal(redactPii(line), line, `masked a non-PII line: ${line}`);
  assert.equal(redactedMessage(new Error(line)), line);
  // describeCause also replaces bare hosts, and a dotted field path reads as one.
  if (!line.includes("counterpart.")) assert.equal(describeCause(new Error(line)), `Error: ${line}`);
}
console.log("   ok  amounts, block numbers, dates, timestamps, tx hashes, 0x addresses and ids are not masked");

// Masking runs after the line is cut to MAX_LOGGED, so a huge echoed body stays cheap.
const t0 = Date.now();
describeCause(new Error("DE89 ".repeat(50_000) + "a.".repeat(50_000) + "@" + "+1 ".repeat(50_000)));
redactedMessage(new Error("x".repeat(200_000) + "@"));
redactPii("+1" + "1".repeat(498) + "x");
redactPii("0049" + " 1".repeat(248) + "x");
redactPii("DE89" + " ABCD".repeat(100) + "x");
assert.ok(Date.now() - t0 < 1000, "masking a long message is bounded");
console.log("   ok  masking is bounded on a long message");

// The token-list warning logs the origin and a redacted message, not the raw URL or error.
const tokenLists = readFileSync(new URL("../services/api/src/wallet-sync/token-lists.ts", import.meta.url), "utf8");
assert.match(tokenLists, /console\.warn\(`token list \$\{urlForLog\(url\)\}: \$\{why\}/);
assert.match(tokenLists, /const why = e instanceof Error \? redactedMessage\(e\)/);
console.log("   ok  the token-list warning logs urlForLog(url) and redactedMessage(e)");

console.log("log-pii: ok");
