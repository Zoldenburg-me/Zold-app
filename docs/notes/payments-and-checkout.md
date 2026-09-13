# Payment links, Shopify, receipts and the card

Read before touching payment requests, the Shopify integrations, shareable receipts or Gnosis Pay.

*Moved verbatim out of CLAUDE.md (Sep 2026) when that file passed 2,100 lines.
The sections below are the original decision history, unedited. CLAUDE.md keeps
the invariants and links here for the reasoning.*

## Payment links + Shopify — the checkout, picked up again (Sep 2026)

`npm run paylinks:test` (70 checks: builders offline, then routes and the
crypto attribution on a hardhat chain) and `npm run shopify:test` (24 checks,
stub Shopify, no chain). Code: `payment-requests.ts` (domain, pure),
`routes/payment-requests.ts` (owner + payer routes, attribution hooks, sweep),
`shopify/{hmac,admin,types}.ts` + `routes/shopify.ts`, `public/pay-request.html`
(the payer's page at `/pay/<handle>/<code>`). UI: Profile -> Payment links in
the app; the Shopify view in `/business`. GitBook: get-paid/payment-links.md,
business/shopify.md.

WHERE THE OLD CHECKOUT STANDS. `tonyzil/pay-with-zold` (on disk
`zold-checkout`) is the merchant OAuth/PKCE handoff written in July against an
API that has since changed under it (RemitVault gone, execution assertions,
Monerium-only identity); its ADR 0001 already argued the checkout belongs on
the app origin. The "Revolut Pay with link" ask is answered HERE, in core, as
PAYMENT REQUESTS against the existing payment page, not by reviving that repo.
Its PKCE handoff remains the shape for a partner who needs a code exchange
(Mony), and nothing here replaces it.

A PAYMENT REQUEST is one ask against the payment page: an amount (or "payer
chooses"), a description, a 15-char Crockford code that IS the credential
(look-alikes folded on read), the ways to pay, and what arrived. Three ways,
each attributed differently, and the difference is the whole design:
 - crypto: USDC to the page's ONE address, so attribution is BY AMOUNT. Every
   open request quotes a USDC figure unique among that payee's open quotes
   (nudged by a micro-unit on collision); a deposit matches the closest quote,
   full beats partial beats over, ties to the older request. Over 10% above a
   quote is NOT that payment (it would swallow the short payment of a bigger
   request — the test that found this had a 60% partial booked as an
   over-payment of a tip jar). Below 20% of a quote is not attributed either.
   Every quote ever shown stays valid; quotes issued AFTER the money arrived
   cannot be what the payer saw and are skipped.
 - bank: SEPA to the payee's IBAN with the code as reference; matched from the
   Monerium issue order's memo (hooked into pollDepositsOnce, idempotent on
   order id). Our OWN PAID payouts carrying the code are matched by the sweep,
   and Monerium's view of that same credit MERGES onto the row (amount within
   a cent inside a day, as documents.ts does) instead of doubling it.
 - zold: not a rail. "Open in Zold" is `/app?pay=<handle>/<code>`, which enters
   the SEPA send flow with IBAN, amount and reference filled in — the same
   money as `bank`, without typing. There is still no on-chain Zold-to-Zold
   transfer; the page says so rather than implying one.

RULES THAT CARRY WEIGHT:
 - The page address is watched while a crypto request is OPEN whatever
   `autoConvert` says — a paid link on a forwarder address was otherwise never
   seen. And auto-convert OFF now settles a page deposit as USDC (the forwarder
   already delivered it; nothing converts it) instead of REFUSING with
   "auto-settlement switched off", which read as a fault to a payee whose link
   had just been paid. convert-deposit-test's expectation was changed to match.
 - `settledEur`/`settledAsset` on a payment say what the payee HOLDS. A crypto
   payment is PAID for the merchant the moment the deposit is attributed, and
   settles in EUR only when the user-signed conversion runs; the two are
   separate fields so neither is overstated.
 - The public projection is an allowlist. A crypto-only link leaks no IBAN,
   legal name, email, id or KYC state (test greps the JSON). A link offering
   bank transfer DOES carry the IBAN and the account holder's legal name — a
   SEPA transfer cannot be made without them and Verification of Payee compares
   the name — and the owner chose to offer it; the doc says so.
 - The code under someone else's handle is a 404: a code pasted under another
   handle must not make a page impersonate a payee. `/api/pay/<h>/<code>` is on
   the tight rate bucket like `/r/` and `/v/`.
 - No delete on requests. Cancel only while unpaid; a paid one is a record.
 - The crypto figure = live mid × (1 + 50 bps allowance), rounded UP to the
   micro-unit; the allowance is printed on the page and stored on the quote,
   never folded into the number. midRates() unavailable => the request is still
   created, and the page says crypto cannot be quoted right now.

SHOPIFY is a payments app ("offsite" flow) riding on the same requests:
session POST (HMAC over the RAW body, key = app secret) -> a crypto-only
request for the session's EUR amount, one hour, `test` carried -> 201 with the
page as redirect_url (Shopify retries; the same id gets the same page) ->
paid hook calls paymentSessionResolve on the store's Payments Apps API ->
Shopify's nextAction.redirectUrl is stored as returnUrl and the page's "Return
to the store" goes through `/api/shopify/return/<code>`. Install is OAuth from
the business dashboard (state nonce in memory, query HMAC checked, token
encrypted with purpose `shopify`, paymentsAppConfigure ready:true; the payee
is the org's EUR account's backingUserId else the installer, and must have a
payment page). REFUSED, each with a merchant-readable message through the
mutation: non-EUR (422), kind=authorization (422 + paymentSessionReject),
refund/capture/void (201 ack, then the matching *SessionReject — refunds are
manual because the sending address is often an exchange's, not the buyer's).
A failed resolve is recorded on the request and retried by the sweep.

NOT PROVEN, and the surface looks more finished than it is: no Shopify app is
registered — a payments app must be approved into Shopify's Payments Apps
program in the Partner Dashboard before any store can install it, and nobody
has started that; the GraphQL shapes are from their docs, exercised only
against the stub. SHOPIFY_API_KEY unset => `/api/health` capabilities.shopify
is false and the dashboard says why. No real bank-transfer attribution has run
(needs a Monerium production connection and a real memo). The `?pay=` deep link
only fires for an already signed-in, approved user. The payer page was checked
against fixture payloads in a browser, not against a live request.

## Shopify custom-app mode — the path that needs no approval (Sep 2026)

`npm run shopify:orders:test` (20 checks, stub Shopify Admin API, no chain).
`SHOPIFY_MODE` in config.ts selects the shape; `custom-app` is the DEFAULT
because it is the only one a store can install today. The payments-app suite
pins `SHOPIFY_MODE=payments-app` explicitly.

WHY IT EXISTS: a Keycard founder's email (Sep 2026) named the real wall —
Shopify's approved-provider list (Coinbase Commerce was dropped from it), and
weeks-to-months KYB with every crypto PSP on it, because a PSP is a
counterparty holding the merchant's money. Our payments-app router is queued
behind that same list, and Shopify vets a payments app's regulatory standing;
Zoldenburg holds no MiCA transfer licence, so that approval is UNCERTAIN, not
merely slow. The custom-app path sidesteps both: a custom-distribution app is
installed on one store with no Shopify review, and a Zold payment page needs
only an active passkey Safe (server.ts /api/users/:id/handle), so a merchant
who keeps USDC hands nobody a passport. Monerium's KYB enters only for euros.

THE SHAPE: the store offers a MANUAL payment method whose name contains
`SHOPIFY_MANUAL_GATEWAY` ("zold"); orders/create (HMAC over the raw body, same
header as the session webhooks) opens a crypto-only payment request sized
from `total_price` with `source.orderGid`/`orderName`/`orderStatusUrl`; the
thank-you page extension in `shopify-app/` polls
`GET /api/shopify/orders/<shop>/<order id>` (CORS-open, the same allowlisted
projection as the pay page, 404 `pending:true` while the webhook is in
flight); the attributed deposit runs `orderMarkAsPaid` through the ADMIN API
(`adminGraphql`, `/admin/api/<v>/graphql.json` — not the payments_apps
endpoint) and writes a `zold.payment` JSON metafield best-effort. Install in
this mode subscribes ORDERS_CREATE + ORDERS_CANCELLED itself; disconnect
deletes the subscription.

RULES, each with a check:
 - A WEBHOOK IS ALWAYS 200. Shopify retries a failing delivery for two days
   and then drops the subscription, so an order we ignore (other gateway, not
   pending, non-EUR, no payment page) is acknowledged with `ignored`, never
   refused. Only a forged signature (401) or an unconnected store (404) fails.
 - THE ORDER GID IS THE IDEMPOTENCY KEY (`source.externalId`). A redelivery
   opens nothing; a TOML-declared duplicate subscription is therefore harmless.
 - THE SHOP IN THE LOOKUP URL MUST MATCH THE ORDER'S SHOP, or a page could be
   made to show one store's order under another's name.
 - A REINSTALL KEEPS THE SUBSCRIPTION ID. Shopify answers "address for this
   topic has already been taken" with no id; the first cut overwrote the
   stored id with undefined and disconnect then deleted nothing.
 - orders/cancelled closes an UNPAID request only.
 - `SHOPIFY_ORDER_TTL_MS` (24h default) is longer than the 1h checkout
   session because a manual-payment order waits for the buyer; after it a
   deposit lands on the page unattributed and the merchant marks by hand.

THE ONE THING THE MODE CANNOT HIDE: the order exists before the money does
(inventory held, abandoned pending orders). The dashboard and the GitBook
page say so. Payment customization functions and an admin order block are
the next steps if the thank-you block proves out; neither is built.

PARKED (Sep 2026, user's call) — PRIVACY OF THE MERCHANT'S BOOK. One Safe per
account means anyone who ever paid a merchant can open that address in an
explorer and read every incoming payment, the EURe balance and every SEPA
burn. Per-order forwarding addresses do NOT fix it (they forward into the
same Safe one hop later). The acceptable fix is stealth Safes — a fresh Safe
with a fresh derived owner per payment, never consolidated on chain, each
converting and redeeming to the IBAN on its own (Fluidkey runs this shape on
Base; their bank leg is Bridge/EURC, ours would be Monerium). It is weeks of
work, needs a PRF-derived key tree with its own backup path (Candide guardian
recovery restores the passkey Safe, not derived keys) and Monerium multi-
address linking exercised. Custodial omnibus and mixers were both rejected.
DO NOT put the current Shopify path in front of a privacy-sensitive merchant
(Keycard) until this exists; everything built here sits above the address
layer and survives unchanged when the address becomes fresh per order.

NOT PROVEN: `shopify-app/` (app TOML + React checkout UI extension, targets
purchase.thank-you.block.render and customer-account.order-status.block.render,
`network_access = true`, an `api_base` setting) has NOT been built with the
Shopify CLI or run in a real checkout — package versions and the
`api.orderConfirmation` / `api.order` names are from the docs, not a run. No
real store has installed the app. The GitBook page presents the manual-method
path as live and the in-checkout method as not yet available.

## Pay with Zold — moved to its own repo (July 2026)
The merchant checkout / "Pay with Zold" product was extracted to
**github.com/tonyzil/pay-with-zold** (private; the directory on disk is
`zold-checkout`) to keep this consumer app lean. The backend OAuth handoff +
existing-user checkout that briefly lived here (checkout.ts, checkout.html,
checkout-test.ts, the /api/checkout/* routes, and store Merchant/PaymentIntent)
were REMOVED from this repo. Do not rebuild them here.
That repo OWNS the authorization-server half — merchant registry, payment
intents, PKCE code exchange — plus the new-user onboard-in-flow (account -> KYC
-> device key -> funding -> device-signed SEPA -> merchant code). It is a
CLIENT of this API: an allowlisted proxy, source of truth for nothing but
merchants and intents. It runs on its own origin because passkeys are
RP-ID-scoped and the FP4 device key lives in one origin's localStorage, so a
user onboarded there has both halves in one place.
SEPA remittance reference (July 2026): POST /api/transfers takes an optional
`reference` on the sepa rail and it rides on the payment, so a payee reconciles
against their own handle instead of our uuid. Without one the line reads
`Powered by Zold <transfer.id>` (Sep 2026: the tag was "Zold"). A bare id meant
a merchant could see that Zold sent money but not which
of their users it was for, which is the manual step the checkout exists to
remove. services/api/src/sepa.ts folds it into the SEPA Latin subset (accents
decomposed, so "Müller" arrives as "Muller" not "M ller"), strips the reserved
slash forms, and truncates the REFERENCE rather than our id — half an id
identifies nothing. 140 chars is the scheme limit and the route refuses a
longer one rather than silently shortening the string the payee reconciles on.
npm run sepa:test (12 checks, no chain). NOT proven end to end: the redeem call
only runs in Monerium sandbox mode, so the memo has never reached a real
statement.
WHAT THIS API STILL OWES IT:
- RP_ID + WEBAUTHN_ORIGINS must cover the checkout origin or every passkey
  ceremony started there is rejected HERE, which reads like a client bug.
  Production: RP_ID=zold.app with app.zold.app + checkout.zold.app both listed.
  Locally: RP_ID=localhost and WEBAUTHN_ORIGINS including localhost:3100.
- No way for it to see a transfer reach a terminal state. It reads the transfer
  with the USER's session at attach time, so the intent's status freezes there
  and the merchant polls after the user has gone — on a real SEPA payout an
  intent would sit at AUTHORIZED forever. Needs a checkout webhook from here,
  or a service credential that can read a transfer without a user session.
  Not visible locally: hardhat settles to PAID before attach.
- public/device.js keeps ONE key slot per origin, not per user. On a shared
  browser a second person onboarding binds the FIRST person's key as their
  authorizer, and either could then spend the other's balance. The checkout
  refuses rather than sharing a key; the real fix is a per-account slot here.
- KYC ordering is fixed by us, not by them: /api/users/:id/authorizer calls
  requireKycApproved, so KYC must precede the device key. Any handoff doc that
  says otherwise is describing an order the API will refuse.
Two bugs the deleted checkout.html had are recorded in that repo's README so
they are not reintroduced: it loaded /device.js with no import map (the
vendored noble modules import the bare specifiers `crypto` and
`@noble/hashes/crypto`, so the module never loaded and signing hung), and it
built the attach URL from `intent.id` where the API returns `intentId` — the
payment cleared on-chain and the merchant was never told. Neither was visible
to checkout-test.ts, which drove the backend directly.
## Shareable receipts — /r/:slug (Aug 2026)

DESIGN SOURCE: `~/Downloads/Zold Mobile Dashboard Redesign.zip`. The filename
lies — the bundle inside is `design_handoff_receipt_share`, "Zold Receipt Share
— Public Tracking Page", not the mobile dashboard. Its README is a real spec.

WHAT SHIPPED: a sender opens "Share receipt" from transaction detail, picks what
the link exposes, and copies `/r/<slug>`. A recipient opens it with no account.
`services/api/src/receipt.ts` builds the payload, `public/receipt.html` renders
it, `store.receiptShares` holds the selections. npm run receipt:test (20 checks,
no chain, wired into check.ts).

THE LOAD-BEARING PROPERTY, and what the test actually proves: redaction happens
server-side. A withheld field is never in the JSON — the test serialises the
whole payload and greps it for each secret, because "the page does not draw it"
and "the page was not sent it" are different guarantees and only the second one
survives someone opening devtools. Withheld fields come back as
`{withheld:true}` with no value, so the page can still draw the ▒ block the
design asks for without ever holding the thing.

FOUR PLACES THE DESIGN WAS NOT FOLLOWED, deliberately:
 - THE SLUG. The mock prints `zold.to/r/8842-1170` — eight decimal digits, 10^8,
   enumerable in hours, and every hit is a real name and amount on an
   unauthenticated page. Kept the grouped shape, widened to 15 Crockford base32
   chars (~75 bits), ambiguous glyphs excluded. `/api/r/` is also bucketed with
   the auth rate limits, since guessing a slug is guessing a credential.
 - THE SIX ROUTE HOPS. The design draws a fixed Zold Safe → Base → Monerium →
   SEPA Instant → Stellar/MYKOBO → MoneyGram route with a hardcoded block
   number. That is not this codebase: MYKOBO appears nowhere, the SEPA rail has
   no Stellar leg at all, the swap goes through whichever liquidity venue won,
   and no block/finality data is stored. Hops are derived per rail from `txs`,
   `liquidity`, `sepa` and `pickup`; a leg that did not run is not drawn, and a
   leg that ran in simulation (CCTP dry-run, mock SEPA) carries `simulated` and
   renders an amber badge. The Base mark only appears when CHAIN_ID really is
   Base — otherwise the hop shows a step number.
 - "REFERENCE & PURPOSE". There is no purpose field on a Transfer. The toggle
   governs the SEPA remittance `reference`, and is labelled for it.
 - TOKENS. The public page uses the receipt handoff's own palette (#ed188d,
   #050506); the in-app composer uses the APP's (--m-pink #ff2d8b). The composer
   sits between Activity and detail and would clash with every screen beside it
   in a second pink. This is not a reopening of the settled token question — it
   is one surface with its own spec versus one inside the app.

ALSO DECIDED: one share per transfer (re-posting edits it, so narrowing a
selection narrows the live link rather than leaving a generous older one alive);
editing does NOT extend the 30-day expiry; revoking keeps the slug recorded so a
holder is told "revoked" rather than getting a typo's 404; a share is refused
while the transfer is still CREATED, because nothing has moved yet.

The in-app composer is a full screen, not the handoff's side-by-side card and
live 520px page preview — 412px cannot hold both, and a shrunken unreadable copy
answers none of the question the composer asks. The preview is a list of each
field and whether it survives.

HOW FAR IT WAS VERIFIED: the payload builder is unit-tested (20 checks incl. the
leak sweeps) and the page was driven in a browser against real buildReceipt()
output for the full / fully-redacted / SEPA / in-flight / revoked / expired
cases. The Express routes and the composer's POST/DELETE were NOT booted — see
the toolchain note below.

!! TOOLCHAIN: `.toolchain/node-v22.17.0-darwin-arm64` IS THE WRONG ARCH for the
machine this ran on (Intel x86_64 — `arch` says i386, and `arch -arm64` reports
"Unknown architecture"). So `npm run dev/api/<anything>:test` all fail with
"Bad CPU type in executable", and node_modules holds an arm64 esbuild, so tsx
dies too. There IS a system node now (nvm v24.13.0, x86_64) — the "machine has
no system Node" line in Environment above is stale. `npm run typecheck` works
(tsc is pure JS); to run a test, compile it with `npx tsc --outDir <tmp>` and
run the emitted JS with the system node.

## Gnosis Pay — connected card, PR 1 shipped (Aug 2026)

`npm run gnosispay:test` (13 checks, stub, offline). Design + corrections:
`docs/gnosis-pay-permissionless-integration.md`.

WHAT IT IS: the user connects their OWN Gnosis Pay account by SIWE and Zold
shows cards, balances and card transactions. Gnosis Pay issues the card, holds
its KYC and owns the card Safe. Permissionless mode has NO webhooks and NO
attribution of card activity back to Zold, so nothing may be presented as a
Zold card — the provenance line is rendered on every state, including errors.

TWO API DETAILS THE DESIGN DOC HAD WRONG, both silently fatal, both found by
reading the live OpenAPI spec and calling the endpoint rather than trusting the
transcription — and both now asserted in the test:
 - `GET /auth/nonce` returns **text/plain**, not JSON.
 - It **sets a `siwe` cookie** that `POST /auth/challenge` verifies against.
   Drop it and every signature is rejected as if the user signed wrong.
Also: `/account-balances` returns decimal strings of MINOR UNITS (`^[0-9]+$`),
kept as strings end to end; and the `Event` schema behind `/transactions`
declares no properties, so items are passed through as opaque.

DECISIONS THAT CARRY WEIGHT:
 - **The JWT is never persisted, not even in localStorage.** It is a bearer
   credential for a third party's financial account; the browser holds it in
   memory and sends `x-gnosis-pay-token`, the API forwards and forgets. A
   reload means signing in again and the screen says so.
 - **A Gnosis Pay 401 is returned as 409.** Passing it through would make the
   browser log the user out of ZOLD because someone else's token expired.
 - **Stored status is shown when signed out; a stored BALANCE never is.** There
   is nothing pushing updates, so every figure carries `asOf` and is labelled a
   snapshot.
 - **The signer is the user's own browser wallet**, not the Zold passkey Safe:
   EIP-1271 is only verifiable where the contract is deployed, and the Zold Safe
   is not on chain 100.

CHAIN FACTS, VERIFIED not assumed (scripts were throwaway; re-run before
relying on them): Gnosis Chain (100) HAS the RIP-7212 P256 precompile — probed
with a real generated P-256 signature, valid returns 1 and a tampered r returns
empty, same as Base Sepolia — and Candide's bundler/paymaster cover chain 100.
So a passkey Safe on Gnosis is possible and is the natural next step; it was NOT
the blocker it was assumed to be.

NOT BUILT, deliberately (PRs 2-4 in the doc): signup, terms, KYC, phone OTP,
Safe deploy, card creation, and ALL funding. NOT PROVEN: no real Gnosis Pay
account has been connected.

SCOPE NOTE: "make everything Gnosis Pay compatible" was scoped to the adapter
only. Moving Zold to Gnosis Chain was considered and NOT done, and the REASON
was corrected once: it is not CCTP. CCTP is the dry-run alternative that has
never executed live; Bridge.xyz is the live seam (BRIDGE.sourceRail = "base").
The real reason is that **Bridge does not support Gnosis Chain either** —
checked against their payment-routes table, which lists Arbitrum, Avalanche,
Base, Celo, Ethereum, HyperEVM, Linea, Monad, Optimism, Polygon, Solana,
Stellar, Sui, Tempo, Tron, World Chain, XDC and Aptos, and no Gnosis at all.
On Gnosis the cash rail would have NO exit. The current Base -> Stellar route
with USDC at both ends is squarely on their supported set.

AND THE MIGRATION IS NOT NEEDED FOR THE CARD ANYWAY. Gnosis Pay's card Safe is
theirs, on chain 100, whatever chain Zold runs on. Only two things want Zold on
Gnosis: the passkey Safe signing SIWE by EIP-1271 (needs it deployed on 100 —
RIP-7212 is live there, so it works), and funding the Gnosis Pay Safe from Zold
(needs EURe on 100 — Monerium issues it there). Both are satisfied by deploying
the user Safe on Gnosis IN ADDITION, with the corridor left on Base. EURe
exists on both and LI.FI covers Gnosis, so card funding is a user-signed
Base->Gnosis EURe bridge. That is the shape to build, not a migration.

BRIDGE + EEA, worth knowing before designing any USDT path: their docs state
"USDC & EURC are the only stablecoins supported for users in the EEA" — MiCA,
applied by them. Zoldenburg UG is an EEA entity, so Bridge CANNOT handle USDT
for us. USDT would have to be swapped to USDC before Bridge sees it, and that
swap is the MiCA exchange service, not an integration detail.

