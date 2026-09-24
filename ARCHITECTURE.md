# Zold — Architecture

Status: September 2026. Running deployment: Base Sepolia (84532). Default
chain: Base mainnet (8453), not yet deployed. What has and has not run against
real money is listed in [README.md](README.md#status); the reasoning behind
each decision below is in [docs/notes/](docs/notes/).

## 1. Accounts and custody

Every user gets a **Candide Safe smart account** (ERC-4337) on the chain
`TRANSF_CHAIN_ID` selects. It is deployed through a bundler and sponsored by a
paymaster, so the user never holds gas. `wallet/passkey-safe-plan.ts` plans
it **1-of-1: the user's passkey is the only owner.** Zold holds no key that can
move funds or block the user from moving them.

**Legacy 2-of-2 Safes.** Until September 2026 hosted production planned Safes
as 2-of-2 with a Zold co-signer. The co-signer could not start a debit, but the
user could not move funds — or add a key of their own — without Zold's
counter-signature. That was retired:

- New plans never include the co-signer, and production no longer requires
  `CANDIDE_COSIGNER_*`.
- An existing 2-of-2 Safe keeps working while `CANDIDE_COSIGNER_KEY` is set
  (without it, its funds cannot move); the API names such accounts at startup.
- The user removes the co-signer from Settings: one passkey-signed
  `removeOwner(prev, cosigner, 1)` operation
  (`POST /api/users/:id/passkey-safe/cosigner-removal`), which the co-signer
  counter-signs one last time. The plan is updated only after the chain shows
  the co-signer gone and threshold 1.
- A Candide recovery installs only the new passkey, so recovery also drops it.

There is **no allowance module and no standing spend authority**. The plan
records an empty allowance list so allowances left on older Safes can be found
and revoked.

**Funding**

- **EUR**: a Monerium IBAN attributed to the Safe. Inbound SEPA mints EURe
  directly to the Safe. The user connects Monerium by OAuth (PKCE) or with
  their own Monerium API keys; `POST /api/users` always creates a `pending`
  account, and only an IBAN whose address matches the Safe approves it.
- **Crypto**: USDC or EURe sent to the Safe directly, or to the payment page
  address, which a Candide forwarder routes from other EVM networks to the
  Safe.

**Recovery** (`recovery.ts`, `routes/recovery-*.ts`, `recovery/`)

- A guardian module on the Safe with a delay (`RECOVERY_DELAY_HOURS`, default
  72) during which the current owner can cancel.
- Managed recovery: a guardian signer service (`RECOVERY_GUARDIAN_SIGNER_URL`)
  acts for users whose identity Monerium approved. It installs the new owner
  alone at threshold 1, but nothing updates the stored plan after it
  executes — that path is not wired end to end.
- Email/SMS recovery: Candide's Safe Recovery Service is the guardian and
  signs after a one-time code on each registered channel. It is wired but has
  never been called against the real service.
- The new credential lives on the `RecoveryRequest` until the chain confirms
  the new owner, so passing the OTP checks does not let anyone sign in or
  spend during the delay.

## 2. Authorising a payment

A send carries **two signatures**, checked in two places:

1. **Device key → `PaymentAuthorization`** (EIP-712). The browser holds a
   device key, wrapped with WebAuthn PRF (HKDF → AES-GCM) where the
   authenticator supports it. It signs the transfer id, amount, recipient
   commitment and deadline. The server verifies it
   (`assertDeviceAuthorization` in `orchestrator.ts`) against the terms stored
   on the transfer.
   *Caveat*: some real authenticators report no PRF support; there the device
   key is stored unwrapped in `localStorage`, and the app detects and surfaces
   this.
2. **Passkey → user operation hash.** `POST /api/transfers` prepares the Safe
   user operation that *is* the debit, for the exact token, amount and
   destination. The passkey signs its hash at send time; the chain enforces
   it. The server relays it (and counter-signs on a legacy 2-of-2 Safe).

A stolen session therefore cannot change the amount or the destination, and
the server cannot produce a debit on its own.

## 3. Transfers

`transfers/build.ts` is the **only** code that creates a transfer — used by the
direct send route and by business draft execution. `orchestrator.ts` drives it:

```
SEPA:  CREATED → DEBITED → PAID
cash:  CREATED → DEBITED → SWAPPED → BRIDGED → PAYOUT_DETAILS_PENDING
         → PAYOUT_FUNDING_PENDING → PAYOUT_FUNDED → PAYOUT_READY
         → PAYOUT_SUBMITTED → PAID
any step can end in FAILED, REFUNDED or MANUAL_REVIEW
```

- Every leg records its step and tx hash before the next runs; a debit already
  recorded is refused, so a crash cannot double-spend.
- **Compensation is asymmetric**: a 4xx refusal refunds; a timeout, a
  duplicate-transfer revert, or any failure after a partner holds the money
  goes to `MANUAL_REVIEW`. `store.updateTransfer` refuses to move a `REFUNDED`
  or `PAID` transfer backwards.
- A sweep at startup and every 5 minutes retries stranded transfers.
- The reconciler (`reconcile.ts`) reports drift between ledgers and never
  repairs it.

**Rails**

| rail | path | state |
|---|---|---|
| SEPA | Monerium redeem burns EURe from the Safe and pays the IBAN. Only the fee (currently €0) leaves the Safe to Zold. | open |
| Cash pickup | USDC → Bridge.xyz → Stellar → MoneyGram (SEP-10/12/24) | **closed** unless `BRIDGE_LIVE=1` and an anchor are configured (`cashRailOpen()`); quotes answer `503 RAIL_CLOSED` |

There are no mock legs: a rail is live or the transfer is refused before
anything leaves the Safe.

## 4. FX and liquidity

| token | issuer | role |
|---|---|---|
| EURe | Monerium (EU EMI) | the euro balance; address per chain from Monerium's `/tokens` |
| USDC | Circle | payment-page deposits and the cash rail |

- `rates.ts` fetches live mid-rates (10-minute cache) with bounds checks. No
  rate, no quote.
- `fx.ts` builds the quote; `assertQuoteRateBinding` refuses and refunds if
  the executed rate drifts past `FX.QUOTE_BINDING_BPS`.
- `liquidity.ts` is the seam: it chooses a venue, persists the quote that
  priced a transfer, and sends execution back to the venue that quoted it. An
  unknown provider id throws — there is no fallback to our own inventory.
- Venues, one file each in `liquidity/`:

| venue | file | notes |
|---|---|---|
| best execution | `best.ts` | default (`LIQUIDITY_PROVIDER=best`), over `LIQUIDITY_VENUES` (default `lifi,dex`) |
| LI.FI | `lifi.ts` | aggregator; intended production venue; Safe-executable |
| Uniswap v3 | `uniswap.ts` | single pool; Safe-executable |
| Bebop RFQ | `rfq.ts` | EURe only on Ethereum |
| CoW | `cow.ts` | quote only |
| FxSwapper | `fx-swapper.ts` | our own inventory; custodial; local hardhat only |

- Every venue quote is checked against the independent mid (`assertPriceSane`).
- Venue calldata is allowlisted (`LIFI_CONTRACTS`, `BEBOP_CONTRACTS`), value
  must be 0, and the approval goes to the spender the venue *names*.
- Amounts out are measured as a balance delta, never copied from the quote.
- `marginBps` is measured between the live mid and what is delivered; positive
  slippage goes to the user by default and is recorded.

Default deployment (`best` over `lifi,dex`) is non-custodial: both venues
execute from the Safe. `transfer.custody` records where the fee landed.

## 5. Businesses

Domain rules live in `domain/` (no HTTP, no chain); routes in
`routes/orgs.ts` and `routes/business/`.

- **Three checks on every request**: session (who), member and role (may they,
  in this org), plan capability (did the org buy it).
- **Four eyes**: a draft's reviewer may not be its drafter; editing someone's
  draft lines makes you the drafter.
- A draft line's payee fingerprint is recomputed at review and at execution,
  so an address-book edit in between blocks the payment (`INVALID_DATA`).
- An org can never lose its last owner.
- Nothing in `store.ts` deletes an org, account, invoice or ledger row. Plan
  gating is a read-time filter; a trial is a grant with an end date.
- Invoicing follows jurisdiction rules (`domain/invoicing.ts`,
  `domain/jurisdictions.ts`): German mandatory details, the EU VAT Directive,
  or user-defined rules elsewhere.

## 6. Code layout

The API is a set of router factories that `server.ts` mounts. `server.ts` is
wiring and owns authentication, so a route module cannot grow a second way to
decide who is calling.

| path | contents |
|---|---|
| `services/api/src/server.ts` | wiring, session auth, router mounts |
| `services/api/src/http/` | origin policy and rate buckets (`policy.ts`), sessions, route guards, in-flight ceremony maps |
| `services/api/src/routes/` | one router per subject; `business/` splits the org surface again |
| `services/api/src/transfers/build.ts` | the one path that creates a transfer |
| `services/api/src/orchestrator.ts` | transfer state machine, compensation, sweeps (kept whole on purpose) |
| `services/api/src/config.ts` | every setting and every production refusal (kept whole on purpose) |
| `services/api/src/capabilities.ts` | what `/api/health` tells the UI it may offer |
| `services/api/src/domain/` | plans, roles, drafts, invoices, invoicing, jurisdictions, ledger, chart of accounts |
| `services/api/src/liquidity/` | one file per FX venue, behind `liquidity.ts` |
| `services/api/src/store/` | row shapes (`types.ts`) and the JSON file db with migrations (`db.ts`); `store.ts` holds the methods and is the only code that touches the db |
| `services/api/src/wallet/` | Safe deployment plan, signing, user operations |
| `services/api/src/adapters/` | Monerium, Gnosis Pay, MoneyGram, crypto deposits, Candide forwarder |
| `services/api/src/stellar/`, `bridge/` | cash rail (closed) |
| `services/api/src/shopify/`, `recovery/` | merchant and guardian integrations |
| `services/api/public/app/` | account app: ordered classic scripts sharing one scope. No file calls forward into a later one; `main.js` loads last and holds everything that awaits then renders |
| `services/api/public/business/` | org dashboard as ES modules; `core.js` owns shared state and exports setters |
| `services/api/public/sw.js` | service worker; page code network-first, `/vendor/*`, icons and manifest cache-first |
| `contracts/src/` | `FxSwapper`, `AdminTimelock`, `MockToken` — local hardhat fixtures, not deployed on real chains |

Four test suites grep source text (custody, passkey-safe-plan, gnosis-pay,
passkey-safe's mount check). Moving code means moving their greps.

## 7. Data and exposure

- **Collect per call, store nothing.** Zold stores no identity documents;
  identity is Monerium's. Sender details for a rail are held for one call.
- **Secrets at rest are encrypted** (`crypto-at-rest.ts`): Monerium tokens and
  API keys, Shopify store tokens. None appears in an API response.
- **Public projections are allowlists**, redacted on the server: a withheld
  field is never in the JSON.
- **Slugs, verification codes and payment codes are credentials**: auth rate
  bucket, never cached by the service worker, 404 under the wrong handle.
- **Documents are frozen, signed snapshots**, re-verified on every visit to
  `/v/<code>`; a revoked one fails verification rather than vanishing.
- **Travel Rule**: SEP-9 originator fields are mapped for the MoneyGram anchor
  (`stellar/sep9.ts`); collection per transfer is not yet wired.

## 8. Public surfaces

| path | what |
|---|---|
| `/` | landing |
| `/app` | account app (PWA) |
| `/business` | organisation dashboard |
| `/pay/<handle>`, `/pay/<handle>/<code>` | payment page and payment link |
| `/invoice/<token>` | invoice |
| `/r/<slug>` | shared receipt |
| `/v/<code>` | document verification |
| `/api/health` | `capabilities: { sandbox, moneriumOAuth, moneriumApiKeys, moneriumEnvironment, moneriumHost, cashRail, shopify, shopifyMode, emailSmsRecovery }` — the UI renders a control only where the API would accept it |
