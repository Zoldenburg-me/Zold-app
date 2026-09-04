# Nigeria rail — who to talk to, and why not cNGN

Researched Sep 2026. Supersedes the merchant-account framing in the first draft
of `docs/cngn-partner-questions.md`.

## The correction that reframed this

We were asking the wrong company. **cNGN is the token issuer, not the rail.**
Their own site says so, in the footer disclaimer, verbatim:

> "WrappedCBDC is only a stablecoin provider. You are solely responsible for
> services you provide to users, including obtaining any necessary licenses or
> approvals and otherwise complying with applicable laws."

So there is nothing to negotiate with them, and no merchant account to seek.
The standing-access, virtual-account, offramp-to-a-NUBAN capability we want is
sold by the infrastructure partners listed on their own `/get-cngn` page.

It also answers the licensing question flatly and in our disfavour: the
obligation sits with us, and they have said so in writing. Same answer as MiCA,
same answer as the payout partners — a partner's licence covers their
execution, never our solicitation of the customer.

Also corrected: cNGN operates under the **SEC Nigeria Regulatory Incubation
Programme** — a provisional, sandbox-style regime — not full authorisation. The
issuer is **WrappedCBDC Limited**, reserves are held in approved Nigerian
commercial banks, and audited reserve reports are published.

## The three candidates

### STRAILS — the front runner
`docs.strails.co`. "Stablecoin Orchestration and Orderbook Engine for cNGN,
USDC and USDT."

Everything we need is documented:

 - **Virtual accounts**: "Issue Nigerian bank accounts that auto-convert NGN
   deposits into cNGN."
 - **Payouts**: "Register, verify, and manage Nigerian bank accounts used for
   offramp settlement."
 - **HMAC-SHA256 webhook signatures, with timestamps and timing-safe
   comparison.** This is the single thing cNGN could not give us, and it is the
   reason a handler can ship at all — ours fails closed on unsigned callbacks.
 - **X25519 + libsodium sealed-box** payload encryption, IP allowlisting, MPC
   vaults.
 - Base, Ethereum, BNB, Solana, Bantu. Base is our app chain.
 - A **mock sandbox** to build against without moving money.
 - Two documented integration paths: **Fintech Partner** and **Direct User**.

STANDING ACCESS IS THE POINT. API keys plus real-time webhooks means we can
observe a settlement that lands hours later, while nobody is looking at the
screen. That is the property that makes the Monerium adapter work and the
Gnosis Pay one only a viewer — see the rule in CLAUDE.md.

ANSWERED FROM THE DOCS — offramp needs THEIR wallet. Both `/cngnofframp` and
`/initiateofframp` draw on a Strails-deployed Smart Wallet, and the fintech
response reports `walletSource: "system_wallet"`. There is no call that
offramps from an arbitrary source address.

The onramp params offer a custom owner EOA, but it is mutually exclusive with
the exit: "Strails cannot withdraw funds from wallets with a custom owner." You
get their custody and the offramp, or your control and no offramp.

SECOND, ARCHITECTURAL, AND SPECIFIC TO US: their Smart Wallet is an EIP-1167
minimal proxy with an owner EOA calling `execute()`, and they state plainly that
they do not use UserOperations, paymasters or the ERC-4337 EntryPoint, with the
owner paying gas in the native token. Zold accounts are ERC-4337 passkey Safes
with NO EOA and NO private key — that is the whole of FP4. So a Zold account
cannot own a Strails wallet in the way their flow assumes.

THE SHAPE THAT DOES WORK, and it is already precedented here: user's Safe signs
a cNGN transfer into a Strails wallet, Strails settles naira. That is a
deposit-address flow, the same shape the cash rail uses with Bridge — where
CLAUDE.md already records that once the funds land they are with the settlement
custodian. Buildable and honest, but it IS a custody hop and `transfer.custody`
would need a value for "delivered to an external settlement custodian" rather
than being squeezed into `orchestrator`.

AVOID THE FX PATH unless it is needed: their orderbook requires registering an
MPC Vault and handing Strails both `mpcVaultApiKey` and
`mpcClientSignerPrivateKey` — an OpenSSH private key — under a disclaimer that
"Strails assumes no liability for losses arising from the use of MPC Vault
services". Plain offramp does not require it.

WHAT IS STILL NOT DISCLOSED: no operating entity, no jurisdiction, no licence,
and nothing about whether a foreign company can onboard.

### Flint API
`flintapi.io`, reference at `stables.flintapi.io` (titled "Stablestack API
Reference"). Advertises the same shape — stablecoin wallet and bridge, virtual
accounts, on/offramp, liquidity rails. **Could not verify anything**: the
marketing page carries no detail and the reference is client-rendered. Worth a
second look as an alternative, not evaluated.

### Bread
`bread.africa`. Advertises "bridge for crypto to fiat, connecting multi chain to
every bank account, has API".

**Their TLS certificate does not match their domain** — it serves a wildcard for
`*.up.railway.app`. For a company proposing to move other people's money that is
a poor signal, and any browser will warn on it. Not pursued.

---

## The email — to STRAILS

> **Subject:** Non-custodial offramp for Nigerian users — integration and entity questions
>
> Hello,
>
> We're Zold, a self-custodial account app built by Zoldenburg UG, a German
> company. Our users hold their own assets in their own smart accounts — we take
> no custody and can move nothing on our own. We want to give Nigerian users a
> naira exit for stablecoin income, and your API looks like the closest fit
> we've found.
>
> We've done the groundwork: our users' accounts are Safes on Base, we already
> execute user-signed swaps through an aggregator, and we've verified cNGN
> liquidity on Base directly — around 0.46% slippage on $1,000, inside 1% of the
> reference mid. What we don't have is the fiat leg, which is where you come in.
>
> Five questions. The first two decide whether we can build at all.
>
> **1. Confirming the offramp source.** Reading your API reference, both
> `/cngnofframp` and `/initiateofframp` draw on a Strails-deployed Smart Wallet
> — the fintech response even reports `walletSource: "system_wallet"` — and the
> onramp docs note that Strails cannot withdraw from a wallet with a custom
> owner. So our reading is that you cannot offramp directly from an address we
> control, and that the workable shape is: our user signs a cNGN transfer out of
> their own account into a Strails wallet, and you settle naira from there. Is
> that right?
>
> If so, two things we need to be precise about, because we tell our users we
> are non-custodial and we will not weaken that quietly: **whose funds are they
> between the deposit landing and the naira settling, and roughly how long is
> that window?** We would record and display it as a custody hop either way; we
> just need to describe it accurately.
>
> **1b. A compatibility note.** Our user accounts are ERC-4337 smart accounts
> owned by a passkey — there is no EOA and no private key anywhere in the
> design. Your Smart Wallet uses an owner EOA calling `execute()` and explicitly
> avoids UserOperations, bundlers and the EntryPoint, so our account cannot be
> the owner of one of your wallets. That pushes us to the deposit-then-offramp
> flow above. Is there anything else on your roadmap for accounts that cannot
> produce an EOA signature?
>
> **2. Can a foreign company integrate?** We're incorporated in Germany with no
> Nigerian entity. Is that workable, and what does onboarding involve? We'd
> rather hear a firm no now than design around a maybe.
>
> **3. Fintech Partner or Direct User — which fits us, and who owns KYC?** We
> serve individual users and businesses directly. In each model, who holds the
> customer relationship, who performs KYC on the end user, and who is the
> regulated party for that user's transaction? Related: cNGN's own site states
> that licensing obligations sit with the integrator, so we'd like to be precise
> about which of those obligations you carry and which land on us.
>
> **4. Your entity and regulatory status.** Your docs don't name the operating
> company or its licences. Who are we contracting with, where are they
> incorporated, and what authorisation do they hold in Nigeria — SEC digital
> asset registration, CBN, or otherwise?
>
> **5. Limits, fees and settlement time.** Per-transaction and daily ceilings on
> offramp, your fee and FX treatment, and realistic NIP settlement times.
>
> On the technical side your docs already answer what we needed — HMAC-SHA256
> webhook signatures with timestamps, the sealed-box payload encryption, and the
> mock sandbox. We fail closed on unsigned callbacks, so having a documented
> scheme is why we're writing to you rather than someone else.
>
> Happy to share our integration notes.
>
> Thanks,
> Tony Thomas — Zoldenburg UG

---

## What each answer changes

| Q | If yes | If no |
|---|---|---|
| 1 | Offramp from the user's own Safe — the non-custodial model survives intact and this is the build | Their wallet holds the balance; that is custody by someone, and the UI must say whose. Possibly a dealbreaker |
| 2 | Proceed | Nigeria stays `BLOCKED_UNSUPPORTED`, same wall as Xflow |
| 3 | Tells us whether we run KYC or they do | — |
| 4 | Tells us whose licence covers the fiat leg | An unlicensed counterparty for a money rail is not one to build on |
| 5 | Sizes the corridor | Cannot price it |

## Standing TODOs if we build

- `verifyStrailsSignature()` — HMAC-SHA256 over the documented payload with a
  timestamp window and timing-safe comparison. Documented, so implementable;
  still fails closed until a secret is configured.
- Sealed-box payload encryption (X25519 / libsodium) — a dependency decision,
  since this repo has four runtime dependencies and none of them is libsodium.
- Whether the user's passkey Safe can be the offramp source is question 1 and
  determines the whole shape.
