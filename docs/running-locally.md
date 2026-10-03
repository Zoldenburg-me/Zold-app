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

Imported wallets sync only on chains with an RPC: `WALLET_SYNC_RPC_1=https://…`
(or `WALLET_SYNC_RPCS='{"1":"https://…"}'`). Locally, point
`WALLET_SYNC_RPC_31337` at the hardhat node and set
`WALLET_SYNC_CONFIRMATIONS=0`; a MockToken mint to an imported address is then
booked within one poll (`WALLET_SYNC_POLL_MS`, default 60 s). Classing a
token needs the curated lists (`WALLET_SYNC_TOKEN_LISTS`, default Uniswap +
CoinGecko) fetched once a day; offline, point it at a local JSON in the
tokenlists.org shape, or the window holds with "Waiting for the token lists".

To fund locally: mint MockToken EURe straight to the user's Safe from hardhat
account 0 (the token owner) and `refresh()` picks it up.

To see the KYC gate locally, `npm run dev` cannot do it (`scripts/_test-env.ts`
sets `KYC_AUTO_APPROVE=1`). Run a second API against the chain dev.ts started —
`TRANSF_API_PORT=3001 TRANSF_CHAIN_ID=31337 KYC_AUTO_APPROVE=0 RP_ID=localhost`
with the operator `*_KEY` vars **blanked** (.env holds real Base Sepolia keys
that do not own the local deployment).

## Browser pane and new pages

- In the embedded browser pane, click coordinates are in SCREENSHOT space, and
  WebAuthn ceremonies never resolve — test passkeys in a real browser.
- An agent or scanner that needs a signed-in account (a pentest, say) uses
  `scripts/pentest-user.ts`: a software passkey that signs up and logs in
  through the real routes and prints a 24h session token. Its key files sit in
  the git-ignored `.private/pentest/`; holding one is holding the account.
- Check `document.compatMode === "CSS1Compat"` on any new page: without
  `<!DOCTYPE html>` tables do not inherit colour.

## The production branch

Deploys run `production`, not main. It holds only what the server needs at
runtime: `services/api/{src,public,site}`, the compiled contract ABIs that
`chain.ts` loads at import, a `package.json` with runtime dependencies only
(tsx included) and its lock. No docs, design, tests, scripts, Solidity, hardhat
or Shopify extension.

```bash
scripts/build-production-branch.sh
git push origin production
```

Each run adds one commit whose tree is main's tree through that allowlist and
whose message names the main commit. On the host: `npm ci --omit=dev`, write
`deployments.json`, `npm start`; there is no `hardhat compile` step.

Rules, because whatever is on `production` is what zoldhq.com runs:

- **Only the script writes it**, and only from `origin/main` after a merge.
  Never commit, merge main, cherry-pick, rebase, reset or force-push. A fix
  goes through a PR to main, then a rebuild.
- **Never build from an unmerged branch.** The script's argument exists for
  re-snapshotting an older main commit, not for shipping a branch.
- **Roll back by deploying an older production commit** (`ZOLD_COMMIT=<sha>`
  for `make-sdl.mjs`), never by moving the branch back. History only grows.
- **A file the server newly needs at runtime goes in the script's allowlist**
  in the same PR. Then check a clean checkout boots: `npm ci --omit=dev`,
  `npm start`, `/api/health`. The ABIs were found this way.
- On GitHub, `production` should be protected against force-pushes and
  deletion (Settings → Branches). Regular pushes stay allowed, since the
  script only adds commits.

## Test suites

`npm run check` is OFFLINE and is the one to run. `npm run check:live` adds the
three Stellar suites (each pins testnet via `scripts/_stellar-testnet.ts` —
config defaults to pubnet, and a real treasury secret in .env would otherwise
submit mainnet ops).

| area | suites |
|---|---|
| money path | `fx:test` `jit:test` `best:test` `dex:test` `lifi:test` `custody:test` `execution:test` `quote-binding:test` `sepa:test` `refund:guard:test` |
| identity | `webauthn:selftest` `security:test` `device-key:test` `authorize:test` `passkey-safe:test` `safe-signers:test` `recovery:test` `recovery:candide:test` `monerium:oauth:test` `monerium:apikeys:test` `webhook:test` |
| business | `business:test` `draft:test` `draft:failure:test` `invoicing:test` `documents:test` |
| bookkeeping | `statement:test` `beleg:test` `lexware:csv:test` `exact-output:test` `gmi:test` (offline, fake server); `gmi:smoke` is read-only against the real account and is NOT in check |
| payments | `paylinks:test` `shopify:test` `shopify:orders:test` `receipt:test` `pay:test` `crypto:test` `convert:test` |
| ops | `reconcile:test` `anchor:*:test` `country:policy:test` `segments:test` `onboarding:test` `gnosispay:test` |
| live (network) | `travelrule:test` `trustline:test` `stellar:payout:live` `anchor:test` `eur:proof` |

