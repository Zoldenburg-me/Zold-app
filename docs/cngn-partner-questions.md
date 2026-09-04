# cNGN — outreach to Wrapped CBDC / Africa Stablecoin Consortium

Drafted Sep 2026. Not sent.

## The shape, corrected

The first draft of this asked to become a cNGN **merchant** with our users as
sub-accounts — the Xflow platform shape, carried over by reflex. That was wrong
for this product and it was caught in review.

**Our users hold their own cNGN and their own relationship with the issuer.**
That is the pattern already built twice here — Monerium by OAuth, Gnosis Pay by
SIWE — and it is better on every axis that matters: no KYB on Zoldenburg UG, no
Nigerian entity, no custody of anyone's naira, and the MiCA exchange question
stays narrow because the user signs their own swap in their own Safe.

**Most of the product needs nothing from them.** cNGN is an ERC-20 on Base. We
already read token balances from chain, and the USDC→cNGN swap is user-signed
through the existing liquidity seam. Holding, displaying and swapping require no
agreement, no keys and no conversation.

Only the **redemption leg** — cNGN burned, naira delivered to a NUBAN — involves
the issuer, and if the customer owns that relationship it is not ours to hold.

## What we need, and why session-bound access will not do

We need **standing delegated access** — the Monerium shape, not the Gnosis Pay
shape. That is a structural requirement, not a preference:

| | session-bound (SIWE/JWT) | standing (OAuth/scoped key) |
|---|---|---|
| access lasts | while the user watches | until revoked |
| act while user is away | no | yes |
| can reconcile a late settlement | **no** | yes |

A card balance is a snapshot, so session-bound access suits it — which is why
the Gnosis Pay adapter holds its JWT in browser memory and never persists it.
**A redemption is not a snapshot.** cNGN burns, NIP settles minutes to hours
later, and the naira lands when nobody is looking at the screen. A session-bound
integration can never observe that leg, webhooks would arrive to a session that
no longer exists, and the ledger could not close without the user present.

Nothing in their public docs offers an authorization-code flow. Everything is
merchant-shaped: keys from a merchant dashboard, three of them (`apiKey`,
`privateKey`, `encryptionKey`), AES-encrypted requests, Ed25519 responses.

So there are three possible worlds, best to worst:

1. **OAuth exists or is planned.** Build it exactly like the Monerium adapter —
   authorization code + PKCE, per-user tokens encrypted at rest, server-side
   refresh. Best case and what we should ask for.
2. **The USER holds their own merchant account and issues US scoped keys.**
   Their KYB, their funds, their bank account; we hold revocable credentials and
   act asynchronously. Substantively the Monerium model with a weaker grant.
   `crypto-at-rest.ts` already has purpose-separated keys, so a `cngn` purpose
   sits beside `monerium` with no new scheme to review. Their docs reference a
   "Redeem permission", so scoping exists — which is what makes this defensible.
3. **Nothing.** Hand-off: we hold, swap and keep books; the user leaves to
   redeem and the UI states plainly that we cannot see that leg.

WHERE (2) IS GENUINELY WORSE THAN (1), and it should not be glossed: asking a
user to paste three secrets, one of them named `privateKey`, is a far larger ask
than an OAuth consent screen and a far larger liability if we are ever breached.
An OAuth grant is scoped and revocable by design; a pasted key set is scoped only
as well as their permission model allows and revoked only if the user remembers
to go and delete it. There is also no refresh and no expiry — a long-lived
secret in our store fails worse than a token that dies on its own.

## Verified before writing

Facts checked this session, so the note is not tyre-kicking:

- **Contracts read on chain**, not off a listing: `name()`/`symbol()`/`decimals()`
  on Base, BNB, Ethereum, Polygon. Six decimals everywhere.
- **Supply is on Base (~2.58bn) and BNB (~699m).** Ethereum (~137k) and Polygon
  (~12.6k) are rounding error.
- **Liquidity is real.** Live through LI.FI/Kyberswap on Base with a same-chain
  control: 1,000 USDC -> 1,372,581 cNGN, ~0.46% slippage, round trip ~0.8%.
  Implied ₦1,372.6/USD against a reference mid of ₦1,364.4 — inside 1% of par.
- **`amount` is in kobo** in their redeem call: `1000000` is ₦10,000. A 100x
  trap for anyone who reads it as naira.

---

## The email

> **Subject:** Individual redemption and delegated access — Zold
>
> Hello,
>
> We're Zold, a self-custodial account app. Our users hold their own assets in
> their own smart accounts; we don't take custody. We'd like Nigerian users to
> be able to turn stablecoin income into naira, and cNGN looks like the right
> instrument.
>
> To be clear about what we are asking for: we are **not** looking to become a
> merchant or to hold anyone's funds. Our users would hold cNGN themselves and
> have their own relationship with you — the same way we integrate Monerium and
> Gnosis Pay today, where the user's account is theirs and we only render it.
>
> We've already verified the parts that need no agreement: we read your contracts
> on chain (Base `0x46C85152bFe9f96829aA94755D9f915F9B10EF5F`, six decimals),
> confirmed supply sits on Base and BNB, and quoted USDC→cNGN on Base live at
> around 0.46% slippage on $1,000, inside 1% of the reference mid. Holding and
> swapping work today without you.
>
> Four questions, and the first is the one that matters.
>
> **1. Is there standing delegated access — and if not, is it on the roadmap?**
> We need to act on a user's own account while they are away: a redemption
> settles over NIP minutes or hours after the burn, so anything session-bound
> can never observe it. Two forms work for us, in order of preference:
>
>   a. **An OAuth-style grant** — the user authorises our application from your
>      dashboard, we hold a refreshable token, they revoke it in one click. This
>      is how we integrate Monerium today and it is what we would build against.
>
>   b. **The user issues us scoped API credentials** from their own merchant
>      account — their KYB, their funds, their bank account, our access limited
>      to the permissions they grant (we noted a "Redeem permission" in your
>      docs). We would encrypt these at rest and never expose them.
>
> If neither exists, please say so — we'll build a hand-off and state plainly in
> our UI that redemption happens with you and that we cannot see it.
>
>
> **2. How does an individual redeem today?** Is the merchant dashboard the only
> route, is there a consumer-facing app, or do most individuals go through a
> licensed exchange such as Quidax or Busha? We want to point users somewhere
> that actually works rather than somewhere that merely exists.
>
> **3. Who can hold and redeem?** Is redemption open to individuals as well as
> registered businesses, and does the holder need to be Nigerian-resident? Some
> of our users are Nigerians living abroad.
>
> **4. Webhooks and status.** If delegated access is possible, what is the
> webhook signature scheme — header, algorithm, and how the secret is issued? We
> refuse unsigned callbacks, so we can't ship a handler without it.
>
> Happy to share what we've built. Even a "no delegated access exists" is a
> useful answer and we'll design around it.
>
> Thanks,
> Tony Thomas — Zold

---

## What each answer changes

| Q | Consequence |
|---|---|
| 1a OAuth | Build the MONERIUM adapter shape: PKCE, per-user tokens encrypted at rest, server-side refresh, revoke in one click |
| 1b scoped keys | Same substance, weaker grant. User-issued credentials under a new `cngn` purpose in crypto-at-rest.ts; the UI must be explicit about what we hold and how to revoke |
| 1 neither | Hand-off only. We hold, swap and keep books; the UI states redemption happens with cNGN and we cannot see it |
| 2     | Decides where we send the user, and whether the exit is one step or three |
| 3     | Decides whether non-resident Nigerians are in scope at all |
| 4     | Only relevant if 1 is yes |

## Related, already decided

- **Bridge cannot serve this.** Their payment-routes table carries no NGN rail,
  and only USDC and EURC for EEA users under MiCA.
- **The swap is the licensed activity, not the token.** EURe/USDC → cNGN
  performed *on behalf of a client* is MiCA Art. 3(1)(16)(e) exchange. The user
  signing it in their own Safe is materially different — see the custody section
  in CLAUDE.md.
- **No merchant account is being sought**, so the Nigerian-entity question that
  stopped Xflow does not arise here.
