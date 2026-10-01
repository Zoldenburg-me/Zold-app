# Zold — notes for coding agents

For every agent here; Claude Code loads it via `CLAUDE.md`.

## Start here

This file is the map and the invariants, and it is loaded into every session.
**Budget: 12,000 characters** (`wc -m AGENTS.md`). Only what almost every task
needs goes here; everything else goes in `docs/` with a one-line pointer. Over
budget: replace or move something, do not append.

Read when the task touches it:
- `docs/status.md` — **what has never run** (no mainnet, no real swap, no cash
  rail, no on-chain recovery, no mail). Read before saying anything works.
- `docs/running-locally.md` — dev vs api, preflight, local funding and KYC
  gate, tests, the production branch.
- `docs/recovery-and-signers.md` — second owner, Zoldenburg guardian, recovery.
- `docs/roadmap.md` — agreed priority and parked ideas.
- `docs/architecture/` — product (what exists, status) and technical (how,
  routes). User docs: the `zold-docs` repo.

## How to write in this repo (comments, docs, this file, notes)

Write what is true now. When a fact changes, overwrite the line; never add an
"update", "retired (date)", "used to" or "superseded" note beside it — history
goes in the commit message. Past tense only for old data or code that still
exists, a guard against a return, or a one-clause reason. Dates only on
verified observations. Cleanup: `docs/agents/prune-history.md`.

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
  `deployments.json` is keyed by chain id; on a real chain it holds only EURe
  and USDC (FxSwapper, AdminTimelock are hardhat-only). **No 8453 entry yet.**
  The running deployment is **Base Sepolia (84532)** + Monerium sandbox at
  zoldhq.com on an Akash lease (technical-architecture §18.1): closing the
  lease deletes every tester's account.
- **Identity is Monerium's.** Onboarding: account (email required) → passkey
  (no skip) → Safe deployed → recovery enrolment → the gate offers OAuth *or*
  your own Monerium API keys → "Activate IBAN with passkey". `POST /api/users`
  always creates `pending` with no IBAN; only an address-matched IBAN approves.
  There is no KYC provider, no Sumsub, no operator review route.
- **Rails**: SEPA (Monerium redeem, non-custodial for the principal, fee €0) is
  open. The **cash rail is CLOSED** unless `cashRailOpen()` — quotes answer 503
  RAIL_CLOSED and the app hides the corridor. There is no UPI rail; do not
  build one.
- **Custody**: `LIQUIDITY.PROVIDER` defaults to `best` over `lifi,dex`, both
  Safe-executable, so the default deployment is non-custodial. The fee always
  lands at the orchestrator and `transfer.custody` records it.
- **No simulation**: no mock deposits, faucet or mock IBANs (`config.ts`
  refuses the old env vars). `/api/health` publishes `capabilities()`
  (capabilities.ts), and the UI renders a control only where the API would
  accept it.
- **The one harness seam that stays**: `KYC_AUTO_APPROVE=1` is honoured only on
  chain 31337 and refused in production; `mirrorOrder` mints the hardhat
  MockToken only on 31337. Inert on real money by construction, not config.

## Where the code lives

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
  renders goes there (an early fetch can resolve before later code exists).
  `sw.js` serves page `.js`/`.css` network-first, so a deploy needs no
  `SHELL_CACHE` bump unless the SHELL list or a vendored file changes.
  `public/business/*.js` are **ES modules**; `core.js` owns shared state.
- **server.ts owns authentication**: every router is a factory taking
  `requireUserSession`.
- Four suites grep source text (custody, passkey-safe-plan, gnosis-pay,
  passkey-safe's mount check). Moving code means moving their greps.

## Invariants

Each of these was a bug once.

**Money**
- **No debit without a user signature.** `POST /api/transfers` prepares the
  userOp that *is* the debit; the passkey signs its hash at send time and the
  chain enforces token, amount and destination. There is no standing
  allowance — the API can dispose of nothing, ever.
- **Quote binds execution.** `assertQuoteRateBinding` refuses and auto-refunds
  if the on-chain rate drifts past `FX.QUOTE_BINDING_BPS`. Persisted quotes
  execute on the venue that priced them.
- **Every venue quote is checked against an independent mid** (`assertPriceSane`
  over `rates.ts`).
- **Venue calldata is allowlisted** (`LIFI_CONTRACTS`, `BEBOP_CONTRACTS`), value
  must be 0, and you approve the spender the maker **NAMES** (`approvalTarget`,
  not `tx.to`).
- **Amounts out are MEASURED** as a balance delta, never copied from the quote.
- **Compensation is asymmetric on purpose**: only a 4xx refusal refunds; a
  timeout, a duplicate-transfer revert, or any failure after Bridge holds the
  deposit is MANUAL_REVIEW. `store.updateTransfer` refuses to move a
  REFUNDED/PAID transfer backwards.
- **Margin is measured, surplus is attributed.** `marginBps` is computed between
  the live mid and what we deliver; positive slippage goes to the user by
  default and is recorded either way.
- **The reconciler reports drift and never repairs it.**

**Identity and authority**
- **The passkey is the Safe's only owner.** The plan type is `threshold: 1`
  only. Never add a co-owner that Zold holds: the user could then not move
  their own funds, or add a key, without us.
- **The user may add their own second owner; Zold never collects its
  signature**, so at threshold > 1 every op is refused and no route lowers the
  threshold. **Zoldenburg is a recovery guardian only by the user's choice**,
  signs only from a hardware wallet, and **the API never holds the guardian
  key**. Full rules: `docs/recovery-and-signers.md`.
- **Gas is a choice, not an assumption.** `SAFE_GAS_PAYMENT` = `sponsored`
  (default) | `native` (Safe pays ETH) | `token` (Safe pays USDC). Verified by
  preflight: the public paymaster REFUSES Base mainnet and sponsors Base
  Sepolia; `native` and `token` work on mainnet.
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
- **PRF is a per-authenticator capability, not a design guarantee.** Real
  hardware reported no PRF support, so the device key was stored unwrapped:
  anything that can read localStorage can spend there. Detect and surface it.

**Data and exposure**
- **Collect per call, store nothing.** `SenderDetails` (name, birth date, ID
  number) is held for one call. Do not store an identity profile for a rail
  that has never run.
- **Public projections are allowlists**, and redaction is server-side — a
  withheld field is never in the JSON, not merely undrawn.
- **Slugs, verification codes and payment codes are credentials**: auth rate
  bucket, never cached by the service worker, and a code under the wrong handle
  is a 404.
- **A merchant-side id is never a global key.** Shopify order and session ids
  are per-store sequences; every lookup by one carries the shop
  (`findPaymentRequestBySource(kind, id, shop)`), or one store's signed
  webhook cancels or dedupes against another's request.
- **Documents are frozen snapshots, re-verified on every visit.** A revoked one
  fails verification rather than vanishing.

**Two strings keep the old "zoll" spelling on purpose** — do not finish the
rename. `PRF_SALT = "zoll/device-key/v1"` is an *input* to key derivation, so a
new spelling makes every wrapped device key undecryptable; the `zoll-device-key`
/ `zoll-session` localStorage slots are read once and migrated forward, and only
the current authorizer can rotate a device key.

## Running and testing

- `npm run check` is OFFLINE and is the one to run.
- `npm run dev` runs local hardhat and **wipes `data/db.dev.json` every start**;
  it cannot deploy a passkey Safe (no bundler). Never point it at the live
  accounts in `data/db.json`. `npm run api` uses `TRANSF_CHAIN_ID` and keeps
  its db. Run `npm run preflight` before any mainnet deploy.
- Details: `docs/running-locally.md`.

## Environment

- Ports 3000 (API/UI), 8545 (chain); contract tests pick a free port.
- No `gh` CLI, no brew. `origin` is SSH and pushes without a token. Opening
  PRs via the REST API needs a PAT the user mints per session (HTTPS username
  `tonyzil`, not `x-access-token`); tell the user to revoke it after.
- Node lives in-project: `export PATH="$PWD/.toolchain/node-v22.17.0-darwin-arm64/bin:$PATH"`.
  It is an **arm64** build: on an Intel Mac ("Bad CPU type", tsx fails too) use
  a system node. `npm run typecheck` works on either (tsc is pure JS).
- In the embedded browser pane, click coordinates are in SCREENSHOT space, and
  WebAuthn ceremonies never resolve — test passkeys in a real browser.
- Check `document.compatMode === "CSS1Compat"` on any new page: without
  `<!DOCTYPE html>` tables do not inherit colour.

## Naming

- **Zoldenburg** = the company / infra brand (B2B, legal, footer).
- **Zold** = the consumer app. The old name **Zoll** survives only in the two
  strings under Invariants ("Two strings keep the old zoll spelling").
- **Narwhal** = mascot. No narwhal emoji exists; the UI uses 🦄.
- Repo dir on disk is still `transF`; do NOT rewrite absolute paths in
  `.claude/launch.json`. GitHub repo rename is pending.
- TODO before public: domain + trademark clearance for "Zold" in fintech.

## Multi-agent workflow

More than one agent commits here.

- Branch prefix: `x/*`. **Never push to a branch another agent created.**
- main is PR-merge only. Before merging, confirm the PR head SHA equals the
  commit you last pushed; after merging, grep the tree — "merged: true" is not
  proof (a PR once dropped a pushed commit).
- Start every session with `git fetch`; expect main to have moved mid-session.
- A grep count of zero is not proof: confirm the file is READABLE first (zsh
  reads `:s/` in `$REF:services/...` as a substitution modifier).

## Style

- Prose without AI-marketing jargon: what is real vs simulated, specifics over
  adjectives, shortcuts stated openly.
- Honest assessments, not cheerleading. Say what is mocked.
