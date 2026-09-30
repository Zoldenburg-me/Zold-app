# Running the app and the tests

Linked from `AGENTS.md`.

## Dev vs api

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

`npm run preflight` asks every Candide endpoint the configured chain and gas
mode depend on whether it will do its job — bundler, paymaster (with a
throwaway deployment op, never signed), recovery module and service,
forwarding — and exits 1 on any FAIL. `--chain 8453 --gas token` overrides.

`npm run dev` wiping its own db is why test accounts vanish between runs — and
why the live accounts in `data/db.json` must never be exercised with it.

To fund locally: mint MockToken EURe straight to the user's Safe from hardhat
account 0 (the token owner) and `refresh()` picks it up.

To see the KYC gate locally, `npm run dev` cannot do it (`scripts/_test-env.ts`
sets `KYC_AUTO_APPROVE=1`). Run a second API against the chain dev.ts started —
`TRANSF_API_PORT=3001 TRANSF_CHAIN_ID=31337 KYC_AUTO_APPROVE=0 RP_ID=localhost`
with the operator `*_KEY` vars **blanked** (.env holds real Base Sepolia keys
that do not own the local deployment).

## Test suites

`npm run check` is OFFLINE and is the one to run. `npm run check:live` adds the
three Stellar suites (each pins testnet via `scripts/_stellar-testnet.ts` —
config defaults to pubnet, and a real treasury secret in .env would otherwise
submit mainnet ops).

| area | suites |
|---|---|
| money path | `fx:test` `jit:test` `best:test` `dex:test` `lifi:test` `custody:test` `execution:test` `quote-binding:test` `sepa:test` `refund:guard:test` |
| identity | `webauthn:selftest` `security:test` `device-key:test` `authorize:test` `passkey-safe:test` `safe-signers:test` `recovery:test` `recovery:candide:test` `monerium:oauth:test` `monerium:apikeys:test` `webhook:test` |
| business | `business:test` `draft:test` `invoicing:test` `documents:test` |
| bookkeeping | `statement:test` `beleg:test` `lexware:csv:test` `exact-output:test` `gmi:test` (offline, fake server); `gmi:smoke` is read-only against the real account and is NOT in check |
| payments | `paylinks:test` `shopify:test` `shopify:orders:test` `receipt:test` `pay:test` `crypto:test` `convert:test` |
| ops | `reconcile:test` `anchor:*:test` `country:policy:test` `segments:test` `onboarding:test` `gnosispay:test` |
| live (network) | `travelrule:test` `trustline:test` `stellar:payout:live` `anchor:test` `eur:proof` |

