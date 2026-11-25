# Postgres store (design)

Board #166. Not yet approved by the owner. Code references were checked against
main 9f905eb (2026-11-25). Paths are under `services/api/src/` unless they
start with `scripts/`.

The store moves from `db.json` straight to Postgres, with no SQLite step.
The API and Postgres run together on one Oracle Cloud ARM host (Ampere,
aarch64), Postgres on its unix socket only with no database port open, and
everything moves off Akash (§7). This note does not reopen either choice.
The hub's own database (`hub.db` in Agentic-payment-protocol) is out of
scope.

**What this note decides:** one table per collection, typed key columns
generated from a JSONB document, uniqueness enforced by the database, an
async store with `store.tx`, a JSON backend and a Postgres backend behind one
interface until cut-over, PGlite for the offline suites and a real Postgres 17
for the concurrency tests, plain numbered SQL migrations, an outbox for
webhooks, a ledger whose rows cannot be deleted and whose every change is kept,
Postgres on a unix socket on the Oracle host with pgBackRest PITR to OCI
Object Storage in two regions, a rebuild path for losing the host, and
eight slices. **What it leaves to the owner:** whether the hub stays
separate, the OCI region, processing agreement and account type, the
recovery-time target, and when to cut over (§9).

## 0. What exists today

- `store/db.ts` holds one `Db` object (`db.ts:52-120`, 33 collections) in
  memory. Every write serialises the whole object, fsyncs it and renames it
  over `data/db.json` (`persist`, `db.ts:452-484`). A failed write exits the
  process, so memory never serves a change the disk refused (`db.ts:471-483`).
- `batched(fn)` (`db.ts:489-504`) folds a block of writes into one file write
  and refuses an async `fn`. It is called at 9 places (§3).
- `store.ts` is the only code that touches `db`. It has 84 `persist()` calls.
  Its getters (`store.users`, `store.transfers`, … `store.ts:143-157`,
  `:651`, `:678`, `:1033-1062`) hand out the live arrays, and every `find…`
  hands out the live row.
- Correctness rests on one fact: a handler is not interrupted between a read
  and a write unless it awaits. The claim methods say so in their comments
  (`claimAuthorization` `store.ts:502-521`, `addSafeOpSignature` `:338-353`,
  `claimDraftExecution` `:1222-1248`, `holdDailyCap` `:453-481`).
- Migrations run at every load and are idempotent (`initStore`,
  `db.ts:171-225`).
- Stored credentials are sealed per field with AES-256-GCM and an AAD of
  `purpose|table|rowId|field` (`crypto-at-rest.ts:1-22`). The `table` in that
  AAD is the collection name, e.g. `shopifyConnections`
  (`stored-secrets.ts:37-46`).

## 1. Inventory: one table per collection

### 1.1 Row shape

Every table is:

```sql
CREATE TABLE <name> (
  id   text PRIMARY KEY,
  doc  jsonb NOT NULL,
  -- typed key columns, each GENERATED ALWAYS AS (…) STORED from doc
  ...
);
```

The row shape in `store/types.ts` and `domain/types.ts` stays the source of
truth. `doc` holds the whole row as the JSON backend has it. Every column we
look up, join or constrain on is a **stored generated column** over `doc`
(Postgres 12+), for example
`state text GENERATED ALWAYS AS (doc->>'state') STORED` or
`address_lc text GENERATED ALWAYS AS (lower(doc->>'address')) STORED`.

Why this shape for slice 1:

- A generated column cannot disagree with `doc`. Two copies of one fact,
  written by hand, can.
- The importer (§6) writes `doc` as it is in `db.json`, and the export back
  is `SELECT doc`. Round-trip checks compare like with like.
- The store methods keep their bodies: read the doc, apply the same
  JavaScript, write the doc. The guards in them (`updateTransfer`'s refusal
  to move a final state backwards, `store.ts:525-540`) do not have to be
  rewritten in SQL to stay correct.
- Unique constraints and indexes work on generated columns.

What moves to real columns later (not in #166): amounts on `transfers`,
`cryptoSends` and `ledger` as `numeric`, so reports can sum in SQL; `txs`
steps of a transfer as a child table, if the reconciler wants to query them.
Nothing in this task needs either.

Collections that are arrays of strings or a map get their own shape:
`processed_monerium_orders(order_id text PRIMARY KEY, at timestamptz)`,
`processed_monerium_webhooks(webhook_id text PRIMARY KEY, at timestamptz)`,
`crypto_deposit_cursor(chain_key text PRIMARY KEY, block numeric NOT NULL)`.

### 1.2 Tables

Keys below are the generated columns. "UNIQUE" means a unique index; "idx"
a plain one. "Sealed" fields are already encrypted by `stored-secrets.ts` and
move byte for byte. "Credential" means a hash or code that grants access
(AGENTS.md: slugs and codes are credentials).

| Collection (`db.ts` line) | Unique / idempotency keys | Indexed (lookups in `store.ts`) | FK | Sensitive | Writes |
|---|---|---|---|---|---|
| users (53) | passkey credential id (`findUserByCredential` :376); payment-page handle, lower (:925), and across organisations through `payment_handles` (below) | lower(address) (:373); lower(passkeySafe.address) (:400); lower(email) (:383, not unique: several rows per address by design :379-382); bare IBAN (:937) | — | email, name, IBAN, KYC, Monerium tokens and API secret (sealed, `stored-secrets.ts:42-44`) | update |
| quotes (54) | — | status, expires_at (pruned :429-430) | user_id → users | — | update; **pruned** |
| transfers (55) | **quote_id** (one transfer per quote; the consumption key, §2) | user_id, state, created_at | user_id → users, quote_id → quotes | reference text, payee IBAN | update; never deleted |
| sessions (56) | token_hash (:819) | user_id, expires_at | user_id → users | credential | update; **pruned** (`db.ts:239-245`) |
| operators (58) | lower(email) (:849, :862) | — | — | — | update |
| operator_credentials (new, from `operators[].credentials`) | credential_id (:870 checks this across all operators) | operator_id | operator_id → operators | — | update |
| operatorSessions (59) | token_hash (:904) | operator_id | operator_id → operators | credential | update; **pruned** (:896-900) |
| serviceCredentials (61) | — | service (:207) | — | credential hash | update |
| receiptShares (63) | slug (:648); transfer_id WHERE revoked_at IS NULL (one live share, :637-646) | transfer_id | transfer_id → transfers | credential | update |
| documents (66) | code (:666) | user_id, org_id | user_id, org_id | credential; frozen snapshot | update (revoke only) |
| paymentRequests (69) | code (:703); (source kind, shop, external id) (:713-717) | user_id, state | user_id | credential | update |
| shopifyConnections (72) | shop (:740) | org_id | org_id | access token, order-link secret (sealed, `stored-secrets.ts:38-39`) | update; **deleted** (:735) |
| shopifyDeliveries (74) | id = delivery id | at (pruned :752-753) | — | — | **pruned** |
| merchantLinks (77) | shop WHERE revoked_at IS NULL (:785-787) | org_id | org_id | link secret (sealed, :40) | update; never deleted |
| processedMoneriumOrders (79) | order_id (PK) | — | — | — | append |
| processedMoneriumWebhooks (81) | webhook_id (PK) | — | — | — | append |
| moneriumIssueOrders (83) | order_id (:1360) | account / user | — | payer name, IBAN | append |
| conversionSweeps (85) | — | user_id | user_id | — | append |
| cryptoDeposits (87) | (lower(tx_hash), log_index) (:984-1009) | user_id, holding, invoice_id, payment_request_id | user_id | — | update |
| cryptoSends (88) | — | user_id, state, account | user_id | — | update |
| audit (90) | — | user_id, at | — | operator notes | **append only** (:235-242) |
| recoveryRequests (92) | (user_id) WHERE mode='zoldenburg' AND status='GRACE_PERIOD' (§2) | user_id, status | user_id | access hash (credential) | update |
| safeOps (94) | — | org_id, state | org_id | — | update |
| cryptoDepositCursor (102) | chain_key (PK) | — | — | — | upsert |
| organisations (110) | payment-page handle, lower (:933), and across users through `payment_handles` (below) | — | — | GetMyInvoices key, Monerium API secret (sealed, :41, :45) | update; never deleted |
| members (111) | invite token hash (:1142); (org_id, user_id) WHERE status <> 'deactivated' (:1136-1141) | org_id, user_id | org_id, user_id | credential | update; never deleted |
| accounts (112) | — | org_id, lower(address) (:1167), backing_user_id (:185) | org_id, backing_user_id | IBAN | update; never deleted |
| importedWallets (113) | — | org_id | org_id | — | update; **deleted** (:1290) |
| contacts (114) | — | org_id | org_id | payee IBAN, address | update; **deleted** (:1197) |
| drafts (115) | — | org_id, state | org_id | — | update |
| invoices (116) | link token hash (:1258) | org_id, state | org_id | credential; payer data | update; never deleted (`DELETED` is a state, `routes/business/invoices.ts:154`) |
| chartAccounts (117) | (org_id, code) | org_id | org_id | — | update |
| accountRules (118) | — | org_id | org_id | — | update; **deleted** (:1320) |
| ledger (119) | (org_id, statement key) WHERE statement IS NOT NULL (`bookkeeping/statement.ts:559-572` matches by key) | org_id, lower(tx_hash) (`hashOnRecord` :135) | org_id | — | no delete; updated (§5) |

Rules for the table above:

- A unique index goes in only where the importer finds no duplicate in the
  live data. Where it finds one, the index is plain, the importer reports the
  rows, and the duplicate is a finding for the lead, not something the
  migration repairs.
- Foreign keys are `ON DELETE RESTRICT`. The same rule: added only where the
  importer finds no orphan.
- **The `table` in a sealed field's AAD stays the collection name**
  (`shopifyConnections`, not `shopify_connections`), and `rowId` stays the
  row's `id`. Changing either makes every sealed value unopenable. The SQL
  table names are snake_case; `stored-secrets.ts` does not change.
- Field encryption stays exactly as it is. Disk encryption comes from OCI
  (§7). No new field is encrypted in #166.
- Ids keep their current text values (`org_…`, `acc_…`, uuids). No serials.

New tables: `schema_migrations`, `outbox` (§5), `ledger_history` (§5),
`cap_holds` (§2), `pending_executions` (§2), and
`payment_handles(handle_lc text PRIMARY KEY, owner_kind text, owner_id text)`.
A user's and an organisation's payment pages share one namespace
(`routes/business/org-payment-page.ts:79-91`), and `/pay/:handle` tries the
user first (`routes/payment-page.ts:233-239`), so two per-table unique
indexes are not enough: a user and an org could each claim one handle and the
org's page would never be served. Every store method that sets or clears a
`paymentPage.handle` writes `payment_handles` in the same transaction; the
primary key refuses the second claim whichever table it comes from. The
importer fills it from both collections and reports a handle held by both as
a finding.

## 2. The async problem

Once a store read is awaited, another request can run between a check and the
write that depends on it. On Postgres a second API instance could too, so
in-memory guards are not enough for the target either.

Two rules cover most of it:

1. **Every store write method is one transaction that locks its row.** It
   runs `SELECT doc … FOR UPDATE`, applies the method's existing body, and
   writes. So everything that is checked inside one method today
   (`claimAuthorization`, `claimCryptoSend`, `claimSafeOpRelay`,
   `addSafeOpSignature`, `finishSafeOp`, `endPendingSafeOp`,
   `claimDraftExecution`, `consumeQuote`, `updateTransfer`'s final-state
   guard, `resolveTransferReview`, `setOrgSafePlan`) stays correct without
   being rewritten.
2. **A check in the caller and a write later is a race** unless a unique
   constraint or a lock covers it. Those are the cases below.

Isolation is `READ COMMITTED` with explicit `FOR UPDATE`. `SERIALIZABLE`
would also be correct, but its retries would reach code that calls partners
between reads, and we would rather refuse than retry a money path.

| Path | Today's guard (evidence) | On Postgres | Concurrency test (Postgres 17) |
|---|---|---|---|
| Quote → transfer | `holdDailyCap` takes an in-memory hold with no yield between count and record (`transfers/build.ts:157-168`, `store.ts:470-481`); `consumeQuote` (`build.ts:169`, `store.ts:441-448`); `addTransferUnderHold` (`build.ts:370`) | Hold: `store.tx` takes `pg_advisory_xact_lock(hashtext('cap:'||capKey))`, recomputes `used` from the database inside the lock, and inserts a `cap_holds` row with an expiry. Consume: one conditional `UPDATE quotes … WHERE status='OPEN'`. The transfer insert and the hold delete are one transaction, and `UNIQUE(transfers.quote_id)` refuses a second transfer for a quote whatever the code does | 20 parallel `POST /transfers` on one quote: one 201, the rest 409. 2 parallel transfers each at the full cap: one passes |
| Authorise and submit a transfer | `claimAuthorization` after the `CREATED` check (`routes/transfers.ts:444`, `store.ts:513-521`) | Rule 1. The caller's earlier `CREATED` check is advisory only | 10 parallel `/authorize` with one signature: exactly one reaches the orchestrator |
| Transfer state machine | `updateTransfer` refuses to leave REFUNDED/PAID/MANUAL_REVIEW (`store.ts:525-540`) | Rule 1 (the guard runs on the locked row). State-change listeners (`:80-89`) move to the outbox, written in the same transaction (§5) | A late `PAID` racing a sweep `REFUNDED`: the final state is the first one committed; the other write keeps its other fields |
| Outbound intents | Intent written and fsynced before the call; a failed write exits, so "no intent on disk means the call never went out" (`orchestrator.ts:529-533`, `:848-851`) | The intent write is awaited and committed before the call. A failed commit throws, so the call is not made. A commit whose outcome is unknown (connection lost during `COMMIT`) is treated as written: the sweep reads the intent and the transfer goes to review, the safe direction. No exit needed | Kill the connection during the intent commit: no partner call; on restart the transfer is either untouched or in review |
| Crypto send | `holdDailyCap` (`routes/crypto-sends.ts:262`), `addCryptoSendUnderHold` (:356, :437), `claimCryptoSend` (:619, `store.ts:964-972`) | As quote → transfer for the hold; rule 1 for the claim | Parallel submits of one send: one `SENT`/`SUBMITTED`. Parallel sends at the cap from one org Safe: one passes (cap key `orgSafeCapKey`, `wallet/org-debit.ts:174`) |
| Org Safe op queue | `addSafeOpSignature` (`routes/business/safe-ops.ts:180`), `claimSafeOpRelay` / `finishSafeOp` (`wallet/org-safe-queue.ts:174-196`) | Rule 1 on the op row | Two owners sign at once: both signatures land. One owner twice: one lands. Two relays: one claims |
| Draft payments | `claimDraftExecution` with `expectedUpdatedAt` (`routes/business/drafts.ts:408`, `:704`) | Rule 1 | Two parallel executes of one reviewed draft: one claims |
| Managed recovery start | Check open requests, maybe cancel the idle one, then add (`routes/recovery-zoldenburg.ts:629-674`); `relaying` is an in-memory set (`:322`) | `store.tx` locks the user row (`SELECT … FROM users WHERE id=$1 FOR UPDATE`) for the whole check-cancel-add. The partial unique index on one `GRACE_PERIOD` request per user backs it. `relaying` becomes a `RELAYING` status in the row, written before the chain call, with the status it came from and the time. Cancel and expiry wait while it is set, as they wait on the set today. A restart can leave it set, so the sweep (`:327-342`) reconciles: a `RELAYING` row older than the relay timeout is synced from the chain (`syncZoldenburgFromChain`); a relayed signature or finalisation moves it to the status the chain shows, and nothing on chain moves it back to the status it came from, so the next sweep or admin action relays again. It never stays `RELAYING` across a sweep that has passed the timeout | Parallel starts for one account at `MAX_OPEN_REQUESTS`: never more than the limit; two finalisers: one relays. Stop the process after `RELAYING` is written: with the relay on chain the row reaches its grace period; without, it is back in its old status and relays once |
| Payment request paid | `record()` reads the row, `applyPayment` merges in place, then writes (`routes/payment-requests.ts:559-575`; in-place merge `payment-requests.ts:551`) | One store method, `recordPaymentRequestPayment(id, payment)`, runs `applyPayment` on the locked row. The "became PAID" hook is an outbox row in the same transaction | A Monerium order and our own transfer for one payment, recorded in parallel: one payment row, merged; the PAID hook fires once |
| Invoice paid | Read the invoice, check its settlement ref, write (`routes/payment-requests.ts:656-663`, `adapters/crypto-deposits.ts:627-632`, `routes/business/state.ts:97-144`) | One store method, `settleInvoice(id, settlement)`, checks the ref on the locked row | The poller and a webhook settle one order in parallel: one settlement |
| Ledger | `batched` blocks in `wallet-sync/sync.ts:300`, `wallet-sync/revalue.ts:82`, `bookkeeping/writer.ts:260`, `routes/orgs.ts:1147`; rule runs compute replacements from rows read earlier, then replace them (`routes/business/bookkeeping.ts:152-162`) | `store.tx` holding `pg_advisory_xact_lock(hashtext('ledger:'||org_id))`, taken by every ledger write: statement writer, sync, revalue, rule run, categorise. A write reads the rows it changes inside that lock, never before it: the rule run becomes one store method, `applyAccountRules(orgId)`, that reads rules and rows, runs `applyRules` and writes, all under the lock. `replaceLedgerEntries` also refuses a row whose stored `updatedAt` is not the one the caller read, so a replacement computed from a stale row fails instead of overwriting. The statement writer's add path is backed by `UNIQUE(org_id, statement key)`, so two sweeps cannot add a line twice | Two statement sweeps in parallel: same lines as one sweep. Revalue racing a categorise: both changes kept, in history. A rule run racing a revalue and a hand categorisation: the revalued value and the hand category both survive |
| Monerium order dedupe | `isOrderProcessed`, then an in-memory `recording` claim, then awaits, then `markOrderProcessed` (`adapters/monerium-sandbox.ts:466-527`) | The claim is `INSERT INTO processed_monerium_orders … ON CONFLICT DO NOTHING` as the last step of the recording transaction, with `recordMoneriumIssue` in the same transaction. `recording` stays for the in-flight window (one process); a second instance would get the duplicate refused by the key | Poller and two webhook deliveries for one order in parallel: one `recorded`, one issue record, one statement line |
| Monerium webhook dedupe | `isWebhookProcessed`, handle, `markWebhookProcessed` (`routes/monerium-webhook.ts:51-63`); today an array scan | `webhook_id` primary key; the mark is `ON CONFLICT DO NOTHING`. Handling twice is already safe because the order dedupe above holds | Two deliveries of one id in parallel: one is recorded and answered 2xx. The other answers 2xx `duplicate` if it arrives after, or 503 `retry` if it arrives while the first is recording (`mirrorOrder` returns `unavailable`, `adapters/monerium-sandbox.ts:490-502`, and the route answers 503, `routes/monerium-webhook.ts:55-64`); its retry then answers 2xx `duplicate`. One issue record either way |
| Shopify delivery dedupe | `shopifyDelivery`, record, mark on finish (`routes/shopify.ts:668-678`) | `INSERT … ON CONFLICT (id) DO NOTHING RETURNING`; a conflict reads the row and checks its shop. Order create is backed by `UNIQUE(kind, shop, external_id)` on payment requests | One delivery id twice in parallel: one request created. Same order id from two shops: two requests |
| Crypto deposits | Idempotent on (txHash, logIndex) (`store.ts:990-1009`) | `UNIQUE(lower(tx_hash), log_index)`, `ON CONFLICT DO NOTHING` then read | Two overlapping scans of one window: one row |
| Passkey sign count | `recordPasskeyUse` only while the credential is still the account's (`store.ts:202-206`), 11 callers (`http/passkey-assertion.ts:44`, `routes/auth.ts:122`, …) | Rule 1 on the user row | A recovery replacing the passkey while an assertion records its count: the count is refused, the new passkey stays |
| Sessions | `findSessionByTokenHash`, `touchSession` (`store.ts:819-841`) | One indexed read per request; the touch is a conditional `UPDATE … WHERE last_used_at < now() - 60s`. Pruning is a periodic `DELETE`, not part of `addSession` | — (not a money path) |
| Imported-wallet proof | `batched` re-reads before writing (`routes/orgs.ts:1244-1294`) | `store.tx` with the wallet row locked | Two proofs at once: one wins, the other 409 |

**Approvals waiting for a passkey move to the database.** Preparing a
transfer's or a crypto send's UserOperation and approving it are separate
requests; today the prepared operation waits in `pendingTransferExecutions`
and `pendingCryptoSends` (`http/pending.ts:56`, `:71`), so a restart, or a
second process, answers the approval 410 (`routes/crypto-sends.ts:531-534`).
S3 moves both to `pending_executions(kind, id, user_id, expires_at, doc)`:
the plan, the unsigned UserOperation, its challenge and the batch recipient,
none of them a secret. The approval reads it on the locked transfer or send
row, deletes it in the same transaction as the claim, and expired rows are
pruned. The other pending maps in `http/pending.ts` (Safe deployments,
Monerium link signatures) stay in memory: a restart asks the user to repeat a
setup step and moves no money. The checkout-webhook retry timers stay until
S4 replaces them. `capHolds` (`store.ts:72`) and `relaying` move to the
database as above. With those moved, nothing on a money path depends on
there being one process; running a second one is still a separate decision.

## 3. Store API

Today: 1,256 `store.…` uses in 109 files under `services/api/src` (outside
`store.ts` and `store/`), and 2,028 in 79 test scripts under `scripts/`.
`store.findUser` alone is 155 of them, `store.updateUser` 64,
`store.updateTransfer` 45. `store.batched(` is called at:
`wallet-sync/sync.ts:300`, `wallet-sync/revalue.ts:82`,
`bookkeeping/writer.ts:260`, `bookkeeping/issue.ts:116`, `routes/users.ts:268`,
`routes/orgs.ts:1147`, `:1244`, `:1281`, `routes/business/income-invoices.ts:272`,
plus `scripts/reencrypt-fields.ts:30`, which imports it from `store/db.js`.

The shape:

```ts
interface StoreBackend { /* every method of today's store, returning Promise<…> */ }

store.findUser(id): Promise<User | undefined>
store.updateUser(id, patch): Promise<User>
store.tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>   // replaces batched
// t has the same methods, bound to the transaction, plus
t.lockUser(id) / t.lockKey(key)                      // FOR UPDATE / advisory lock
```

- `store.tx` replaces `batched`. Inside it, `await` is allowed; partner and
  chain calls are not (a lint grep in `scripts/check.ts` refuses `fetch`,
  `writeAndWait` and the adapters inside a `store.tx` callback, the same way
  the grep suites work today). A transaction does not span I/O we do not own.
- Each getter that returns a whole collection (`store.users`,
  `store.transfers`, …) becomes `await store.list("users")` in S2, and a real
  query in S3 where it is on a request path. Scans on sweeps
  (`bookkeeping/writer.ts:262`, `hashOnRecord` `store.ts:112-138`) may stay
  scans for #166.
- **Rows are copies.** The Postgres backend returns parsed JSON, never a live
  object. Code that mutates a row and relies on a later write finds that out
  only on Postgres. So in S2 the JSON backend returns `structuredClone`d rows
  too. One known case: `applyPayment` merges into the stored row in place
  (`payment-requests.ts:551`) and `record()` then writes `r.payments`
  (`routes/payment-requests.ts:567`); S3 moves it into the store method.
- `store.ts` stays the only code that touches the database. Its header and
  the invariants (no method deletes an org, account, invoice or ledger row)
  stay; §5 adds the database's own refusal.
- Listeners (`onTransferStateChange`, `onPaymentRequestStateChange`) become
  outbox kinds in S4. Until then they run after commit, as they run after
  `persist()` today.

The JSON backend after S2 is today's code behind the interface, with the
methods synchronous inside and one process-wide async mutex in front of
**every** method, reads included:

- A call outside a transaction takes the mutex, runs, persists before it
  releases (a write), and returns. It cannot run while a `store.tx` holds the
  mutex, so it never reads a transaction's half-made changes, and its own
  write is on disk before it returns, as today.
- `store.tx` holds the mutex from start to end. Calls on its `t` run without
  taking it again. The file is written once at the end. No other call's write
  is folded into it: nothing else runs meanwhile, which is the difference
  from reusing `batched`'s global depth counter.
- A callback that throws: the writes it made are persisted, as `batched` does
  today. The JSON backend has no rollback; the Postgres backend rolls back.
  That difference is why §3 step 3 moves each check-then-write into one store
  method that checks before it writes.

Behaviour does not change; only the call sites gain `await`, and requests
that used to interleave between synchronous calls now queue behind a
transaction. The JSON suites assert both: a read issued while a `store.tx`
callback awaits returns the state from before the transaction, and a write
outside it is on disk when it resolves.

Mechanical order for S2 (each step leaves `npm run check` green):

1. Add the interface and make every method `async` on the JSON backend.
   TypeScript then marks every caller that uses a result without `await`.
2. Convert leaf modules first (`users/`, `domain/`, `http/`), then
   `adapters/`, `bookkeeping/`, `wallet*/`, `orchestrator.ts`,
   `transfers/build.ts`, then `routes/`. A function that gains an `await`
   becomes `async`, and its callers follow.
3. Before converting a caller listed in §2, move its check-then-write into
   one store method or a `store.tx` first, in the same commit. The window that
   was synchronous must not open on the JSON backend either.
4. Convert the test scripts last (`initStore()` → `await initStore()`,
   reads awaited).
5. Remove `batched` and the sync `persist` export; move
   `scripts/reencrypt-fields.ts` to `store.tx`.

## 4. Backends and tests

- **One interface, two backends** until cut-over: `STORE_BACKEND=json`
  (default until S8) or `postgres` with `DATABASE_URL`. The Postgres backend
  takes `DATABASE_URL` and an optional `DATABASE_CA` (PEM path), nothing
  host-specific. A unix socket or loopback needs no TLS. Any other host on a
  real-money chain needs `sslmode=verify-full` and the CA, or the API refuses
  to start (§7).
- **Driver:** `pg` (node-postgres, MIT, 8.x). Small, plain, a pool and
  parameterised queries; nothing else is needed.
- **Offline suites on PGlite.** `@electric-sql/pglite` 0.6.0, Apache-2.0,
  about 27 MB unpacked (WASM Postgres, in process, no server, no network). It
  runs one connection and serialises queries, so it cannot show a race. It is
  right for "does every query, constraint and migration work" and wrong for
  "does the lock hold". It goes in `devDependencies` only; production never
  loads it. `npm run check` runs the store suites twice, JSON and PGlite, and
  stays offline. S1 confirms that its Postgres major is 17 and that every
  feature we use (generated columns, partial unique indexes, advisory locks,
  triggers) behaves as on the server; anything that does not runs only in the
  Postgres 17 suite.
- **Concurrency suites on Postgres 17.** A separate `npm run check:pg`, given
  `TEST_DATABASE_URL`, creates a throwaway database per run and runs §2's
  tests with real parallel connections. It runs on the local
  `postgresql@17` on this Mac and on Florentine's Linux VM; S3 adds it to the
  production workflow before cut-over. Not part of the offline `check`.
- **Migrations:** plain numbered SQL files (`services/api/migrations/0001_init.sql`,
  …) and a runner of about 50 lines in `store/pg/migrate.ts`: one transaction
  per file, a `schema_migrations(version, sha256, applied_at)` row each, and a
  refusal when an applied file's hash changed. No library: the schema is
  small, the files are reviewable as SQL, and a migration tool would be one
  more dependency on the money path for features we do not use (down
  migrations; we roll forward). The load-time JS migrations in `initStore`
  (`db.ts:215-221`) are run once by the importer and are not repeated on
  Postgres.

## 5. Outbox and the append-only rows

**Outbox.** `outbox(id, kind, payload jsonb, created_at, attempts,
next_attempt_at, delivered_at, last_error)`. A state change and its
notification are written in one transaction, so a crash cannot keep one and
lose the other. A worker in the API process claims due rows with
`FOR UPDATE SKIP LOCKED`, delivers, and marks them. Kinds in #166:

- checkout-service hints (`checkout-webhook.ts:49-52`). Today their retries
  are in memory and "a restart drops pending ones" (`checkout-webhook.ts:20-22`);
  the outbox keeps them. The `webhook-id` stays the outbox row id, so the
  receiver's dedupe is unchanged.
- the payment-request PAID hooks (`routes/payment-requests.ts:550-557`).

Outbound partner and chain calls (Monerium redeem, venue swaps, refunds) are
not moved to an outbox worker in #166. Their intents are already written and
committed before the call (`orchestrator.ts:529-548`), which is the property
an outbox gives; moving the calls themselves to a worker changes the
request flow and is a separate decision.

**Audit is append-only in the database.** The application role gets
`INSERT, SELECT` on `audit` and nothing else, and a trigger refuses `UPDATE`
and `DELETE` for every role (the trigger also covers an owner connection).

**The ledger is not append-only today, and #166 does not make it so.** Rows
are updated by the statement writer (amount, direction, date and facts:
`bookkeeping/statement.ts:586-599`), by revaluation (asset and value:
`wallet-sync/revalue.ts:85-107`), by rule runs and by people categorising
(`routes/business/bookkeeping.ts:159`, `:218`, `:240`). Turning those into
correction rows changes the books and the DATEV export, and is bookkeeping
work, not storage. What #166 enforces in the database:

- No `DELETE` on `ledger`, `organisations`, `accounts`, `invoices`,
  `documents`, `transfers`, `audit`: not granted, and a trigger refuses it.
  This is the store invariant ("nothing deletes", `store.ts:8-10`) held by
  the database.
- Every `UPDATE` of a ledger row first copies the old row into
  `ledger_history(entry_id, doc, changed_at)` by trigger, which the
  application role can only insert into through the trigger. The books can
  change; the change cannot be hidden.

The tables that do delete today keep doing so, through their store methods
only: quote and session pruning, Shopify delivery pruning,
`removeShopifyConnection`, `removeContact`, `removeImportedWallet`,
`removeAccountRule` (`store.ts:429-430`, `:735-739`, `:753`, `:896-900`,
`:1197-1202`, `:1290-1295`, `:1320-1325`).

## 6. Data migration and cut-over

**Importer** (`scripts/pg-import.ts`, S5):

- Reads `db.json` with `loadStoreReadOnly` (`db.ts:229-232`), runs the
  load-time migrations in memory, and writes every row in one transaction.
- Idempotent: `INSERT … ON CONFLICT (id) DO NOTHING`, then compares. A
  second run on the same file changes nothing and says so. A row present with
  a different `doc` stops the run.
- Before inserting, it reports what would break a constraint: duplicates for
  each unique key and orphans for each foreign key (§1.2). Those are findings,
  not repairs.
- **Verify both ways:** per table, the row count and a SHA-256 over the rows
  sorted by id, each in canonical JSON (sorted keys). The source side is the
  snapshot after the load-time migrations ran in memory (they fill missing
  fields and prune sessions, `db.ts:215-220`), not the raw file, so both
  sides hash the same data. Computed from that snapshot and from
  `SELECT doc` on Postgres; they must match. Then the export (below) is
  checksummed against the same migrated snapshot. The raw file's SHA-256 is
  recorded too, to name the input, not compared.
- Never prints a row. Output is table names, counts and hashes.

**Export** (`scripts/pg-export.ts`): `SELECT doc` per table into the
`Db` shape, so `db.json` can be rebuilt from Postgres. It is the rollback
path and the test of the importer. The `Db` shape has no place for
`outbox`, `ledger_history`, `cap_holds` or `pending_executions`; the export
refuses to run while any `outbox` row is undelivered unless told to write
them to a separate file (below), and writes `ledger_history` to its own
age-encrypted file next to the `db.json`.

**Cut-over** (the runbook is written in S7; the owner picks the time). The
API and the data move together, from the Akash lease to the Oracle host
(§7), testnet (zoldhq.com) first, then app.zoldhq.com:

1. On the Oracle host: the Postgres 17 suite (`check:pg`) passes against the
   target cluster, `npm run preflight` passes, and a restore drill (§7) has
   been done once.
2. Drain: no transfer, crypto send or safe op in a non-final state, and the
   #167 condition (no no-reference SEPA transfer waiting).
3. Stop writes: stop the API on the lease (it is the only writer).
4. Copy `db.json` off the lease with `scripts/backup-db.sh` (age-encrypted).
   Keep the lease and its volume, read-only, until step 8.
5. On the Oracle host: import, then verify (counts and hashes both ways). A
   mismatch stops the cut-over; start the lease again on JSON.
6. Start the API on the Oracle host with `STORE_BACKEND=postgres` and
   `DATABASE_URL`, wait for `/api/health`, then point the Cloudflare tunnel's
   hostname at the new `cloudflared` (DNS does not change; §18.1).
7. Smoke: sign in with the owner's passkey, read balances and the last
   transfers, list the audit. No money moves in the smoke.
8. Close the lease only after the owner says so.

**Rollback:** while nothing has been written on Postgres, point the tunnel
back at the lease and start it on its `db.json`. After Postgres has taken
writes:

1. Drain as in step 2 above, then **stop writes**: stop the API unit on the
   Oracle host (the outbox worker runs in it), set the application role
   `NOLOGIN`, and check `pg_stat_activity` shows no session of it. Only then
   export, so no payment or job commits after the snapshot.
2. **Outbox:** let the worker deliver every due row before the stop. Rows it
   cannot deliver (`attempts` exhausted) go to `outbox-pending.json`, are
   reported to the lead, and are delivered by hand; the JSON backend has no
   outbox, so after rollback the checkout hints fall back to today's
   in-memory retries.
3. **Ledger history:** exported to its own encrypted file. The JSON backend
   keeps no history, so ledger edits made after rollback are not recorded
   there, as today. The Postgres database itself is kept as it stood at the
   stop, application role `NOLOGIN`, until the owner deletes it, so nothing
   it recorded is lost.
4. `cap_holds` and `pending_executions` are dropped: holds expire anyway, and
   an approval in flight answers 410 and the user starts it again.
5. Export, verify the export against Postgres (counts and hashes), then start
   the lease on that `db.json` and point the tunnel back.

The encrypted `db.json` copies are kept until the owner deletes them.

**Backups:** §7.

## 7. Where it runs: the Oracle host

The API and Postgres run on the same host: the owner's Oracle Cloud (OCI)
ARM server (Ampere, aarch64). Postgres is self-hosted, not a managed service,
and listens on its unix socket only; no database port is open on the host or
in OCI. Everything moves off Akash, both deployments. The Akash lease is kept,
stopped and read-only, until the owner closes it (§6 step 8).

- **Region:** an EU region. Recommended: Frankfurt (`eu-frankfurt-1`). The
  owner confirms (§9).
- **Account type: Pay As You Go, not Always Free.** Oracle's Always Free
  page (<https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm>,
  read 2026-11-25) says "Idle Always Free compute instances may be reclaimed
  by Oracle", and counts an instance idle when, over 7 days, 95th-percentile
  CPU, network and (A1 shapes only) memory utilisation are all under 20%. A
  quiet API and Postgres on an A1 shape can meet that. Reclaimed, this host
  takes down the API, Postgres and both deployments at once. The page does
  not say whether a Pay As You Go account's instances are exempt; it does say
  an upgraded account is not charged for usage within the Always Free
  limits. So: the owner confirms the account type, an Always Free account is
  converted to Pay As You Go before S7, and S7 checks in the console that
  the instance carries no idle-reclamation notice. §7.1 covers the host
  being lost anyway.
- **Processing agreement:** Oracle's Data Processing Agreement for Oracle
  Cloud Services covers OCI. AGENTS.md needs one before user data lands, so
  the owner confirms that the account is covered (§9).
- **Postgres 17** from the PostgreSQL project's own packages (PGDG), which
  build for aarch64. A major upgrade is a planned task, not automatic; minor
  versions follow the distribution's security updates.
- **No network port.** `listen_addresses = ''`: Postgres listens on its unix
  socket only. `pg_hba.conf` allows `local` connections with
  `scram-sha-256`, and nothing else. `DATABASE_URL` is then
  `postgresql://<role>@/<db>?host=/var/run/postgresql`. No TLS is needed on
  a socket. The OCI security list opens no database port.
- **The code still takes only `DATABASE_URL`** (and `DATABASE_CA` when it is
  given). It fails closed: on a real-money chain a TCP host other than
  loopback is refused unless the URL asks for `sslmode=verify-full` and a CA
  is given. Moving the database to another host later is a config change, not
  a code change.
- **Two deployments, one host:** testnet and mainnet each get their own OS
  user, API process, database and roles. Neither role can connect to the
  other's database. Staging stays off the passkey domain, as today.
- **Roles:** per database, an owner role that runs the migrations (at
  deploy, before the API starts) and an application role the API runs as.
  The application role has no DDL and the grants in §5.
- **Disk encryption:** OCI encrypts boot and block volumes at rest by
  default, with Oracle-managed keys. A key of our own in OCI Vault is
  possible later; not needed for #166.
- **PITR: pgBackRest** (MIT, packaged by PGDG for aarch64) to OCI Object
  Storage through its S3-compatible API, off the host. Two repositories:
  `repo1` a bucket in the host's region, `repo2` a bucket in a second EU
  region (for example `eu-amsterdam-1`), so losing a region does not lose the
  backups. Continuous WAL archiving to both with `archive_timeout = 60s`, so
  at most about a minute of committed writes is lost with the host; a weekly
  full and daily differential backup, 14 days of retention. The repository is
  encrypted by pgBackRest (`aes-256-cbc`) under a key that is not on the
  host's disk in plaintext beside the backups, so a copy of the bucket alone
  opens nothing. The owner keeps that passphrase outside OCI; without it no
  restore is possible, on this host or a new one. pgBackRest over WAL-G: it encrypts the repository, has a
  `verify` command, and is in the same package repository as Postgres.
- **Restore drill:** before the cut-over, then monthly, **onto a new OCI
  instance**, not the running host: follow the rebuild below up to the
  restore, restore to a time T, start Postgres, and compare per-table row
  counts and hashes (the importer's verify, §6) against an export taken at T.
  The drill restores from `repo1` and `repo2` in alternate months. It times
  the rebuild from "instance requested" to "verify passed", and the time is
  logged on the board with the result. A drill over the recovery-time target
  is a finding. The instance is deleted afterwards.
- **Off-box copy:** `scripts/backup-db.sh` gains a Postgres mode (`pg_dump`
  piped to `age`) for a copy outside OCI.
- **Running it:** systemd units for the API and `cloudflared`, restart on
  failure. Deploys keep today's pull model: the host polls the `production`
  branch, so nothing on GitHub holds a credential for it (§18.1). This
  replaces the Akash leg of the `production` workflow.
- **Toolchain:** Node 22.23.4 for linux-arm64. S7 checks that
  `npm ci --omit=dev` builds on aarch64 and that no dependency ships only an
  x64 binary.

### 7.1 Losing the host

API and database share the host, so a dead instance, a reclaimed one or a
lost boot volume is a full outage of both deployments. S7 writes this as a
section of the runbook and as a provisioning script, `scripts/oracle-host/`,
that the drill runs.

**Proposed target, for the owner to accept (§9):** service back within
**4 hours** of the decision to rebuild (RTO), losing at most the writes of
the last minute before the host died (RPO, `archive_timeout`). Testnet
follows mainnet, within a further 4 hours.

What must exist outside the host for this to work: the pgBackRest
repositories (both regions), the repository passphrase, an age-encrypted copy
of each deployment's environment file, and the Cloudflare tunnel, all held by
the owner; the code is on GitHub (`production`).

Rebuild:

1. Create an Ampere A1 instance from the same image in the same (or the
   second) EU region; attach a block volume for the Postgres data directory.
2. Run the provisioning script: OS users per deployment, PGDG Postgres 17
   and pgBackRest, `listen_addresses = ''`, `pg_hba.conf` local
   `scram-sha-256` only, Node 22.23.4 linux-arm64.
3. `pgbackrest restore` from `repo1` (or `repo2` if the region is gone), to
   the latest point or a chosen time. Start Postgres. The owner and
   application roles and their grants come back with the restore; the
   script checks that both exist and that the application role has only the
   §5 grants.
4. `pgbackrest check` on both repositories, so WAL archiving runs again from
   the new host before it takes a write.
5. Restore the environment files, then the systemd units for the API (per
   deployment) and `cloudflared`, and the deploy pull loop on `production`.
   `npm run preflight`.
6. Start `cloudflared` with the tunnel's credentials; the hostnames follow
   the tunnel, so DNS does not change.
7. Smoke as in §6 step 7. The old instance, if it comes back, stays stopped:
   two hosts must never write to the same repositories.

Transfers in flight when the host died are handled by the existing sweeps
after the restart: an intent without a known outcome goes to review (§2,
outbound intents). A write lost inside the RPO window is the case the
reconciler reports and does not repair.

The limit #166 names ("the API still sees the data in memory and holds the
database credentials") holds on the Oracle host too: Oracle, as the host,
can reach the disk and memory, under its processing agreement.

## 8. Slices

Each slice is one PR, mergeable on its own with main green. The JSON backend
stays the default until the cut-over.

| Slice | What | Owner needed |
|---|---|---|
| S0 | This note | approval |
| S1 | `pg` dependency, PGlite dev dependency, migration runner, `0001_init.sql` (§1), the Postgres backend behind the interface with the same method bodies, store suites run on JSON and PGlite. No caller switched | — |
| S2 | Async store API and the mechanical conversion (§3), on the JSON backend. `store.tx` replaces `batched`. Rows are clones. Caller check-then-writes in §2 moved into store methods first | — |
| S3 | Money-path transactions and locks on Postgres: `cap_holds`, recovery-start lock, `recordPaymentRequestPayment`, `settleInvoice`, the dedupe keys. `npm run check:pg` with every concurrency test in §2 | — |
| S4 | Outbox and its worker (checkout hints, PAID hooks); audit and no-delete triggers; `ledger_history`; the application role's grants | — |
| S5 | Importer, export, verify (§6), run against a copy of the testnet `db.json` on the local Postgres 17. Constraint findings reported to the lead | — |
| S6 | Docs: AGENTS.md (where the code lives, secrets and storage), `docs/running-locally.md` (local Postgres, `check:pg`), technical-architecture §18.1, `docs/roadmap.md`, `docs/status.md` | — |
| S7 | The Oracle host (§7): Postgres 17 and roles, pgBackRest to Object Storage in two regions, systemd units, the deploy pipeline in place of the Akash leg, the aarch64 toolchain check, the cut-over runbook, the host-loss runbook and provisioning script (§7.1), and the first restore drill onto a new instance, timed | region, DPA and Pay As You Go account confirmed; recovery-time target accepted; host access |
| S8 | Cut-over (§6): testnet, then app.zoldhq.com. `STORE_BACKEND=postgres` becomes the default; the JSON backend stays one release as the rollback path, then goes | the owner picks the time |

S2 is the largest (about 1,250 call sites and 2,000 in tests) and can be cut
by directory if one PR is too big to review. S7 can run alongside S2-S5.

## 9. Owner questions

1. **Hub database:** does `hub.db` (Agentic-payment-protocol, `packages/hosted`)
   stay a separate store, as #166 assumes? This note assumes yes.
2. **Region, DPA and account type:** is `eu-frankfurt-1` the region; is the
   OCI account one that Oracle's Data Processing Agreement covers; and is it
   Pay As You Go? If it is Always Free, convert it to Pay As You Go before S7
   starts (§7: an idle Always Free instance may be reclaimed). Which second
   EU region holds `repo2`?
3. **Recovery target:** accept or change the proposed 4 hours to restore
   service and one minute of lost writes after losing the host (§7.1).
4. **Cut-over:** the owner's call, once S7 is done (§6). Nothing to answer
   now.
