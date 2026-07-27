# Zold — notes for Claude sessions

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
  PII: senderProfile lands in plaintext db.json alongside private keys — a real
  deployment must keep it with the KYC provider and store only a reference.
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
  npm run trustline:test covers it live. NOTE MG_ANCHOR_ASSET still defaults to
  SRT (testanchor's token) — MoneyGram needs USDC.
- CCTP: dry-run by default; CCTP_LIVE=1 + funded CCTP_BURNER_KEY executes
  (faucet.circle.com for testnet USDC). Stellar CCTP domain is 27; mint
  recipient AND destinationCaller must be the CctpForwarder.

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

## Current state (July 2026)
- Repo: github.com/tonyzil/transF (private). The GitHub rename never
  happened — pushing to .../Zoll.git returns "Repository not found", so
  `transF` is the live remote, not just the directory name. PR #1 open:
  feat/passkey-onboarding-destination-send (passkey onboarding wizard,
  destination-first send flow, README rewrite).
- Working: three payout rails (KES cash / SEPA / UPI), Candide Safe
  wallets deployed gasless with EIP-1271 Monerium linking, live anchor
  payouts, e2e green across all rails.
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
FP4 still open (key-custody half): `user.privateKey` remains in db.json —
Monerium linking + redeem still sign server-side. The plan stands: Candide
WebAuthn Safe owner (fromSafeWebauthn) signs the Monerium declaration +
orders via the passkey, then the passkey-owned Safe replaces the browser
EOA as the vault authorizer (no contract change needed). The send-time passkey prompt is now
the real gate: the device key is encrypted at rest with WebAuthn PRF
(HKDF -> AES-GCM, only {iv,ct} in localStorage), so each payment needs a
ceremony to unwrap; authenticators without PRF fall back to an unwrapped
key labelled protection:"none". npm run fp4:test covers the envelope
headlessly. UNVERIFIED without a real authenticator: that PRF is offered
at all, and that it returns the SAME 32 bytes across ceremonies — if not,
a wrapped key is unrecoverable after reload. Test that first in a real
browser before trusting the wrap.
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
least auditable via kyc.applicantId), and db.json still holds privateKey +
senderProfile PII in plaintext.
Launch gate: local demos fine; NOT safe hosted, with real funds, or claiming
payout finality until FP1-FP4 done.

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
3. Public-chain deployment — decision leans POLYGON over Base: EURe is
   native there (kills the mirror-seam), CCTP live (domain 7), Candide
   covers it (and founders are user's friends — also ask them about
   WebAuthn Safe owners for FP4). Monerium sandbox chain name = `amoy` (VERIFIED; other aliases rejected).
   Safes keep the same address cross-chain.
4. Passkey-as-Safe-owner (true non-custodial; today passkey is auth only).
Parked deliberately: NEAR Intents (future multi-chain deposits), Metastable
(EURe↔EURC later), Flexa/AMP (no — wrong market, card program beats it).

## Multi-agent workflow (two agents work this repo)
Claude (local sessions) and OpenClaw (friend's agent) both commit here. The
PR #3 merge silently dropped a pushed commit because both touched the same
branch (stale head at merge time; recovered in PR #4). Rules:
- Branch prefixes: `claude/*` for Claude sessions, OpenClaw uses its own
  branches. NEVER push to a branch the other agent created.
- main is PR-merge only. Before merging any PR, confirm its head SHA equals
  the commit you last pushed; after merging, verify the content actually
  landed (grep the tree, don't trust "merged: true").
- Start every session with git fetch; expect main to have moved.
- OpenClaw's token expires soon (July 2026) — its activity may stop.

## Style
- User wants prose without AI-marketing jargon (see README voice: what's
  real vs simulated, specifics over adjectives, shortcuts stated openly).
- Honest assessments valued over cheerleading; say what's mocked.

## Pay with Zold — merchant checkout (July 2026, slice 1 of 2)
BACKEND DONE: OAuth-style handoff so a partner (Mony) can embed a "Pay with
Zold" button. We are the authorization server (mirror of the Monerium
OAuth-connect flow). services/api/src/checkout.ts + store Merchant/
PaymentIntent + routes: GET /api/checkout/authorize (PKCE S256, creates
intent, redirects to /checkout?intent=), GET /api/checkout/intents/:id
(public info for the UI), POST /api/checkout/intents/:id/attach (user links
their device-authorized SEPA transfer into the merchant IBAN → one-time
code + redirect), POST /api/checkout/token (merchant: code+verifier+secret →
status+bearer, burns code), GET /api/checkout/status/:id (poll). Demo
merchant seeded only when SECURITY.allowSimulation (clientId demo-merchant,
CHECKOUT_DEMO_IBAN). npm run checkout:test proves the whole handoff for an
existing user (Version 1), incl. wrong-PKCE rejection. e2e still green.
The payment reuses the real quote→transfer→device-authorize path (no new
money-movement code); attach refuses unless the transfer is the user's, SEPA,
pays the merchant IBAN, matches the amount, and has left CREATED.
SLICE 2 (TODO, needs a real browser): the /checkout UI page — passkey login
(existing) or onboard (new, tiered KYC), show "Pay €X to <merchant>", run the
transfer+device step-up, call attach, redirect back. Also: merchant registry
beyond the demo seed, signed webhooks on status change, and the Version-3
onboard-in-flow (new users). KYC caveat stands: at pay time Zold is the
regulated entity; first-party top-up to the user's own KYC'd Mony wallet is
the lighter category.
