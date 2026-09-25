# 1inch Card, non-custodial, on Aqua — a proposal

> **Read `docs/1inch-aqua-incubator-application.md` first (11 Sep 2026).** It
> corrects this file: Kulipa (§6, §11) is defunct since 29 Jul 2026; Baanx and
> Monavate are owned by Exodus since 1 May 2026 (via receivership, not the
> $175m deal); Immersve withdrawals are not permissionless and Immersve has no
> EEA issuer since Dec 2025; Marqeta's JIT timeout is published (3 s); Aqua IS
> on Ethereum Sepolia (§10 says no testnet — that was Base Sepolia only); the
> "11,240 bytes" figures are hex length, the code is 5,619 bytes. The
> structure below still stands.

Status: **proposal, nothing built.** Written Sep 2026 against the Aqua developer
whitepaper (Version: Developer Preview 1.0), the deployed `Aqua.sol` source, and
`eth_getCode` probes of the live registries. Every claim marked VERIFIED below
was checked against a chain or the source, not read off a blog post — and one of
them contradicts the blog post.

The ask is narrow: **1inch Card is the one custodial product 1inch ships, and
Aqua is the primitive that fixes it.** Zold supplies the wallet, the euro leg
and the settlement rail. Nobody has to write a new protocol.


## 1. What Aqua actually is, once you take the AMM framing off

`Aqua.sol` is **80 lines**. It has no owner, no pause, no upgrade path, and it
never holds a token. Its entire state is one mapping, and the source comments it
itself:

```solidity
mapping(address maker =>
  mapping(address app =>
    mapping(bytes32 strategyHash =>
      mapping(address token => Balance)))) private _balances; // aka makers' allowances
```

Four verbs act on it:

| verb | who calls it | what it does |
|---|---|---|
| `ship(app, strategy, tokens, amounts)` | the maker | grants a scoped, named spending right. **No tokens move.** |
| `dock(app, hash, tokens)` | the maker | revokes it. Sets the balance to 0 and marks it DOCKED. No tokens move. |
| `pull(maker, hash, token, amount, to)` | the app (`msg.sender`) | spends, straight from the maker's wallet to an arbitrary `to`. |
| `push(maker, app, hash, token, amount)` | anyone | returns value into the right, expanding it. |

Aqua enforces almost nothing about *why*. It enforces three ceilings and leaves
the policy to the app contract:

1. the maker's ERC-20 approval to Aqua — the outer hard cap the user sets,
2. the virtual balance for that exact `(maker, app, strategyHash, token)`,
3. the maker's real wallet balance at `pull()` time, or the transfer reverts.

Strip the market-making vocabulary and what is left is a **general-purpose,
revocable, scoped, atomic spending-rights registry over funds that never leave
the owner's wallet.** 1inch shipped a card authorization primitive and called it
a liquidity protocol.


## 2. What is wrong with 1inch Card today

- **It is custodial.** Crypto Life / Baanx holds the balance; Monavate is the
  issuer and principal Mastercard member. If Baanx fails, the cardholder is an
  unsecured creditor. This is the same shape as every crypto card except Gnosis
  Pay, and Gnosis Pay's Safe is Gnosis Pay's, not the user's.
- **You have to pre-load it, and loaded money stops being anything else.** It
  earns nothing, votes nothing, collateralises nothing, provides no liquidity.
  This is the "DeFi-disabled capital" complaint the Aqua whitepaper opens with,
  applied to spending instead of to LP positions. 1inch argues against pooled
  custody in one product and requires it in another.
- **The economics leak to a third party.** Published figures: 1.75% conversion
  fee, 2% cashback in BXX, roughly 0.25% net to the user. The conversion spread
  goes to the card partner, not through 1inch's own aggregator.
- **Brand.** 1inch's identity is self-custody. The card is the exception, and it
  is the most consumer-visible product in the suite.

A card that spends from the user's own wallet fixes all four at once, and the
fourth for free.


## 3. The mapping

| Aqua concept | Card concept |
|---|---|
| Maker | the cardholder's own smart account |
| ERC-20 approval to Aqua | the user's hard ceiling across every card they hold |
| `ship()` | issue a card. Instant, no funding step, no money moves. |
| `strategyHash` | **the card itself** — immutable terms: settlement asset, per-tx cap, expiry, policy commitment, card id in the salt |
| virtual balance | the card's available limit |
| `pull(..., to)` | clearing. `to` is the settlement address. |
| `push()` | refund, reversal, cashback. Auto-expands the limit — the whitepaper's auto-compounding, reused. |
| `dock()` | freeze or cancel. One call, immediate, no funds move. |
| balance below commitment → `pull()` reverts | **a decline.** |

One wallet balance backs many cards, each with its own hash and its own limit,
with no capital split between them. That is Aqua's shared-liquidity property
applied to spend authority. It is also just how a household with four cards on
one current account already works.


## 4. The inversion — why cards fit Aqua better than trading does

Aqua's one genuinely unresolved economic risk, stated plainly in §6.2 of the
whitepaper, is that virtual balance can exceed real balance. When it does, the
strategy is "illiquid": `pull()` reverts, the AMM keeps quoting a price it
cannot honour, and the first trade after liquidity returns can lock in an
adverse move. For a market maker that is path-dependent loss and the paper
recommends manual docking as the mitigation.

**For a card, the same condition is a decline.** Declines are routine and cost
nothing in every card network. There is no adverse selection, no path
dependence and no inventory facing a stale price.

The amplification argument is also *stronger* here. The whitepaper measures
85–97% of AMM liquidity sitting idle. A card limit is idle far more than that:
€5,000 of headroom exists so that one €80 supermarket trip clears. So the same
€5,000 of EURe can simultaneously be a €5,000 card limit, Aave collateral, and
an LP strategy, and in practice the card touches €80 of it. The whitepaper calls
that "utility efficiency" and illustrates it with gauge voting. Spending is the
version of it a consumer can actually see.


## 5. The hard problem: authorization is not clearing

This is where a naive "just point the card at Aqua" design fails, so it goes
before the architecture rather than in a footnote.

Mastercard's flow is authorization (seconds, at the terminal) → clearing (hours
to days) → settlement. The issuer is exposed for the whole gap. If `pull()`
reverts *at clearing*, that is not a decline — the merchant already handed over
the goods and the issuer eats it. `ship()` checks neither the wallet balance nor
the ERC-20 approval (VERIFIED, read the source: it writes the virtual balance
unconditionally), so a virtual limit is a ceiling, not a reserve.

Three tiers, and a real product picks one per transaction rather than pretending
the problem away:

**Tier A — reserve at authorization. The default.**
The authorization message triggers `pull()` immediately, into a per-transaction
settlement contract rather than to the acquirer. Clearing releases; a void or
expiry `push()`es back into the card's limit. The issuer gets hard certainty and
the user still never pre-loaded anything.

The float argument is the whole pitch in one line: today the user's float is
*their entire card balance, for as long as they hold the card*. Under Tier A it
is *one transaction, for one clearing cycle*. That is the same order-of-magnitude
improvement Aqua claims for LP capital, moved onto spending.

Cost: one on-chain transaction per authorization. On Base or Gnosis that is
cents, and it can be paymaster-sponsored so the user never holds gas — Zold
already runs Candide's bundler and paymaster for exactly this.

**Tier B — stand-in with a haircut.** For low-ticket, contactless and offline
authorizations where the network's latency budget will not tolerate an on-chain
round trip, approve against a cached balance read with configured headroom, pull
at clearing, and carry the tail risk. Every issuer already does this for offline
transactions. The difference here is that the eligibility rule — amount ceiling,
merchant category, country — lives in the immutable strategy bytes, so the
policy is on-chain and auditable rather than a row in a processor's config table.

**Tier C — credit.** A third party fronts the authorization, with the dockable
strategy as collateral. That turns the card into a genuine credit product and
Aqua into the collateral registry. Interesting, not for v1.


## 6. Does an issuer allow this? Yes — and 1inch's own partner already sells it

This was the first question asked of the proposal and it is the right one. The
permission gate is already open, and the market has walked through it. Five live
precedents, checked September 2026:

- **Baanx — the company behind the 1inch Card — runs the MetaMask Card, and it
  is non-custodial.** Funds stay in the user's wallet on Linea, the user sets the
  spending caps, and a smart contract authorises at the terminal in under five
  seconds. Baanx describes itself as the market leader in non-custodial cards,
  offers **custodial and non-custodial as two options on the same platform**
  across EVM and Solana, and shipped its first non-custodial on-chain card with
  Tezos in 2024. Ledger, Exodus, Trust Wallet and 1inch all run Crypto Life cards
  on that platform. **1inch is sitting on the custodial tier of a platform that
  sells the non-custodial one.**
- **Gnosis Pay** — a Visa card in the EEA spending from the user's own Safe on
  Gnosis Chain, funded with Monerium EURe against a personal IBAN. That is Zold's
  exact stack, in production, today.
- **Kulipa** — for self-custodial wallets the issuer processor sends the
  authorisation request and Kulipa moves the funds into an on-chain escrow, then
  clears with the scheme. That is Tier A above, running on Visa and Mastercard.
- **Rain** — a Visa principal member. Each customer gets a smart contract they own
  and can withdraw from; Rain underwrites a credit line against that collateral.
- **Immersve** — a Mastercard principal member, on-chain funding contracts,
  permissionless withdrawal.

So "will an issuer let a card spend from the user's own wallet" is settled. The
remaining gates:

1. **You need a programme manager who has already built the non-custodial
   authorisation path.** The list is short; Baanx is on it and already
   contracted with 1inch. Nobody has to build this from scratch with a bank.
2. **Every one of them binds the card to the provider's own wallet, on the
   provider's own chain.** MetaMask Card spends from a MetaMask smart account on
   Linea. Gnosis Pay spends from a purpose-built Gnosis Pay Safe on Gnosis, which
   shows as *view-only* in Safe{Wallet} because their modules own it. Rain spends
   from a Rain contract, Immersve from their Funds Storage. **Today
   "non-custodial" means: your keys, our wallet, our chain.**
3. **Latency is answered, not open.** Under five seconds at the terminal, per
   Baanx's own MetaMask material. That retires the biggest question in §5.
4. **Regulatory position is unchanged.** The programme manager owns KYC and the
   BIN sponsor owns the money leg. Non-custody moves neither.
5. **Counterparty timing.** Exodus is acquiring Baanx for $175m, expected to close
   in early 2026 subject to US, UK and EU approval. A conversation with Baanx in
   2026 is a conversation with a company mid-acquisition.

**Gate 2 is where Aqua matters.** Aqua is a neutral, ownerless registry deployed
deterministically across thirteen-plus chains, and anything that can call it can
grant against it, including a Safe the user already has on a chain the user
already uses. 1inch owns it outright, and a competitor cannot adopt it without
adopting 1inch's contract. The ask to Baanx is to point the non-custodial
authorisation path they built for MetaMask at Aqua in place of one wallet
vendor's own framework.

**Security.** On 1 June 2026 attackers exploited the Zodiac Delay and Roles
modules on Gnosis Pay's card Safes; roughly $1.5m was extracted and Gnosis
covered user losses. The root cause was a missing status check in a static call,
in a module installed on the user's own wallet. Aqua installs nothing on the
user's wallet. It holds an ERC-20 allowance and eighty lines of accounting with
no owner, no pause and no upgrade path, a strictly smaller surface than the
incumbent design.

**A fourth tier, and why Tier A stays the default.** Gnosis Pay's Delay Module
imposes a three-minute delay on the user's *non-card* transactions, which closes
the double-spend race between an authorisation and the user's own outbound
transfer without pulling anything at authorisation. Aqua has no delay mechanism,
so the race is open: either pull at authorisation (Tier A) or install a delay
module and accept the kind of surface that cost Gnosis $1.5m. That is why Tier A
is the default.


## 7. Whose contract does the pulling? The integration question

Yes — a card programme has to accept Aqua as the thing it pulls from, and none of
them do today. This is the hardest part of the proposal, harder than any contract
work, and it is worth sizing precisely rather than waving at.

**How big the change actually is.** Immersve's Universal EVM funding contract
already has an approval mode. Read from their source, not their docs:

```solidity
function directSpendDebit(address spender, uint256 amount, bytes32 idempotencyKey) external {
    _requireFundingMode(FundingMode.APPROVAL);
    _requireFundsAdmin(msg.sender);
    SafeERC20.safeTransferFrom(_token, spender, address(this), amount);
    ...
}
```

So a Mastercard principal member already ships the exact mechanic: the cardholder
keeps the money in their own wallet, grants an ERC-20 approval, and the programme
pulls at spend time with an idempotency key and a reversal window. Moving that to
Aqua is one call — `AQUA.pull(maker, strategyHash, token, amount, address(this))`
in place of `safeTransferFrom`, with the contract inheriting `AquaApp`. Their
idempotency keys, reversal window, refunds, pause and roles are all untouched.

One line in principle. A contract change, an audit and a product decision in
practice, and it is theirs to make, not ours.

**What they get for making it.** Their approval mode today is a blanket ERC-20
allowance to their own contract: one number, no per-card limit on chain, no way
to revoke one card without revoking all of them, and no accounting if the same
balance is meant to back anything else. Aqua gives three ceilings instead of one,
a per-card virtual balance, a `dock()` that kills one card without touching the
approval, and separate accounting so a card cannot eat a committed payroll.

**The counter-argument.** For one card with one limit, a raw approval to their
own contract is simpler, and Aqua is a third-party dependency for accounting
they could keep in their own storage. Aqua is only worth it when several
spending rights sit over one balance and the accounting should be neutral
rather than the card programme's private ledger.

### The consequence nobody can design around: `dock()` forces Tier A

Aqua's revoke is unconditional and immediate. `dock()` zeroes the virtual balance
and any later `pull()` underflows and reverts, and the card programme cannot delay
it, veto it or see it coming. That is excellent for the cardholder and a genuine
problem for the issuer, because a cardholder can spend at a terminal and dock
before clearing.

Gnosis Pay's three-minute Delay Module exists to close this race (its defined
term in their terms of service says so, "in order to avoid double-spending"),
and Aqua reopens it. No module can fix it: the user calls `dock()` on Aqua
directly, and nothing the CardApp does can slow it. Gnosis Pay already reserves
at authorisation (their lifecycle docs: on approval "money is immediately
deducted … and moved to hold account on chain"), so for that programme Tier A is
not a new settlement model, only a new place to pull from.

**So pull-at-authorisation is the only safe tier for an Aqua card.** §5's Tier B
is unavailable once the funding source is Aqua. Say so at the start of any
partner conversation.

### Three routes, and only one of them is a pitch

1. **1inch directs its own programme.** This is why this proposal is addressed to
   1inch and not to Rain or Immersve. 1inch is Baanx's *client*, and a client can
   specify a funding source where a peer asking a competitor to adopt their
   protocol cannot. Baanx has already built the non-custodial authorisation path,
   so the ask is "point it at Aqua", not "build non-custodial".
2. **Just-in-time funding, where nobody has to accept Aqua at all.** Marqeta's
   Gateway JIT Funding — documented as available in Europe — inverts the flow: the
   platform sends a synchronous message asking permission to fund each
   transaction, and our gateway answers. The funding source is then our business
   and invisible to them; at clearing Marqeta performs a JIT Unload and a Partner
   Funds Load, which is where the money is actually delivered. Aqua appears in
   nobody's contract but ours. The trade is that we take on programme-manager
   obligations and need a BIN sponsor, so it is the heavier route commercially and
   the lighter one technically.
   CAVEAT, and it is the number that decides the architecture: **Marqeta does not
   publish the gateway response timeout.** If it is around a second, no chain
   settles a pull inside it — Base blocks are 2s, Gnosis 5s — so the gateway must
   decide on a state read and pull immediately afterwards, leaving a few seconds
   of exposure per transaction. Get that number before designing anything.
3. **Take a programme as-is and put Aqua elsewhere.** Going with Gnosis Pay or
   Rain unchanged means their wallet on their chain, and Aqua adds nothing to the
   card — except on Gnosis Pay, where it turns out the card Safe can be an Aqua
   maker with nobody's permission, because the user can queue arbitrary
   transactions through the Delay Module. That is worked out in full in
   `docs/aqua-on-gnosis-pay.md`, including the reserve rule that keeps the card
   working and the finding that an Aqua pull bypasses their three-minute delay.
   Aqua also adds nothing to the card itself there. It still earns its place on §9's other uses: mandates, invoice
   pre-authorisation, employee limits, refund reserves. Smaller claim, available
   today, no partner has to agree to anything.

Route 1 is the pitch. Route 2 needs no permission but needs a licence
relationship. Route 3 is what happens if both stall, and it is not a failure.


## 8. What each party builds, and why the incumbent says yes

**1inch builds one contract: `CardApp.sol`.** No protocol change. Sketch, using
the real interface:

```solidity
contract CardApp is AquaApp {
    struct Card {                 // abi.encode(card) -> strategyHash
        address app;              // == address(this), checked
        address holder;           // the maker
        address token;            // settlement asset, e.g. EURe
        uint256 perTxCap;
        uint64  expiry;
        bytes32 policy;           // hash of the MCC / country / velocity rules
        bytes32 salt;             // the card id
    }

    // called by the licensed processor, against an authorization it already
    // risk-checked; funds land here, not at the acquirer, until clearing
    function authorize(address holder, bytes calldata card, uint256 amount, bytes32 authId)
        external onlyProcessor
    {
        Card memory c = _decode(card);              // reverts if c.app != address(this)
        require(amount <= c.perTxCap && block.timestamp < c.expiry);
        AQUA.pull(holder, keccak256(card), c.token, amount, address(this));
        _holds[authId] = Hold(holder, keccak256(card), c.token, amount);
    }

    function clear(bytes32 authId, address acquirer) external onlyProcessor { /* release */ }
    function voidAuth(bytes32 authId) external { /* AQUA.push back into the limit */ }
    function refund(address holder, bytes calldata card, uint256 amount) external { /* merchant push */ }
}
```

Four properties come from Aqua's design, not from this contract:

- `pull()` takes the app from `msg.sender`, so only the app the holder shipped
  to can spend that card, only up to that card's own virtual limit, and never
  above the holder's ERC-20 approval. Three independent ceilings, none of them
  ours to raise.
- `dock()` zeroes the balance, so a later `pull()` underflows and reverts.
  Freeze is immediate and costs one transaction with no funds movement.
- Strategies are immutable, so raising a limit is dock-then-ship. That is the
  right security property for a card and awkward UX; the app hides it.
- Aqua has no admin key and no pause, so no party (1inch included) can freeze a
  cardholder's underlying funds.

**A trap worth writing down now:** `push()` requires an *active* strategy. A
refund to a docked card **reverts**. So do not dock on card expiry or on
cancellation until the refund window has closed, or route late refunds to a
fresh strategy. This is a live bug in any first implementation that treats
`dock()` as "close the card".

**Zold supplies the account and the euro.** Already built and running:
passkey-owned Safe (2-of-2, Candide, RIP-7212 verified live on Base *and* on
Gnosis chain 100), email/SMS guardian recovery, Monerium EURe with a real
Estonian IBAN and a redemption right at par against a licensed e-money issuer,
user-signed execution where the chain enforces token, amount and destination,
best-execution routing across LI.FI / Uniswap v3 / RFQ with a live-mid guard,
and statements and receipts that verify on re-read.

That matters because Aqua gives you a spending right, not euros in an acquirer's
account. The gap between those two is the entire reason Baanx exists and the
entire reason it is custodial. Zold closes it with e-money rather than with a
conversion desk.

**Baanx / Monavate, or a replacement, keep the BIN and the processing and stop
holding customer funds.** This is the line that makes the incumbent agree rather
than resist: safeguarding customer money is their most expensive obligation, and
this removes it. They become a processor, which is what they are good at.

**And 1inch gets more volume, not less.** The conversion at settlement moves off
the card partner's book and onto 1inch's own router. The 1.75% that currently
leaves the ecosystem becomes aggregator flow. Cashback stops being a custodial
credit and becomes a `push()` that expands the user's own limit.


## 9. Five things Aqua does that are not swaps

The user's constraint was "not a swap product". Each of these is a surface Zold
already ships, where Aqua replaces a database promise with a chain-enforced one.

1. **Subscription mandates.** A merchant gets a strategy: a direct-debit-shaped
   right with a hard on-chain cap and instant `dock()` cancellation. No eight-week
   refund dispute, no letter to a bank. Zold already has payment links and a
   Shopify integration that would consume this directly.
2. **Invoice and payroll pre-authorization.** Zold's business drafts have a
   known gap — the window between four-eyes approval and execution, where an
   address-book edit lands. We detect it with a stored fingerprint recomputed at
   execution. `ship()` the approved amount to a payout app at review time
   instead: committed, still in the Safe, still earning, chain-enforced, and
   `dock()` is the cancel. The commitment stops being a row in `db.json`.
3. **Employee cards on one org balance.** One strategy per employee, per-employee
   cap, revoke on offboarding in a single call. Today that needs N funded
   sub-accounts and a sweep.
4. **Merchant refund reserve.** A Shopify merchant's refund float becomes a
   virtual balance the acquirer can pull, not a deposit we hold. Directly
   relevant to the merchant-privacy work already parked.
5. **Invoice financing without escrow.** A lender ships a virtual balance against
   an invoice; the app pulls on acceptance. No locked collateral on either side.

For completeness: Aqua as a *swap* venue drops into Zold's existing
`LiquidityProvider` seam beside LI.FI and the Uniswap adapter, with a
`safeSwapPlan` the user's Safe executes. That is a half-day of work and it is not
what this document is about.


## 10. Verified, and not verified

**VERIFIED on chain, Sep 2026, `eth_getCode` plus selector search in the deployed
bytecode:**

- Aqua registry `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` is live on Base
  mainnet and on Gnosis, with identical bytecode length (11,240 bytes) on both,
  so a deterministic deploy. Monerium issues EURe on both chains, and Gnosis is
  where Gnosis Pay's card Safes live.
- Its deployed bytecode contains the selectors for `ship`, `dock`, `pull`,
  `push` and `rawBalances`, so the repo interface is the deployed interface.
- **The address in the 1inch developer-release blog post is a different
  contract.** `0x499943e74fb0ce105688beee8ef2abec5d936d31` is also live on Base,
  12,504 bytes, same ABI — the November 2025 developer preview. Two registries
  with the same interface on one chain. Ship to the wrong one and the virtual
  balances sit in a registry no app reads. Pin the address from the repository,
  not from the announcement.
- Aqua is not deployed on Base Sepolia (empty code). As with LI.FI, the card
  work cannot be exercised on Zold's current test chain. Either fork Base
  mainnet locally or do this work on Base mainnet or Gnosis.
- `Aqua.sol` read in full: 80 lines, no owner, no pause, no upgradeability, no
  signature scheme. A Safe can be a maker, since `ship()` and `dock()` key off
  `msg.sender` with no EOA assumption.

**Not verified, and each is a real gate:**

- **The license.** Aqua is `LicenseRef-Degensoft-Aqua-Source-1.1`, © Degensoft
  Ltd — source-available, not open source. A CardApp built on it needs a
  licensing conversation. That gate is also the reason to open the conversation,
  which suits a pitch.
- **Latency for Tier A on *our* chains.** Baanx authorises the MetaMask Card in
  under five seconds on Linea, so the shape is precedented — but nobody has run a
  pull-at-authorisation against Aqua on Base or Gnosis. The `onlyProcessor` role
  is a licensed entity and the budget is still theirs to confirm.
- **Nothing here has run.** No CardApp exists. No `ship()` has been called from a
  Zold Safe. No authorization has ever been settled this way by anyone.
- **Approval rate is a commercial risk even when it is not a loss.** A
  non-custodial card that declines more often than a prepaid one is a problem
  with the scheme and with users, independent of who bears the money.
- **Licensing on our side is unchanged and this proposal does not pretend
  otherwise.** Zoldenburg holds no MiCA transfer licence and no e-money licence.
  The euro leg is Monerium's; the card leg is the BIN sponsor's. Non-custody
  narrows the MiCA class and drops safeguarding. It does not answer the licence
  question.
- Published 1inch Card figures (1.75% conversion, 2% BXX cashback, EEA/UK only,
  Baanx/Monavate) come from public reviews and the card page, not from 1inch
  directly. Confirm before quoting them back at them.


## 11. The ask

The question is no longer whether a card can spend from a wallet the user
controls. Baanx answered that for MetaMask, Gnosis Pay answered it for Visa in
the EEA on the same Monerium rail we already run, and Kulipa answered it by
pulling into escrow at authorisation exactly as Tier A describes.

The open question is narrower and it is commercial, not technical: **will Baanx
point the non-custodial path they already sell at a registry 1inch owns and a
wallet 1inch does not?** One conversation, three people in the room — Aqua's
authors, whoever owns the card relationship at 1inch, and Baanx. Everything
technical here is precedented. The only unprecedented part is the wallet being
neutral, which is precisely the part 1inch would own.

1inch advertised bounties of up to $100,000 for contributions on the Aqua
developer release, and runs a separate Aqua security bounty on HackenProof. A
reference `CardApp` is the sort of contribution the first of those is paying
for, and it is the same artifact this proposal needs built anyway.
