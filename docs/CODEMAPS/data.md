<!-- Generated: 2026-10-03 | Files scanned: 3 (store/db.ts, store/types.ts, domain/types.ts) | Token estimate: ~650 -->
# Data

One JSON file (`TRANSF_DB_PATH`, default data/db.json), read/written whole by
store/db.ts; every write persists synchronously (`batched` groups a loop).
No SQL, no migrations tool: db.ts runs idempotent migrations at load
(e.g. migrateUsersToOrganisations).
`npm run dev` wipes data/db.dev.json on start.

## Collections
Personal side
- users (passkey, passkeySafe, iban/ibanBic, monerium, paymentPage) · sessions
- quotes → transfers (orchestrator states, custody, marginBps)
- paymentRequests (source: app | shopify) · receiptShares · documents
- cryptoDeposits · conversionSweeps · moneriumIssueOrders
- processedMoneriumOrders / processedMoneriumWebhooks (idempotency)
- recoveryRequests · shopifyConnections · audit

Organisations
```
organisations ─┬─ members (role, status, invite)
               ├─ accounts (currency, backingUserId → users, gate, profile)
               ├─ importedWallets
               ├─ contacts (bankAccounts, fingerprint)
               ├─ drafts (payment runs: DRAFT→PENDING_REVIEW→REVIEWED→EXECUTING→EXECUTED)
               ├─ invoices (incoming via link; outgoing issued snapshot; DRAFT from wallet receipts, settled by ledger rows)
               ├─ chartAccounts + accountRules (default rules on org create)
               └─ ledger (entries; `statement` = the euro account's lines, Belege)
```

## Rules baked into the data
- Nothing in store.ts deletes an org, account, invoice or ledger row.
- Gating is read-time (plans/capabilities), never a write-time delete.
- Ledger accountCode: set by a rule (`accountCodeAuto`) or a person (PATCH).
- Invoice link tokens are stored hashed (linkTokenHash); sessions by tokenHash.
