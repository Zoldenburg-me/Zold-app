<!-- Generated: 2026-10-07 | Files scanned: 176, full read | Token estimate: ~1000 -->
# Backend (services/api/src)

## Middleware chain (server.ts)
json (keeps rawBody for HMAC) → securityHeaders → originPolicy (CORS GET/POST/DELETE, foreign Origin on writes = 403) → trust proxy → /api rate limit (buckets g/a/o/p/d/s) → pages (before /api, so static cannot shadow it) → routers → notFound → error handler
No helmet, no global auth: each handler calls the injected `requireSession` / `requireUserSession`; operator routes use a bearer token; webhooks check signatures.
Startup/timers: sweepStrandedTransfers (boot, 5 min), sweepAnchorPayouts (30 s), recovery, payment-request, crypto-deposit and wallet-sync pollers.

## Routers (224 API routes + 17 page GETs = 241; per-file counts from `router.METHOD(`) — file: route groups
| Mount | File | Routes |
|---|---|---|
| /api | routes/auth.ts | session, webauthn challenge, passkey register/login, passkey-Safe deployment |
| /api | routes/users.ts | POST /users, /users/:id, display name (locked once Monerium verifies), bic, kyc, privacy bundles |
| /api | routes/transfers.ts | POST /quotes, POST /transfers, activity, authorize, refresh-payout |
| /api | routes/monerium.ts (1175 l) | OAuth connect/callback, API keys, link-signature, activate, move-iban |
| /api | routes/monerium-webhook.ts | POST /webhooks/monerium |
| /api | routes/payment-page.ts | handle, /pay/:handle, QR svg |
| /api | routes/ens.ts (2) | GET /ens/lookup?name= (session), CCIP-Read gateway for the L1 OffchainResolver |
| /api | routes/payment-requests.ts | user payment requests, /pay/:handle/:code (+quote) |
| /api | routes/crypto-deposits.ts | deposits, convert prepare/execute, auto-convert |
| /api | routes/documents.ts | receipt/statement/balance/ownership docs, /v/:code verify |
| /api | routes/receipt-shares.ts | share a transfer receipt, /r/:slug |
| /api | routes/recovery-candide.ts | email/SMS guardian channels, recovery flow |
| /api | routes/recovery-zoldenburg.ts | Zoldenburg guardian + /admin/recoveries |
| /api | routes/safe-signers.ts, safe-import.ts | owners, threshold, spending limits, import |
| /api | routes/shopify.ts (13) | org install (/orgs/:id/shopify), callback, HMAC payment/refund/capture/void/order hooks, order pay pages |
| /api | routes/email-verification.ts, faucet.ts, admin.ts | codes, testnet faucet, operator stats |
| /api/orgs | routes/orgs.ts (28) | orgs, plans, members, invites, accounts, contacts, wallets and their ownership proof (challenge, prove, re-check) |
| /api/orgs | routes/business.ts → routes/business/* (50 routes; no src/business dir) | drafts (four-eyes runs), invoices, invoicing (§14 UStG; issue-outgoing is the one issue path), income-invoices (payer rules, monthly drafts from wallet receipts, issuing a draft), payment-links, bookkeeping (coa, rules, ledger, holdings, realised gains, revalue), bookkeeping-export (statement, Belege, Lexware, ZIP), integrations (GetMyInvoices) |
| /api/invoice-links | business/invoice-links.ts | supplier fills an invoice by token |
| /api/gnosis-pay | routes/gnosis-pay.ts | SIWE, account, transactions |
| — | server.ts | GET /api/health, GET /api/rates |

## Core modules
orchestrator.ts (1226 l) transfer state machine · transfers/build.ts (400) build from quote ·
liquidity.ts + liquidity/{best,lifi,uniswap,cow,rfq,fx-swapper} venues ·
rates.ts independent mid · fx.ts · chain.ts (viem) · sepa.ts · reconcile.ts ·
ens.ts (CCIP-Read encoding, signer) · usd-token.ts (the dollar token: USDC, or zUSD on staging) ·
log-range.ts (eth_getLogs window halves on RPC range refusals) · users/display-name.ts · users/verified-name.ts (the name Monerium verified) ·
transfers/{activity (the feed, bank-in rows from issue orders), safe-moved (what a transfer took from the Safe), review-evidence (what resolves MANUAL_REVIEW as PAID), user-transfer (owner's view of a transfer)} ·
adapters/monerium-limit.ts (one soft rate-limit queue for every Monerium GET) ·
payment-requests.ts (707) · pay.ts · documents.ts · receipt.ts · audit.ts ·
wallet/signature-check.ts (the one signed-message verifier: EIP-1271, ECDSA, ERC-6492) ·
wallet-sync/{sync,valuation,token-class,token-lists,ownership (proof checked on the wallet's chain),revalue (price retry)}

## Domain (pure rules)
roles (5 roles → permissions) · plans (capabilities) · drafts (state machine) ·
invoices/invoicing/vat-ids/jurisdictions · income-invoices (drafts from wallet receipts) · coa (chart + default rules) · ledger (FIFO holdings, disposals, gains per month) ·
wallet-ownership (proof challenge and state) ·
safe-books (from when a Safe's movements are an account's books) ·
accounts · ceilings · residency · monerium-profile · monerium-identity (carries identity, profile history) · monerium-order (processed state) · payment-review (second-person review needed) · csv-safe (formula guard on every CSV export)

## HTTP layer (http/)
sessions · guards · policy · passkey-assertion · error-log · known-errors · async-errors · log-cause (URL-redacted error causes for logs and clients)
