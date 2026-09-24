# docs/notes — decision history

The reasoning behind the project's invariants, split by area.

Read the file that covers what you are about to touch:

| file | covers |
|---|---|
| `money-movement.md` | custody, liquidity venues, fees, FX, the cash rail, Stellar, sandbox modes |
| `identity-and-security.md` | the security gate, key custody, recovery, onboarding, Monerium connections |
| `business-and-invoicing.md` | the organisation domain, currencies, invoicing by jurisdiction, account documents |
| `payments-and-checkout.md` | payment links, both Shopify modes, shareable receipts, Gnosis Pay |
| `app-and-chains.md` | the mobile app and PWA, testnet plumbing, how far a send actually runs |
| `review-passes.md` | the mainnet-ready cut and the two multi-agent review sweeps |
| `roadmap-and-partners.md` | payout, funding and card partners, with the per-partner detail |
| `code-layout.md` | where every file moved in the modularity pass, and the rules that kept it a pure move |

These are notes, not specification. A claim marked VERIFIED was checked against
a live chain, API or bytecode — if you contradict one, re-test before rewriting
it, and say what you ran. Design documents live one level up in `docs/`.
