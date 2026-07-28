# Payment pages

A shareable handle that resolves to an address someone can pay: `/pay/alice`.
Modelled on Fluidkey's `alice.fkey.id`, which is the clearest version of this
idea in production.

## What Fluidkey does, and what we do instead

Checked against `ftx.fkey.id` and their docs, not inferred:

| | Fluidkey | Here, today |
|---|---|---|
| Identifier | `name.fkey.id`, also an ENS name (`name.fkey.eth`) | `/pay/name` path on the app origin |
| Address shown | a **new stealth address on every resolution**, derived from the recipient's stealth meta-address (ERC-5564) | the account's one existing Safe address |
| Account type | 1/1 Safe smart accounts as the stealth accounts | Candide Safe — the same primitive |
| Networks | Base, Ethereum, BSC, Arbitrum, Polygon, Gnosis | one, whichever `TRANSF_CHAIN_ID` names |
| Payer inputs | none — QR plus copy-address | the same: QR plus copy-address |
| Privacy | unlinkable by construction | **none**, and the page says so |

The two things they have that we do not are stealth addresses and multi-chain.
Everything else on their page is the same shape, which is why this one is
deliberately plain: no amount field, no wallet connection. A payer's wallet
does both better than a web page can.

## Not private, said out loud

Fluidkey's entire pitch is that a payer learns nothing about the recipient's
other activity. Ours resolves to a single address, so every payment lands in
the same place and anyone holding the link can read the whole history of it on
an explorer.

That is a real difference in kind, not a smaller version of the same thing. The
page therefore states it in plain words, and nothing in the product describes
these links as private. If that sentence ever gets softened for marketing
reasons, the feature has become misleading.

## Why not stealth addresses yet

Not difficulty — sequencing. Doing it honestly means the recipient controls
every derived account, which means deriving the keys **client-side** from
something only they hold. Fluidkey derives from a signature.

Doing it server-side would be easy and wrong: it would put a key for every
stealth account in `db.json`, next to the one `user.privateKey` that FP4 exists
to remove. That is the opposite direction from the custody plan, so stealth
addresses should land after FP4's passkey/co-signer Safe, not before.

Two other things it would touch, worth knowing before starting:

- **Detection.** `crypto-deposits.ts` watches `user.address`. Stealth means
  watching many addresses per account, or scanning ERC-5564 announcements —
  a different shape of poller, not a longer address list.
- **Payout.** The vault credits are keyed to `user.address`. Payments landing
  on stealth accounts need sweeping into the funding account before they are
  spendable, which is the same Safe-move problem the crypto-in sweep has.

## Handles are enumerable

`200` versus `404` on `/api/pay/:handle` tells a caller whether a handle is
claimed, and handles are short and human-readable by design. That is true of
every username system and cannot be fixed while the link is meant to be
shared, so it is stated rather than papered over: the page tells the payee that
anyone who knows **or guesses** the handle can find the address, and no comment
in the code claims the endpoint resists walking.

When Candide Forwarding Address is configured (`CANDIDE_FORWARDING_*`), the
page shows an activated forwarding deposit address instead of the account's Safe
address. This is a hardening step, not stealth privacy: the forwarding address
is still public, deposits to it are still inspectable, and forwarding status can
still reveal delivery on-chain. What it avoids is publishing the user's main
Safe address directly from a guessed handle.

The integration deliberately uses a deterministic salt per user handle. That
keeps one shareable page stable and avoids burning through Candide's active
address cap; per-payment salts are the next step if the product wants
transaction-level deposit addresses.

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
