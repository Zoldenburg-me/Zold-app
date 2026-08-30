# Gnosis Pay Permissionless Integration

## Read This First

Gnosis Pay's permissionless API is a good fit for a user-owned card companion
inside Zold. It is not a branded Zold card program, and it does not give Zold
partner observability.

The useful product shape is:

- The user signs into Gnosis Pay with their own wallet or smart account.
- Gnosis Pay owns the card/KYC/card-Safe lifecycle.
- Zold shows status, card metadata, balances, and transactions after the user
  has an active Gnosis Pay session.
- Real card funding is an explicit money-movement feature and should be built
  after authentication and onboarding are stable.

## Sources Checked

- Documentation index: https://docs.gnosispay.com/llms.txt
- Integration models: https://docs.gnosispay.com/integration-model
- SIWE authentication: https://docs.gnosispay.com/auth
- User onboarding: https://docs.gnosispay.com/onboarding-flow
- Gnosis Pay account/Safe model: https://docs.gnosispay.com/account
- On-chain integration overview: https://docs.gnosispay.com/gp-onchain/overview
- Virtual cards: https://docs.gnosispay.com/cards/create-virtual-cards
- IBAN integration: https://docs.gnosispay.com/on-off-ramps/iban-integration
- API reference: https://api.gnosispay.com/api-docs/spec.json

## Corrections To This Document (Aug 2026, found while building PR 1)

Two details below were transcribed wrongly and both are silently fatal — they
fail in ways that read as a Zold signing bug rather than a wrong request. Found
by reading the live OpenAPI spec at
`https://api.gnosispay.com/api-docs/spec.json` and calling the endpoint.

 - `GET /api/v1/auth/nonce` returns **`text/plain`**, not JSON. Parsing it as
   JSON throws on a perfectly good response.
 - That same response **sets a `siwe` cookie**, and `POST /auth/challenge`
   verifies the signature against it. Fetch the nonce server-side without
   carrying the cookie forward and every signature is rejected as invalid.

Endpoint names that differ from the list below, per the live spec: phone
verification is `POST /api/v1/verification` and `/verification/check` (not a
`sendPhoneOtp`/`verifyPhoneOtp` pair); Safe deploy status is
`GET /api/v1/safe/deploy`; terms are at both `GET /api/v1/terms` and
`GET|POST /api/v1/user/terms`.

Also worth knowing before building on the shapes: `GET /account-balances`
returns **decimal strings of minor units** (`^[0-9]+$`), not numbers, and the
`Event` schema behind `GET /transactions` declares **no properties at all**, so
transaction items are genuinely opaque and should be passed through rather than
typed.

## Permissionless Capabilities

Permissionless integration needs no API key. The user authenticates with
Sign-In with Ethereum and Gnosis Pay returns a JWT for API calls.

The permissionless flow supports:

- Requesting a nonce with `GET /api/v1/auth/nonce`.
- Verifying a SIWE signature with `POST /api/v1/auth/challenge`.
- Creating a Gnosis Pay user with `POST /api/v1/auth/signup`.
- Reading the user profile with `GET /api/v1/user`.
- Accepting terms with `GET /api/v1/user/terms` and `POST /api/v1/user/terms`.
- Running Gnosis Pay's Sumsub KYC integration.
- Answering source-of-funds questions.
- Phone verification by OTP.
- Deploying and checking the Gnosis Pay Safe.
- Creating free virtual cards.
- Reading cards, account balances, and card transactions while the user has a
  valid session.
- Requesting Gnosis Pay's Monerium IBAN integration where the user is eligible.

## Permissionless Limits

Do not design around features that only exist in partner mode:

- No Gnosis Pay webhooks.
- No reliable attribution of card activity back to Zold.
- No branded card program.
- No sensitive card details/PAN display.
- No Partner Secure Element.
- No production-scale partner support or observability guarantees.

For Zold, permissionless should be treated as a user-connected card account,
not as Zold issuing or operating the card program.

## Account Model Fit

Gnosis Pay uses a Gnosis Pay Safe on Gnosis Chain. The Safe remains
self-custodied and is controlled by its owners. A Safe owner can be an EOA or
another smart wallet. Authenticated wallets are used for API sessions and may
also become Safe owners during setup.

That lines up with Zold's passkey-Safe direction, but there is a chain
constraint:

- Gnosis Pay's account and card Safe lives on Gnosis Chain.
- The IBAN docs explicitly call out chain id `100`.
- Zold's current passkey Safe code can produce EIP-1271 Safe signatures, but
  the contract account must be deployed on the chain where Gnosis Pay verifies
  it.

If Zold's main Safe is deployed on another chain for a test environment, a
passkey-Safe SIWE flow for Gnosis Pay should either deploy the same passkey
Safe on Gnosis Chain or fall back to an external wallet SIWE flow for the first
MVP.

## Recommended Zold Integration

Add a small Gnosis Pay adapter and keep Gnosis Pay session state separate from
Zold payment state.

Proposed user state:

```ts
gnosisPay?: {
  connectedAddress: `0x${string}`;
  userId?: string;
  safeAddress?: `0x${string}`;
  safeStatus?: "not_deployed" | "processing" | "ok" | "failed";
  kycStatus?: string;
  cardIds?: string[];
  tokenExpiresAt?: string;
  updatedAt: string;
}
```

Do not store sensitive card details. Avoid storing the Gnosis Pay JWT unless
there is a clear product need; if it is stored server-side, encrypt it and
respect the documented maximum token lifetime.

## API Adapter

Add `services/api/src/adapters/gnosis-pay.ts` with:

- `getNonce()`
- `verifySiwe(message, signature, ttlInSeconds)`
- `signup(authEmail, partnerId?)`
- `getUser(jwt)`
- `getTerms(jwt)`
- `acceptTerm(jwt, terms, version)`
- `getKycIntegration(jwt)`
- `getSourceOfFunds(jwt)`
- `answerSourceOfFunds(jwt, answers)`
- `sendPhoneOtp(jwt, phoneNumber)`
- `verifyPhoneOtp(jwt, code)`
- `deploySafe(jwt, dailyLimit?)`
- `getSafeDeployStatus(jwt)`
- `getSafeConfig(jwt)`
- `createVirtualCard(jwt)`
- `listCards(jwt, filters?)`
- `getAccountBalances(jwt)`
- `listCardTransactions(jwt, filters?)`
- `checkIbanAvailability(jwt)`
- `getIbanSigningMessage(jwt)`
- `createMoneriumIntegration(jwt, signature)`

Configuration should be explicit:

- `GNOSIS_PAY_BASE_URL=https://api.gnosispay.com`
- `GNOSIS_PAY_PARTNER_ID=` optional; only use after partner/dashboard setup.
- `GNOSIS_PAY_SIWE_CHAIN_ID=100`
- `GNOSIS_PAY_JWT_TTL_SECONDS=3600`

## SIWE and Passkeys

Gnosis Pay accepts EOA signatures and EIP-1271 smart-account signatures.
Zold can reuse the existing passkey Safe message-signing path for EIP-1271
SIWE, with one important condition: the Safe must be deployed on the relevant
chain before Gnosis Pay can validate `isValidSignature`.

Recommended flow:

1. Zold calls Gnosis Pay `GET /api/v1/auth/nonce`.
2. Zold builds a SIWE message for the user's chosen signer address.
3. If the signer is a Zold passkey Safe, the browser collects a passkey
   assertion over the Safe message hash and the backend assembles the Safe
   signature.
4. Zold posts `{ message, signature, ttlInSeconds }` to
   `POST /api/v1/auth/challenge`.
5. Zold uses the JWT only for the user's current Gnosis Pay session.

For an MVP, external-wallet SIWE is the shortest path. Passkey-Safe SIWE is
the better long-term fit because it preserves Zold's passkey-first account
model.

## UI Flow

Add a Card view with these states:

1. Connect Gnosis Pay.
2. Sign in with SIWE.
3. Sign up with email if the JWT has no Gnosis Pay user.
4. Accept terms.
5. Start KYC iframe or SDK token flow.
6. Complete source-of-funds questionnaire.
7. Verify phone with OTP.
8. Deploy Gnosis Pay Safe.
9. Create virtual card.
10. Show card list, account balance, and transaction list.

Because permissionless has no webhooks, card activity should be refreshed by
user-driven polling when the Card view is opened or refreshed.

## Funding Design

Do not couple card creation and card funding in the same first PR.

Funding options:

- If Zold production moves to Gnosis Chain, send EURe or USDC from the Zold
  passkey Safe to the user's Gnosis Pay Safe after explicit user approval.
- If Zold stays on Base first, add a bridge/swap route before funding the
  Gnosis Pay Safe.
- For eligible EU/CH users, use Gnosis Pay's IBAN integration to cash in
  through Monerium directly to the Gnosis Pay account.

The Gnosis Chain option is the cleanest long-term fit because Gnosis Pay,
Monerium EURe, and CoW EURe liquidity all converge there.

## Open Questions Before Build

- Does Gnosis Pay require production domains such as `zoldhq.com` to be
  whitelisted even for permissionless SIWE, or only for partner mode?
- Which signer should the first MVP use: external wallet or Zold passkey Safe
  deployed on Gnosis Chain?
- Should Zold store short-lived Gnosis Pay JWTs encrypted, or keep them only in
  the browser/session and require re-SIWE after expiry?
- Should Gnosis Pay KYC become a separate card-only onboarding path, or should
  Zold keep Sumsub/Monerium KYC separate for remittance rails?
- Which funding route should be supported first: direct Gnosis Chain Safe
  transfer, bridge from current app chain, or Gnosis Pay IBAN cash-in?

## PR Sequence

1. Auth/read-only foundation:
   - Add config and Gnosis Pay API adapter.
   - Add SIWE challenge/verify endpoints.
   - Add Card view status panel.
   - Read user profile, cards, balances, and transactions.
2. Onboarding writes:
   - Signup.
   - Terms acceptance.
   - KYC link.
   - Source-of-funds answers.
   - Phone OTP.
   - GP Safe deploy/status.
3. Virtual card issuance:
   - Create virtual card.
   - Show status and card list.
   - Keep sensitive card details out of Zold.
4. Funding:
   - Add explicit top-up quote/confirmation.
   - Reuse Zold's passkey authorization model.
   - Keep bridge/swap/funding receipts separate from Gnosis Pay transaction
     polling.

## PR 1 — BUILT (Aug 2026)

`services/api/src/adapters/gnosis-pay.ts`, `routes/gnosis-pay.ts` (a factory
taking `requireSession`, mounted at `/api/gnosis-pay`), `user.gnosisPay` status
in the store, and a Card tile + screen in the mobile app.
`npm run gnosispay:test` (13 checks, stub Gnosis Pay, no chain, no network).

Answers to the open questions above, as decided while building:

 - **Signer: the user's own browser wallet.** Not the Zold passkey Safe. An
   EIP-1271 signature is only verifiable where the contract is deployed and the
   Zold Safe is not on chain 100. Separately VERIFIED with a real generated
   P-256 signature that Gnosis Chain DOES have the RIP-7212 precompile (valid
   sig returns 1, tampered sig returns empty), and that Candide's bundler covers
   chain 100 — so a passkey Safe there is a deliberate next step, not a blocker.
 - **JWT: never persisted, anywhere.** It is a bearer credential for someone
   else's card account. The browser holds it in memory for the session and
   sends it in an `x-gnosis-pay-token` header; the API forwards and forgets.
   Not localStorage either — an XSS would otherwise own the card account for an
   hour. A reload means signing in again, and the screen says so.
 - **A Gnosis Pay 401 becomes a 409 from us.** Passing their 401 through would
   make the browser treat the user's ZOLD session as expired and log them out
   because a third party's token aged out.
 - **Provenance on every response and every render.** Permissionless has no
   webhooks, so each payload carries `asOf` and the screen says the balance is
   a snapshot. Stored status is shown when signed out, but a stored BALANCE
   never is — a stale balance drawn as current is the failure this avoids.
 - KYC stays separate: Gnosis Pay runs its own, and nothing here touches
   Sumsub/Monerium.

Still absent, and deliberately: signup, terms, KYC, phone OTP, Safe deploy,
card creation and all funding — PRs 2-4 below.

NOT PROVEN: no real Gnosis Pay account has been connected. The stub answers the
shapes their live spec declares; a real SIWE round trip needs a wallet and their
onboarding.

## Non-Goals

- Do not claim Zold issues the card in permissionless mode.
- Do not display PAN or sensitive card credentials without Partner Secure
  Element.
- Do not rely on Gnosis Pay webhooks unless Zold enters partnership mode.
- Do not auto-create or auto-fund a card Safe during account signup.
- Do not use API-held wallet keys for Gnosis Pay signing.

