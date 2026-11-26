/**
 * The Postgres backend: every method of `store` (store.ts), with the same
 * bodies, over the tables of migrations/0001_init.sql.
 *
 * Each table holds the row as `doc`. A read selects it by a generated key
 * column, in stored order (`seq`), so "the first match" is the one the JSON
 * array would give. A write is one transaction: it reads the rows it changes
 * `FOR UPDATE`, applies the method's JavaScript (shared through
 * store/rules.ts where it decides anything), and writes the docs back.
 * Listeners run after the commit (inside a `store.tx`, after its COMMIT, and
 * never for a transaction rolled back), as they run after `persist()` today.
 *
 * The API runs on it with STORE_BACKEND=postgres (config/env.ts). Cap holds
 * are rows of `cap_holds` (migrations/0003). Rows come back as copies, never
 * live objects.
 */
import { randomUUID } from "node:crypto";
import { auditEntry, type AuditEntry } from "../../audit.js";
import type {
  Account,
  AccountRule,
  ChartAccount,
  Contact,
  DraftPayment,
  ImportedWallet,
  Invoice,
  LedgerEntry,
  Member,
  Organisation,
  OrgSafePlan,
} from "../../domain/types.js";
import { describeCause } from "../../http/log-cause.js";
import { decodeUserOperation, encodeUserOperation } from "../../domain/safe-op-queue.js";
import { currentTx, deferToCommit, endTx, inScope, isLock, lockOutsideTx, nestedTx, newTxHooks, type Collection, type StoreBackend, type StoreMethods } from "../backend.js";
import { defaultChartRows, type Db } from "../db.js";
import {
  applyOrgSafePlan,
  applyReplacedOrgSafePlan,
  applyReviewResolution,
  acceptInviteOnRow,
  applyUserPatch,
  cancelUnpaidOnRow,
  checkReviewResolution,
  draftPatchOnRow,
  refuseActivityPatch,
  settlementOnRow,
  transferPatchOnRow,
  assertCapAmounts,
  assertDepositKey,
  followIban,
  hashOnRecordIn,
  passkeyUsePatch,
  quoteConsumable,
  emailCodeAttemptPatch,
  reviewRefundTx,
  sessionDead,
} from "../rules.js";
import type {
  ConversionSweep,
  CryptoDeposit,
  CryptoSend,
  MerchantLink,
  MoneriumIssueRecord,
  Operator,
  OperatorCredential,
  OperatorSession,
  PaymentRequest,
  PendingExecution,
  PendingSafeOp,
  Quote,
  ReceiptShare,
  RecoveryRequest,
  SafeOpSignature,
  ServiceCredential,
  Session,
  ShopifyConnection,
  ShopifyDelivery,
  StoredDocument,
  Transfer,
  User,
} from "../types.js";
import type { Database, Sql, TxSql } from "./sql.js";

/** The SQL table of each collection that is a list of rows with an `id`. */
const TABLE = {
  users: "users",
  quotes: "quotes",
  transfers: "transfers",
  sessions: "sessions",
  operators: "operators",
  operatorSessions: "operator_sessions",
  serviceCredentials: "service_credentials",
  receiptShares: "receipt_shares",
  documents: "documents",
  paymentRequests: "payment_requests",
  shopifyConnections: "shopify_connections",
  shopifyDeliveries: "shopify_deliveries",
  merchantLinks: "merchant_links",
  conversionSweeps: "conversion_sweeps",
  cryptoDeposits: "crypto_deposits",
  cryptoSends: "crypto_sends",
  audit: "audit",
  recoveryRequests: "recovery_requests",
  safeOps: "safe_ops",
  organisations: "organisations",
  members: "members",
  accounts: "accounts",
  importedWallets: "imported_wallets",
  contacts: "contacts",
  drafts: "drafts",
  invoices: "invoices",
  chartAccounts: "chart_accounts",
  accountRules: "account_rules",
  ledger: "ledger",
} as const satisfies Partial<Record<Collection, string>>;
type Table = (typeof TABLE)[keyof typeof TABLE];

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a cap hold counts. A hold lives from the cap check to the row that
 * replaces it (a transfer's build, a send's prepare: seconds, bounded by the
 * partners' timeouts). In memory a restart dropped the holds; in the database
 * one left by a process that died counts until it expires, then is ignored.
 */
export const CAP_HOLD_TTL_MS = 15 * 60_000;

async function rows<T>(q: Sql, table: Table, where = "TRUE", params: unknown[] = [], tail = ""): Promise<T[]> {
  const r = await q.query<{ doc: T }>(`SELECT doc FROM ${table} WHERE ${where} ORDER BY seq ${tail}`, params);
  return r.rows.map((x) => x.doc);
}
async function first<T>(q: Sql, table: Table, where: string, params: unknown[]): Promise<T | undefined> {
  return (await rows<T>(q, table, where, params, "LIMIT 1"))[0];
}
/** The row with this id, locked for the rest of the transaction. */
async function locked<T>(q: Sql, table: Table, id: string): Promise<T | undefined> {
  const r = await q.query<{ doc: T }>(`SELECT doc FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  return r.rows[0]?.doc;
}
async function insert(q: Sql, table: Table, row: { id: string }): Promise<void> {
  await q.query(`INSERT INTO ${table} (id, doc) VALUES ($1, $2::json)`, [row.id, JSON.stringify(row)]);
}
async function save(q: Sql, table: Table, row: { id: string }): Promise<void> {
  await q.query(`UPDATE ${table} SET doc = $2::json WHERE id = $1`, [row.id, JSON.stringify(row)]);
}
/** Delete the ids `dead` picks among the rows `where` selects, `dead` being
 *  the same JavaScript the JSON backend filters with. */
async function prune<T extends { id: string }>(q: Sql, table: Table, where: string, params: unknown[], dead: (row: T) => boolean) {
  const ids = (await rows<T>(q, table, where, params)).filter(dead).map((r) => r.id);
  if (ids.length) await q.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
}

/**
 * Claim `handle` for this owner in `payment_handles`, or refuse: a user's
 * and an organisation's pages share one namespace (§1.2). Run in the
 * transaction that writes the owner's row.
 */
/**
 * Delete a cap hold holding its cap's lock, as holdDailyCap counts under it:
 * a cap sum reads the holds and then the rows in two statements, so a hold
 * replaced between them would be counted twice (a false refusal). False when
 * there is no such hold.
 */
async function releaseUnderCapLock(t: Sql, holdId: string): Promise<boolean> {
  const key = (await t.query<{ cap_key: string }>("SELECT cap_key FROM cap_holds WHERE id = $1", [holdId])).rows[0]?.cap_key;
  if (key === undefined) return false;
  await t.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || $1))", [`cap:${key}`]);
  return (await t.query("DELETE FROM cap_holds WHERE id = $1 RETURNING id", [holdId])).rows.length > 0;
}

async function syncHandle(q: Sql, kind: "user" | "organisation", ownerId: string, handle: string | undefined) {
  const lc = handle ? handle.toLowerCase() : null;
  await q.query("DELETE FROM payment_handles WHERE owner_kind = $1 AND owner_id = $2 AND handle_lc IS DISTINCT FROM $3", [kind, ownerId, lc]);
  if (!lc) return;
  const ins = await q.query(
    "INSERT INTO payment_handles (handle_lc, owner_kind, owner_id) VALUES ($1, $2, $3) ON CONFLICT (handle_lc) DO NOTHING RETURNING handle_lc",
    [lc, kind, ownerId],
  );
  if (ins.rows.length) return;
  const held = await q.query<{ owner_kind: string; owner_id: string }>("SELECT owner_kind, owner_id FROM payment_handles WHERE handle_lc = $1", [lc]);
  const h = held.rows[0];
  if (!h || h.owner_kind !== kind || h.owner_id !== ownerId) throw new Error("that payment page handle is taken");
}

/** One operator's passkeys in `operator_credentials`, so none is two operators'. */
async function syncOperatorCredentials(q: Sql, o: Operator) {
  await q.query("DELETE FROM operator_credentials WHERE operator_id = $1", [o.id]);
  for (const c of o.credentials) {
    await q.query("INSERT INTO operator_credentials (credential_id, operator_id) VALUES ($1, $2)", [c.credentialId, o.id]);
  }
}

const pageHandle = (x: { paymentPage?: { handle?: string } }) => x.paymentPage?.handle;

async function insertUser(q: Sql, u: User) {
  await insert(q, TABLE.users, u);
  await syncHandle(q, "user", u.id, pageHandle(u));
}
async function saveUser(q: Sql, u: User, handleBefore: string | undefined) {
  await save(q, TABLE.users, u);
  if (pageHandle(u) !== handleBefore) await syncHandle(q, "user", u.id, pageHandle(u));
}
async function saveOrg(q: Sql, o: Organisation, handleBefore: string | undefined) {
  await save(q, TABLE.organisations, o);
  if (pageHandle(o) !== handleBefore) await syncHandle(q, "organisation", o.id, pageHandle(o));
}

/** seedChartOfAccounts (store/db.ts) on Postgres. */
async function seedChart(q: Sql, orgId: string, at = new Date().toISOString()) {
  const has = await q.query("SELECT 1 FROM chart_accounts WHERE org_id = $1 LIMIT 1", [orgId]);
  if (has.rows.length) return;
  const seed = defaultChartRows(orgId, at);
  for (const c of seed.chart) await insert(q, TABLE.chartAccounts, c);
  for (const r of seed.rules) await insert(q, TABLE.accountRules, r);
}

/** hashOnRecord (store.ts), given only the rows whose text holds the hash:
 *  a superset of the matches, in stored order. */
async function hashOnRecord(q: Sql, hash: string, userId: string): Promise<string | undefined> {
  const where = "strpos(lower(doc::text), $1) > 0";
  const h = [hash.toLowerCase()];
  return hashOnRecordIn(
    {
      transfers: await rows<Transfer>(q, TABLE.transfers, where, h),
      cryptoDeposits: await rows<CryptoDeposit>(q, TABLE.cryptoDeposits, where, h),
      conversionSweeps: await rows<ConversionSweep>(q, TABLE.conversionSweeps, where, h),
      ledger: await rows<LedgerEntry>(q, TABLE.ledger, where, h),
    },
    hash,
    userId,
  );
}

type TransferStateListener = (t: Transfer, from: Transfer["state"]) => void | Promise<void>;
type PaymentRequestStateListener = (r: PaymentRequest, from: PaymentRequest["state"]) => void | Promise<void>;

type TxFn = <T>(fn: (q: Sql) => Promise<T>) => Promise<T>;

export function createPgStore(database: Database): StoreBackend {
  const transferStateListeners: TransferStateListener[] = [];
  const paymentRequestStateListeners: PaymentRequestStateListener[] = [];

  /** Run `fire` once the write has committed: at once outside a transaction,
   *  after its COMMIT inside one, and never if it rolls back. */
  const afterCommit = (fire: () => void) => {
    if (!deferToCommit(fire)) fire();
  };
  /** Logged, never thrown into the write: it has committed. */
  function announceStateChange(t: Transfer, from: Transfer["state"]) {
    if (t.state === from) return;
    afterCommit(() => {
      for (const listener of transferStateListeners) {
        try {
          Promise.resolve(listener(t, from)).catch((err) =>
            console.error(`store: transfer state listener failed for ${t.id}: ${describeCause(err)}`),
          );
        } catch (err) {
          console.error(`store: transfer state listener failed for ${t.id}: ${describeCause(err)}`);
        }
      }
    });
  }
  function announcePaymentRequestState(r: PaymentRequest, from: PaymentRequest["state"]) {
    if (r.state === from) return;
    afterCommit(() => {
      for (const listener of paymentRequestStateListeners) {
        try {
          Promise.resolve(listener(r, from)).catch((err) =>
            console.error(`store: payment request state listener failed for ${r.id}: ${describeCause(err)}`),
          );
        } catch (err) {
          console.error(`store: payment request state listener failed for ${r.id}: ${describeCause(err)}`);
        }
      }
    });
  }

  /** The store's methods over `q`; `tx` runs a block as one transaction (on
   *  a transaction's own client it just runs it there). */
  function build(q: Sql, tx: TxFn): StoreMethods {
  async function updateUserIn(t: Sql, id: string, patch: Partial<User>): Promise<User> {
    const u = await locked<User>(t, TABLE.users, id);
    if (!u) throw new Error(`unknown user ${id}`);
    const handleBefore = pageHandle(u);
    if (applyUserPatch(u, patch)) {
      for (const a of await rows<Account>(t, TABLE.accounts, "backing_user_id = $1", [id], "FOR UPDATE")) {
        if (followIban(a, id, u.iban)) await save(t, TABLE.accounts, a);
      }
    }
    await saveUser(t, u, handleBefore);
    return u;
  }

  /** Lock one row, let `fn` change it (or refuse with null), save it. */
  async function change<T extends { id: string }, R = T>(
    table: Table,
    id: string,
    missing: string | null,
    fn: (row: T) => R | null,
  ): Promise<R | null> {
    return tx(async (t) => {
      const row = await locked<T>(t, table, id);
      if (!row) {
        if (missing) throw new Error(missing);
        return null;
      }
      const out = fn(row);
      if (out === null) return null;
      await save(t, table, row);
      return out;
    });
  }
  /** Object.assign the patch (and `updatedAt` when `stamp`), as store.ts does. */
  async function patchRow<T extends { id: string }>(table: Table, id: string, what: string, patch: Partial<T>, stamp: boolean): Promise<T> {
    return (await change<T>(table, id, `unknown ${what} ${id}`, (row) =>
      Object.assign(row, patch, stamp ? { updatedAt: new Date().toISOString() } : {}),
    ))!;
  }
  /** updateTransfer with a patch computed from the locked row. */
  async function patchTransfer(id: string, make: (row: Transfer) => Partial<Transfer>): Promise<Transfer> {
    let from: Transfer["state"] = "CREATED";
    const t = (await change<Transfer>(TABLE.transfers, id, `unknown transfer ${id}`, (row) => {
      const p = transferPatchOnRow(row, make(structuredClone(row)));
      from = row.state;
      return Object.assign(row, p, { updatedAt: new Date().toISOString() });
    }))!;
    announceStateChange(t, from);
    return t;
  }
  /** updatePaymentRequest with a patch computed from the locked row, or none. */
  async function patchPaymentRequest(id: string, make: (row: PaymentRequest) => Partial<PaymentRequest> | null) {
    let from: PaymentRequest["state"] = "OPEN";
    let written = false;
    const r = (await tx(async (t) => {
      const row = await locked<PaymentRequest>(t, TABLE.paymentRequests, id);
      if (!row) throw new Error(`unknown payment request ${id}`);
      from = row.state;
      const p = make(structuredClone(row));
      if (!p) return row;
      written = true;
      Object.assign(row, p, { updatedAt: new Date().toISOString() });
      await save(t, TABLE.paymentRequests, row);
      return row;
    }))!;
    if (written) announcePaymentRequestState(r, from);
    return { request: r, from, written };
  }
  async function removeRow(table: Table, id: string): Promise<boolean> {
    const r = await q.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
    return r.rows.length > 0;
  }

  const backend: StoreMethods = {
    async list<K extends Collection>(name: K): Promise<Db[K]> {
      if (name === "processedMoneriumOrders") {
        const r = await q.query<{ id: string }>("SELECT order_id AS id FROM processed_monerium_orders ORDER BY seq");
        return r.rows.map((x) => x.id) as Db[K];
      }
      if (name === "processedMoneriumWebhooks") {
        const r = await q.query<{ id: string }>("SELECT webhook_id AS id FROM processed_monerium_webhooks ORDER BY seq");
        return r.rows.map((x) => x.id) as Db[K];
      }
      if (name === "cryptoDepositCursor") {
        const r = await q.query<{ k: string; b: string }>("SELECT chain_key AS k, block::text AS b FROM crypto_deposit_cursor");
        return Object.fromEntries(r.rows.map((x) => [x.k, x.b])) as Db[K];
      }
      if (name === "moneriumIssueOrders") {
        const r = await q.query<{ doc: MoneriumIssueRecord }>("SELECT doc FROM monerium_issue_orders ORDER BY seq");
        return r.rows.map((x) => x.doc) as Db[K];
      }
      return (await rows(q, TABLE[name as keyof typeof TABLE])) as Db[K];
    },

    async addUser(u: User) {
      await tx((t) => insertUser(t, u));
    },
    updateUser: (id, patch) => tx((t) => updateUserIn(t, id, patch)),
    lockUser: (id) => tx((t) => locked<User>(t, TABLE.users, id)),
    async lockKey(key) {
      // Per database: advisory locks are cluster-wide.
      await q.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || $1))", [key]);
    },
    patchUserSub: (id, key, fn, patch = {}) =>
      tx(async (t) => {
        const u = await locked<User>(t, TABLE.users, id);
        if (!u) throw new Error(`unknown user ${id}`);
        return updateUserIn(t, id, { ...patch, [key]: fn(structuredClone(u[key])) } as Partial<User>);
      }),
    recordPasskeyUse: (id, credentialId, signCount) =>
      tx(async (t) => {
        const patch = passkeyUsePatch(await locked<User>(t, TABLE.users, id), credentialId, signCount);
        return patch ? updateUserIn(t, id, patch) : undefined;
      }),
    countEmailCodeAttempt: (id, max, now = Date.now()) =>
      tx(async (t) => {
        const patch = emailCodeAttemptPatch(await locked<User>(t, TABLE.users, id), max, now);
        return patch ? updateUserIn(t, id, patch) : undefined;
      }),
    serviceCredentials: (service) => rows<ServiceCredential>(q, TABLE.serviceCredentials, "service = $1", [service]),
    rotateServiceCredential: (next, overlapMs, by, revoked = false) =>
      tx(async (t) => {
        const until = new Date(Date.now() + overlapMs).toISOString();
        for (const c of await rows<ServiceCredential>(t, TABLE.serviceCredentials, "service = $1", [next.service], "FOR UPDATE")) {
          if (!c.expiresAt || c.expiresAt > until) {
            c.expiresAt = until;
            await save(t, TABLE.serviceCredentials, c);
          }
        }
        await insert(t, TABLE.serviceCredentials, next);
        await insert(
          t,
          TABLE.audit,
          auditEntry("service.credential_rotated", {
            service: next.service,
            credentialId: next.id,
            previousValidUntil: until,
            revokedPrevious: revoked,
            operator: by,
          }),
        );
        return until;
      }),
    async audit(entry: AuditEntry) {
      await insert(q, TABLE.audit, entry);
    },
    async auditFor(userId, limit = 200) {
      const where = userId ? "user_id = $1" : "TRUE";
      const params = userId ? [userId] : [];
      // rows.slice(-limit).reverse(): the last `limit`, newest first.
      if (Number.isFinite(limit) && Math.trunc(limit) > 0) {
        const r = await q.query<{ doc: AuditEntry }>(`SELECT doc FROM audit WHERE ${where} ORDER BY seq DESC LIMIT $${params.length + 1}`, [
          ...params,
          Math.trunc(limit),
        ]);
        return r.rows.map((x) => x.doc);
      }
      return (await rows<AuditEntry>(q, TABLE.audit, where, params)).slice(-limit).reverse();
    },
    setSegment: (id, segment, by = "system") =>
      change<User>(TABLE.users, id, `unknown user ${id}`, (u) => {
        if (u.segment && by !== "admin") {
          throw new Error(`user ${id} already has segment ${u.segment.value}; only an admin action may change it`);
        }
        u.segment = { ...segment, decidedBy: by };
        return u;
      }) as Promise<User>,
    addConsent: (id, consent) =>
      change<User>(TABLE.users, id, `unknown user ${id}`, (u) => {
        (u.consents ??= []).push(consent);
        return u;
      }) as Promise<User>,
    addUsAnswers: (id, answers) =>
      change<User>(TABLE.users, id, `unknown user ${id}`, (u) => {
        (u.usPersonAnswers ??= []).push(answers);
        return u;
      }) as Promise<User>,
    async addRecoveryRequest(r: RecoveryRequest) {
      await insert(q, TABLE.recoveryRequests, r);
    },
    updateRecoveryRequest: (id, patch) => patchRow<RecoveryRequest>(TABLE.recoveryRequests, id, "recovery request", patch, false),
    updateRecoveryRequestFrom: (id, from, patch) =>
      change<RecoveryRequest>(TABLE.recoveryRequests, id, `unknown recovery request ${id}`, (row) =>
        from.includes(row.status) ? Object.assign(row, patch) : null,
      ),
    async countRecoveryOtpAttempt(id, max) {
      let out: { attempts: number; over: boolean } | undefined;
      const r = await change<RecoveryRequest>(TABLE.recoveryRequests, id, null, (row) => {
        if (row.status !== "OTP_PENDING" || !row.candide) return null;
        const attempts = (row.candide.otpAttempts ?? 0) + 1;
        if (attempts > max) Object.assign(row, { status: "CANCELED", canceledAt: new Date().toISOString(), cancelReason: "too many wrong codes" });
        else row.candide = { ...row.candide, otpAttempts: attempts };
        out = { attempts, over: attempts > max };
        return row;
      });
      return r && out ? { request: r, ...out } : null;
    },
    findRecoveryRequest: (id) => first<RecoveryRequest>(q, TABLE.recoveryRequests, "id = $1", [id]),
    recoveryRequestsForUser: (userId) => rows<RecoveryRequest>(q, TABLE.recoveryRequests, "user_id = $1", [userId]),

    async addSafeOp(op: PendingSafeOp) {
      await insert(q, TABLE.safeOps, op);
      return op;
    },
    findSafeOp: (id) => first<PendingSafeOp>(q, TABLE.safeOps, "id = $1", [id]),
    safeOpsOf: (orgId) => rows<PendingSafeOp>(q, TABLE.safeOps, "org_id = $1", [orgId]),
    endPendingSafeOp: (id, patch) =>
      change<PendingSafeOp>(TABLE.safeOps, id, null, (o) =>
        o.state !== "PENDING" ? null : Object.assign(o, patch, { updatedAt: new Date().toISOString() }),
      ),
    dropSafeOpSignatures: (id, ownerAddresses, reason, at = new Date().toISOString()) =>
      tx(async (t) => {
        const o = await locked<PendingSafeOp>(t, TABLE.safeOps, id);
        if (!o || o.state !== "PENDING") return null;
        const gone = new Set(ownerAddresses.map((a) => a.toLowerCase()));
        const dropped = o.signatures.filter((s) => gone.has(s.ownerAddress.toLowerCase()));
        if (!dropped.length) return o;
        o.signatures = o.signatures.filter((s) => !gone.has(s.ownerAddress.toLowerCase()));
        o.dropped.push(...dropped.map((s) => ({ memberId: s.memberId, ownerAddress: s.ownerAddress, droppedAt: at, reason })));
        o.updatedAt = at;
        await save(t, TABLE.safeOps, o);
        return o;
      }),
    addSafeOpSignature: (id, sig: SafeOpSignature) =>
      change<PendingSafeOp>(TABLE.safeOps, id, null, (o) => {
        if (o.state !== "PENDING") return null;
        const owner = sig.ownerAddress.toLowerCase();
        if (o.signatures.some((s) => s.memberId === sig.memberId || s.ownerAddress.toLowerCase() === owner)) return null;
        o.signatures.push(sig);
        o.updatedAt = sig.signedAt;
        return o;
      }),
    claimSafeOpRelay: (id) =>
      change<PendingSafeOp>(TABLE.safeOps, id, null, (o) => {
        if (o.state !== "PENDING") return null;
        o.state = "RELAYING";
        o.updatedAt = new Date().toISOString();
        return o;
      }),
    finishSafeOp: (id, patch) =>
      tx(async (t) => {
        const o = await locked<PendingSafeOp>(t, TABLE.safeOps, id);
        if (!o || o.state !== "RELAYING") throw new Error(`safe op ${id} is not relaying`);
        if (patch.state === "PENDING" || patch.state === "RELAYING") throw new Error("a relay ends in a final state");
        Object.assign(o, patch, { updatedAt: new Date().toISOString() });
        await save(t, TABLE.safeOps, o);
        return o;
      }),
    findUserByAddress: (address) => first<User>(q, TABLE.users, "address_lc = $1", [address.toLowerCase()]),
    findUserByCredential: (credentialId) => first<User>(q, TABLE.users, "credential_id = $1", [credentialId]),
    async usersByEmail(email) {
      const needle = email.trim().toLowerCase();
      if (!needle) return [];
      return rows<User>(q, TABLE.users, "email_lc = $1", [needle]);
    },
    async findUserByEmail(email) {
      const matches = await backend.usersByEmail(email);
      return (
        matches.find((u) => !!u.emailVerifiedAt) ??
        matches.find((u) => u.passkeySafe?.candideRecovery?.guardianStatus === "active") ??
        matches.find((u) => u.passkeySafe?.status === "active") ??
        matches[0]
      );
    },
    findUserBySafeAddress: (address) => {
      const needle = address.trim().toLowerCase();
      return first<User>(q, TABLE.users, "address_lc = $1 OR safe_address_lc = $1", [needle]);
    },
    async mirroredOrderIds() {
      return backend.list("processedMoneriumOrders");
    },
    async isOrderProcessed(orderId) {
      return (await q.query("SELECT 1 FROM processed_monerium_orders WHERE order_id = $1", [orderId])).rows.length > 0;
    },
    async markOrderProcessed(orderId) {
      const r = await q.query("INSERT INTO processed_monerium_orders (order_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING order_id", [orderId]);
      return r.rows.length > 0;
    },
    async isWebhookProcessed(webhookId) {
      return (await q.query("SELECT 1 FROM processed_monerium_webhooks WHERE webhook_id = $1", [webhookId])).rows.length > 0;
    },
    async markWebhookProcessed(webhookId) {
      const r = await q.query("INSERT INTO processed_monerium_webhooks (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING webhook_id", [webhookId]);
      return r.rows.length > 0;
    },
    addQuote: (qt: Quote) =>
      tx(async (t) => {
        // A quote nobody took is worth nothing a day after it expired; a
        // CONSUMED quote is a transfer's terms and stays.
        const stale = Date.now() - DAY_MS;
        await prune<Quote>(t, TABLE.quotes, "status IS DISTINCT FROM 'CONSUMED'", [], (x) => !(x.status === "CONSUMED" || Date.parse(x.expiresAt) > stale));
        await insert(t, TABLE.quotes, qt);
      }),
    updateQuote: (id, patch) => patchRow<Quote>(TABLE.quotes, id, "quote", patch, false),
    consumeQuote: async (id, now = Date.now()) =>
      (await change<Quote, boolean>(TABLE.quotes, id, `unknown quote ${id}`, (x) => {
        if (!quoteConsumable(x, now)) return null;
        x.status = "CONSUMED";
        return true;
      })) ?? false,
    expireQuote: async (id) =>
      (await change<Quote, boolean>(TABLE.quotes, id, null, (x) => {
        if ((x.status ?? "OPEN") !== "OPEN") return null;
        x.status = "EXPIRED";
        return true;
      })) ?? false,
    async addTransfer(t: Transfer) {
      await insert(q, TABLE.transfers, t);
    },
    /**
     * The cap's advisory lock, then `used` recomputed inside it (it reads
     * `heldEurToday` and the rows of the day, in this transaction), then the
     * hold, with an expiry (§2, quote → transfer). Two holders of one cap key
     * take turns; the second sees the first's hold or the row that replaced it.
     */
    holdDailyCap: (capKey, eur, capEur, used) =>
      tx(async (t) => {
        await t.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || $1))", [`cap:${capKey}`]);
        await t.query("DELETE FROM cap_holds WHERE expires_at < now() - interval '1 day'");
        const usedEur = await used();
        assertCapAmounts(eur, usedEur, capEur);
        if (usedEur + eur > capEur) return { ok: false as const, usedEur, capEur };
        const holdId = randomUUID();
        await t.query("INSERT INTO cap_holds (id, cap_key, day, eur, expires_at) VALUES ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')", [
          holdId,
          capKey,
          new Date().toISOString().slice(0, 10),
          eur,
          CAP_HOLD_TTL_MS,
        ]);
        return { ok: true as const, holdId };
      }),
    async heldEurToday(capKey, day = new Date().toISOString().slice(0, 10)) {
      const r = await q.query<{ sum: string }>("SELECT coalesce(sum(eur), 0)::text AS sum FROM cap_holds WHERE cap_key = $1 AND day = $2 AND expires_at > now()", [capKey, day]);
      return Number(r.rows[0].sum);
    },
    addTransferUnderHold: (row: Transfer, holdId) =>
      tx(async (t) => {
        // The row and the release are one transaction: the amount is counted
        // as the hold or as the transfer, never both and never neither.
        if (!(await releaseUnderCapLock(t, holdId))) throw new Error(`no cap hold ${holdId} — the transfer was not reserved`);
        await insert(t, TABLE.transfers, row);
      }),
    async releaseCapHold(holdId) {
      await q.query("DELETE FROM cap_holds WHERE id = $1", [holdId]);
    },
    /** A row of `pending_executions` (migrations/0004); the operation's
     *  bigints go through the Safe op queue's encoding. */
    putPendingExecution: (kind, id, entry) =>
      tx(async (t) => {
        await t.query("DELETE FROM pending_executions WHERE expires_at < $1", [new Date()]);
        await t.query(
          `INSERT INTO pending_executions (kind, id, user_id, expires_at, doc) VALUES ($1, $2, $3, $4, $5::json)
           ON CONFLICT (kind, id) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at, doc = EXCLUDED.doc`,
          [kind, id, entry.userId, new Date(entry.expiresAt), encodeUserOperation(entry)],
        );
      }),
    async findPendingExecution(kind, id) {
      const r = await q.query<{ doc: string }>("SELECT doc::text AS doc FROM pending_executions WHERE kind = $1 AND id = $2 AND expires_at >= $3", [
        kind,
        id,
        new Date(),
      ]);
      return r.rows[0] ? decodeUserOperation<PendingExecution>(r.rows[0].doc) : undefined;
    },
    async dropPendingExecution(kind, id) {
      await q.query("DELETE FROM pending_executions WHERE kind = $1 AND id = $2", [kind, id]);
    },
    claimAuthorization: async (id) =>
      (await change<Transfer, boolean>(TABLE.transfers, id, null, (t) => {
        if (t.state !== "CREATED" || !t.auth || t.auth.authorizedAt) return null;
        const now = new Date().toISOString();
        t.auth.authorizedAt = now;
        t.updatedAt = now;
        return true;
      })) ?? false,
    async updateTransfer(id, patch) {
      let from: Transfer["state"] = "CREATED";
      const t = (await change<Transfer>(TABLE.transfers, id, `unknown transfer ${id}`, (row) => {
        const p = transferPatchOnRow(row, patch);
        from = row.state;
        return Object.assign(row, p, { updatedAt: new Date().toISOString() });
      }))!;
      announceStateChange(t, from);
      return t;
    },
    appendTransferStep: (id, step, patch = {}) => patchTransfer(id, (row) => ({ ...patch, txs: [...row.txs, step] })),
    patchTransferSub: (id, key, fn, patch = {}) => patchTransfer(id, (row) => ({ ...patch, [key]: fn(row[key]) })),
    onTransferStateChange(listener) {
      transferStateListeners.push(listener);
    },
    async resolveTransferReview(id, r) {
      checkReviewResolution(r);
      const { result, audit } = await tx(async (t) => {
        const row = await locked<Transfer>(t, TABLE.transfers, id);
        const refundTx = reviewRefundTx(r);
        // Two reviews of different transfers citing one refund tx lock
        // different rows; this lock makes the second wait for the first's
        // commit, so its hashOnRecord sees the hash booked.
        if (row && refundTx) await t.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || $1))", [`:refund-evidence:${refundTx.toLowerCase()}`]);
        const out = applyReviewResolution(row, r, row && refundTx ? await hashOnRecord(t, refundTx, row.userId) : undefined);
        if (out.audit) {
          await save(t, TABLE.transfers, row!);
          await insert(t, TABLE.audit, out.audit);
        }
        return out;
      });
      if (audit && result.ok) announceStateChange(result.transfer, "MANUAL_REVIEW");
      return result;
    },
    async findReceiptShareByTransfer(transferId) {
      const shares = await rows<ReceiptShare>(q, TABLE.receiptShares, "transfer_id = $1", [transferId]);
      return shares.find((s) => !s.revokedAt) ?? shares.at(-1);
    },
    findReceiptShareBySlug: (slug) => first<ReceiptShare>(q, TABLE.receiptShares, "slug = $1", [slug]),
    async addDocument(d: StoredDocument) {
      await insert(q, TABLE.documents, d);
      return d;
    },
    updateDocument: (id, patch) => patchRow<StoredDocument>(TABLE.documents, id, "document", patch, false),
    findDocumentByCode: (code) => first<StoredDocument>(q, TABLE.documents, "code = $1", [code]),
    documentsForUser: (userId) => rows<StoredDocument>(q, TABLE.documents, "user_id = $1", [userId]),

    async addPaymentRequest(r: PaymentRequest) {
      await insert(q, TABLE.paymentRequests, r);
      return r;
    },
    async updatePaymentRequest(id, patch) {
      let from: PaymentRequest["state"] = "OPEN";
      const r = (await change<PaymentRequest>(TABLE.paymentRequests, id, `unknown payment request ${id}`, (row) => {
        from = row.state;
        return Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      }))!;
      announcePaymentRequestState(r, from);
      return r;
    },
    updatePaymentRequestFrom: async (id, from, patch) => {
      const r = await patchPaymentRequest(id, (row) => (from.includes(row.state) ? patch : null));
      return r.written ? r.request : null;
    },
    cancelUnpaidPaymentRequest: async (id, now = new Date(), evenIfExpired = false) => {
      const r = await patchPaymentRequest(id, (row) => cancelUnpaidOnRow(row, now, evenIfExpired));
      return r.written ? r.request : null;
    },
    recordPaymentRequestPayment: (id, apply) => patchPaymentRequest(id, apply),
    onPaymentRequestStateChange(listener) {
      paymentRequestStateListeners.push(listener);
    },
    findPaymentRequest: (id) => first<PaymentRequest>(q, TABLE.paymentRequests, "id = $1", [id]),
    findPaymentRequestByCode: (code) =>
      first<PaymentRequest>(q, TABLE.paymentRequests, "code = $1", [code.replace(/-/g, "").toUpperCase()]),
    paymentRequestsForUser: (userId) => rows<PaymentRequest>(q, TABLE.paymentRequests, "user_id = $1", [userId]),
    findPaymentRequestBySource: (kind, externalId, shop) =>
      first<PaymentRequest>(q, TABLE.paymentRequests, "source_kind = $1 AND source_external_id = $2 AND source_shop = $3", [kind, externalId, shop]),

    async addShopifyConnection(c: ShopifyConnection) {
      await insert(q, TABLE.shopifyConnections, c);
      return c;
    },
    updateShopifyConnection: (id, patch) => patchRow<ShopifyConnection>(TABLE.shopifyConnections, id, "Shopify connection", patch, true),
    async removeShopifyConnection(id) {
      await removeRow(TABLE.shopifyConnections, id);
    },
    findShopifyConnectionByShop: (shop) => first<ShopifyConnection>(q, TABLE.shopifyConnections, "shop = $1", [shop.trim().toLowerCase()]),
    shopifyConnectionsForOrg: (orgId) => rows<ShopifyConnection>(q, TABLE.shopifyConnections, "org_id = $1", [orgId]),
    shopifyDelivery: (id) => first<ShopifyDelivery>(q, TABLE.shopifyDeliveries, "id = $1", [id]),
    recordShopifyDelivery: (d: ShopifyDelivery) =>
      tx(async (t) => {
        const stale = Date.now() - 72 * 3_600_000;
        await prune<ShopifyDelivery>(t, TABLE.shopifyDeliveries, "TRUE", [], (x) => !(Date.parse(x.at) > stale));
        // A parallel first delivery of the same id waits on the key, then reads its row.
        const ins = await t.query("INSERT INTO shopify_deliveries (id, doc) VALUES ($1, $2::json) ON CONFLICT (id) DO NOTHING RETURNING id", [d.id, JSON.stringify(d)]);
        if (ins.rows.length) return d;
        const existing = await first<ShopifyDelivery>(t, TABLE.shopifyDeliveries, "id = $1", [d.id]);
        if (!existing) throw new Error(`Shopify delivery ${d.id} collides with a row that is gone`);
        return existing;
      }),
    async markShopifyDeliveryHandled(id) {
      await change<ShopifyDelivery>(TABLE.shopifyDeliveries, id, null, (d) => {
        if (d.handled) return null;
        d.handled = true;
        return d;
      });
    },

    async addMerchantLink(l: MerchantLink) {
      await insert(q, TABLE.merchantLinks, l);
      return l;
    },
    updateMerchantLink: (id, patch) => patchRow<MerchantLink>(TABLE.merchantLinks, id, "merchant link", patch, true),
    findMerchantLink: (id) => first<MerchantLink>(q, TABLE.merchantLinks, "id = $1", [id]),
    activeMerchantLinkForShop: (shop) =>
      first<MerchantLink>(q, TABLE.merchantLinks, "shop = $1 AND revoked_at IS NULL", [shop.trim().toLowerCase()]),
    merchantLinksForOrg: (orgId) => rows<MerchantLink>(q, TABLE.merchantLinks, "org_id = $1", [orgId]),
    async addReceiptShare(s: ReceiptShare) {
      await insert(q, TABLE.receiptShares, s);
    },
    updateReceiptShare: (id, patch) => patchRow<ReceiptShare>(TABLE.receiptShares, id, "receipt share", patch, true),
    revokeReceiptShare: async (id) =>
      (await change<ReceiptShare>(TABLE.receiptShares, id, `unknown receipt share ${id}`, (s) => {
        s.revokedAt = new Date().toISOString();
        s.updatedAt = s.revokedAt;
        return s;
      }))!,
    addSession: (s: Session) =>
      tx(async (t) => {
        await prune<Session>(t, TABLE.sessions, "TRUE", [], (x) => sessionDead(x, DAY_MS));
        await insert(t, TABLE.sessions, s);
      }),
    findSessionByTokenHash: (tokenHash) => first<Session>(q, TABLE.sessions, "token_hash = $1", [tokenHash]),
    revokeSession: async (id) =>
      (await change<Session>(TABLE.sessions, id, `unknown session ${id}`, (s) => {
        s.revokedAt = new Date().toISOString();
        return s;
      }))!,
    touchSession: (id) =>
      tx(async (t) => {
        const s = await locked<Session>(t, TABLE.sessions, id);
        if (!s) throw new Error(`unknown session ${id}`);
        // Telemetry, not a security control: minute granularity.
        const now = Date.now();
        if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
        s.lastUsedAt = new Date(now).toISOString();
        await save(t, TABLE.sessions, s);
        return s;
      }),
    findOperator: (id) => first<Operator>(q, TABLE.operators, "id = $1", [id]),
    findOperatorByEmail: (email) => first<Operator>(q, TABLE.operators, "email = $1", [email.trim().toLowerCase()]),
    async findOperatorCredential(credentialId) {
      const r = await q.query<{ doc: Operator }>(
        "SELECT o.doc FROM operator_credentials c JOIN operators o ON o.id = c.operator_id WHERE c.credential_id = $1",
        [credentialId],
      );
      const operator = r.rows[0]?.doc;
      const credential = operator?.credentials.find((c) => c.credentialId === credentialId);
      return operator && credential ? { operator, credential } : undefined;
    },
    addOperator: (o: Operator) =>
      tx(async (t) => {
        if ((await t.query("SELECT 1 FROM operators WHERE email = $1", [o.email])).rows.length) {
          throw new Error("an operator with that email exists");
        }
        const row = { ...o, email: o.email.trim().toLowerCase() };
        await insert(t, TABLE.operators, row);
        await syncOperatorCredentials(t, row);
        return row;
      }),
    addOperatorCredential: (operatorId, credential: OperatorCredential) =>
      tx(async (t) => {
        const o = await locked<Operator>(t, TABLE.operators, operatorId);
        if (!o) throw new Error(`unknown operator ${operatorId}`);
        if (o.disabledAt) throw new Error("this operator is disabled");
        if ((await t.query("SELECT 1 FROM operator_credentials WHERE credential_id = $1", [credential.credentialId])).rows.length) {
          throw new Error("that passkey is already registered");
        }
        o.credentials = [...o.credentials, credential];
        await save(t, TABLE.operators, o);
        await syncOperatorCredentials(t, o);
        return o;
      }),
    recordOperatorCredentialUse: (operatorId, credentialId, signCount) =>
      tx(async (t) => {
        const o = await locked<Operator>(t, TABLE.operators, operatorId);
        const c = o?.credentials.find((x) => x.credentialId === credentialId);
        if (!o || !c) throw new Error(`unknown operator credential ${credentialId}`);
        o.credentials = o.credentials.map((x) =>
          x.credentialId === credentialId ? { ...x, signCount, lastUsedAt: new Date().toISOString() } : x,
        );
        await save(t, TABLE.operators, o);
      }),
    disableOperator: (id) =>
      tx(async (t) => {
        const o = await locked<Operator>(t, TABLE.operators, id);
        if (!o) throw new Error(`unknown operator ${id}`);
        o.disabledAt ??= new Date().toISOString();
        for (const s of await rows<OperatorSession>(t, TABLE.operatorSessions, "operator_id = $1", [id], "FOR UPDATE")) {
          if (s.revokedAt) continue;
          s.revokedAt = o.disabledAt;
          await save(t, TABLE.operatorSessions, s);
        }
        await save(t, TABLE.operators, o);
        return o;
      }),
    addOperatorSession: (s: OperatorSession) =>
      tx(async (t) => {
        await prune<OperatorSession>(t, TABLE.operatorSessions, "TRUE", [], (x) => sessionDead(x, DAY_MS));
        await insert(t, TABLE.operatorSessions, s);
      }),
    findOperatorSessionByTokenHash: (tokenHash) => first<OperatorSession>(q, TABLE.operatorSessions, "token_hash = $1", [tokenHash]),
    revokeOperatorSession: async (id) =>
      (await change<OperatorSession>(TABLE.operatorSessions, id, `unknown operator session ${id}`, (s) => {
        s.revokedAt ??= new Date().toISOString();
        return s;
      }))!,
    touchOperatorSession: (id) =>
      tx(async (t) => {
        const s = await locked<OperatorSession>(t, TABLE.operatorSessions, id);
        if (!s) throw new Error(`unknown operator session ${id}`);
        const now = Date.now();
        if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
        s.lastUsedAt = new Date(now).toISOString();
        await save(t, TABLE.operatorSessions, s);
        return s;
      }),
    findUserByHandle: (handle) => first<User>(q, TABLE.users, "page_handle = $1", [handle.trim().toLowerCase()]),
    findUser: (id) => first<User>(q, TABLE.users, "id = $1", [id]),
    findOrgByHandle: (handle) => first<Organisation>(q, TABLE.organisations, "page_handle = $1", [handle.trim().toLowerCase()]),
    findUserByIban: (iban) => first<User>(q, TABLE.users, "iban_bare = $1", [iban.replace(/\s/g, "").toUpperCase()]),
    findQuote: (id) => first<Quote>(q, TABLE.quotes, "id = $1", [id]),
    findTransfer: (id) => first<Transfer>(q, TABLE.transfers, "id = $1", [id]),

    findCryptoSend: (id) => first<CryptoSend>(q, TABLE.cryptoSends, "id = $1", [id]),
    addCryptoSendUnderHold: (row: CryptoSend, holdId) =>
      tx(async (t) => {
        if (!(await releaseUnderCapLock(t, holdId))) throw new Error(`no cap hold ${holdId} — the send was not reserved`);
        await insert(t, TABLE.cryptoSends, row);
      }),
    claimCryptoSend: async (id) =>
      (await change<CryptoSend, boolean>(TABLE.cryptoSends, id, null, (s) => {
        // Past its deadline the link it pays may already read it as never sent.
        if (s.state !== "CREATED" || s.authorizedAt || Date.now() / 1000 > s.deadline) return null;
        const now = new Date().toISOString();
        Object.assign(s, { state: "SUBMITTED", authorizedAt: now, updatedAt: now });
        return true;
      })) ?? false,
    updateCryptoSend: (id, patch) => patchRow<CryptoSend>(TABLE.cryptoSends, id, "crypto send", patch, true),
    updateCryptoSendFrom: (id, from, patch) =>
      change<CryptoSend>(TABLE.cryptoSends, id, `unknown crypto send ${id}`, (row) =>
        from.includes(row.state) ? Object.assign(row, patch, { updatedAt: new Date().toISOString() }) : null,
      ),

    findCryptoDeposit: (chainId, txHash, logIndex) =>
      first<CryptoDeposit>(q, TABLE.cryptoDeposits, "chain_id = $1 AND tx_hash_lc = $2 AND log_index = $3", [String(chainId), txHash.toLowerCase(), logIndex]),
    addCryptoDeposit: (d: CryptoDeposit) =>
      tx(async (t) => {
        // Idempotent on (chainId, txHash, logIndex), as store.ts. A parallel
        // insert of the same transfer waits on the unique key and then finds this row.
        assertDepositKey(d);
        const key = "chain_id = $1 AND tx_hash_lc = $2 AND log_index = $3";
        const params = [String(d.chainId), d.txHash.toLowerCase(), d.logIndex];
        const existing = await first<CryptoDeposit>(t, TABLE.cryptoDeposits, key, params);
        if (existing) return existing;
        const ins = await t.query("INSERT INTO crypto_deposits (id, doc) VALUES ($1, $2::json) ON CONFLICT DO NOTHING RETURNING id", [d.id, JSON.stringify(d)]);
        if (ins.rows.length) return d;
        const winner = await first<CryptoDeposit>(t, TABLE.cryptoDeposits, key, params);
        if (!winner) throw new Error(`crypto deposit ${d.id} collides with another row`);
        return winner;
      }),
    updateCryptoDeposit: (id, patch) => patchRow<CryptoDeposit>(TABLE.cryptoDeposits, id, "crypto deposit", patch, true),
    patchCryptoDeposit: (id, make) =>
      change<CryptoDeposit>(TABLE.cryptoDeposits, id, `unknown crypto deposit ${id}`, (row) => {
        const patch = make(structuredClone(row));
        return patch ? Object.assign(row, patch, { updatedAt: new Date().toISOString() }) : null;
      }),
    settleCryptoDeposit: (id, decide) =>
      change<CryptoDeposit>(TABLE.cryptoDeposits, id, `unknown crypto deposit ${id}`, (row) => {
        if (row.settledAt) return null;
        const now = new Date().toISOString();
        return Object.assign(row, decide(structuredClone(row)), { settledAt: now, updatedAt: now });
      }),
    async cryptoDepositCursor(chainId) {
      const r = await q.query<{ b: string }>("SELECT block::text AS b FROM crypto_deposit_cursor WHERE chain_key = $1", [String(chainId)]);
      return r.rows[0] === undefined ? undefined : BigInt(r.rows[0].b);
    },
    async setCryptoDepositCursor(chainId, block) {
      await q.query(
        "INSERT INTO crypto_deposit_cursor (chain_key, block) VALUES ($1, $2::numeric) ON CONFLICT (chain_key) DO UPDATE SET block = EXCLUDED.block",
        [String(chainId), block.toString()],
      );
    },

    addOrganisation: (org: Organisation, seedCoa = true) =>
      tx(async (t) => {
        await insert(t, TABLE.organisations, org);
        await syncHandle(t, "organisation", org.id, pageHandle(org));
        if (seedCoa) await seedChart(t, org.id, org.createdAt);
        return org;
      }),
    findOrganisation: (id) => first<Organisation>(q, TABLE.organisations, "id = $1", [id]),
    lockOrganisation: (id) => tx((t) => locked<Organisation>(t, TABLE.organisations, id)),
    patchOrgSub: (id, key, fn, patch = {}) =>
      tx(async (t) => {
        if ("safe" in patch) throw new Error("an org Safe plan is written through setOrgSafePlan only");
        const o = await locked<Organisation>(t, TABLE.organisations, id);
        if (!o) throw new Error(`unknown organisation ${id}`);
        const handleBefore = pageHandle(o);
        Object.assign(o, patch, { [key]: fn(structuredClone(o[key])) }, { updatedAt: new Date().toISOString() });
        await saveOrg(t, o, handleBefore);
        return o;
      }),
    updateOrganisationIf: (id, ok, make) =>
      tx(async (t) => {
        const o = await locked<Organisation>(t, TABLE.organisations, id);
        if (!o) throw new Error(`unknown organisation ${id}`);
        if (!ok(structuredClone(o))) return null;
        const patch = make(structuredClone(o));
        if ("safe" in patch) throw new Error("an org Safe plan is written through setOrgSafePlan only");
        const handleBefore = pageHandle(o);
        Object.assign(o, patch, { updatedAt: new Date().toISOString() });
        await saveOrg(t, o, handleBefore);
        return o;
      }),
    async updateOrganisation(id, patch) {
      if ("safe" in patch) throw new Error("an org Safe plan is written through setOrgSafePlan only");
      return tx(async (t) => {
        const o = await locked<Organisation>(t, TABLE.organisations, id);
        if (!o) throw new Error(`unknown organisation ${id}`);
        const handleBefore = pageHandle(o);
        Object.assign(o, patch, { updatedAt: new Date().toISOString() });
        await saveOrg(t, o, handleBefore);
        return o;
      });
    },
    setOrgSafePlan: (orgId, plan: OrgSafePlan) =>
      tx(async (t) => {
        const o = applyOrgSafePlan(await locked<Organisation>(t, TABLE.organisations, orgId), orgId, plan);
        await save(t, TABLE.organisations, o);
        return o;
      }),
    replaceUndeployedOrgSafePlan: (orgId, oldAddress, plan) =>
      tx(async (t) => {
        const o = applyReplacedOrgSafePlan(await locked<Organisation>(t, TABLE.organisations, orgId), orgId, oldAddress, plan);
        await save(t, TABLE.organisations, o);
        return o;
      }),
    async organisationsForUser(userId) {
      const r = await q.query<{ member: Member; org: Organisation }>(
        "SELECT m.doc AS member, o.doc AS org FROM members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.seq",
        [userId],
      );
      return r.rows.map((x) => ({ member: x.member, org: x.org }));
    },

    async addMember(m: Member) {
      await insert(q, TABLE.members, m);
      return m;
    },
    findMember: (id) => first<Member>(q, TABLE.members, "id = $1", [id]),
    async memberFor(orgId, userId) {
      const found = await rows<Member>(q, TABLE.members, "org_id = $1 AND user_id = $2", [orgId, userId]);
      return found.find((m) => m.status !== "deactivated") ?? found[0];
    },
    findMemberByInviteHash: (tokenHash) => first<Member>(q, TABLE.members, "invite_token_hash = $1", [tokenHash]),
    membersOf: (orgId) => rows<Member>(q, TABLE.members, "org_id = $1", [orgId]),
    updateMember: (id, patch) => patchRow<Member>(TABLE.members, id, "member", patch, false),
    // The organisation row is locked first, so two changes to one org's
    // members are taken one after the other (§2 rule 4).
    updateMemberChecked: (id, patch, allowed) =>
      tx(async (t) => {
        const m0 = await first<Member>(t, TABLE.members, "id = $1", [id]);
        if (!m0) throw new Error(`unknown member ${id}`);
        await locked<Organisation>(t, TABLE.organisations, m0.orgId);
        const all = await rows<Member>(t, TABLE.members, "org_id = $1", [m0.orgId], "FOR UPDATE");
        const m = all.find((x) => x.id === id)!;
        if (!allowed(structuredClone(all), structuredClone(m))) return null;
        Object.assign(m, patch);
        await save(t, TABLE.members, m);
        return m;
      }),
    acceptInvite: (id, tokenHash, userId, at = new Date().toISOString()) =>
      tx(async (t) => {
        const m0 = await first<Member>(t, TABLE.members, "id = $1", [id]);
        if (!m0) return null;
        await locked<Organisation>(t, TABLE.organisations, m0.orgId);
        const all = await rows<Member>(t, TABLE.members, "org_id = $1", [m0.orgId], "FOR UPDATE");
        const m = all.find((x) => x.id === id)!;
        const patch = acceptInviteOnRow(m, tokenHash, userId, all, at);
        if (!patch) return null;
        Object.assign(m, patch);
        await save(t, TABLE.members, m);
        return m;
      }),

    async addAccount(a: Account) {
      // The id is minted fresh, so the one key this can meet is a company Safe's.
      const r = await q.query(
        "INSERT INTO accounts (id, doc) VALUES ($1, $2::json) ON CONFLICT (address_lc) WHERE backing_user_id IS NULL DO NOTHING RETURNING id",
        [a.id, JSON.stringify(a)],
      );
      return r.rows.length ? a : null;
    },
    findAccount: (id) => first<Account>(q, TABLE.accounts, "id = $1", [id]),
    accountsOf: (orgId) => rows<Account>(q, TABLE.accounts, "org_id = $1", [orgId]),
    accountsAtAddress: (address) => rows<Account>(q, TABLE.accounts, "address_lc = $1", [address.toLowerCase()]),
    updateAccount: (id, patch) => patchRow<Account>(TABLE.accounts, id, "account", patch, true),

    async addContact(c: Contact) {
      await insert(q, TABLE.contacts, c);
      return c;
    },
    findContact: (id) => first<Contact>(q, TABLE.contacts, "id = $1", [id]),
    contactsOf: (orgId) => rows<Contact>(q, TABLE.contacts, "org_id = $1", [orgId]),
    updateContact: (id, patch) => patchRow<Contact>(TABLE.contacts, id, "contact", patch, true),
    removeContact: (id) => removeRow(TABLE.contacts, id),

    async addDraft(d: DraftPayment) {
      await insert(q, TABLE.drafts, d);
      return d;
    },
    findDraft: (id) => first<DraftPayment>(q, TABLE.drafts, "id = $1", [id]),
    draftsOf: (orgId) => rows<DraftPayment>(q, TABLE.drafts, "org_id = $1", [orgId]),
    updateDraft: (id, patch) => {
      refuseActivityPatch(patch);
      return patchRow<DraftPayment>(TABLE.drafts, id, "draft", patch, true);
    },
    updateDraftFrom: (id, patch, c) => {
      refuseActivityPatch(patch);
      return change<DraftPayment>(TABLE.drafts, id, `unknown draft ${id}`, (row) => {
        const next = draftPatchOnRow(row, patch, c);
        return next ? Object.assign(row, next, { updatedAt: new Date().toISOString() }) : null;
      });
    },
    appendDraftActivity: async (id, entry, patch = {}) =>
      (await change<DraftPayment>(TABLE.drafts, id, `unknown draft ${id}`, (row) =>
        Object.assign(row, patch, { activity: [...row.activity, entry], updatedAt: new Date().toISOString() }),
      ))!,
    claimDraftExecution: (id, from = ["REVIEWED"], expectedUpdatedAt) =>
      change<DraftPayment>(TABLE.drafts, id, null, (d) => {
        if (!from.includes(d.state)) return null;
        if (expectedUpdatedAt !== undefined && d.updatedAt !== expectedUpdatedAt) return null;
        d.state = "EXECUTING";
        d.updatedAt = new Date().toISOString();
        return d;
      }),

    async addInvoice(i: Invoice) {
      await insert(q, TABLE.invoices, i);
      return i;
    },
    findInvoice: (id) => first<Invoice>(q, TABLE.invoices, "id = $1", [id]),
    findInvoiceByLinkHash: (hash) => first<Invoice>(q, TABLE.invoices, "link_token_hash = $1", [hash]),
    invoicesOf: (orgId) => rows<Invoice>(q, TABLE.invoices, "org_id = $1", [orgId]),
    updateInvoice: (id, patch) => patchRow<Invoice>(TABLE.invoices, id, "invoice", patch, true),
    updateInvoiceFrom: (id, from, patch) =>
      change<Invoice>(TABLE.invoices, id, `unknown invoice ${id}`, (row) =>
        from.includes(row.state) ? Object.assign(row, patch, { updatedAt: new Date().toISOString() }) : null,
      ),
    settleInvoice: (id, ref, update, replace = false) =>
      change<Invoice>(TABLE.invoices, id, `unknown invoice ${id}`, (row) => {
        const patch = settlementOnRow(structuredClone(row), ref, update, replace);
        return patch ? Object.assign(row, patch, { updatedAt: new Date().toISOString() }) : null;
      }),
    startInvoicePayment: (invoiceId, from, draft) =>
      tx(async (t) => {
        const i = await locked<Invoice>(t, TABLE.invoices, invoiceId);
        if (!i) throw new Error(`unknown invoice ${invoiceId}`);
        if (!from.includes(i.state)) return null;
        await insert(t, TABLE.drafts, draft);
        Object.assign(i, { state: "PAYING", payment: { ...i.payment, draftId: draft.id }, updatedAt: new Date().toISOString() });
        await save(t, TABLE.invoices, i);
        return { invoice: i, draft };
      }),

    async addImportedWallet(w: ImportedWallet) {
      await insert(q, TABLE.importedWallets, w);
      return w;
    },
    findImportedWallet: (id) => first<ImportedWallet>(q, TABLE.importedWallets, "id = $1", [id]),
    importedWalletsOf: (orgId) => rows<ImportedWallet>(q, TABLE.importedWallets, "org_id = $1", [orgId]),
    updateImportedWallet: (id, patch) => patchRow<ImportedWallet>(TABLE.importedWallets, id, "imported wallet", patch, false),
    removeImportedWallet: (id) => removeRow(TABLE.importedWallets, id),

    chartOf: (orgId) => rows<ChartAccount>(q, TABLE.chartAccounts, "org_id = $1", [orgId]),
    async addChartAccount(c: ChartAccount) {
      await insert(q, TABLE.chartAccounts, c);
      return c;
    },
    updateChartAccount: (id, patch) => patchRow<ChartAccount>(TABLE.chartAccounts, id, "chart account", patch, false),
    rulesOf: (orgId) => rows<AccountRule>(q, TABLE.accountRules, "org_id = $1", [orgId]),
    async addAccountRule(r: AccountRule) {
      await insert(q, TABLE.accountRules, r);
      return r;
    },
    removeAccountRule: (id) => removeRow(TABLE.accountRules, id),
    async seedChartOfAccounts(orgId) {
      await tx((t) => seedChart(t, orgId));
    },

    ledgerOf: (orgId) => rows<LedgerEntry>(q, TABLE.ledger, "org_id = $1", [orgId]),
    addLedgerEntries: (entries: LedgerEntry[]) =>
      tx(async (t) => {
        for (const e of entries) await insert(t, TABLE.ledger, e);
        return entries;
      }),
    updateLedgerEntry: (id, patch) => patchRow<LedgerEntry>(TABLE.ledger, id, "ledger entry", patch, false),
    /** Bulk replace after a rule run: whole rows, one transaction. An id
     *  with no row is ignored, as in store.ts. */
    replaceLedgerEntries: (entries: LedgerEntry[]) =>
      tx(async (t) => {
        for (const e of entries) await save(t, TABLE.ledger, e);
      }),

    async recordMoneriumIssue(r: MoneriumIssueRecord) {
      const ins = await q.query<{ doc: MoneriumIssueRecord }>(
        "INSERT INTO monerium_issue_orders (order_id, doc) VALUES ($1, $2::json) ON CONFLICT (order_id) DO NOTHING RETURNING doc",
        [r.orderId, JSON.stringify(r)],
      );
      if (ins.rows.length) return r;
      const existing = await q.query<{ doc: MoneriumIssueRecord }>("SELECT doc FROM monerium_issue_orders WHERE order_id = $1", [r.orderId]);
      return existing.rows[0]!.doc;
    },
    async addConversionSweep(s: ConversionSweep) {
      await insert(q, TABLE.conversionSweeps, s);
      return s;
    },
    documentsForOrg: (orgId) => rows<StoredDocument>(q, TABLE.documents, "org_id = $1", [orgId]),
  };
  return backend;
  }

  const owner = {};
  /** The connection of each open transaction, for its savepoints. */
  const clients = new WeakMap<StoreMethods, TxSql>();
  const base = build(database, (fn) => database.tx(fn));
  // A call made inside a transaction runs on its client, through `t` or `store`.
  const routed: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(base)) {
    routed[name] =
      typeof f !== "function" || name === "onTransferStateChange" || name === "onPaymentRequestStateChange"
        ? f
        : (...args: unknown[]) => {
            const open = currentTx(owner);
            if (!open && isLock(name)) return Promise.reject(lockOutsideTx(name));
            return ((open ?? base) as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
          };
  }
  const store: StoreBackend = {
    ...(routed as StoreMethods),
    // `used` reads the store: in a transaction of its own, so those reads run
    // on the connection that holds the cap's lock, not on another one from
    // the pool (which parallel holders waiting on the lock could exhaust).
    holdDailyCap: (capKey, eur, capEur, used) => store.tx((t) => t.holdDailyCap(capKey, eur, capEur, used)),
    tx<T>(fn: (t: StoreMethods) => Promise<T> | T): Promise<T> {
      const open = currentTx(owner);
      if (open) return nestedTx(owner, fn, (f) => clients.get(open)!.savepoint(f))!;
      const hooks = newTxHooks();
      return endTx(
        database.tx((client) => {
          const t = build(client, (f) => f(client));
          clients.set(t, client);
          return inScope(owner, t, fn, hooks);
        }),
        hooks,
      );
    },
    close: () => database.close(),
  };
  return store;
}
