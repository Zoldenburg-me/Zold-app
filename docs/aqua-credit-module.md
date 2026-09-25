# A credit module on Aqua — where it works and where it cannot

Companion to `docs/1inch-aqua-card.md` and `docs/aqua-on-gnosis-pay.md`.
Sep 2026. Status: **design note. Nothing built.**

Short answer: **yes, but not the way the question implies.** Aqua cannot hold
collateral and cannot be a lien. It can fund the *lender's* side of a credit
line, and that turns out to be the better use of it.


## 1. The trap, stated first

"Deposit ETH into the Safe and borrow against it" reads as secured lending. Built
on Aqua alone it is not secured at all, for two independent reasons, both read
out of the 80-line source:

- **`dock()` is unconditional and immediate.** The borrower revokes the claim
  whenever they like. The lender cannot delay it, veto it or see it coming.
- **Even without docking, the borrower just moves the collateral.** `pull()` ends
  in `safeTransferFrom` against the real wallet balance, so an empty wallet makes
  the claim revert. The virtual balance is a ceiling on a claim, never a reserve
  and never an encumbrance.

So a credit line whose only security is an Aqua strategy is **unsecured credit
wearing collateral's clothes.** Everything below is arranged around that fact
rather than pretending it away.


## 2. Verified on Gnosis Chain (100), Sep 2026

The whole stack for this already exists on one chain, and it is the chain Gnosis
Pay runs on:

- **Aqua registry** `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` — 11,240 bytes,
  carrying `ship` / `dock` / `pull` / `push`.
- **EURe** `0xcB444e90D8198415266c6a2724b7900fb12FC56E` — `name()` returns
  "Monerium EUR emoney". E-money, redeemable at par, with an IBAN behind it.
- **Aave v3 Pool** `0xb50201558B00496A145fE76f7424749556E326D8` —
  `getReservesList()` returns 9 reserves and **EURe is one of them**, alongside
  WETH, wstETH, GNO, sDAI, USDC, USDC.e and wxDAI.

Rates and sizes below are read off the Aave market page rather than measured
here: EURe on Gnosis shows roughly 15.79M supplied at **3.50%** supply APY
against 13.09M borrowed at **4.71%** variable borrow APY. Treat them as
indicative and re-read before quoting.


## 3. Design A — spend the collateral. Simple, and not credit.

Ship the collateral itself. The CardApp pulls it at settlement and swaps to EURe
through 1inch. No lender, no oracle, no liquidation, works today.

**Cost:** every purchase is a disposal. For a German user that is a taxable
event per transaction, and it breaks the one-year §23 EStG holding exemption on
the portion sold. People want a crypto credit card so they can spend without
selling, and this design sells. Do not ship it labelled as credit.


## 4. Design B — compose with a money market. Buildable now.

The Safe supplies wstETH, GNO or WETH to Aave v3 on Gnosis, borrows EURe, and the
borrowed EURe sits **in the Safe**. The Safe ships that EURe to the CardApp, and
the card pulls it at settlement. Repayment is whenever, or a sweep on incoming
EURe.

This is the Aqua whitepaper's own worked example, and it is already a shipped
product: ether.fi Cash runs Borrow Mode at a 55% LTV on weETH at roughly 4% APY,
against a Visa card, with a Direct Pay mode beside it that is Design A.

**Where Aqua fits.** You cannot borrow inside an authorization window: no chain
settles a borrow in the latency budget a terminal allows. So Design B is a
borrowed EURe buffer that the card draws down, with borrow interest paid on the
idle buffer. That is the card-float problem again, one layer up, and metered.

Re-supplying the borrowed EURe to Aave earns 3.50% against the 4.71% you pay,
cutting the buffer's cost to about 1.2 points, but it takes the EURe out of the
wallet, where the card cannot reach it.

> Aqua is the only way to make the buffer earn **without leaving the wallet**.

That is a narrow claim, and it should be pitched as one.

**Risks to put in front of a user, not in a footnote:**
- Liquidation while they are standing at a till. A 30-40% ETH drawdown has
  happened repeatedly; the card declines and the collateral sells at the worst
  moment.
- A variable borrow rate on an account they use daily.
- The Aave health factor and the card compete for the same collateral.
- The reserve rule from `docs/aqua-on-gnosis-pay.md` applies unchanged: shipped
  virtual balances summed across all strategies must stay at or below
  balance − card reserve.


## 5. Design C — flip who the maker is. Here Aqua is the primitive.

Undrawn credit is the most idle capital in finance. A lender committing €10m of
card credit has to park €10m, and on any given day almost none of it is drawn.
That is the Aqua whitepaper's thesis with the nouns changed.

So make **the lender** the Aqua maker:

- The lender keeps the €10m in their own wallet, earning, collateralised, voting,
  doing whatever else it does.
- They `ship()` a virtual balance **per borrower** to a `CreditApp`. One strategy
  hash per borrower is a per-borrower limit drawn from one shared balance, which
  is exactly what a credit book is.
- At authorization the CreditApp `pull()`s only what that transaction needs, to
  the settlement address.
- Repayments arrive as `push()`, which expands that borrower's line automatically.
- `dock()` is the lender cutting off one borrower instantly, without touching any
  other line and without moving money.

None of the §1 trap applies, because the maker is the lender: docking stops future
draws, it does not steal anything, and a sophisticated party running its own
treasury is the actor Aqua was designed for. This is also the only design here
where SLAC is an argument in favour rather than a hazard.

For 1inch specifically: the treasury, or a partnered market maker, can fund card
credit without a dedicated float, and a credit line becomes a strategy that
competes on terms like any other.


## 6. If the borrower's collateral must actually be security

Two options, and neither is Aqua:

- **An escrow contract.** Move the collateral somewhere the borrower cannot
  unilaterally empty. This is what Rain and ether.fi do. It works, it is
  understood, and Aqua contributes nothing to it.
- **A restricted Safe, Gnosis-Pay-shaped.** Renounce the Safe's ownership so it is
  module-only; a Roles module permits the borrower everything except reducing
  collateral below the required ratio; a Delay module means any withdrawal is
  visible for N minutes before it lands, so the lender can act first. This is the
  architecture read out of `gnosispay/account-kit` and written up in
  `docs/aqua-on-gnosis-pay.md`.

The second is the genuine non-custodial lien and it is the more interesting
answer, but it is not free: modules on the user's wallet are the surface that was
exploited in June 2026 for roughly $1.5m, through an ERC-1271 check that read the
returned magic value without checking the call had succeeded.


## 7. What to build, in order

1. **Design C first.** Aqua is load-bearing there, it needs no
   consumer-protection story, and it gives 1inch a concrete offer: fund card
   credit without parking the float.
2. **Design B second**, on Gnosis, because every piece is verified live on that
   one chain and ether.fi has already proved the shape works commercially.
3. **Design A only if labelled as a sale**, with the disposal consequence on the
   screen, not only in the terms.
4. **The restricted Safe** only when someone is prepared to own module risk.

**Unproven, and none of it is small:** no CreditApp exists, no lender has agreed
to be a maker, nothing has been run against Aave on Gnosis from a Safe, no card
programme accepts Aqua as a funding source (see §7 of the main proposal), and the
rate figures above are read from a web page rather than from the chain.
