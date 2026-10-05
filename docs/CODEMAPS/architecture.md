<!-- Generated: 2026-10-04 | Files scanned: 192 (151 .ts, 41 .js) | Token estimate: ~750 -->
# Architecture

Single Node/Express app (`services/api`) serving the API, the website and three
front ends, plus Solidity contracts used only on local hardhat.

```
browser ─┬─ /            landing (site.css/site.js + landing.css, landing/*.js)
         ├─ /app         the person's own account (public/app/*.js, classic scripts)
         ├─ /business    Zold Business: companies (public/business/*.js, ES modules)
         ├─ /admin       operator view (admin.html)
         ├─ /pay, /invoice, /v, /r   public pages (no session)
         └─ ENS wallets ─► /api/ens/gateway (CCIP-Read for <handle>.zoldhq.com)
                │
        services/api/src/server.ts  (wiring only: middleware → routers)
                │
   routes/* ──► domain/* (rules)  ──► store.ts ──► store/db.ts (one JSON file)
      │            │
      │            └─► bookkeeping/* (statement, Belege, exports)
      └─► transfers/build.ts ──► orchestrator.ts ──► liquidity.ts ─► liquidity/*
                                    │                    (LI.FI, DEX, CoW, RFQ)
                                    ├─► chain.ts (viem, Base / Base Sepolia / 31337)
                                    ├─► wallet/* (passkey Safe via Candide bundler)
                                    └─► sepa.ts ─► adapters/monerium-* (EURe ↔ IBAN)
```

## Boundaries
- **server.ts** owns auth: every router is a factory taking `requireSession` /
  `requireUserSession`.
- **transfers/build.ts** is the ONE path that builds a transfer; the business
  router is handed it.
- **store.ts** is the only code touching the db object.
- **capabilities.ts** → `/api/health`; the UI renders a control only where the API accepts it.

## Money flow (send)
Function-level map of both rails: remittance.md.
`POST /api/quotes` → `POST /api/transfers` (prepares the userOp = the debit)
→ passkey signs → `POST /transfers/:id/authorize` → orchestrator executes
(swap if needed, measured balance delta) → Monerium redeem to IBAN (SEPA)
→ reconcile.ts reports drift, never repairs.

## Money flow (receive)
Monerium issue to the Safe (IBAN in) · payment page / request (`/pay`, or
its ENS name `<handle>.zoldhq.com`) ·
crypto deposit via Candide forwarder → optional convert to EURe.

## Deploy
Akash lease at zoldhq.com, chain `TRANSF_CHAIN_ID` (Base Sepolia today; its
dollar token is zUSD, see usd-token.ts).
`production` branch is built only by `scripts/build-production-branch.sh`.
