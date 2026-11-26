# Postgres store (design)

Board #166. Not yet approved by the owner. Code references were checked against
main 9f905eb (2026-11-25). Paths are under `services/api/src/` unless they
start with `scripts/`.

The store moves from `db.json` straight to Postgres, with no SQLite step.
The API and Postgres run together on one Oracle Cloud ARM host (Ampere,
aarch64), Postgres on its unix socket only with no database port open, and
everything moves off Akash (§7). This note does not reopen either choice.
The `@zold/accept` hosted hub's database (`hub.db` in
Agentic-payment-protocol) moves into the same Postgres server, in its own
`hub` database and roles (§7.2, slice S9).

**What this note decides:** one table per collection, typed key columns
generated from a JSONB document, uniqueness enforced by the database, an
async store with `store.tx`, a JSON backend and a Postgres backend behind one
interface until cut-over, PGlite for the offline suites and a real Postgres 17
for the concurrency tests, plain numbered SQL migrations, an outbox for
webhooks, a ledger whose rows cannot be deleted and whose every change is kept,
one API process per deployment, enforced at start, two Postgres clusters (one
per deployment) on unix sockets with peer authentication on the Oracle host,
pgBackRest PITR to OCI Object Storage in two regions plus daily dumps the host
cannot delete, a rebuild path for losing the host, the hub in its own
database on the same server, and nine slices. It assumes the owner provides
the OCI account (§7). **What it leaves to the owner:** the recovery-time
target, whether to lock the dump bucket's retention rule, and when to cut
over (§9).

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
  doc  json NOT NULL,
  -- typed key columns, each GENERATED ALWAYS AS (…) STORED from doc
  ...
);
```

The row shape in `store/types.ts` and `domain/types.ts` stays the source of
truth. `doc` holds the whole row as the JSON backend has it, as `json`,
not `jsonb`: `jsonb` reorders object keys, and callers compare rows with
`JSON.stringify` (`mergeStatementLines`, `bookkeeping/statement.ts:583`,
`:588`), so a row read back from `jsonb` would look changed. `json` keeps the
text as written; the `->`/`->>` operators work on it. Every column we
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

Two more columns on every row table: `seq bigint GENERATED ALWAYS AS
IDENTITY`, the row's position in the JSON array, so a method that returns
"the first match" reads `ORDER BY seq` and gets the row the JSON backend
would; and no generated timestamp column. A cast to `timestamptz` depends on
the session's time zone, so Postgres refuses it in a generated column; the
key columns hold the ISO text (`expires_at text`), and a query that compares
with `now()` casts in its `WHERE`.

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
| operator_credentials (new: the key of `operators[].credentials`, which stay in the operator's `doc`; written in the same transaction as every operator write) | credential_id (:870 checks this across all operators) | operator_id | operator_id → operators | — | update |
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
| cryptoDeposits (87) | (chain_id, lower(tx_hash), log_index) (:985-1009, §2) | user_id, holding, invoice_id, payment_request_id | user_id | — | update |
| cryptoSends (88) | — | user_id, state, account | user_id | — | update |
| audit (90) | — | user_id, at | — | operator notes | **append only** (:235-242) |
| recoveryRequests (92) | (user_id) WHERE mode='zoldenburg' AND status='GRACE_PERIOD' (§2) | user_id, status | user_id | access hash (credential) | update |
| safeOps (94) | — | org_id, state | org_id | — | update |
| cryptoDepositCursor (102) | chain_key (PK) | — | — | — | upsert |
| organisations (110) | payment-page handle, lower (:933), and across users through `payment_handles` (below) | — | — | GetMyInvoices key, Monerium API secret (sealed, :41, :45) | update; never deleted |
| members (111) | invite token hash (:1142); (org_id, user_id) WHERE status <> 'deactivated' (:1136-1141) | org_id, user_id | org_id, user_id | credential | update; never deleted |
| accounts (112) | lower(address) (:1167; the add scans for it today, §2) | org_id, backing_user_id (:185) | org_id, backing_user_id | IBAN | update; never deleted |
| importedWallets (113) | — | org_id | org_id | — | update; **deleted** (:1290) |
| contacts (114) | — | org_id | org_id | payee IBAN, address | update; **deleted** (:1197) |
| drafts (115) | — | org_id, state | org_id | — | update |
| invoices (116) | link token hash (:1258); (org_id, number) for issued invoices (§2, invoice numbers) | org_id, state | org_id | credential; payer data | update; never deleted (`DELETED` is a state, `routes/business/invoices.ts:154`) |
| chartAccounts (117) | (org_id, code) | org_id | org_id | — | update |
| accountRules (118) | — | org_id | org_id | — | update; **deleted** (:1320) |
| ledger (119) | (org_id, statement key) WHERE statement IS NOT NULL (`bookkeeping/statement.ts:559-572` matches by key) | org_id, lower(tx_hash) (`hashOnRecord` :135) | org_id | — | no delete; updated (§5) |

Rules for the table above:

- A unique index goes in only where the importer finds no duplicate in the
  live data. Where it finds one, the index is plain, the importer reports the
  rows, and the duplicate is a finding for the lead, not something the
  migration repairs. `0001_init.sql` (S1) has the unique keys today's store
  methods already rely on (credential ids, token hashes, slugs, codes,
  handles, `shop`, the dedupe ids, the crypto-deposit key, one live receipt
  share, one live membership, `(org_id, code)` on the chart, the statement
  key); S5's report is read before 0001 is first applied to a deployment.
  The keys today's code does not enforce come with the slice whose §2 row
  adds them, as plain indexes until then: `transfers.quote_id` and one
  `GRACE_PERIOD` recovery per user (S3), `lower(address)` on accounts (S3;
  `accountsAtAddress` reports two accounts at one address as unbookable
  today, `bookkeeping/money-in.ts:42`), and `(org_id, number)` on invoices
  (S2).
- Foreign keys are `ON DELETE RESTRICT`. The same rule: added only where the
  importer finds no orphan, so none is in 0001; they come with S5.
- **The `table` in a sealed field's AAD stays the collection name**
  (`shopifyConnections`, not `shopify_connections`), and `rowId` stays the
  row's `id`. Changing either makes every sealed value unopenable. The SQL
  table names are snake_case; `stored-secrets.ts` does not change.
- Field encryption stays exactly as it is. Disk encryption comes from OCI
  (§7). No new field is encrypted in #166.
- Ids keep their current text values (`org_…`, `acc_…`, uuids). No serials.

New tables: `schema_migrations`, `outbox` (§5), `ledger_history` (§5),
`cap_holds` (§2), `pending_executions` (§2), and
`payment_handles(handle_lc text PRIMARY KEY, owner_kind text, owner_id text)`. `0001_init.sql` creates
`payment_handles`, the migration runner `schema_migrations`; the other four
come with the slice that writes them (S3, S4).
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
write that depends on it. Many handlers are safe today only because they are
synchronous from check to write (drafts edit and cancel, last-owner, invoice
numbering, pay-to submit, Shopify cancel); S2 makes their reads awaited, so
each such window opens unless the check moves into the write.

**One API process per deployment** is a hard invariant, enforced at start:
the Postgres backend takes `pg_try_advisory_lock(hashtext('api:'||<deployment>))`
on a dedicated connection before it serves anything, and the process refuses
to start if the lock is held. The lock lives as long as that connection, so
a crashed process releases it. So does a database restart or a dropped
connection while the process lives on, and the pool would reconnect without
it; so the process watches that connection (its `error` and `end` events
and a `SELECT 1` every 5 s) and on losing it **exits non-zero at once**,
before another request or sweep tick runs. systemd starts it again, and the
new process takes the lock or refuses to start. Tests: two processes on one
database, the second exits before it listens; `pg_terminate_backend` on the
lock's connection, the API exits. These in-memory guards on money and identity
paths rely on it, and stay in memory in #166:

- `executing` / `compensating` (`orchestrator.ts:556`, `:561`), which the
  stranded sweep's `busy()` (`:869`) reads; `refreshPayoutLocks` (`:1288`)
  and `sweepAnchorPayouts` (`:913`);
- the deposit conversion guards `pendingDepositConversions` and
  `convertingDeposits` (`routes/crypto-deposits.ts:56`, `:70`, checked at
  `:200`);
- Turnkey `signing` / `finishing` (`recovery/turnkey-recovery.ts:90`, `:96`)
  and `harnessPending` (`:55`); Candide `passkeySubmits`
  (`routes/recovery-candide.ts`);
- `submitting` (`routes/business/org-safe-deployment.ts:145`), `issuing`
  (`bookkeeping/issue.ts:94`), `invoiceLocks`
  (`routes/business/invoice-pay-link.ts:80`), `pendingLinks`
  (`merchant-links.ts:95`), Shopify `opening` / `resolving`
  (`routes/shopify.ts:120`, `:259`);
- the Monerium refresh single-flight `refreshing`
  (`adapters/monerium-connection.ts:232`), `recording`
  (`adapters/monerium-sandbox.ts`), the WebAuthn challenge map
  (`webauthn.ts:157`), and the pending maps of `http/pending.ts` that stay in
  memory (below).

Moving any of them to a lease column (`UPDATE … SET lease_until=… WHERE
lease_until IS NULL OR lease_until < now() RETURNING`) is the work a second
process would need first; it is not in #166. The restore drill and a
returning old host must not start an API for a deployment for the same
reason (§7, §7.1). 
**Sweeps are single-flight.** The sweeps in `server.ts:334-396` are bare
`setInterval`s, and a tick can outlast its interval today: the Zoldenburg
sweep runs every 60 s (`config/security.ts:51`) and waits up to 90 s for a
receipt (`recovery/zoldenburg-guardian.ts:260`). Every tick runs inside
`pg_try_advisory_lock(hashtext('job:'||<deployment>||':'||<job>))` and
returns at once if the lock is held; the JSON backend uses an in-memory flag
per job. Only the verifier sweep has one today (`sweeping`,
`recovery/recovered-passkey.ts:125`). Test: a tick held open past its
interval; the next tick does nothing.

Five rules cover most of it:

1. **Every store write method is one transaction that locks its row.** It
   runs `SELECT doc … FOR UPDATE`, applies the method's existing body, and
   writes. So everything that is checked inside one method today
   (`claimAuthorization`, `claimCryptoSend`, `claimSafeOpRelay`,
   `addSafeOpSignature`, `finishSafeOp`, `endPendingSafeOp`,
   `claimDraftExecution`, `consumeQuote`, `updateTransfer`'s final-state
   guard, `resolveTransferReview`, `setOrgSafePlan`) stays correct without
   being rewritten.
2. **Arrays and sub-objects change inside the store method, on the locked
   row, never as a whole value the caller built.** A patch like
   `{ txs }` or `{ sepa: { ...t.sepa, state } }` was computed from a row read
   before an await; locking the row then writes a stale array, and an
   executor's intent step and a compensator's or poller's write can erase
   each other. The orchestrator does exactly this today: `txs.push` then
   `updateTransfer(id, { txs })` (`orchestrator.ts:530-533`, `:543-546`,
   `:1351-1355`), and `adapters/monerium-sandbox.ts:709`, `:711` write
   `sepa: { ...t.sepa, state }`. An intent that vanishes lets the next sweep
   refund a transfer whose funds left. So: `appendTransferStep(id, step)` and
   `patchTransferSub(id, key, fn)` for transfers, `patchUserSub(id, key, fn)`
   for `passkeySafe` / `monerium`, `patchOrgSub(id, key, fn)` for
   `invoicing` / `integrations`, `appendDraftActivity(id, entry)`,
   `recordPaymentRequestPayment` and `settleInvoice` (table below). `fn`
   receives the locked current value and returns the new one, in JavaScript
   on the locked row (a `jsonb_set` would reorder the keys, §1.1). S2 adds a grep gate to
   `scripts/check.ts` that refuses, outside `store.ts` and `store/`, a patch
   built from these spreads and pushes: `...user.passkeySafe` (9 today),
   `...user.monerium` (4), `...t.sepa`, `...ctx.org.invoicing` (1),
   `...ctx.org.integrations` (1), `...draft.activity` (4),
   `transfer.txs.push` / `txs.push` followed by an `updateTransfer`, writes of
   `r.payments` and `invoice.settlements`. Test (S3, Postgres 17): an
   executor append and a compensator append on one transfer in parallel;
   both steps survive, in commit order.
3. **Every state write names the states it may leave.** The store method
   takes the allowed from-states and runs `UPDATE … WHERE id=$1 AND state =
   ANY($from) RETURNING doc`; no row back means the state moved, and the
   caller refuses (409) instead of writing. This is a conditional write, not
   a check in the caller.
4. **A rule over other rows locks a parent row or is a unique index.** Row
   locks cannot see write skew (last owner, four eyes, invoice numbers), so
   those take the organisation row `FOR UPDATE` or rely on `UNIQUE`.
5. **A partner or chain call between a check and a write claims a reserve
   status first.** The claim is a conditional write (rule 3) to a status
   such as `EXECUTING` or `FINALIZING`, committed before the call; the call's
   outcome moves it on; the sweep reconciles a reserve older than its
   timeout from the chain, as `RELAYING` does below. A second caller finds
   the reserve and refuses.

Anything else that checks in the caller and writes later is a race unless
one of these covers it.

Isolation is `READ COMMITTED` with explicit `FOR UPDATE`. `SERIALIZABLE`
would also be correct, but its retries would reach code that calls partners
between reads, and we would rather refuse than retry a money path.

The table below is built in S3 (money paths on Postgres, `check:pg`).

| Path | Today's guard (evidence) | On Postgres | Concurrency test (Postgres 17) |
|---|---|---|---|
| Quote → transfer | `holdDailyCap` takes an in-memory hold with no yield between count and record (`transfers/build.ts:157-168`, `store.ts:470-481`); `consumeQuote` (`build.ts:169`, `store.ts:441-448`); `addTransferUnderHold` (`build.ts:370`) | Hold: `store.tx` takes `pg_advisory_xact_lock(hashtext('cap:'||capKey))`, recomputes `used` from the database inside the lock, counting only `cap_holds` rows with `expires_at > now()` (an expired hold is ignored by the sum, then pruned), and inserts a `cap_holds` row with an expiry. Consume: one conditional `UPDATE quotes … WHERE status='OPEN' AND expires_at > now()`; today `consumeQuote` checks the status only (`store.ts:441-447`). The expiry write (`routes/transfers.ts:115`, unconditional today) becomes `UPDATE quotes SET status='EXPIRED' WHERE id=$1 AND status='OPEN'`, so it cannot overwrite a consumed quote. The transfer insert and the hold delete are one transaction, and `UNIQUE(transfers.quote_id)` refuses a second transfer for a quote whatever the code does | 20 parallel `POST /transfers` on one quote: one 201, the rest 409. 2 parallel transfers each at the full cap: one passes. A quote past `expires_at` but still `OPEN`: consume refused. An expired hold leaves the cap free |
| Authorise and submit a transfer | `claimAuthorization` after the `CREATED` check (`routes/transfers.ts:444`, `store.ts:513-521`) | Rule 1. The caller's earlier `CREATED` check is advisory only | 10 parallel `/authorize` with one signature: exactly one reaches the orchestrator |
| Transfer state machine | `updateTransfer` refuses to leave REFUNDED/PAID/MANUAL_REVIEW (`store.ts:525-540`) | Rule 1 (the guard runs on the locked row). State-change listeners (`:80-89`) move to the outbox, written in the same transaction (§5) | A late `PAID` racing a sweep `REFUNDED`: the final state is the first one committed; the other write keeps its other fields |
| Outbound intents | Intent written and fsynced before the call; a failed write exits, so "no intent on disk means the call never went out" (`orchestrator.ts:529-533`, `:848-851`) | The intent write is awaited and committed before the call. A failed commit throws, so the call is not made. A commit whose outcome is unknown (connection lost during `COMMIT`) is treated as written: the sweep reads the intent and the transfer goes to review, the safe direction. No exit needed | Kill the connection during the intent commit: no partner call; on restart the transfer is either untouched or in review |
| Crypto send | `holdDailyCap` (`routes/crypto-sends.ts:262`), `addCryptoSendUnderHold` (:356, :437), `claimCryptoSend` (:619, `store.ts:964-972`) | As quote → transfer for the hold; rule 1 for the claim | Parallel submits of one send: one `SENT`/`SUBMITTED`. Parallel sends at the cap from one org Safe: one passes (cap key `orgSafeCapKey`, `wallet/org-debit.ts:174`) |
| Org Safe op queue | `addSafeOpSignature` (`routes/business/safe-ops.ts:180`), `claimSafeOpRelay` / `finishSafeOp` (`wallet/org-safe-queue.ts:174-196`) | Rule 1 on the op row | Two owners sign at once: both signatures land. One owner twice: one lands. Two relays: one claims |
| Draft payments | `claimDraftExecution` with `expectedUpdatedAt` (`routes/business/drafts.ts:408`, `:704`) | Rule 1 | Two parallel executes of one reviewed draft: one claims |
| Managed recovery start | Check open requests, maybe cancel the idle one, then add (`routes/recovery-zoldenburg.ts:629-674`); `relaying` is an in-memory set (`:322`) | `store.tx` locks the user row (`SELECT … FROM users WHERE id=$1 FOR UPDATE`) for the whole check-cancel-add. The partial unique index on one `GRACE_PERIOD` request per user backs it. `relaying` becomes a `RELAYING` status in the row, written before the chain call, with the status it came from and the time. Cancel and expiry wait while it is set, as they wait on the set today. The start gate filters open requests by status and expiry before it looks for a relay (`:629-633`, then `relaying.has` at `:644`), so `RELAYING` joins `OPEN` and is exempt from the expiry filter, as `GRACE_PERIOD` is: a request whose relay is in flight past its `expiresAt` still blocks a new start. A restart can leave it set, so the sweep (`:327-342`) reconciles: a `RELAYING` row older than the relay timeout is synced from the chain (`syncZoldenburgFromChain`); a relayed signature or finalisation moves it to the status the chain shows, and nothing on chain moves it back to the status it came from, so the next sweep or admin action relays again. It never stays `RELAYING` across a sweep that has passed the timeout | Parallel starts for one account at `MAX_OPEN_REQUESTS`: never more than the limit; two finalisers: one relays. A `RELAYING` request past its `expiresAt`: a new start answers 409. Stop the process after `RELAYING` is written: with the relay on chain the row reaches its grace period; without, it is back in its old status and relays once |
| Payment request paid | `record()` reads the row, `applyPayment` merges in place, then writes (`routes/payment-requests.ts:559-575`; in-place merge `payment-requests.ts:551`) | One store method, `recordPaymentRequestPayment(id, payment)`, runs `applyPayment` on the locked row. The "became PAID" hook is an outbox row in the same transaction | A Monerium order and our own transfer for one payment, recorded in parallel: one payment row, merged; the PAID hook fires once |
| Invoice paid | Read the invoice, check its settlement ref, write (`routes/payment-requests.ts:656-663`, `adapters/crypto-deposits.ts:627-632`, `routes/business/state.ts:97-144`) | One store method, `settleInvoice(id, settlement)`, checks the ref on the locked row | The poller and a webhook settle one order in parallel: one settlement |
| Ledger | `batched` blocks in `wallet-sync/sync.ts:300`, `wallet-sync/revalue.ts:82`, `bookkeeping/writer.ts:260`, `routes/orgs.ts:1147`; rule runs compute replacements from rows read earlier, then replace them (`routes/business/bookkeeping.ts:152-162`) | `store.tx` holding `pg_advisory_xact_lock(hashtext('ledger:'||org_id))`, taken by every ledger write: statement writer, sync, revalue, rule run, categorise. A write reads the rows it changes inside that lock, never before it: the rule run becomes one store method, `applyAccountRules(orgId)`, that reads rules and rows, runs `applyRules` and writes, all under the lock. `replaceLedgerEntries` also refuses a row whose stored `updatedAt` is not the one the caller read, so a replacement computed from a stale row fails instead of overwriting. The statement writer's add path is backed by `UNIQUE(org_id, statement key)`, so two sweeps cannot add a line twice | Two statement sweeps in parallel: same lines as one sweep. Revalue racing a categorise: both changes kept, in history. A rule run racing a revalue and a hand categorisation: the revalued value and the hand category both survive |
| Monerium order dedupe | `isOrderProcessed`, then an in-memory `recording` claim, then awaits, then `markOrderProcessed` (`adapters/monerium-sandbox.ts:466-527`) | The claim is `INSERT INTO processed_monerium_orders … ON CONFLICT DO NOTHING` as the last step of the recording transaction, with `recordMoneriumIssue` in the same transaction. `recording` stays for the in-flight window (one process); a second instance would get the duplicate refused by the key | Poller and two webhook deliveries for one order in parallel: one `recorded`, one issue record, one statement line |
| Monerium webhook dedupe | `isWebhookProcessed`, handle, `markWebhookProcessed` (`routes/monerium-webhook.ts:51-63`); today an array scan | `webhook_id` primary key; the mark is `ON CONFLICT DO NOTHING`. Handling twice is already safe because the order dedupe above holds | Two deliveries of one id in parallel: one is recorded and answered 2xx. The other answers 2xx `duplicate` if it arrives after, or 503 `retry` if it arrives while the first is recording (`mirrorOrder` returns `unavailable`, `adapters/monerium-sandbox.ts:490-502`, and the route answers 503, `routes/monerium-webhook.ts:55-64`); its retry then answers 2xx `duplicate`. One issue record either way |
| Shopify delivery dedupe | `shopifyDelivery`, record, mark on finish (`routes/shopify.ts:668-678`) | `INSERT … ON CONFLICT (id) DO NOTHING RETURNING`; a conflict reads the row and checks its shop. Order create is backed by `UNIQUE(kind, shop, external_id)` on payment requests | One delivery id twice in parallel: one request created. Same order id from two shops: two requests |
| Crypto deposits | Idempotent on (txHash, logIndex) (`store.ts:985-1009`) | `UNIQUE(chain_id, lower(tx_hash), log_index)`, `ON CONFLICT DO NOTHING` then read. The scanner covers one chain per deployment (`CHAIN_ID`, `adapters/crypto-deposits.ts:34`), but each deposit records its `chainId` (`store/types.ts:540`) and the cursor is per chain, so the key carries it: a second chain cannot collide with the first | Two overlapping scans of one window: one row |
| Passkey sign count | `recordPasskeyUse` only while the credential is still the account's (`store.ts:202-206`), 11 callers (`http/passkey-assertion.ts:44`, `routes/auth.ts:122`, …). The counter check (`webauthn.ts:323`) compares against the count the caller read before its await, and the method writes whatever came back | Rule 1 on the user row, and the compare moves into the method: the write happens only if `stored = 0 AND new = 0` or `new > stored` on the locked row; otherwise the method returns false and the caller answers 401, as for a replaced credential (S3) | A recovery replacing the passkey while an assertion records its count: the count is refused, the new passkey stays. Two assertions with counts 5 and 6 recorded in the order 6, 5: the stored count is 6 and the second is refused |
| Sessions | `findSessionByTokenHash`, `touchSession` (`store.ts:819-841`); login mints its session synchronously after `recordPasskeyUse` so that a recovery landing later revokes it too (`routes/auth.ts:440-448`); recovery revokes the others (`recovery/recovered-passkey.ts:155`, `revokeOtherSessions` `http/sessions.ts:32-36`) | On an async store the credential check and the session insert are separate awaits, and a recovery can swap the passkey and revoke between them, leaving the old device a 24 h bearer. So `users.session_epoch` (an integer in `doc`, generated column): every passkey replace or recovery bumps it in the same transaction as the swap and the revoke, and moves the one session the method keeps (`revokeOtherSessions(userId, keepId)`, e.g. the session that approved a passkey replacement, `routes/auth.ts:249-259`) to the new epoch, so that session stays signed in; `addSession` copies the epoch it read with the credential check and inserts only `WHERE` the user's epoch still equals it; `requireSession` (`http/sessions.ts:44-61`) refuses a session whose epoch is below the user's. The touch is a conditional `UPDATE … WHERE last_used_at < now() - 60s`. Pruning is a periodic `DELETE`, not part of `addSession` (S4) | Login paused after its credential check while a recovery swaps the passkey: the login gets 401, or its session is refused on first use; never a live session on the old passkey. A passkey replacement approved from a session: that session still works, every other one is refused |
| Imported-wallet proof | `batched` re-reads before writing (`routes/orgs.ts:1244-1294`) | `store.tx` with the wallet row locked | Two proofs at once: one wins, the other 409 |


The paths below are not covered by rule 1 alone. "Today" says whether the
window is open now (an await between check and write) or opens with S2 (the
handler is synchronous from check to write today). The slice is where the
store-level rule and its test land; every test runs on JSON in `check` and
in parallel on Postgres 17 in `check:pg`.

| Path | Today | Store-level rule | Test | Slice |
|---|---|---|---|---|
| Draft edit, cancel, `reconcileDrift` vs `EXECUTING` | Edit and cancel check the state on the row they read and write it (`routes/business/drafts.ts:179`→`:200`, `:339`→`:347`/`:351`), synchronous today. `reconcileDrift` (`business/state.ts:153`→`:156`) trusts the draft passed in; `drafts.ts:403`, `:590` re-read after awaits, `:239`, `:300`, `:491` pass the row first read | Rule 3: `updateDraft(id, patch, { from })` with `WHERE state = ANY($from)`; edit and cancel from the editable states only, `reconcileDrift` from the states it reconciles; never from `EXECUTING`. Activity via `appendDraftActivity` (rule 2) | An edit and a cancel each racing `claimDraftExecution`: either the claim wins and the edit/cancel answers 409, or the edit wins and the claim's `expectedUpdatedAt` refuses; the draft never leaves `EXECUTING` by an edit | S2 |
| Crypto send `FAILED` | The `FAILED` writes after the screening await (`routes/crypto-sends.ts:572`, `:585`, `:612`) run before `claimCryptoSend` (`:619`) with no state check; `updateCryptoSend` has no guard (`store.ts:973-979`). Open today: a second submit can have claimed it meanwhile | Rule 3: `FAILED` only from the pre-submit states, never over `SUBMITTED` or `SENT`; a refused write leaves the row and the cap hold alone | A screening failure written while a parallel submit has claimed the send: the send stays `SUBMITTED`, the cap still counts it, the draft cannot re-run | S2 |
| Invoice `/pay` twice | `assertPayable(syncInvoicePayment(invoice))` then the draft insert (`routes/business/invoices.ts:178`→`:257`→`:268`), synchronous today | One store method, `startInvoicePayment(invoiceId, draft)`: conditional `SUBMITTED`→`PAYING` and the draft insert in one transaction | Two parallel `/pay` on one invoice: one draft, one 409 | S2 |
| Supplier pay-to submit | State check then `payTo` write (`routes/business/invoice-links.ts:179`→`:212`/`:254`), synchronous after the `load` await at `:177` | Rule 3: `WHERE state='LINK_CREATED'` on the write | Two submits with different `payTo`: the first stands, the second answers 409 | S2 |
| Payment-request expiry sweep | Filters `OPEN` once (`routes/payment-requests.ts:743`), awaits `hook(r)` (`:768`) inside the loop, writes `EXPIRED` without re-checking (`:746`). Open today | Rule 3: `EXPIRED` only `WHERE state='OPEN'` | A payment recorded while the sweep is mid-loop: the request stays `PAID` | S2 |
| Shopify cancel | `payments.length === 0` on the row read, then cancel (`routes/shopify.ts:685`→`:686`), synchronous today | One store method: cancel `WHERE state='OPEN' AND expires_at > now() AND json_array_length(doc->'payments') = 0` on the locked row, the same test as `effectiveState(existing) === 'OPEN'` (`payment-requests.ts:573-576`) today, so a request already past its expiry stays expired | A payment recorded in parallel with a Shopify cancel: one of them; never a cancelled request with a payment. A cancel for a request past `expiresAt`: it stays `EXPIRED` | S2 |
| One deposit matched twice | A deposit is attributed to a request (`attributeDepositToRequest`, `payment-requests.ts:593`→`:620`) or linked to an invoice (`routes/crypto-deposits.ts:141`→`:175`), synchronous today | The deposit row gets a `settledTo` field (generated column `settled_to`), set by the one store method that records the deposit's money on a target (a request payment or an invoice settlement) `WHERE settled_to IS NULL`, in the same transaction as that payment or settlement; no row back means the money is already recorded elsewhere, and the caller refuses. The invoice link itself (`invoiceId`) stays changeable, or droppable, until then, as today (`routes/crypto-deposits.ts:137-150` refuses a move only once a settlement carries `deposit:<id>`); the move is refused `WHERE settled_to IS NOT NULL` | One deposit attributed by the scanner and settled on an invoice in parallel: one target. An unsettled link moved to another invoice: allowed |
| Deposit conversion and partials | Guarded by deleting the pending entry and `convertingDeposits` (`routes/crypto-deposits.ts:288`, `:295`), both in memory, before the submit (`:299`→`:358`); `settleConvertedDeposit` reads `deposit.partials` after awaits (`adapters/crypto-deposits.ts:414-480`) | Rule 5: a `CONVERTING` reserve on the deposit row before the submit; partials appended with rule 2 | Two conversions of one deposit: one submits. Two partials settling in parallel: both kept | S3 |
| Last owner | Count of owners then the role change or deactivation (`routes/orgs.ts:606`→`:616`), synchronous today | Rule 4: the method locks the `organisations` row, counts active owners inside the lock, then writes | Two owners each demoting the other in parallel: one succeeds, one answers 409; one owner remains | S2 |
| Four eyes | `canReviewDraft` compares reviewer and drafter (`routes/business/drafts.ts:282-309`), synchronous today | The review write is conditional on the draft's `updated_at` and drafter read with the check (`WHERE doc->>'updatedAt' = $read AND doc->>'createdByMemberId' = $drafterMember`, and the review state from rule 3), so an edit that makes the reviewer the drafter lands first or refuses the review | A line edit by the reviewer racing their own approval: the approval is refused | S2 |
| Invoice numbers | `nextNumberOf(ctx.org, issueDate)` (`routes/business/issue-outgoing.ts:115`), then `addInvoice` (`:192`), the series bump (`:213-216`) and `updateInvoice` (`:237`), synchronous today | Rule 4: the series is on the organisation row (`invoicing.numberSeries`), so one store method locks that row `FOR UPDATE`, picks the number, inserts the invoice and bumps the series (rule 2) in one transaction; `UNIQUE(org_id, number)` on issued invoices (§1.2) refuses a duplicate whatever the code does, including a number typed by hand. A unique number per invoice is what §14 UStG requires | Two automatic issues in parallel: two different, consecutive numbers. A typed number racing an automatic one that picks it: one 409 | S2 |
| Candide recovery | Execute after an admin reject re-checks nothing after its awaits (`routes/recovery-candide.ts:935`/`:947`→`:960`→`:972`→`:1006`, `GRACE_PERIOD` written unconditionally); finalize (`:295`→`:316`→`:350`/`:352`) likewise. Open today. The passkey step is guarded on current main by an in-memory `passkeySubmits` set around the guardian await and a re-read of the status after it (`passkeySubmits`, `recovery-candide.ts`, #227) | Rule 5: `EXECUTING` and `FINALIZING` reserves, each claimed with rule 3 from the status it requires before the chain call; a reject is a rule-3 write that refuses on a reserve. The passkey step keeps `passkeySubmits` (one process), held until its `OTP_PENDING` write has committed, not only around the guardian call: today it is cleared as the guardian answers, which is safe only while the re-read and write that follow are synchronous. That write becomes rule 3 `WHERE status='PASSKEY_PENDING'`. So a second submit is refused (409) from the guardian request until the commit, and never sends a second guardian request | Admin reject racing execute: either the reject wins and nothing goes on chain, or execute holds the reserve and the reject answers 409. A second passkey submit arriving after the guardian answered but before the write committed: 409, one guardian request | S4 |
| Turnkey recovery | Re-checks at `recovery/turnkey-recovery.ts:185`, then `GRACE_PERIOD` unconditional at `:207` after awaits (`:187`, `:188`, `:196`); `signing` stops a second call in one process only | Rule 5: a `SIGNING` reserve claimed from the required status before the first await | Two starts in parallel: one signs | S4 |
| Zoldenburg finalize | The finalize route (`routes/recovery-zoldenburg.ts:805`), the admin route (`:1116`) and the sweep each reach `finalizeZoldenburgRecovery` (`:290`→`:299`/`:307`) and `bindAndFinish` (`:273-284`) without `relaying`. Open today: a second bind sets the registration `signCount` again (`recovery/recovered-passkey.ts:142`) and revokes sessions again (`:155`), logging out the recovered device | Rule 5: a `FINALIZING` reserve from `GRACE_PERIOD`, reconciled by the sweep from the Safe's owners as `RELAYING` is; the bind runs only for the caller that claimed it | Two finalisers in parallel: one bind; the recovered device's session survives | S4 |
| Monerium refresh | Single-flight per user in memory (`adapters/monerium-connection.ts:232`, `:245-249`) and a compare on `refreshTokenEnc` after the await (`:271-274`) on the live row | The compare moves into `storeMoneriumTokens(userId, expectedRefreshEnc, next)`: `WHERE doc->'monerium'->>'refreshTokenEnc' = $expected` on the locked row; no row means the connection changed and the new tokens are not written. Replacing API keys already compares the keys (`routes/business/org-monerium.ts:234`) and moves into its method the same way | Two refreshes with one token in parallel (single-flight bypassed): one stores, the other refuses; the stored refresh token is the newest | S4 |
| Ceremony challenges | Login challenges are single-use and consumed on read (`webauthn.ts:157`, `consumeChallenge` `:205-210`). `verifyAssertionForChallenge` (9 callers) only compares; single use rests on each flow consuming its pending entry or claim | They stay in memory under the one-process invariant: a restart drops them and the user repeats the ceremony. For a money action the single-use point is the claim in the same transaction (`claimAuthorization`, `claimCryptoSend`, `pending_executions` deleted with the claim), so a replayed assertion finds nothing to claim. S4 lists each of the 9 callers with its single-use point; one without becomes `DELETE … RETURNING` on its pending row | Each caller: one assertion presented twice; the second is refused | S4 |
| One Safe, two accounts | `accounts` has no unique address; importer and add scan with `toLowerCase()` (`routes/safe-import.ts:271-276`, `routes/orgs.ts:792-804`, `store.ts:1167-1170`) | `UNIQUE(lower(address))` on accounts where the importer finds no duplicate (§1.2); the add is `INSERT … ON CONFLICT DO NOTHING RETURNING`, and no row back answers 409 | Two imports of one Safe in parallel: one account | S3 |

**Approvals waiting for a passkey move to the database.** Preparing a
transfer's or a crypto send's UserOperation and approving it are separate
requests; today the prepared operation waits in `pendingTransferExecutions`
and `pendingCryptoSends` (`http/pending.ts:56`, `:71`), so a restart, or a
second process, answers the approval 410 (`routes/crypto-sends.ts:531-534`).
S3 moves both to `pending_executions(kind, id, user_id, expires_at, doc)`:
the plan, the unsigned UserOperation, its challenge and the batch recipient,
none of them a secret. A UserOperation is mostly `bigint`s, which JSON cannot
hold, so `doc` stores it through `encodeUserOperation` /
`decodeUserOperation` (`domain/safe-op-queue.ts:109-120`), as the Safe op
queue does, and a round-trip test compares the decoded operation and its hash
with the original. The approval reads it on the locked transfer or send
row, deletes it in the same transaction as the claim, and expired rows are
pruned. The other pending maps in `http/pending.ts` (Safe deployments,
Monerium link signatures) stay in memory: a restart asks the user to repeat a
setup step and moves no money. The checkout-webhook retry timers stay until
S4 replaces them. `capHolds` (`store.ts:72`) and `relaying` move to the
database as above; the other in-memory guards stay, under the one-process
invariant above.

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
  Copies make the other case visible too: a caller that builds an array or
  sub-object from a row it read earlier and writes it back whole. §2 rule 2
  moves those into the store method, and its grep gate keeps them there.
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
callback awaits does not resolve until the transaction has ended, and then
returns its committed state, never a half-made one; and a write outside a
transaction is on disk when it resolves.

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
- **Offline suites on PGlite.** `@electric-sql/pglite` 0.4.6, Apache-2.0,
  25.6 MB unpacked (WASM Postgres, in process, no server, no network). It
  is pinned to the 0.4 line because that is the last one on Postgres 17
  (17.5): 0.5.x runs Postgres 18 and 0.6.0 runs Postgres 19
  (`SELECT version()`, checked in S1), and the offline suite should run the
  production major. It runs one connection and serialises queries, so it
  cannot show a race. It is right for "does every query, constraint and
  migration work" and wrong for "does the lock hold". It goes in
  `devDependencies` only and the backend adapts it by shape
  (`store/pg/sql.ts`), so production never loads it. `npm run check` runs
  the store suite (`scripts/_store-suite.ts`) twice, JSON and PGlite, and
  stays offline. Checked in S1 (`scripts/store-backend-test.ts`):
  generated columns, partial unique indexes, triggers, `FOR UPDATE` and
  advisory locks behave as on the server; a second holder of an advisory
  lock cannot be shown on one connection, so that case runs only in the
  Postgres 17 suite. PGlite's `query` takes one statement, so a migration
  file goes through `exec`.
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

- **The account is the owner's.** The owner provides the OCI account: its
  type, its EU region and second backup region, and Oracle's Data
  Processing Agreement for it (AGENTS.md needs one before user data lands).
  This note assumes that account exists. S7 checks in the console that the
  instance carries no idle-reclamation notice (Oracle's Always Free page,
  <https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm>,
  read 2026-11-25: "Idle Always Free compute instances may be reclaimed by
  Oracle"); §7.1 covers the host being lost anyway.
- **Postgres 17** from the PostgreSQL project's own packages (PGDG), which
  build for aarch64. A major upgrade is a planned task, not automatic; minor
  versions follow the distribution's security updates.
- **Two clusters, one per deployment.** PITR, WAL, `archive_command` and a
  pgBackRest stanza all belong to a cluster, so one cluster would tie the
  deployments together: restoring testnet to a time T would roll mainnet back
  with it, and testnet filling WAL or disk would stop mainnet. So:
  `pg_createcluster 17 mainnet -u pg-mainnet` and
  `pg_createcluster 17 testnet -u pg-testnet`, each run by its own OS user,
  each with its own data directory, its own socket directory
  (`/run/postgresql-mainnet`, `/run/postgresql-testnet`) and port number
  (mainnet 5432, testnet 5433; the port only names the socket file,
  `.s.PGSQL.<port>`, and nothing listens on TCP), its own systemd
  unit, its own pgBackRest stanza and config file, its own bucket per region,
  and its own repository passphrase. The API of a deployment runs as a third
  OS user (`zold-mainnet`, `zold-testnet`) and can reach only its own
  cluster's socket directory.
- **No network port.** `listen_addresses = ''`: each cluster listens on its
  unix socket only. The OCI security list opens no database port.
- **Peer authentication, no database password.** Each cluster's `pg_hba.conf`
  has `local` lines only. Postgres uses the **first** line that matches the
  connection type, database and user, and if that line's peer check or map
  fails it tries no later line. So the bootstrap superuser's line, with no
  map, comes first, and each database's line names that database's two
  roles in the user column, never `all`. On mainnet:

  ```
  local  all          pg-mainnet               peer
  local  <zold db>    <app role>,<owner role>  peer map=zold-mainnet
  local  hub          hub_app,hub_owner        peer map=hub
  local  all          all                      reject
  ```

  (`pg-testnet` on testnet, without the `hub` line; `pg_createcluster -u`
  names the superuser role after the cluster's OS user.) Each map is a
  `pg_ident.conf` map from that deployment's OS users to its roles
  (`zold-mainnet` → the application role, the deploy user → the owner role;
  `zold-hub` → `hub_app`, §7.2). Only the cluster's OS user connects as
  superuser, to every database: the provisioning script, the restore and
  its hash checks (§7.1), the daily dump (below) and the hub write stop
  (§7.2) run as it. `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC`, then `GRANT
  CONNECT` to the two roles of that database. A testnet process cannot open
  mainnet's socket (directory permissions), would not be mapped if it could
  (`pg_ident`), and has no `CONNECT` grant on the database. `DATABASE_URL` is
  `postgresql://<role>@/<db>?host=/run/postgresql-<deployment>&port=<port>`
  with no password (the port is needed: it names the socket file), so the environment file holds no database credential.
- **The code still takes only `DATABASE_URL`** (and `DATABASE_CA` when it is
  given). It fails closed: on a real-money chain a TCP host other than
  loopback is refused unless the URL asks for `sslmode=verify-full` and a CA
  is given. Moving the database to another host later is a config change, not
  a code change.
- **Roles:** per database, an owner role that runs the migrations (at
  deploy, before the API starts) and an application role the API runs as.
  The application role has no DDL and the grants in §5. Staging stays off the
  passkey domain, as today.
- **Disk encryption:** OCI encrypts boot and block volumes at rest by
  default, with Oracle-managed keys. A key of our own in OCI Vault is
  possible later; not needed for #166.
- **PITR: pgBackRest** (MIT, packaged by PGDG for aarch64) to OCI Object
  Storage through its S3-compatible API, off the host. Per cluster, two
  repositories: `repo1` a bucket in the host's region, `repo2` a bucket in a
  second EU region (for example `eu-amsterdam-1`), so losing a region does not
  lose the backups. Bucket names carry the deployment
  (`zold-pgbackrest-mainnet-fra`, `…-testnet-fra`, and the same in the second
  region), and each deployment's OCI user has a policy for its own two buckets
  only. WAL is archived continuously to both, with `archive-async=y` and
  `archive_timeout = 60s`; a weekly full and a daily differential backup to
  each repository (pgBackRest schedules backups per repository), 14 days of
  retention.
- **Recovery point.** `archive_timeout` forces a segment switch every 60 s;
  it does not make the upload finish. The one-minute RPO of §7.1 holds only
  while archiving keeps up, which the alerts below watch: a backlog is a
  larger loss window, and is an alert, not a silent change of the target.
- **The repository passphrase is on the host.** `archive-push` encrypts each
  WAL segment (`repo-cipher-type=aes-256-cbc`), so it needs
  `repo-cipher-pass` at every push. It sits in that cluster's pgBackRest
  config file, mode `0600`, owned by the cluster's OS user (`pg-mainnet` /
  `pg-testnet`: `archive_command` runs as that user, so root-only would not
  work), and nowhere else on the host. Each cluster has its own passphrase.
  The owner holds the off-host copy outside OCI; without it no restore is
  possible, on this host or a new one. A copy of a bucket alone opens
  nothing; a copy of the host opens its own cluster's repositories.
- **What pgBackRest does when one repository fails** (user guide, "Multiple
  Repositories", <https://pgbackrest.org/user-guide.html#multi-repo>):
  `archive-push` "will always push WAL to the archive in all configured
  repositories"; "when a repository cannot be reached, WAL will still be
  pushed to other repositories", but only with `archive-async=y`, "otherwise,
  the other repositories can only get one WAL segment ahead of the
  unreachable repository"; and "if WAL cannot be pushed to any repository,
  then PostgreSQL will not remove it from the pg_wal directory, which may
  cause the volume to run out of space". The documentation does not say
  whether a segment stored in one repository but not the other is reported
  to Postgres as archived. S7 tests it on the host by blocking `repo2` and
  watching `pg_wal` and `pg_stat_archiver`, and writes the result here. We do
  **not** set `archive-push-queue-max`: on reaching it pgBackRest reports the
  WAL as archived and drops it, and "PITR will not be possible past that
  point" (<https://pgbackrest.org/configuration.html#section-archive/option-archive-push-queue-max>).
  A cluster that stops on a full WAL volume refuses writes and keeps its
  history; one that drops WAL keeps taking money writes with no way to
  restore them. A repository that stays unreachable is removed from the
  config by hand (as in §7.1 step 4), with a new full backup to the one that
  remains, so its segments stop piling up.
- **Alerts** (per cluster, every minute, to the owner's phone through the
  same channel as the reconciler): `pg_stat_archiver.failed_count` rose, or
  `now() - last_archived_time` over 5 minutes; free space on the Postgres
  volume under 30 % and under 15 %; `pgbackrest check` failing. Each cluster's
  data directory is on its own block volume, so one cluster filling its disk
  does not fill the other's.
- **Backups the host cannot delete.** The host's Object Storage key can
  overwrite and delete in the pgBackRest buckets, because pgBackRest needs
  both (it rewrites `backup.info`, and `expire` deletes old backups), so a
  compromised host or a bad `expire` can empty both repositories. OCI
  retention rules cannot protect those buckets: a time-bound rule refuses
  overwriting and deleting every object in the bucket for its duration
  ("You can't update, overwrite, or delete objects or object metadata …
  for the duration specified (time-bound rules)", and rules apply to the
  whole bucket,
  <https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usingretentionrules.htm>),
  which stops pgBackRest itself. Instead each deployment gets a third bucket,
  `zold-dumps-<deployment>`, in the second region, with a **time-bound
  retention rule of 14 days**. A systemd timer writes a daily `pg_dump`
  piped to `age` (to the owner's age key) into it, each as a new object: `pg_dumpall --globals-only` (the roles and their attributes; there are no
  passwords, §7) and `pg_dump -Fc` of each database in the cluster (on
  mainnet, Zold's and `hub`, §7.2), in one encrypted tar. Each database's
  dump carries its own check file: the timer opens a `REPEATABLE READ`
  transaction, takes `pg_export_snapshot()`, computes per-table row counts
  and hashes inside it, and runs
  `pg_dump --snapshot=<id>` on the same snapshot, so the counts describe
  exactly the rows in the dump. This is **the table check**, the one
  every drill and restore in this note uses. It is generic, not §6's
  `doc`-by-id one, so it fits every table: per table, the row count and a
  SHA-256 over each row as `to_jsonb(row)::text` (every column, keys in a
  fixed order), the rows sorted by that text `COLLATE "C"`, which needs no
  primary key (`ledger_history`) and no btree order on a `json` column.
  The session first runs `SET TimeZone = 'UTC'`, `SET DateStyle = 'ISO,
  YMD'`, `SET IntervalStyle = 'postgres'`, `SET extra_float_digits = 1`
  and `SET bytea_output = 'hex'`, so the text form does not depend on the
  host's time zone, settings or collation library: the same rows hash the
  same on the live host, a drill instance and a fresh `initdb`. For a document table that is `id` and `doc`; for
  `payment_handles`, `schema_migrations`, `outbox`, `ledger_history`,
  `cap_holds`, `pending_executions` and the hub's tables it is their own
  columns. The drill compares the restored database against the same
  query. The
  host's credential for it has create and read only (no overwrite, no
  delete); a lifecycle rule deletes objects after 30 days. A compromised
  host can then wipe the PITR repositories but not the last 14 days of
  dumps: the worst case is a restore from the last daily dump. The rule
  starts unlocked; whether to lock it (irreversible, "not even a tenancy
  administrator or Oracle Support can delete a locked rule") is the owner's
  call (§9).
- pgBackRest over WAL-G: it encrypts the repository, has a `verify` command,
  and is in the same package repository as Postgres.
- **Restore drill:** before the cut-over, then monthly per cluster, **onto a
  new OCI instance**, not the running host. The drill must never write to
  the production repositories: its OCI user holds a **read-only** credential
  for the pgBackRest buckets (read and list, no create, overwrite or
  delete), the restore runs with `pgbackrest restore --archive-mode=off`
  (<https://pgbackrest.org/command.html#command-restore>: "it is not a good
  idea to push WAL from the cluster into the repository"), and
  `pgbackrest stop` runs on the drill instance before Postgres starts, which
  blocks `archive-push`, `backup` and `expire` there. It follows the rebuild
  below up to the restore, restores to a time T, starts Postgres, and
  runs the table check (above) on every table of every database in the
  cluster, against the same check run on the live host at T (one
  `REPEATABLE READ` snapshot per database). It does not start the API: a restored
  mainnet API would run the sweeps against real partners, a second API
  process (§2). The drill restores from `repo1` and `repo2` in alternate
  months, and every third month from the latest dump instead (§7.1, both
  repositories lost), so the logical path is tried too; that month it
  compares against the dump's own check file, not an export from the live
  database, which has taken writes since. It times the database part, from "instance requested" to "verify
  passed". The service part of the recovery target (API, tunnel, smoke) is
  timed on testnet: once before the cut-over and then quarterly, testnet is
  rebuilt for real onto a new instance (its old API stopped first), the
  tunnel moved to it and the smoke run, and the time from "instance
  requested" to "smoke passed" logged. Both times are logged on the board
  with the result; either over the recovery-time target is a finding. Drill
  instances are deleted afterwards.
- **Off-box copy:** `scripts/backup-db.sh` gains a Postgres mode (`pg_dump`
  piped to `age`) for a copy outside OCI, run by the owner.
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
the last minute before the host died (RPO, `archive_timeout`, while
archiving keeps up, §7). Testnet follows mainnet, within a further 4 hours.
If both pgBackRest repositories are lost too, the fallback is the last daily
dump in the retention bucket (§7), and the loss window is up to a day.

What must exist outside the host for this to work: the pgBackRest
repositories (both regions), the dump bucket, the repository passphrases, an
age-encrypted copy of each deployment's environment file, and the Cloudflare
tunnel, all held by the owner; the code is on GitHub (`production`).

Rebuild, mainnet first, then testnet the same way:

1. Create an Ampere A1 instance from the same image in the same (or the
   second) EU region; attach one block volume per cluster for its data
   directory.
2. Run the provisioning script: the OS users per deployment, PGDG Postgres
   17 and pgBackRest, the two clusters with their socket directories,
   `listen_addresses = ''`, `pg_hba.conf` and `pg_ident.conf` with `peer`
   only (§7), Node 22.23.4 linux-arm64.
3. Write the cluster's pgBackRest config with **only the repositories that
   can be reached**. With a region gone, that is `repo2` alone:
   `pgbackrest check` checks "all repositories … that are configured"
   (<https://pgbackrest.org/command.html#command-check>), and an unreachable
   one would fail it and hold WAL. `pgbackrest restore --repo=<n>` to the
   latest point or a chosen time. Start Postgres. The owner and application
   roles and their grants come back with the restore; the script checks that
   both exist, that the application role has only the §5 grants, and that
   `CONNECT` is revoked from `PUBLIC`.
4. `pgbackrest check`, so WAL archiving runs again from the new host before
   it takes a write. A repository left out in step 3 is added back, with a
   new stanza in a reachable region if its own is gone, and a full backup is
   taken to it before it counts as a second copy.
5. Restore the environment files, then the systemd units for the API (per
   deployment) and `cloudflared`, and the deploy pull loop on `production`.
   `npm run preflight`.
6. Start `cloudflared` with the tunnel's credentials; the hostnames follow
   the tunnel, so DNS does not change.
7. Smoke as in §6 step 7. The old instance, if it comes back, stays stopped:
   two hosts must never write to the same repositories, and two API
   processes must never run for one deployment (§2).

**Both repositories lost** (or both unreadable): steps 1-2, then fetch the
latest dump from the dump bucket and decrypt it with the owner's age key,
which is never on the host (the owner runs `age -d` or hands the key in for
the restore only). The cluster comes from `initdb`, so at first only its
bootstrap superuser exists, and the `peer` mappings of step 2 point at roles
that are not there yet. Every step below runs as the cluster's OS user
(`pg-mainnet`) over the socket, through its own `pg_hba.conf` line (§7).
The globals are loaded first: the dump's `CREATE ROLE "pg-mainnet";` line,
which `initdb` already made, is filtered out (`grep -vx`), and the rest
runs with `psql -v ON_ERROR_STOP=1`, so any error stops the restore. Then,
for **every database in the dump** (on mainnet, Zold's and `hub`, §7.2):
`CREATE DATABASE <db> OWNER <its owner role>`, `pg_restore --role=<its
owner role>` into it, and run the table check (§7) on it against the dump's
check file. `pg_restore` without `--create` does not carry the
database-level settings (since PG 11 they are in neither the globals nor
the restored contents), so the provisioning script's database step is run
next: `REVOKE CONNECT … FROM PUBLIC` and the `GRANT CONNECT`s on each
database, `CONNECTION LIMIT 25` on `hub`, and any `ALTER DATABASE … SET`.
Only then the step-3 check, which here also checks that `CONNECT` is
revoked from `PUBLIC` on each database, granted only to that database's two
roles, and that `hub` has `datconnlimit = 25` (and, for `hub`, the checks of
§7.2); and that each database's `schema_migrations` is at the latest
version. Before S9 ports the hub, `hub` is provisioned but empty, with no
tables and no `schema_migrations`: the check then expects exactly that, and
any table in it fails. Then create a new pgBackRest stanza in each reachable
region and take a full backup before step 5. Everything after the dump's
time is lost; the reconciler reports the drift and the owner is told the
loss window.

Transfers in flight when the host died are handled by the existing sweeps
after the restart: an intent without a known outcome goes to review (§2,
outbound intents). A write lost inside the RPO window is the case the
reconciler reports and does not repair.

The limit #166 names ("the API still sees the data in memory and holds the
database credentials") holds on the Oracle host too: Oracle, as the host,
can reach the disk and memory, under its processing agreement.

### 7.2 The hub on the same server

The `@zold/accept` hosted hub (Agentic-payment-protocol, `packages/hosted`,
today SQLite `hub.db`) moves into the mainnet cluster, in a **database of its
own**, `hub`, not a schema in Zold's. The hub takes untrusted agent traffic
and its code is public, so it is kept apart by the database boundary, roles
and limits, not by trust in its code. A schema would not be enough: in one
database the hub could take any advisory lock Zold uses (they are per
database and need no privilege: holding `api:<deployment>` stops the API
from starting, holding `cap:<key>` turns that cap's transfers into
`lock_timeout` errors), and it would keep `USAGE` on `public` and `EXECUTE`
on its functions through `PUBLIC`, whatever is revoked from its own role.

- **Its own database.** `CREATE DATABASE hub OWNER hub_owner`. Advisory
  locks, `LISTEN/NOTIFY`, the `public` schema and functions are then
  separate from Zold's. `REVOKE CONNECT ON DATABASE <zold db> FROM PUBLIC`
  (the §7 pattern) leaves `hub_app` and `hub_owner` unable to connect to
  Zold's database at all; `REVOKE CONNECT ON DATABASE hub FROM PUBLIC` and
  `GRANT CONNECT` to the two hub roles only. Postgres has no cross-database
  query without `dblink` or `postgres_fdw`, so neither extension is
  installed in either database, and the provisioning script checks it.
- **Its own roles.** `hub_owner` owns the `hub` database and runs its
  migrations; it is `NOSUPERUSER NOCREATEROLE NOCREATEDB`, and the deploy
  user is mapped to it only at migration time, as for Zold's owner role
  (§7). `hub_app` is what the hub process runs as, with DML on the hub's
  tables only and no DDL. No Zold role has `CONNECT` on `hub`.
- **Limits for untrusted traffic.** Connections, WAL and disk belong to the
  cluster, so a hub flood must not reach Zold:
  - connections: `ALTER ROLE hub_app CONNECTION LIMIT 20` and
    `ALTER DATABASE hub CONNECTION LIMIT 25`, the hub's own pool below that,
    and `reserved_connections = 10` with `pg_use_reserved_connections`
    granted to Zold's application and owner roles (Postgres 16+), so a hub
    flood cannot lock the API out of `max_connections`;
  - queries, per role with `ALTER ROLE hub_app SET`: `statement_timeout =
    '5s'`, `lock_timeout = '2s'`, `idle_in_transaction_session_timeout =
    '10s'`, `temp_file_limit = '256MB'`, `work_mem = '4MB'`;
  - writes: the hub rate-limits writes per agent **and in total** in its
    own code, since a write flood fills the shared `pg_wal` and archive,
    and under the fail-closed choice in §7 a full WAL volume stops mainnet
    money writes. Postgres has no per-database disk quota, so a cap the
    hub's code can miss is backed by one outside it: the per-minute alert
    check also **stops the hub** when `hub` passes its hard size or the
    shared volume drops under 15 % free, with `ALTER DATABASE hub
    CONNECTION LIMIT 0` and `pg_terminate_backend` on its sessions. The
    check runs as the cluster's OS user and bootstrap superuser
    (`pg-mainnet`, §7), the one role that may do both. Zold keeps writing;
    the owner lifts the stop by hand, as that same user, with `ALTER
    DATABASE hub CONNECTION LIMIT 25` (the provisioned value, not `-1`). The
    provisioning script leaves a limit of 0 on `hub` as it is and says so,
    so a re-run never lifts a stop;
  - alerts: the §7 disk and archiver alerts name the database that is
    growing (`pg_database_size` per database, and the write counters of
    `pg_stat_database` per database against the cluster's WAL rate in
    `pg_stat_wal`), with an extra alert when `hub` passes a size set in
    S7.
  The numbers are S7's starting values, tuned under real hub load in S9.
- **Its own OS user, hardened.** The hub process runs on the host as
  `zold-hub`, mapped by `pg_ident.conf` to `hub_app` only, with `peer` on
  the socket as in §7; the socket directory gives it a path and nothing
  more. No TCP port is opened for Postgres. Its systemd unit sets
  `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`,
  `PrivateTmp=yes` and `ReadWritePaths=` its own state directory only, and
  `InaccessiblePaths=` the environment files of `zold-mainnet` and
  `zold-testnet` and the pgBackRest config files; those files are not
  readable by `zold-hub` by mode either.
- **Shared backups, separate repair.** Being in the mainnet cluster, `hub` is
  in the same pgBackRest stanza, the daily dump (§7: globals plus `pg_dump
  -Fc` per database), the restore drill (both databases in its verify) and
  the recovery target (§7.1). PITR is per cluster, so it couples the two in
  both directions. **A hub-only incident is never repaired with a cluster
  PITR**, because that rewinds Zold's money state. It is repaired by a
  logical restore of the `hub` database alone: `pg_restore` of the last
  daily dump into a fresh `hub` database, or a PITR to the chosen time onto
  a scratch instance (the drill's read-only path) and a `pg_dump` of `hub`
  from there restored into the host, each followed by the table check, the
  provisioning script's database step and checks as in §7.1. The restore
  does not lift a stop: before it, the owner records the live `hub`'s
  `datconnlimit`; if it was 0, the database step sets 0 again, not 25, and
  the check expects 0. The stop is then lifted by hand, as above. A Zold PITR rewinds the hub with it,
  and the hub's agents are told which window they lost.
- **Testnet.** The mainnet cluster holds only the mainnet hub. A testnet
  hub, if one runs, is a `hub` database in the testnet cluster with the same
  roles, limits and unit, as its own OS user `zold-hub-testnet`; testnet hub
  data never sits in the mainnet cluster.
- **Provisioned here, ported there.** The `hub` database, its roles, grants,
  `CONNECT` revokes, limits, `pg_ident` lines and systemd unit are created
  by S7's provisioning script (`scripts/oracle-host/`, §7.1) in this
  repository, so the isolation is reviewed in one place. S9 only ports the
  code and imports `hub.db` into what S7 created.
- **No bridge yet.** Settlements stay in the hub. A later hub→Zold-ledger
  bridge, if it is built, is narrow and audited: one store method behind its
  own role, writing only through the ledger's append path (§5), each call in
  the audit trail. Not part of #166.

## 8. Slices

Each slice is one PR, mergeable on its own with main green. The JSON backend
stays the default until the cut-over.

| Slice | What | Owner needed |
|---|---|---|
| S0 | This note | approval |
| S1 | `pg` dependency, PGlite dev dependency, migration runner, `0001_init.sql` (§1), the Postgres backend behind the interface with the same method bodies, store suites run on JSON and PGlite. No caller switched | — |
| S2 | Async store API and the mechanical conversion (§3), on the JSON backend. `store.tx` replaces `batched`. Rows are clones. Caller check-then-writes in §2 moved into store methods first: the sub-object methods and the spread/push grep gate (rule 2), conditional state writes (rule 3), and the §2 rows marked S2 with their tests on JSON | — |
| S3 | Money-path transactions and locks on Postgres: the one-process start lock and the sweep locks, `cap_holds`, recovery-start lock, `recordPaymentRequestPayment`, `settleInvoice`, the dedupe keys, monotonic sign count, the §2 rows marked S3. `npm run check:pg` with the concurrency tests of §2's first table, the executor ‖ compensator append, and the S2 rows run in parallel | — |
| S4 | Outbox and its worker (checkout hints, PAID hooks); audit and no-delete triggers; `ledger_history`; the application role's grants. Identity and recovery: `session_epoch`, the ceremony-challenge audit of the 9 callers, the Candide, Turnkey and Zoldenburg-finalize reserve statuses, the Monerium token compare in the store; their tests on JSON and Postgres 17 | — |
| S5 | Importer, export, verify (§6), run against a copy of the testnet `db.json` on the local Postgres 17. Constraint findings reported to the lead | — |
| S6 | Docs: AGENTS.md (where the code lives, secrets and storage), `docs/running-locally.md` (local Postgres, `check:pg`), technical-architecture §18.1, `docs/roadmap.md`, `docs/status.md` | — |
| S7 | The Oracle host (§7): Postgres 17 and roles, two clusters with peer authentication, pgBackRest to Object Storage in two regions, the dump bucket with its retention rule, the archiver and disk alerts, the one-repository-down test, systemd units, the deploy pipeline in place of the Akash leg, the aarch64 toolchain check, the cut-over runbook, the host-loss runbook and provisioning script (§7.1) including the `hub` database, its roles, grants and limits (§7.2), and the first restore drill onto a new instance and the first testnet rebuild, both timed | recovery-time target accepted; host access |
| S8 | Cut-over (§6): testnet, then app.zoldhq.com. `STORE_BACKEND=postgres` becomes the default; the JSON backend stays one release as the rollback path, then goes | the owner picks the time |
| S9 | Hub on Postgres (§7.2), in Agentic-payment-protocol: `packages/hosted` ported from SQLite to the `hub` database S7 created, an import of the existing `hub.db` with a verify (row counts and hashes per table, as §6, and the isolation: `hub_app` cannot connect to Zold's database, cannot take an advisory lock in it, and holds no privilege outside `hub`; the same three checks run in the drill). Needs S7, not S8 | — |

S2 is the largest (about 1,250 call sites and 2,000 in tests) and can be cut
by directory if one PR is too big to review. S7 can run alongside S2-S5.
S9 comes after S7 and can land before S8, so the §7.2 limits meet real hub load before Zold's cut-over. It is a PR on Agentic-payment-protocol, not on this repository; the hub code stays there for now, and its database, roles and limits come from S7's script here.

## 9. Owner questions

1. **Recovery target:** accept or change the proposed 4 hours to restore
   service and one minute of lost writes after losing the host (§7.1).
   And: lock the dump bucket's retention rule once S7 has run it for a
   while? Locked, not even Oracle can shorten it; unlocked, an OCI
   administrator account can delete the rule (§7).
2. **Cut-over:** the owner's call, once S7 is done (§6). Nothing to answer
   now.
