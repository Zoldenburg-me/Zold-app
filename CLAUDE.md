# Zold — notes for Claude sessions

## Start here

This file is the map and the invariants. The *reasoning* — what was tested,
what broke, what was rejected and why — lives in `docs/notes/`, moved there
verbatim when this file passed 2,100 lines. It is decision history, not a
tutorial: a claim marked VERIFIED was checked against a live chain, API or
bytecode. If you contradict one, re-test before rewriting it, and say what you
ran.

| you are about to… | read |
|---|---|
| touch money movement, FX, a swap, the cash rail or Stellar | `docs/notes/money-movement.md` |
| touch keys, passkeys, sessions, custody, recovery or Monerium | `docs/notes/identity-and-security.md` |
| touch the org domain, drafts, currencies or invoices | `docs/notes/business-and-invoicing.md` |
| touch payment links, Shopify, receipts or the card | `docs/notes/payments-and-checkout.md` |
| touch the mobile UI, the PWA, chain selection or deployments | `docs/notes/app-and-chains.md` |
| wonder why a guard looks arbitrary | `docs/notes/review-passes.md` |
| look for a file that moved, or move one | `docs/notes/code-layout.md` |
| talk to a payout, card or funding partner | `docs/notes/roadmap-and-partners.md` |
| pick up someone else's branch | Multi-agent workflow, below |

Design docs (not history): `docs/business-accounts.md`,
`docs/gnosis-pay-permissionless-integration.md`, `docs/payment-pages.md`,
`docs/privacy-bundle.md`, `docs/gitbook/`.

THREE RULES OVERRIDE CONVENIENCE:
1. **main is PR-merge only.**
2. **Nothing renders as real that has not moved real money.** This is the UPI
   lesson (a rail that minted its own reference numbers for money that reached
   nobody) and it is why gated currencies, SOON labels, `simulated` badges,
   dry-run plans and `heldByUs` all exist. Deleting a fake is cheaper than
   explaining one.
3. **Fail closed.** No rate, no quote. No venue, no trade — never a silent
   fallback to our own book. No Monerium connection, no SEPA send — refuse
   *before* the fee debit.

## What this deployment is

- **Chain**: `TRANSF_CHAIN_ID` selects it; default **8453 (Base mainnet)**.
  Nothing is pinned to hardhat. `deployments.json` is keyed by chain id. On a
  real chain it holds only Monerium's EURe and Circle's USDC — FxSwapper and
  AdminTimelock are hardhat-only fixtures. **No 8453 entry exists yet**: run
  `npm run deploy` with real operator keys before `npm run api` there.
  Running deployment today is **Base Sepolia (84532)**.
- **Identity is Monerium's.** Onboarding: account (email required) → passkey
  (no skip) → Safe deployed → recovery enrolment → the gate offers OAuth *or*
  your own Monerium API keys → "Activate IBAN with passkey". `POST /api/users`
  always creates `pending` with no IBAN; only an address-matched IBAN approves.
  There is no KYC provider, no Sumsub, no operator review route.
- **Rails**: SEPA (Monerium redeem, non-custodial for the principal, fee €0) is
  open. The **cash rail is CLOSED** unless `cashRailOpen()` — quotes answer 503
  RAIL_CLOSED and the app hides the corridor. UPI is deleted, not disabled.
- **Custody**: `LIQUIDITY.PROVIDER` defaults to `best` over `lifi,dex`, both
  Safe-executable, so the default deployment is non-custodial. The fee always
  lands at the orchestrator and `transfer.custody` records it.
- **Simulation is gone.** No `/api/simulate/*` mock deposits, no
  `ALLOW_MOCK_FALLBACK`, no faucet, no mock IBANs. `/api/health` publishes
  `capabilities: { sandbox, moneriumOAuth, moneriumApiKeys, moneriumEnvironment,
  moneriumHost, cashRail, shopify, shopifyMode, emailSmsRecovery }` (verified
  against `capabilities()` in capabilities.ts), and the UI renders a control only
  where the API would accept it.
- **The one harness seam that stays**: `KYC_AUTO_APPROVE=1` is honoured only on
  chain 31337 and refused in production; `mirrorOrder` mints the hardhat
  MockToken only on 31337. Inert on real money by construction, not config.

## Where the code lives

The modularity pass (Sep 2026) split the five big files; every move was a MOVE
(no behaviour change). Full table and reasoning: `docs/notes/code-layout.md`.

- `server.ts` is wiring only (~320 lines): routers under `routes/`, the shared
  HTTP layer under `http/`, and **`transfers/build.ts` is the ONE path that
  builds a transfer** — the business router is handed it, never rebuilds it.
- `store.ts` holds the methods; row shapes in `store/types.ts`, the file-backed
  db in `store/db.ts`. Still the only thing that touches the database object.
- `liquidity.ts` is the seam; one file per venue in `liquidity/`.
  `liquidity/best.ts` takes its venue resolver as an argument (no cycle).
- `public/app/*.js` are **classic scripts sharing one scope**: every file but
  the last holds declarations and wiring only, and NOTHING CALLS FORWARD into a
  later file. The last is `app/main.js`, and anything that awaits and then
  renders goes there — the event loop runs while the parser waits on a later
  script, so an early fetch can resolve before the code it renders with exists.
  `sw.js` serves page `.js`/`.css` network-first (only `/vendor/*`, icons and
  the manifest are cache-first), so a deploy needs no `SHELL_CACHE` bump unless
  the SHELL list or a vendored file changes. `public/business/*.js` are **ES modules**; `core.js` owns the
  shared state and exports setters.
- **server.ts still owns authentication**: every router is a factory taking
  `requireUserSession`.
- Four suites grep source text (custody, passkey-safe-plan, gnosis-pay,
  passkey-safe's mount check). Moving code means moving their greps.

## Invariants

Each of these was a bug once. The reasoning is in `docs/notes/`.

**Money**
- **No debit without a user signature.** `POST /api/transfers` prepares the
  userOp that *is* the debit; the passkey signs its hash at send time and the
  chain enforces token, amount and destination. The allowance model is gone —
  the API can dispose of nothing, ever.
- **Quote binds execution.** `assertQuoteRateBinding` refuses and auto-refunds
  if the on-chain rate drifts past `FX.QUOTE_BINDING_BPS`. Persisted quotes
  execute on the venue that priced them.
- **Every venue quote is checked against an independent mid** (`assertPriceSane`
  over `rates.ts`) — a pool is wherever the last trade left it, and an
  aggregator's route is a third party's choice.
- **Venue calldata is allowlisted** (`LIFI_CONTRACTS`, `BEBOP_CONTRACTS`), value
  must be 0, and you approve the spender the maker **NAMES** — `approvalTarget`
  equalling `tx.to` today is luck, not a guarantee.
- **Amounts out are MEASURED** as a balance delta, never copied from the quote.
- **Compensation is asymmetric on purpose**: only a 4xx refusal refunds; a
  timeout, a duplicate-transfer revert, or any failure after Bridge holds the
  deposit is MANUAL_REVIEW. `store.updateTransfer` refuses to move a
  REFUNDED/PAID transfer backwards.
- **Margin is measured, surplus is attributed.** `marginBps` is computed between
  the live mid and what we deliver; positive slippage goes to the user by
  default and is recorded either way.
- **The reconciler reports drift and never repairs it.** A system that mints to
  make two ledgers agree is worse than the disagreement.

**Identity and authority**
- **The passkey is the Safe's only owner.** The 2-of-2 Zold co-signer was
  retired (Sep 2026): it meant a user could not move their own funds, or add
  a key, without us. Legacy 2-of-2 Safes need `CANDIDE_COSIGNER_KEY` until
  each user removes it (`passkey-safe/cosigner-removal`); never plan a new
  Safe with it.
- **Three checks, not one**: session (who), member+role (may they here), plan
  capability (did the org buy it). Collapsing any two opens a hole.
- **Four eyes**: the reviewer may not be the drafter, whatever their role — and
  editing someone's draft lines makes you the drafter.
- **Gating is a read-time filter, NEVER a write-time delete.** Nothing in
  `store.ts` deletes an org, account, invoice or ledger row; no such method
  exists. A trial is a grant with an end date, not a plan change.
- **INVALID_DATA**: a draft line's payee fingerprint is recomputed at review AND
  at execution. The gap between approval and execution is where an address-book
  edit lands.
- **An org can never lose its last owner** — by role change or by deactivation.
- **A recovery's new credential lives on the RecoveryRequest** until the chain
  confirms the new owner, so whoever holds the OTP channels cannot sign in or
  spend during the grace period.
- **PRF is a per-authenticator capability, not a design guarantee.** Real
  hardware reported no PRF support, so the device key was stored unwrapped:
  anything that can read localStorage can spend there. Detect and surface it.

**Data and exposure**
- **Collect per call, store nothing.** The sender profile (name, birth date, ID
  number) was deleted; `SenderDetails` is held for one call. Do not reintroduce
  a stored identity profile for a rail that has never run.
- **Public projections are allowlists**, and redaction is server-side — a
  withheld field is never in the JSON, because "the page does not draw it" and
  "the page was not sent it" are different guarantees.
- **Slugs, verification codes and payment codes are credentials**: auth rate
  bucket, never cached by the service worker, and a code under the wrong handle
  is a 404.
- **Documents are frozen snapshots, re-verified on every visit.** A revoked one
  fails verification rather than vanishing.

**Two strings keep the old "zoll" spelling on purpose** — do not finish the
rename. `PRF_SALT = "zoll/device-key/v1"` is an *input* to key derivation, so a
new spelling makes every wrapped device key undecryptable; the `zoll-device-key`
/ `zoll-session` localStorage slots are read once and migrated forward, and only
the current authorizer can rotate a device key.

## Running the app

| | `npm run dev` | `npm run api` |
|---|---|---|
| chain | local hardhat 31337 | whatever `TRANSF_CHAIN_ID` says (8453 default) |
| database | `data/db.dev.json`, **wiped every start** | `data/db.json`, preserved |
| passkey Safe deploy | **impossible** | works |

Passkey Safe deployment goes through an ERC-4337 bundler and paymaster; local
hardhat has neither, so the API refuses with 409 and names the mismatch rather
than failing as a bare "Failed to fetch". That is also the wall a local send
hits: `npm run api` against Base Sepolia with a funded, deployed Safe is the
only way past it.

`npm run dev` wiping its own db is why test accounts vanish between runs — and
why the live accounts in `data/db.json` must never be exercised with it.

To fund locally: mint MockToken EURe straight to the user's Safe from hardhat
account 0 (the token owner) and `refresh()` picks it up.

To see the KYC gate locally, `npm run dev` cannot do it (`scripts/_test-env.ts`
blanks `KYC_AUTO_APPROVE`). Run a second API against the chain dev.ts started —
`TRANSF_API_PORT=3001 TRANSF_CHAIN_ID=31337 KYC_AUTO_APPROVE=0 RP_ID=localhost`
with the operator `*_KEY` vars **blanked** (.env holds real Base Sepolia keys
that do not own the local deployment).

## Environment

- Ports 3000 (API/UI), 8545 (chain), 8546 (contract tests).
- No `gh` CLI, no brew. `origin` is SSH (`git@github.com:…`) and the user's
  key works for push and branch deletion without a token (verified 2026-09-24).
  The GitHub REST API (opening or closing PRs via curl) needs a fine-grained
  PAT the user mints per session; with a PAT in an HTTPS URL, the auth username
  must be `tonyzil`, not `x-access-token`. Tell the user to revoke it after.
- Node lives in-project: `export PATH="$PWD/.toolchain/node-v22.17.0-darwin-arm64/bin:$PATH"`.
  That is an **arm64** build and was
  the wrong arch on the Intel machine one session ran on ("Bad CPU type"), which
  also breaks tsx via an arm64 esbuild. A system node (nvm v24.13.0, x86_64) was
  present there. Check before assuming either: `npm run typecheck` works
  regardless (tsc is pure JS); to run a test on a broken toolchain, compile with
  `npx tsc --outDir <tmp>` and run the emitted JS.
- In the embedded browser pane, click coordinates are in SCREENSHOT space, and
  WebAuthn ceremonies never resolve — test passkeys in a real browser.
- Check `document.compatMode === "CSS1Compat"` on any new page. Two pages
  shipped without `<!DOCTYPE html>`, and in quirks mode tables do not inherit
  colour — invoice line items rendered nearly invisible.

## Naming

- **Zoldenburg** = the company / infra brand (B2B, legal, footer).
- **Zold** = the consumer app (renamed from **Zoll** July 2026 — Zoll is German
  for "customs/toll", which named the fee at the border rather than the account).
- **Narwhal** = mascot. No narwhal emoji exists; the UI uses 🦄.
- Repo dir on disk is still `transF`; do NOT rewrite absolute paths in
  `.claude/launch.json`. GitHub repo rename is pending.
- TODO before public: domain + trademark clearance for "Zold" in fintech.

## Test suites

`npm run check` is OFFLINE and is the one to run. `npm run check:live` adds the
three Stellar suites (each pins testnet via `scripts/_stellar-testnet.ts` —
config defaults to pubnet, and a real treasury secret in .env would otherwise
submit mainnet ops).

| area | suites |
|---|---|
| money path | `fx:test` `jit:test` `best:test` `dex:test` `lifi:test` `custody:test` `execution:test` `fp5:test` `sepa:test` `refund:guard:test` |
| identity | `webauthn:selftest` `security:test` `fp4:test` `authorize:test` `passkey-safe:test` `recovery:test` `recovery:candide:test` `monerium:oauth:test` `monerium:apikeys:test` `webhook:test` |
| business | `business:test` `draft:test` `invoicing:test` `documents:test` |
| payments | `paylinks:test` `shopify:test` `shopify:orders:test` `receipt:test` `pay:test` `crypto:test` `convert:test` |
| ops | `reconcile:test` `anchor:*:test` `country:policy:test` `segments:test` `onboarding:test` `gnosispay:test` |
| live (network) | `travelrule:test` `trustline:test` `stellar:payout:live` `anchor:test` `eur:proof` |

## What has never run

Say this plainly rather than letting the surface imply otherwise:

- **No mainnet deploy.** No 8453 entry in `deployments.json`; needs funded
  operator keys the user holds.
- **No real money has moved through a swap.** No dex/LI.FI/RFQ/CoW swap has
  executed; no Base Sepolia send has exercised execution → debit.
- **The cash rail has never opened.** Bridge live mode is entirely unexercised,
  CCTP has never executed live, and the anchor-attribution half of the Stellar
  payout has never run — only the on-ledger payment half is proven (tx
  `60528481…`, ledger 3965805). testanchor never publishes
  `withdraw_anchor_account`, so MoneyGram's own anchor is where the bugs will be.
- **No real Monerium production OAuth app is registered**, and no real
  client-credentials token has been used. The OAuth cookie binding and the
  refresh client-id change are unproven against the real server.
- **No Shopify app is registered** and no store has installed one; the
  payments-app route additionally needs approval into Shopify's Payments Apps
  program, which is uncertain, not merely slow — hence `custom-app` is the
  default mode.
- **No Candide recovery service has been called** (stub only); no on-chain
  guardian add, execute or finalise, no real OTP.
- **No mail transport exists.** Invitations, invoice links and recovery emails
  are never sent by Zold; routes return the token to the caller and say so. Do
  not add a "we emailed them" string without adding a transport.
- **Imported wallets never sync** (`sync.status` stays `pending`), so the ledger
  is empty and the screens say so.
- **PWA install on iOS is untested**: a home-screen web app may get storage
  separate from Safari, and the device key lives in localStorage — onboarding in
  Safari then installing could strand an account.
- Timeout values everywhere were chosen, not measured.

**PARKED, and it gates one customer**: merchant-book privacy. One Safe per
account means anyone who ever paid a merchant can read every incoming payment
and the balance in an explorer. Per-order forwarding does not fix it (same Safe,
one hop later); stealth Safes do, and that is weeks of work. Do not put the
Shopify path in front of a privacy-sensitive merchant until it exists.

## Roadmap (agreed priority)

Condensed. Per-partner detail — dLocal's sandbox, Mony's fee and KYC-tier
constraints, Immersve's three funding protocols, the verified Monerium sandbox
chain names — is in `docs/notes/roadmap-and-partners.md`.

0. **Payout partners**: dLocal (stablecoin-funded payouts, 60+ markets) and
   Yellow Card (Africa, settles natively in USDC). Both uncontracted. Pin down
   settlement currency, prefunding, fees/FX, recipient KYC ownership, caps.
1. **Iron** (iron.xyz) sandbox → USD/GBP funding. Request-based access; the user
   must request it. EUR stays direct-Monerium.
2. **Mony partnership** (UPI One World): stablecoin top-up via our SEPA exit.
   Their inbound is manual screenshot reconciliation — the pitch is that we
   become their reconciliation layer.
3. **Chain choice is open, not settled.** EURe is on six chains; LI.FI quoted
   best on Base, CoW's EURe depth is on Gnosis, and Monerium market-makes on
   Bebop on Ethereum. Decide on liquidity and gas deliberately.
4. **Card rail — Immersve** (Mastercard principal member, so the issuer rather
   than a reseller; Base and Polygon both covered). The catch: **USDC/USDT only,
   no EURe**, so a card puts EUR/USD FX between a balance and a spend — which
   disappears on the *recipient* side. They run their own KYC, so it is a second
   identity relationship, not a reuse of Monerium's. Read the 1inch Aqua
   sections of `docs/notes/roadmap-and-partners.md` before relying on this:
   Immersve withdrawals are NOT permissionless, the Bank of Lithuania cut its
   EEA issuer channel (Dec 2025), Kulipa is dead, and Exodus now owns Baanx and
   Monavate. Proposal only; nothing card-side is built.

Parked deliberately: NEAR Intents, Metastable, Flexa/AMP (wrong market).

## Multi-agent workflow (THREE+ agents work this repo)

Claude sessions, OpenClaw, `pinky/*` and `baer/*` all commit here.

- Branch prefixes: `claude/*` for Claude sessions. **Never push to a branch
  another agent created.**
- main is PR-merge only. Before merging, confirm the PR head SHA equals the
  commit you last pushed; after merging, grep the tree — "merged: true" is not
  proof. PR #3 silently dropped a pushed commit this way.
- Start every session with `git fetch`; expect main to have moved mid-session.
- **2026-09-24: every branch except main was deleted**, locally and on GitHub,
  at the user's request — including unmerged `baer/*`, `pinky/*`, `docs/*` and
  five `claude/*` branches. Work that exists only in another agent's clone must
  be re-pushed from there; do not assume an old branch name still resolves.
- A grep count of zero is not proof either: confirm the file is READABLE first.
  (zsh treats `:s/` in `$REF:services/...` as a substitution modifier, which
  mangled the ref and made a landed change read as absent.)

## Style

- Prose without AI-marketing jargon: what is real vs simulated, specifics over
  adjectives, shortcuts stated openly.
- Honest assessments over cheerleading. Say what is mocked.
