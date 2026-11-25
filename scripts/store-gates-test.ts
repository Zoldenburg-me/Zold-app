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
 *   2. No `fetch`, `writeAndWait` or adapter call inside a `store.tx`
 *      callback: a transaction does not span I/O we do not own.
 *   3. `batched` and the sync `persist` are gone from callers.
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
  for (const file of ["services/api/src/store.ts", "services/api/src/store/pg/backend.ts"]) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const body = text.slice(text.indexOf("updateTransfer("), text.indexOf("updateTransfer(") + 600);
    assert.match(body, /transferPatchOnRow\(/, file);
  }
  assert.match(readFileSync(path.join(SRC, "store/rules.ts"), "utf8"), /export function transferPatchOnRow[\s\S]{0,300}mergeTransferSteps\(/);
});

// ── 2. No partner or chain call inside a store.tx callback ─────────────────
/** The source of each `store.tx(` callback, by brace matching from its `{`. */
function txBodies(text: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = [];
  for (const m of text.matchAll(/\bstore\.tx\(/g)) {
    const open = text.indexOf("{", m.index!);
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    out.push({ at: m.index!, body: text.slice(open, i + 1) });
  }
  return out;
}
/** Names a file imports from adapters/ or stellar/, the partner clients. */
function partnerImports(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/(?:adapters|stellar)\/[^"]*"/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name && !/^type\s/.test(part.trim()) && /^[a-z]/.test(name)) names.push(name);
    }
  }
  return names;
}
check("no fetch, writeAndWait or partner adapter call inside a store.tx callback", () => {
  const found: string[] = [];
  for (const p of [...files(SRC), ...files(path.join(ROOT, "scripts")).filter((x) => !x.endsWith("-test.ts"))]) {
    const text = readFileSync(p, "utf8");
    const partners = partnerImports(text);
    for (const { at, body } of txBodies(text)) {
      // An adapter's pure helpers are allowed; an awaited adapter call is I/O.
      const io = [/\bfetch\(/, /\bwriteAndWait\(/, ...partners.map((name) => new RegExp(`\\bawait\\s+${name}\\(`))];
      for (const re of io) {
        const m = body.match(re);
        if (m) found.push(`${rel(p)}:${lineOf(text, at)}: store.tx calls ${m[0]}`);
      }
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

if (failures.length) {
  console.error(`\n${failures.length} gate(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nSTORE GATES PASSED — ${n}/${n}`);
