# Wallet tier

Linked from `docs/roadmap.md`.

Goal: anyone in a country Zold may serve gets the passkey Safe and every
crypto feature without KYC. Fiat rails (IBAN, SEPA, later USD and payout
corridors) keep the KYC of the partner that runs them. Monerium is the
identity for the EUR rail, not the gate in front of the whole app.

## The tiers

| Tier | Who | Gets | Identity |
|---|---|---|---|
| Wallet | `WALLET_ONLY`, `IN_COLLECTIONS`, and any account Monerium has not approved or has rejected | Safe, receive, hold, convert USDC→EURe, payment page, crypto payment requests, invoices, bookkeeping, recovery | none held by Zold |
| EUR account | `EU_FULL`, `ONCHAIN_NO_CARD` once Monerium approves | + IBAN, SEPA in and out, bank method on requests, holder letters | Monerium |
| Other rails | per partner, per residence | USD/GBP accounts (Iron), payouts (Yellow Card, dLocal) | that partner's own KYC |

Other rails are not engaged (`docs/roadmap.md` items 0–1).

## Who gets an account (`resolveSegment`, `domain/segments.ts`)

1. US person → `BLOCKED_US`. Owner decision: stays blocked.
2. Sanctioned residence or citizenship (`SANCTIONED`) → `BLOCKED_SANCTIONED`.
3. India → `IN_COLLECTIONS`: the wallet (`safe`, `onchain_balance`) plus
   collections, which stay gated on an Indian entity.
4. EU/EEA/GB/CH → `EU_FULL`; 5. other Monerium-servable → `ONCHAIN_NO_CARD`.
6. A residence in Monerium's table that it does not serve (Nigeria, Kenya,
   South Africa …) → `WALLET_ONLY`, unless it is on `WALLET_DENIED`
   (`domain/residency.ts`: MM, AF, LY, YE, VE, IQ, LB) → `BLOCKED_UNSUPPORTED`.
   The deny list is an owner decision of 2026-10-10, to be confirmed with
   counsel.
7. A code not in the table → `BLOCKED_UNSUPPORTED`.

## Gates

- **Wallet features** check the segment (`requireCapability(…,
  "onchain_balance")`, `walletBlocker` in `domain/wallet-tier.ts`) and the
  Safe (`safeDebitBlocker`). Never `kycStatus`: a pending, under-review or
  rejected account keeps the wallet. Deposit conversion and auto-convert are
  wallet features (user-signed swap from the user's own Safe, `feeAmount: 0n`).
- **Fiat features** keep `requireKycApproved`: `transfers/build.ts`,
  `routes/transfers.ts`, `POST /users/:id/privacy-bundle`. A SEPA quote also
  needs the `monerium` capability, so `WALLET_ONLY` and `IN_COLLECTIONS` are
  refused 403 before KYC is consulted.
- **The app** asks `bankOffered()` (`public/app/dashboard.js`): the segment
  has `monerium` and the account is not rejected. Without it, onboarding ends
  at the Safe (no Monerium step, no step counter), Home shows "Wallet" in
  place of the IBAN, Add money offers only the crypto wallet, Account details
  shows the wallet address, Send says bank sending is not available, and
  nothing asks the user to verify. A rejected account is told: our banking
  partner can't onboard you at the moment; you can keep using Zold as a
  wallet.
- There is no route that sends tokens to an arbitrary address or swaps
  between arbitrary tokens. The app's Send is SEPA only and says so.

## Business features without KYC

| Feature | Wallet tier | Notes |
|---|---|---|
| Crypto payment requests, payment page | yes | USDC to the page address |
| Auto-convert USDC→EURe | yes | the result is EURe in the Safe, never labelled a bank balance |
| Invoices, income invoices, bookkeeping, exports | yes | gated by org plan, not KYC |
| Bank method on requests, SEPA payouts, bulk payouts | no | need an IBAN |
| Balance confirmation, proof of ownership | no | Zold would vouch for an identity it never checked |
| Shopify | yes, merchant's own app | below; not built |

Every name an unverified account shows to a third party (invoice header, pay
page, checkout) must render as entered, never as verified — the rule
`holderVerified` already applies on the pay page. Not built for invoices and
checkout.

## Shopify: merchant's own app (not built)

`custom-app` mode (`routes/shopify.ts`) needs no Payments Apps approval but
runs on one Zold app, and custom distribution is one store per app. The
merchant creates the app in their own Shopify account and gives Zold its
credentials.

- HMAC checks (install callback, webhooks) and the token exchange
  (`shopify/admin.ts`) read the connection's secret, sealed through
  `stored-secrets.ts` as a new kind, instead of `SHOPIFY.apiSecret`.
- Webhooks resolve the connection by `x-shopify-shop-domain` and verify with
  that secret. No connection or no secret → refuse; never the global secret.
- The thank-you-page extension ships inside an app via the Shopify CLI, which
  a merchant cannot be asked to run. The pay link goes in the order
  confirmation email instead.
- Unverified: whether a merchant-created app yields a static Admin API token
  or only a client id and secret. Confirm on a dev store first.

## Open before mainnet

- **Gas.** Safe deployment and conversions are sponsored on Base Sepolia, for
  wallet accounts too. Before mainnet: `token` gas or a per-account cap for
  accounts without a fiat partner (sybil drain).
- **Address screening.** Needed before any outgoing op to a user-chosen
  address exists; none does yet. No answer from the screening source →
  refuse. Provider not chosen.
- **Zold fee on wallet-tier swaps and checkout.** Conversion has none. A fee
  on routing an anonymous user's swaps or merchant payments may make
  Zoldenburg a CASP under MiCA. Lawyer before any fee lands.
- **Merchant limits.** Volume cap for unverified merchants, or Shopify only
  after verification.
- **Mainnet.** On Base Sepolia the wallet is a test wallet and says so.

## Invariants that do not change

No debit without a passkey signature. The passkey is the Safe's only owner.
Fail closed. Nothing renders as real that has not moved real money. Collect
per call, store nothing: the wallet tier adds no identity fields.

## Remaining PRs on `x/wallet-tier*`

1. Gas policy for accounts without a fiat partner; address screening with the
   first send-to-address route.
2. Unverified-name rendering on invoices and checkout.
3. Shopify per-merchant credentials.
