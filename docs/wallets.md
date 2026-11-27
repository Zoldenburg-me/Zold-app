# Wallets

No deployment may depend on a key nobody can find. Every wallet a deployment
configures is in `wallets.json` (repo root, keyed by chain id like
`deployments.json`) with its role, the setting that names it and who holds its
key. `npm run preflight` refuses a real-money chain when a configured wallet is
missing there, is registered under another setting, or has `keyHolder:
"unknown"`; on a test chain the same gaps are WARN lines.

The repo is public. `wallets.json` holds addresses (public on chain anyway),
roles and setting names, never a key and never where one is kept. Where each
key lives, and its backup, is in the owner's private notes.

## Adding or changing a wallet

1. The owner creates or chooses the wallet and writes in their private notes
   where the key and its backup are.
2. A PR adds the address to `wallets.json` under every chain it serves:
   `role`, `env` (the setting names), `keyHolder`.
3. Only then does the address or key go into the deployment's env.
4. `npm run preflight -- --chain <id>` with that env passes the `wallets`
   section. A FAIL line names the setting and the address; the key never
   appears.

`keyHolder`:
- `server` — the key is in the deployment's encrypted env file, so it is as
  findable as that file and its decryption key.
- `owner` — the owner holds it outside the server (hardware wallet, password
  manager); the server knows only the address.
- `unknown` — nobody can sign for it. Kept in the file so preflight names it
  if it comes back; it has to be replaced.

## The roles

| Role | Setting | Key | Chains |
|---|---|---|---|
| Candide custodial withdrawer: recovers a payment-page deposit stuck in its forwarding address, after Candide's timelock | `CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER` (address) | owner; it withdraws with a transaction on the chain the deposit went to, so it must exist at its address on every source chain a page accepts: an EOA, or a Safe deployed at the same address on each. Mainnet pages accept Base only (`CANDIDE_FORWARDING_SOURCE_CHAIN_IDS` unset), where the mainnet withdrawer Safe is deployed | Base mainnet. Base Sepolia pages take zUSD straight into the Safe and do not use it |
| Zoldenburg recovery guardian | `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` (address) | owner, hardware wallet only (`docs/recovery-and-signers.md`) | both |
| Orchestrator: receives fees, submits payout steps | `ORCHESTRATOR_KEY` / `DEPLOY_ORCHESTRATOR_KEY` | server | both |
| Ramp | `RAMP_KEY` / `DEPLOY_RAMP_KEY` | server | both |
| Relay: pays gas for calls anyone may make, holds nothing else | `RELAY_KEY` | server | both |
| ENS gateway signer | `ENS_GATEWAY_KEY` | server | where ENS is on |
| Testnet faucet and zUSD owner ("the vanity account") | `FAUCET_KEY` | server; refused on a real-money chain | Base Sepolia |
| Contract deployer and admin | `DEPLOYER_KEY` / `DEPLOY_DEPLOYER_KEY` | owner; the deploy machine, never the server off the local chain | where we deploy contracts |
| Cash-rail destination | `BRIDGE_DESTINATION_ADDRESS` (address) | set only when the cash rail opens | — |

`STELLAR_TREASURY_SECRET` is a Stellar key, outside this check; the cash rail
is closed. Contract addresses (recovery module, ENS resolver, tokens) are not
wallets and live in `deployments.json` or code.

## Replacing the mainnet custodial withdrawer

The Akash mainnet lease still uses the old withdrawer, whose `keyHolder` is
`"unknown"`, so preflight fails on its env. The replacement,
`0x222222222211B5eB5be634822404F66f1A3adB00` (a Safe whose signer is the
owner's hardware wallet, also the Zoldenburg recovery guardian), is registered
and set in the Oracle host's mainnet env. It takes effect at the cut-over,
and from then on steps 4 to 6 apply. Adding a source chain to
`CANDIDE_FORWARDING_SOURCE_CHAIN_IDS` first needs that Safe deployed at the
same address on the new chain.

A forwarding address is computed from recipient, custodial withdrawer,
destination chain and salt (`forwarding_getAddress`). A new withdrawer
therefore gives every Candide payment page a new deposit address.

1. **New wallet.** The owner creates a hardware-wallet EOA, or a Safe
   deployed at the same address on every source chain, and records it
   privately. The role needs the same address on every chain a page accepts:
   recovery is a transaction on the chain the deposit went to.
2. **Register.** A PR adds it to `wallets.json` under `8453` with `env:
   ["CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER"]`, `keyHolder: "owner"`. The old
   entry stays as `unknown`.
3. **Configure.** Set `CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER` to the new
   address in the mainnet env and run `npm run preflight -- --chain 8453`
   with it. Push the env to the mainnet lease.
4. **Pages close at renewal.** A page keeps showing its old address while
   that activation is live. When `livePaymentPage` next renews it (activation
   close to expiry), it gets a different address than the page shows and
   answers 503 `PAGE_UNAVAILABLE`; it never swaps the address silently.
5. **Re-activate each page.** The page's owner saves their handle again
   (`POST /users/:id/handle`, the payment-page form in the app). That
   activates the new address at Candide and stores it on the page. The
   `/pay/<handle>` link stays the same; only copies of the raw address or its
   QR code are stale.
6. **Old addresses.** Candide keeps forwarding to the recipient from an old
   address until its activation expires; after that, deposits there stay put.
   Anything at an old address (expired, below the bridge minimum, or an
   unlisted token) can be withdrawn by the recipient Safe on that chain at
   once, if the Safe exists there, or by the old withdrawer after the
   timelock. Nobody holds the old withdrawer's key, so tell anyone who saved
   the old address or QR to use the page link instead.

Recovery itself: [forwarding-address.candidelabs.com](https://forwarding-address.candidelabs.com/),
signed by the custodial withdrawer or the recipient on the source chain.
