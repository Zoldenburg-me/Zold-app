# Zold — notes for Claude sessions

## Start here

This file is decision history, not a tutorial. It is long because most of it
records something that was *tested* and should not be re-litigated or
re-discovered the expensive way. Read the section you need:

| you are about to… | read |
|---|---|
| touch money movement or FX | Liquidity venues; Current state |
| touch keys, passkeys or custody | Security gate; FP4 completion |
| deploy or change chains | Testnet plumbing; Sandbox modes |
| touch the Stellar/cash rail | Stellar payout leg; Sandbox modes |
| pick up someone else's branch | Multi-agent workflow |

Two rules that override convenience: **main is PR-merge only**, and a claim
here marked VERIFIED was checked against a live chain, API or bytecode — if you
contradict one, re-test before rewriting it, and say what you ran.


## Naming (decided July 2026)
- **Zoldenburg** = the company / infra brand (B2B, legal, footer). Old-Swiss-
  bank gravitas.
- **Zold** = the consumer app name (short, corridor-speakable; reads as "gold"
  with a Z, and carries the Zoldenburg stem). Renamed from **Zoll** July 2026 —
  Zoll is German for "customs/toll", which named the fee at the border rather
  than the account, and the new positioning is an account, not a remittance fee.
- **Narwhal** = mascot (favicon + empty states). No narwhal emoji exists; UI
  uses 🦄 as stand-in.
- Repo dir on disk is still `transF` (do NOT rewrite absolute paths in
  .claude/launch.json). GitHub repo rename to `zold`/`zoldenburg` is pending
  (redirects old URLs; cheap). Code/docs/package name already say Zold.
- TWO STRINGS KEEP THE OLD SPELLING ON PURPOSE, do not "finish" the rename:
  `PRF_SALT = "zoll/device-key/v1"` in public/device.js is an INPUT to the key
  derivation, so a new spelling derives a different AES key and every wrapped
  device key on a user's authenticator becomes undecryptable. The
  `zoll-device-key` / `zoll-session` localStorage slots are read once and
  migrated forward (LEGACY_KEY_SLOT); the device key is bound on-chain via
  authorizerOf and only the CURRENT authorizer can rotate it, so dropping the
  slot would leave an account permanently unable to spend.
- TODO before public: domain + trademark clearance for "Zold" in fintech.

## Environment
- Node lives in-project (machine has no system Node):
  `export PATH="$PWD/.toolchain/node-v22.17.0-darwin-arm64/bin:$PATH"`
- No `gh` CLI, no brew. GitHub pushes use a fine-grained PAT the user mints
  per session and revokes after (needs Contents write; + Pull requests to
  manage PRs). Push auth username must be `tonyzil`, not `x-access-token`.
- Ports 3000 (API/UI), 8545 (chain), 8546 (contract tests). Stop the dev
  stack before `npm run e2e` — it checks and refuses if ports are busy.
- `npm run dev` wipes `data/db.json` and redeploys the local chain.
  Demo users don't survive restarts.
- In the embedded browser pane, click coordinates are in SCREENSHOT space
  (the size line under each screenshot), not viewport space. WebAuthn
  ceremonies never resolve there — use the skip path; test passkeys in a
  real browser.

## Sandbox modes (all driven by .env — gitignored, user holds credentials)
- Monerium: MONERIUM_CLIENT_ID/SECRET → real per-user IBANs on Sepolia
  (chain name must be `sepolia` in sandbox). Deposits need a portal
  "Receive" simulation by the user; `scripts/credit-test.ts <addr> <eur>`
  is the local shortcut.
- Anchor: MG_ANCHOR_DOMAIN=testanchor.stellar.org → cash pickups create
  real SEP-24 withdrawals, now carrying a validated asset amount (USDC/SRT,
  NOT the recipient's KES — the anchor does its own FX). testanchor caps
  withdrawals at 10 units, so corridor-sized transfers are refused there by
  design; npm run anchor:test proves the guards live. On-ledger SEP-24
  payment IS implemented now (PR #18: sendSep24WithdrawalPayment sends the
  asset to the anchor's account with its memo, persists the payment hash
  before polling, marks PAID only on anchor completion; driven by POST
  /api/transfers/:id/authorize's sibling /refresh-payout). NOT proven
  end-to-end: no funded treasury holding the anchor asset has run it, so no
  real cash has moved; and nothing sweeps PAYOUT_FUNDING_PENDING/FUNDED in
  the background — a client must poll /refresh-payout.
  CCTP IS wired into executeTransfer (PR #26): it records the burn/mint plan
  per transfer; dry-run (default) keeps the local mock escrow so the
  no-credential demo completes, CCTP_LIVE=1 submits the real Base Sepolia
  burn. Never executed live.
- Travel Rule / SEP-12 (July 2026): a cash pickup is a money transmission, so
  the anchor needs the FATF originator set about the SENDER. We used to send
  none of it — the SEP-24 withdrawal carried only asset/account/amount and the
  anchor's SEP-12 customer sat at NEEDS_INFO, so a real withdrawal could never
  complete. Now: `user.senderProfile` holds the text fields (no document
  images — those belong with a KYC provider), `senderProfileToSep9` maps them
  to SEP-9 names, and `submitSenderProfile` PUTs them before the withdrawal is
  opened, REFUSING early and naming the gaps if the anchor requires something
  we lack. The required list is the anchor's own and is per-customer state, so
  it adapts from testanchor's 3 fields to MoneyGram's larger set.
  CRITICAL: one treasury account serves every user, so each user needs a
  distinct SEP-10/SEP-12 memo (`senderMemo`, derived from the user id) or they
  all share one customer record and we would transmit the WRONG person's
  identity. npm run travelrule:test proves the isolation live (user A ACCEPTED,
  user B still NEEDS_INFO).
  MONEYGRAM'S SHAPE DIFFERS FROM TESTANCHOR — checked against their docs, not
  inferred: (a) MoneyGram reads SEP-9 from the SEP-24 interactive POST body,
  testanchor wants SEP-12 PUT /customer, so we do both; (b) country codes are
  ISO alpha-3 ("DEU"), not the alpha-2 the app stores — see stellar/sep9.ts,
  which omits rather than guesses an unmappable code; (c) MoneyGram documents
  exactly 9 fields and does NOT want id_type/id_number/email_address/
  occupation, so the SEP-24 body sends only its subset; (d) state_or_province
  is ISO-3166-2 and only for USA/CAN/MEX; (e) custodial SEP-10 must NOT send
  home_domain (we omit it whenever a memo is set — the custodial case).
  Their reference number is external_transaction_id at
  pending_user_transfer_complete, and funds go to withdraw_anchor_account with
  withdraw_memo as an id memo at pending_user_transfer_start — both already
  matched. Divergence we keep deliberately: MoneyGram says use amount_in
  as-is; resolvePaymentAmount still refuses an amount_in ABOVE what we
  authorised. Their bridging page recommends Allbridge/Bridge.xyz and never
  mentions CCTP.
  PII: senderProfile lands in plaintext db.json — a real deployment must keep
  it with the KYC provider and store only a reference.
- Stellar trustlines/gas (July 2026): Stellar refuses to deliver an asset an
  account does not trust, and the repo had NO changeTrust anywhere — so a live
  CCTP burn would have destroyed USDC on Base and minted nothing, and an anchor
  refund had nowhere to land. Verified against MoneyGram's real anchor:
  extmgxanchor.moneygram.com publishes USDC issued by
  GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5, whose Horizon
  home_domain is centre.io — i.e. Circle's testnet USDC, the same asset CCTP
  mints, so the ASSET is compatible even though MoneyGram's bridging page only
  names Allbridge/Bridge.xyz. ensureTrustline/hasTrustline/accountReserves/
  anchorPayoutReadiness live in stellar/anchor.ts; base reserve is read from
  Horizon (0.5 XLM today) rather than hardcoded, and each trustline locks one.
  bridgeUsdcToStellar now REFUSES to burn when the Stellar recipient cannot
  receive the asset. `npm run stellar:setup [-- --fix]` is the operator step
  (MoneyGram's own guide: fund with XLM, add the trustline, acquire the asset);
  npm run trustline:test covers it live. MoneyGram domains now default
  MG_ANCHOR_ASSET to USDC and reject non-USDC assets at startup.
- CCTP: dry-run by default; CCTP_LIVE=1 + funded CCTP_BURNER_KEY executes
  (faucet.circle.com for testnet USDC). Stellar CCTP domain is 27; mint
  recipient AND destinationCaller must be the CctpForwarder.

## Stellar payout leg — how far it actually runs (Aug 2026)

Ran against real testnet and the real testanchor, not mocks.

PROVEN LIVE:
 - SEP-10 auth as the treasury (GCLMM2GB…), JWT issued.
 - SEP-12 customer is ACCEPTED with all 12 fields already provided — the Travel
   Rule work did that, and it is not the blocker for anything below.
 - Treasury holds ~10,000 XLM and trustlines to TSTLN and to USDC issued by
   GBBD47IF… — Circle's testnet USDC, the same asset MoneyGram's anchor uses.
 - SEP-24 AND SEP-6 withdrawals both open successfully.
 - **A REAL ON-LEDGER PAYMENT LANDS.** tx
   60528481153e250d00943d09c871ba35da3c0df347ac1cff65fa6bdc41e3d993, ledger
   3965805: 1.5 XLM moved with an id memo, built exactly as
   sendSep24WithdrawalPayment builds it (payment op + memo + sign + submit).
   Sequence handling, memo attachment and submission all work against the real
   network. This is the piece that had never run.

STILL NOT PROVEN, and testanchor is the reason:
 - testanchor NEVER publishes withdraw_anchor_account. A SEP-24 withdrawal sits
   at `incomplete` until a human completes their reference UI, and SEP-6 —
   which is supposed to be the non-interactive sibling — behaves the same way,
   returning only an id and a more_info_url. Their reference UI renders empty
   fields in an embedded browser, so the form cannot be driven headlessly.
 - Therefore sendSep24WithdrawalPayment itself is STILL UNEXERCISED end to end:
   the ledger half is proven, the anchor-attribution half is not. Nothing pays
   an anchor account because no anchor account is ever named.
 - Their SEP-6 DEPOSIT also parks at `incomplete` with SEP-12 ACCEPTED, so the
   treasury cannot obtain SRT or USDC from them. Any test needing anchor asset
   is blocked on that, which is why the live script defaults to native XLM.
 - CONSEQUENCE: the anchor half will first be exercised against MoneyGram's own
   anchor, not testanchor. Budget for finding bugs there, and do not read
   "anchor payouts work" as covering it.

`npm run stellar:payout:live` drives as far as the anchor permits and refuses
with the precise reason rather than pretending. It will complete unchanged the
moment an anchor actually publishes an account.

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
  Monerium webhook no longer trusts its request body — see below.)
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

## Business + premium accounts (Aug 2026) — the organisation domain

The product moved from "a user is an account" to **global (local) accounts held
by an organisation**, with the shape of the app around them taken from **Gnosis
Business** (hq.xyz, discontinued). Their full guide was read — all 64 pages, via
`llms.txt` — not skimmed. Design and reasoning: `docs/business-accounts.md`.
`npm run business:test` (39 checks, no chain, no network).

WHAT IS NEW, and what it replaced:
 - `services/api/src/domain/` — Organisation, Member/Role, Account, Contact,
   DraftPayment, Invoice, ChartAccount/AccountRule, LedgerEntry, ImportedWallet.
   The old model had ONE `user.iban`, ONE `user.address`, ONE balance; that is
   false for a business with several people and several accounts, and for a
   premium personal user with several currencies.
 - `services/api/src/routes/{orgs,business,org-context}.ts`, mounted under
   `/api/orgs` as router FACTORIES taking `requireSession`, so server.ts stays
   the single owner of authentication.
 - `public/business.html` (the org dashboard, at `/business`) and
   `public/invoice.html` (the supplier's invoice view, at `/invoice/:token`).
 - A migration in store.ts gives every pre-existing user a personal org of one,
   CARRYING their real IBAN and address forward rather than re-issuing. Verified
   against the live local `data/db.json`: 5 users, every iban and address
   matched, funded users -> `active`, kyc_pending -> `provisioning`, and every
   pre-existing collection untouched. It is idempotent (keyed on a member row).

THREE CHECKS, NOT ONE, and they answer different questions — collapsing any two
opens a hole. Session (who is this), member+role (may they do this here), plan
capability (did the org buy it). A viewer on a Business plan must not be able to
send money; an owner on Starter must not reach the chart of accounts.

THE RULES THAT CARRY THE WEIGHT, each with a test:
 - **Gating is a read-time filter, NEVER a write-time delete.** A downgraded org
   keeps its chart of accounts, tags and history; the API refuses to serve them.
   Gnosis promised exactly this and it is only true if nothing deletes on
   downgrade. Proved live: downgrade to starter, 15 chart accounts / 8 rules /
   1 contact / 2 drafts / 1 invoice still in the store, all readable again after
   re-upgrade. Nothing in `store.ts` deletes an org, account, invoice or ledger
   row — deliberately no such method exists.
 - **A trial is a grant with an end date, not a plan change.** `org.plan` is
   untouched for the whole trial, so lapsing needs no migration. One per org.
 - **FOUR EYES.** The reviewer may not be the drafter, whatever their role,
   or review is a button the same person presses twice.
 - **INVALID_DATA.** A draft whose payee changed after it was saved is HELD, not
   retargeted. The line stores a fingerprint at save time and it is recomputed
   at review AND again at execution — the gap between approval and execution is
   exactly where an address-book edit lands. Bank accounts keep their id when
   their IBAN is edited, so identity alone does NOT detect this; the fingerprint
   is what does. Proved end to end through the API.
 - **An org can never lose its last owner** — by role change or deactivation,
   which are the same hole reached two ways.

ONLY EUR IS REAL, and that is enforced in one place. `domain/accounts.ts` holds
the currency registry, and liveness is a PREDICATE (`live()`) that asks whether
the provider is configured, not a boolean somebody can flip. USD/GBP/KES/INR are
modelled with `status: "gated"` and a `needs` line naming the partner and the
missing piece (Iron is request-access and ungranted; Triple-A wants $10k/month;
dLocal and Yellow Card are uncontracted). A gated account is still RECORDED when
asked for — that keeps the demand signal and stops the UI lying in the other
direction — but it can never be spent from. This is the UPI lesson applied
structurally: a rail that has never moved money must not render as if it has.

WHAT WE TOOK FROM GNOSIS AND WHAT WE DID NOT — the one real conflict is custody.
Their whole promise was "you import your wallets, we never have access": an
accounting layer over other people's money. That is incoherent for us, because a
*local account* is something we ISSUE. So: we issue accounts and sign for them
(FP4 device key / passkey Safe), and imported wallets are READ-ONLY — balances,
bookkeeping and export, never a signature. Rows are stamped `custody:
"external"` so a signing path can assert on the row itself. Executing a draft
from an imported wallet returns unsigned transactions and says so.

DRAFT EXECUTION IS WIRED (Aug 2026). `npm run draft:test` (14 checks, spawns
its own chain and API). A reviewed draft becomes ONE TRANSFER PER LINE, each
carrying its own FP4 authorization; nothing moves until the device signs each
one, which is what makes every refusal path below safe.
 - ONE CODE PATH. `buildTransferFromQuote` was EXTRACTED from POST
   /api/transfers unchanged and is INJECTED into the business router, so draft
   execution cannot become a second, weaker way to create a transfer. The test
   asserts the batch fails with the byte-identical error a direct transfer
   gives — that equality is the point, not the failure.
 - WHO MAY SIGN. Spending authority is a device key in one person's browser, so
   `Account.backingUserId` records whose it is. A `payer` may approve and may
   press send, but only the backing user can produce the signature; the API says
   that in words instead of failing later at /authorize like a bug.
 - PLAN-DEPENDENT REVIEW. With `transfers.approvals` bought, a draft must be
   REVIEWED by a second person before it can be sent. WITHOUT it (Starter) there
   is no review step at all, so DRAFT -> EXECUTING is legal — otherwise every
   Starter draft would be permanently unsendable, which is what the first cut
   did.
 - ALL-OR-NOTHING. Every line is planned before anything is created: wallet
   destinations, gated currencies, sub-fee amounts and over-cap amounts are all
   refused up front (422, nothing created). The balance is checked as a TOTAL,
   because the per-transfer check inside buildTransferFromQuote sees the full
   balance every time and N lines that each fit can still overdraw together.
 - PARTIAL FAILURE. If line 3 fails, lines 1-2 exist as CREATED transfers with
   no signature — they cannot move money and simply expire. The draft goes to
   FAILED (not back to REVIEWED) so a retry is a deliberate re-draft rather than
   a second batch stacked on the first.
 - DRAFT STATE IS DERIVED from its transfers, never stored: a row claiming
   EXECUTED while a transfer sits in MANUAL_REVIEW would be a comfortable lie.
 - MOCK IS A THIRD ANSWER. `CurrencyDefinition.mode()` returns "live" | "mock" |
   false, not a boolean. EUR is "live" against Monerium and "mock" on a genuinely
   local deployment (SECURITY.allowSimulation) — real machinery, no real money,
   labelled as such in the API and the UI. The first cut collapsed mock into
   "closed", which made the entire product unreachable in development and is how
   a mock path stops being exercised at all.
 - AN ORG ACCOUNT NEEDS A FUNDING IDENTITY. Per-org Safe/Monerium provisioning
   is NOT built, so a new org's account is `gated` (never `provisioning`, which
   would promise work nobody is doing) until someone calls
   POST /accounts/:id/fund to back it with their own account. A business org
   must ask; the response says plainly that personal money is now paying company
   bills.
 - STILL UNPROVEN: a batch that actually creates transfers. That needs an active
   passkey Safe, which needs an ERC-4337 bundler; local hardhat has none, which
   is exactly why e2e asserts the Safe refusal rather than a send. Prove it on
   Base Sepolia with `npm run api`.

NOT FINISHED, and refused loudly rather than faked:
 - No mail transport exists, so member invitations and invoice links return
   their token to the caller with a note saying no email was sent. Do not add a
   "we emailed them" string without adding a transport.
 - Imported wallets are never actually synced — `sync.status` stays `pending`.
   The ledger is therefore empty until something writes to it, and the
   Transactions/Assets screens say so rather than showing zeros as if final.
 - Cards are modelled as a capability that reports `unavailable` at ANY price,
   never as an upgrade. Telling someone to pay for something unbuilt costs them
   money.

## CHF and NGN — tokens shown, rails still closed (Aug 2026)

Added to the currency registry with the two settlement tokens the user asked
for. `npm run business:test` (43 checks). ALL FOUR ADDRESSES VERIFIED ON CHAIN
by reading name()/symbol()/decimals() from the contract — the addresses came
from a third-party listing and a listing page is a claim, not evidence.

 - **CHF / ZCHF (Frankencoin)** — ethereum
   `0xB58E61C3098d85632Df34EecfB899A1Ed80921cB`, 18dp, supply ~30.6M.
 - **NGN / cNGN** (Wrapped CBDC, Africa Stablecoin Consortium), 6dp on all four:
   base `0x46C85152bFe9f96829aA94755D9f915F9B10EF5F`,
   bnb `0xa8AEA66B361a8d53e8865c62D142167Af28Af058`,
   ethereum `0x17CDB2a01e7a34CbB3DD4b83260B05d0274C8dab`,
   polygon `0x52828daa48C1a9A06F37500882b42daf0bE04C3B`.
   SUPPLY IS ON BASE (~2.58bn) AND BNB (~699m). Ethereum (~137k) and Polygon
   (~12.6k) are rounding error — do not design a route through them. Base is
   also our app chain, so it is the only deployment worth building against.

THE NEW STATE THIS INTRODUCED, and why it needed its own modelling: a currency
whose TOKEN is real, liquid and verified, but whose ACCOUNT does not exist.
That is different from USD/GBP (no token, named partner ungranted) and it is
the shape most likely to mislead — a live token reads as a working rail. So
`CurrencyDefinition.token` names the token, its issuer, its verified contracts
and WHAT BACKS IT, and `currencyAvailability()` stamps `heldByUs` on it. The
test asserts `heldByUs === available`: a token can only be reported as held
where the rail is actually open, so a shown token can never imply a balance.

BACKING IS THE FIELD THAT MATTERS and the one a currency code hides:
 - EURe is e-money with a REDEMPTION RIGHT AT PAR against a licensed issuer.
 - ZCHF has NO issuer who owes anyone redemption — it is minted against
   borrower collateral with the peg defended by auctions. Under MiCA it is a
   crypto-asset, not an EMT, and Frankencoin argues some provisions do not
   apply because it is decentralised — an argument, not a ruling.
 - cNGN is naira-reserve backed under a NIGERIAN perimeter (SEC Nigeria, 2025
   Investments and Securities Act; CBN keeps payment-system oversight). That
   says nothing about MiCA and gives an EEA holder no EU protection.
Rendering all three as "CHF / EUR / NGN" would flatten instruments that differ
in kind, which is why the business Currencies table now has a token column
carrying the backing sentence verbatim.

ALSO: `AccountProvider` gained `"none"` — no candidate identified at all,
distinct from a named partner we have not contracted with. CHF is `none` (there
is no Swiss institution in view; Frankencoin is a protocol, not a counterparty
you can sign with). NGN is `yellowcard`, who genuinely cover Nigeria as their
largest market and are uncontracted.

AND THE CONSTRAINT THAT BITES cNGN: Bridge supports only USDC and EURC for EEA
users under MiCA, so cNGN cannot move through our licensed transfer seam for a
European entity at all. Their API also needs a merchant account and API keys
nobody has requested.

## Invoicing by jurisdiction (Aug 2026)

THE MISTAKE THIS FIXED, one commit after the first cut shipped: German law was
applied to EVERY entity. A Polish or Swedish org was offered
"§ 19 UStG Kleinunternehmerregelung" and a 19% rate; an Indian one was offered
German exemptions with no mention of GST. That is worse than offering nothing,
because it looks authoritative. `domain/jurisdictions.ts` now resolves the rule
set from the ISSUING entity's country — an invoice is governed by where the
issuer is established, not where the customer is.

THREE RULE SETS, and the difference is what we ENCODE versus what we CARRY:
 - `DE`  statutory  — German paragraphs encoded and enforced (see below).
 - `EU`  directive  — the VAT Directive baseline every member state shares
   (Art. 226 particulars, 196 reverse charge, 138 intra-community, 146 export).
   National additions are NOT encoded; there are 26 other sets and we verified
   none. The org adds its own rules for what its country needs.
 - `GENERIC` structural — both parties, a number, dates and arithmetic that adds
   up. NO tax law. India, the US, the UK and everywhere else land here.

EVERY REPORT CARRIES ITS VERIFICATION LEVEL, so `ok: true` never claims more
coverage than we have, and `notVerified` names the gaps verbatim (for India it
names GSTIN, HSN/SAC, place of supply and the CGST/SGST/IGST split, which we do
not model). The UI renders that list next to every invoice.

CITATIONS FOLLOW THE RULE SET. `basis(de, eu)` quotes a German paragraph only
under DE, the Directive article under EU, and NOTHING under GENERIC — quoting
"§ 14 Abs. 4 UStG" at an Indian entity would be confidently wrong. Same for
exemption labels: `reasonForRuleSet()` gives Poland "Reverse charge (EU) —
Art. 196 VAT Directive", not "Reverse Charge (EU-Ausland) — § 3a Abs. 2 UStG".
Three separate leaks of this kind were found and fixed by testing PL and IN
against the running server; grep for hardcoded `UStG` before adding UI copy.

NO VAT RATE TABLE IS SHIPPED. Rates change by statute and 27 numbers we have not
checked would be 27 confident lies. Germany's 19/7 is enforced because we
checked it; everywhere else the org sets the rate it charges and we validate
only that it is a percentage. A missing rate REFUSES rather than defaults —
quietly applying 19 to a Polish entity is the original bug in miniature.

The § 33 UStDV €250 simplified-invoice shortcut is likewise German-only. Member
states may set their own; we have not checked them, so elsewhere full content is
required.

CUSTOM RULES: an org can define its own exemption reasons (id, label, legal
basis, and the note printed verbatim). Required for GENERIC jurisdictions and
useful in EU ones. Presented as user-supplied everywhere — we print the note and
do not check it. A custom rule requiring the customer's tax identifier checks
only that one is PRESENT, never that it matches an EU VAT-ID shape: an Indian
GSTIN is not a USt-IdNr., and validating it against that shape rejects the
correct value.

## German invoicing (Aug 2026) — the DE rule set

Business users can now ISSUE invoices, not only receive them. `Invoice.direction`
splits the two: `incoming` is the original Invoice-Me link a supplier fills in,
`outgoing` is one we issue. THIS SECTION IS THE `DE` RULE SET ONLY — see
"Invoicing by jurisdiction" above for how a non-German entity is handled.
`services/api/src/domain/invoicing.ts` holds the rules; `npm run invoicing:test`
(26 checks, offline).

NOT TAX ADVICE and the app says so on every screen that touches it. What the
code guarantees is narrower: the software cannot produce a document missing a
mandatory field, and cannot show tax the issuer does not owe.

THE TWO RULES WITH MONEY ATTACHED, both silent failures — nothing bounces, the
damage arrives months later:
 - §14c UStG: show VAT you did not owe and you OWE IT ANYWAY, and the customer
   cannot deduct it. So `VatTreatment` is a DISCRIMINATED UNION whose exempt arm
   has no rate and no tax field — "exempt with a VAT amount" is unrepresentable,
   not merely discouraged. computeTotals forces every line to 0% when the
   invoice is exempt, even a line carrying its own rate.
 - §14 Abs. 4: a missing mandatory field costs the RECIPIENT their Vorsteuerabzug
   until a corrected invoice arrives. The damage lands on the customer, not on
   whoever made the mistake, which is why it is checked before issuing.

WHAT IS ENCODED (sources checked against IHK/Haufe/dejure, not memory):
 - §14 Abs. 4 UStG — the ten mandatory details. The date of supply is required
   EVEN WHEN it equals the invoice date; a supply PERIOD satisfies it too.
 - §33 UStDV — Kleinbetragsrechnung up to €250 GROSS drops recipient, invoice
   number, tax number and supply date. One cent over and full content returns.
 - §34a UStDV (new 2025) — Kleinunternehmer content rules, so a missing tax
   number is a WARNING there and an ERROR elsewhere. §19 thresholds rose in 2025
   to €25,000 prior year / €100,000 current.
 - Reverse charge — the invoice must carry the literal
   "Steuerschuldnerschaft des Leistungsempfängers" (Art. 226 Nr. 11a MwStSystRL
   allows other official EU languages), and EU B2B needs BOTH USt-IdNr.
 - Also: intra-community supply, export to third countries, place-of-supply
   abroad, and a free-text `other` that forces the issuer to write the basis.
 - Every reason carries its statute, printed next to the choice and on the
   document, so the user can check us rather than trust us.

MONEY IS INTEGER CENTS end to end, and VAT is rounded ONCE PER RATE BUCKET, not
per line — rounding each line and summing drifts against what the tax office
recomputes. Per-line VAT is then attributed back so the column adds up exactly.

PREFILL: `Organisation.invoicing` holds the issuer identity (USt-IdNr.,
Steuernummer, Kleinunternehmer flag, bank, register court/number, payment terms,
number series, footer). §14 wants the issuer's name, address and tax id on EVERY
invoice, so they live there once. `issued` on the invoice is a FROZEN SNAPSHOT of
both parties, the treatment and the display choices — re-rendering from today's
org profile would quietly rewrite a document the tax office may later ask about.

DISPLAY TOGGLES COVER OPTIONAL BLOCKS ONLY. Everything §14 requires is rendered
unconditionally and is absent from the settings map: a generator whose settings
can produce an invalid invoice is a trap, and it springs on the customer.

THE DOCUMENT IS A DOCUMENT. `public/invoice.html` renders a white A4-printable
sheet inside the dark app chrome, with a German sender line, per-rate VAT table
and a print stylesheet. Deliberately NOT the receipt-printer aesthetic that was
considered: a till roll cannot hold two addresses and a VAT table, does not
print to A4, and reads as less credible to the accountant who must accept it.
That treatment belongs on /r/:slug receipts, which are a different artifact.

BUG THIS FOUND — QUIRKS MODE. business.html and invoice.html were written
without `<!DOCTYPE html>`, so they rendered in BackCompat. In quirks mode TABLES
DO NOT INHERIT COLOR from their parent, so the invoice line items and totals
rendered in the dark theme's light text on the white sheet — nearly invisible,
and only visible at all because that page inverts. Every pre-existing page had a
doctype; only the two new ones did not. Both fixed. Check `document.compatMode`
is `CSS1Compat` on any new page.

NOT BUILT, and said on the document itself: XRechnung / ZUGFeRD (EN 16931).
German B2B must already be able to RECEIVE e-invoices; the obligation to ISSUE
them phases in from 2027 (2028 for smaller turnover), so a PDF is enough today
and will not be. That is the next real piece of work here.

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

## Security gate (red-team, July 2026 — fix before any hosted/public demo)
Sessions+authz landed (PR #2). FP1+FP2 DONE (July 2026): simulate endpoints
403 in production (ALLOW_SIMULATION=1 to override), mock fallback fail-closed
unless ALLOW_MOCK_FALLBACK=1, origin allowlist (WEBAUTHN_ORIGINS/RP_ID) +
per-IP rate limits, and full server-side WebAuthn: challenge endpoint, CBOR
attestation parsing -> COSE key stored, assertion signature+rpIdHash+counter
verified before sessions (services/api/src/webauthn.ts, selftest script
npm run webauthn:selftest). Still open, in fix order:
KYC gate (July 2026): `KYC_AUTO_APPROVE=0` / production starts users pending
and gates IBAN issuance, deposits, device binding, quotes, transfer creation,
and authorization. The browser app now shows pending/rejected/manual-review
states instead of sending those users through Monerium provisioning; add-money
and send controls remain unavailable until approved. Approval must still come
from the configured provider/operator path; the local
`/api/users/:id/kyc/mock-review` route remains dev-only self-approval.
Existing-Monerium connect DONE in code (July 2026, OpenClaw ba7c0c2 + test in
PR #41): pending users choose between connecting an existing Monerium account
and the normal identity review path. The connect flow is Authorization Code +
PKCE (S256) across five endpoints — connect/start, oauth/callback, accounts,
activate, DELETE connect. Per-user tokens are AES-256-GCM encrypted at rest
(MONERIUM_TOKEN_ENCRYPTION_KEY, required — start 503s without it) and stripped
from every API response. activate deploys/links the app Safe and requests a NEW
app IBAN; it never moves the user's existing one. npm run monerium:oauth:test
drives the loop against a stub that verifies the PKCE itself (12 checks).
UNPROVEN: nobody has connected a real Monerium account — needs the OAuth app
registered with a matching MONERIUM_REDIRECT_URI and one browser run.
FP3 DONE (July 2026): failures auto-compensate (escrow release + vault
re-credit at current rates, itemized deductions, REFUNDED state), startup +
5-min sweep recovers stranded transfers; FORCE_FAIL_STEP test hook,
npm run fp3:test.
!! STALE SINCE THE REMITVAULT REMOVAL (Aug 2026) — READ THIS FIRST !!
`contracts/src/RemitVault.sol` NO LONGER EXISTS. It was deleted on main by
`break/remove-remit-vault`, and that PR did not update this file, so everything
below describing RemitVault.debit / setAuthorizer / _isValidSignature describes
a contract that is gone — including the whole "FP4 completion — recovery"
section further down, whose steps 3 and 4 name functions you cannot call.
WHAT IS ACTUALLY TRUE NOW: the same EIP-712 PaymentAuthorization is signed by
the same browser device key, but it is verified by `assertDeviceAuthorization`
in services/api/src/orchestrator.ts using viem's verifyTypedData — in the API
process, not by bytecode. The EIP-712 domain moved to "TransF Safe Transfer"
with the user's Safe as verifyingContract.
THE SECURITY CONSEQUENCE, stated plainly because the text below claims the
opposite as VERIFIED: a wrong-key signature is no longer "rejected by the
contract itself". The server is the thing checking, but it no longer stores
user Safe owner keys; passkey Safes debit through co-signer allowances. The
device key still stops a stolen session from swapping the payee or the amount.
The recovery plan below needs rewriting against whatever replaces the vault as
the enforcement point.
USER-SIGNED EXECUTION (Aug 2026, branch claude/user-signed-execution — the
regulatory doc's Change 1; supersedes the interim per-transfer allowance that
briefly lived on claude/per-transfer-allowance and was never merged): the
ALLOWANCE MODEL IS GONE ENTIRELY. No module, no delegate, no standing or
one-time amounts — transferTokenFromSafeAllowance no longer exists. POST
/api/transfers prepares the userOp that IS the debit: an ERC-20 transfer of
the exact amount (fee only on the SEPA rail; nothing when the fee is 0) to
the orchestrator address. The passkey signs its hash at send time
(executionAssertion on /authorize, verified against the stored challenge
BEFORE the one-shot claim), the co-signer counter-signs where it is an owner,
and the orchestrator's debit leg submits it through the bundler — so a debit
failure takes the normal FAILED/compensation path. The chain enforces token,
amount AND destination; the API can dispose of nothing, ever. Legacy standing
allowances on old Safes are revoked automatically: the prepared userOp
prepends deleteAllowance when the chain shows one (CANDIDE.
allowanceModuleAddress survives only for that read). The co-signer sends no
native transactions any more — it needs NO gas. The allowance repair routes
(GET/POST /passkey-safe/allowance*) and the client's repair banner are
deleted. The CANDIDE_COSIGNER_*_ALLOWANCE_* env knobs do nothing (boot note
says so). npm run execution:test (13 checks, pure builders); fp3/e2e blocker
regexes updated to the new refusal text.
CHANGE 2 WINDOWS 1-3 DONE (same branch): the cash-rail send is ONE user-signed
batch [legacy revoke?] -> fee transfer -> approve venue -> swap, atomic — a
failed leg reverts the whole operation and nothing leaves the Safe. The swap
output goes STRAIGHT to the destination the payout leg names: Bridge's
deposit address in live mode (the Bridge transfer is created at TRANSFER
CREATION, idempotency key zold-<id>-bridge, so execute's re-create is stable;
executeTransfer asserts the deposit address still matches the batch recipient
and refuses to settle otherwise), the orchestrator only in local dry-run
(escrow demo pulls from it). Venue side is `safeSwapPlan` on the liquidity
seam: dex builds exactInputSingle calldata offline (same pool+floor as the
quote — the ONLY venue provable on Base Sepolia, needs dex:setup's pool);
lifi/rfq re-quote WITH executor=Safe + recipient baked in (their calldata
binds the taker — orchestrator-quoted calldata is NOT reusable); fx-swapper
CANNOT serve a Safe (onlyTrader, our inventory — falls back to plain debit +
orchestrator swap, so a deployment on LIQUIDITY_PROVIDER=fx-swapper keeps
windows 2-3; switch to dex/best to close them); cow refuses. usdcOut is
MEASURED as the recipient's balance delta, floor-checked against the signed
minOut. COMPENSATION: fixed a latent main bug — the "was it swapped?" check
matched only liquidity.fx-swapper.eure-usdc, so dex/rfq/lifi-swapped failures
would have "refunded" EURe the orchestrator no longer held; now prefix-matches
liquidity.*.eure-usdc. Live-batch failures after the userOp lands are
MANUAL_REVIEW always (funds are at Bridge, nothing local to reverse —
compensateTransfer guards on transfer.safeSwap.mode === "live" and
failAndCompensate on the bridge.xyz.deposit.funded step); dry-run batch
failures reverse-swap from the orchestrator exactly as before. UNPROVEN: no
real Base Sepolia send has exercised execution→debit, and no batched swap has
run against a real pool (needs dex:setup + a funded Safe); Bridge live mode
remains entirely unexercised.

FP4 (key custody): SPEND-AUTHORITY HALF DONE (July 2026, PR #11, branch
claude/fp4-vault-authorization — do not re-do differently). RemitVault.debit
now requires an EIP-712 PaymentAuthorization signed by the account's
registered authorizer; the orchestrator role only submits and pays gas. The
authorizer key is generated in the browser (localStorage, vendored
@noble/secp256k1 + keccak in services/api/public/vendor/, import-map wired),
registered via POST /api/users/:id/authorizer (trust-on-first-use by the
ramp; only the current authorizer can rotate). Send flow is propose ->
sign-in-page -> POST /api/transfers/:id/authorize. Verified live: sandbox
onboarding bound the browser key on-chain; wrong-key signature rejected by
the contract itself. authorizerOf ALSO accepts EIP-1271 — this is the hook
for the passkey half below; build against it, not around it.
FP4 key-custody half: user Safe owner keys are no longer stored in db.json.
Candide WebAuthn Safe owner (fromSafeWebauthn) signs the Monerium declaration
and orders via the passkey, then the passkey-owned Safe replaces the browser
EOA as the vault authorizer (no contract change needed). The send-time passkey prompt is now
the real gate: the device key is encrypted at rest with WebAuthn PRF
(HKDF -> AES-GCM, only {iv,ct} in localStorage), so each payment needs a
ceremony to unwrap; authenticators without PRF fall back to an unwrapped
key labelled protection:"none". npm run fp4:test covers the envelope
headlessly. VERIFIED NEGATIVELY (Aug 2026, real browser + real authenticator):
the authenticator reported NO PRF SUPPORT, so the device key was stored
UNWRAPPED with protection:"none". The console says so plainly
("this authenticator reports no PRF support — the device key cannot be
passkey-encrypted"), but the consequence is quiet and worth stating: on such a
device the "every payment needs a passkey ceremony to unwrap the key" property
DOES NOT HOLD. Anything that can read localStorage can spend. Treat PRF as a
per-authenticator capability to be detected and surfaced, not a guarantee of
the design. Still unverified on hardware that DOES offer PRF: that it returns
the SAME 32 bytes across ceremonies — if not, a wrapped key is unrecoverable
after reload.
FP5 (contract governance + quote binding): PARTIAL. Quote↔execution binding
DONE (services/api/src/orchestrator.ts assertQuoteRateBinding: refuses +
auto-refunds if on-chain rate drifts > FX.QUOTE_BINDING_BPS from the quote's
lockedSwapRate; npm run fp5:test). OpenClaw PR #9 landed replay/role/pause
hardening (idempotent deposits, escrow Status enum + refundTo binding,
swapper onlyTrader+pause, live-chain deploy guard). Multisig/timelock ownership DONE
(July 2026, PR #26): contracts/src/AdminTimelock.sol is an M-of-N + delay
owner of vault/swapper/escrow, so no single key can raise the daily cap,
grant itself a role, or drain swapper inventory. Emergency pause stays
instant via a separate guardian role (guardian can pause, only the timelock
can un-pause). deploy.ts transfers ownership after wiring roles;
TIMELOCK_DELAY_SECONDS / TIMELOCK_THRESHOLD configure it. Still open:
tiered/KYC-risk caps (vs global daily cap), Bebop executable quotes to
replace the mock rate.
Hardening pass (July 2026, branch claude/code-vulnerability-review-drgsst):
- AUTHORIZE RACE — was a real double-spend. Everything in
  POST /api/transfers/:id/authorize up to the first `await` runs synchronously,
  so two parallel submissions of ONE device signature both cleared the
  `state === "CREATED"` check. The vault rejected the loser's duplicate
  transferId, that revert took the FP3 path, and compensation re-credited the
  sender (local RPC) while the winner completed the payout — the shared txs
  array already held the winner's `vault.debit`. Now store.claimAuthorization()
  claims the submission synchronously (nothing yields between read and write),
  and failAndCompensate never refunds a "duplicate transfer" revert — that is
  MANUAL_REVIEW. npm run authorize:test.
- Dev-only defaults stopped keying off the API host alone: LOOKS_LOCAL = loopback
  API + local RPC + chain 31337. A reverse proxy to 127.0.0.1:3000 passed the old
  test, so a hosted deploy that forgot NODE_ENV=production served simulated SEPA
  deposits, self-serve KYC approval and internal error text. The simulate routes
  additionally require a loopback socket with no forwarding headers.
- The API can hold real operator keys at last: ORCHESTRATOR_KEY / RAMP_KEY /
  DEPLOYER_KEY (DEPLOY_*_KEY accepted too). Only deploy.ts read keys from the env
  before, so the Amoy path meant hardhat's published keys holding ramp +
  orchestrator — and the ramp role can bind a payment authorizer to any account
  that has not bound one yet, so anyone could claim a new user's account and
  spend it. FP4 was worth nothing in that configuration.
- Passkey re-registration now needs a step-up from the CURRENT credential (a
  stolen session token was otherwise permanent account access, silently
  replacing the real passkey); WebAuthn challenges are bound to the account; a
  step-up must carry the UV flag, and the client asks for
  userVerification: "required". npm run webauthn:selftest is 9/9.
- destinationCommitment covers the recipient NAME as well as the account
  identifier — on the cash rail the name is the payout identity. chain.ts and
  public/device.js in lockstep; this invalidates signatures issued before it.
- Monerium order ids are shape-checked and encoded before they land in the
  request path (they arrive in a webhook body, unauthenticated when no
  MONERIUM_WEBHOOK_SECRET is set).
- Smaller: per-credential rate bucket on passkey login, TRUSTED_PROXY_HOPS so
  limits key on the real client IP instead of one shared proxy address, session
  pruning + throttled lastUsedAt writes (the store was re-serialised on every
  authenticated request), AdminTimelock.execute counts only CURRENT owners'
  confirmations, and the UI escapes recipient/partner strings and refuses
  non-http(s) anchor links.
NOT verified in that pass: no solc in the review sandbox, so npm run compile,
test:contracts and e2e did not run — typecheck, webauthn:selftest and
authorize:test did. Still open from the same review: KYC approval via a
connected Monerium account is delegated trust with no identity match (now at
least auditable via kyc.applicantId), and db.json still holds senderProfile PII
in plaintext.
Launch gate: local demos fine; NOT safe hosted, with real funds, or claiming
payout finality until FP1-FP4 done.

## Multi-agent review pass (Aug 2026, branch claude/user-signed-execution)

Four parallel review agents swept the whole tree after the three custody
iterations; every finding was verified against the code before acting (two of
the client agent's "dead label" claims were factually wrong — check before
deleting). Fixed: /authorize now verifies the EXECUTION assertion before the
redeem assertion (the client performs that ceremony first, so the old order
read the sign counter backwards and 401'd every Safe-funded SEPA send on
counter-incrementing authenticators); a claimed-but-unrecorded debit (crash
between userOp inclusion and the DEBITED write) is swept to MANUAL_REVIEW; a
SEPA send with no Monerium configured refuses instead of mock-PAID after a
real fee debit; Bridge execute replays the exact creation body (amount is
persisted as safeSwap.bridgeAmountUsdc — the idempotency key is shared);
persisted liquidity quotes execute on the venue that priced them and an
unknown LIQUIDITY_PROVIDER throws instead of silently using FxSwapper; RFQ
validates its recipient BEFORE settling; rfq/cow reverse-side rate/probe unit
bugs; batch path enforces quote expiry. DELIBERATELY KEPT despite "dead"
reports: the desktop rail UI (parked until Noir screens, see Mobile section),
getBridgeTransfer + pickup.bridge* fields (the seam for the STILL-MISSING
Bridge state polling — nothing advances a live Bridge transfer after
deposit.funded), sender-profile + /users/:id/transfers routes (external API
surface). KNOWN GAPS left open, in code-comment or here only: recovery can
only be STARTED from the parked desktop settings view (mobile has no start
control); the crypto auto-convert toggle is likewise unreachable; batch-mode
surplus is structurally user-kept regardless of LIQUIDITY_SURPLUS_POLICY;
the device-signed EIP-712 `to` field still names the orchestrator even for
batches that deliver to Bridge (changing it needs a coordinated device.js
lockstep bump).

## Gnosis Pay — connected card, PR 1 shipped (Aug 2026)

`npm run gnosispay:test` (13 checks, stub, offline). Design + corrections:
`docs/gnosis-pay-permissionless-integration.md`.

WHAT IT IS: the user connects their OWN Gnosis Pay account by SIWE and Zold
shows cards, balances and card transactions. Gnosis Pay issues the card, holds
its KYC and owns the card Safe. Permissionless mode has NO webhooks and NO
attribution of card activity back to Zold, so nothing may be presented as a
Zold card — the provenance line is rendered on every state, including errors.

TWO API DETAILS THE DESIGN DOC HAD WRONG, both silently fatal, both found by
reading the live OpenAPI spec and calling the endpoint rather than trusting the
transcription — and both now asserted in the test:
 - `GET /auth/nonce` returns **text/plain**, not JSON.
 - It **sets a `siwe` cookie** that `POST /auth/challenge` verifies against.
   Drop it and every signature is rejected as if the user signed wrong.
Also: `/account-balances` returns decimal strings of MINOR UNITS (`^[0-9]+$`),
kept as strings end to end; and the `Event` schema behind `/transactions`
declares no properties, so items are passed through as opaque.

DECISIONS THAT CARRY WEIGHT:
 - **The JWT is never persisted, not even in localStorage.** It is a bearer
   credential for a third party's financial account; the browser holds it in
   memory and sends `x-gnosis-pay-token`, the API forwards and forgets. A
   reload means signing in again and the screen says so.
 - **A Gnosis Pay 401 is returned as 409.** Passing it through would make the
   browser log the user out of ZOLD because someone else's token expired.
 - **Stored status is shown when signed out; a stored BALANCE never is.** There
   is nothing pushing updates, so every figure carries `asOf` and is labelled a
   snapshot.
 - **The signer is the user's own browser wallet**, not the Zold passkey Safe:
   EIP-1271 is only verifiable where the contract is deployed, and the Zold Safe
   is not on chain 100.

CHAIN FACTS, VERIFIED not assumed (scripts were throwaway; re-run before
relying on them): Gnosis Chain (100) HAS the RIP-7212 P256 precompile — probed
with a real generated P-256 signature, valid returns 1 and a tampered r returns
empty, same as Base Sepolia — and Candide's bundler/paymaster cover chain 100.
So a passkey Safe on Gnosis is possible and is the natural next step; it was NOT
the blocker it was assumed to be.

NOT BUILT, deliberately (PRs 2-4 in the doc): signup, terms, KYC, phone OTP,
Safe deploy, card creation, and ALL funding. NOT PROVEN: no real Gnosis Pay
account has been connected.

SCOPE NOTE: "make everything Gnosis Pay compatible" was scoped to the adapter
only. Moving Zold to Gnosis Chain was considered and NOT done, and the REASON
was corrected once: it is not CCTP. CCTP is the dry-run alternative that has
never executed live; Bridge.xyz is the live seam (BRIDGE.sourceRail = "base").
The real reason is that **Bridge does not support Gnosis Chain either** —
checked against their payment-routes table, which lists Arbitrum, Avalanche,
Base, Celo, Ethereum, HyperEVM, Linea, Monad, Optimism, Polygon, Solana,
Stellar, Sui, Tempo, Tron, World Chain, XDC and Aptos, and no Gnosis at all.
On Gnosis the cash rail would have NO exit. The current Base -> Stellar route
with USDC at both ends is squarely on their supported set.

AND THE MIGRATION IS NOT NEEDED FOR THE CARD ANYWAY. Gnosis Pay's card Safe is
theirs, on chain 100, whatever chain Zold runs on. Only two things want Zold on
Gnosis: the passkey Safe signing SIWE by EIP-1271 (needs it deployed on 100 —
RIP-7212 is live there, so it works), and funding the Gnosis Pay Safe from Zold
(needs EURe on 100 — Monerium issues it there). Both are satisfied by deploying
the user Safe on Gnosis IN ADDITION, with the corridor left on Base. EURe
exists on both and LI.FI covers Gnosis, so card funding is a user-signed
Base->Gnosis EURe bridge. That is the shape to build, not a migration.

BRIDGE + EEA, worth knowing before designing any USDT path: their docs state
"USDC & EURC are the only stablecoins supported for users in the EEA" — MiCA,
applied by them. Zoldenburg UG is an EEA entity, so Bridge CANNOT handle USDT
for us. USDT would have to be swapped to USDC before Bridge sees it, and that
swap is the MiCA exchange service, not an integration detail.

## Monerium — your OWN API keys as a connector (Sep 2026)

`npm run monerium:apikeys:test` (13 checks, stub Monerium + local chain). For
testing against your own Monerium account: Profile -> Monerium keys, paste the
client id + secret of an app created in THAT account's developer section.

WHERE THE CREDENTIAL DECISION LIVES NOW: `adapters/monerium-connection.ts`.
`moneriumClientFor(user)` answers "whose credentials act for this user" —
API keys, then OAuth, then the app's MONERIUM_CLIENT_ID/SECRET — and
`moneriumLiveFor(user)` answers "is Monerium real for this user" (app
credentials OR a connection of their own). The token encrypt/decrypt/refresh
helpers that used to sit in server.ts moved there unchanged in scheme
(crypto-at-rest.ts purpose `monerium`; old ciphertext still decrypts). ONE
DELIBERATE CHANGE inside that move: the OAuth refresh now sends
MONERIUM_OAUTH_CLIENT_ID (falls back to MONERIUM_CLIENT_ID), the same client
that did the code exchange; the old code sent MONERIUM_CLIENT_ID, which a real
OAuth server rejects when the two differ.

WHY THE SANDBOX ADAPTER HAD TO CHANGE, not just the routes: the address the
app links and the IBAN it requests live under the USER's profile, which the
app's keys cannot see (the same blind spot `MoneriumClient.orders()` documents
for unscoped calls). So `redeemToIban`, `getOrderState`, `findIban` and the
deposit poller now run on the user's client when they have one; the poller
additionally walks `usersWithOwnCredentials()` and asks each one's account
(default profile AND the recorded one). The test proves it the hard way: the
API is started with NO app secret, the stub issues a token only for the one
known pair and 401s everything else, and activation + a credited deposit still
happen. `executeSepaTransfer` is gated on `moneriumLiveFor(user)`, so an
account connected by API keys places a REAL redeem even on a deployment whose
own credentials are unset — a connected account mock-PAYING would be the UPI
fake again.

RULES THAT CARRY WEIGHT:
 - VERIFIED BEFORE STORED. The pair is exchanged for a token and /auth/context,
   /profiles, /ibans, /addresses are read before anything is written. A 400/
   401/403 from the grant is a 400 to the caller naming the ENVIRONMENT
   (sandbox keys against production is the likely mistake); 5xx/DNS is a 503.
   A refused pair leaves no row behind, not even encrypted.
 - THE SECRET NEVER LEAVES. Encrypted with MONERIUM_TOKEN_ENCRYPTION_KEY, never
   in a response — not even its ciphertext (`publicApiKeys` strips it, the test
   greps every body). Without that key the connector reports `unavailable` in
   /api/health capabilities and the route 503s; plaintext storage is refused.
 - CONNECTING IS NOT APPROVAL. kycStatus stays pending; activation's
   address-matched IBAN approves, exactly as for OAuth. The ONE shortcut: if the
   connected account ALREADY attributes an IBAN to this Safe address, that is
   the same evidence activation would produce, so it is taken at connect time.
   Any other IBAN in the snapshot is somebody's money routing — ignored.
 - A MOCK IBAN IS RETIRED on connect (funding.mode mock -> sandbox, iban
   cleared, status provisioning) so "Activate IBAN with passkey" appears. An
   app-provisioned active IBAN is KEPT — if the operator connects the very
   account the app's credentials belong to, the app profile IS their profile.
 - REMOVING KEYS keeps the IBAN recorded (it exists at Monerium regardless) and
   says in funding.detail that deposits/payouts pause until keys return.
 - POST is on the auth rate bucket (it is a credential check against a third
   party). Audit kinds `partner.credentials_connected/removed` record it.

UNPROVEN: no real Monerium app's client-credentials token has been used. Their
docs say an app created in an account acts with that account's scope; one run
against api.monerium.dev with real sandbox keys settles it, and the redeem leg
on a user client has only the guard branches exercised. Also unproven: the
OAuth refresh client-id change above (no test refreshes).

## BridgeEscrow REMOVED (Sep 2026)

`contracts/src/BridgeEscrow.sol` is gone, with its deploy step, its role
wiring, its contract tests and its `bridge` key in deployments.json.

WHY: it only ever served the CCTP-to-Stellar route, which is dropped. The live
cash rail is Bridge.xyz and never touched the escrow — `executeTransfer`'s
live branch transfers USDC straight to Bridge's deposit address. The escrow was
the DRY-RUN branch alone.

AND REMOVING IT MADE DRY-RUN MORE HONEST, not less. The lock produced a real
transaction on a real contract, recorded as `bridge.lockForPayout` — an
artifact that reads like a settlement to anyone scanning the transfer, for
money that had reached no bridge at all. That is the UPI lesson in miniature.
`recordBridgePlan` already writes `bridge.xyz.dry-run.transfer` with the plan's
idempotency key, which says what actually happened: a plan was recorded and
nothing moved.

CONSEQUENCES, all simplifications: dry-run leaves the USDC with the
orchestrator, so compensation is a plain reverse swap with no escrow release
first; `settlePickup` is a pickup-state change and nothing else; and the
`bridge.lockForPayout` / `bridge.release` / `bridge.settle` steps no longer
exist. A live failure after Bridge has the deposit is still MANUAL_REVIEW —
that was never the escrow's doing.

VERIFIED BEFORE DELETING: both deployed BridgeEscrow contracts on Base Sepolia
(the one in deployments.json and the different one CLAUDE.md had recorded —
they disagreed, so the file had been redeployed) hold ZERO USDC. Nothing was
stranded by dropping the addresses.

## Custody — the non-custodial path is the DEFAULT now (Aug 2026)

`npm run custody:test` (11 checks, no chain, no network).

THE BUG THIS FIXED, and it was a shipped default rather than a code path:
`LIQUIDITY_PROVIDER` defaulted to `fx-swapper`, which CANNOT be executed by a
user's Safe (its inventory is `onlyTrader`). So `prepareSafeSwapForTransfer`
returned null, the cash rail fell back to the plain debit, and the DEFAULT
deployment moved every sender's full balance to the orchestrator's own address
before swapping it. "We are non-custodial" was true only for an operator who
knew to change one env var. The fallback that got you there was a
`console.error` nobody reads.

WHAT CHANGED:
 - `LIQUIDITY.PROVIDER` defaults to **`best`** (over `LIQUIDITY_VENUES=lifi,dex`,
   both Safe-executable). `scripts/_local-chain.ts` pins `fx-swapper` with `??=`
   for hardhat, which has neither LI.FI nor a seeded pool. THE DIRECTION IS THE
   POINT: production inherits the safe default and the local demo names its
   exception, not the other way round.
 - `transfer.custody` is recorded on EVERY transfer and every rail:
   `mode: "non-custodial" | "orchestrator"`, a `reason` when custodial, and
   `feeToOrchestrator` stated rather than left to be discovered. It starts at
   the honest worst case and is narrowed ONLY when a batch is genuinely
   prepared — so a venue outage leaves the truthful answer behind.
 - `CUSTODY.requireNonCustodial` (`REQUIRE_NON_CUSTODIAL=1`) refuses at creation
   rather than falling back. NOT on by default and that is deliberate: with
   BRIDGE_LIVE unset there is no external deposit address to deliver into, so
   defaulting it on would brick every dry-run and testnet deployment including
   Base Sepolia. The PATH is the default; the GUARANTEE is opt-in.
 - A startup CUSTODY line says which mode this deployment will actually run in.
   VERIFIED LIVE across four configurations (default/fx-swapper/BRIDGE_LIVE/
   +REQUIRE_NON_CUSTODIAL) — each printed the right one.

WHAT IS STILL CUSTODIAL, stated rather than glossed:
 - The FEE always lands at the orchestrator (`feeTo: orchestratorAddress` in the
   batch). Judged revenue at the moment it moves, not client funds in transit —
   but recorded, not hidden.
 - Dry-run mode (BRIDGE_LIVE unset) delivers the batch output to the
   orchestrator because the local escrow demo pulls from it. Still user-signed,
   still one batch — and recorded as `orchestrator`, not quietly counted as a
   win.
 - The SEPA rail was ALREADY non-custodial for the principal and this did not
   change it: Monerium's redeem burns the payout straight from the Safe and only
   the fee moves (`DEBIT_STEP.safeFee`). Do not "fix" that into a full debit.

REGULATORY NOTE, since this is why it matters: custody is NOT the trigger for
most of what this app does. Money remittance under ZAG/PSD2 is *defined* as the
no-account case, and MiCA's exchange (Art. 3(1)(16)(e)) and transfer (l)
services trigger on acting "on behalf of clients". Being non-custodial narrows
the MiCA class and drops safeguarding; it does not remove the licence question.
Do not let this work be read as having answered it.

## Liquidity venues — tested, not assumed (last checked Aug 2026)

The problem: we cannot carry a treasury. The FxSwapper model holds inventory we
fund, which does not scale past a demo. Liquidity has to come from someone else
at execution time.

TESTED AGAINST THE REAL APIS, not docs:

**Bebop — see "Bebop — CORRECTED" below.** The July verdict of "does not work
for us" was drawn from base/polygon/gnosis only and is WRONG as a headline;
EURe is supported on Ethereum. One finding from that round still stands and is
load-bearing: Bebop returns `approvalTarget` SEPARATELY from `tx.to`, they are
the same contract today, so approving tx.to works by luck and would break
silently on a move to a separate settlement contract or Permit2. The same trap
exists in LI.FI. Approve what the maker NAMES.

**CoW Protocol — works, and is the likely answer.**
 - Quotes EURe->USDC on Gnosis at essentially the mid: 100 EURe -> 113.83 USDC
   (1.1383) against a live EUR/USD of ~1.1379.
 - Intent-based: you sign an order, solvers compete to fill it. No inventory on
   either side, which is the whole point.
 - `signingScheme: eip1271` — a Safe can sign the order itself. Same shape as
   the FP4 recovery plan.
 - RATE LIMITED, hard. Two quotes seconds apart returned 429 pointing at their
   Discord for a custom limit. indicativeRate() is cached for exactly this
   reason; the 60s default may still be too aggressive with real users, and a
   negotiated limit is worth asking for before this is production liquidity.
 - CowLiquidityProvider is wired for QUOTING ONLY. execute() refuses on
   purpose: placing an order needs an EIP-712 signature over CoW's order
   struct, and a decision about who signs — the user's Safe with the user
   present, or the orchestrator. Half-working execution would be worse than
   none.

**Best execution + surplus (Aug 2026).**
 - LIQUIDITY_PROVIDER=best quotes every venue in LIQUIDITY_VENUES in PARALLEL
   and takes the largest out for the same in. With an aggregator sitting beside
   a single-pool adapter, choosing by config means settling worse whenever the
   other venue wins — silently, with nothing in the record. Losers AND their
   failure reasons are stored on the quote (`routing`), so a route choice is
   auditable after the fact. One venue down does not sink a trade another can
   price; ALL failing REFUSES rather than falling back to our own book.
 - NOT netted against gas. On these L2s gas is cents against a corridor trade,
   and faking that precision would be worse than the omission — but a venue
   winning by a hair on price could lose on cost. Revisit if venues land close.
 - SURPLUS (positive slippage) is MEASURED and ATTRIBUTED, never silent.
   LIQUIDITY_SURPLUS_POLICY defaults to `user` and that default is load-bearing:
   the receipt reports marginBps MEASURED between the live mid and what we
   deliver, so pocketing surplus quietly would make that number understate what
   we take — the exact dishonesty the live-rates work removed. `treasury` is
   supported and still records the amount, so it can be reflected in the margin
   instead of hidden inside it. Keeping the spread is a business decision;
   hiding it is not one the code will make.
 - npm run best:test (13 checks, injected stub venues, no chain/network). The
   router takes injected venues because config is frozen at first import — an
   env flip after that silently exercises the default and passes for the wrong
   reason.

**Bebop — CORRECTED Aug 2026. Monerium is a market maker ON Bebop.**
 - bebop.xyz/case-studies/monerium: Monerium joined Bebop AS A MARKET MAKER,
   streaming firm EURe quotes into the network. Issuer-led liquidity — the
   issuer itself is the counterparty, so there is no intermediary spread. Live
   on ETHEREUM, more chains planned. EURe trades against stablecoins, ETH, WBTC
   and hundreds of others; six-figure swaps supported.
 - THIS OVERTURNS THE JULY VERDICT of "does not work for us". That verdict was
   drawn from base/polygon/gnosis, where EURe still IS TokenNotSupported — the
   partnership is on the one chain we had not been able to test.
 - WHY WE COULD NOT SEE IT: ethereum and arbitrum return
   "UnknownError: UnknownError" for EVERY pair, including a USDC->WETH control
   that must work. So that error is auth, not token support. Access is gated
   behind an API key requested via their contact form; a `source` header alone
   does not open it. Any future "is X supported" test on Bebop MUST run a
   known-good control on the same chain, or an auth failure reads as an
   unsupported token.
 - OUR ADAPTER IS ALREADY CORRECT AND NEEDS NO CODE: RfqLiquidityProvider sends
   Bebop's documented `source-auth` header and parses the v3 shape. Set
   BEBOP_API_KEY, BEBOP_CHAIN=ethereum, and add `rfq` to LIQUIDITY_VENUES — then
   it competes on price like any other venue rather than being trusted blindly.
 - OPEN QUESTION BEFORE USING IT: EURe-on-Ethereum is 0x39b8B638…, and the
   best-execution router assumes all venues sit on the app chain. Routing
   through Bebop means holding EURe on Ethereum (or bridging), and mainnet gas
   against a corridor-sized transfer is a real cost that the router does NOT
   net out. Better price, dearer settlement — measure both before switching.

**LI.FI — the production venue (Aug 2026). Aggregation beats one pool.**
 - TESTED LIVE, not assumed: 100 EURe -> USDC returned EXECUTABLE quotes on
   Gnosis 1.1493, Base 1.1506, Polygon 1.1491 against a live mid of ~1.1511 —
   4 to 17bps — routed via Nordstern Finance / Fly / Bitget. A hand-rolled
   Uniswap adapter can only ever see Uniswap; none of those venues would have
   been in a hardcoded list. That breadth IS the argument for an aggregator.
 - EURe exists on more chains than assumed (Monerium production /tokens):
   ethereum 1, gnosis 100, polygon 137, base 8453, arbitrum 42161, linea 59144.
   So Base mainnet is a real option, not only Gnosis.
 - IT CANNOT BE EXERCISED ON A TESTNET. It LISTS Base Sepolia (84532) but
   answers 404 "No available quotes" there even for WETH/USDC, which has real
   Uniswap depth — so it is the Bebop gap again. Hence `dex` stays as the
   locally-provable path and `lifi` is what ships. Keep both; neither replaces
   the other.
 - approvalAddress EQUALS transactionRequest.to today (both the LI.FI Diamond
   0x1231DEB6…). Approving tx.to would therefore work by luck and break
   silently the day routing moves to a separate settlement contract or Permit2 —
   the identical trap already found on Bebop. We approve what it NAMES.
 - NO EXPIRY IS RETURNED (executionDuration: 0), so the only staleness bound is
   the one we impose via the quote's expiresAt.
 - The mid-deviation guard matters MORE here than for a pool: route selection is
   delegated to a third party, so the price is still checked against rates.ts
   before we bind. assertPriceSane names the venue in its refusal.
 - 1INCH IS DOMINATED BY THIS: mainnet-only, needs an API key we do not have,
   and LI.FI aggregates across aggregators (it can route through 1inch itself).
 - BEBOP JIT REMAINS RULED OUT for EURe on evidence, not preference —
   TokenNotSupported on base/polygon/gnosis, no testnet.
 - npm run lifi:test (16 checks, stub LI.FI shaped from a captured live Base
   response, no chain). UNPROVEN: no real swap has executed.

**Uniswap v3 — the one that executes, and the one we build on.**
 - VERIFIED ON-CHAIN with eth_getCode on Base Sepolia (84532), not read off a
   docs page: Factory 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24, SwapRouter02
   0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4, QuoterV2
   0xC5290058841028F1614F3A6F0F5816cAd0df5E27, NonfungiblePositionManager
   0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2, Permit2. Monerium's real EURe on
   that chain is 0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85 (18dp, from their
   /tokens), USDC is 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6dp).
 - CHOSEN OVER 1INCH DELIBERATELY. 1inch is mainnet-only, so a 1inch adapter
   could never be exercised before it touched real money — exactly how the Bebop
   adapter ended up correct and unrun. The v3 interface is identical on Base
   Sepolia and Base mainnet, so the tested path is the shipped path. 1inch still
   fits later as a mainnet ROUTING layer behind the same seam.
 - THERE IS NO EURe/USDC POOL on Base Sepolia at any fee tier (100/500/3000/
   10000 all empty), while WETH/USDC has real depth — so the testnet DEX is
   genuinely used, just not for EURe. `npm run dex:setup [-- --fix]` creates and
   seeds one. That pool is a TEST FIXTURE, NOT A TREASURY: on mainnet the
   counterparty is everyone else's liquidity, which is the whole reason for
   leaving FxSwapper. Never read a Base Sepolia quote as evidence of pricing.
 - THE GUARD THAT MATTERS, and the way a pool differs from a maker: an RFQ maker
   names a price it will honour, but an AMM pool is simply wherever the last
   trade left it, and anyone can move a thin one. So every quote's implied
   USD/EUR is checked against the independent live mid from rates.ts and REFUSES
   beyond DEX_MAX_MID_DEVIATION_BPS (300 default). Without it, skewing a pool
   would make us quote, bind and settle a real transfer at that skew while
   reporting it as the market. The pool is also pinned onto the quote, so
   execute() cannot drift to a different, unchecked one, and amountOutMinimum
   carries the quoted floor into the router.
 - amountOut is MEASURED as a balance delta after the swap, not copied from the
   quote — the router reverting on a bad fill and the amount actually received
   are two different facts.
 - npm run dex:test (12 checks, no chain). UNPROVEN: no real swap has executed,
   because seeding needs EURe and there is no faucet for it — it is only minted
   against a real SEPA deposit. Deployer holds 21 USDC / 0 EURe today.

CONSEQUENCE FOR THE CHAIN DECISION: EURe's deepest liquidity is on GNOSIS, and
Monerium is Gnosis-native. Base Sepolia was chosen for testing because gas is
~9,000x cheaper than Amoy, which was right for testing and says nothing about
production. If CoW-on-Gnosis is the liquidity route, Gnosis is the natural
production chain — not Base, not Polygon. Decide it deliberately.

## FP4 completion — recovery (decided July 2026, 2-of-2)

THE BLOCKER: losing the browser device key permanently bricks an account.
`RemitVault.setAuthorizer` only lets the CURRENT authorizer rotate, and the
key lives in localStorage. No passkey, no support path, no ramp override
recovers it. Demonstrated live: the "Base Proof" account on Base Sepolia has
EUR 121 credited and can never spend it. Consumer smart-wallet research
consistently finds users will not fund an account without credible,
*rehearsable* recovery — so this gates launch, not polish.

THE FIX, in this order (the order is not optional):
 0. Refuse to issue an IBAN until a passkey exists. An IBAN is the point of
    no return — after it, money can arrive. DONE (passkeyRequiredBeforeFunding,
    gated on allowSimulation so e2e/local demos still run).
 1. Passkey becomes a Safe owner (abstractionkit `fromSafeWebauthn`),
    replacing the server-held user key path.
 2. Add the co-signer as a second owner, threshold 2. 2-of-2 for now —
    Privy/Turnkey cost money, so the third (social-login) signer is deferred.
    Owner actions still need both passkey and co-signer signatures. Production
    payment relays use a token-scoped AllowanceModule delegate so the API can
    move only within the configured allowance instead of holding a user owner key.
 3. setAuthorizer(safe, safe). `_isValidSignature` already accepts EIP-1271,
    so NO CONTRACT CHANGE. After this authorizerOf never changes again.
 4. Install Candide's SocialRecoveryModule with guardians. With only 2-of-2
    there is no spare signer, so guardians are REQUIRED, not optional.
 5. DONE: delete the server-held user Safe owner key path; db.json now still
    carries senderProfile PII but not user Safe owner keys.

WHY THE ORDER: steps 1-2 must precede 3. Pointing authorizerOf at a Safe while
the server owned it would have handed the database spending power over every
balance. That server-held user owner path has been removed.

VERIFIED, so nobody re-litigates it:
 - RIP-7212 (P256 precompile) is LIVE on Base Sepolia AND Base mainnet —
   tested with a real generated signature. Passkey-owned Safes need no
   verifier contract.
 - abstractionkit 0.4.0 (already a dependency) exports SocialRecoveryModule,
   SocialRecoveryModuleGracePeriodSelector, fromSafeWebauthn,
   webauthnSignatureFromAssertion, WebauthnDummySignerSignaturePair.
 - RemitVault._isValidSignature staticcalls isValidSignature for contract
   signers — the hook is already there.

WRINKLE TO DESIGN IN FROM THE START: redeemToIban signs as the Safe to burn
EURe, and runs asynchronously after the user has gone. A passkey-owned Safe
cannot be signed by the server alone. Collect BOTH signatures at send time —
the vault authorization and the Monerium redeem message. Both are fully
determined when the user approves (amount + IBAN), so nothing is signed blind.

HARD EDGE: only the current authorizer can rotate, so accounts that still
hold their device key can migrate themselves; ones that lost it never can.
This fixes the future, not the past.

BACKSTOP, NOT A PRODUCT: EURe is e-money, so Monerium's liability is to the
identified customer and holders have a redemption right at par — unlike USDC,
where Circle owes the holder nothing. Monerium also has the technical means
(EURe is a UUPS proxy they own, with mint(); no burn/recover/forceTransfer
selector exists in the deployed implementation). So a lost wallet is likely
recoverable through re-KYC and reissuance. UNCONFIRMED — not in their docs,
ask them in writing. It does not cover USDC or in-flight transfers, does not
restore the Safe, and "submit ID and wait" is not a recovery path to put in
front of someone whose salary is in the account.

## Roadmap (agreed priority)
0. Payout partners secured (July 2026): **dLocal** (crypto product:
   stablecoin-funded payouts, 60+ markets — UPI/India, M-Pesa/Kenya, PIX/
   LATAM; docs.dlocal.com has a public sandbox) and **Yellow Card** (Africa,
   ~20 markets, settles natively in USDC — no prefunding). Build PayoutRail
   adapters for both; Kenya gets two live options (route to best price).
   Pin down per-corridor: settlement currency, prefunding terms, fees/FX,
   recipient KYC ownership, speeds/caps.
1. Iron (iron.xyz, MoonPay) sandbox → USD/GBP funding adapter. Access is
   request-based; user must request it. EUR stays direct-Monerium.
2. Mony partnership (UPI One World app; replied to user's tweet):
   stablecoin top-up of Mony wallets via our SEPA exit → their Banking
   Circle account. Their inbound is manual screenshot reconciliation —
   pitch = we become their reconciliation/API layer. Bebop RFQ for
   crypto→EURe conversion. Constraints learned: ~2% top-up fee, €25 exit
   fee, low-KYC tier caps; SEPA Instant is EU-mandated since Oct 2025 so
   the "24h" is their internal crediting, not the rail.
3. Public-chain deployment — DONE on **Base Sepolia (84532)**, not Polygon.
   The Polygon case was "EURe is native there"; Monerium's production /tokens
   shows EURe on SIX chains — ethereum 1, gnosis 100, polygon 137, base 8453,
   arbitrum 42161, linea 59144 — so that argument no longer selects a chain on
   its own. Choose on liquidity and gas instead: LI.FI quoted best on Base
   (1.1506 vs 1.1493 Gnosis, 1.1491 Polygon), CoW's EURe depth is on Gnosis,
   and Bebop's Monerium market-maker feed is on Ethereum. Nothing is pinned:
   TRANSF_CHAIN_ID selects the chain and deployments.json is keyed by it.
   Monerium sandbox chain names verified: `amoy`, `basesepolia`.
4. Passkey-as-Safe-owner (true non-custodial; today passkey is auth only).
5. Card rail — **Immersve** (immersve.com, docs.immersve.com). Mastercard
   PRINCIPAL MEMBER, so they are the issuer rather than a reseller (contrast
   Gnosis Pay, which routes through Monavate). Three funding protocols:
   - *Approval-based* (Universal EVM): cardholder spends straight from their
     own wallet via a standard ERC-20 approval — no deposit, no migration.
   - *Flexi deposit*: a dedicated cardholder-scoped contract, balance readable
     on-chain, PERMISSIONLESS withdrawals (the user can always exit).
   - *Universal deposit*: one shared partner-scoped contract, cheaper gas.
   Authorisation flow: Mastercard sends the auth, Immersve reads the chain in
   real time, and on sufficient funds pulls the token, converts to fiat via
   Circle and settles with Mastercard.
   Chains: Algorand, Arbitrum, **Base**, BNB, Ethereum, **Polygon**, Sei —
   both chains we care about are covered.
   THE CATCH: **USDC/USDT only. No EURe.** Our vault holds EURe, so a card
   cannot spend the balance directly. Either the user keeps a USDC sleeve, or
   we convert on demand — which the cash rail already does (FxSwapper /
   JIT RFQ), so the machinery exists. Note this puts EUR/USD FX between a
   user's balance and their card spend; on the RECIPIENT side that question
   disappears, since they can be paid in USDC and spend it.
   Also: Immersve runs its own KYC ("Immersve Conducted KYC", recommended for
   non-custodial), so it is a second identity relationship alongside
   Monerium's, not a reuse of it.
   Best fit is the receiving end — a recipient who can spend beats one
   collecting cash at a counter. Unanswered: issuer of record per region
   (their site says "regulatory licenses" without naming entities, and our
   regulator page names entities precisely), and per-region availability.
Parked deliberately: NEAR Intents (future multi-chain deposits), Metastable
(EURe↔EURC later), Flexa/AMP (no — wrong market, card program beats it).

## Running the app — which command, and what it costs (Aug 2026)

`npm run dev` and `npm run api` are NOT interchangeable, and picking wrong
wastes an hour on errors that look like bugs.

| | `npm run dev` | `npm run api` |
|---|---|---|
| chain | local hardhat 31337 | whatever TRANSF_CHAIN_ID says (84532) |
| database | `data/db.dev.json`, **WIPED every start** | `data/db.json`, preserved |
| passkey Safe deploy | **IMPOSSIBLE** | works |

PASSKEY SAFE DEPLOYMENT CANNOT WORK UNDER `npm run dev`. It goes through an
ERC-4337 bundler and paymaster, and a local hardhat node has neither — the call
reaches Candide asking about CANDIDE_CHAIN_ID for a Safe that exists only on
this laptop. Before the guard it failed as a bare "Failed to fetch" in the
browser, which reads as our bug rather than a chain that cannot do the
operation. The API now refuses with 409 and names the mismatch.

Corollary worth remembering: `npm run dev` wiping its own db is why a test
account vanishes between runs, and why the live accounts in `data/db.json`
(including any with an on-chain-bound authorizer) must never be exercised with
it.

## Multi-agent workflow (THREE+ agents work this repo)
Claude (local sessions) and OpenClaw (friend's agent) both commit here. The
PR #3 merge silently dropped a pushed commit because both touched the same
branch (stale head at merge time; recovered in PR #4). Rules:
- Branch prefixes: `claude/*` for Claude sessions, OpenClaw uses its own
  branches. NEVER push to a branch the other agent created.
- main is PR-merge only. Before merging any PR, confirm its head SHA equals
  the commit you last pushed; after merging, verify the content actually
  landed (grep the tree, don't trust "merged: true").
- Start every session with git fetch; expect main to have moved.
- Agents seen on this repo: `claude/*` (local sessions), OpenClaw, `pinky/*`
  and `baer/*`. Expect main to move mid-session — it did repeatedly in Aug 2026.
- A merge reporting success is not proof. PR #80 merged at the right SHA and a
  later check still read as "absent" — the check was broken (zsh treats `:s/`
  in `$REF:services/...` as a substitution modifier, so `git show` got a mangled
  ref and grep counted zero). Build the ref in a variable first, and confirm a
  file is READABLE before believing a grep count of zero.

## Style
- User wants prose without AI-marketing jargon (see README voice: what's
  real vs simulated, specifics over adjectives, shortcuts stated openly).
- Honest assessments valued over cheerleading; say what's mocked.

## Shareable receipts — /r/:slug (Aug 2026)

DESIGN SOURCE: `~/Downloads/Zold Mobile Dashboard Redesign.zip`. The filename
lies — the bundle inside is `design_handoff_receipt_share`, "Zold Receipt Share
— Public Tracking Page", not the mobile dashboard. Its README is a real spec.

WHAT SHIPPED: a sender opens "Share receipt" from transaction detail, picks what
the link exposes, and copies `/r/<slug>`. A recipient opens it with no account.
`services/api/src/receipt.ts` builds the payload, `public/receipt.html` renders
it, `store.receiptShares` holds the selections. npm run receipt:test (20 checks,
no chain, wired into check.ts).

THE LOAD-BEARING PROPERTY, and what the test actually proves: redaction happens
server-side. A withheld field is never in the JSON — the test serialises the
whole payload and greps it for each secret, because "the page does not draw it"
and "the page was not sent it" are different guarantees and only the second one
survives someone opening devtools. Withheld fields come back as
`{withheld:true}` with no value, so the page can still draw the ▒ block the
design asks for without ever holding the thing.

FOUR PLACES THE DESIGN WAS NOT FOLLOWED, deliberately:
 - THE SLUG. The mock prints `zold.to/r/8842-1170` — eight decimal digits, 10^8,
   enumerable in hours, and every hit is a real name and amount on an
   unauthenticated page. Kept the grouped shape, widened to 15 Crockford base32
   chars (~75 bits), ambiguous glyphs excluded. `/api/r/` is also bucketed with
   the auth rate limits, since guessing a slug is guessing a credential.
 - THE SIX ROUTE HOPS. The design draws a fixed Zold Safe → Base → Monerium →
   SEPA Instant → Stellar/MYKOBO → MoneyGram route with a hardcoded block
   number. That is not this codebase: MYKOBO appears nowhere, the SEPA rail has
   no Stellar leg at all, the swap goes through whichever liquidity venue won,
   and no block/finality data is stored. Hops are derived per rail from `txs`,
   `liquidity`, `sepa` and `pickup`; a leg that did not run is not drawn, and a
   leg that ran in simulation (CCTP dry-run, mock SEPA) carries `simulated` and
   renders an amber badge. The Base mark only appears when CHAIN_ID really is
   Base — otherwise the hop shows a step number.
 - "REFERENCE & PURPOSE". There is no purpose field on a Transfer. The toggle
   governs the SEPA remittance `reference`, and is labelled for it.
 - TOKENS. The public page uses the receipt handoff's own palette (#ed188d,
   #050506); the in-app composer uses the APP's (--m-pink #ff2d8b). The composer
   sits between Activity and detail and would clash with every screen beside it
   in a second pink. This is not a reopening of the settled token question — it
   is one surface with its own spec versus one inside the app.

ALSO DECIDED: one share per transfer (re-posting edits it, so narrowing a
selection narrows the live link rather than leaving a generous older one alive);
editing does NOT extend the 30-day expiry; revoking keeps the slug recorded so a
holder is told "revoked" rather than getting a typo's 404; a share is refused
while the transfer is still CREATED, because nothing has moved yet.

The in-app composer is a full screen, not the handoff's side-by-side card and
live 520px page preview — 412px cannot hold both, and a shrunken unreadable copy
answers none of the question the composer asks. The preview is a list of each
field and whether it survives.

HOW FAR IT WAS VERIFIED: the payload builder is unit-tested (20 checks incl. the
leak sweeps) and the page was driven in a browser against real buildReceipt()
output for the full / fully-redacted / SEPA / in-flight / revoked / expired
cases. The Express routes and the composer's POST/DELETE were NOT booted — see
the toolchain note below.

!! TOOLCHAIN: `.toolchain/node-v22.17.0-darwin-arm64` IS THE WRONG ARCH for the
machine this ran on (Intel x86_64 — `arch` says i386, and `arch -arm64` reports
"Unknown architecture"). So `npm run dev/api/<anything>:test` all fail with
"Bad CPU type in executable", and node_modules holds an arm64 esbuild, so tsx
dies too. There IS a system node now (nvm v24.13.0, x86_64) — the "machine has
no system Node" line in Environment above is stale. `npm run typecheck` works
(tsc is pure JS); to run a test, compile it with `npx tsc --outDir <tmp>` and
run the emitted JS with the system node.

## Pay with Zold — moved to its own repo (July 2026)
The merchant checkout / "Pay with Zold" product was extracted to
**github.com/tonyzil/pay-with-zold** (private; the directory on disk is
`zold-checkout`) to keep this consumer app lean. The backend OAuth handoff +
existing-user checkout that briefly lived here (checkout.ts, checkout.html,
checkout-test.ts, the /api/checkout/* routes, and store Merchant/PaymentIntent)
were REMOVED from this repo. Do not rebuild them here.
That repo OWNS the authorization-server half — merchant registry, payment
intents, PKCE code exchange — plus the new-user onboard-in-flow (account -> KYC
-> device key -> funding -> device-signed SEPA -> merchant code). It is a
CLIENT of this API: an allowlisted proxy, source of truth for nothing but
merchants and intents. It runs on its own origin because passkeys are
RP-ID-scoped and the FP4 device key lives in one origin's localStorage, so a
user onboarded there has both halves in one place.
SEPA remittance reference (July 2026): POST /api/transfers takes an optional
`reference` on the sepa rail and it rides on the payment, so a payee reconciles
against their own handle instead of our uuid. The memo used to be hardcoded to
`Zold <transfer.id>` — a merchant could see that Zold sent money but not which
of their users it was for, which is the manual step the checkout exists to
remove. services/api/src/sepa.ts folds it into the SEPA Latin subset (accents
decomposed, so "Müller" arrives as "Muller" not "M ller"), strips the reserved
slash forms, and truncates the REFERENCE rather than our id — half an id
identifies nothing. 140 chars is the scheme limit and the route refuses a
longer one rather than silently shortening the string the payee reconciles on.
npm run sepa:test (12 checks, no chain). NOT proven end to end: the redeem call
only runs in Monerium sandbox mode, so the memo has never reached a real
statement.
WHAT THIS API STILL OWES IT:
- RP_ID + WEBAUTHN_ORIGINS must cover the checkout origin or every passkey
  ceremony started there is rejected HERE, which reads like a client bug.
  Production: RP_ID=zold.app with app.zold.app + checkout.zold.app both listed.
  Locally: RP_ID=localhost and WEBAUTHN_ORIGINS including localhost:3100.
- No way for it to see a transfer reach a terminal state. It reads the transfer
  with the USER's session at attach time, so the intent's status freezes there
  and the merchant polls after the user has gone — on a real SEPA payout an
  intent would sit at AUTHORIZED forever. Needs a checkout webhook from here,
  or a service credential that can read a transfer without a user session.
  Not visible locally: hardhat settles to PAID before attach.
- public/device.js keeps ONE key slot per origin, not per user. On a shared
  browser a second person onboarding binds the FIRST person's key as their
  authorizer, and either could then spend the other's balance. The checkout
  refuses rather than sharing a key; the real fix is a per-account slot here.
- KYC ordering is fixed by us, not by them: /api/users/:id/authorizer calls
  requireKycApproved, so KYC must precede the device key. Any handoff doc that
  says otherwise is describing an order the API will refuse.
Two bugs the deleted checkout.html had are recorded in that repo's README so
they are not reintroduced: it loaded /device.js with no import map (the
vendored noble modules import the bare specifiers `crypto` and
`@noble/hashes/crypto`, so the module never loaded and signing hung), and it
built the attach URL from `intent.id` where the API returns `intentId` — the
payment cleared on-chain and the merchant was never told. Neither was visible
to checkout-test.ts, which drove the backend directly.
