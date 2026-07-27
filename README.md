![Zold](assets/readme-banner.png)

# Zold

A remittance app that settles on stablecoin rails. Built by **Zoldenburg**,
the cross-border payments infrastructure underneath it. 🦄

Money comes in by SEPA transfer to a per-user IBAN and lands on-chain as
e-money in the user's Safe smart account. It goes out three ways: cash pickup
in Kenya, bank transfer to any IBAN, or an
instant UPI payment in India. The app quotes each route with the fee and FX
spread shown, executes the on-chain legs, and tracks every transfer through
a state machine to PAID.

This is a prototype, but less of it is fake than you'd expect. A surprising
amount of regulated financial infrastructure is reachable today without a
single commercial agreement — that fact is the whole reason this project
exists. See [ARCHITECTURE.md](ARCHITECTURE.md) for the platform design and
the business reasoning.

## What's real

Running this repo with sandbox credentials, today:

- **IBANs**: every new user gets a real IBAN from Monerium's sandbox,
  attached to their own smart account. SEPA deposits mint EURe on-chain.
- **Balances**: API responses include both `safeBalanceEur` (real EURe held by
  the user's Safe) and `vaultBalanceEur` (the RemitVault ledger). `balanceEur`
  remains the primary spendable balance for the current vault-first executor:
  the vault ledger.
- **Wallets**: each user's account is a Safe smart account, deployed to
  Sepolia through Candide's bundler. Deployment costs the user nothing;
  gas is sponsored. Monerium verifies ownership via EIP-1271, so the IBAN
  belongs to the contract wallet, not to us.
  A passkey registration now also records the deterministic 2-of-2
  passkey/co-signer Safe that will replace the legacy server-owned Safe once
  client-signed UserOps are wired. With `CANDIDE_COSIGNER_ADDRESS` and
  `CANDIDE_COSIGNER_KEY` configured, onboarding can deploy that Safe through a
  passkey-signed, co-signed Candide UserOperation before funding.
- **Bank payouts**: the exit rail places real Monerium redeem orders —
  EURe is burned and a SEPA transfer goes out. (It needs EURe in the Safe
  to succeed; without it, the order is rejected and the app falls back to a
  simulation and records why.)
- **Cash pickup protocol**: the MoneyGram leg speaks SEP-10 and SEP-24 —
  the same protocol MoneyGram's anchor runs — verified live against
  Stellar's public test anchor. Production MoneyGram is a config change
  plus a partnership.
  Partner onboarding must supply the anchor domain, production asset, whether
  custodial SEP-10 auth needs a positive integer user memo (`MG_AUTH_MEMO`),
  and whether MoneyGram expects client-domain attribution
  (`MG_CLIENT_DOMAIN` + `MG_CLIENT_DOMAIN_SIGNING_SECRET`).
- **Bridge**: a CCTP v2 worker is wired against the real Base Sepolia
  contracts and Circle's attestation API for the Base → Stellar leg.
  It runs in dry-run mode until `npm run cctp:readiness` sees a funded Base
  Sepolia burner and Stellar treasury, then `CCTP_LIVE=1` submits burn,
  attestation polling, and Stellar `mint_and_forward`.
- **Passkeys**: onboarding registers a WebAuthn credential and returning
  users sign in with it.
- **Travel Rule data**: cash pickup is a money transmission, so the anchor is
  told who is sending — name, date of birth, address and identity document,
  mapped to SEP-9 fields and sent over SEP-12 before the withdrawal opens. If
  the anchor requires something the sender profile lacks, the payout is refused
  with the missing fields named rather than opening a session that can never
  complete. Each user gets a distinct SEP-12 customer via a derived memo, so one
  user's identity is never attributed to another's payout.
- **KYC gate**: local demos auto-approve by default, but `KYC_AUTO_APPROVE=0`
  starts users as `pending`; IBAN issuance, deposits, device binding, quotes,
  and transfers fail closed until a review approves the account. The app shows
  pending/rejected/manual-review states instead of provisioning forever. The
  pending screen splits users between connecting an existing Monerium account
  and the normal identity-review path. The included mock review endpoint is for
  local tests only, not a regulated provider.
- **Existing Monerium accounts**: a user who already banks with Monerium can
  connect that account (OAuth Authorization Code + PKCE) instead of repeating
  KYC. Their tokens are encrypted at rest and never reach the browser; the app
  links its own Safe and requests a *new* app IBAN rather than moving theirs.
  `npm run monerium:oauth:test` drives the whole loop against a stub that
  verifies the PKCE itself. Unproven until someone connects a real Monerium
  account in a browser: that Monerium's authorize page accepts our registered
  client_id/redirect_uri.

## What's simulated

- The settlement chain is a local Hardhat node. EURe and USDC there are
  mock tokens; deposits from the Monerium sandbox are mirrored into the
  local vault rather than being the same coins.
- Live Monerium deposits mint real EURe to the user's Safe. The UI shows both
  the Safe balance and the vault ledger balance. The current transfer executor
  selects a funding source per transfer: vault ledger first for local/mock
  compatibility, otherwise Safe-held EURe when available. Safe-funded SEPA
  redeems directly from the Safe after collecting the fee; Safe-funded cash/UPI
  move the exact signed amount to the orchestrator for the existing FX path.
  These one-time Safe operations still rely on the legacy server-held Safe owner
  key until FP4 custody replaces that key with passkey/co-signer approval. A
  Safe-funded failure refunds to the Safe whatever actually left it — the fee on
  SEPA, the full amount on the FX rails — and the daily cap counts both pots as
  one budget rather than giving each its own.
- The Safe-funded path has no on-chain replay guard. `RemitVault.debit` refuses
  a transferId it already processed; a plain transfer out of the Safe cannot
  write that registry, so the checks are the vault's registry (read, not
  written) plus this API's own record. Neither survives a restored `db.json` or
  a second API instance, and closing that needs a registry the contract writes.
  Nor can the path run locally at all — the Safe move goes through Candide's
  bundler and paymaster, which no hardhat node provides, so only what happens
  after the debit is covered by tests.
- FX rates come from constants, not an oracle. The swap contract is a
  stand-in for a DEX route.
- The UPI partner and the MoneyGram payout (in mock mode) return generated
  reference numbers. The shapes match the real APIs so swapping in a
  licensed partner is adapter work.
- Sender identity data (date of birth, address, ID number) is stored in
  `data/db.json` in plaintext, next to the Safe keys. A real deployment must
  leave it with the KYC provider and keep only a reference here. Document
  images are refused outright rather than stored.
- Users' Safe owner keys live in `data/db.json`. Custodial, plainly.
  The passkey is an auth factor today; making it the Safe's owner is the
  planned fix.

## Running it

You need Node 22 or newer. Nothing else.

```sh
npm install
npm run compile        # build the contracts
npm run test:contracts # 38 tests against a throwaway chain
npm run e2e            # one script: deposit, then all three payout rails
npm run dev            # chain + contracts + API + UI on localhost:3000
```

The API binds to `127.0.0.1` by default. Set `TRANSF_API_HOST` only for a
deliberate remote demo; mock mutation endpoints stay disabled on non-local
hosts unless `ALLOW_SIMULATION=1` is also set.

[TESTING.md](TESTING.md) is a step-by-step walkthrough, including the
sandbox setups. The short version:

- **Mock mode** (no accounts anywhere): everything works out of the box.
- **Monerium sandbox**: create a free app at [monerium.dev](https://monerium.dev),
  put the credentials in `.env` (copy `.env.example`), and user creation
  starts doing the real thing. `npm run monerium:check` verifies the setup.
- **Anchor mode**: set `MG_ANCHOR_DOMAIN=testanchor.stellar.org` and cash
  pickups create real SEP-24 withdrawals. `npm run stellar:check` proves the
  whole protocol run in about ten seconds.
- **CCTP**: `npm run cctp:dryrun` prints the exact transactions it would
  send. Fund a key with Sepolia ETH and USDC from
  [faucet.circle.com](https://faucet.circle.com), set `CCTP_LIVE=1`, and it
  sends them.

## How it's put together

```
services/api/src/
  server.ts          HTTP API + static UI
  orchestrator.ts    transfer state machines, one per rail
  fx.ts              quoting (rates, spread, fees)
  store.ts           JSON file store; stands in for a real ledger
  chain.ts           viem clients for the local chain
  adapters/          monerium (real), moneygram/anchor, upi (mock)
  wallet/candide.ts  Safe deployment + EIP-1271 signing
  bridge/cctp.ts     Base -> Stellar burn/attest/mint worker
  stellar/anchor.ts  SEP-10 auth, SEP-24 withdrawals
contracts/src/       RemitVault, FxSwapper, BridgeEscrow, MockToken
services/api/public/ the UI — one HTML file, no build step
scripts/             deploy, dev stack, e2e, sandbox checks
```

The design rule throughout: every external service sits behind an adapter,
and each adapter has a mock that matches the real API's shape. Monerium
graduated from mock to real without touching the orchestrator. The intent
is that MoneyGram, the UPI partner, and the USD side do the same.

Contracts are deliberately small. `RemitVault` is the old/mock custody ledger:
it holds per-user balances with a daily cap, idempotent deposit references,
and idempotent transfer IDs. In the Safe-first Monerium path, real EURe lands in
the user's Safe; today it may be swept into the vault by the server-held Safe
key, and the remaining migration is to move the vault's policy and replay
controls to a user-authorized Safe-funded transfer initiation path.
`FxSwapper` swaps at an owner-set rate behind a slippage guard, restricted
to approved executors and pausable by the owner.
`BridgeEscrow` locks funds for the bridge leg, prevents completed transfer
IDs from being reused, and can refund only to the target bound at lock time.
No inheritance forest, no proxy patterns — they're
meant to be read in one sitting.

## Things to know before relying on it

- `npm run dev` resets the local chain and the demo users each start.
- Quotes lock a rate for ten minutes; nothing hedges the exposure.
- Production must set `KYC_AUTO_APPROVE=0` and replace the local mock-review
  seam with a real KYC provider before issuing IBANs or allowing payments.
  Pending or rejected accounts are visible in the UI, but the approval decision
  must still come from a provider/operator path, not the user's own session.
- Existing Monerium users need a per-user OAuth connection before they can skip
  duplicate KYC. The repo has the path-selection seam; see
  [HANDOFF-MONERIUM-CONNECT.md](HANDOFF-MONERIUM-CONNECT.md) for the remaining
  OAuth and IBAN-linking work.
- Monerium webhooks verify the documented `webhook-signature` HMAC when
  `MONERIUM_WEBHOOK_SECRET=whsec_...` is set; leave it unset only for local
  sandbox polling or stubbed tests.
- The default Hardhat keys are refused on non-local RPC URLs unless
  `ALLOW_DEV_KEYS_ON_EXTERNAL_RPC=1` is explicitly set.

None of these are surprises buried in the code; they're all flagged where
they live.
