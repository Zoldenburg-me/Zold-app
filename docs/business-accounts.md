# Business & premium accounts — the rebuild

Decided Aug 2026. This file records the model and the reasoning; the code is
`services/api/src/domain/`. Read this before changing an entity.

The product is **global (local) accounts**: an organisation holds accounts
denominated in the currency of a place, and pays out on that place's rail. The
shape of the app around those accounts is taken from **Gnosis Business**
(hq.xyz, discontinued), whose guide we read in full.


## What we took from Gnosis Business, and what we did not

Their model is worth copying because it is a *finished* answer to "what does a
crypto-native business actually need on top of a balance": an organisation with
members and roles, plans that gate features, an address book that holds bank
details, payments that go through review before they move, invoices that a
supplier can fill in without an account, and bookkeeping that exports to Xero.

TAKEN, close to as-is:
 - **Organisation as the tenant**, not the user. Members are invited by email,
   carry a role, and are deactivated rather than deleted. Invitations expire
   (theirs: 3 days — we keep that).
 - **Two plans with a feature matrix.** Starter is free and payouts-only;
   Business is paid and unlocks accounting. One 30-day trial per org.
   Downgrade *pauses* premium features and keeps the data, so an upgrade
   restores everything. That last rule is the one that makes the gate humane,
   and it is a storage decision, not a UI one — see `plans.ts`.
 - **Per-feature verification.** They ran KYB twice: once with Triple-A for
   fiat payouts, once with Blockpass for cards. That is not duplication, it is
   the honest shape — each regulated partner owns its own identity
   relationship and neither accepts the other's. Our `verifications` map is
   keyed by capability for exactly this reason.
 - **Address book holds bank details.** A contact is not an address; it is a
   payee with wallets *and* bank accounts, and the payout form reads from it.
 - **Drafts with review and approval.** Create → submit for review → reviewed →
   execute, with distinct people on each step, plus `INVALID_DATA` for a draft
   whose saved recipient changed underneath it. That state exists because
   address books drift, and a payment that silently retargets is worse than one
   that stops.
 - **Invoice-Me links.** The payor generates a one-time link; the supplier
   fills the invoice in with no account and no wallet connection; the payor
   pays from the transfer page. Invoices lock on submit.
 - **Bulk payments via CSV** with column mapping, 500 rows, 2 MB.
 - **Chart of accounts + account rules** (defaults, per-wallet/asset,
   per-contact), transaction mapping, FIFO tax lots, monthly balance report,
   CSV/Xero export.

NOT TAKEN, and the reason matters:
 - **Their custody model is the opposite of ours.** Gnosis Business never held
   funds — "you import your wallets, we never have access". That is coherent
   for an accounting layer, and incoherent for us: a *local account* is
   something we issue, with an identifier someone else can pay into. So we
   issue accounts and sign for them (FP4 device key / passkey Safe), and we
   additionally support **imported wallets as read-only** — balances,
   transactions, bookkeeping and export, but we never sign for them. A payment
   from an imported wallet is built by us and signed by its owner.
   The one-line rule: *if we issued it, we can sign it; if you imported it, you
   sign it.*
 - **Their payout rail.** Triple-A required $10k/month before verification
   would even start. Our EUR rail is Monerium and is already proven.
 - **Cards.** Their card was USDC-on-Polygon through a third-party issuer. Our
   roadmap picks Immersve for the same slot; nothing here builds a card, and
   the capability is modelled so the UI can say so.


## Entities

`Organisation` is the tenant and the thing that holds money.

    Organisation
      type      "personal" | "business"
      plan      "starter" | "premium" | "business"
      profile   legal name, tax id, registered address, country
      reporting currency, time zone, cost-basis method
      verifications  capability -> record   (see below)

Personal and business are the same machine with different defaults and a
different plan ladder — personal orgs get `starter`/`premium`, business orgs get
`starter`/`business`. They are not separate code paths, because every feature
below (accounts, contacts, payouts, receipts, export) is wanted by a premium
personal user too; what differs is members, KYB and the invoice/COA surface.

A `Member` joins a `User` (a login identity — passkey, sessions, device key) to
an organisation with a role. A user can belong to several organisations, which
is why the session carries a user and every request resolves an org from the
path, never from the session alone.

Roles, narrowest to widest:

| role | reads | drafts | approves | moves money | admin |
|---|---|---|---|---|---|
| `viewer` | ✅ | | | | |
| `accountant` | ✅ | ✅ | | | books only |
| `payer` | ✅ | ✅ | | ✅ | |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `owner` | ✅ | ✅ | ✅ | ✅ | ✅ + billing, delete |

`accountant` exists because the person who categorises transactions is usually
not the person allowed to send money, and collapsing them is how a bookkeeping
login becomes a spending login.

`Account` is the new product primitive — one local account in one currency.

    Account
      currency  EUR | USD | GBP | KES | INR
      status    gated | provisioning | active | error
      provider  monerium | iron | triplea | dlocal | yellowcard | null
      identifier  iban / accountNumber+sortCode / routingNumber / mobile
      address   0x… smart account, where the currency is tokenised

Only **EUR is real**: Monerium issues a genuine IBAN and EURe settles on Base
Sepolia today. Every other currency is modelled with `status: "gated"` and a
`gate.needs` string naming the partner and what is missing. This is deliberate
and is the same rule the rest of the repo follows: a rail that has never moved
money must not render as if it has. `accounts.ts` holds the registry and it is
the single place a currency becomes live.

`ImportedWallet` (+ `WalletGroup`) is the Gnosis half: an address we watch and
book, never sign for. `custody: "external"` is stored on the row, and the
signing paths assert it.

`Contact`, `DraftPayment`, `Invoice`, `ChartAccount`, `AccountRule` and
`LedgerEntry` follow their Gnosis descriptions closely; the per-entity notes
live with the types.


## Plan gating

`plans.ts` is a matrix of capability -> minimum plan, derived from their feature
table. Two rules that are easy to get wrong:

 1. **Gating is a read-time filter, never a write-time delete.** A downgraded
    org keeps its chart of accounts, its tags and its history; the API refuses
    to *serve* them and the UI shows an upgrade prompt. Their FAQ promises
    exactly this ("your information isn't lost… all your previous data and
    settings will come back automatically"), and it is only true if nothing
    ever deletes on downgrade.
 2. **A trial is a grant with an end date, not a plan change.** One per org.
    When it lapses the org is back on its base plan with no data touched.


## What this rebuild replaces

Rewritten: `store.ts`, `server.ts` route surface, `public/index.html`.
Deleted: the assumption that a user *is* an account — one `user.iban`, one
`user.address`, one balance.

Kept untouched, because it is the expensive part and it is verified: `chain.ts`,
`liquidity.ts`, `rates.ts`, `dex.ts`, `fx.ts`, `sepa.ts`, `webauthn.ts`,
`qr.ts`, `receipt.ts`, `reconcile.ts`, `recovery*.ts`, `country-policy.ts`,
`adapters/*`, `stellar/*`, `bridge/*`, `wallet/*`, and the contracts. The
orchestrator keeps its state machine and gains an org-scoped caller.
