# Punch-list: what stands between here and a safe hosted demo

Written at main `ca6c5e6`. Everything the current session could do solo and
verify is merged. This is the remaining work, grouped by **what unblocks it** —
because the blocker, not the difficulty, is what decides who does each item and
when.

Legend for the blocker column:
- **OWNER** — needs something only the repo owner can supply (funding, real
  hardware, a hosted domain). No agent can finish or even verify it without this.
- **OPENCLAW** — lives in files OpenClaw is actively editing (`orchestrator.ts`,
  the funding flow). Two agents in that file is how the #18/#23 merge-ordering
  drop happened. Assign, don't race.
- **MULTI** — genuinely multi-session; touches many layers or needs a real
  browser to prove.

---

## P0 — the one unblocker everything else waits on

### 1. Deploy the settlement contracts to a public chain (Polygon Amoy)  · OWNER
The whole system settles on a local Hardhat node. `chain.ts` pins
`chain: hardhat` on every client, and `config.ts` **throws** if the dev keys
meet a non-local RPC (`ALLOW_DEV_KEYS_ON_EXTERNAL_RPC` guard). A hosted API has
no local chain, so nothing below is real until this is done.

- Amoy is the verified target: Monerium's sandbox chain name is confirmed, and
  EURe is native there, which also deletes the mirror seam + reconciler.
- Un-pin `chain.ts` (parametrize the viem chain from config), deploy
  RemitVault / FxSwapper / BridgeEscrow / AdminTimelock to Amoy, wire roles,
  transfer ownership to the timelock, write the addresses to `deployments.json`.
- **Prereq (owner):** an Amoy RPC, funded deployer/orchestrator/ramp keys
  (real, not the hardhat defaults), and Monerium configured for Amoy.
- **Done when:** `npm run e2e` passes against Amoy with real EURe, and the
  hardhat-key guard is satisfied by real keys rather than bypassed.
- **Note:** this is item B in `HANDOFF-CCTP-SEP24.md`, already scoped to Polygon.

---

## P1 — custody and correctness that only matter once the chain is real

### 2. Remove server-held signing keys (FP4 key-custody half)  · MULTI
`user.privateKey` is plaintext in `data/db.json`. On a hosted box, whoever reads
that file holds every user's Safe owner key — the key Monerium's IBAN is bound
to. Monerium linking and redeem orders still sign server-side with it.

- Plan (unchanged, in CLAUDE.md FP4): a Candide WebAuthn Safe owner
  (`fromSafeWebauthn`) signs the Monerium declaration + orders via the passkey;
  the passkey-owned Safe then replaces the browser EOA as the vault authorizer.
  `authorizerOf` already accepts EIP-1271 for exactly this — build against it.
- Needs client-side UserOperation signing for the gasless deploy (vendoring
  much of abstractionkit into a no-build repo) and real-browser WebAuthn.
- **Done when:** `db.json` holds no private key; a live send signs the Monerium
  redeem via the passkey-owned Safe; wrong-key still rejected on-chain.

### 3. Stop the FP3 refund path from minting  · OPENCLAW (waits on #1)
`compensateTransfer` → `simulateSepaDeposit` → `MockToken.mint`. It works only
because EURe is a mock you own. **With real EURe you cannot mint, so a failed
transfer would debit the user and never refund them** — silent, and only on a
real chain. Nobody has flagged this in the code.

- The real fix (refund from a treasury float) depends on treasury mechanics that
  don't exist until #1. But a **guard is cheap now**: fail closed / route to
  MANUAL_REVIEW when a refund would mint on a non-local chain, mirroring the
  hardhat-key guard. Do the guard before Amoy, the float after.
- **Done when:** on a non-local chain a compensating refund never calls mint;
  either it moves real value from a float or it parks in MANUAL_REVIEW.

### 4. Background driver for anchor payouts  · OPENCLAW
`PAYOUT_FUNDING_PENDING` (anchor waiting for our on-ledger payment, we haven't
sent it) and `PAYOUT_FUNDED` (we paid, anchor hasn't confirmed) are advanced
**only** by a client POSTing `/refresh-payout`. Close the tab and a funded
payout stalls forever. The FP3 sweep covers `DEBITED/SWAPPED/BRIDGED`, not these.

- Add a background sweep (like the FP3 sweep and Monerium poller) that runs
  anchor-backed transfers in those states through `refreshPayout`. It also lets
  `/refresh-payout` return immediately instead of blocking ~60s in the handler.
- **Done when:** a funded anchor payout reaches PAID with no client polling; a
  test drives a transfer to PAYOUT_FUNDED and asserts the sweep completes it.

---

## P2 — needed to actually move money end to end

### 5. Prove one live cash payout  · OWNER
No real cash has moved. SEP-24 completes only through the human interactive flow;
CCTP has never run live. The code path exists (PR #18 on-ledger payment, PR #26
CCTP wiring) but has never been exercised with funds.

- **Prereq (owner):** a funded CCTP burner (Base Sepolia ETH + testnet USDC, or
  the Amoy equivalent) and a Stellar treasury actually holding the anchor asset
  with its trustline. Note: SRT on testanchor comes via the anchor's interactive
  deposit flow, so it is not scriptable.
- testanchor caps withdrawals at 10 units — demo small.
- **Done when:** a small transfer runs debit → swap → live CCTP burn/attest/mint
  → SEP-24 on-ledger payment → anchor `completed`, with real value at each hop.

### 6. Finish the Monerium OAuth connect  · OPENCLAW
WIP already on main (`568b180`, not via a PR — worth noting it bypassed the
merge gate). The path-selection seam exists; the OAuth + IBAN-linking does not.
Full spec is in `HANDOFF-MONERIUM-CONNECT.md`. Authorization Code + PKCE,
refresh tokens encrypted server-side, never returned to the browser.

---

## P3 — operational hardening before the URL is public

### 7. Real-browser passkey PRF verification  · OWNER (5 minutes)
The one unverified FP4 claim. On your machine: register a passkey, send, **reload
the page**, send again. If the authenticator returns different PRF bytes across
ceremonies, the wrapped device key is unrecoverable after reload — a funded
account bricks. Spec says it's stable per (credential, salt); can't be proven in
the embedded pane. Do this before anyone funds a real account.

### 8. Hosting hardening  · OWNER / MULTI
- **HTTPS + `RP_ID`/`WEBAUTHN_ORIGINS`** set to the real domain, or passkeys
  break.
- **Timelock owners on separate hardware, held by different people.** Three keys
  on one machine is a 2-of-3 wearing a costume.
- **`.env` → a secret store**, off the box.
- **`db.json` → a real store** that survives restarts and concurrent instances;
  `processedMoneriumOrders` and `processedMoneriumWebhooks` grow unbounded there.
- **`npm run check` now needs network** (anchor:test, cctp:dryrun hit live
  endpoints) — split a no-network CI lane if that matters.

---

## Suggested order

1 → (3-guard, in parallel, cheap) → 7 (owner, 5 min) → 2 → 4 → 5 → 3-float → 6 → 8.

Reasoning: #1 unblocks everything and is owner-gated, so start it first. The #3
*guard* and #7 are near-free and remove silent-failure and account-bricking risk
before real funds appear. #2 is the biggest custody win and the longest job. #5
is the payoff — the first time the corridor moves real value.

## What is NOT on this list (already done, this session)
Vault authorization (FP4 spend), browser-signed payments + PRF wrapping, payout
destination binding, AdminTimelock governance + guardian pause, Monerium webhook
(real HMAC + retry-safe dedupe + replay window), the ledger reconciler, correct
anchor withdrawal amounts + payment safety, and a production KYC operator seam.
All merged, all with tests in `npm run check`.
