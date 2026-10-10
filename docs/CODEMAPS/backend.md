<!-- Generated: 2026-10-04 | Files scanned: 151 | Token estimate: ~1000 -->
# Backend (services/api/src)

## Middleware chain (server.ts)
json → securityHeaders → originPolicy → /api rate limit → pages → routers → notFound → error log

## Routers (~238 routes) — file: route groups
| Mount | File | Routes |
|---|---|---|
| /api | routes/auth.ts | session, webauthn challenge, passkey register/login, passkey-Safe deployment |
| /api | routes/users.ts | POST /users, /users/:id, display name (locked once Monerium verifies), bic, kyc, privacy bundles |
| /api | routes/transfers.ts | POST /quotes, POST /transfers, activity, authorize, refresh-payout |
| /api | routes/monerium.ts (1175 l) | OAuth connect/callback, API keys, link-signature, activate, move-iban |
| /api | routes/monerium-webhook.ts | POST /webhooks/monerium |
| /api | routes/service-checkout.ts | GET /service/checkout/transfers/:id (checkout-service credential), POST /admin/service-credentials/checkout/rotate |
| /api | routes/payment-page.ts | handle, /pay/:handle, QR svg |
| /api | routes/ens.ts | GET /ens/gateway/:sender/:callData.json (CCIP-Read, signed for the L1 OffchainResolver), GET /ens/lookup?name= |
| /api | routes/payment-requests.ts | user payment requests, /pay/:handle/:code (+quote) |
| /api | routes/crypto-deposits.ts | deposits, convert prepare/execute, auto-convert |
| /api | routes/documents.ts | receipt/statement/balance/ownership docs, /v/:code verify |
| /api | routes/receipt-shares.ts | share a transfer receipt, /r/:slug |
| /api | routes/recovery-candide.ts | email/SMS guardian channels, recovery flow |
| /api | routes/recovery-zoldenburg.ts | Zoldenburg guardian + /admin/recoveries |
| /api | routes/recovery-turnkey.ts | Turnkey guardian sub-orgs: /recovery/turnkey/users/:id/guardians (+ /:subOrgId/add and /remove, /ops/:requestId: the passkey ops that add or remove it on chain), /recovery/turnkey/login (404 until `TURNKEY_GUARDIANS=1`) |
| /api | routes/recovery-turnkey-requests.ts | recovery with that guardian: /recovery/turnkey/requests (+/:id/passkey, /digest, /signature, /finalize; per-request secret), /users/:id/recovery/turnkey/requests (+/:rid/cancel) |
| /api | routes/safe-signers.ts, safe-import.ts | owners, threshold, spending limits, import |
| /api | routes/shopify.ts | install/callback, payments app hooks, order pay pages |
| /api | routes/email-verification.ts, faucet.ts, admin.ts | codes, testnet faucet, operator stats |
| /api/orgs | routes/orgs.ts (27) | orgs, plans, members, invites, accounts, contacts, wallets and their ownership proof (challenge, prove, re-check) |
| /api/orgs | routes/business.ts → business/* | drafts (four-eyes runs), invoices, invoicing (§14 UStG; issue-outgoing is the one issue path), income-invoices (payer rules, monthly drafts from wallet receipts, issuing a draft), payment-links, bookkeeping (coa, rules, ledger, holdings, realised gains, revalue), bookkeeping-export (statement, Belege, Lexware, ZIP), integrations (GetMyInvoices) |
| /api/invoice-links | business/invoice-links.ts | supplier fills an invoice by token |
| /api/gnosis-pay | routes/gnosis-pay.ts | SIWE, account, transactions |
| — | server.ts | GET /api/health, GET /api/rates |

## Core modules
orchestrator.ts (1079 l) transfer state machine · transfers/build.ts (400) build from quote ·
liquidity.ts + liquidity/{best,lifi,uniswap,cow,rfq,fx-swapper} venues ·
rates.ts independent mid · fx.ts · chain.ts (viem) · sepa.ts · reconcile.ts ·
ens.ts (CCIP-Read encoding, signer) · usd-token.ts (the dollar token: USDC, or zUSD on staging) ·
log-range.ts (eth_getLogs window halves on RPC range refusals) · users/display-name.ts ·
payment-requests.ts (707) · pay.ts · documents.ts · receipt.ts · audit.ts ·
checkout-service.ts (checkout scope, allowlist, hashed credential) · checkout-webhook.ts (signed state-change hint) ·
http/standard-webhooks.ts (sign and verify, both directions) ·
wallet/signature-check.ts (the one signed-message verifier: EIP-1271, ECDSA, ERC-6492) ·
wallet-sync/{sync,valuation,token-class,token-lists,ownership (proof checked on the wallet's chain),revalue (price retry)}

## Domain (pure rules)
roles (5 roles → permissions) · plans (capabilities) · drafts (state machine) ·
invoices/invoicing/vat-ids/jurisdictions · income-invoices (drafts from wallet receipts) · coa (chart + default rules) · ledger (FIFO holdings, disposals, gains per month) ·
wallet-ownership (proof challenge and state) ·
safe-books (from when a Safe's movements are an account's books) ·
accounts · ceilings · residency · monerium-profile

## HTTP layer (http/)
sessions · guards · policy · passkey-assertion · error-log · known-errors · async-errors
