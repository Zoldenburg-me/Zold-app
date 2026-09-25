# Roadmap and payout partners

*Decision history with the per-partner detail, kept as written apart from
naming.*

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

## 1inch Aqua — a card primitive wearing an AMM costume (Sep 2026)

PROPOSAL ONLY, nothing built: `docs/1inch-aqua-card.md`. The pitch is that
1inch Card is custodial (Baanx holds, Monavate issues) and Aqua is the thing
that fixes it, with Zold supplying the Safe and the EURe/IBAN leg.

WHAT AQUA IS, having read the 80-line `Aqua.sol` rather than the marketing:
one mapping the source itself comments "aka makers' allowances", keyed
maker -> app -> strategyHash -> token -> balance, and four verbs — `ship`
(grant), `dock` (revoke), `pull` (spend, `msg.sender` IS the app), `push`
(return). No owner, no pause, no upgrade, never holds a token, no signature
scheme — so a Safe can be a maker. It is a revocable scoped spending-rights
registry; the AMM is one app on top.

VERIFIED on chain (eth_getCode + selector search in the deployed bytecode):
 - `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` is live on Base mainnet and
   Gnosis, identical 11,240-byte deterministic deploy, carrying the ship/dock/
   pull/push/rawBalances selectors.
 - The address in 1inch's own developer-release blog post is a different
   contract. `0x499943e74fb0ce105688beee8ef2abec5d936d31` is also live on Base
   (12,504 bytes) with the same ABI: the Nov 2025 preview. With two registries
   on one chain, virtual balances shipped to the wrong one sit where no app
   reads them. Pin the repo address, not the announcement's.
 - Not on Base Sepolia (empty code). As with LI.FI, this cannot be exercised
   on our test chain. Fork Base mainnet or work on Base/Gnosis.

**Two traps.** `ship()` checks neither the wallet balance nor the ERC-20
approval, so a virtual balance is a ceiling, not a reserve; the auth-vs-clearing
tier design in the doc exists because of this. And `push()` requires an active
strategy, so a refund to a docked card reverts. Do not treat `dock()` as "close
the card" until the refund window shuts.

LICENSE GATE: Aqua is `LicenseRef-Degensoft-Aqua-Source-1.1`, © Degensoft Ltd —
source-available, not open source. A CardApp needs a licensing conversation.

**Issuer question: settled, and it changes the pitch.** Baanx, the company
behind the 1inch Card, already sells non-custodial. They run the MetaMask Card
(funds stay in the user's wallet on Linea, user-set caps, a contract authorises
in under five seconds), list custodial and non-custodial as two tiers of one
platform across EVM and Solana, and shipped the first non-custodial on-chain
card with Tezos in 2024. Ledger, Exodus, Trust Wallet and 1inch all run Crypto
Life cards there; 1inch is on the custodial tier. Also live: Gnosis Pay (user's
own Safe on Gnosis + Monerium EURe + a personal IBAN, which is our stack, on
Visa, in the EEA), Kulipa (issuer processor sends the auth, Kulipa moves funds
to an on-chain escrow, then clears: pull-at-auth, proven), Rain (Visa principal
member, per-customer contract the customer owns), Immersve (Mastercard
principal member, on-chain funding contracts).

**Where the gate is now.** Each of these binds the card to the provider's wallet
on the provider's chain: MetaMask's smart account on Linea, a Gnosis Pay Safe on
Gnosis that reads view-only in Safe{Wallet} because their modules own it, a Rain
contract, Immersve's Funds Storage. "Non-custodial" currently means your keys,
our wallet, our chain. Aqua fills that gap, and it is the only part 1inch would
own. Latency is settled (under five seconds, precedented); the open question is
commercial.

**Security incident.** On 1 Jun 2026 attackers exploited the Zodiac Delay +
Roles modules on Gnosis Pay's card Safes (missing status check in a static
call); ~$1.5m was extracted and Gnosis covered it. Those modules sit on the
user's wallet. Aqua installs nothing on the wallet: it is an ERC-20 allowance
and 80 lines with no owner. The corollary: Aqua has no delay mechanism, so the
auth-vs-user-withdrawal race is unhandled unless you pull at authorisation. Do
not handle that by adding a delay module.

COUNTERPARTY TIMING: Exodus is acquiring Baanx for $175m, expected to close
early 2026 subject to US/UK/EU approval.

**The card programme still has to accept Aqua as its pull source,** and none
do. Size of the change, read from Immersve's source (not their docs):
`FundsStorageLogic.directSpendDebit()` under `FundingMode.APPROVAL` already does
`safeTransferFrom(_token, spender, address(this), amount)`. So a Mastercard
principal member already ships "user keeps the money, we pull at spend time with
an idempotency key and a reversal window". Moving that to Aqua is one call
(`AQUA.pull(...)` instead of `safeTransferFrom`, inherit `AquaApp`); their
idempotency, reversals, pause and roles are untouched. One line in principle; in
practice a contract change, an audit and a product decision, all of them theirs.

**Pull-at-authorisation is the only safe tier for an Aqua card.** Aqua's
`dock()` is unconditional and immediate, and the app cannot delay, veto or
foresee it, so a cardholder can spend at a terminal and dock before clearing.
Gnosis Pay's 3-minute Delay Module exists to close that race. Aqua reopens it,
and no module can be added because dock() is called on Aqua directly.

GNOSIS PAY IS THE ONE PLACE AQUA WORKS WITH NOBODY'S PERMISSION — full write-up
in `docs/aqua-on-gnosis-pay.md`, read from `gnosispay/account-kit` source, not
their docs page. Setup renounces the Safe's ownership (`swapOwner` to the
placeholder `0x..02`), so the Safe is module-only: a Roles module scoped to
EXACTLY `EURe.transfer(settlementSafe, amount)` within a refilling allowance, and
a Delay module (3-min cooldown, 1-week expiry) on which the USER'S EOA IS ITSELF
A MODULE. Two things their docs do not say: (a) `Bouncer.sol` owns the roles
module and pins its selector to `setAllowance`, so the user can zero their limit
but CAN NEVER REVOKE Gnosis Pay's spender — the permission is permanent; (b) the
user CAN queue arbitrary Safe transactions through the Delay module, which is how
`EURe.approve(AQUA, X)` + `AQUA.ship(...)` get executed.

VERIFIED ON GNOSIS (100): Aqua `0x1111113ccf...` 11,240 bytes with all four
selectors; EURe `0xcB444e90D8198415266c6a2724b7900fb12FC56E` name() ==
"Monerium EUR emoney". Both halves already on Gnosis Pay's own chain.

CORRECTION TO AN EARLIER CLAIM IN THIS FILE'S FIRST DRAFT: Gnosis Pay DOES
reserve at authorisation. Their lifecycle doc says on approval "money is
immediately deducted from user account and moved to hold account on chain" and
that at clearing a short balance "isn't an issue"; Monavate's terms say funds are
"immediately deducted". So the exposure window is one instant, not the clearing
window, and the Delay Module's job is narrower than assumed.

**Terms read** (Gnosis Pay ToS 18 Nov 2025, English law, EEA entity Gnosis P.
Tech Unipessoal Lda; Monavate Cardholder Terms EEA, issuer UAB Monavate).
Nothing prohibits granting an ERC-20 allowance from the Safe, and ToS §11.3
disclaims liability for the Safe expressly "because … it is accessible by other
third party software applications". Four clauses bite: §6.2 "Prohibited
Configurations" is drafted by exclusion (anything but deploying the two modules
and setting the daily limit), though an approve arguably is not a Safe
*configuration* and Monavate's narrower ground is "in such a way that it no
longer works with the Card"; §2.6 lets them restrict an account at discretion;
Monavate requires "sufficient Supported Funds in your Safe AT ALL TIMES"; and
§5.5 forbids business use, which rules out any org/treasury version. The costly
one is the shortfall clause: a completed transaction against a short Safe is a
debt the user must reimburse, Monavate may charge the Safe for it, may suspend
the card until repaid, and may levy a per-transaction admin fee. The terms also
hold the best argument for the idea: "no interest is payable to you on the
balance of Supported Funds stored on the Safe", so the idle balance is
contractual.

**Reserve rule,** sized from the terms: hotels/car rentals add "typically
10%-20%" over-authorisation and the difference can take 7 days to free up. Set
the reserve equal to the on-chain daily limit (readable via their API), because
the Roles allowance caps the card's draw per period at exactly that; this beats
a user-set slider. Invariant: sum of shipped EURe across all strategies <= EURe
balance - daily limit. How to describe it: the money never leaves the Safe.
Aqua holds an allowance, the card always sees the full balance, and docking is
instant with no withdrawal to wait for.

**The real objection is the asset, not custody.** An AMM strategy converts
inventory by design, so a pull of EURe that pushes back USDC.e leaves an EEA
cardholder holding an asset the card cannot spend (Supported Funds = EURe in the
EEA, GBPe in the UK, USDC.e elsewhere). Value is unchanged and the card is
underfunded. A card float needs a single-asset EURe-in/EURe-out app with no
inventory risk. None exists on Aqua; it would have to be written. Until then, do
not point card money at a EURe/USDC.e pool.

**Must reach the UI.** An Aqua `pull()` is `transferFrom` executed by Aqua
against a standing allowance, not a Safe transaction, so the Delay Module never
sees it and the 3-minute double-spend protection does not cover it (their own
defined term scopes the delay to "any non-Card transactions that you carry out
from your Safe").
The only protection is the virtual-balance ceiling, so the rule is: sum of
shipped virtual balances across all strategies <= balance - card reserve.
Aqua's SLAC thesis says over-provision across strategies; a card-backing wallet
must refuse that, or a shared-liquidity UI declines someone's weekly shop. Terms
question not settled: nobody has read whether Gnosis Pay permits a third-party
allowance from the card Safe.

Credit on Aqua: `docs/aqua-credit-module.md`. **Aqua cannot be a lien.**
`dock()` is unconditional and the borrower can move the collateral (pull ends in
safeTransferFrom against the real balance), so a credit line secured only by an
Aqua strategy is unsecured credit. Do not design one and do not let a UI imply
otherwise. Spending the collateral instead is a disposal per purchase: in
Germany a taxable event each time, and it breaks the §23 EStG one-year
exemption, which is why people want credit rather than debit.

**Where it does work: the lender is the maker.** Undrawn credit is the most idle
capital in finance; a lender committing €10m parks €10m and almost none is drawn
on any day. So the lender ships: keeps the money in their own wallet, one
strategy hash per borrower gives a per-borrower limit off one shared balance,
`pull()` at authorisation, repayments arrive as `push()`, `dock()` cuts off one
borrower instantly. The lien problem does not arise because the maker is the
lender. This is the only design here where SLAC helps.

**Composing with a money market** (verified on Gnosis; one chain has the whole
stack): Aave v3 Pool `0xb50201558B00496A145fE76f7424749556E326D8`
getReservesList() returns 9 reserves and EURe is one (with WETH, wstETH, GNO,
sDAI, USDC, USDC.e, wxDAI). Off their market page, not measured: EURe ~3.50%
supply / 4.71% variable borrow. The argument for Aqua here is narrow. You cannot
borrow inside an auth window, so Design B is a borrowed EURe buffer the card
draws down, i.e. paying interest on idle float. Re-supplying it to Aave cuts the
cost to ~1.2 points but takes it out of the wallet, where the card cannot reach
it. Aqua is the only way to make the buffer earn without leaving the wallet;
claim no more than that. Precedent: ether.fi Cash already ships Borrow Mode
(weETH, 55% LTV, ~4% APY, Visa) beside a Direct Pay mode.

A REAL non-custodial lien needs an escrow (not Aqua) or a Gnosis-Pay-shaped
restricted Safe (renounce ownership, Roles module forbidding collateral below
ratio, Delay module so the lender sees a withdrawal before it lands) — and that
buys the module surface that was exploited in June 2026.

THREE ROUTES: (1) 1inch directs its own programme — the pitch, because 1inch is
Baanx's CLIENT and a client can specify a funding source where a peer cannot;
(2) JIT funding (Marqeta Gateway JIT Funding, documented for Europe) inverts the
flow so nobody needs to accept Aqua at all — but they DO NOT PUBLISH THE GATEWAY
RESPONSE TIMEOUT, and if it is ~1s no chain settles a pull inside it (Base 2s
blocks, Gnosis 5s), so get that number first; (3) take a programme as-is, put
Aqua on the non-card uses only.

## 1inch Aqua incubator — application analysis (Sep 2026)

`docs/1inch-aqua-incubator-application.md`. Nothing submitted, nothing built.
READ IT BEFORE TOUCHING THE THREE AQUA DOCS ABOVE — it corrects them.

THE INCUBATOR IS NOT A PRODUCT INCUBATOR. It is the "1inch DAO Aqua Revenue
Stream Incubator" (1IP-93): up to $50k per team, milestone-paid (5/10/35/50,
the 50% being "integrated into the 1inch dApp"), a PERPETUAL revenue share to
the DAO from the first dollar (the one approved team offered 40/30/25), scope
"AMMs and DeFi services that utilize Aqua as an accounting and settlement
layer", and "Non-trading/non-liquidity projects" are EXPLICITLY OUT. Nine
months in, $0 disbursed ("the blocker is execution of the grant agreement").
Nothing 1inch has published links Aqua to cards or payments. So: APPLY WITH
THE SETTLEMENT-FX STRATEGY the card and Zold's flows generate (oracle-anchored
EURe/USDC/EURC, "Oracle-Based" on their own type list, fed by the cash
corridor, pay-link/Shopify settlement and any card clearing), and PITCH THE
CARD SEPARATELY to 1inch Labs/Degensoft and to Exodus. Licence: Aqua-Source-1.1
§5.2 "Pure Caller Use" is free below USD 100k fees/yr and USD 10m liquidity
under control; the incubator exemption only matters above that.

CORRECTIONS TO THE SECTIONS ABOVE, each checked:
 - EXODUS OWNS BAANX AND MONAVATE. The $175m SPA never closed; W3C defaulted
   on Exodus's $70m loan, UK receivers were appointed, and Exodus bought
   Monavate Holdings + Baanx.com Ltd from the receivers on 1 May 2026 for
   $76.27m plus Baanx US for $30m, saying "self-custodial payments at scale".
   One public company now holds the non-custodial pull code AND the EEA
   issuer (UAB Monavate, Lithuania). US/UK MetaMask Card sign-ups paused Jun
   2026; UAB Monavate under Bank of Lithuania scrutiny.
 - KULIPA IS DEAD (29 Jul 2026, solvency) and took Ready/Solflare/~20 wallet
   card programmes with it. Drop it from every precedent list.
 - IMMERSVE WITHDRAWALS ARE NOT PERMISSIONLESS (EIP-712 intent signed by their
   WITHDRAWAL_SIGNER_ROLE; "approved by the Immersve platform"), every partner
   storage is a BeaconProxy behind THEIR beacon (no slot for our contract), and
   the Bank of Lithuania cut their Monavate EEA channel on 29 Dec 2025 — no
   EEA issuer behind any change they make.
 - MARQETA'S JIT TIMEOUT IS PUBLISHED: 3 s. Lithic ASA 6 s (3 s recommended),
   Airwallex 2.5 s, Adyen 2 s, Immersve custodial 1 s, Bridge webhook 0.5 s.
   Only Lithic's window fits a CONFIRMED pull on Base/Linea with a retry;
   Gnosis (5 s blocks) fits none.
 - AQUA IS ON ETHEREUM SEPOLIA (VERIFIED, byte-identical to the 12 mainnets
   probed; SwapVM router absent there; not in their README — confirm it is
   theirs). Monerium sandbox EURe is on Sepolia (0x67b34b93…, name "Monerium
   EURe") and Candide's public bundler serves 11155111, so the full
   Safe→approve→ship→pull loop CAN run on a public testnet. "Not on Base
   Sepolia" still holds. The "11,240 bytes" above was hex length; the code is
   5,619 bytes.
 - GNOSIS HAS TWO EURe CONTRACTS: Monerium's list now publishes 0x420CA0f9…
   ("Monerium EURe"); 0xcB444e90… ("Monerium EUR emoney") is legacy. Which one
   Gnosis Pay's Supported Funds means is unread — check before reserve math.
 - LINEA has Aqua, production EURe (0x3ff47c5B…) AND the MetaMask Card's
   EURe/GBPe approval pull, so it is the exact chain for the Exodus pitch;
   Candide's PUBLIC bundler does not serve it.

BRIDGE'S CARD FACTORY HAS A CUSTOM-IMPLEMENTATION SEAM (VERIFIED by selector
resolution on Base 0x65bf8b55…): createIssuer / createIssuerWithCustom-
Implementation / transferToDestination / authorised debitors / per-user
velocity. The pull lives in a per-issuer implementation, so an Aqua-backed
issuer is architecturally anticipated — still Bridge's call. Bridge Building
S.A. is a Luxembourg EMI + MiCA CASP; EEA cards announced for 2026, not live;
USDC/EURC only in the EEA (so EURe→EURC via the strategy). Zold already
integrates Bridge. Best provider fit; Gnosis Pay white-label is the smallest
technical delta (already reserves at auth, already spends EURe) and the
largest contract (2–3 year terms, their Safe).

**Workaround that needs nobody's permission: invert it.** Take a processor
with a synchronous auth callback and fiat prefund (Lithic+Monavate,
Marqeta+TransactPay, Adyen, Airwallex); our CardApp does AQUA.pull at
authorisation; the issuer's fiat prefund is topped up by Monerium redemptions
(the SEPA leg we already run). Aqua appears in no contract but ours. The cost is
programme-manager obligations and a settlement-lag float, not user balances.

TRAD-FINTECH STABLECOIN CARDS (full table in the doc): Stripe/Bridge (the only
issuer-processor with a documented wallet pull at auth), Marqeta (zerohash +
BVNK), Lithic (Monavate), Nium (own EMIs, custodial balance, Mar 2026), Adyen
/ Airwallex / Checkout.com (fiat only), Wallester (Visa principal, VASP tier
€5,995/mo, runs WhiteBIT Nova), Enfuce / Paynetics (fiat BIN sponsors), Striga
→ Lightspark Europe (MiCA+EMI claim, custodial), Mercuryo Spend (preload).
Crypto-native EEA pull-at-auth with a named EMI: Gnosis Pay (Monavate), Bleap
(Unlimit EU), MetaMask/CL (Monavate), OKX (unnamed). Rain and Reap: no EEA
entity; Rain's Partner-Managed mode is the §5 shape without Europe.
