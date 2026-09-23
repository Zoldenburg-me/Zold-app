# The app, the chains and how far a send runs

Read before touching the mobile UI, the PWA layer, chain selection or deployments.json.

*Moved verbatim out of CLAUDE.md (Sep 2026) when that file passed 2,100 lines.
The sections below are the original decision history, unedited. CLAUDE.md keeps
the invariants and links here for the reasoning.*

## Mobile app + PWA (Aug 2026) — LANDED

Branch `claude/remove-upi-and-onboarding-restyle` is FULLY MERGED into main
(`git rev-list --count origin/main..origin/<branch>` is 0). This section used to
say "IN PROGRESS, PR not opened" and that was doc rot: main already carries the
UPI removal, the onboarding restyle, the PWA layer and the mobile app. Work from
main.

DESIGN SOURCE: `~/Downloads/Zold Mobile Dashboard Redesign.zip` — the user's
Claude Design export. `README.md` in it is a real spec (tokens, screens,
behaviour, state); build `Zold Mobile Noir.dc.html`, the approved variant.
The landing page came from a separate export, already applied.

BUILT — every screen in the handoff: mobile shell (412px column, bottom nav
Add·Send·Zold·Activity·Profile), Noir home/safe card, Add funds + bank +
wallet, Zold Plus, the Pay hub, the send flow (country → method → amount →
recipient → progress), Activity, transaction detail, Profile, and the KYC
gate + pending screens.

THE RULE APPLIED THROUGHOUT, agreed with the user: where the design shows
something the API cannot back, it is visibly unavailable — never faked. The
savings vault, USD accounts and Zold Plus say SOON; the send flow offers the
two corridors the API prices (EUR->KES, EUR->EUR) and states that more open
with partners rather than listing 182 countries that dead-end at the quote;
Zold Plus shows no price because that tier does not exist, and links to the
Privacy Bundle that does. On the Pay hub, Zold and Crypto are SOON and
genuinely `disabled` — there is no Zold-to-Zold endpoint and USDC arrives at an
account but nothing sends it out. Its search runs over people this account has
actually paid, not the design's @zoldtag directory: a handle resolves to a
deposit address with no rail that can pay it, so the search would find someone
and then have nowhere to go. No QR affordance either — nothing scans one.
Quotes, signing and both timelines are real; a timeline reads the transfer's
own state, not a timer.

TOKEN QUESTION — SETTLED (Aug 2026), do not reopen. The Noir file is
half-converted: home and the send flow follow its README (12px radii, mono
labels, Space Grotesk figures) while Activity, Profile, Plus and KYC are drawn
with 40-56px round avatars and 16/14px M3 type. The user chose the README —
"nothing above 12px, 50% only for status dots" — and the retrofit is done, so
the app is on ONE scale. `.m-optrow` moved too (Add funds, destination and
method lists): at 16/14 it sat a size above every row beside it. If a screen
from that file looks wrong when you port it, the file is wrong, not the app.

Two structural cleanups worth not undoing:
 - The dashboard's recent list and the Activity screen render the SAME row
   component (`mTxRow`). They were two functions drawing two shapes, so one
   transfer looked like two different things depending on the screen.
 - The send progress screen and transaction detail share `mTimeline()`. The
   handoff gives detail 4 steps and progress 5; the same transfer showing a
   different number of steps per screen is the confusing half of that.

BUG FIXED, and the class name is load-bearing: the timeline's node column is
`.tl`, NOT `.rail`. `#dashboard.m-on .rail { display:none }` hides the desktop
layout's right-hand column with a selector that outranks anything scoped to
`.m-step`, so every timeline rendered with no nodes and no connecting line —
including the shipped send progress screen, silently, for several commits.

HOW FAR A SEND ACTUALLY RUNS (Aug 2026, re-measured after the RemitVault
merge). Not "never observed" any more — the wall moved, and it is worth knowing
exactly where it now is.

PROVEN, locally, through the mobile UI: device key bound -> POST /api/quotes
(live mid, EUR->KES) -> POST /api/transfers -> device signs the EIP-712
PaymentAuthorization -> POST /authorize -> orchestrator runs ->
`assertDeviceAuthorization` PASSES. That last step is the one worth recording:
after RemitVault was deleted the signature is verified in the API process, and
this proves that path accepts a real browser-generated signature.

THE WALL: local hardhat transfers now refuse before debit unless the account
has an active passkey Safe with a configured co-signer allowance. The Safe
address is counterfactual and can only be deployed through Candide's bundler on
CANDIDE_CHAIN_ID=84532, which
does not exist on local hardhat 31337. Nothing about the send flow fixes this;
`npm run api` against Base Sepolia with a funded, deployed Safe is the only way
past it, and debited -> bridged -> paid is still unexercised beyond its
state-mapping logic.

FUNDING NOW, since `scripts/credit-test.ts` was DELETED with RemitVault: there
is no ledger to credit any more, so mint MockToken EURe straight to the user's
Safe address from hardhat account 0 (the token owner) and `refresh()` picks it
up. /api/simulate/sepa-deposit still refuses in sandbox mode.

Activity and transaction detail were verified by rendering realistic Transfer
objects into `hist` — the render code is real, the transfers were fixtures.

BALANCE FIGURES CHANGED SHAPE: `accountBalances` now returns only
`balanceEur === safeBalanceEur`; `vaultBalanceEur` is gone. `mobileFigures`
reports total == available deliberately — there is one pot, and an in-flight
transfer has already left the Safe, so the Safe balance is both what is held
and what is spendable. Do not "fix" that into a subtraction.

HOW TO SEE THE KYC GATE LOCALLY, because this costs an hour otherwise:
`npm run dev` CANNOT show it. `scripts/_test-env.ts` sets
`process.env.KYC_AUTO_APPROVE = ""` outright, so passing KYC_AUTO_APPROVE=0 to
`npm run dev` does nothing and every new user lands approved. Run a second API
directly instead, against the chain dev.ts already started:
  TRANSF_API_PORT=3001 TRANSF_CHAIN_ID=31337 \
  TRANSF_RPC_URL=http://127.0.0.1:8545 TRANSF_DB_PATH=/tmp/db.gate.json \
  KYC_AUTO_APPROVE=0 ALLOW_SIMULATION=1 RP_ID=localhost \
  WEBAUTHN_ORIGINS=http://localhost:3001 MONERIUM_CLIENT_ID= \
  MONERIUM_CLIENT_SECRET= RAMP_KEY= ORCHESTRATOR_KEY= DEPLOYER_KEY= \
  npx tsx services/api/src/server.ts
Blanking the *_KEY vars matters: .env holds real Base Sepolia operator keys and
they are not the owners of the local 31337 deployment. Gate, both pending
paths, rejected, and simulate-approval-through-to-dashboard were each exercised
that way. The KYC checklist is DERIVED from the account, not the design's fixed
"two done, one in progress" — only the first unfinished step is marked running,
and a rejected account stops pulsing.

PWA: manifest, generated icons (a committed pure-Python PNG writer — no
imaging library exists on this machine), and a shell service worker whose one
hard rule is that NOTHING under /api/ is cached. Proven by killing the server:
the app still opens and API calls return a 503 the UI prints. The offline bar
is driven by BOTH navigator.onLine and api() failing, because a dead server on
live wifi reports onLine true.
BEFORE SHIPPING INSTALL: on iOS a home-screen web app may get storage separate
from Safari. The FP4 device key lives in localStorage and only the current
authorizer may rotate it, so onboarding in Safari then installing could strand
an account. Untested on a real device; test before offering install.

## Testnet plumbing (July 2026)
- TRANSF_CHAIN_ID selects the chain (31337 hardhat default, 80002 Amoy, 137
  Polygon); services/api/src/chain.ts resolves the viem chain from it and
  synthesises one for unknown ids. NOTHING is pinned to hardhat any more.
- THE BUG THIS FIXED: the EIP-712 domain hardcoded hardhat.id while RemitVault
  builds its DOMAIN_SEPARATOR from block.chainid. On any other chain every
  device signature would be rejected as "bad authorization" — an error pointing
  at the innocent signing code. assertChainMatches() now runs at server start
  and in deploy.ts, and refuses when the RPC disagrees with TRANSF_CHAIN_ID.
- deployments.json is keyed by chain id; legacy flat files are read as 31337
  and migrated on the next deploy, so a testnet deploy no longer overwrites the
  local one. loadDeployments(chainId) / saveDeployments(chainId, addrs).
- deploy.ts takes DEPLOY_{DEPLOYER,ORCHESTRATOR,RAMP}_KEY from the env and
  REFUSES to use the hardhat defaults on any chain but 31337.
- Still owner-supplied before Amoy: an RPC, three funded keys, MONERIUM_CHAIN=amoy
  (verified name), and MG_ANCHOR_ASSET=USDC (issue #53).

## Current state (Aug 2026)
- Repo: github.com/Zoldenburg-me/Zold-app (active main).
- Deployed on Base Sepolia (84532) against Monerium's real EURe. Landing page at `/`, app at `/app`, payment pages at `/pay/:handle`, shareable receipts at `/r/:slug`.
- Active Base Sepolia Deployments (`deployments.json`):
  - `EURe`: `0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85`
  - `USDC`: `0xf94c01838c60f4ddf9519da75180feac7450303a`
  - `FxSwapper`: `0x7b19ccdfb4bcc1bbc12daa2e94e5ad694c8613b8`
  - `AdminTimelock`: `0xe560f041a8175d72558836159573550eaa89f8c4`
- Shareable Receipts (PR #122): `/r/:slug` renders shareable receipts. Set `TRANSF_PUBLIC_URL=https://zoldhq.com` for host generation.
- Toolchain: Node.js `v24.13.0` (`~/.nvm/versions/node/v24.13.0/bin`) and `x86_64` `cloudflared` 2026.7.3 in `.toolchain/bin/cloudflared`.
- Working: two payout rails (KES cash / SEPA), Candide Safe 2-of-2 wallets deployed gasless with EIP-1271 Monerium linking, e2e green across both rails.
- UPI REMOVED (Aug 2026) — deleted, not disabled, and not to be rebuilt from
  this repo's history without a partner. It was a mock partner adapter that
  minted its own UTRs: the rail rendered a "UPI payment successful" panel and a
  12-digit reference for money that had reached nobody, which is the one class
  of fake this project does not keep. Gone: adapters/upi.ts, the `upi` member of
  PayoutRail, receiveInr/recipientVpa/transfer.upi, the INR quote mode (both
  INR-fixed and EUR-fixed), the destination commitment's `upi|vpa=` preimage in
  BOTH chain.ts and public/device.js, the QR-scan UI, and the e2e leg. India is
  gone from the app's destination list too — its only rail was UPI, so leaving
  it listed meant an empty options screen with no way forward. `POST /api/quotes`
  now refuses `rail: "upi"` with 400, and e2e asserts that refusal so the rail
  cannot creep back in unnoticed.
- NOT "live anchor payouts" — that phrase was in this file and was wrong. The
  Stellar ledger half is proven and the anchor half has never run; see the
  Stellar section.
- Deployment capabilities are now published (Aug 2026): GET /api/health carries
  `capabilities: { simulation, sandbox }`. The app's "Add money" card renders
  deposit controls only where the API accepts them.
  `capabilities: { simulation, sandbox }`. The app's "Add money" card was hard
  wired to /api/simulate/sepa-deposit and shown to everyone, but that route is
  dev-only — 403 in production, and 403 off a loopback socket — and NOTHING in
  any response told the client which mode it was in, so the only way to find
  out was to press the button and read the error. The browser now renders the
  deposit control only where the API would accept it and shows real transfer
  instructions everywhere else. The client default is `simulation: false`, so a
  failed probe hides a control the server might refuse rather than offering one
  it will. Public on purpose: it is deployment state, not account state,
  /api/health already publishes contract addresses, and the simulate routes are
  gated on the flag AND a loopback socket, so the value buys an attacker
  nothing one refused request would not.
- Reconciler (July 2026): services/api/src/reconcile.ts compares Monerium's
  processed issue orders against what we mirrored, plus on-chain invariants
  (totalCredited == sum of balances; vault tokens cover credit). Reports
  UNMIRRORED / PHANTOM / CHAIN drift; never repairs — a system that silently
  mints to make two ledgers agree is worse than the disagreement. Runs
  log-only on server startup + every 15 min; `npm run reconcile` on demand,
  `npm run reconcile:test` (6 checks) proves each drift class is caught.
  This is ARCHITECTURE.md §6's reconciler, and it goes away when the mirror
  seam does (Polygon: EURe native, no local mirror).
- FX rates are LIVE (July 2026): services/api/src/rates.ts fetches EUR mids
  (TRANSF_RATES_URL, 10-min cache) and REFUSES to quote rather than serve a
  stale rate. The EUR->USD leg is read from the on-chain swapper, not a
  constant, so the quote cannot promise a rate the swap will not honour.
  THE BUG THIS FIXED: EURUSD 1.08 / USDINR 87.2 / USDKES 129.5 were hardcoded
  and had gone 5-14% stale (real: 1.1379 / 96.55 / 129.64) while the receipt
  said "real exchange rate" with a "0.50% margin" — EUR->INR was quoting 14.3%
  under the market. 1.08 lived in THREE places (config twice + deploy.ts) and
  FP5's binding check compared only two of them, so fixing one alone would have
  silently promised a rate the swap could not deliver. midRate is now the live
  mid, fxRate what we deliver, and marginBps is MEASURED between them.
  TRANSF_RATES_FIXED pins rates for tests/offline (fail-closed in production
  unless ALLOW_FIXED_RATES=1); DEPLOY_EURUSD_RATE pins the swapper seed.
  npm run fx:test (11 checks). NOTE for the cash rail: MoneyGram does the
  USD->local FX itself (their quote guarantees a rate for 30 min; some
  countries return fxRateEstimated:true and cannot lock), so our KES figure is
  an estimate of THEIR pricing — the authoritative number should come from
  their Quote API once we are a real partner.
- JIT liquidity seam (July 2026): LIQUIDITY_PROVIDER picks who fills the
  EURe->USDC leg — `fx-swapper` (our own inventory, owner-set rate, the only
  option on hardhat) or `rfq` (just-in-time from a market maker via Bebop's
  PMM RFQ API, built against their documented v3 shape:
  GET /pmm/{chain}/v3/quote -> buyTokens[addr].{amount,minimumAmount}, expiry,
  and with gasless=false a ready `tx` we submit). The RFQ path is fail-closed
  everywhere: maker down / declining / slow / wrong token all REFUSE rather
  than fall back to our own book, which would price real transfers off a rate
  we chose while reporting a maker set it.
  Two rates, deliberately: quote() is firm and per-amount; indicativeRate() is
  cheap and cached (LIQUIDITY_INDICATIVE_TTL_MS) for receipts, so typing in the
  amount box is not a quote storm.
  THE COUPLING THIS FIXED: fx.ts and FP5's assertQuoteRateBinding both read the
  FxSwapper contract directly, so a deployment switched to RFQ would have kept
  quoting — and binding against — the local mock's rate. Both now ask
  liquidityProvider(). liquidity.rfq (maker quote id + tx) is persisted on the
  transfer because prepare and execute are separate steps; re-quoting at
  execution would settle at a price the user never saw.
  npm run jit:test (14 checks, stub Bebop, no chain needed).
  UNPROVEN: never run against real Bebop — needs a supported chain (not
  hardhat), real token addresses and one live quote. The execute() path in
  particular has only been exercised through its guard branches.
- Known TODOs marked in code: per-transfer FX hedging. (Both earlier items
  are done: passkey assertion verification shipped with FP2, and the
  Monerium webhook no longer trusts its request body — see
  docs/notes/identity-and-security.md.)
- Monerium webhook FIXED (July 2026): it used to credit whatever address
  and amount the body stated, unauthenticated. It now reads only an order
  id and re-reads that order from Monerium (mirrorOrderById), so a forged
  payload buys nothing; MONERIUM_WEBHOOK_SECRET adds an HMAC gate on top
  (OpenClaw PR #32 replaced the guessed scheme with Monerium's documented
  webhook-id/webhook-timestamp/webhook-signature HMAC, plus delivery-id
  dedupe; PR #33 added a staleness window and stopped a transient Monerium
  outage from consuming a delivery id — a 503 now asks for the retry instead
  of silently swallowing it). npm run webhook:test covers it with a stub
  Monerium.

