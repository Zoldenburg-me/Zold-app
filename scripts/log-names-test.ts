/**
 * No personal name in a server log line (#155 slice B).
 *
 *   1. bookHolderLabel names a money-in holder by id only, for a person and
 *      for a company account, never by the user's or the org's name;
 *   2. a source guard: no console call under services/api/src interpolates a
 *      name field (`.name`, `.displayName`, `.legalName`, …). Error class
 *      names and Shopify order names (an order number like #1001) are the
 *      only names a log may print, by receiver;
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
const NAME_FIELD = /([\w$\])]+)\??\.(\w*[nN]ame)\b/g;
// receiver.field pairs that are not a person's or a company's name.
const ALLOWED = new Set(["err.name", "e.name", "o.name", "source.orderName"]);
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
  const call = /console\.(log|warn|error|info|debug)\s*\(/g;
  for (let m; (m = call.exec(src)); ) {
    let i = call.lastIndex;
    for (let depth = 1; i < src.length && depth; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls++;
    for (const n of src.slice(m.index, i).matchAll(NAME_FIELD)) {
      if (ALLOWED.has(`${n[1]}.${n[2]}`)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${path.relative(SRC, file)}:${line}: ${n[0]}`);
    }
  }
}
assert.ok(calls > 100, `the guard found the console calls (${calls})`);
assert.deepEqual(offenders, [], `a log call prints a name field:\n${offenders.join("\n")}`);

// The guard itself catches the shapes it exists for.
const caught = (s: string) => [...s.matchAll(NAME_FIELD)].some((n) => !ALLOWED.has(`${n[1]}.${n[2]}`));
assert.ok(caught("console.log(`for ${user.name}`)"));
assert.ok(caught("console.log(`for ${holder.org.name}'s account`)"));
assert.ok(caught("console.log(`for ${u?.displayName}`)"));
assert.ok(!caught("console.warn(`failed: ${err.name}`)"));

// 3. the issue-order line names its holder through the label.
const sandbox = readFileSync(path.join(SRC, "adapters/monerium-sandbox.ts"), "utf8");
assert.match(sandbox, /recorded issue order \$\{order\.id\} \(€\$\{amount\}\) for \$\{bookHolderLabel\(holder\)\}/);

console.log(`log-names: ${calls} console calls in ${files.length} files print no name field`);
