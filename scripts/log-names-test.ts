/**
 * No personal name in a server log line (#155 slice B).
 *
 *   1. bookHolderLabel names a money-in holder by id only, for a person and
 *      for a company account, never by the user's or the org's name;
 *   2. a source guard: no console call under services/api/src prints a
 *      person-shaped name, as a field (`.name`, `.displayName`, `.legalName`,
 *      `.payeeName`, …) or bare (`${name}`, `firstName` after a destructure),
 *      or a whole person or company object (`user`, `JSON.stringify(org)`).
 *      Other names (`fileName`, `chainName`) are not a person's and pass.
 *      Error class names anywhere, and Shopify order names (an order number
 *      like #1001) in routes/shopify.ts only, are the names a log may print.
 *      It reads source text, so it does not see a name or a person reached
 *      through another variable (`const who = user.name; log(who)`, or an
 *      alias `const u = user; log(u)`) or by bracket lookup (`user["name"]`);
 *   3. the Monerium issue-order line goes through bookHolderLabel.
 *
 * Run: npm run log-names:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-log-names-")), "db.json");
process.env.TRANSF_CHAIN_ID = "84532";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:1"; // nothing here reads the chain

const { bookHolderLabel } = await import("../services/api/src/bookkeeping/money-in.js");

// 1. ids only.
const user = { id: "u_ada", name: "Ada Lovelace", address: "0x00000000000000000000000000000000000000a1" } as any;
const org = { id: "org_acme", name: "Acme Analytical Engines GmbH" } as any;
const account = { id: "acc_acme", orgId: "org_acme", address: "0x00000000000000000000000000000000000000b2" } as any;
assert.equal(bookHolderLabel({ kind: "user", user }), "user:u_ada");
assert.equal(bookHolderLabel({ kind: "account", account, org }), "account:acc_acme");
for (const label of [bookHolderLabel({ kind: "user", user }), bookHolderLabel({ kind: "account", account, org })]) {
  assert.ok(!/Ada|Lovelace|Acme/.test(label), `a holder label carries no name: ${label}`);
}

// 2. source guard over every console call (multi-line arguments included).
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/api/src");

// The code of a call with string text blanked and `${…}` kept, so a word
// inside a message ("name missing") is not an identifier.
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

// Three rules, each over the code of one console call:
//   a name field:  `user.name`, `holder.org.legalName`, `u?.displayName`;
//   a bare name:   `name`, `firstName`, `legalName` (a destructured name);
//   (both only when person-shaped: `name` itself, or a prefix that names a
//   person, a company or an order, so `fileName` and `chainName` pass);
//   a whole person or company object as a value: `user`, `req.user`,
//   `JSON.stringify(org)`, `{ member }` (but `user.id` is fine).
const NAME_FIELD = /([\w$\])]+)\??\.(\w*[nN]ame)\b/g;
const BARE_NAME = /(?<![\w$.])(\w*[nN]ame)\b(?!\s*:(?!:))/g;
const PERSON = "user|users|member|members|holder|org|orgs|organization|customer|sender|recipient|payee|beneficiary|owner|guardian|profile|person|contact|company";
// What comes before "name" in a person-shaped name. `order` is here so an
// order name is caught outside routes/shopify.ts, bare as well as a field.
// The payment-side roles are prefixes only, not whole-object values, so a
// bare `tenant` or `director` is not read as a person.
const PERSON_PREFIX = new RegExp(`(^|${PERSON}|first|last|full|legal|display|given|family|middle|nick|sur|account|merchant|business|trade|party|payer|receiver|signer|client|employee|partner|supplier|vendor|contractor|buyer|seller|debtor|creditor|landlord|tenant|representative|director|order)$`, "i");
const personShaped = (id: string) => PERSON_PREFIX.test(id.slice(0, -4));
const PERSON_VALUE = new RegExp(`(?<![\\w$])(${PERSON})\\b(?!\\s*(\\?\\.|\\.|\\[|:(?!:)))`, "g");
// Names that are not a person's or a company's, by receiver or identifier.
const ALLOWED = new Set(["err.name", "e.name", "error.name"]);
// Shopify's order name is an order number (#1001), not a person: allowed in
// that file only, so `o.name` anywhere else is caught.
const ALLOWED_IN: Record<string, Set<string>> = { "routes/shopify.ts": new Set(["o.name", "source.orderName", "orderName"]) };
// A person handed to a formatter that prints an id or an address only.
const ID_ONLY = /\b(bookHolderLabel|passkeyAccountAddress)\(\s*\w+\s*\)/g;

function nameHits(callText: string, file = ""): string[] {
  const code = codeOf(callText).replace(ID_ONLY, "");
  const allowed = (k: string) => ALLOWED.has(k) || ALLOWED_IN[file]?.has(k);
  const hits: string[] = [];
  for (const n of code.matchAll(NAME_FIELD)) if (personShaped(n[2]) && !allowed(`${n[1]}.${n[2]}`)) hits.push(n[0]);
  for (const n of code.matchAll(BARE_NAME)) if (personShaped(n[1]) && !allowed(n[1])) hits.push(n[0]);
  for (const n of code.matchAll(PERSON_VALUE)) hits.push(n[0]);
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

const offenders: string[] = [];
let calls = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = path.relative(SRC, file).split(path.sep).join("/");
  const call = /console\.(log|warn|error|info|debug)\s*\(/g;
  for (let m; (m = call.exec(src)); ) {
    let i = call.lastIndex;
    for (let depth = 1; i < src.length && depth; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls++;
    for (const hit of nameHits(src.slice(call.lastIndex, i - 1), rel)) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${rel}:${line}: ${hit}`);
    }
  }
}
assert.ok(calls > 100, `the guard found the console calls (${calls})`);
assert.deepEqual(offenders, [], `a log call prints a name or a person:\n${offenders.join("\n")}`);

// The guard itself catches the shapes it exists for, and nothing else.
const caught = (s: string, file = "") => nameHits(s, file).length > 0;
// name fields
assert.ok(caught("`for ${user.name}`"));
assert.ok(caught("`for ${holder.org.name}'s account`"));
assert.ok(caught("`for ${u?.displayName}`"));
assert.ok(caught("`org ${o.name}`"), "o.name outside Shopify");
assert.ok(caught("`org ${o.name}`", "routes/business.ts"));
assert.ok(!caught("`shopify: order ${o.name} at ${c.shop}`", "routes/shopify.ts"));
assert.ok(!caught("`failed: ${err.name}`"));
// bare (destructured) names
assert.ok(caught("`for ${name}`"));
assert.ok(caught("`hello ${firstName} ${lastName}`"));
assert.ok(caught("\"payee\", legalName"));
assert.ok(caught("{ name }"));
assert.ok(!caught("\"name missing\""), "a word in a message");
assert.ok(!caught("{ name: \"x\" }"), "an object key");
// whole person/company objects
assert.ok(caught("user"));
assert.ok(caught("\"member\", member"));
assert.ok(caught("JSON.stringify(org)"));
assert.ok(caught("`req ${req.user}`"));
assert.ok(caught("{ holder }"));
assert.ok(caught("\"x\", users"));
// non-PII stays clean
assert.ok(!caught("`user ${user.id} order ${order.id} (€${amount}) tx ${sha}`"));
assert.ok(!caught("`org ${org?.id} member ${member.userId}`"));
assert.ok(!caught("{ user: user.id, transferId }"));
assert.ok(!caught("\"user not found\", err"));
assert.ok(!caught("`${userId} ${orgId} ${usersCount}`"));
assert.ok(!caught("`for ${bookHolderLabel(holder)}`"));
assert.ok(caught("`for ${bookHolderLabel(holder)} ${holder}`"));
assert.ok(caught("`order ${r.source.orderName}`", "routes/business.ts"), "orderName outside Shopify");
// only person-shaped names: a file, chain or bare Shopify order name passes
assert.ok(!caught("`wrote ${fileName}`"));
assert.ok(!caught("`rpc for ${chainName} (${cfg.chainName})`"));
assert.ok(!caught("`shopify: order ${orderName} at ${shop}`", "routes/shopify.ts"));
assert.ok(caught("`order ${orderName}`", "routes/business.ts"), "bare orderName outside Shopify");
for (const id of ["firstName", "lastName", "legalName", "displayName", "userName", "username", "fullName", "payeeName", "accountHolderName", "companyName", "partnerName", "holderName", "vendorName", "debtorName", "creditorName"]) {
  assert.ok(caught(`\`for \${${id}}\``), `bare ${id}`);
  assert.ok(caught(`\`for \${x.${id}}\``), `field ${id}`);
}
assert.ok(caught("`partner ${p.partnerName}`"), "p.partnerName");
assert.ok(caught("`holder ${p.holderName}`"), "p.holderName");

// 3. the issue-order line names its holder through the label.
const sandbox = readFileSync(path.join(SRC, "adapters/monerium-sandbox.ts"), "utf8");
assert.match(sandbox, /recorded issue order \$\{order\.id\} \(€\$\{amount\}\) for \$\{bookHolderLabel\(holder\)\}/);

console.log(`log-names: ${calls} console calls in ${files.length} files print no name or person`);
