# Money movement — custody, liquidity, fees, rails

Read before touching a quote, a swap, a debit, the cash rail or the Stellar leg.

*Decision history: the reasoning behind the current invariants, kept as written
apart from naming.*

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
   the recovery plan.
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

## Fees — SEPA is free (Sep 2026)

`FX.FIXED_FEE_EUR` is gone. Fees are per rail through `railFeeEur(rail)`:
`SEPA_FEE_EUR` defaults to 0 (Monerium charges nothing for the redeem, so
neither do we), `CASH_FEE_EUR` to 0.99 on the closed cash corridor, both env-
overridable. Conversions carry no Zold fee. Consequences: the SEPA fee debit
leg (`DEBIT_STEP.safeFee`) runs only when the fee is positive, quotes and the
app print no fee row at zero, and the receipt omits "Zold fee" rather than
printing €0.00. safe-funded-recovery-test pins `SEPA_FEE_EUR=0.99` for its
"only the fee comes back" case, which needs a fee to move.

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
- Travel Rule / SEP-12 (July 2026) — THE STORED PROFILE IS GONE (Sep 2026, see
  "Sender profile removed" in docs/notes/identity-and-security.md);
  `user.senderProfile` and its two routes no
  longer exist and the adapter takes per-call `SenderDetails`. The rest of this
  bullet is kept for what was verified against the anchors:
  a cash pickup is a money transmission, so
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

