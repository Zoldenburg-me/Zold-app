<!-- Generated: 2026-10-03 | Files scanned: 144 | Token estimate: ~950 -->
# Backend (services/api/src)

## Middleware chain (server.ts)
json → securityHeaders → originPolicy → /api rate limit → pages → routers → notFound → error log

## Routers (221 routes) — file: route groups
| Mount | File | Routes |
|---|---|---|
| /api | routes/auth.ts | session, webauthn challenge, passkey register/login, passkey-Safe deployment |
| /api | routes/users.ts | POST /users, /users/:id, bic, kyc, privacy bundles |
| /api | routes/transfers.ts | POST /quotes, POST /transfers, activity, authorize, refresh-payout |
| /api | routes/monerium.ts (1175 l) | OAuth connect/callback, API keys, link-signature, activate, move-iban |
| /api | routes/monerium-webhook.ts | POST /webhooks/monerium |
| /api | routes/payment-page.ts | handle, /pay/:handle, QR svg |
| /api | routes/payment-requests.ts | user payment requests, /pay/:handle/:code (+quote) |
| /api | routes/crypto-deposits.ts | deposits, convert prepare/execute, auto-convert |
| /api | routes/documents.ts | receipt/statement/balance/ownership docs, /v/:code verify |
| /api | routes/receipt-shares.ts | share a transfer receipt, /r/:slug |
| /api | routes/recovery-candide.ts | email/SMS guardian channels, recovery flow |
| /api | routes/recovery-zoldenburg.ts | Zoldenburg guardian + /admin/recoveries |
| /api | routes/safe-signers.ts, safe-import.ts | owners, threshold, spending limits, import |
| /api | routes/shopify.ts | install/callback, payments app hooks, order pay pages |
| /api | routes/email-verification.ts, faucet.ts, admin.ts | codes, testnet faucet, operator stats |
| /api/orgs | routes/orgs.ts (24) | orgs, plans, members, invites, accounts, contacts, wallets |
| /api/orgs | routes/business.ts → business/* | drafts (four-eyes runs), invoices, invoicing (§14 UStG; issue-outgoing is the one issue path), income-invoices (payer rules, monthly drafts from wallet receipts, issuing a draft), payment-links, bookkeeping (coa, rules, ledger), bookkeeping-export (statement, Belege, Lexware, ZIP), integrations (GetMyInvoices) |
| /api/invoice-links | business/invoice-links.ts | supplier fills an invoice by token |
| /api/gnosis-pay | routes/gnosis-pay.ts | SIWE, account, transactions |
| — | server.ts | GET /api/health, GET /api/rates |

## Core modules
orchestrator.ts (1077 l) transfer state machine · transfers/build.ts (400) build from quote ·
liquidity.ts + liquidity/{best,lifi,uniswap,cow,rfq,fx-swapper} venues ·
rates.ts independent mid · fx.ts · chain.ts (viem) · sepa.ts · reconcile.ts ·
payment-requests.ts (702) · pay.ts · documents.ts · receipt.ts · audit.ts

## Domain (pure rules)
roles (5 roles → permissions) · plans (capabilities) · drafts (state machine) ·
invoices/invoicing/vat-ids/jurisdictions · income-invoices (drafts from wallet receipts) · coa (chart + default rules) · ledger ·
accounts · ceilings · residency · monerium-profile

## HTTP layer (http/)
sessions · guards · policy · passkey-assertion · error-log · known-errors · async-errors
