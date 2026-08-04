# Payment pages

A shareable handle that resolves to a page-scoped deposit address someone can
pay: `/pay/alice`.
Modelled on Fluidkey's `alice.fkey.id`, which is the clearest version of this
idea in production.

## What Fluidkey does, and what we do instead

Checked against `ftx.fkey.id` and their docs, not inferred:

| | Fluidkey | Here, today |
|---|---|---|
| Identifier | `name.fkey.id`, also an ENS name (`name.fkey.eth`) | `/pay/name` path on the app origin |
| Address shown | a **new stealth address on every resolution**, derived from the recipient's stealth meta-address (ERC-5564) | one deposit Safe address per payment page |
| Account type | 1/1 Safe smart accounts as the stealth accounts | Candide Safe — the same primitive |
| Networks | Base, Ethereum, BSC, Arbitrum, Polygon, Gnosis | one, whichever `TRANSF_CHAIN_ID` names |
| Payer inputs | none — QR plus copy-address | the same: QR plus copy-address |
| Privacy | unlinkable by construction | **none**, and the page says so |

The two things they have that we do not are stealth addresses and multi-chain.
Everything else on their page is the same shape, which is why this one is
deliberately plain: no amount field, no wallet connection. A payer's wallet
does both better than a web page can.

## Page address, not main wallet

The payment page does not show the user's main smart account. It has its own
deposit Safe address and its own settlement rule, so a normal transfer into the
wallet cannot accidentally be swept because the page's auto-convert setting is
on.

That page address is still public. Fluidkey's entire pitch is that a payer
learns nothing about the recipient's other activity. Ours is not there yet: each
payment page resolves to one address, so every payment to that page lands in the
same place and anyone holding the link can read that page address history on an
explorer.

That is a real difference in kind, not a smaller version of the same thing. The
page therefore states it in plain words, and nothing in the product describes
these links as private. If that sentence ever gets softened for marketing
reasons, the feature has become misleading.

## Why not stealth addresses yet

Not difficulty — sequencing. Doing it honestly means the recipient controls
every derived account, which means deriving the keys **client-side** from
something only they hold. Fluidkey derives from a signature.

Doing stealth server-side would be easy and wrong: it would put a key for every
stealth account in `db.json`, next to the one `user.privateKey` that FP4 exists
to remove. The current payment-page deposit Safe is a page-level MVP custody
boundary, not a privacy solution, and its key is stripped from API responses and
forbidden in production stores.

Two other things it would touch, worth knowing before starting:

- **Detection.** `crypto-deposits.ts` watches `user.address`. Stealth means
  watching many addresses per account, or scanning ERC-5564 announcements —
  a different shape of poller, not a longer address list.
- **Payout.** Balances are keyed to the merchant Safe. Payments landing on
  stealth accounts need Safe-native movement into the merchant account before
  they are spendable, which is the same Safe-move problem the crypto-in sweep
  has.

## Handles are enumerable

`200` versus `404` on `/api/pay/:handle` tells a caller whether a handle is
claimed, and handles are short and human-readable by design. That is true of
every username system and cannot be fixed while the link is meant to be
shared, so it is stated rather than papered over: the page tells the payee that
anyone who knows **or guesses** the handle can find the address, and no comment
in the code claims the endpoint resists walking.

## Roadmap: pay by link, not just crypto QR

The long-term version of `/pay/<handle>` is a payment instrument, not only a
wallet-address card. It should let a payer choose a route:

- crypto deposit, converted just-in-time to EURe through a real venue such as
  Bebop;
- SEPA bank transfer into an app-issued IBAN or virtual account reference;
- later local rails, if the corridor supports payer-initiated collection.

The UI must then show the recipient a private receipt:

| Field | Why it matters |
|---|---|
| payer/source address or bank counterparty | "Who paid me?" |
| source tx hash or SEPA reference | payer-side proof |
| source token/amount or bank amount | reconciliation |
| conversion venue and rate | receipt honesty |
| credited EURe amount | spendable balance |
| credit tx / issue order | audit trail |

Do not merge a forwarding-address implementation as "privacy solved". Candide
Forwarding Address is useful as a deposit-address layer, but the public docs
describe forwarding/routing to a configured recipient, not arbitrary actions
such as "swap on Bebop first, then credit EURe". If the recipient is the user's
Safe, the deposit may still be traceable to that Safe. If the recipient is a
Zold conversion treasury, Zold takes custody during conversion.

The roadmap decision is therefore explicit:

- **OG build:** one public deposit Safe address per payment page, with blunt
  privacy copy and page-scoped settlement.
- **Near-term hardening:** ask Candide whether custom forwarding hooks or
  arbitrary calldata are available; if not, treat Candide forwarding as UX
  hardening only.
- **Non-custodial privacy path:** use per-payment user-controlled addresses or
  stealth-style accounts. The app can privately map deposit address to user and
  show payer details, while the user retains control of funds.
- **Custodial conversion path:** route deposits to a Zold treasury, execute
  Bebop just-in-time conversion, then credit EURe to the user's Safe. This has
  the cleanest public graph, but it is custody and must be treated as such.

## Handles

Lowercase, 3–30 characters, alphanumeric with internal hyphens, unique
case-insensitively. Refused: reserved route names, anything starting `0x`.

Route names are reserved because the page shares an origin with the app, so a
handle called `settings` invites a convincing phish. `0x` is refused because a
handle that looks like an address is a trap on a page whose job is showing an
address.

Claiming a handle is KYC-gated, matching every other route that leads to money
arriving. Conversion refuses on an unapproved account anyway, so gating the
claim means the public page never has to expose an account's review status to
explain itself.

## The public projection

`publicPayee` in `services/api/src/pay.ts` is an **allowlist**: it names the
fields that go out. The account object beside it holds an IBAN, an email
address, a KYC decision, a Travel Rule profile and a private key, so a
redaction list would leak whatever field somebody adds next.

`payDisplayName` is deliberately separate from `user.name`. That one may be a
legal name from KYC, and claiming a handle is not consent to publish it at a
guessable URL. Absent means the page shows the handle alone.

## The QR code

Written rather than installed (`services/api/src/qr.ts`) — byte mode, EC level
L, versions 1–6, rendered server-side as SVG so there is one implementation and
nothing new on the client.

It carries the **bare address**, not an EIP-681 URI. Wallet support for parsing
EIP-681 is uneven, while every wallet that scans anything can scan an address,
so the page states the chain and token in text and offers the URI as an "open in
wallet" link. A code a payer's wallet cannot read is worse than one carrying
less.

A full EIP-681 URI with an amount is ~135 bytes and does not fit in version 6 —
measured. The encoder throws rather than emitting something unscannable.

**Verified by an independent decoder.** `npm run pay:test` rasterises the
matrix and reads it back with `jsqr`, which is the check that matters: our own
reader shares our own assumptions and will agree with any self-consistent
mistake.

It caught a real one. The first version of `placeFormat` transposed the two
format strips — bits 0-5 belong in column 8, not row 8 — and reversed the bit
order along row 8, and it wrote over the dark module at `[size-8][8]`. The data
codewords were perfect, every self-check passed, and no scanner could read the
result, because nothing could tell which mask had been applied. That is the
shape of bug a round-trip through your own code cannot find.

Still worth doing once: scanning one with an actual phone camera, which tests
contrast and module size rather than correctness.
