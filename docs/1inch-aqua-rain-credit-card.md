# A 1inch credit card on Aqua, issued through Rain real-time funding

Companion to `docs/1inch-aqua-card.md`, `docs/aqua-credit-module.md` and
`docs/1inch-aqua-incubator-application.md`. Sep 2026. Status: **architecture
draft. Nothing built.** Read `aqua-credit-module.md` §1 first: Aqua cannot hold a
lien, and everything here is arranged around that.

**Short answer.** Rain's real-time funding (RTF) does not make Rain pull from
Aqua. Rain now pulls from an ERC-20 allowance at authorisation, on Rain's rails
with Rain as issuer, and that is the only safe tier for an Aqua card
(`1inch-aqua-card.md` §5, "dock() forces Tier A"). So the credit design that
works on Aqua, where **the lender is the maker** (`aqua-credit-module.md` §5,
Design C), can sit one layer behind the wallet Rain pulls from, with no change on
Rain's side. The cost is a small per-card buffer. One small ask of Rain removes
the buffer (§6).


## 1. What Rain's real-time funding changed, and what it did not

From Rain's announcement (read 23 Sep 2026, rain.xyz/resources/introducing-real-time-funding):

- The user connects a wallet and **approves how much the card can spend**.
- At authorisation, **only the transaction amount is committed** to the user's
  per-user collateral contract, where it stays until it is "liquidated to repay
  Rain's extension of credit to the user". The rest stays in the wallet.
- The approval is revocable at any time.
- "The underlying collateral model does not change." Each user still has their
  own collateral contract; RTF only moves when it gets funded.
- **Beta, only for programmes where Rain manages authorisation.** Assets at
  launch: **USDC on Base**, USDC on Arbitrum, USDT0 on Plasma.

What this changes for the Aqua card:

| before RTF | with RTF |
|---|---|
| Rain-Managed meant prefunding `RainCollateral`; the user's float was their whole card balance | Rain pulls per transaction at auth. Tier A (reserve at authorisation), with Rain as the party doing it |
| Aqua could only enter through Partner-Managed (we hold the reserve, we answer a webhook with an unpublished timeout) | Aqua can enter through Rain-Managed. **We never sit in the authorisation path** and no timeout decides our architecture |

What it does **not** change:

- **Rain's pull is `USDC.transferFrom(wallet, collateral, amount)`**, as far as
  anyone outside Rain can tell (approval + commit-at-auth). A wallet cannot
  intercept a USDC `transferFrom` and forward it to `AQUA.pull()`. So Rain does
  not call Aqua, and nothing we deploy can make it. Aqua has to sit **behind**
  the funded address, not in place of it.
- Rain still has **no EEA issuer** (see incubator doc §4 table). A card built this
  way is for Rain's regions (North America, LAC, APAC, CEMEA), not for an
  EEA/German cardholder. The design below does not depend on Rain (§8), so the
  EEA version reuses it with a different issuer.
- Rain-Managed still means Rain's contracts and Rain's signing keys. They
  hot-patched a signature-reuse exploit on Solana on 28 Aug 2026 (~$1.1m across
  three programmes). RTF shrinks what sits in their contract to one
  transaction's amount per user. That helps the cardholder and makes no
  difference to the lender.

Chain choice follows: **Base.** RTF supports USDC there, Aqua
`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` is deployed there (VERIFIED,
incubator doc §7), Candide's public bundler serves 8453, and Zold's mainnet
defaults already point at Base.


## 2. The design in one picture

```
   LENDER (maker)                      1inch treasury / market maker / credit fund
   one USDC balance, own wallet        approve(AQUA, cap)   ship() one strategy per borrower
        │
        │  AQUA.pull(lender, hash(borrower), USDC, amt, cardAccount)   ← only on refill
        ▼
   ┌──────────────┐    refill / sweep / repay     ┌──────────────────────┐
   │  CreditApp   │ ◄──────────────────────────── │  Keeper (Zold API)   │
   │ (Aqua app)   │                               │  watches Rain webhooks│
   └──────┬───────┘                               │  + CardAccount events │
          │ tops up to buffer B                   └──────────────────────┘
          ▼
   ┌──────────────────┐   USDC.approve(RainSpender, B)   ← the RTF approval
   │  CardAccount     │ ─────────────────────────────────┐
   │  (per borrower)  │                                  │
   │  holds ≤ B USDC  │                                  ▼
   └──────────────────┘              Rain RTF: transferFrom(cardAccount, collateral, amt)
          ▲                                  at AUTHORISATION
          │ repay (user USDC)                        │
          │                                          ▼
   BORROWER (cardholder)             RainCollateral (per user) ──► liquidated to Visa at settlement
   passkey Safe; owns the card,
   NOT the buffer
```

Three things carry the weight:

1. **The lender is the Aqua maker, not the cardholder.** `dock()` is then the
   lender cutting off one borrower, which is exactly what a lender needs.
   The cardholder cannot revoke anything that protects the lender, so the
   `dock()`-before-clearing race in `1inch-aqua-card.md` §5 does not exist in
   this design.
2. **Rain never touches Aqua.** It sees an ordinary wallet with an ordinary USDC
   approval. Everything Aqua-shaped is our contract and the lender's wallet.
3. **The buffer is the only idle lender money.** A €5,000 line keeps about €500
   in the CardAccount. The other €4,500 stays in the lender's wallet, where
   the same balance backs every other borrower's line. That is Aqua's
   shared-liquidity (SLAC) thesis applied to a credit book, where
   over-provisioning is normal practice rather than a risk.


## 3. Components

### 3.1 `CardAccount`, one per borrower (the address Rain's RTF approval sits on)

A minimal non-upgradeable contract. **It is not the borrower's Safe.** If the
buffer sat in the user's Safe, the user could withdraw the lender's money, and
the line would be unsecured before the first swipe.

- Holds USDC from two sources, and keeps an internal ledger of each:
  `equity` (the user's own deposits) and `lenderFloat` (pulled from Aqua).
- **Only three ways out:**
  1. Rain's `transferFrom` via the RTF approval. This is spend.
  2. `CreditApp.sweep()`, which moves `lenderFloat` back to the lender through
     `AQUA.push`. It runs on dock, on close, and when the buffer is too large.
  3. `withdrawEquity(amount)` by the borrower's Safe, capped at `equity`.
- Spend draws `equity` first and `lenderFloat` second. This gives debit and
  credit on one card, which is ether.fi's Direct Pay beside Borrow Mode. The
  split is computed from the balance delta, because Rain's `transferFrom`
  never calls us.
- The RTF approval to Rain's spender is set **by the contract**, not by the user,
  and is kept at or below the current balance. The borrower can close the card
  (revoke + sweep), but cannot raise the approval above what the account holds.

Open question to Rain, and the first one to ask: **does RTF accept a contract
as the funding wallet?** Crossmint's Rain integration uses smart-contract
wallets with Rain-managed collateral on Base Sepolia, which suggests yes for
funding. Nothing public says so for the RTF approval specifically.

### 3.2 `CreditApp`, the Aqua app (the lender's contract)

The strategy is the credit agreement, and its bytes are immutable once shipped:

```solidity
struct CreditTerms {
    address borrower;        // the borrower's Safe (identity, repayments)
    address cardAccount;     // where refills go; nowhere else
    uint256 limit;           // credit line, USDC 6dp (also the shipped virtual balance)
    uint256 bufferTarget;    // B, §5
    uint32  aprBps;          // simple interest on outstanding, accrued per second
    uint32  graceDays;       // interest-free from statement date
    uint32  minPaymentBps;   // of statement balance
    uint64  expiry;          // strategy stops refilling after this
    bytes32 underwritingRef; // off-chain decision record, not PII
}
// strategyHash = keccak256(abi.encode(terms)). One hash per borrower per terms version.
```

Functions (all bounded; none can move money anywhere except the named places):

| fn | who | effect |
|---|---|---|
| `refill(terms)` | keeper (anyone, really; it can only move lender money into that borrower's CardAccount) | `AQUA.pull(lender, hash, USDC, bufferTarget − lenderFloat, cardAccount)`. Refuses past `expiry`, past `limit − outstanding`, or on a docked strategy (Aqua reverts anyway) |
| `repay(terms, amount)` | borrower or anyone | takes USDC, reduces `outstanding`, `AQUA.push(lender, app, hash, USDC, amount)`. The line grows back by what was repaid |
| `sweep(terms)` | keeper / lender / on close | returns unspent `lenderFloat` to the lender via `push` |
| `accrue(terms)` | view + checkpoint | interest on `outstanding = pulled − returned − repaid` |

Invariant, and a test must check it after every operation:
`outstanding + lenderFloat(cardAccount) == Σpulled − Σpushed`. This means the
lender's exposure is the money that went through Rain and was not repaid. The
float is still recoverable.

### 3.3 Keeper, which lives in the Zold API

- Subscribes to Rain's transaction webhooks (authorisation, reversal,
  settlement) and to `Transfer(cardAccount → *)` on Base.
- After every spend: `refill()`. Latency is one Base block (~2 s) plus bundler
  inclusion, **after** the authorisation, never inside it.
- On reversal or refund: Rain returns funds (destination to be confirmed with
  Rain, most likely the funding wallet, i.e. the CardAccount). The keeper
  treats the inbound as `lenderFloat` first. Nothing is repaid twice.
- Statement job: monthly `accrue`, minimum-payment check, and delinquency
  → the lender or its servicer decides `dock()`.
- Gas: sponsored through Candide's paymaster, like every other Zold userOp.
  The keeper holds no user funds and no lender keys. It can only call
  functions whose destinations are fixed by the strategy bytes.

### 3.4 Lender

The lender is a wallet that holds USDC, sets `approve(AQUA, totalCap)` and
`ship()`s one strategy per approved borrower. Candidates in order of realism:
Zoldenburg's own treasury for a capped pilot, a credit fund or market maker
that 1inch introduces, and the 1inch DAO treasury, which would be a
governance proposal of its own. The lender's USDC can still do other things
while undrawn (another Aqua strategy, for instance), within the lender's own
reserve rule: shipped balances across all strategies must stay at or below the
wallet balance minus a liquidity reserve. That is **the lender's** risk
decision, not the cardholder's.

### 3.5 Security, if the line is secured (optional, and NOT Aqua)

Secured credit needs collateral the borrower cannot move. Aqua cannot provide
that (`aqua-credit-module.md` §1). v1 choices:

- **Unsecured, small lines, underwritten off-chain.** This is the plain
  credit-card shape. The lender's loss is capped at `limit` per borrower.
- **Secured by an escrow** `CollateralVault` (cbBTC / wstETH on Base) with an
  LTV that sets `limit`, an oracle, and **liquidation through 1inch
  aggregation/Fusion**. That is where 1inch's router earns a place in the card
  beyond branding. It works like Rain's and ether.fi's escrows and inherits
  their risks: liquidation at the till, oracle dependency.
- Not the restricted-Safe lien from `aqua-credit-module.md` §6. It needs module
  risk nobody has signed up for.


## 4. The flows

**Onboarding.** Rain KYC → Rain card issued → Zold deploys the borrower's passkey
Safe (existing path) and a `CardAccount` bound to it → CardAccount approves
Rain's RTF spender → the lender underwrites and `ship()`s `CreditTerms` →
keeper `refill()`s to B. Spendable immediately; the user deposited nothing.

**Authorisation (Rain-managed, we are not in the path).** The terminal sends
$120 → Rain checks the CardAccount's allowance and balance → Rain `transferFrom`s
120 USDC into the user's RainCollateral → approve. CardAccount's `equity` is
drawn first, then `lenderFloat`.

**Refill (after the auth).** Keeper sees the Transfer → `refill()` →
`AQUA.pull` 120 USDC from the lender's wallet into the CardAccount → back to B.
If the refill fails (lender docked, lender wallet short, limit reached), the
next authorisation that exceeds the remaining buffer is declined by Rain for
insufficient funds. A failed refill therefore produces a decline, never an
unfunded purchase, because Rain has already committed the money for every
approved auth.

**Settlement.** Rain liquidates the RainCollateral to Visa. Nothing for us to
do. The lender's exposure started at the auth pull, not here.

**Reversal / refund.** The money comes back to the CardAccount → counted as
float → the next refill is smaller. If the card is closed, `sweep` returns it to
the lender.

**Repayment.** The borrower pays USDC (or EURe → USDC through the §2 settlement
strategy, or a Monerium SEPA deposit converted) into `CreditApp.repay` →
`AQUA.push` → the lender's virtual balance for that borrower grows back.
Autopay is a user-signed Safe batch on the statement date. Nobody else can
sign it.

**Cut-off.** The lender calls `dock(app, hash, [USDC])` → no further refills;
the keeper `sweep`s the float back. The card can still spend the borrower's own
`equity`. A cut-off leaves a debit card, not a dead card.

**Default.** Outstanding balance past N days → the lender (or a servicer) handles
collections off-chain. If the line was secured (§3.5), the vault liquidates
through 1inch. Aqua has no role here, and it should not appear to have one.


## 5. Buffer sizing, and what the buffer costs

The buffer has to cover every authorisation Rain can approve before the next
refill lands:

```
B ≥ perTxCap × k
  perTxCap  — per-transaction limit set on the Rain card (Rain supports limits)
  k         — authorisations that can arrive inside one refill latency (~2–6 s)
```

With `perTxCap = $500` and `k = 2`, B = $1,000. Larger purchases need either a
higher cap (bigger buffer) or an **on-demand top-up**: the app raises B for one
purchase before the user taps, which is how people already use virtual cards.

Lender float, the number that makes the pitch:

| | conventional credit book | this design |
|---|---|---|
| 1,000 cards × $5,000 lines | lender reserves against $5m committed | lender reserves B × *active* cards ≈ $1m worst case, less since B only needs to exist while a card is active |
| undrawn money | held idle at a bank or programme | stays in the lender's wallet, available to other strategies |
| per-borrower cut-off | processor config | `dock()`, on-chain, instant, one line only |

Be clear about the limit: **the buffer is idle lender money that sits
in someone else's contract.** It is 10–20% of the line, not 100%, but it is not
zero. §6 is how it gets to zero.


## 6. The one ask of Rain that removes the buffer

RTF already commits funds at auth by calling something on the funding side. If
Rain would, for an allow-listed funding contract, call

```solidity
interface IRtfSource { function fund(address token, uint256 amount, address to, bytes32 authId) external; }
```

instead of `transferFrom`, then `CardAccount.fund` calls `CreditApp.draw` →
`AQUA.pull(lender, hash, USDC, amount, rainCollateral)` in the same
transaction. The buffer disappears and the lender's float for this card is zero
until the swipe. This is the true Aqua card: pull at authorisation, straight
from the lender's wallet into the issuer's collateral.

The ask is small. It is one interface, and the atomicity is theirs: if `fund`
reverts, they decline. It is also Rain's call, and after the Aug 2026 exploit
their appetite for new call paths will be low. **v1 does not depend on it.**
Put it on the table as v2, with a running v1 behind it.


## 7. Properties, each of which gets a test

1. Lender money can only ever reach: that borrower's CardAccount, Rain's
   collateral (via the RTF approval), or back to the lender. No keeper, no Zold
   key and no borrower action can route it anywhere else.
2. The borrower can withdraw `equity` and never `lenderFloat`.
3. RTF approval ≤ CardAccount balance at all times.
4. `outstanding + lenderFloat == Σpulled − Σpushed` (the §3.2 invariant).
5. A docked strategy refills nothing. `sweep` still works after `dock`. (Check:
   Aqua's `push()` requires an ACTIVE strategy (`1inch-aqua-card.md` §5), so
   **sweep and repay must run before `dock`, or return funds by plain transfer
   to the lender with our own ledger entry.** This decides the dock procedure:
   the lender first sets the app to "closing", then sweep, then dock. Repayments
   after dock go by direct transfer.)
6. A failed refill produces a Rain decline, never a Rain approval backed by
   nothing (property of RTF; verify in Rain's sandbox with an empty CardAccount).
7. Terms cannot change under a live line: a new `CreditTerms` means a new hash
   and a new ship. The old line is swept and docked.


## 8. Issuer-agnostic, on purpose

The only thing Rain contributes to the contracts is a spender address and the
fact that it pulls at authorisation. The same `CardAccount` + `CreditApp` works
unchanged behind any issuer that pulls from an allowance at auth:

| issuer | pull | region | status for us |
|---|---|---|---|
| **Rain RTF** | USDC allowance, commit at auth | NA / LAC / APAC / CEMEA | **v1 target.** Beta, Rain-managed programmes, Base USDC |
| Baanx (Exodus), MetaMask Card rail | EURe/GBPe allowance on Linea | EEA + UK (US/UK sign-ups paused Jun 2026) | the EEA path, and **1inch Card's current vendor**; same contracts on Linea (Aqua + EURe verified there), paid bundler needed |
| Immersve, APPROVAL mode | `safeTransferFrom` by their settler | no EEA issuer today | technically identical |
| Bridge card factory | custom implementation per issuer | Luxembourg EMI, EEA cards "2026" | the §6 shape without asking: our implementation *is* the pull |

This matters because **1inch Card today is Baanx, custodial**. Moving it to Rain
is 1inch's commercial decision and costs them the EEA. The pitch should be "these
two contracts give you a credit card funded from a lender's wallet on whichever
rail you keep". Rain RTF is the rail where it runs first because it needs nobody
to change anything.


## 9. Who carries what

| | Rain | Zold / programme | Lender |
|---|---|---|---|
| card issuing, BIN, Visa, scheme rules | ✓ | | |
| cardholder KYC | ✓ (Rain-managed) | | |
| authorisation decision | ✓ (balance + allowance) | | |
| disputes / chargebacks | ✓ with the programme | programme-manager duties | |
| CardAccount, CreditApp, keeper | | ✓ | |
| underwriting, limits, APR | | | ✓ |
| credit losses | | | ✓ |
| collections | | servicer, if contracted | ✓ |
| **credit licence** | | | ✓ **the gate** |

**The credit licence is the gate, and Aqua does not change it.** A lender
extending revolving consumer credit needs to be licensed where the borrower is
(US: state lending licences or a bank-partner origination; other regions
likewise). Rain's own "extension of credit" is fully collateralised by the
committed funds; ours is actual credit. The unsecured variant is consumer
lending, and the secured variant is still lending. Scope v1 to business cards or
to a jurisdiction where the lender already holds a licence.

**Aqua licence.** `LicenseRef-Degensoft-Aqua-Source-1.1` §5.2 "Pure Caller Use"
is free below USD 100k fees/yr **and USD 10m liquidity under control**. A credit
book of shipped lines passes $10m quickly: 2,000 cards × $5,000. Past that
point it needs a licence from Degensoft or the incubator exemption. Raise it with
1inch at the start. It is also a reason for 1inch to want the programme, not
merely allow it.


## 10. Execution plan

**Phase 0: answers, not code (1–2 weeks, all external).**
Ask Rain: (a) can an RTF funding wallet be a contract, and which spender
address does it approve; (b) is RTF in the sandbox (Base Sepolia, RUSD
`0x10b5Be49…` per Crossmint's Rain guide); (c) where reversals and refunds land;
(d) webhook events and their latency; (e) per-transaction limits on a card;
(f) appetite for §6. Ask 1inch: whether Rain is a rail they would run the card
on, and the Aqua licence position for a credit book. Line up one lender for a
pilot, most likely our own treasury, capped.

**Phase 1: contracts on a Base mainnet fork (2–3 weeks).**
`contracts/src/aqua/{CardAccount,CreditApp}.sol` in this repo's hardhat setup,
tests against the real Aqua bytecode on a Base fork (Aqua is not on Base Sepolia).
A `MockRainSpender` does `transferFrom` at "auth" exactly as §1 describes. Covers
every §7 property plus the dock/sweep ordering. `npm run aquacredit:test`.

**Phase 2: Rain sandbox, end to end (2 weeks, gated on Phase 0 (b)).**
On Base Sepolia there is no Aqua. Deploy a same-interface test registry
(clearly named, never shipped), or if Rain's sandbox runs elsewhere, follow it.
A real Rain sandbox card, a real RTF auth, keeper refill from the webhook, a
reversal, a repayment, and a dock. Keeper lives in `services/api/src/card/`, with
the same sweep pattern as the existing recovery and payment-request sweeps.

**Phase 3: mainnet pilot (after licence scoping).**
Base mainnet, real Aqua, our own treasury as lender, 10–20 cards, lines ≤ $500,
business cardholders. Success criteria: zero Rain approvals without backing
funds, refill p99 under one block after the webhook, sweep leaves no lender
float after close.

**Phase 4: the ask.** Bring Phase 3's numbers to Rain for §6 (the zero-buffer
pull) and to 1inch/Exodus for the Linea/EURe version (§8). The contracts stay
the same, only the spender changes.


## 11. Not known, and who answers it

- Whether RTF accepts a contract as the funding wallet, and the spender address
  (Rain).
- Whether RTF is available in Rain's sandbox (Rain).
- Where RTF reversals and refunds are returned (Rain).
- Whether 1inch would run the 1inch Card on Rain, and the Aqua licence for a
  credit book above $10m (1inch / Degensoft).
- Which lender, under which licence, in which jurisdiction (us + counsel).
- Rain's docs are behind a login (docs.rain.xyz redirects to /login). Everything
  here about RTF comes from the public announcement. Nothing from their API
  reference has been read.
- Nothing has run. No CardAccount, no CreditApp, no strategy shipped, no Rain
  sandbox account.
