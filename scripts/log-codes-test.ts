/**
 * No payment code in a server log line (#226).
 *
 * A payment code with its payee handle opens the public pay page, so it is a
 * credential (AGENTS.md) and a log names the request by its id instead. This
 * is a source guard over every console call under services/api/src (multi-line
 * arguments included). A call fails if its code
 *   - formats a code: `displayCode(`, `normaliseCode(`;
 *   - reads a `.code` field, unless the receiver is an error or a refusal
 *     (`err?.code`, `e.code`, `refusal.code` are error codes, not credentials);
 *   - names a bare `code`, `requestCode`, `paymentCode` or `payCode`.
 * A value hashed by `redact(…)` (audit.ts) may be printed.
 * It reads source text, so it does not see a code reached through another
 * variable (`const ref = r.code; log(ref)`).
 *
 * Run: npm run log-codes:test
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/api/src");

// The code of a call with string text blanked and `${…}` kept, so a word
// inside a message ("code missing") is not an identifier.
function codeOf(s: string): string {
  let out = "";
  const stack: string[] = []; // open quotes; "}" marks a `${` we are inside
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const q = stack[stack.length - 1];
    if (q === '"' || q === "'" || q === "`") {
      if (ch === "\\") { out += "  "; i++; continue; }
      if (ch === q) { stack.pop(); out += ch; continue; }
      if (q === "`" && ch === "$" && s[i + 1] === "{") { stack.push("}"); out += "${"; i++; continue; }
      out += ch === "\n" ? ch : " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") stack.push(ch);
    else if (ch === "{") stack.push("{");
    else if (ch === "}" && (q === "}" || q === "{")) stack.pop();
    out += ch;
  }
  return out;
}

const FORMATTER = /\b(displayCode|normaliseCode)\s*\(/g;
const CODE_FIELD = /([\w$\])]+)\??\.code\b/g;
const ERROR_RECEIVER = new Set(["err", "e", "error", "cause", "refusal"]);
const BARE_CODE = /(?<![\w$.])(code|requestCode|paymentCode|payCode)\b(?!\s*:(?!:))/g;
// redact(x) prints a hash; one level of nested parentheses is enough here.
const REDACTED = /\bredact\(([^()]|\([^()]*\))*\)/g;

function codeHits(callText: string): string[] {
  const code = codeOf(callText).replace(REDACTED, "");
  const hits: string[] = [];
  for (const m of code.matchAll(FORMATTER)) hits.push(m[0]);
  for (const m of code.matchAll(CODE_FIELD)) if (!ERROR_RECEIVER.has(m[1])) hits.push(m[0]);
  for (const m of code.matchAll(BARE_CODE)) hits.push(m[0]);
  return hits;
}

const files: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
};
walk(SRC);
assert.ok(files.length > 50, "the guard walked the API source");

/** The end of a call whose "(" is just before `start`: the index of its ")".
 *  Parentheses in string text ("closed (x)") do not count. */
function callEnd(s: string, start: number): number {
  const stack: string[] = []; // as in codeOf
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    const q = stack[stack.length - 1];
    if (q === '"' || q === "'" || q === "`") {
      if (ch === "\\") i++;
      else if (ch === q) stack.pop();
      else if (q === "`" && ch === "$" && s[i + 1] === "{") { stack.push("}"); i++; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") stack.push(ch);
    else if (ch === "{") stack.push("{");
    else if (ch === "}" && (q === "}" || q === "{")) stack.pop();
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return s.length;
}

/** Every console call in a source file: `line: hit` for each code it prints. */
function scan(src: string): { calls: number; hits: string[] } {
  const hits: string[] = [];
  let calls = 0;
  const call = /console\.(log|warn|error|info|debug)\s*\(/g;
  for (let m; (m = call.exec(src)); ) {
    calls++;
    for (const hit of codeHits(src.slice(call.lastIndex, callEnd(src, call.lastIndex)))) {
      hits.push(`${src.slice(0, m.index).split("\n").length}: ${hit}`);
    }
  }
  return { calls, hits };
}

const offenders: string[] = [];
let calls = 0;
for (const file of files) {
  const rel = path.relative(SRC, file).split(path.sep).join("/");
  const found = scan(readFileSync(file, "utf8"));
  calls += found.calls;
  for (const hit of found.hits) offenders.push(`${rel}:${hit}`);
}
assert.ok(calls > 100, `the guard found the console calls (${calls})`);
assert.deepEqual(offenders, [], `a log call prints a payment code:\n${offenders.join("\n")}`);

// The guard itself catches the shapes it exists for, and nothing else.
const caught = (s: string) => codeHits(s).length > 0;
assert.ok(caught("`paid hook failed for ${displayCode(saved.code)}: ${describeCause(e)}`"));
assert.ok(caught("`pay-request: ${displayCode(\n  saved.code,\n)} received`"), "multi-line");
assert.ok(caught("`for ${normaliseCode(text)}`"));
assert.ok(caught("`for ${r.code}`"));
assert.ok(caught("`for ${saved?.code}`"));
assert.ok(caught("`for ${link.request.code}`"));
assert.ok(caught("\"request\", code"));
assert.ok(caught("{ code }"));
assert.ok(caught("`for ${requestCode}`"));
assert.ok(!caught("`for ${r.id} (${redact(displayCode(r.code))})`"), "a hashed code");
assert.ok(!caught("`for ${redact(r.code)}`"));
assert.ok(!caught("`paid hook failed for ${r.id}: ${describeCause(e)}`"));
assert.ok(!caught("`failed: ${err?.code ?? \"error\"} (SMTP ${err.responseCode})`"));
assert.ok(!caught("`write failed (${e?.code ?? e?.name})`"));
assert.ok(!caught("`refused (${refusal.code})`"));
assert.ok(!caught("\"code missing\""), "a word in a message");
assert.ok(!caught("{ code: \"INSTALL_OTHER_BROWSER\" }"), "an object key");
assert.ok(!caught("`${statusCode} ${responseCode} had ${b.codesIssued}`"));

// Through the scan: a ")" in a message does not end the call before the code.
assert.deepEqual(scan('console.log("refund :) sent", displayCode(r.code));').hits, ["1: displayCode(", "1: r.code"]);
assert.deepEqual(scan("console.error(`closed ) for ${r.id}`,\n  r.code);").hits, ["1: r.code"], "a template, over lines");
assert.deepEqual(scan("console.warn('it\\'s done (ok)', r.id); f(r.code);").hits, [], "the call ends at its own )");
assert.deepEqual(scan("console.log(`a ${f(\")\")} b`, payCode);").hits, ["1: payCode"], "a ) in a string inside ${}");

console.log(`log-codes: ${calls} console calls in ${files.length} files print no payment code`);
