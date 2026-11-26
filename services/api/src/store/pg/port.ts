/**
 * db.json ↔ Postgres: the pre-import report, the import, the export and the
 * verify of docs/postgres-store-design.md §6. The scripts are
 * scripts/pg-import.ts and scripts/pg-export.ts.
 *
 * The source is always the migrated snapshot (loadMigratedSnapshot,
 * store/db.ts): the file as initStore would serve it. Both sides are hashed
 * from the same `Db` shape: per collection, the row count and a SHA-256 over
 * the rows in stored order (the JSON array's; `seq` on Postgres), each in
 * canonical JSON (keys sorted), so a round trip that reorders rows or changes
 * a value fails. Nothing here prints or returns a row: reports name
 * collections, rules and row ids only.
 */
import { createHash } from "node:crypto";
import { emptyDb, type Db } from "../db.js";
import type { Collection } from "../backend.js";
import type { OutboxRow } from "../types.js";
import { listCollection, TABLE } from "./backend.js";
import { assertSchemaCurrent } from "./migrate.js";
import type { Database, Sql } from "./sql.js";

export const COLLECTIONS = Object.keys(emptyDb()) as Collection[];

// ── Canonical form and digest ──────────────────────────────────────────────

/** JSON with every object's keys sorted, so two equal rows hash the same
 *  whatever order their keys were written in. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** A collection's rows, as stored. The cursor is a map with no stored order
 *  on Postgres, so its entries are sorted by chain. */
function rowsOf(db: Db, name: Collection): unknown[] {
  if (name === "cryptoDepositCursor") return Object.entries(db.cryptoDepositCursor ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (db[name] as unknown[] | undefined) ?? [];
}

export type Digest = Record<string, { rows: number; sha256: string }>;

export function digest(db: Db): Digest {
  const out: Digest = {};
  for (const name of COLLECTIONS) {
    const h = createHash("sha256");
    const rows = rowsOf(db, name);
    for (const r of rows) h.update(canonical(r)).update("\n");
    out[name] = { rows: rows.length, sha256: h.digest("hex") };
  }
  return out;
}

/** The collections whose count or hash differ between two digests. */
export function digestMismatches(a: Digest, b: Digest): string[] {
  return COLLECTIONS.filter((c) => a[c]?.rows !== b[c]?.rows || a[c]?.sha256 !== b[c]?.sha256);
}

// ── Pre-import report ──────────────────────────────────────────────────────

/**
 * One thing the import would trip over, or the lead should know. `blocks`:
 * the insert would fail on a key, cast or constraint of the migrations, or a
 * money amount is not a number; the import refuses while any is present.
 * Otherwise a finding only (an orphan: there are no foreign keys yet).
 */
export interface Finding {
  rule: string;
  collection: string;
  blocks: boolean;
  /** The row ids involved; for a duplicate, the rows sharing one key. */
  ids: string[];
}

type Row = Record<string, unknown>;
/** What `doc->>'…'` gives: text, or null for a missing or JSON null value. */
const text = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));
const at = (r: Row, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), r);
const lower = (v: string | null) => (v === null ? null : v.toLowerCase());
const idOf = (r: unknown): string => (r && typeof r === "object" ? String((r as Row).id ?? (r as Row).orderId ?? "?") : String(r));

/**
 * A unique index of the migrations, as JavaScript over the row. `key` gives
 * the indexed values, or null where the row is not in the index (a partial
 * index's WHERE, or a NULL value: Postgres treats NULLs as distinct).
 */
interface UniqueKey {
  index: string;
  collection: Collection;
  key: (r: Row) => (string | null)[] | null;
}
const col = (path: string, f: (v: string | null) => string | null = (v) => v) => (r: Row) => [f(text(at(r, path)))];

const UNIQUE_KEYS: UniqueKey[] = [
  { index: "users_credential_id", collection: "users", key: col("passkey.credentialId") },
  { index: "users_page_handle", collection: "users", key: col("paymentPage.handle", lower) },
  { index: "organisations_page_handle", collection: "organisations", key: col("paymentPage.handle", lower) },
  { index: "sessions_token_hash", collection: "sessions", key: col("tokenHash") },
  { index: "operators_email_lc", collection: "operators", key: col("email", lower) },
  { index: "operator_sessions_token_hash", collection: "operatorSessions", key: col("tokenHash") },
  { index: "receipt_shares_slug", collection: "receiptShares", key: col("slug") },
  { index: "receipt_shares_live", collection: "receiptShares", key: (r) => (text(r.revokedAt) === null ? [text(r.transferId)] : null) },
  { index: "documents_code", collection: "documents", key: col("code") },
  { index: "payment_requests_code", collection: "paymentRequests", key: col("code") },
  { index: "payment_requests_source", collection: "paymentRequests", key: (r) => ["source.kind", "source.shop", "source.externalId"].map((p) => text(at(r, p))) },
  { index: "shopify_connections_shop", collection: "shopifyConnections", key: col("shop") },
  { index: "merchant_links_live_shop", collection: "merchantLinks", key: (r) => (text(r.revokedAt) === null ? [text(r.shop)] : null) },
  { index: "crypto_deposits_chain_tx_log", collection: "cryptoDeposits", key: (r) => [text(r.chainId), lower(text(r.txHash)), text(r.logIndex)] },
  { index: "members_invite_token_hash", collection: "members", key: col("invite.tokenHash") },
  { index: "members_live", collection: "members", key: (r) => (text(r.status) !== null && text(r.status) !== "deactivated" ? [text(r.orgId), text(r.userId)] : null) },
  { index: "invoices_link_token_hash", collection: "invoices", key: col("linkTokenHash") },
  // 0002: one issued number per organisation.
  { index: "invoices_org_number", collection: "invoices", key: (r) => [text(r.orgId), text(at(r, "issued.number"))] },
  { index: "chart_accounts_org_code", collection: "chartAccounts", key: (r) => [text(r.orgId), text(r.code)] },
  { index: "ledger_org_statement_key", collection: "ledger", key: (r) => [text(r.orgId), text(at(r, "statement.key"))] },
  // 0003: one transfer per quote, one account per company Safe, one
  // Zoldenburg grace period per user.
  { index: "transfers_quote_id", collection: "transfers", key: col("quoteId") },
  { index: "accounts_address_unbacked", collection: "accounts", key: (r) => (text(r.backingUserId) === null ? [lower(text(r.address))] : null) },
  {
    index: "recovery_requests_one_grace",
    collection: "recoveryRequests",
    key: (r) => (text(r.mode) === "zoldenburg" && text(r.status) === "GRACE_PERIOD" ? [text(r.userId)] : null),
  },
  { index: "monerium_issue_orders_pkey", collection: "moneriumIssueOrders", key: col("orderId") },
  { index: "outbox_key_key", collection: "outbox", key: col("key") },
];
/** The unique indexes the report mirrors, besides each table's primary key
 *  (pg-import-test.ts checks this against the migrated schema). */
export const REPORTED_UNIQUE_INDEXES = UNIQUE_KEYS.map((u) => ({ index: u.index, collection: u.collection }));

/** The foreign keys §1.2 names. None is in the schema yet: an orphan is a
 *  finding for the lead, and decides whether the key can go in. */
const REFERENCES: { collection: Collection; field: string; to: Collection }[] = [
  ...(["quotes", "transfers", "sessions", "paymentRequests", "conversionSweeps", "cryptoDeposits", "cryptoSends", "recoveryRequests", "documents", "members"] as const).map((c) => ({
    collection: c,
    field: "userId",
    to: "users" as const,
  })),
  { collection: "accounts", field: "backingUserId", to: "users" },
  { collection: "transfers", field: "quoteId", to: "quotes" },
  { collection: "operatorSessions", field: "operatorId", to: "operators" },
  { collection: "receiptShares", field: "transferId", to: "transfers" },
  ...(
    ["documents", "shopifyConnections", "merchantLinks", "safeOps", "members", "accounts", "importedWallets", "contacts", "drafts", "invoices", "chartAccounts", "accountRules", "ledger"] as const
  ).map((c) => ({ collection: c, field: "orgId", to: "organisations" as const })),
];

/** Collections that are rows with an `id` primary key. */
const ID_COLLECTIONS = Object.keys(TABLE) as (keyof typeof TABLE)[];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isFiniteNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/**
 * What would break the import, and the orphans, in `db` (a migrated
 * snapshot). Read-only, and needs no database.
 */
export function preImportReport(db: Db): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, collection: string, blocks: boolean, ids: string[]) => ids.length && out.push({ rule, collection, blocks, ids });
  const list = (c: Collection) => ((db[c] as unknown[] | undefined) ?? []) as Row[];
  const known = new Set<string>(COLLECTIONS);

  // A collection the import has no table for would be dropped in silence.
  for (const k of Object.keys(db)) if (!known.has(k)) add("unknown-collection", k, true, [k]);
  for (const c of COLLECTIONS) {
    const v = (db as unknown as Row)[c];
    const shape = c === "cryptoDepositCursor" ? v !== null && typeof v === "object" && !Array.isArray(v) : Array.isArray(v);
    if (!shape) add("not-a-collection", c, true, [c]);
  }

  // Primary keys: present, text, once.
  const dupes = (rule: string, collection: string, keyed: [string, string][]) => {
    const by = new Map<string, string[]>();
    for (const [k, id] of keyed) by.set(k, [...(by.get(k) ?? []), id]);
    for (const ids of by.values()) if (ids.length > 1) add(rule, collection, true, ids);
  };
  for (const c of [...ID_COLLECTIONS, "outbox" as const]) {
    const rows = list(c);
    add("bad-id", c, true, rows.flatMap((r, i) => (typeof r?.id === "string" && r.id ? [] : [`#${i}`])));
    dupes("duplicate:primary-key", c, rows.filter((r) => typeof r?.id === "string").map((r) => [r.id as string, r.id as string]));
  }
  for (const c of ["processedMoneriumOrders", "processedMoneriumWebhooks"] as const) {
    const ids = list(c) as unknown[];
    add("bad-id", c, true, ids.flatMap((v, i) => (typeof v === "string" && v ? [] : [`#${i}`])));
    dupes("duplicate:primary-key", c, ids.filter((v): v is string => typeof v === "string").map((v) => [v, v]));
  }
  add("bad-id", "moneriumIssueOrders", true, list("moneriumIssueOrders").flatMap((r, i) => (typeof r?.orderId === "string" && r.orderId ? [] : [`#${i}`])));

  for (const u of UNIQUE_KEYS) {
    const keyed: [string, string][] = [];
    for (const r of list(u.collection)) {
      const k = u.key(r);
      if (!k || k.some((x) => x === null)) continue;
      keyed.push([JSON.stringify(k), idOf(r)]);
    }
    dupes(`duplicate:${u.index}`, u.collection, keyed);
  }
  // One namespace for user and organisation payment pages (payment_handles).
  dupes(
    "duplicate:payment_handles",
    "users+organisations",
    [...list("users").map((r) => ["user", r] as const), ...list("organisations").map((r) => ["organisation", r] as const)].flatMap(([kind, r]) => {
      const h = lower(text(at(r, "paymentPage.handle")));
      return h ? [[h, `${kind}:${idOf(r)}`] as [string, string]] : [];
    }),
  );
  // One passkey, one operator (operator_credentials).
  const creds: [string, string][] = [];
  for (const o of list("operators")) {
    const cs = Array.isArray(o.credentials) ? (o.credentials as Row[]) : [];
    for (const c of cs) {
      const id = text(c?.credentialId);
      if (id === null) add("operator-credential-id", "operators", true, [idOf(o)]);
      else creds.push([id, idOf(o)]);
    }
  }
  dupes("duplicate:operator_credentials", "operators", creds);

  // The deposit key's columns are NOT NULL (0005, 0008); log_index is an
  // integer column, and the store writes a number (assertDepositKey).
  for (const d of list("cryptoDeposits")) {
    const li = d.logIndex;
    if (li === undefined || li === null) add("deposit-key:logIndex-missing", "cryptoDeposits", true, [idOf(d)]);
    else if (typeof li !== "number" || !Number.isSafeInteger(li) || li < 0 || li > 2147483647) add("deposit-key:logIndex-not-integer", "cryptoDeposits", true, [idOf(d)]);
    if (text(d.chainId) === null) add("deposit-key:chainId-missing", "cryptoDeposits", true, [idOf(d)]);
    if (!text(d.txHash)) add("deposit-key:txHash-missing", "cryptoDeposits", true, [idOf(d)]);
  }
  // Amounts the daily cap sums: one that is not a number makes the sum NaN
  // or Infinity (JSON writes NaN and Infinity as null).
  add("cap-amount:not-finite", "transfers", true, list("transfers").filter((t) => !isFiniteNumber(t.sendEur)).map(idOf));
  add("cap-amount:not-finite", "cryptoSends", true, list("cryptoSends").filter((c) => !isFiniteNumber(c.capEur)).map(idOf));

  // crypto_deposit_cursor.block is numeric and reads back as `block::text`:
  // only a string in that canonical form comes back as it went in.
  const cursor = (db.cryptoDepositCursor ?? {}) as Record<string, unknown>;
  add("cursor-block-not-numeric", "cryptoDepositCursor", true, Object.keys(cursor).filter((k) => typeof cursor[k] !== "string" || !/^(0|[1-9]\d*)$/.test(cursor[k] as string)));
  // outbox rows go into typed columns.
  add(
    "outbox-row-shape",
    "outbox",
    true,
    (list("outbox") as unknown as OutboxRow[])
      .filter(
        (o) =>
          typeof o.kind !== "string" ||
          !o.payload ||
          typeof o.payload !== "object" ||
          !Number.isSafeInteger(o.attempts) ||
          o.attempts < 0 ||
          (o.key !== undefined && typeof o.key !== "string") ||
          (o.lastError !== undefined && typeof o.lastError !== "string") ||
          !ISO.test(String(o.createdAt)) ||
          !ISO.test(String(o.nextAttemptAt)) ||
          [o.claimedUntil, o.deliveredAt, o.deadAt].some((t) => t !== undefined && !ISO.test(String(t))),
      )
      .map(idOf),
  );

  for (const ref of REFERENCES) {
    const have = new Set(list(ref.to).map((r) => r?.id));
    add(`orphan:${ref.field}->${ref.to}`, ref.collection, false, list(ref.collection).filter((r) => text(r[ref.field]) !== null && !have.has(r[ref.field])).map(idOf));
  }
  return out;
}

/** The report as lines: no row content, ids only. */
export function formatReport(findings: Finding[]): string[] {
  const lines = findings.map((f) => `${f.blocks ? "BLOCKS " : "finding"}  ${f.rule}  ${f.collection}  ${f.ids.length} row(s): ${f.ids.join(", ")}`);
  const per = new Map<string, number>();
  for (const f of findings) per.set(`${f.rule} (${f.collection})`, (per.get(`${f.rule} (${f.collection})`) ?? 0) + (f.rule.startsWith("duplicate:") ? 1 : f.ids.length));
  lines.push(`summary: ${findings.filter((f) => f.blocks).length} blocking, ${findings.filter((f) => !f.blocks).length} other`);
  for (const [k, n] of per) lines.push(`  ${k}: ${n}`);
  return lines;
}

// ── Export ─────────────────────────────────────────────────────────────────

/** Every collection in the `Db` shape, as the Postgres store reads it. */
export async function readDb(q: Sql): Promise<Db> {
  const db = emptyDb();
  for (const c of COLLECTIONS) (db as unknown as Row)[c] = await listCollection(q, c);
  return db;
}

/**
 * The two key tables filled from the rows (payment_handles from users' and
 * organisations' handles, operator_credentials from operators'
 * credentials), compared with what `db` says they must hold. The names of
 * those that differ; the digest covers only the collections.
 */
export async function derivedMismatches(q: Sql, db: Db): Promise<string[]> {
  const sorted = (xs: string[]) => [...xs].sort();
  const handles = sorted(
    [...db.users.map((r) => ["user", r] as const), ...db.organisations.map((r) => ["organisation", r] as const)].flatMap(([kind, r]) => {
      const h = text(at(r as unknown as Row, "paymentPage.handle"));
      return h ? [`${h.toLowerCase()}|${kind}|${r.id}`] : [];
    }),
  );
  const creds = sorted(db.operators.flatMap((o) => (o.credentials ?? []).map((c) => `${c.credentialId}|${o.id}`)));
  const got = async (sql: string) => sorted((await q.query<{ k: string }>(sql)).rows.map((r) => r.k));
  const out: string[] = [];
  if (JSON.stringify(await got("SELECT handle_lc || '|' || owner_kind || '|' || owner_id AS k FROM payment_handles")) !== JSON.stringify(handles)) out.push("payment_handles");
  if (JSON.stringify(await got("SELECT credential_id || '|' || operator_id AS k FROM operator_credentials")) !== JSON.stringify(creds)) out.push("operator_credentials");
  return out;
}

/** Tables Postgres has and db.json has no place for (§6, export). */
export async function postgresOnlyCounts(q: Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["ledger_history", "cap_holds", "pending_executions"]) {
    out[t] = Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

/** `ledger_history` as JSON lines, in order, for its own encrypted file. */
export async function readLedgerHistory(q: Sql): Promise<string> {
  const r = await q.query<{ line: string }>(
    "SELECT json_build_object('seq', seq, 'entryId', entry_id, 'orgId', org_id, 'doc', doc, 'changedAt', changed_at)::text AS line FROM ledger_history ORDER BY seq",
  );
  return r.rows.map((x) => `${x.line}\n`).join("");
}

/**
 * Hold the deployment's start lock for the rest of `q`'s transaction, or
 * refuse: an API serving this database would write past the snapshot, and
 * one starting now would find the lock held and exit (store/pg/start-lock.ts).
 */
async function holdStartLock(q: Sql): Promise<void> {
  const r = await q.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('api:' || current_database())) AS ok");
  if (!r.rows[0]?.ok) throw new Error("an API holds this deployment's start lock: stop it first");
}

export interface Export {
  db: Db;
  ledgerHistory: string;
  postgresOnly: Record<string, number>;
}

/**
 * The export (§6): the whole store in the `Db` shape, read under the start
 * lock. `during` runs before the lock is let go (the CLI writes and checks
 * its files there), so no API starts between the read and the file.
 */
export async function exportDb<T = Export>(database: Database, during?: (e: Export, q: Sql) => Promise<T>): Promise<T> {
  await assertSchemaCurrent(database);
  return database.tx(async (q) => {
    await holdStartLock(q);
    const e: Export = { db: await readDb(q), ledgerHistory: await readLedgerHistory(q), postgresOnly: await postgresOnlyCounts(q) };
    return during ? during(e, q) : (e as T);
  });
}

// ── Import ─────────────────────────────────────────────────────────────────

export class ImportRefused extends Error {
  constructor(
    message: string,
    readonly findings: Finding[] = [],
  ) {
    super(message);
  }
}

/** Every table the store writes, for the empty-target check. */
const ALL_TABLES = [
  ...Object.values(TABLE),
  "payment_handles",
  "operator_credentials",
  "processed_monerium_orders",
  "processed_monerium_webhooks",
  "monerium_issue_orders",
  "crypto_deposit_cursor",
  "outbox",
  "ledger_history",
  "cap_holds",
  "pending_executions",
];

async function targetRows(q: Sql): Promise<number> {
  let n = 0;
  for (const t of ALL_TABLES) n += Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return n;
}

/**
 * A failed insert, named by collection and row id and the constraint or
 * error code. Never the driver's message or detail: they quote the value.
 */
function insertFailure(collection: string, id: string, err: unknown): ImportRefused {
  const e = err as { code?: string; constraint?: string; column?: string };
  const what = [e.code && `SQLSTATE ${e.code}`, e.constraint && `constraint ${e.constraint}`, e.column && `column ${e.column}`].filter(Boolean).join(", ");
  return new ImportRefused(`insert failed at ${collection} row ${id}${what ? ` (${what})` : ""}; rolled back, the target is empty`);
}

export interface ImportHooks {
  /** Called before each row is inserted; a test fails the import here. */
  beforeRow?(collection: Collection, index: number): void | Promise<void>;
}

async function insertAll(q: Sql, db: Db, hooks: ImportHooks): Promise<void> {
  const run = async (collection: Collection, index: number, id: string, fn: () => Promise<unknown>) => {
    await hooks.beforeRow?.(collection, index);
    try {
      await fn();
    } catch (err) {
      throw insertFailure(collection, id, err);
    }
  };
  for (const c of ID_COLLECTIONS) {
    const table = TABLE[c];
    const rows = db[c] as unknown as Row[];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await run(c, i, r.id as string, async () => {
        await q.query(`INSERT INTO ${table} (id, doc) VALUES ($1, $2::json)`, [r.id, JSON.stringify(r)]);
        const handle = c === "users" || c === "organisations" ? text(at(r, "paymentPage.handle")) : null;
        if (handle) {
          await q.query("INSERT INTO payment_handles (handle_lc, owner_kind, owner_id) VALUES ($1, $2, $3)", [handle.toLowerCase(), c === "users" ? "user" : "organisation", r.id]);
        }
        if (c === "operators") {
          for (const cred of (r.credentials as Row[] | undefined) ?? []) {
            await q.query("INSERT INTO operator_credentials (credential_id, operator_id) VALUES ($1, $2)", [cred.credentialId, r.id]);
          }
        }
      });
    }
  }
  for (const [c, table, column] of [
    ["processedMoneriumOrders", "processed_monerium_orders", "order_id"],
    ["processedMoneriumWebhooks", "processed_monerium_webhooks", "webhook_id"],
  ] as const) {
    const ids = db[c];
    for (let i = 0; i < ids.length; i++) await run(c, i, ids[i], () => q.query(`INSERT INTO ${table} (${column}) VALUES ($1)`, [ids[i]]));
  }
  const issues = db.moneriumIssueOrders;
  for (let i = 0; i < issues.length; i++) {
    await run("moneriumIssueOrders", i, issues[i].orderId, () => q.query("INSERT INTO monerium_issue_orders (order_id, doc) VALUES ($1, $2::json)", [issues[i].orderId, JSON.stringify(issues[i])]));
  }
  const cursor = Object.entries(db.cryptoDepositCursor);
  for (let i = 0; i < cursor.length; i++) {
    const [k, b] = cursor[i];
    await run("cryptoDepositCursor", i, k, () => q.query("INSERT INTO crypto_deposit_cursor (chain_key, block) VALUES ($1, $2::numeric)", [k, b]));
  }
  const outbox = db.outbox;
  for (let i = 0; i < outbox.length; i++) {
    const o = outbox[i];
    await run("outbox", i, o.id, () =>
      q.query(
        `INSERT INTO outbox (id, kind, key, payload, created_at, attempts, next_attempt_at, claimed_until, delivered_at, dead_at, last_error)
         VALUES ($1, $2, $3, $4::json, $5, $6, $7, $8, $9, $10, $11)`,
        [o.id, o.kind, o.key ?? null, JSON.stringify(o.payload), o.createdAt, o.attempts, o.nextAttemptAt, o.claimedUntil ?? null, o.deliveredAt ?? null, o.deadAt ?? null, o.lastError ?? null],
      ),
    );
  }
}

export type ImportResult = { imported: true; digest: Digest } | { imported: false; digest: Digest };

/**
 * Import a migrated snapshot in one transaction (§6). Refuses, writing
 * nothing, when the report finds anything blocking, when the schema is not
 * current, or when an API holds the start lock. A target that already holds
 * exactly this snapshot is left as it is (`imported: false`); any other
 * non-empty target is refused. Before the COMMIT the rows are read back in
 * the same transaction and hashed: a mismatch rolls the import back.
 */
export async function importSnapshot(database: Database, db: Db, hooks: ImportHooks = {}): Promise<ImportResult> {
  const findings = preImportReport(db);
  const blocking = findings.filter((f) => f.blocks);
  if (blocking.length) throw new ImportRefused(`the source has ${blocking.length} blocking finding(s); nothing was imported`, findings);
  await assertSchemaCurrent(database);
  const want = digest(db);
  return database.tx(async (q) => {
    await holdStartLock(q);
    if ((await targetRows(q)) > 0) {
      const bad = [...digestMismatches(want, digest(await readDb(q))), ...(await derivedMismatches(q, db))];
      if (bad.length) throw new ImportRefused(`the target is not empty and differs from the source in: ${bad.join(", ")}; nothing was imported`);
      return { imported: false, digest: want };
    }
    await insertAll(q, db, hooks);
    const bad = [...digestMismatches(want, digest(await readDb(q))), ...(await derivedMismatches(q, db))];
    if (bad.length) throw new ImportRefused(`read back, the import differs from the source in: ${bad.join(", ")}; rolled back, the target is empty`);
    return { imported: true, digest: want };
  });
}

export interface Verified {
  mismatches: string[];
  source: Digest;
  target: Digest;
  postgresOnly: Record<string, number>;
}

/** Verify on `q` (inside a transaction that holds the start lock). */
export async function verifyOn(q: Sql, db: Db): Promise<Verified> {
  const target = digest(await readDb(q));
  const source = digest(db);
  return { mismatches: [...digestMismatches(source, target), ...(await derivedMismatches(q, db))], source, target, postgresOnly: await postgresOnlyCounts(q) };
}

/**
 * Verify (§6): the snapshot against what Postgres holds now, under the start
 * lock, so a running API is refused rather than read mid-write. The
 * collections and key tables that differ; empty when equal.
 */
export async function verifyAgainst(database: Database, db: Db): Promise<Verified> {
  await assertSchemaCurrent(database);
  return database.tx(async (q) => {
    await holdStartLock(q);
    return verifyOn(q, db);
  });
}
