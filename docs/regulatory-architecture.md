# Reducing regulatory exposure — concrete changes

Working document. Not legal advice; BaFin assesses substance over form, so these
are the facts a lawyer would weigh, not a conclusion. But they are the facts we
control, and changing them is cheaper before the conversation than after.

## The principle

Two questions decide whether we are a financial service or a software company:

1. **Can we dispose of client assets?** Not "do we", not "does policy allow it" —
   *can we*, technically, without the client.
2. **For each regulated leg, is there a named licensed party who contracts with
   the user and carries the obligation?**

Every comparable that operates unlicensed answers (1) with no and (2) with yes:

| Company | Licensed party named | Their own role |
|---|---|---|
| Rebind | Monerium (EMI), Gnosis Pay | *"solely a technical interface"* |
| Peanut | Bridge (Stripe) | frontend |
| MoneyGram wallet partners | MoneyGram (money transmitter) | wallet provider; assets *"not held by MoneyGram"* |
| **Zold** | Monerium, LHV Pank, MoneyGram | **currently fails (1)** |

---

## Change 1 — Remove unilateral disposal of client funds

**Today.** `transferTokenFromSafeAllowance()` (`wallet/candide.ts`) needs only
`CANDIDE_COSIGNER_KEY`. It reads the co-signer's standing allowance from Safe's
`AllowanceModule` and moves EURe out of the user's Safe. **No user signature is
involved on-chain.**

The user's device signature is checked by `assertDeviceAuthorization()` —
inside our own process. That is a policy control, not an architectural one. A
regulator reads the capability, and a compromised API bypasses the policy.

**Change.** Delete the allowance path. The user's passkey signs the ERC-4337
UserOperation that performs the movement. Nothing acts on the user's behalf, so
nothing needs an allowance.

**Removes:** `transferTokenFromSafeAllowance`, `CANDIDE_COSIGNER_*` allowance
config, the allowance module from the Safe deployment.

**Also fixes:** the security regression from the RemitVault removal. That check
moved from bytecode into our process and can be skipped by a compromised
server. If the user signs the execution, there is nothing to skip — the chain
enforces it. The regulatory fix and the security fix are one change.

## Change 2 — Shrink the custody window to the leg that cannot avoid it

An earlier draft said "remove custody". That was too broad, and the objection
is correct: once value is in flight across chains, something has to carry it.
CCTP burns on Base, waits on Circle's attestation, then mints on Stellar — that
is inherently asynchronous and cannot be one user-signed transaction. The user
has no Stellar account, and the anchor does not publish its payout account
until later in the flow.

So the question is not "custody or not" but **which legs need it**, and the
answer differs sharply by rail.

### SEPA rail — already almost clean, and worth defending

```
debitSafeFundedSepaFee()   // only the FEE moves to us
redeemToIban()             // the payout burns straight from the user's Safe
```

Per `DEBIT_STEP.safeFee`: *"only the fee moves, because the redeem burns the
payout straight from the Safe."* The user's own Safe is debited by a redeem
they authorised; we never hold the payout.

That is the interface story, already true, on the rail that actually works
today. Protect it — and take the fee as a separate transfer rather than routing
the payout through us for convenience.

### FX / cash rail — five windows today, all addressable

```
1  debitInputFunds        EURe  user's Safe → orchestratorAddress   ← avoidable
2  executeTransferLiquidity  swap, from our holdings, as principal  ← avoidable
3  usdc.approve(bridge) + bridge.lockForPayout, orchestratorWallet  ← avoidable
4  CCTP burn → attestation → mint to CctpForwarder                  ← in transit
5  STELLAR_TREASURY_SECRET holds the float and pays the anchor      ← ours today
```

**Windows 1–3 are avoidable.** One batched UserOperation from the user's Safe
can approve the venue, swap EURe→USDC, and send the output to the destination
the payout leg names — all on the app chain, all in one signature. We would
never hold the euros or the USDC.

**Window 4 is not really custody.** CCTP burns on one side and mints only to a
predetermined recipient — `mintRecipient` and `destinationCaller` are both the
forwarder. We submit the mint; we cannot redirect it.

**Window 5 is ours today, and does not have to be** — see below.

### Windows 4 and 5 — replace CCTP and the treasury with Bridge

MoneyGram's own bridging guidance names two partners, and describes them very
differently:

| Partner | MoneyGram's description |
|---|---|
| Allbridge Core | *"stablecoin-native bridging between EVM and non-EVM chains, including Stellar"* |
| **Bridge.xyz** | *"**licensed custodial wallet infrastructure** with programmable APIs"* |

Allbridge would replace CCTP and nothing else — the treasury stays ours.
**Bridge.xyz is recommended as licensed custody**, which is the part that
matters. If our USDC on Stellar sits in a Bridge-operated custodial wallet
under Bridge's licence, window 5 stops being ours.

**What that deletes:**

- `STELLAR_TREASURY_SECRET` — a hot key holding customer float
- `bridge/cctp.ts` — burn, attestation polling, `mint_and_forward` (~305 LOC)
- trustline management, base reserves, `anchorPayoutReadiness`
- the funded-treasury precondition that currently blocks the rail entirely

**What it does NOT delete.** MoneyGram's workflow is: bridge the USDC, *then*
use the SEP-24 API to initiate the cash-out. We still drive that. So these stay
with us regardless:

- SEP-10 auth, SEP-12 customer records, SEP-24 withdrawal (`stellar/anchor.ts`)
- Travel Rule originator data and per-user memo isolation — that obligation does
  not transfer to a custodian
- the MoneyGram partner agreement — we remain the partner

**The question this depends on, unanswered publicly.** MoneyGram's page does not
say who holds the Stellar account or how trustlines are arranged. So before
planning on it, ask Bridge directly:

> Does your custodial wallet hold the USDC on Stellar and execute the SEP-24
> payment on our instruction — or does it deliver into an account we control?

If the former, window 5 is gone and the cash rail becomes non-custodial for us.
If the latter, we have swapped CCTP for equivalent plumbing and kept the
treasury. That one answer decides whether Bridge is a convenience or the change
that makes this leg clean.

### The fallback if Bridge holds nothing for us

The payout leg is money remittance however it is built, so it needs a licence
regardless. Under MoneyGram's partner structure, holding value mid-flight is
*within* a licensed activity rather than an unlicensed side-effect.

So the position is defensible either way. Bridge makes it better; MoneyGram's
partner agreement makes it lawful. Do not treat Bridge as a substitute for the
agreement — it is a substitute for our hot key.

## Change 3 — Be the interface to the venue, not the counterparty

**Today.** We select the venue, quote the rate, execute the swap from our own
address, and deliver the other asset. That is exchange as a service.

**Change.** Build the calldata; the user's account executes it. Show the
venue's own quote and name the venue. We are then constructing a transaction,
which is software.

Rebind's wording is the model, and it is only available to us once Changes 1–2
land:

> "REBIND functions solely as a technical interface that allows Users to
> interact directly with blockchain networks and decentralized services."
> "REBIND does not provide custody, exchange, brokerage, or intermediation
> services."

## Change 4 — Keep the fee shape (do not regress)

Already correct, and worth protecting: `FX.FIXED_FEE_EUR` is a flat service
fee, `marginBps` is *measured* rather than charged, and
`LIQUIDITY_SURPLUS_POLICY` defaults to `user`.

A flat fee for building a transaction is software revenue. A spread on a
conversion is dealing. Do not move to a spread for margin reasons without
understanding what it changes about what we are.

## Change 5 — Name the licensed party, per leg, in the product

Not only in the terms — in the UI, at the moment each leg is used, with the
user accepting that party's terms.

| Leg | Licensed party | User must accept |
|---|---|---|
| Account, e-money, IBAN | Monerium (EMI, Iceland) | Monerium Personal ToS |
| SEPA payment rails | **AS LHV Pank** | LHV's terms — surfaced via Monerium |
| Identity verification | Sumsub | Sumsub notice |
| Settlement custody (cash rail) | **Bridge.xyz** — licensed custodial wallet | Bridge's terms, if user-facing |
| Cash payout | MoneyGram (money transmitter) | MoneyGram's terms |

`AS LHV Pank` is currently named nowhere in our product or docs. Monerium's
Personal ToS requires users to read and accept the payment partner's terms, so
this is an existing gap, not a new requirement.

## Change 6 — Keep the payout leg separable

**No architecture makes paying a third party in another country not-a-payment-
service.** That leg needs to sit under MoneyGram's licence, with us as partner,
or not exist.

So build so it can be switched off independently: the account, conversion and
self-withdrawal features ship on a clean interface story while the payout leg
waits on the partner agreement. Do not let one blocked leg gate the rest.

Note the asymmetry that helps us: **withdrawal to the user's own verified IBAN
is a first-party payment** and does not raise the third-party question at all.
Verification of Payee — mandatory across the eurozone since 9 Oct 2025 — is the
control that keeps it first-party. Nominated IBANs must be VoP-checked, and a
`no match` must refuse.

## Change 7 — Screen for prohibited sectors

The whitelabel compliance docs require rejecting customers in listed sectors.
`senderProfile.occupation` exists but is free text and screened against
nothing. Free text is worse than nothing here, because it looks like we asked.

Needs a structured sector field at onboarding, refused in the shape of
`country-policy.ts`.

---

## What none of this fixes

- Paying third parties abroad needs someone's licence. Bridge holding the asset
  does not change that — it changes who is the custodian, not who is the
  transmitter. The MoneyGram partner agreement is still the thing that makes
  the leg lawful.
- Travel Rule originator data stays our obligation. A custodian does not absorb
  it, so `stellar/sep9.ts`, the SEP-12 memo isolation and the sender profile all
  remain load-bearing.
- Being a distributor of Monerium needs their explicit approval; per-user IBAN
  provisioning via API is distribution, whatever the standard terms say.
- Monerium's API terms cap their liability to us at **ISK 1,000** (~€7), require
  us to indemnify them, and let them terminate "in our sole discretion at any
  time, for any reason." Adding Bridge adds a second dependency with its own
  version of that clause. Business-continuity risk to disclose, not an
  architectural one to solve.

## Dependency map after the change

```
EUR in         Monerium (EMI) ──► LHV Pank (SEPA rails)
identity       Sumsub ──► shared to Monerium; SEP-9 subset to MoneyGram
conversion     liquidity venue, user-signed          [or Monerium's own swapper]
settlement     Bridge.xyz — licensed custodial wallet on Stellar
cash out       MoneyGram — money transmitter, SEP-24 driven by us
```

Five licensed counterparties, none of them us. That is the shape the terms
should describe, and — subject to the Bridge question above — it is reachable.

## Sequencing

0. **Ask Bridge the custody question** (one email, already on the call list).
   It decides whether windows 4–5 disappear or merely change plumbing, so it
   should be answered before anyone plans that work.
1. **Change 1, and Change 2 windows 1–3** — the parts that decide the
   characterisation on the unlicensed legs, and the same work that closes the
   FP4 security gap. Independent of the Bridge answer; start here regardless.
2. **Change 5** — naming parties; days, mostly copy and one consent screen.
3. **Change 7** — sector screening; a template already exists.
4. **Change 3** — follows once 1–2 land.
5. **Change 6** — a build-order rule rather than a task.

Then the terms can say what we are, accurately, and the lawyer is reviewing a
description of reality rather than an intention.
