![Zold](assets/readme-banner.png)

# Zold

Cross-border payments on stablecoin rails, built by **Zoldenburg**.

Euros arrive by SEPA transfer to a per-user IBAN and land on-chain as EURe in
the user's own Safe smart account. They leave as a SEPA transfer to any IBAN, or
as cash collected at a MoneyGram counter. Every route is quoted against a live
mid-market feed with the fee and measured FX margin shown before the user
signs, and every transfer is tracked through an explicit state machine to `PAID`.

The account is non-custodial. The user's passkey is an owner of their Safe, a
second key generated in their browser authorises each payment over its exact
terms, and neither can be replaced by the server.

---

## System at a glance

```
                    ┌──────────────────────────────────────────────┐
   SEPA in ───────► │  Monerium  ──EURe──►  user's Safe (ERC-4337)  │
   USDC in ───────► │                       passkey + co-signer 2/2 │
                    └────────────────────┬─────────────────────────┘
                                         │ device-signed EIP-712
                                         ▼
                              ┌─────────────────────┐
                              │    orchestrator     │  state machine per rail
                              └──────┬───────┬──────┘
                                     │       │
                    SEPA rail ◄──────┘       └──────► FX rail
                          │                                │
              Monerium redeem                     liquidity venue
              (burn EURe → SEPA)                  (EURe → USDC)
                          │                                │
                          ▼                                ▼
                    payee's bank                   CCTP Base → Stellar
                                                           │
                                                           ▼
                                                  MoneyGram anchor
                                                    (SEP-10/12/24)
                                                           │
                                                           ▼
                                                   cash at a counter
```

The normal identity-review path can be backed by Sumsub. Sumsub stores document
images and liveness media; this app stores only the Sumsub applicant reference,
review result, and extracted text fields needed for Travel Rule and partner
handoff. Approved Sumsub applicants can be shared to Monerium through Sumsub's
share-token flow, and MoneyGram receives only the documented SEP-9 text fields.
Bridge still needs its hosted KYC link or direct Customers API requirements.

Chain selection is configuration, not code: `TRANSF_CHAIN_ID` resolves the
chain and `deployments.json` is keyed by chain id, so several deployments
coexist without overwriting each other. The current target is Base Sepolia
(84532) against Monerium's EURe.

---

## Capability status

Stated precisely, because partners and operators need to know which legs have
carried value and which have not.

| Capability | Status |
|---|---|
| Residency gate at account creation | **Live** — Monerium's residency tiers, enforced before KYC |
| IBAN issuance, SEPA deposit → EURe in Safe | **Live** — Monerium, EIP-1271 ownership |
| Safe deployment, gas-sponsored, passkey-owned | **Live** — Candide bundler + paymaster |
| Passkey auth, WebAuthn assertion verified server-side | **Live** |
| Device-key payment authorisation (EIP-712) | **Live** — verified before any debit |
| Live FX quoting, measured margin, fail-closed on stale | **Live** |
| SEPA payout (Monerium redeem, normalised reference) | **Live** |
| Managed recovery (guardian, delay, operator approval) | **Live** |
| Inbound USDC → EURe conversion | Integrated; no production deposit converted |
| Liquidity venues (LI.FI, CoW, Uniswap v3, RFQ, best-execution) | Quoting live; no venue has executed a settlement |
| CCTP Base → Stellar | Integrated; runs dry until `CCTP_LIVE=1` |
| Stellar payout leg | Ledger half proven on-chain; anchor attribution not yet exercised |
| MoneyGram cash pickup | Protocol complete (SEP-10/12/24); requires a partner agreement |
| KYC provider | **Sumsub integrated** — WebSDK, signed webhooks, Monerium share token, MoneyGram SEP-9 fields |

Two constraints worth naming directly:

- **`debited → bridged → paid` has not run end to end.** Each leg is covered by
  its own suite; the composition is not yet proven.
- **The cash rail is gated on a MoneyGram partner agreement**, not on
  engineering. Stellar's public test anchor never publishes a withdrawal
  account, so the anchor-attribution half runs first against MoneyGram's own
  anchor. Everything up to that point is built and tested.

---

## Architecture

### Layers

| Layer | Responsibility |
|---|---|
| `server.ts` | HTTP surface — 51 routes, session and KYC gating, rate limits, origin allowlist |
| `orchestrator.ts` | Transfer state machines, authorisation checks, compensation |
| `fx.ts` · `rates.ts` | Quoting: live mids, measured margin, refuses stale |
| `liquidity.ts` · `dex.ts` | Venue abstraction and best-execution routing |
| `wallet/candide.ts` | Safe derivation, ERC-4337 deployment, EIP-1271/EIP-712 signing |
| `stellar/` · `bridge/` | Anchor protocol and cross-chain USDC movement |
| `adapters/` | One module per external provider, each behind a stable interface |
| `store.ts` | Persistence and atomic claims |
| `config.ts` | Configuration and the production readiness gate |

### The adapter rule

Every external service sits behind an interface, and the modules above it never
learn which implementation is in use. `liquidity.ts` is the reference case: one
`LiquidityProvider` interface, six implementations, one factory. Adding a venue
touches one file, and the router quotes every configured venue in parallel and
settles at the best price rather than a configured default.

### Contracts

Four, deliberately small, no inheritance depth and no proxies.

| Contract | Role |
|---|---|
| `AdminTimelock.sol` | M-of-N + delay owner of the others. No single key can raise a cap, grant a role or drain inventory. A separate guardian can pause instantly; only the timelock can un-pause |
| `FxSwapper.sol` | Swaps at an owner-set rate behind a slippage guard, restricted to approved executors, pausable |
| `BridgeEscrow.sol` | Locks funds for the bridge leg, refuses reused transfer ids, refunds only to the target bound at lock time |
| `MockToken.sol` | Local-chain ERC-20 for tests |

Custody is the user's Safe. There is no protocol-owned balance ledger — that
was removed deliberately, so the only record of a user's euros is the EURe in
their own smart account.

---

## End-to-end flow

### 1 — Account and passkey

`POST /api/users` creates the account. The browser then registers a WebAuthn
credential: the server issues a challenge bound to the account, parses the CBOR
attestation, and stores the COSE public key (`webauthn.ts`). Every later sign-in
verifies the assertion signature, the RP ID hash and the counter before a
session is issued. Re-registering a passkey requires a step-up from the current
credential, so a stolen session cannot silently replace it.

From the passkey, `wallet/candide.ts` derives the Safe address
deterministically — the address exists before anything is deployed.

### 2 — Residency and identity

Account creation is gated on residency before anything else runs
(`country-policy.ts`). Only countries in Monerium's supported residency tiers
pass; their `prohibited` tier and any country absent from their reference are
refused, with common aliases and names normalised so the check cannot be evaded
by spelling. This is a product gate aligned to what the issuer will support —
not a substitute for sanctions screening, wallet screening, source-of-funds
checks, partner corridor rules or legal review, and it needs re-syncing against
Monerium's reference before launch.

Note it constrains **who may hold an account**, not where money may be sent;
payout corridors are governed separately by the rails and their partners.

Past that gate, IBAN issuance, deposits, device binding, quoting and transfers
all fail closed until the account is approved. Two paths:

- **Identity review** — the standard route.
- **Connect an existing Monerium account** — OAuth Authorization Code + PKCE
  (S256). Per-user tokens are AES-256-GCM encrypted at rest, never returned by
  any endpoint. The app links its own Safe and requests a new IBAN; the user's
  existing account is untouched.

For cash payouts the sender's FATF originator data is collected and mapped to
SEP-9 field names (`stellar/sep9.ts`). Each user gets a distinct SEP-12 customer
via a derived memo, so one treasury account never attributes one user's identity
to another's payout.

### 3 — Wallet deployment

The Safe is deployed through an ERC-4337 UserOperation via Candide's bundler,
with the paymaster covering gas — the user pays nothing and needs no native
token. Owner actions are **2-of-2**: the passkey and a co-signer. Base's RIP-7212
P256 precompile verifies passkey signatures natively, so no verifier contract is
required.

Candide's `SocialRecoveryModule` is installed at deployment with a guardian.
Recovery requires operator identity approval and the module delay must elapse
before a separate signer service acts; the API never holds the guardian key.
Production payment relays use Candide's `AllowanceModule`: the co-signer is a
token-scoped delegate with a bounded recurring allowance, so debits can execute
without storing a user Safe owner key in the API. That is intentionally weaker
than "server can never move funds alone"; the allowance amount/period is the
limit and must be treated as production risk configuration.

### 4 — Device spending key

A secp256k1 key is generated in the browser and never leaves it — the server
learns only the address (`public/device.js`). It is encrypted at rest with a
secret only the authenticator can produce: WebAuthn PRF → HKDF → AES-GCM, with
only the ciphertext in local storage.

Registration is trust-on-first-use, and only the current key can rotate itself.

> Where PRF is unsupported by the authenticator, the key is stored unwrapped and
> reported as `protection: "none"`. Treat PRF as a per-device capability to
> detect and surface, not a guarantee.

### 5 — Funding

Monerium issues an IBAN bound to the Safe, ownership proven by EIP-1271 — the
IBAN belongs to the contract wallet. An inbound SEPA transfer mints EURe
directly to the Safe.

The webhook takes only an order id and re-reads that order from Monerium, so a
forged payload buys nothing; an HMAC gate with delivery-id deduplication and a
staleness window sits on top. A reconciler compares Monerium's processed orders
against what was mirrored, plus on-chain invariants, every 15 minutes. It
reports drift and never repairs — a system that silently mints to make two
ledgers agree is worse than the disagreement.

Accounts may also opt into inbound USDC conversion: a poller reads ERC-20
Transfer logs, prices through the same liquidity seam the corridor uses, and
refuses — recording the reason — below the dust floor, off a live-mid check, or
without an approved account.

### 6 — Quote

`POST /api/quotes`. `rates.ts` fetches live EUR mids on a 10-minute cache and
**refuses to quote rather than serve a stale rate**. The EUR→USD leg is read
from the venue that would actually fill it, so a quote cannot promise a rate the
settlement will not honour. `marginBps` is *measured* between the mid and what
is delivered, not asserted.

The quote is locked for ten minutes and records `lockedSwapRate` for binding at
execution.

### 7 — Authorisation

`POST /api/transfers` fixes the exact terms. A `destinationCommitment` — a
keccak hash over the rail, the payout identifier and the recipient name — binds
*who* is paid into the signature, so the payee cannot be swapped after signing.

The device signs an EIP-712 `PaymentAuthorization` (domain `TransF Safe
Transfer`, `verifyingContract` = the user's Safe) covering account, amount,
destination, transfer id and deadline. Before signing, the browser recomputes
the commitment independently and refuses if the server's terms name a different
recipient.

On the SEPA rail the Monerium redeem message is signed in the same step: both
signatures are collected while the user is present, so nothing is signed blind
later.

`POST /api/transfers/:id/authorize` claims the submission atomically before any
`await`, closing a double-submit window.

### 8 — Execution

`orchestrator.ts` runs the state machine:

```
CREATED → DEBITED → SWAPPED → BRIDGED → PAYOUT_DETAILS_PENDING
        → PAYOUT_FUNDING_PENDING → PAYOUT_FUNDED → PAYOUT_READY
        → PAYOUT_SUBMITTED → PAID
                    ↘ MANUAL_REVIEW · FAILED · REFUNDED
```

Before anything moves: `assertDeviceAuthorization` verifies the signature, and
`assertQuoteRateBinding` refuses and auto-refunds if the executable rate has
drifted beyond `QUOTE_BINDING_BPS` from the quote.

**SEPA rail.** Only the fee moves out of the Safe; the redeem burns the payout
directly from it. `sepa.ts` folds the remittance reference into the SEPA Latin
subset — accents decomposed, reserved forms stripped, truncated at the scheme's
140 characters — so the payee reconciles against their own handle.

**FX rail.** The full amount moves to the orchestrator, then:
`liquidity.ts` swaps EURe→USDC at the best available venue price, with every
quote's implied rate checked against the independent mid and refused beyond a
band. Positive slippage is measured and attributed to the user by default.
`bridge/cctp.ts` burns on Base and mints on Stellar via Circle's attestation
service. `stellar/anchor.ts` authenticates over SEP-10, submits the sender
profile over SEP-12, opens a SEP-24 withdrawal, and pays the anchor's account
with its memo — refusing to burn if the Stellar recipient lacks a trustline for
the asset.

**Failure.** Compensation releases escrow and re-credits at current rates with
itemised deductions, reaching `REFUNDED`. Stranded transfers are swept at
startup and every five minutes. A duplicate-transfer revert is never
auto-refunded — it goes to `MANUAL_REVIEW`.

### 9 — Last mile

- **SEPA** — funds land in the payee's account, carrying the sender's reference.
- **Cash** — the recipient collects at any MoneyGram agent with the reference
  number and photo ID.

The client polls `refresh-payout`; the app's timeline reads the transfer's real
state rather than advancing on a timer.

---

## Security model

| Control | Effect |
|---|---|
| Passkey as Safe owner, 2-of-2 with co-signer | Owner actions need both signatures; payment relays are limited by token-scoped co-signer allowances |
| Device key, EIP-712 per payment | A stolen session cannot change the amount or the payee |
| `destinationCommitment` covers the recipient name | The payout identity is signed, not just the account |
| `AdminTimelock` M-of-N + delay | No single key can change protocol parameters |
| Guardian recovery, operator-approved, delayed | A lost passkey is recoverable without a custodial key |
| Fail-closed production gate | The process refuses to start on incomplete configuration |
| Origin allowlist, per-IP and per-credential rate limits | Ceremony and login abuse bounded |

Two properties are stated rather than implied:

- **Device authorisation is verified in the API process**, not by a contract.
  The server cannot forge a signature, but it is the component performing the
  check.
- **`user.privateKey` remains in the datastore** for accounts not yet migrated
  to the passkey-owned Safe, and the JSON store requires
  `ALLOW_PLAINTEXT_STORE=1` to be acknowledged explicitly at startup. Migrating
  the remaining server-held key is the open item.

---

## Operating it

Requires Node 22 or newer.

```sh
npm install
npm run compile          # contracts
npm run test:contracts   # 8 tests against a throwaway chain
npm run check            # 31 suites: contracts, e2e, typecheck, focused harnesses
npm run api              # run against the configured chain
```

`/` is the landing page, `/app` the account.

Configuration lives in `.env`; `.env.example` documents every variable.
`config.ts` enforces a production readiness gate at startup and refuses to run
on an incomplete configuration — missing operator token, unacknowledged
datastore, absent webhook secret or token encryption key, non-explicit origins
or proxy hops, missing co-signer or recovery guardian, or a smart-account chain
that disagrees with the app chain.

Operational tooling:

```sh
npm run reconcile        # ledger + on-chain invariant drift report
npm run monerium:check   # verify issuer configuration
npm run stellar:check    # full anchor protocol run
npm run cctp:readiness   # confirm burner and treasury funding
npm run dex:setup        # pool inspection and setup
```

See [INTEGRATORS.md](INTEGRATORS.md) for every external dependency and the
credentials each requires, and [ARCHITECTURE.md](ARCHITECTURE.md) for the
platform design and commercial reasoning.

---

## Repository map

```
services/api/src/
  server.ts            HTTP API, session and KYC gating, static UI
  orchestrator.ts      transfer state machines, authorisation, compensation
  fx.ts  rates.ts      quoting; live mids, measured margin, fail-closed
  liquidity.ts  dex.ts venue interface, best-execution routing, surplus
  chain.ts             chain resolution, EIP-712 terms, commitments
  store.ts             persistence, atomic authorisation claims
  config.ts            configuration + production readiness gate
  reconcile.ts         issuer/chain drift detection
  sepa.ts              remittance reference normalisation
  country-policy.ts    residency gate at account creation
  webauthn.ts          challenge, attestation, assertion verification
  recovery.ts          guardian recovery orchestration
  pay.ts  qr.ts        payment pages and QR encoding
  wallet/candide.ts    Safe derivation, ERC-4337 deployment, signing
  stellar/             SEP-10 auth, SEP-24 withdrawals, SEP-9 mapping
  bridge/cctp.ts       Base → Stellar burn / attest / mint
  adapters/            monerium, moneygram, crypto deposits, forwarder
contracts/src/         AdminTimelock, FxSwapper, BridgeEscrow, MockToken
services/api/public/   landing + app, no build step
scripts/               deploy, operations, 30 test harnesses
```
