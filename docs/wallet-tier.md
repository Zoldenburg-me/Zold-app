# Wallet tier — scope

Linked from `docs/roadmap.md`.

Goal: anyone in a country Zold may serve gets the passkey Safe and every
crypto feature without KYC. Fiat rails (IBAN, SEPA, later USD and payout
corridors) keep the KYC of the partner that runs them. Monerium stays the
identity for the EUR rail; it stops being the gate in front of the whole app.

Nothing here is built unless the PR list at the bottom says so.

## The tiers

| Tier | Who | Gets | Identity |
|---|---|---|---|
| Wallet | any residence not blocked by rules 1–2 of `resolveSegment` | Safe, receive, hold, convert USDC→EURe, payment page, crypto payment requests, invoices, bookkeeping, recovery | none held by Zold; address screening only |
| EUR account | where `moneriumWillServe` | + IBAN, SEPA in and out, bank method on requests, holder letters | Monerium |
| Other rails | per partner, per residence | USD/GBP accounts (Iron), payouts (Yellow Card, dLocal) | that partner's own KYC |

Other rails are not engaged (`docs/roadmap.md` items 0–1). The wallet tier
ships without them.

## How the gate works today

- `resolveSegment` (`domain/segments.ts`) decides a segment at signup. Rule 6,
  `BLOCKED_UNSUPPORTED`, refuses signup for every residence Monerium will not
  serve. `ONCHAIN_NO_CARD` and `EU_FULL` carry `safe` and `onchain_balance`.
- Every account starts `kycStatus: "pending"`; only an address-matched
  Monerium IBAN approves it.
- `requireKycApproved` (`http/guards.ts`) guards:
  - `transfers/build.ts` and `routes/transfers.ts` — the SEPA and cash rails.
    Correct as is: these are fiat rails.
  - `POST /users/:id/privacy-bundle`.
- The app hides send and fund cards behind `kycApproved()` and onboarding
  routes every pending account to the Monerium gate.
- There is no route that sends tokens to an arbitrary address or swaps between
  arbitrary tokens. "Crypto features" today means receive, hold, convert
  deposits, payment page, payment requests, recovery.

## The change

1. **A wallet segment.** Rule 6 returns `WALLET_ONLY` with capabilities
   `["safe", "onchain_balance"]` instead of refusing. Rules 1 (US person) and
   2 (sanctions) still refuse; that ordering does not move.
2. **Gate by feature, not by account.** Wallet features check the Safe
   (`safeDebitBlocker`) and the segment capability. Fiat features check that
   the rail's partner approved this account. `requireKycApproved` stays only
   on fiat routes. `kycStatus: "rejected"` and `"manual_review"` are refused
   everywhere until an owner decides otherwise.
3. **Onboarding has an exit before the Monerium gate.** After the Safe and
   recovery enrolment: "Use as a wallet" or "Add a bank account". A
   `WALLET_ONLY` account never sees the Monerium step. The app shows a
   control only where `capabilities()` says the API accepts it.
4. **Gas.** No unbounded sponsorship for unverified accounts (sybil drain).
   Either `token` gas (Safe pays USDC) or sponsorship with a per-account cap.
   Base mainnet: the public paymaster refuses it anyway.
5. **Address screening.** Before any outgoing op from an unverified account,
   screen the destination against a sanctions list. No answer from the
   screening source → refuse (fail closed). Provider not chosen.

## Business features without KYC

| Feature | Wallet tier | Notes |
|---|---|---|
| Crypto payment requests, payment page | yes | USDC to the page address; not KYC-gated |
| Auto-convert USDC→EURe | yes | user-signed, no fee leg (`feeAmount: 0n`); the result is EURe in the Safe, never labelled a bank balance |
| Invoices, income invoices, bookkeeping, exports | yes | gated by org plan (`requireCapability`), not KYC |
| Bank method on requests, SEPA payouts, bulk payouts | no | need an IBAN |
| Balance confirmation, proof of ownership | no | Zold would vouch for an identity it never checked |
| Shopify | yes, merchant's own app | below |

Every name an unverified account shows to a third party (invoice header, pay
page, checkout) renders as entered, never as verified — the same rule as
`holderVerified` on the pay page.

## Shopify: merchant's own app

`custom-app` mode (`routes/shopify.ts`) needs no Payments Apps approval but
runs on one Zold app, and custom distribution is one store per app. The
merchant creates the app in their own Shopify account and gives Zold its
credentials.

- Per-connection secret. HMAC checks (`routes/shopify.ts` install callback and
  webhooks) and the token exchange (`shopify/admin.ts`) use
  `SHOPIFY.apiSecret`. They read the connection's secret instead, sealed
  through `stored-secrets.ts` as a new kind.
- Webhooks resolve the connection by `x-shopify-shop-domain` and verify with
  that connection's secret. No connection or no secret → refuse; never the
  global secret.
- The thank-you-page extension ships inside an app via the Shopify CLI, which
  a merchant cannot be asked to run. The pay link goes in the order
  confirmation email instead.
- Unverified: whether a merchant-created app today yields a static Admin API
  token or only a client id and secret. Confirm on a dev store before building
  the connect screen.

## Owner decisions (before the PR that needs each)

- **Zold fee on wallet-tier swaps and checkout.** Conversion has none. A fee
  on routing an anonymous user's swaps or merchant payments may make
  Zoldenburg a CASP under MiCA. Lawyer before any fee lands.
- **Merchant limits.** Volume cap for unverified merchants, or Shopify only
  after verification.
- **US persons and India.** `BLOCKED_US` and `IN_COLLECTIONS` stay as they are
  unless decided otherwise.
- **Screening provider.**
- **Mainnet.** On Base Sepolia the wallet tier is a test wallet and says so.
  It is real only after an 8453 deployment.

## Invariants that do not change

No debit without a passkey signature. The passkey is the Safe's only owner.
Fail closed. Nothing renders as real that has not moved real money. Collect
per call, store nothing: the wallet tier adds no identity fields.

## PR order on `x/wallet-tier*`

1. This doc; deposit conversion and auto-convert for `pending` accounts
   (`walletBlocker` in `http/guards.ts`).
2. `WALLET_ONLY` segment, signup for unsupported residences, onboarding exit.
3. Gas policy and address screening for unverified accounts.
4. Unverified-name rendering on invoices, pay page, checkout.
5. Shopify per-merchant credentials.

Each user-visible PR gets its `zold-docs` PR.
