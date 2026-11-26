/**
 * Source gates for the async store (docs/postgres-store-design.md §2 rule 2
 * and §3), the same way the other grep suites work:
 *
 *   1. Outside store.ts and store/, no patch is built from a sub-object or
 *      array of a row read earlier: `...user.passkeySafe`, `...user.monerium`,
 *      `...t.sepa`, `...org.invoicing`, `...org.integrations`,
 *      `...draft.activity`, a written `payments` or `settlements`. Those go
 *      through patchUserSub / patchOrgSub / patchTransferSub /
 *      appendDraftActivity / recordPaymentRequestPayment / settleInvoice,
 *      which change the value on the row as stored. A transfer's `txs` is
 *      merged into the stored log by updateTransfer itself, on both backends.
 *   2. No partner or chain I/O inside a `store.tx` callback: a transaction
 *      does not span I/O we do not own. Enforced at run time (refuseInTx);
 *      this checks the guard is in place, and that a callback that answers
 *      awaits nothing after it.
 *   3. `batched` and the sync `persist` are gone from callers.
 *   4. server.ts takes the one-process start lock before anything else.
 *
 * No chain, no network.  npm run store-gates:test
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "services/api/src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(ROOT, p);
const outsideStore = files(SRC).filter((p) => !p.endsWith("/store.ts") && !p.includes("/store/"));
const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

let n = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`${++n}. ${label}`);
  } catch (err: any) {
    failures.push(`${label}: ${err?.message ?? err}`);
    console.log(`${++n}. FAILED — ${label}: ${err?.message ?? err}`);
  }
};

/** Every match of `re` in the files, as file:line. */
function hits(paths: string[], re: RegExp): string[] {
  return paths.flatMap((p) => {
    const text = readFileSync(p, "utf8");
    return [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map(
      (m) => `${rel(p)}:${lineOf(text, m.index!)}: ${m[0].replace(/\s+/g, " ").slice(0, 80)}`,
    );
  });
}

// ── 1. Sub-objects and arrays change on the stored row ─────────────────────
/** The argument text of each store write call, by paren matching. */
function storeWrites(text: string): { at: number; args: string }[] {
  const out: { at: number; args: string }[] = [];
  for (const m of text.matchAll(/\bstore\.(?:update|add|patch|record|settle|start|append)\w*\(/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push({ at: m.index!, args: text.slice(open, i + 1) });
  }
  return out;
}
const SPREADS: [string, string][] = [
  ["passkeySafe", "passkeySafe"],
  ["monerium", "monerium"],
  ["sepa", "sepa"],
  ["invoicing", "invoicing"],
  ["integrations", "integrations"],
  ["activity", "activity"],
];
for (const [what, key] of SPREADS) {
  check(`no store write outside the store spreads a ${what} read earlier`, () => {
    const spread = new RegExp(`\\.\\.\\.\\(?\\s*[\\w.]+[!?]?\\.${key}\\b`);
    const assigned = new RegExp(`\\b\\w+\\.${key}\\s*=\\s*\\{\\s*\\.\\.\\.\\(?\\s*[\\w.]+[!?]?\\.${key}\\b`, "g");
    const found: string[] = [];
    for (const p of outsideStore) {
      const text = readFileSync(p, "utf8");
      for (const { at, args } of storeWrites(text)) {
        const m = args.match(spread);
        if (m) found.push(`${rel(p)}:${lineOf(text, at)}: ${m[0]}`);
      }
      for (const m of text.matchAll(assigned)) found.push(`${rel(p)}:${lineOf(text, m.index!)}: ${m[0].replace(/\s+/g, " ")}`);
    }
    assert.deepEqual(found, []);
  });
}
check("outside the store, passkeySafe changes go through patchUserSub; updateUser writes only a new plan", () => {
  // The two whole writes that replace the plan with a new one: a passkey's
  // first plan, and an imported Safe. Any other would erase a field another
  // writer put there since the row was read.
  const allowed = new Set(["services/api/src/routes/auth.ts: plannedSafe", "services/api/src/routes/safe-import.ts: {"]);
  const found: string[] = [];
  for (const p of outsideStore) {
    const text = readFileSync(p, "utf8");
    for (const { at, args } of storeWrites(text)) {
      if (!text.startsWith("store.updateUser(", at)) continue;
      const m = /\bpasskeySafe\s*:\s*(\{|[\w.]+)/.exec(args);
      if (m && !allowed.has(`${rel(p)}: ${m[1]}`)) found.push(`${rel(p)}:${lineOf(text, at)}: passkeySafe: ${m[1]}`);
    }
  }
  assert.deepEqual(found, []);
});
check("no payment request's payments and no invoice's settlements are written whole outside the store", () => {
  assert.deepEqual(
    [
      ...hits(outsideStore, /updatePaymentRequest\([^;]*?\bpayments\b/s),
      ...hits(outsideStore, /updateInvoice\([^;]*?(?:\bsettlements\b|settlementUpdate\()/s),
    ],
    [],
  );
});
check("updateTransfer merges a txs patch into the stored log, on both backends", () => {
  // Postgres: updateTransfer is patchTransfer, which writes on the locked row.
  for (const [file, start] of [["services/api/src/store.ts", "updateTransfer("], ["services/api/src/store/pg/backend.ts", "async function patchTransfer("]]) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const body = text.slice(text.indexOf(start), text.indexOf(start) + 600);
    assert.match(body, /transferPatchOnRow\(/, file);
  }
  assert.match(readFileSync(path.join(SRC, "store/pg/backend.ts"), "utf8"), /updateTransfer: \(id, patch\) => patchTransfer\(/);
  assert.match(readFileSync(path.join(SRC, "store/rules.ts"), "utf8"), /export function transferPatchOnRow[\s\S]{0,300}mergeTransferSteps\(/);
});

// ── 2. No partner or chain call inside a store.tx callback ─────────────────
// The rule is enforced at run time (store/backend.ts refuseInTx): `fetch`,
// `writeAndWait` and Horizon refuse inside an open transaction, whatever
// helper they are reached through. These checks keep the guard in place and
// catch the direct cases before a test has to run them.
/** The argument text of each `store.tx(` call, by paren matching: the
 *  callback whole, whether it has a block or an expression body. */
function txBodies(text: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = [];
  for (const m of text.matchAll(/\bstore\.tx\(/g)) {
    const open = m.index! + m[0].length - 1;
    out.push({ at: m.index!, body: text.slice(open, closing(text, open) + 1) });
  }
  return out;
}
/** The index of the bracket that closes the one at `open`. */
function closing(text: string, open: number): number {
  const [o, c] = text[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) break;
  }
  return i;
}
check("fetch, writeAndWait and Horizon refuse inside a store.tx at run time", () => {
  const backend = readFileSync(path.join(SRC, "store/backend.ts"), "utf8");
  assert.match(backend, /g\.fetch = \(\(\.\.\.args[\s\S]{0,80}refuseInTx\("fetch"\)/, "store/backend.ts wraps fetch");
  assert.match(backend, /\nguardFetch\(\);/, "store/backend.ts installs the fetch guard when it loads");
  const chain = readFileSync(path.join(SRC, "chain.ts"), "utf8");
  const write = chain.slice(chain.indexOf("export async function writeAndWait("));
  assert.match(write.slice(0, write.indexOf("simulateContract")), /refuseInTx\("writeAndWait"\)/, "writeAndWait refuses before it simulates");
  const anchor = readFileSync(path.join(SRC, "stellar/anchor.ts"), "utf8");
  assert.doesNotMatch(anchor, /new Horizon\.Server\((?!STELLAR\.horizon\);\n\})/, "every Horizon client comes from horizon()");
  assert.equal([...anchor.matchAll(/new Horizon\.Server\(/g)].length, 1);
});
check("no fetch or writeAndWait written inside a store.tx callback", () => {
  const found: string[] = [];
  for (const p of [...files(SRC), ...files(path.join(ROOT, "scripts")).filter((x) => !x.endsWith("-test.ts"))]) {
    const text = readFileSync(p, "utf8");
    for (const { at, body } of txBodies(text)) {
      const m = body.match(/\b(?:fetch|writeAndWait)\(/);
      if (m) found.push(`${rel(p)}:${lineOf(text, at)}: store.tx calls ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});
check("nothing is awaited after a response is sent in a store.tx callback", () => {
  // The JSON backend has no rollback: a callback that answered and then
  // failed would turn writes already on disk into a 500 (send-after-commit.ts).
  const strip = (x: string) => x.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const p of files(SRC)) {
    const text = readFileSync(p, "utf8");
    for (const { at, body } of txBodies(text)) {
      for (const s of body.matchAll(/\bres\b(?:\.status\([^)]*\))?\.(?:json|send|end|sendStatus|redirect)\(/g)) {
        if (/return\s*$/.test(body.slice(0, s.index))) continue;
        const rest = strip(body.slice(closing(body, s.index! + s[0].length - 1) + 1)).replace(/^\s*;?/, "");
        if (/^\s*return\b/.test(rest)) continue;
        if (/\bawait\b/.test(rest)) found.push(`${rel(p)}:${lineOf(text, at + s.index!)}: ${s[0]} … await`);
      }
    }
  }
  assert.deepEqual(found, []);
});

check("every ledger write outside the store is in a function that took the org's ledger lock first", () => {
  // §2 ledger row: statement writer, sync, revalue, rule run, categorise and
  // Beleg all take lockKey(`ledger:<org>`) before they read the rows they change.
  const found: string[] = [];
  for (const p of outsideStore) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\bstore\.(?:addLedgerEntries|updateLedgerEntry|replaceLedgerEntries)\(/g)) {
      // The innermost store.tx callback around the call, up to the call.
      const start = "store.tx".length;
      const inner = txBodies(text).filter(({ at, body }) => at < m.index! && at + start + body.length > m.index!).at(-1);
      const before = inner ? inner.body.slice(0, m.index! - inner.at - start) : "";
      if (!/lockKey\(`ledger:\$\{/.test(before)) found.push(`${rel(p)}:${lineOf(text, m.index!)}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

// ── 3. batched and the sync persist are gone ───────────────────────────────
check("no caller uses batched() or the sync persist()", () => {
  const callers = [...outsideStore, ...files(path.join(ROOT, "scripts")).filter((x) => !x.endsWith("store-gates-test.ts"))];
  assert.deepEqual(hits(callers, /\bstore\.batched\(|\bbatched\(|import\s*\{[^}]*\b(?:persist|batched)\b[^}]*\}\s*from\s*"[^"]*store\/db/), []);
  assert.doesNotMatch(readFileSync(path.join(SRC, "store/db.ts"), "utf8"), /export function batched/);
});

// ── 4. One API process: the start lock comes first ─────────────────────────
check("server.ts takes the start lock before it reads the store, starts a sweep or listens", () => {
  const src = readFileSync(path.join(SRC, "server.ts"), "utf8");
  const lock = src.indexOf("await takeStartLock(");
  assert.ok(lock > 0, "server.ts takes the start lock on Postgres");
  for (const later of ["await initStore()", "singleFlight(", "app.listen("]) {
    const at = src.indexOf(later);
    assert.ok(at > lock, `${later} comes after the start lock`);
  }
});

if (failures.length) {
  console.error(`\n${failures.length} gate(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nSTORE GATES PASSED — ${n}/${n}`);
