![Zold](assets/readme-banner.png)

# Zold

**Global accounts for people and businesses whose money crosses borders.**
Built and operated by Zoldenburg.

A global account is a set of local accounts under one roof. Each one is
denominated in the currency of a place, carries the identifier locals use, and
pays out on that place's own rail. You hold them all in one smart wallet that
only you can operate, and you move between them at a live, visible rate.

**Euros are open today.** You get a euro IBAN. Money that arrives by bank
transfer is held as EURe, a regulated euro e-money token, in a wallet whose
keys are yours. From there you pay any bank account in the SEPA area, get paid
by link, page or invoice, take crypto and settle it in euros, and keep the
books.

The product documentation lives in [docs/gitbook](docs/gitbook/README.md).

---

## What you get

### An account that is yours

- **A real euro IBAN**, issued through Monerium, an e-money institution
  licensed in the European Economic Area. Bank transfers arrive as EURe,
  backed one-for-one and redeemable at par.
- **A smart wallet on Base** whose owner is a passkey on your device. Every
  payment is signed by you at the moment you send it. Zold cannot move your
  money without you and cannot replace your keys.
- **Recovery by email or phone.** Lose the device and you recover the wallet
  with a new passkey after a one-time code on every channel you registered,
  with a waiting period during which the rightful owner can cancel.
- **Prices before you sign.** Every transfer and conversion is quoted against
  a live mid-market rate. The fee and the measured margin are on screen before
  you approve, and the rate you approve is the rate you get. If Zold cannot get
  a fresh rate it refuses to quote rather than guess.

### Send money

- **SEPA bank transfer to any IBAN**, free of Zold fees, with a remittance
  reference the payee can reconcile on.
- **Tracking and receipts.** Every payment moves through named states you can
  watch, and every completed one has a receipt you can share by link, choosing
  which details the link exposes.
- **Pay from an invoice.** A supplier's invoice becomes a payment with the
  right amount, IBAN and reference already filled in.

### Get paid

- **Your payment page** at `/pay/<your handle>`: one address that takes USDC
  on most EVM networks and lands it in your wallet, with a QR code and an
  "open in wallet" link. Switch auto-convert on and incoming crypto is turned
  into euros with your passkey.
- **Payment links.** Ask for a fixed amount or let the payer choose, by crypto
  or by bank transfer with a reference that matches the payment to the link.
- **Invoice-Me links.** Send a supplier a link; they fill in their invoice and
  bank details, and you pay it from the same screen.
- **Statements and documents.** Account statements, transfer receipts, balance
  confirmations and proof of ownership, each printable to PDF and carrying a
  verification code anyone can check at `/v/<code>`.

### For businesses

- **Organisations, members and roles.** Owners, admins, payers and viewers,
  with an organisation that can never lose its last owner.
- **Payments that go through review.** A draft is prepared by one person and
  approved by another before it can be sent, and a payee whose bank details
  changed after approval is held rather than paid.
- **Bulk payments** from a file, executed as one batch, each line with its own
  signature.
- **Address book** with bank accounts and wallets, and imported wallets you
  hold elsewhere shown read-only beside your Zold accounts.
- **Invoicing that follows your country's rules.** German invoices are checked
  against the statutory mandatory details and VAT treatment; EU invoices follow
  the VAT Directive; everywhere else you set the rules and Zold prints them.
- **Bookkeeping**: transactions, tags, a chart of accounts with rules, cost
  basis, and CSV export for your accountant's software.
- **Shopify.** Offer Zold as a payment method on your store. A customer places
  the order, pays the USDC figure shown on the thank-you page, and the order is
  marked paid in Shopify the moment the payment is seen.
- **Gnosis Pay card.** Connect your own Gnosis Pay account and see your card,
  balances and card transactions inside Zold.
- **Privacy Bundle** for accounts that want less of their activity visible.

---

## Coming soon

| | |
|---|---|
| **Cash pickup** | Send euros, a relative collects local currency at a MoneyGram counter. |
| **US dollar account** | A US account and routing number that receives ACH and wire and pays out to any US bank. |
| **More currencies** | GBP, CHF, NGN and KES accounts, each on its own local rail. |
| **Shopify in-checkout** | Zold as a native payment method inside Shopify's checkout, with no pending order. |
| **Cards** | Spend your balance with a card issued for your Zold account. |

---

## How it works

```
   bank transfer ──► Monerium ──EURe──►  your Safe on Base  ◄──USDC── payment page
                                          passkey-owned              (any EVM network,
                                                │                     via forwarding)
                                    signed by you, per payment
                                                │
                     ┌──────────────────────────┼──────────────────────────┐
                     ▼                          ▼                          ▼
             SEPA to any IBAN         USDC ⇄ EURe conversion       statements, receipts,
           (Monerium redeem)         (best price across venues)    invoices, bookkeeping
```

- **Money is regulated money.** EURe is Monerium's e-money; USDC is Circle's
  fully reserved dollar. Your IBAN is a real IBAN, provided with Monerium
  through a licensed bank in the SEPA area.
- **The wallet is a Safe smart account**, deployed gas-free, owned by your
  passkey. Signing happens on your device with WebAuthn; the server verifies
  and never holds an owner key.
- **Conversions go to the best price.** Zold quotes every configured venue in
  parallel, settles at the best one, checks every price against an independent
  live mid before it binds, and records which venue won and why.
- **Deposits are forwarded.** The payment page address routes USDC from any
  supported EVM network into your wallet on Base.
- **Documents are verifiable.** Every statement and receipt is a signed
  snapshot; the verifier re-checks the signature and the chain on every visit.

---

## Security

- The passkey is the wallet owner. A payment needs your signature over its
  exact amount and destination, so a stolen session cannot change either.
- Secrets at rest are encrypted: Monerium tokens and API keys, Shopify store
  tokens. None of them ever appears in an API response.
- Rate limits and an origin allowlist on every authentication route, and a
  production readiness gate that refuses to start on an incomplete
  configuration.
- Recovery cannot be used to spend: a recovered credential gains control only
  after the waiting period the module enforces, and the previous owner can
  cancel during it.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the platform design, [INTEGRATORS.md](INTEGRATORS.md) for every external dependency and the credentials each one needs, [SECURITY.md](SECURITY.md) for the security policy.

---

## Run it

Node 22 or newer.

```sh
npm install
npm run check        # typecheck, contracts and every focused test suite
npm run api          # run against the configured chain (Base mainnet by default)
```

`/` is the landing page, `/app` the account, `/business` the organisation
dashboard, `/pay/<handle>` a payment page, `/invoice/<token>` an invoice,
`/r/<slug>` a shared receipt, `/v/<code>` a document verification.

Configuration lives in `.env`; `.env.example` documents every variable. Chain
selection is configuration: `TRANSF_CHAIN_ID` picks the chain and
`deployments.json` is keyed by it. The Shopify app project is in
[shopify-app](shopify-app/README.md).

```
services/api/src/
  server.ts              HTTP API, sessions, static UI
  orchestrator.ts        transfer state machines and compensation
  fx.ts  rates.ts        quoting against live mids
  liquidity.ts  dex.ts   venues and best-execution routing
  wallet/candide.ts      Safe deployment and signing
  documents.ts           statements, receipts, verification
  payment-requests.ts    payment links and attribution
  domain/                organisations, accounts, invoices, ledger
  routes/                orgs, business, documents, payment requests, shopify, recovery
  adapters/              monerium, crypto deposits, forwarding, gnosis pay
  public/                landing, app, business dashboard, invoice, pay pages
shopify-app/             Shopify app config and checkout extension
contracts/src/           AdminTimelock, FxSwapper, MockToken
docs/gitbook/            product documentation
scripts/                 deploy, operations, test suites
```

---

## Two names

**Zold** is the app. **Zoldenburg** is the company that builds and operates it.

## License

[Apache-2.0](LICENSE). Security policy in [SECURITY.md](SECURITY.md).
