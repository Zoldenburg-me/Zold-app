# Testing Zold end to end

Everything below runs on macOS/Linux with **Node.js ≥ 22** and free ports
`3000`, `8545`, `8546`. No other system dependencies.

```sh
npm install
npm run compile
```

## Level 0 — automated checks (5 min, no accounts needed)

```sh
npm run test:contracts   # 41 Solidity tests: vault caps/roles/replay + FP4 auth, FX access/slippage, escrow, AdminTimelock governance
npm run e2e              # full corridor: cash pickup + SEPA exit
npm run audit:deps       # npm advisory scan
npm run check            # everything: the two above plus ~25 focused harnesses
```

`npm run check` is the one that matters before pushing — it allocates a random
free port for the whole run, which is why a suite passing on its own is weaker
evidence than it looks. Note it is not fully deterministic: `trustline:test`
reaches MoneyGram's real anchor and fails if that host is unreachable.

Both must end green (`41 tests passed`, `E2E PASSED`). The e2e boots its own
chain + API, so stop `npm run dev` first if it's running (it will tell you).

## Level 1 — the app in mock mode (10 min, no accounts needed)

```sh
npm run dev              # then open http://localhost:3000/app
```

`/` serves the landing page; the app is at `/app`.

1. **Onboarding** — enter a name, "Open my account". The setup screen steps
   through instantly in mock mode and lands on the dashboard. You get an IBAN
   (mock-issued) and a real Candide Safe smart-account address (computed
   offline, same tech as production).
2. **Add money** — deposit €250. Watch the balance: this is a real ERC-20 mint
   + vault credit on the local chain.
3. **🇰🇪 Cash pickup** — send €100. Expect: quote with mid-market rate, 0.50%
   spread, €0.99 fee → animated timeline of 5 real transactions (debit,
   FX-swap approve, EURe→USDC swap, bridge approve, escrow lock) → amber
   MoneyGram-style pickup reference → "Simulate cash pickup" → escrow settles,
   history flips to PAID.
4. **🏦 Bank transfer** — send €40 to any IBAN. Expect: fee-only quote
   (€39.01), single debit tx, simulated SEPA payout, PAID.

KYC-gated mode: start the API with `KYC_AUTO_APPROVE=0`. A new account should
land on the Identity review screen instead of the provisioning spinner. The
screen asks whether the user already has a Monerium account. Choosing the
existing-account path records that branch for the upcoming OAuth build; choosing
the new-account path continues the normal identity-review state. The dashboard
can still be opened, but add-money and send controls stay unavailable until the
account becomes `approved`.

## Level 2 — real sandboxes (optional, ~20 min setup)

### Monerium (real IBANs on real smart wallets)

1. Create a (free) sandbox app at <https://monerium.dev> → copy credentials.
2. `cp .env.example .env`, fill `MONERIUM_CLIENT_ID` / `MONERIUM_CLIENT_SECRET`.
3. `npm run monerium:check` — must print `auth ok`.
4. `npm run dev` → create a user. The onboarding steps now run for real
   (~30s): Safe deployed gasless on Sepolia via Candide's public bundler,
   address linked to Monerium via EIP-1271, real sandbox IBAN issued.
5. Fund it: log into the sandbox portal → *Receive* → simulate a SEPA
   transfer to the user's IBAN. Real test EURe mints to the Safe on Sepolia;
   the app mirrors it into the vault within ~15s.
   (Shortcut without the portal: `npx tsx scripts/credit-test.ts <smart-account-address> 250`)
6. **Real exit flow**: after a portal deposit, a 🏦 Bank transfer places a
   real Monerium redeem order (watch `sepa.orderId` on the transfer, state
   PAYOUT_SUBMITTED → PAID). Without a portal deposit it falls back to a
   simulated payout and records Monerium's actual rejection on the transfer.

### Stellar anchor (the MoneyGram protocol, live)

```sh
npm run stellar:check    # friendbot treasury + SEP-10 auth + SEP-24 withdrawal
```

Runs against Stellar's public test anchor — no signup. With
`MG_ANCHOR_DOMAIN=testanchor.stellar.org` in `.env`, cash-pickup transfers
create real SEP-24 withdrawals (the ticket links the anchor's interactive
page).

For production MoneyGram, confirm the partner-specific SEP-10 auth settings
before using live credentials: `MG_AUTH_MEMO` for custodial positive-integer
user memos, plus `MG_CLIENT_DOMAIN` and `MG_CLIENT_DOMAIN_SIGNING_SECRET` if
MoneyGram requires client-domain attribution.

Stellar variables the code understands:

- `MG_ANCHOR_DOMAIN` — anchor home domain, for example `testanchor.stellar.org`
- `MG_ANCHOR_ASSET` — withdrawal asset. Defaults to `SRT` for the public test
  anchor and `USDC` for MoneyGram domains; setting a non-`USDC` MoneyGram asset
  fails at startup.
- `STELLAR_TREASURY_SECRET` — treasury signer for SEP-10 auth and on-ledger
  SEP-24 payment
- `STELLAR_HORIZON`, `STELLAR_SOROBAN_RPC`, `STELLAR_PASSPHRASE`,
  `STELLAR_FRIENDBOT` — default to public Stellar testnet endpoints

The treasury must hold the anchor asset and have the required trustline.
`testanchor.stellar.org` can use `native` with no trustline for protocol
tests, but production MoneyGram/USDC requires the partner-confirmed asset.

### CCTP bridge (Base Sepolia → Stellar testnet)

```sh
npm run cctp:dryrun      # prints the exact burn/attest/mint plan, moves nothing
npm run cctp:readiness   # validates live CCTP env + balances, moves nothing
```

To execute for real: fund an EOA with Base Sepolia ETH (any faucet) + testnet
USDC (<https://faucet.circle.com>), set `CCTP_BURNER_KEY`,
`STELLAR_TREASURY_SECRET`, and `CCTP_LIVE=1`.

`npm run cctp:readiness` also checks the Stellar CCTP contract strkeys:
`CCTP_STELLAR_FORWARDER` and `CCTP_STELLAR_MSG_TRANSMITTER`. They default to
the current testnet values in `services/api/src/config.ts`; override them only
when Circle/Stellar publishes new deployments.

## Known limitations (by design, MVP)

- Settlement chain is a local Hardhat node; EURe/USDC there are mocks.
- Owner keys of user Safes are stored server-side (`data/db.json`) — custodial
  MVP; passkey owners are the production path.
- The MoneyGram payout is a protocol-shaped mock unless pointed at a real
  anchor.
- Fresh `npm run dev` resets the local chain + demo users (`data/db.json`).

## Liquidity venues

```sh
npm run lifi:test   # 16 checks — aggregated routes bound, wrong answers refused
npm run dex:test    # 12 checks — pool prices checked against an independent mid
npm run best:test   # 13 checks — better price wins, surplus measured
```

All three are offline. What they cannot cover is a real swap: LI.FI publishes
no testnet, and Base Sepolia has no EURe/USDC pool. `npm run dex:setup` reports
exactly what is missing and refuses rather than half-running; `-- --fix` creates
and seeds a pool once the treasury holds EURe.

## Stellar payout

```sh
npm run stellar:check         # SEP-10 + SEP-24 against Stellar's test anchor
npm run trustline:test        # 9 checks — the payout account can receive the asset
npm run stellar:payout:live   # drives a real testnet payment as far as the anchor allows
```

`stellar:payout:live` proves the ledger half — a real memo-carrying payment
lands — then stops, because the test anchor never publishes a withdrawal
account over SEP-24 or SEP-6. It completes unchanged against an anchor that
does.
