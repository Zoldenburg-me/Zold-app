![Zold](assets/readme-banner.png)

# Zold

A self-custodial euro account for people and businesses whose money crosses
borders. Built and operated by Zoldenburg.

You get a euro IBAN through Monerium. Bank transfers arrive as EURe (Monerium's
regulated euro e-money token) in a Safe smart account on Base whose owner is a
passkey on your device, and that passkey is its only owner. Every payment is a
user operation you sign at send time; the server can prepare a debit but holds
no key that can make or block one.

Product documentation for users: [docs/gitbook](docs/gitbook/README.md).

## Status

| | |
|---|---|
| **Open** | Euro IBAN (Monerium OAuth or your own Monerium API keys), SEPA payouts via Monerium redeem (no Zold fee), USDC ⇄ EURe conversion, payment page, payment links, Invoice-Me links, receipts, verifiable documents, business organisations with four-eyes drafts, invoicing, bookkeeping, Gnosis Pay card view |
| **Not built** | International payouts (the Pay hub tile reads SOON until a payout partner is contracted), USD account, other currencies, own card, Shopify in-checkout payment method |
| **Never run on real money** | No mainnet deploy, no executed swap, no registered Monerium production OAuth app, no Shopify app install, no Candide recovery call, no mail transport |

The running deployment is Base Sepolia (84532). The default chain is Base
mainnet (8453), which has no entry in `deployments.json` yet.

## Architecture

```
                      ┌──────────── browser ────────────┐
                      │ /app  /business  /pay  /r  /v   │  passkey (WebAuthn)
                      └───────────────┬─────────────────┘  signs every userOp
                                      │ HTTPS
┌─────────────────────────────────────▼──────────────────────────────────────┐
│ server.ts  wiring + authentication                                          │
│   http/        origin policy, rate buckets, sessions, guards                │
│   routes/      one router factory per subject, handed requireUserSession    │
├────────────────────────────────────────────────────────────────────────────┤
│ transfers/build.ts   the ONE path that creates a transfer                   │
│ orchestrator.ts      transfer state machine, compensation, sweeps           │
│ fx.ts  rates.ts      quotes; live mid that every venue quote must meet      │
│ liquidity.ts         venue seam → liquidity/{lifi,rfq,uniswap,cow,best,…}  │
│ domain/              orgs, roles, plans, drafts, invoices, ledger (no I/O)  │
│ store.ts             the only code that touches the database               │
├────────────────────────────────────────────────────────────────────────────┤
│ wallet/     Candide Safe (ERC-4337, bundler + paymaster)                    │
│ adapters/   Monerium, Gnosis Pay, crypto deposits, forwarder                │
│ shopify/  recovery/                                                         │
└──────┬──────────────────┬──────────────────┬───────────────────────────────┘
       ▼                  ▼                  ▼
   Base (Safe,        Monerium          FX venues
   EURe, USDC)     (IBAN, redeem)    (LI.FI, Bebop, …)
```

### How a SEPA payment flows

1. `POST /api/quotes` prices the payment (`fx.ts`). SEPA is EUR to EUR: no FX
   leg, a fixed fee (€0), and a short expiry.
2. `POST /api/transfers` calls `transfers/build.ts`, which prepares the Safe
   user operation that *is* the debit. Its token, amount and destination are
   fixed in the hash.
3. The browser signs that hash with the passkey. The chain enforces what was
   signed.
4. `orchestrator.ts` submits the userOp and redeems EURe to the IBAN through
   Monerium, recording each state and tx hash. A 4xx refusal refunds; a timeout
   or anything ambiguous goes to `MANUAL_REVIEW`.

Converting an inbound USDC deposit to EURe inside the Safe is the only thing
that uses a venue; `liquidity.ts` picks it:
every venue's quote is checked against the independent mid, venue calldata is
allowlisted, and the amount received is measured as a balance delta.

### Directory map

```
services/api/src/
  server.ts            wiring and authentication (~350 lines)
  config.ts            every setting and every production refusal
  capabilities.ts      what /api/health tells the UI it may offer
  orchestrator.ts      transfer state machine and compensation (the money path)
  fx.ts  rates.ts      quoting and live mid-rates
  liquidity.ts         venue seam; one venue per file in liquidity/
  store.ts             data access; row shapes in store/types.ts, file db in store/db.ts
  http/                policy.ts, sessions.ts, guards.ts, pending.ts
  routes/              auth, users, transfers, monerium, orgs, business/, documents,
                       payment-requests, payment-page, receipt-shares, shopify,
                       gnosis-pay, crypto-deposits, recovery-*, admin, pages
  transfers/build.ts   builds a transfer from a quote (direct send and draft execution)
  domain/              plans, roles, drafts, invoices, invoicing, jurisdictions, ledger, coa
  wallet/              Candide Safe deployment, signing, passkey Safe plan
  adapters/            monerium-*, gnosis-pay, crypto-deposits, candide-forwarder
  shopify/  recovery/  merchant and guardian integrations
  documents.ts  receipt.ts  reconcile.ts  webauthn.ts  crypto-at-rest.ts

services/api/public/
  index.html + app/*.js       the account app (/app): classic scripts sharing one scope;
                              main.js loads last and holds everything that awaits then renders
  business.html + business/   organisation dashboard (/business): ES modules, core.js owns state
  landing, pay, pay-request, invoice, receipt, document, admin pages
  sw.js                       service worker (page code network-first)

contracts/src/        FxSwapper, AdminTimelock, MockToken (local hardhat fixtures only)
shopify-app/          Shopify app config and checkout extension
scripts/              deploy, dev chain, operations, and every test suite
docs/                 design docs, architecture, and the GitBook user guide
```

### Rules the code depends on

- **No debit without a user signature, and no Zold key on the Safe.** The
  passkey is the only owner and signs every user operation. There is no
  allowance. (Safes deployed earlier as 2-of-2 with a Zold co-signer keep
  working until their user removes it from Settings.)
- **Fail closed.** No rate, no quote; no venue, no trade; no Monerium
  connection, no SEPA send.
- **Nothing is shown as real that has not moved real money.** Closed rails are
  hidden or labelled, never simulated.
- **Three authority checks**: session (who), member and role (may they, here),
  plan capability (did the org buy it). A draft's reviewer may not be its
  drafter.
- **Nothing deletes an org, account, invoice or ledger row.** Gating is a
  read-time filter.
- **Public projections are allowlists**, redacted on the server.

Platform design: [ARCHITECTURE.md](ARCHITECTURE.md). External dependencies and their
credentials: [INTEGRATORS.md](INTEGRATORS.md).

## Run it

Node 22 or newer.

```sh
npm install
cp .env.example .env    # every variable is documented there
npm run check           # typecheck, contracts and every offline test suite
```

| | `npm run dev` | `npm run api` |
|---|---|---|
| chain | local hardhat (31337) | `TRANSF_CHAIN_ID` (default 8453) |
| database | `data/db.dev.json`, wiped every start | `data/db.json`, kept |
| passkey Safe deploy | not possible (no bundler/paymaster) | works |

Sending a payment end to end needs `npm run api` against Base Sepolia with a
funded, deployed Safe. Before `npm run api` on a new chain, run
`npm run deploy` with real operator keys.

Pages: `/` landing, `/app` account, `/business` organisations,
`/pay/<handle>` payment page, `/invoice/<token>` invoice, `/r/<slug>` shared
receipt, `/v/<code>` document verification.

### Tests

`npm run check` is offline and is the one to run. Each suite also runs alone (`npm run fx:test`,
`npm run business:test`, …); [TESTING.md](TESTING.md) covers manual end-to-end testing.

## Names

**Zold** is the app. **Zoldenburg** is the company.

## License

[Apache-2.0](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
