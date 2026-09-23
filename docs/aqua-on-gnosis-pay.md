# Aqua on a Gnosis Pay account — what is actually possible

Companion to `docs/1inch-aqua-card.md`. Written Sep 2026 from
`gnosispay/account-kit` source (`populateAccountSetup`, `parts/rolesMod.ts`,
`parts/bouncer.ts`, `contracts/Bouncer.sol`, `accounts-actions/execute.ts`) and
from `eth_getCode` / `eth_call` against Gnosis Chain. Not from the docs page,
which omits the two facts that matter most.

Status: **investigation. Nothing built, nothing shipped, no user has done this.**


## 1. How a Gnosis Pay account is really built

Account setup is a single multisend, and its first instruction is the surprising
one:

1. **`swapOwner(0x…01, owner, 0x…02)` — the Safe renounces ownership.** Its only
   owner becomes the placeholder `0x…02`. Nobody holds a key that can call
   `execTransaction` ever again. From here the Safe is driveable only by modules.
2. `enableModule(rolesMod)` and `enableModule(delayMod)` on the Safe.
3. Delay module deployed, then `setTxCooldown(cooldown)` and
   `setTxExpiration(expiration)` — the documented values are 3 minutes and a
   week. Then **each beneficiary is `enableModule`d on the Delay module itself.**
   That is how the user acts at all: the EOA is a module on the Delay module,
   which is a module on the Safe.
4. Roles module deployed. `setAllowance(SPENDING_ALLOWANCE, refill, maxBalance,
   refill, period, timestamp)` — a refilling allowance, e.g. daily.
5. `assignRoles(spender, [SPENDING_ROLE], [true])` — Gnosis Pay's spender gets it.
6. `scopeTarget(role, token)`, then `scopeFunction(role, token,
   transfer.selector, …)` with exactly two conditions: the `to` parameter must be
   **EqualTo the settlement receiver**, and the amount must be **WithinAllowance**.
7. `transferOwnership(rolesMod → Bouncer)`. `Bouncer.sol` is 45 lines that
   forward exactly one selector from exactly one caller, and its constructor pins
   that selector to `setAllowance`.

So the card's entire on-chain power is `EURe.transfer(settlementSafe, amount)`,
amount within a refilling allowance. That is a genuinely tight scope and it
deserves the compliment.

**Two consequences the documentation page does not state, both material:**

- **The user cannot revoke Gnosis Pay's role.** The Bouncer pins `setAllowance`,
  so the only Roles-module change anyone can ever make on that account is
  adjusting the allowance. You can set your daily limit to zero; you cannot
  unassign the spender, re-scope the role or add a target. Ownership of the roles
  module has been handed to a contract that will forward one function forever.
  "Self-custody" here means the money is yours and the permission is permanent.
- **The user CAN execute arbitrary transactions from the Safe**, by queueing them
  on the Delay module and executing after the cooldown. That is the door Aqua
  walks through, and it needs nobody's agreement.


## 2. Verified on Gnosis Chain (100), Sep 2026

- Aqua registry `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`: **11,240 bytes of
  code**, containing the `ship` / `dock` / `pull` / `push` selectors. Same
  bytecode length as the Base deployment, so the same deterministic build.
- EURe `0xcB444e90D8198415266c6a2724b7900fb12FC56E`: `name()` returns
  **"Monerium EUR emoney"**, `symbol()` returns **EURe**.

Both halves of the idea are already on the chain Gnosis Pay runs on.


## 3. What Aqua can do there today, with nobody's permission

Queue `EURe.approve(AQUA, X)` on the Delay module, wait the cooldown, execute.
Queue `AQUA.ship(app, strategy, [EURe], [amount])`, wait, execute. The Gnosis Pay
Safe is now an Aqua maker, and the same EURe that backs the card also backs a
strategy.

### Idea 1 — the card float stops being idle. This is the whole point.

A Gnosis Pay balance is money you are required to keep sitting still. Self-custody
made it yours; it did not make it productive. Aqua's entire thesis is that idle
capital should back a strategy, and a card float is the purest idle capital in the
product: high balance, low utilisation, indefinite duration — worse than the
85-97% idleness the Aqua whitepaper measures for AMM pools.

Gnosis is also where EURe's deepest liquidity sits. CoW quoted 100 EURe → 113.83
USDC there against a live mid of ~1.1379, essentially mid (recorded in CLAUDE.md
under Liquidity venues). Fees come back through `push()`, which expands the
strategy's usable balance automatically.

Nothing here requires Gnosis Pay to agree to anything, and that is the unusual
part.

### THE RESERVE RULE — the only thing between this and a declined card

`pull()` can never exceed the strategy's virtual balance. So ship
(balance − reserve) and the drain is capped at exactly that, leaving the reserve
for the card. One line, and it must be enforced in the UI:

> the sum of virtual balances shipped across ALL strategies must be
> ≤ balance − card reserve

Aqua's SLAC argument is that a maker *should* over-provision the same balance
across several strategies. **For a wallet backing a card that argument is
inverted and must be refused.** A UI that presents shared liquidity the way the
whitepaper frames it will quietly ruin somebody's weekly shop.

### THE FINDING THAT HAS TO BE SAID OUT LOUD

**An Aqua `pull()` is invisible to the Delay Module.** The three-minute delay
governs transactions the *Safe executes*. `AQUA.pull()` is
`transferFrom(safe, to, amount)` executed by Aqua against an allowance the Safe
already granted — it is not a Safe transaction, so nothing queues and nothing
waits.

The double-spend protection Gnosis Pay built specifically to keep the card funded
does not cover this route. That is not a vulnerability in either system; it is
the correct behaviour of an ERC-20 allowance. But it means the reserve rule above
is the *only* protection, and a user who ships their whole balance has removed a
guarantee they almost certainly think they still have. Put that sentence next to
the button.

### Idea 2 — other spending rights over the card balance, without a second module

Gnosis Pay gives one refilling allowance, to one spender, for one recipient, and
it cannot be extended or revoked. Aqua strategies over the same Safe can express
further scoped rights — a subscription mandate, an invoice commitment, a savings
sweep — each with independent accounting and, unlike the card role, each
**instantly revocable with `dock()`**. That is the "several rights over one
balance" argument made concrete, on a wallet that already exists and already has
exactly one permanent right.

### Idea 3 — the change that needs Gnosis Pay, and it is one line again

Their spender calls `EURe.transfer(receiver, amount)` through the Roles module.
If the spender were instead an Aqua App calling
`AQUA.pull(maker, strategyHash, EURe, amount, receiver)`, the card could spend
from **any wallet that shipped a card strategy** — including a Zold Safe — with
no Gnosis Pay Safe in the picture and no money migration at all. Structurally the
same one-line change as Immersve's `directSpendDebit`.

The same caveat carries and must lead the conversation rather than follow it:
`dock()` is instant and unstoppable, so a card funded through Aqua has to reserve
at authorisation. **Gnosis Pay already does exactly that** — see §4 — so this is
the one programme where the change would not force a redesign of the settlement
model, only of where the funds are pulled from.


## 4. CORRECTION — the card pulls at authorisation, not at clearing

An earlier draft of this work said Gnosis Pay does not reserve at authorisation
and that the Delay Module covers the gap to clearing. **That was wrong.** Their
own transaction-lifecycle documentation says that on approval "money is
immediately deducted from user account and moved to hold account on chain", and
that at clearing insufficient balance "isn't an issue" because the funds were
already reserved at authorisation. The Monavate cardholder terms say the same in
contract language: funds "held in the Safe" are "immediately deducted and used to
fund the purchase".

Two things follow, and they pull in opposite directions:

- **The exposure window is one instant, not 24-48 hours.** If the EURe is there
  when the card is tapped, the payment completes. Clearing cannot fail for want
  of funds. That makes the float idea materially safer than the first draft
  assumed.
- **The Delay Module's job is narrower than assumed**, and their own defined term
  says so: it imposes three minutes on "any non-Card transactions that you carry
  out from your Safe … in order to avoid double-spending". An Aqua `pull()` is
  not a transaction the user carries out from the Safe, so §3's finding stands
  unchanged and is now backed by their own drafting rather than by inference.

Also settled from the definitions: the card's destination is the **Settlement
Safe**, "owned and controlled by Monavate", and **Supported Funds** are GBPe in
the UK, **EURe in the EEA and Switzerland**, USDC.e elsewhere, all on Gnosis
Chain. A German cardholder's card spends EURe and nothing else.


## 5. The terms, read

Two agreements govern this: the **Gnosis Pay Terms of Service** (last updated 18
November 2025, governed by English law; the EEA counterparty is Gnosis P. Tech,
Unipessoal Lda in Lisbon) and the **Monavate Cardholder Terms (EEA)**, with the
card issued by UAB Monavate in Vilnius. Not legal advice; this is what the text
says.

**Nothing in either agreement prohibits granting an ERC-20 allowance from the
Safe.** The ToS goes further and contemplates it: §11.3 disclaims liability for
the Safe "because, for example, it is accessible by other third party software
applications and your use of any such applications may be subject to separate
terms and conditions". §10 does the same for Third Party Services generally.

Four clauses nonetheless bite, and one is expensive.

**§6.2, "Prohibited Configurations" — drafted by exclusion.** Any configuration
of the Safe other than deploying the two modules (§5.3) and setting the daily
limit (§6.1.6.2) is a Prohibited Configuration, and the stated consequence is
that "the Card [becomes] incompatible with the Safe such that it can no longer be
used as a funding source". An ERC-20 approval is arguably not a *configuration*
of the Safe at all — it changes no owner, module, threshold or guard — and
Monavate's equivalent ground is worded more narrowly still, as modifying
configurations "in such a way that it no longer works with the Card", which an
approval does not. So an approval most likely sits outside the clause. But that
is a gap rather than a permission, and §2.6 lets Gnosis Pay "disable or restrict
your Account … at any time" for non-compliance, at their discretion.

**Monavate: a continuous balance obligation.** "You must have sufficient
Supported Funds in your Safe **at all times** to cover the value of any
transactions you make using your Card." Over-shipping is therefore a breach of
the cardholder terms, not merely a risk of a decline.

**THE SHORTFALL CLAUSE — the real cost of getting the reserve wrong.** If a
transaction completes while the Safe is short, the difference is a *Shortfall*
which "must be reimbursed by you"; Monavate "may charge your Safe for this
amount", "may suspend the Card" until reimbursed, and "reserve the right to
charge … an administration fee for each transaction" that causes one. So the
downside is not a polite decline. It is a debt to the issuer, a per-transaction
fee, and a suspended card.

**§5.5: "Your Account is a personal account, and you must not use it for business
purposes."** That removes any treasury or org version of this idea outright.

**And the clause that is the best argument *for* it.** Monavate's terms state
plainly that "no interest is payable to you on the balance of Supported Funds
stored on the Safe". The idleness is contractual, not incidental — the issuer has
told the cardholder in writing that this money will earn nothing, forever.


## 6. Sizing the reserve, with numbers from the terms rather than guesses

Two inputs come straight out of the cardholder terms:

- At hotels and car rentals "an additional amount (typically 10%-20%) may be
  added to anticipate service charges or tips", temporarily charging the Safe for
  more than the bill.
- That difference "may take up to seven (7) days from the date of the
  transaction before the difference is available to spend".

So a reserve has to survive a 120% authorisation and a week-long hold.

**A better rule than a slider: set the reserve equal to the on-chain daily
spending limit.** The Roles module caps what the card can draw in a period at
exactly that allowance, so a reserve equal to it cannot be exhausted by the card
within a period. It is also a number the user already chose, and one Zold can
read through Gnosis Pay's own API (`Retrieve Onchain Daily Limit`) rather than
inventing. The invariant becomes:

> sum of EURe virtual balances shipped across all strategies
> ≤ EURe balance − on-chain daily limit

**And the framing that makes this honest rather than frightening: the money never
leaves the Safe.** Aqua holds an allowance, not the tokens. The card always sees
the full balance. The reserve is not a segregated pot — it is a cap on how much
somebody else could take in a race. Docking is one transaction and instant, and
because nothing ever moved there is no withdrawal to wait for.


## 7. The risk that is specific to AMM strategies, and it is the real objection

An Aqua AMM strategy converts inventory by design. A pull that takes EURe and
pushes back USDC.e leaves the cardholder holding USDC.e — **which an EEA card
cannot spend**, because Supported Funds for the EEA are EURe only. Total value is
unchanged and the card is still underfunded.

The virtual-balance ceiling contains this: if shipped EURe never exceeds
balance − reserve, the reserve survives any fill. But it means the *yield* arrives
in the wrong asset and has to be swapped back, and it means a market-making
strategy is a poor structural fit for card money.

**The shape that actually suits a card float is not an AMM, and "single-asset" is
too loose a name for it.** Two independent properties have to hold, because two
different things can make the EURe absent when the card is tapped:

| strategy shape | asset comes back changed? | absent between transactions? | `dock()` recovers it? |
|---|---|---|---|
| AMM, two tokens | yes, EURe can return as USDC.e | no | n/a |
| term lending, one token | no | yes, for the term | **no** |
| atomic same-asset (flash) | no | no | nothing to recover |

The first fails on asset: an EEA card cannot spend USDC.e. The second fails on
duration, and on a point worth stating plainly — **`dock()` revokes future pulls,
it does not claw back what has already been pulled.** Only the third leaves the
EURe physically in the Safe at the end of every transaction, because `push()`
transfers straight back to the maker.

So the property is **same asset AND same transaction**. Concretely, an app whose
only legal operation is pull EURe, hand it to a borrower inside the call, and
require EURe plus a fee back before the call returns:

```solidity
contract SameAssetFlashApp is AquaApp {
    function flash(address maker, bytes calldata strategy, uint256 amount, bytes calldata data)
        external nonReentrantStrategy(maker, keccak256(strategy))
    {
        Strategy memory s = _decode(strategy);       // reverts if s.app != address(this)
        bytes32 h = keccak256(strategy);
        (uint256 start,) = AQUA.rawBalances(maker, address(this), h, s.token);
        AQUA.pull(maker, h, s.token, amount, msg.sender);
        uint256 fee = amount * s.feeBps / 10_000;
        IFlashBorrower(msg.sender).onFlash(s.token, amount, fee, data);
        _safeCheckAquaPush(maker, h, s.token, start + fee);   // borrower pushed amount + fee
    }
}
```

`_safeCheckAquaPush` is Aqua's own helper for callback flows and it requires the
reentrancy lock the modifier provides. If the borrower does not push, it reverts
and the pull unwinds with it. No inventory risk, no duration, no credit risk, and
the blast radius of a bug is the shipped virtual balance rather than the wallet.

**And the honest part: the risk ladder is the return ladder inverted.** EURe
flash-loan demand on Gnosis is probably close to zero, so this earns close to
nothing. Aqua ships one example app, `XYCSwap.sol`, and it is a swap. Nothing of
this shape exists, it would be new unaudited code, and it is subject to the same
Degensoft licence question as everything else here. That is the piece that
decides whether the card-float idea is worth doing at all.

**Honest assessment:** the mechanism works, the terms most likely permit it, and
the reserve rule is provable. But with only AMM-shaped strategies available, the
cardholder takes inventory risk and contract risk on the money that makes their
card work, in exchange for returns that on Gnosis are unlikely to be large. For
most balances that is a bad trade. Build the single-asset strategy first, or do
not offer this.


## 8. What this does not fix

- **No authorisation webhook.** The permissionless integration gives a third
  party no hook to answer, so nothing can fund the card just in time. Idea 1
  makes the float productive; it does not abolish the float. Only Idea 3 does.
- **Their terms.** Now read — see §5. Probably permitted, not clearly permitted,
  and Gnosis Pay keeps a discretionary right to restrict the account.
- **The role is permanent.** A user who wants out closes the account. Setting the
  allowance to zero is the only lever.
- **Modules on the user's wallet are the attack surface.** The June 2026 exploit
  was an ERC-1271 check in the module path that read the returned magic value
  without checking that the call had succeeded, letting forged approvals queue
  withdrawals from accounts the attacker did not own; ~$1.5m was taken and Gnosis
  covered it. Aqua adds no module. It does add a spender with a standing
  allowance, and that allowance survives anything Gnosis Pay does, because
  revoking it needs a Safe transaction and the only paths are the scoped role and
  the user's own delay queue. That cuts both ways; tell the user which way.


## 9. Zold's shortest path

Zold already connects to Gnosis Pay by SIWE and reads cards, balances and
transactions (PR 1, `docs/gnosis-pay-permissionless-integration.md`). None of the
additions below touch the card:

- read the Safe's Aqua state with `rawBalances` and show it beside the Gnosis Pay
  balance,
- a reserve control that computes balance − reserve and refuses to ship past it,
  summing across every strategy rather than per strategy,
- two delay-queue transactions to approve and ship, one to dock,
- and the honest line next to the button: this money can be pulled by the strategy
  without the three-minute delay, and the reserve is what keeps the card working.
