# Applying to the 1inch Aqua incubator with Zold — analysis and plan

Written 11 Sep 2026. Status: **analysis and application plan, nothing submitted,
nothing built.** Companion to `docs/1inch-aqua-card.md` (the card structure),
`docs/aqua-on-gnosis-pay.md` and `docs/aqua-credit-module.md`. Where this file
contradicts those three, this file is newer and the reason is given.

Tags used below: **[P]** a primary source (the provider's own page, a filing,
contract source, or a chain read); **[S]** press; **[I]** inference. Everything
marked VERIFIED was checked by `eth_getCode`/`eth_call` against public RPCs or by
reading the deployed selectors on 11 Sep 2026, not read off a page.

Short version, so the rest can be skipped by someone in a hurry:

1. **The incubator is a DAO grant for trading strategies with a perpetual
   revenue share.** It is not a product incubator. Up to $50k, paid per
   milestone; the scope excludes "non-trading/non-liquidity projects"; $0 has
   been disbursed nine months in. A card-funding app pitched as a card would be
   screened out on the first read.
2. **So the application is the settlement-FX strategy the card and Zold's
   payment flows generate, not the card.** An oracle-anchored EURe/USDC (and
   EURC) strategy on Aqua fed by real payment flow is squarely in scope, is
   novel on their list, and the card is the demand story behind it.
3. **The card structure itself goes through a different door**: 1inch Labs /
   Degensoft (who own the card product) and Exodus (who since May 2026 own BOTH
   the programme manager Baanx AND the EEA issuer Monavate, and bought them
   saying "self-custodial payments at scale").
4. **The provider problem has a workaround that needs nobody's permission**,
   and it has been sized: several issuer-processors give the programme
   a real-time authorisation callback with a published timeout (Lithic 6 s,
   Marqeta 3 s, Airwallex 2.5 s, Adyen 2 s), and settle in fiat from a prefunded
   programme account. Our own app does the Aqua pull; the issuer never learns
   what Aqua is; the fiat prefund is topped up by Monerium redemptions, which
   is the SEPA leg Zold already runs.
5. **A testnet demo is possible after all.** Aqua's registry is deployed on
   Ethereum Sepolia (VERIFIED, byte-identical to mainnet), Monerium's sandbox
   issues EURe there, and Candide's public bundler serves that chain. The
   earlier "cannot be exercised on a testnet" finding was about Base Sepolia
   only.


## 1. What the incubator actually is

Everything in this section is [P] from the 1inch governance forum and the
application form unless marked otherwise.

| item | fact |
|---|---|
| name | "1inch DAO Aqua Revenue Stream Incubator", governance id 1IP-93; the form is titled "1inch Aqua Incubator — Grant Application" |
| who runs it | the 1inch DAO treasury. Steward: Kene_Anode (StableLab). Reviewers: StableLab, DAOPlomats, Arana Digital, 2-of-3 vote. The 1inch Foundation is being authorised as the legal administrator (KYC/KYB, grant agreements) because 1IP-93 forgot to name one |
| money | $400,000 pool, **up to $50,000 per team**, 8–10 teams. Milestones 5% idea / 10% testnet prototype / 35% working implementation / 50% **integrated into the 1inch dApp and on mainnet**. "If you do not hit the milestone, you do not receive the funding. No exceptions." |
| the price | **revenue share to the DAO from the first dollar**, percentage proposed by the team; buyout after three years at fair market terms. The one approved team (Aqua0) offered 40% / 30% / 25% |
| scope | "AMMs and DeFi services that utilize Aqua as an accounting and settlement layer"; themes: dynamic-fee AMMs, inventory- or oracle-based pricing, cross-chain, RWA / LST / yield-bearing assets, new swapVM instructions, "novel approaches" |
| explicitly out | core-team AMMs, deployed swapVM instructions, and **"Non-trading/non-liquidity projects"** |
| judging | "Novelty is the #1 screen"; applicants must check against existing strategies |
| deadline | rolling since 7 Jul 2026 |
| status | Q2 report (26 Aug 2026): 24 applications, 13 active, 1 approved (Aqua0), 2 pitched (HarvestAqua, Tidewater), **$0 disbursed — "the blocker is execution of the grant agreement"**. The programme has no landing page yet |
| form | Notion form linked from 1inch's LinkedIn post. Fields: strategy name; category (Aqua strategy / swapVM instruction / both); type (Dynamic Fee AMM, Inventory-Based, **Oracle-Based**, Cross-Chain, RWA Focused, LST Focused, Novel Approach, swapVM Instruction); target markets; target chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, SEI, HyperEVM, Other); funding requested (max $50k); per-milestone deliverables/KPIs/timeline; 6-month post-launch targets (monthly volume, gross revenue, revenue to DAO, chains, pairs); **proposed revenue-share %**; timeline; team; GitHub; contact |
| token grants | none. The separate LP-incentive programme (1IP-105, 10M 1INCH + 500k USDC over three months) **excludes incubator strategies** |
| licence | Degensoft's clarification (8 Sep 2026): incubator participants need no separate commercial licence while active and paying the revenue share, **only for strategies on the official deployments** (`0x1111113ccf…a90a`); a self-deployed registry is not covered |

Two things follow that the earlier docs did not know.

**The card is out of scope as a headline.** Nothing 1inch, Degensoft or the DAO
has published (the whitepaper, the developer-release post, the launch post, the
three governance threads) links Aqua to payments, cards, spending or the 1inch
Card. A "CardApp" application lands in the "non-trading / non-liquidity" bin,
and the 50% milestone ("fully integrated into the 1inch dApp interface") has no
meaning for a card. The reviewers are assessing AMM strategies for fee revenue
to a treasury.

**The licence question is mostly answered by the licence, not the incubator.**
Aqua-Source-1.1 §5.2 makes "Pure Caller Use" free of any payment obligation, and
the commercial triggers are charged fees above USD 100,000 in a rolling year or
liquidity under control above USD 10,000,000. An app that only calls the
official registry, below those numbers, needs no conversation at all. The
incubator's exemption buys something only once a strategy crosses them — which
is the outcome we would want anyway.


## 2. The pitch that fits the door: a EUR settlement strategy

Zold moves euros between EURe and dollar stablecoins today, in three places, all
with real flow and none of them a trading product:

- the cash corridor swaps EURe→USDC before Bridge takes it (best-execution
  router over LI.FI / Uniswap v3 / RFQ, live-mid guard in `rates.ts`),
- payment links and Shopify settle incoming USDC→EURe by a user-signed
  conversion,
- a card, if built, settles EURe→USDC or USDC→EURe at every clearing, and the
  1inch Card today charges 1.75% for exactly that conversion, through a
  custodial partner, off 1inch's own rails.

An Aqua strategy that prices EURe/USDC (and EURe/EURC, USDC/EURC) **off an
independent EUR/USD mid with a tight band**, fills from makers' wallets, and
takes flow from those three sources is:

- **in scope**: it is an Aqua strategy, it is "Oracle-Based" on their own type
  list, and e-money EURe is an "underserved asset class" (RWA-shaped) — the
  only EUR stablecoin with a redemption right at par against a licensed issuer;
- **novel on their list**: the core team's strategies are xy=k, concentrated
  and stableswap; nothing published is oracle-anchored or EUR-denominated. This
  must be re-checked against the live 1inch.com/aqua interface the week of
  applying, since novelty is their first screen;
- **integrable into the 1inch dApp**, which is the 50% milestone: LPs on
  1inch.com/aqua ship EURe and USDC to it like any other strategy;
- **a revenue stream** the DAO can share in: a strategy fee of a few bps on
  every fill, from day one, on flow that exists before any LP shows up.

What the strategy borrows from work that already exists in this repo, so the
build is short:

- the mid-deviation guard (`DEX_MAX_MID_DEVIATION_BPS`, `assertPriceSane`) is
  the oracle band; the on-chain version is a Chainlink EUR/USD read (live on
  Base, Ethereum, Gnosis, Linea, Arbitrum) with a staleness check, plus the
  same refusal semantics — a stale or out-of-band oracle makes the strategy
  refuse, not quote;
- `LiquidityProvider` already has a seam for a new venue; an `aqua` venue that
  quotes from the strategy and executes through `safeSwapPlan` is the half-day
  item `docs/1inch-aqua-card.md` §9 mentions, and it is how Zold's own flow
  reaches the strategy on day one;
- EURe is live where Aqua is live: Base, Gnosis, Linea, Ethereum, Arbitrum,
  Polygon (Monerium production `/tokens`, read 11 Sep 2026).

**Weakness, to state in the application: an oracle-anchored strategy is an
inventory business for the maker.** A maker shipping EURe and USDC into a band
around the mid earns the fee and takes adverse selection when the mid moves
faster than the oracle updates. So the band, the oracle heartbeat and a
per-strategy max fill size are parameters of the strategy bytes, not of the
app, and the first makers are Zold's own treasury and 1inch's, not the public.
Aqua's whitepaper §6.2 names this ("illiquid strategy keeps quoting a stale
price"), and the mitigation is the same as theirs: refuse when out of band, dock
when in doubt.

Working title only, to be replaced: "EUR settlement strategy". Do not ship a
name made up here.


## 3. The card, re-read after this research

`docs/1inch-aqua-card.md` still holds: Aqua is a scoped, revocable, ownerless
spending-rights registry; the mapping to cards is exact; `dock()` is instant
and unconditional so pull-at-authorisation is the only safe tier; `push()`
reverts on a docked strategy so a card must not be docked until its refund
window closes. Four things in it are now wrong or stale, and one is new.

**The precedent list lost a member.** Kulipa collapsed on 29 Jul 2026 (solvency)
and took Ready's, Solflare's and roughly twenty other wallet card programmes
down with it overnight [S]. The doc cited Kulipa as the live example of
pull-into-escrow at authorisation. The shape is still right; the company is
gone, and the lesson is the counterparty: prefer a programme where the e-money
institution itself is the contracting issuer, not a startup between the wallet
and the BIN.

**Baanx is not a client relationship any more; it is Exodus.** The $175m deal
never closed as signed. W3C defaulted on Exodus's $70m loan in April 2026,
Exodus put Monavate and Baanx.com into UK receivership, then bought them from
the receivers on 1 May 2026 for $76.27m plus $30m for Baanx US [P, Exodus
releases and 8-K]. Exodus's CEO on closing: "This deal unlocks self-custodial
payments at scale." So the counterparty who owns the non-custodial pull code
(Baanx), the EEA issuer (UAB Monavate, Lithuania) AND wants self-custody at
scale is one public company. That is a better door for the card idea than
"1inch asks its vendor", and it does not need the DAO.

**"Immersve withdrawals are permissionless" was wrong.** Read from their source:
DEPOSIT-mode `withdraw()` verifies an EIP-712 `WithdrawalIntent` signed by an
Immersve `WITHDRAWAL_SIGNER_ROLE` key; their docs say "Withdrawals are approved
by the Immersve platform" [P]. The APPROVAL-mode `directSpendDebit` line the doc
quotes is real and unchanged, but every partner storage is a BeaconProxy behind
Immersve's beacon, so there is no slot for a partner-supplied contract — the
change is theirs alone, and it upgrades every partner at once.

**Immersve has no EEA issuer today.** The Bank of Lithuania instructed UAB
Monavate on 29 Dec 2025 to stop providing services to Immersve UK Ltd, including
distributing Monavate-issued cards [P, lb.lt]. Their "Mastercard principal
member" line has no regional breakdown; their pricing and marketing pages list
AU, NZ, UAE, UK, US. For a German cardholder there may be no issuer behind any
change they make.

**New: Linea is the exact technical fit for the Baanx path.** MetaMask Card
spends **EURe and GBPe on Linea** from the user's EOA by ERC-20 approval to a
Baanx spender [P, MetaMask support]. Aqua is deployed on Linea (VERIFIED) and
Monerium issues production EURe there (`0x3ff47c5B…`, `name()` = "Monerium
EURe", VERIFIED). So the one live non-custodial EUR card in the EEA already
runs on a chain where the registry and the e-money coexist. The change is
"make the spender an Aqua app and read `rawBalances` instead of
`allowance()+balanceOf()`", and Candide's public bundler does not serve Linea
(checked: 59144 answers "public endpoint doesn't support this network"), so a
Zold Safe there needs a paid Candide plan or another bundler.


## 4. The provider problem, provider by provider

The first question: how does an existing card provider pull from
Aqua instead of from its own contract or balance? Sized per provider, smallest
change, who has to say yes.

| provider | how it pulls today | smallest change for an Aqua pull | who decides | EEA issuer today |
|---|---|---|---|---|
| **Immersve** | `directSpendDebit`: `safeTransferFrom(token, spender, storage, amount)` by their SETTLER key, APPROVAL mode (in bytecode, not in the public catalogue) | add `FundingMode.AQUA`; storage proxy becomes the Aqua app; that line becomes `AQUA.pull(spender, hash, token, amount, address(this))`; `directSpendReverse` becomes `push()`; authoriser reads `rawBalances` | their engineering + a Hashlock re-audit; beacon upgrade hits all partners | **none** since the Dec 2025 Lithuanian instruction |
| **Rain** (Rain-Managed) | per-user `RainCollateral` contract; `makePayment`/`withdrawAsset` gated by Rain controller signatures; users cannot withdraw without Rain [P, Etherscan] | replace the collateral contract with an Aqua app their controller calls — a new audited contract, after they hot-patched a signature-reuse exploit on Solana on 28 Aug 2026 ($1.1m across Avici, Tria, Solayer Pay) | Rain engineering + risk; appetite will be low | none published; regions "North America, LAC, APAC, CEMEA"; ether.fi's EEA cards are issued by Third National (Puerto Rico) |
| **Rain** (Partner-Managed) | "You maintain the reserve balance, decide whether to approve or decline each transaction via webhook"; Rain liquidates to Visa | **zero change on Rain's side** — the Aqua pull lives in our app, fired by our webhook handler; Rain sees a USDC reserve | Rain sales; ask for the unpublished webhook timeout | same as above — no EEA |
| **Baanx / Exodus** (MetaMask Card) | ERC-20 approval from the EOA to a Baanx spender; `transferFrom` at purchase; "under five seconds" is a CompoSecure press figure, not an SLA | spender becomes an Aqua app (one function if it is a contract, a new contract if it is an EOA); auth read swaps to `rawBalances` | Exodus engineering AND UAB Monavate as issuer (their terms define "sufficient supported funds") | UAB Monavate, Lithuania — under supervisory pressure; US/UK sign-ups paused since June 2026 |
| **Gnosis Pay** (white-label) | Roles module lets their spender call `EURe.transfer(settlementSafe, amount)` within a refilling allowance; reserves at authorisation | spender calls `AQUA.pull(maker, hash, EURe, amount, settlementSafe)` — the one programme that already reserves at auth and already spends EURe, so only the pull site changes | Gnosis Pay product; white-label terms are 2–3 year minimums, custom pricing, Sumsub KYC, their API creates the Safe | Monavate Ltd (FCA) / UAB Monavate for EU |
| **Bridge (Stripe)** | noncustodial strategy: user `approve()`s Bridge's issuer contract; Bridge "pulls the exact spend amount onchain" at each authorisation, completing asynchronously | see below — their factory has a custom-implementation seam | Bridge product/engineering | **Bridge Building S.A., Luxembourg — CSSF EMI + MiCA CASP** [P]; EEA cards "launching 2026", not confirmed live |

Two of these deserve more than a row.

### Bridge's factory has a custom-implementation entry point (VERIFIED)

Bridge publishes its noncustodial card contract on Base as
`0x65bf8b55EEDef53C094E40003a03390De744DF33` [P, apidocs]. Reading its
dispatcher on chain (8,727 bytes, not a proxy) and resolving the selectors:

```
createIssuer(bytes32,address,address,address)
createIssuerWithCustomImplementation(bytes32,address,address,address,address)
getIssuerAddress(bytes32,address)
transferToDestination(bytes32,address,address,uint160,address,bytes32)
isAuthorizedDebitor / updateAuthorizedDebitor(bytes32,address,bool)
isDestinationAllowed / updateIssuerDestination(bytes32,address,bool)
getUserVelocity / updateUserVelocity(bytes32,address,address,uint40,uint40,uint40)
setAuthorizedManager / isAuthorizedManager(bytes32,address)
pause / grantRole / ownership handover
```

So the published address is a **factory and policy registry**, not the puller:
each programme is an issuer id with its own deployed contract (that is what the
user's approval targets), an allowlisted debitor set, allowlisted destinations
and per-user velocity limits, and `createIssuerWithCustomImplementation` exists
to deploy a programme on a **different implementation**. The factory's own
bytecode contains no `transferFrom`, EIP-3009 or Permit2 selector; the pull is
in the per-issuer implementation. That is exactly the seam an Aqua-backed
issuer would use: an implementation whose debit is `AQUA.pull` and whose
reversal is `push()`, registered by Bridge under a new issuer id, with the
factory's velocity and destination policy untouched. It is still Bridge's call
(the factory is role-gated), but the architecture already anticipates it, which
no other provider's does. Not verified: which implementation is live (no
factory events in the last ~600k Base blocks; instances were created earlier),
and whether Bridge would ever register a third party's implementation.

Two constraints on Bridge that do not go away: MiCA — "USDC & EURC are the only
stablecoins supported for users in the EEA" [P], so a Bridge card pulls EURC,
not EURe, and Zold would need an EURe→EURC leg (the settlement strategy in §2,
which is a point in its favour); and their EEA card launch is announced for
2026 and not confirmed live. Zold already integrates Bridge for the cash rail,
so the counterparty exists.

### Gnosis Pay is the smallest technical delta, and the largest contractual one

Everything in `docs/aqua-on-gnosis-pay.md` stands, with one correction: Gnosis
now has two EURe contracts. Monerium's production token list publishes
`0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430` (`name()` = "Monerium EURe",
VERIFIED); the `0xcB444e90…` the earlier doc verified answers "Monerium EUR
emoney" and is the legacy contract. Which one a Gnosis Pay Safe's "Supported
Funds" means has to be read from their current account-kit or terms before any
reserve arithmetic — `account-kit/src/constants.ts` carries no token address,
so it is passed in at setup, and it could be either.


## 5. The workaround that needs nobody's permission

If the providers will not connect, there is a simple workaround. It is not a
hack, and the numbers that decide it are below.

**Invert the integration.** Several issuer-processors give the programme
manager a synchronous authorisation decision and settle in fiat from a
programme-level prefunded account. In that shape the stablecoin side is entirely
ours: our `CardApp` (the Aqua app) fires `AQUA.pull` at authorisation, and the
issuer only ever sees a fiat balance it draws down at clearing. Aqua appears in
no contract but Zold's. The published decision windows, all [P] from the
provider docs:

| processor | callback | window | EEA route | stablecoin stance |
|---|---|---|---|---|
| Lithic | Auth Stream Access | **6 s** (decline on timeout; 3 s recommended) | Monavate partnership announced 13 Aug 2026, no live EEA programme named | "the stablecoin provider manages wallets, on-chain activity and conversion"; you prefund fiat |
| Marqeta | Gateway JIT Funding | **3 s** — "the Marqeta platform declines the transaction" | TransactPay (EMI, Gibraltar/Malta, Visa+Mastercard principal), acquired Aug 2025; Banking Circle for 30 countries | zerohash (Jul 2026) and BVNK (Sep 2026) partnerships; funds drawn from a programme bank account |
| Airwallex | remote authorisation | **2.5 s** | Netherlands EMI, Visa, EEA 31 countries; consumer programmes need approval | fiat wallet only |
| Adyen | relayed authorisation | **2 s** | Adyen N.V., EEA+UK+US; access by application | fiat balance platform only |
| Immersve | custodial `auth-request` | **1 s** | none today | n/a |
| Bridge | real-time auth webhook | **0.5 s** default, fallback DECLINE | Luxembourg EMI | but the noncustodial pull is their own contract, async — the webhook is not where the pull happens |
| Checkout.com | authorisation relay | not published (account-manager setting) | UK+EEA since 2023 | fiat |
| Rain | Partner-Managed webhook | not published | none | USDC reserve you hold |

Against block times: Base 2 s, Linea ~2 s, Gnosis 5 s, Ethereum 12 s. So:

- **Lithic's 6 s** is the only window in which a pull can be submitted at
  authorisation, included on Base or Linea, and *confirmed* before answering,
  with one retry's margin. That is true pull-at-authorisation.
- **Marqeta's 3 s** fits Base only if the first submission lands; no margin.
  Answer on a state read (`rawBalances` and the maker's real balance and
  approval — three cheap `eth_call`s), submit the pull immediately, and carry
  seconds of exposure to a `dock()` race per transaction. The exposure is
  bounded by one transaction's amount and the maker's ability to dock inside
  three seconds, which in practice needs a bot.
- **2–2.5 s** (Adyen, Airwallex) is a state read only; the pull confirms after
  the answer. Same race, slightly longer.
- Gnosis at 5 s blocks fits none of them for a confirmed pull. Base or Linea
  it is.

Everything else in the design is already Zold's: the fiat prefund at the issuer
is topped up by **Monerium redemptions** — the pulled EURe is redeemed to the
programme's IBAN at par, which is the SEPA leg `executeSepaTransfer` runs
today, and a USDC pull converts through the §2 strategy first. Monerium EURe is
e-money with a redemption right, so the "prefund" is a day or two of clearing
volume, not customer balances. That float is the programme's, not the
cardholders'; it is the same kind of float every issuer already demands, sized
to settlement lag rather than to every user's balance.

Costs, stated: we become the programme manager (KYC ownership or an Immersve-
style delegated KYC, scheme rules, chargebacks, a BIN sponsor contract,
prefunding); Lithic's and Marqeta's EEA routes are new (weeks-old partnership
announcements, no named live consumer programme); the Monavate half of Lithic's
route carries the same supervisory question as Baanx's. None of these are Aqua
problems. They are the cost of running a card, and a provider that accepts Aqua
directly (§4) would remove none of them except the prefund.

**Which is the recommendation:** pitch the direct integration to Exodus and to
Bridge, because those are the two counterparties where the change is small and
the strategic fit is stated in their own words — and build the demo on the
inverted shape, because it is the only one that can be shown without anyone's
permission and it is the fallback for production.


## 6. Traditional fintech offering stablecoin cards — the landscape

The user's third question. Every row is from the provider's own pages unless
tagged; "no" means not found on any page fetched, which for licences and
regions is close to meaning no.

| provider | what they are | issuer of record (EEA) | funding model | wallet pull at auth | chains / tokens | partner needs own licence? | EEA live | fit for Zold |
|---|---|---|---|---|---|---|---|---|
| **Stripe / Bridge Cards** | issuer-processor + stablecoin infra | Bridge Building S.A. (LU, EMI + MiCA CASP); US: Lead Bank | noncustodial pull by ERC-20 approval, or Bridge-custodied wallet, or Stripe financial account | **yes** | Base, Linea, World Chain, Solana, Tempo; USDC (EURC for EEA) | no (Bridge developer account + Stripe account) | announced 2026, not confirmed | **highest**: same counterparty as the cash rail, EEA entity, MiCA-clean, custom-implementation seam |
| **Marqeta** | processor / programme manager | TransactPay (EMI GI/MT, Visa+MC principal) | Gateway JIT, fiat programme bank account | no (fiat); stablecoin via zerohash/BVNK | not published | "Managed by Marqeta" available | yes (Expensify EU on Marqeta, Jul 2026) | good for §5 shape; 3 s |
| **Lithic** | processor | UK/EEA via Monavate (Aug 2026) | ASA callback, fiat prefund; "stablecoin provider manages wallets" | no (we do) | not published; Lightspark programme settles USDC | programme-management offered | no live EEA programme named | good for §5 shape; 6 s |
| **Nium** | EMI + principal member | UAB Nium EU (Bank of Lithuania), Nium Malta | cards linked to customer wallets held **at Nium**; stablecoin card platform launched 30 Mar 2026, converts at spend | no (custodial at Nium) | "digital dollars such as USDC"; no chain list; no EUR coin | no (40+ licences) | EEA entities yes; stablecoin card region list not published | custodial; only if we accept an omnibus |
| **Adyen Issuing** | bank-licensed platform | Adyen N.V. | balance accounts, wire-funded; relayed auth 2 s | no | none | no | yes | §5 shape only; fiat purist |
| **Airwallex** | EMI | Airwallex (NL) B.V. | Airwallex wallet; remote auth 2.5 s | no | none (stablecoin only as a "last mile" conversion service) | consumer programmes need approval | yes | §5 shape only |
| **Checkout.com Issuing** | acquirer-issuer | not named on fetched pages | prefunded issuing account; auth relay, timeout unpublished | no | none | "available for all merchants in UK and EEA" | yes | weak |
| **Wallester** | Visa principal, EE payment institution | Wallester AS | settlement/funding account; webhooks post-event | no | none (partner does crypto) | no; VASP tier €5,995/month [P blog] | yes (EEA, UK, CH) | BIN sponsor for a custodial-style programme; WhiteBIT Nova runs on it |
| **Enfuce** | EMI (FI), Visa+MC principal | Enfuce License Services | prefund account | no | none | no | yes | fiat BIN sponsor only |
| **Paynetics** | EMI (BG) + FCA UK | Paynetics AD | not published; processors Thredd/Clowd9/Marqeta | no | on/off-ramp only | agent/distributor model | yes | fiat BIN sponsor only |
| **Striga → Lightspark Europe** | EE, claims MiCA + EMI (Jun 2026) | not named | custodial per-user balance debited at auth, post-event webhooks | no | BTC, ETH, USDC; Base/Polygon/Solana [S] | "no licenses needed" | 30 EEA countries | custodial; USDC-only |
| **Mercuryo Spend** | virtual Mastercard | Quicko Sp. z o.o. (PL) | preload from wallet | no | 70+ assets | WebView link, KYB | EEA only | preload, not a pull |
| **Paysafe / Skrill** | consumer prepaid | Paysafe Payment Solutions (IE); MiCA CASP Apr 2026 | fiat wallet | no | crypto not spendable | n/a | yes | not a programme for third parties |
| **Gnosis Pay white-label** | crypto-native, EEA | Monavate | Safe on Gnosis, Roles-module pull, **reserves at auth** | **yes** (their Safe) | Gnosis (+ETH, Polygon listed); EURe/USDC/EURC | no; 2–3 year terms, custom pricing | yes | **smallest Aqua delta**, largest contract |
| **Bleap** | crypto-native, EEA | Unlimit EU Ltd (CY EMI), Mastercard | direct-debit mandate against a non-custodial MPC wallet, pull at auth | **yes** | Arbitrum; USDC/USDT/USDA/EURA [S] | no partner programme found | yes (EEA + CH) | proves Unlimit will issue on a wallet pull; no API |
| **Holyheld** | crypto-native | Unlimit EU Ltd | exchange USDC→e-money balance | no | ~20 chains [S] | SDK is an off-ramp, not issuing | yes | not a pull |
| **OKX Card EEA** | exchange card | unnamed EU payment provider; OKX Europe Ltd is the MiCA entity | "stablecoins remain in the user's wallet until the moment of purchase" via OKX Pay smart wallet; USDC/USDG | yes (their wallet) | not published | n/a | yes (Jan 2026) | precedent only |
| **Baanx / CL (Exodus)** | programme manager | UAB Monavate (EU), Monavate Ltd (UK) | custodial tier (1inch, Ledger) and approval-pull tier (MetaMask, Linea) | **yes** (MetaMask only) | Linea (EURe, GBPe, USDC, USDT, mUSD, wETH), Solana, Base, Monad | not offered publicly | yes, sign-ups paused US/UK | the direct pitch target |
| **Rain** | Visa principal (US/APAC) | none in EEA | per-user collateral contract, Rain-signed; or Partner-Managed reserve + webhook | no (deposit) | ETH, Polygon, Base, Solana, Stellar, Avalanche [S] | no | no | Partner-Managed is §5 shape without EEA |
| **Immersve** | Mastercard principal (regions unclear) | none since Dec 2025 | deposit or approval pull, Immersve-signed | yes (approval mode, unlisted) | Arbitrum, Base, BNB, Ethereum, Monad, Polygon, Sei; USDC (+USDT on BNB) | no | no | technically closest, no issuer |
| **Reap** | Visa principal HK/MX | none | master collateral account, USDC/USDT; webhook auth | no | Base, Solana deposits | no | no | out of region |
| Kulipa, Ready, Solflare cards, Solid | — | — | — | — | — | — | dead (Kulipa 29 Jul 2026; Solid liquidated Nov 2025) | remove from every list |
| Mesh | funding/orchestration layer for Rain programmes | not an issuer | top-up into the programme balance | no | 35 networks | — | — | not a card |

Scheme level, for completeness [P]: Visa reports 160+ stablecoin-linked card
programmes and a $20bn annualised settlement run rate (Sep 2026), settles USDC
on nine chains, and names Rain and Bridge as its programme partners; Mastercard
runs stablecoin settlement in the US/LatAm with Lead Bank, Cross River, Nuvei
and others, and its EEMEA USDC/EURC merchant settlement with Circle. Neither
publishes an EEA cardholder-side stablecoin card offer for non-banks; both
route through the issuers above.

The MiCA line that keeps recurring: Bridge (USDC/EURC only in the EEA), OKX
(USDC/USDG), Holyheld (USDC), Gnosis Pay (EURe/USDC/EURC) have all trimmed to
compliant coins; MetaMask/CL still lists USDT for EU users, and KAST and Fizen
are USDT-based. Copy the first group.


## 7. The testnet demo, which is now possible

VERIFIED 11 Sep 2026 by `eth_getCode` against public RPCs, `sha256` of the
returned code compared across chains:

| chain | Aqua `0x1111113ccf…a90a` | note |
|---|---|---|
| Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Linea, BNB, Avalanche, Unichain, Sonic, zkSync | 5,619 bytes, identical hash | matches the README's 16-chain list (Robinhood, Cronos, Monad, HyperEVM not probed) |
| **Ethereum Sepolia** | **5,619 bytes, identical hash** | not in the README, not in the SDK's chain list; the SwapVM router is absent there. Same deterministic address and bytecode, so almost certainly 1inch's own test deploy — **confirm with them before relying on it** |
| Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Linea Sepolia, Chiado, Scroll | empty | the earlier "cannot be exercised on a testnet" finding was measured on Base Sepolia only |
| the Nov 2025 preview registry `0x499943e7…` | 6,251 bytes on every mainnet probed | still the address in the incubator announcement post; still the wrong one to ship to |

(The earlier docs say "11,240 bytes"; that was the hex string length. The
bytecode is 5,619 bytes.)

On Sepolia, in addition: Monerium's sandbox issues EURe at
`0x67b34b93ac295c985e856E5B8A20D83026b580Eb` (`name()` = "Monerium EURe",
VERIFIED; chain name `sepolia`, which CLAUDE.md already records as the sandbox
default), and Candide's public bundler answers `eth_supportedEntryPoints` for
chain 11155111 (checked). So the whole loop — passkey Safe deployed through the
bundler, sandbox EURe arriving from a simulated SEPA deposit, `approve(AQUA)`,
`ship()` a card strategy, a `CardApp.authorize` that `pull`s into a hold,
`clear`/`void`, `dock` — can run on a public testnet with e-money that Monerium
itself minted. That is the incubator's 10% milestone ("working prototype on
testnet"), and it is also the demo that turns the Exodus and Bridge
conversations from a document into a screen. Zold needs a Sepolia entry in
`deployments.json` (EURe only, like every real chain) and `TRANSF_CHAIN_ID=
11155111`; nothing in the chain plumbing is pinned.

For the settlement strategy the same chain works for the mechanics; pricing
tests need a Chainlink EUR/USD feed, which exists on Sepolia.


## 8. Draft application, against their form

**Strategy name.** Working title only; pick one before submitting.

**Category / type.** Aqua Strategy · Oracle-Based, with "RWA Focused" as the
secondary framing (e-money). Not "Novel Approach" — that reads as evasive.

**Target markets.** EUR/USD stablecoin pairs: EURe/USDC, EURe/EURC, USDC/EURC.
The largest fiat pair in the world and the least served on chain; EURe is the
only EUR coin with a licensed issuer owing redemption at par.

**Target chains.** Base first (Zold's chain; EURe, Chainlink EUR/USD, Bridge
and Aqua all present), then Gnosis (EURe's deepest liquidity, CoW at mid) and
Linea (MetaMask Card's EURe). "Other: Gnosis, Linea" on the form.

**Why it earns fees.** Flow exists before liquidity does: Zold's cash corridor
(EURe→USDC before Bridge), payment-link and Shopify settlement (USDC→EURe), and
the card leg in §3 at every clearing. Each fill pays the strategy fee. The
1inch Card's 1.75% conversion today goes to a custodial partner; a card that
settles through this strategy returns that conversion to Aqua and to the DAO's
share of it.

**Funding requested.** $50,000, milestone-paid per their schedule: 5% design
and parameter spec; 10% Sepolia prototype (strategy contract, Chainlink band,
Zold venue adapter, the loop in §7); 35% mainnet on Base with Zold's own flow
routed through it and the mid-deviation and staleness refusals live; 50% listed
in the 1inch Aqua interface with public makers.

**Six-month targets.** Fill them from real numbers, not hopes: Zold's current
monthly conversion volume across the three flows, a strategy fee of 5–10 bps,
the DAO's share of that. Small honest figures beat large ones here — the
reviewers rejected three Q2 applications for overlap and none for being small.

**Revenue share.** Aqua0 offered 40/30/25. Propose in that band and say why the
number is what it is: the first year's flow is Zold's own, the DAO's share is
of strategy fees, and the card conversion, if it lands, is the upside they are
buying into.

**Team.** Zold: passkey Safe accounts (Candide, 2-of-2), Monerium EURe with
real IBANs, best-execution router (LI.FI / Uniswap v3 / RFQ, live-mid guard),
user-signed execution, Bridge cash rail, verified statements/receipts. Point
at the repo and at the three Aqua docs, which show the source was read and the
registries were probed.

**What to say about the card.** One paragraph, at the end, framed as the flow
source and as the reason 1inch specifically should care: the 1inch Card is the
one custodial product in the suite and Aqua is the primitive that fixes it;
Zold has sized the provider change per counterparty (§4) and has a demo path
that needs nobody's permission (§5). Ask for an introduction to whoever owns
the card at 1inch Labs. Do not make it the deliverable.

**KYC/KYB and the grant agreement.** Zoldenburg UG signs; be ready for the
Foundation's KYB. Note that no team has been paid yet because the DAO could not
execute an agreement — plan cash as if the grant arrives late or never, and
treat the introduction and the listing as the real prize.


## 9. The direct pitch — two counterparties, two one-pagers

Not part of the DAO application. Written from `docs/1inch-aqua-card.md` §8 and
§11 with the corrections above.

**Exodus (owner of Baanx and Monavate).** Their stated reason for buying is
self-custodial payments at scale; their non-custodial tier exists on one wallet
and one chain foundation (MetaMask on Linea, Tezos/Etherlink). Aqua is the
neutral registry that turns that tier into something any wallet can plug into
without adopting MetaMask's framework — and Linea already has EURe, Aqua and
their spender. The ask: make the spender an Aqua app; the win for them: one
integration for every wallet, and the 1inch Card (still on their custodial
tier) becomes their showcase. Timing risk: four months post-receivership,
US/UK sign-ups paused, UAB Monavate under Bank of Lithuania scrutiny.

**Bridge (Stripe).** Their factory already has
`createIssuerWithCustomImplementation`; their EEA entity is a Luxembourg EMI
and MiCA CASP; Zold is already a Bridge customer. The ask: register an
implementation whose debit is `AQUA.pull` and whose reversal is `push()`, under
the factory's existing velocity and destination policy. The win for them: the
shared-liquidity story for card float, and a first EUR-native programme.
Constraint to design around: EURC not EURe in the EEA, so the §2 strategy is
the bridge between the two.

Gnosis Pay is the third conversation and the cheapest to have, because Zold
already connects to it by SIWE and the white-label API exists; but it binds the
card to their Safe on their chain under a multi-year contract, and Aqua adds
nothing to the card there without their one-line change. Keep it as the
fallback that is live today.


## 10. Corrections to earlier files, so nobody re-derives them

- CLAUDE.md, Aqua section: "Exodus is acquiring Baanx for $175m, expected to
  close early 2026" → closed 1 May 2026 through UK receivership, ~$106m total,
  Exodus owns Baanx.com Ltd, Baanx US and Monavate Holdings.
- CLAUDE.md, Roadmap item 5 and `docs/1inch-aqua-card.md` §6: "Immersve …
  permissionless withdrawals" → withdrawals need an Immersve-signed EIP-712
  intent; and Immersve's EEA issuing channel was cut on 29 Dec 2025.
- `docs/1inch-aqua-card.md` §6 and §11: Kulipa as a live precedent → defunct
  since 29 Jul 2026.
- `docs/1inch-aqua-card.md` §7 route 2: "Marqeta does not publish the gateway
  response timeout" → it does: three seconds. Lithic 6 s, Airwallex 2.5 s,
  Adyen 2 s, Immersve custodial 1 s, Bridge webhook 0.5 s.
- `docs/1inch-aqua-card.md` §10 and CLAUDE.md: "not on Base Sepolia … fork Base
  mainnet or work on Base/Gnosis" → also true, but Ethereum Sepolia has the
  registry, sandbox EURe and a bundler. "11,240 bytes" → 5,619 bytes.
- `docs/aqua-on-gnosis-pay.md` §2: EURe on Gnosis → two contracts; Monerium's
  list now publishes `0x420CA0…`.
- Aqua chain list: README says 16 chains; 12 of them plus Sepolia verified
  here; Robinhood, Cronos, Monad, HyperEVM not probed.


## 11. What is not known, and who has to answer it

- Whether 1inch considers the Sepolia registry official (ask the steward).
- Whether Exodus sells the approval-pull tier to third parties at all, and what
  UAB Monavate's cardholder terms would say about a pull that is not a Safe
  transaction (the Gnosis Pay terms question in `docs/aqua-on-gnosis-pay.md`
  §5, transposed).
- Whether Bridge will register a third-party implementation, and when EEA
  cards go live.
- Rain's and Checkout.com's callback timeouts.
- Which EURe contract Gnosis Pay's Supported Funds refers to.
- Nothing here has run. No strategy exists, no CardApp exists, no `ship()` has
  been sent from a Zold Safe, on any chain.
