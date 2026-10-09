# ENS names for payment pages

A payment page with the handle `alice` can also be reached as the ENS name
`alice.zoldhq.com`. A wallet that resolves the name gets the page's deposit
address. Status: tested end to end on local hardhat only; the Sepolia
resolver is deployed but no name resolves yet (`docs/status.md`).

| Network | Resolver | Gateway URL |
|---|---|---|
| Sepolia (11155111) | `0x86be72493f3e08f84dc7caf47acbe9ebbb764305` | `https://zoldhq.com/api/ens/gateway/{sender}/{data}.json` |
| Mainnet | not deployed | |

The Sepolia resolver's owner is a hot key, which is acceptable on a test
network only.

## How it resolves

1. The wallet asks ENS for `alice.zoldhq.com`. That name has no record of its
   own, so ENSIP-10 wildcard resolution finds the resolver of `zoldhq.com`.
2. That resolver is our `OffchainResolver` (`contracts/src/OffchainResolver.sol`),
   on Ethereum mainnet or Sepolia. Its `resolve` reverts with `OffchainLookup`
   (ERC-3668), naming the gateway URL.
3. The wallet fetches `GET /api/ens/gateway/{sender}/{data}.json`
   (`routes/ens.ts`, encoding in `ens.ts`), and the API signs the answer with
   `ENS_GATEWAY_KEY`.
4. The wallet passes the answer to `resolveWithProof`. The contract accepts it
   only if a listed signer signed it, for this resolver, for this exact
   request, and before it expires (`ENS_GATEWAY_TTL_S`, 300 s by default).

Under a DNS name, step 2 goes through ENS's own OffchainDNSResolver first.
That resolver reads the TXT record and relays the lookup, which is why the
gateway does not check `{sender}`.

## What a name answers

These are the same facts `GET /pay/:handle` already publishes:

- `addr(node, coinType)`: the page's deposit address, but only for the coin
  types (ENSIP-11) of chains the page takes payments on. These are the pay
  chain, plus the forwarder's source chains when it has them.
- `addr(node)`, Ethereum's coin type 60: zero, unless the page takes payments
  on Ethereum. Most wallets ask for this record by default. A Base-only page
  therefore resolves only in wallets that ask for Base's coin type.
- `text(node, "url")`: the page URL.
- `contenthash`, `name`, `pubkey` and `ABI`: always empty. Wallets ask for
  these alongside the address, and refusing them would fail the whole lookup.
  Any other record type is refused (400).
- Nothing for a closed page, an org page (it has no address), an unknown
  handle, a deeper name like `x.alice.zoldhq.com`, or a label not already in
  normalised form (`ALICE`, or a look-alike letter that lowercases to a
  handle). ENS clients normalise before they hash, so only a caller that
  skipped that sends one.
- Nothing while a page's forwarder renewal takes longer than 2 s; the renewal
  carries on and the next lookup sees it.

A signed answer is reused for the same request while more than half its
validity is left, so a page change shows in the gateway within half the TTL
(150 s by default), plus 60 s of HTTP caching.

Handles are already a subset of what ENS accepts. The one extra rule is that
`--` cannot be the third and fourth characters (ENSIP-15), and `normaliseHandle`
refuses that.

## Setting it up

1. **Gateway key.** Generate a fresh key for the gateway and put it in the API
   host's `.env` as `ENS_GATEWAY_KEY`. It signs every answer, so it must not
   be reused for anything else; the API refuses to start if it equals one of
   the operator or faucet keys. Use a different key for Sepolia and mainnet:
   the signature binds the resolver's address but not the chain, so a
   resolver deployed at the same address on both would accept each other's
   answers.
2. **Deploy the resolver** (`npm run deploy:ens-resolver`, header lists the
   env). Do Sepolia first. Move the owner to a hardware wallet afterwards
   (`transferOwnership`, then `acceptOwnership` from it): the owner can change
   the URL and the signers, and so redirect every name.
3. **DNS.** Enable DNSSEC on `zoldhq.com` at the registrar. Then add the TXT
   record that ENS's gasless DNSSEC import reads, naming the resolver:
   `ENS1 <OffchainResolver address>`. Check on Sepolia that
   `alice.zoldhq.com` reaches the resolver, not only `zoldhq.com`. If it does
   not, the wildcard record (`*.zoldhq.com`) needs the same TXT value.
4. **API env:** `ENS_PARENT_NAME=zoldhq.com`, `ENS_RESOLVER_ADDRESS`,
   `ENS_GATEWAY_KEY`. All three or none; a partial set refuses to start.
   `/api/health` then reports `ensParent`.

Once `zold.eth` is bought, the same resolver serves it: set it as the
resolver of `zold.eth` in the ENS app. The parent name is one env value, so
serving both names at once would need `ENS_PARENT_NAME` to take a list.

## Looking up a name

`GET /api/ens/lookup?name=vitalik.eth` (signed in) returns the name's address
for this deployment's chain, through `ENS_RPC_URL` on `ENS_CHAIN_ID`. There is
no fallback to the Ethereum record. A name with no record for the chain gives
`404 NO_ADDRESS`, because an address on mainnet need not be the same account
on Base, for a Safe in particular. `ENS_CHAIN_ID=11155111` is refused on a
real-money chain, since anyone can take any name on Sepolia.

A name's resolver can send the lookup to a gateway URL of its owner's
choosing, so the server fetches it only over https, never to a private,
loopback or link-local address, without following redirects, within 3 s and
64 KB (`ccipFetch`). No send screen uses it yet: sending to a
crypto wallet is still a "soon" row.
