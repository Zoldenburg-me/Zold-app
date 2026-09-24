# Business accounts, currencies and invoicing

Read before touching the organisation domain, drafts, the currency registry, invoices or account documents.

*Decision history: the reasoning behind the current invariants, kept as written
apart from naming.*

## Business + premium accounts (Aug 2026) — the organisation domain

The product moved from "a user is an account" to **global (local) accounts held
by an organisation**, with the shape of the app around them taken from **Gnosis
Business** (hq.xyz, discontinued). Their full guide was read — all 64 pages, via
`llms.txt` — not skimmed. Design and reasoning: `docs/business-accounts.md`.
`npm run business:test` (39 checks, no chain, no network).

WHAT IS NEW, and what it replaced:
 - `services/api/src/domain/` — Organisation, Member/Role, Account, Contact,
   DraftPayment, Invoice, ChartAccount/AccountRule, LedgerEntry, ImportedWallet.
   The old model had ONE `user.iban`, ONE `user.address`, ONE balance; that is
   false for a business with several people and several accounts, and for a
   premium personal user with several currencies.
 - `services/api/src/routes/{orgs,business,org-context}.ts`, mounted under
   `/api/orgs` as router FACTORIES taking `requireSession`, so server.ts stays
   the single owner of authentication.
 - `public/business.html` (the org dashboard, at `/business`) and
   `public/invoice.html` (the supplier's invoice view, at `/invoice/:token`).
 - A migration in store.ts gives every pre-existing user a personal org of one,
   CARRYING their real IBAN and address forward rather than re-issuing. Verified
   against the live local `data/db.json`: 5 users, every iban and address
   matched, funded users -> `active`, kyc_pending -> `provisioning`, and every
   pre-existing collection untouched. It is idempotent (keyed on a member row).

THREE CHECKS, NOT ONE, and they answer different questions — collapsing any two
opens a hole. Session (who is this), member+role (may they do this here), plan
capability (did the org buy it). A viewer on a Business plan must not be able to
send money; an owner on Starter must not reach the chart of accounts.

THE RULES THAT CARRY THE WEIGHT, each with a test:
 - **Gating is a read-time filter, NEVER a write-time delete.** A downgraded org
   keeps its chart of accounts, tags and history; the API refuses to serve them.
   Gnosis promised exactly this and it is only true if nothing deletes on
   downgrade. Proved live: downgrade to starter, 15 chart accounts / 8 rules /
   1 contact / 2 drafts / 1 invoice still in the store, all readable again after
   re-upgrade. Nothing in `store.ts` deletes an org, account, invoice or ledger
   row — deliberately no such method exists.
 - **A trial is a grant with an end date, not a plan change.** `org.plan` is
   untouched for the whole trial, so lapsing needs no migration. One per org.
 - **FOUR EYES.** The reviewer may not be the drafter, whatever their role,
   or review is a button the same person presses twice.
 - **INVALID_DATA.** A draft whose payee changed after it was saved is HELD, not
   retargeted. The line stores a fingerprint at save time and it is recomputed
   at review AND again at execution — the gap between approval and execution is
   exactly where an address-book edit lands. Bank accounts keep their id when
   their IBAN is edited, so identity alone does NOT detect this; the fingerprint
   is what does. Proved end to end through the API.
 - **An org can never lose its last owner** — by role change or deactivation,
   which are the same hole reached two ways.

ONLY EUR IS REAL, and that is enforced in one place. `domain/accounts.ts` holds
the currency registry, and liveness is a PREDICATE (`live()`) that asks whether
the provider is configured, not a boolean somebody can flip. USD/GBP/KES/INR are
modelled with `status: "gated"` and a `needs` line naming the partner and the
missing piece (Iron is request-access and ungranted; Triple-A wants $10k/month;
dLocal and Yellow Card are uncontracted). A gated account is still RECORDED when
asked for — that keeps the demand signal and stops the UI lying in the other
direction — but it can never be spent from. This is the UPI lesson applied
structurally: a rail that has never moved money must not render as if it has.

WHAT WE TOOK FROM GNOSIS AND WHAT WE DID NOT — the one real conflict is custody.
Their whole promise was "you import your wallets, we never have access": an
accounting layer over other people's money. That is incoherent for us, because a
*local account* is something we ISSUE. So: we issue accounts and sign for them
(device key / passkey Safe), and imported wallets are READ-ONLY — balances,
bookkeeping and export, never a signature. Rows are stamped `custody:
"external"` so a signing path can assert on the row itself. Executing a draft
from an imported wallet returns unsigned transactions and says so.

DRAFT EXECUTION IS WIRED (Aug 2026). `npm run draft:test` (14 checks, spawns
its own chain and API). A reviewed draft becomes ONE TRANSFER PER LINE, each
carrying its own device-key authorization; nothing moves until the device signs each
one, which is what makes every refusal path below safe.
 - ONE CODE PATH. `buildTransferFromQuote` was EXTRACTED from POST
   /api/transfers unchanged and is INJECTED into the business router, so draft
   execution cannot become a second, weaker way to create a transfer. The test
   asserts the batch fails with the byte-identical error a direct transfer
   gives — that equality is the point, not the failure.
 - WHO MAY SIGN. Spending authority is a device key in one person's browser, so
   `Account.backingUserId` records whose it is. A `payer` may approve and may
   press send, but only the backing user can produce the signature; the API says
   that in words instead of failing later at /authorize like a bug.
 - PLAN-DEPENDENT REVIEW. With `transfers.approvals` bought, a draft must be
   REVIEWED by a second person before it can be sent. WITHOUT it (Starter) there
   is no review step at all, so DRAFT -> EXECUTING is legal — otherwise every
   Starter draft would be permanently unsendable, which is what the first cut
   did.
 - ALL-OR-NOTHING. Every line is planned before anything is created: wallet
   destinations, gated currencies, sub-fee amounts and over-cap amounts are all
   refused up front (422, nothing created). The balance is checked as a TOTAL,
   because the per-transfer check inside buildTransferFromQuote sees the full
   balance every time and N lines that each fit can still overdraw together.
 - PARTIAL FAILURE. If line 3 fails, lines 1-2 exist as CREATED transfers with
   no signature — they cannot move money and simply expire. The draft goes to
   FAILED (not back to REVIEWED) so a retry is a deliberate re-draft rather than
   a second batch stacked on the first.
 - DRAFT STATE IS DERIVED from its transfers, never stored: a row claiming
   EXECUTED while a transfer sits in MANUAL_REVIEW would be a comfortable lie.
 - MOCK IS A THIRD ANSWER. `CurrencyDefinition.mode()` returns "live" | "mock" |
   false, not a boolean. EUR is "live" against Monerium and "mock" on a genuinely
   local deployment (SECURITY.allowSimulation) — real machinery, no real money,
   labelled as such in the API and the UI. The first cut collapsed mock into
   "closed", which made the entire product unreachable in development and is how
   a mock path stops being exercised at all.
 - AN ORG ACCOUNT NEEDS A FUNDING IDENTITY. Per-org Safe/Monerium provisioning
   is NOT built, so a new org's account is `gated` (never `provisioning`, which
   would promise work nobody is doing) until someone calls
   POST /accounts/:id/fund to back it with their own account. A business org
   must ask; the response says plainly that personal money is now paying company
   bills.
 - STILL UNPROVEN: a batch that actually creates transfers. That needs an active
   passkey Safe, which needs an ERC-4337 bundler; local hardhat has none, which
   is exactly why e2e asserts the Safe refusal rather than a send. Prove it on
   Base Sepolia with `npm run api`.

NOT FINISHED, and refused loudly rather than faked:
 - No mail transport exists, so member invitations and invoice links return
   their token to the caller with a note saying no email was sent. Do not add a
   "we emailed them" string without adding a transport.
 - Imported wallets are never actually synced — `sync.status` stays `pending`.
   The ledger is therefore empty until something writes to it, and the
   Transactions/Assets screens say so rather than showing zeros as if final.
 - Cards are modelled as a capability that reports `unavailable` at ANY price,
   never as an upgrade. Telling someone to pay for something unbuilt costs them
   money.

## CHF and NGN — tokens shown, rails still closed (Aug 2026)

Added to the currency registry with its two settlement tokens. `npm run business:test` (43 checks). ALL FOUR ADDRESSES VERIFIED ON CHAIN
by reading name()/symbol()/decimals() from the contract — the addresses came
from a third-party listing and a listing page is a claim, not evidence.

 - **CHF / ZCHF (Frankencoin)** — ethereum
   `0xB58E61C3098d85632Df34EecfB899A1Ed80921cB`, 18dp, supply ~30.6M.
 - **NGN / cNGN** (Wrapped CBDC, Africa Stablecoin Consortium), 6dp on all four:
   base `0x46C85152bFe9f96829aA94755D9f915F9B10EF5F`,
   bnb `0xa8AEA66B361a8d53e8865c62D142167Af28Af058`,
   ethereum `0x17CDB2a01e7a34CbB3DD4b83260B05d0274C8dab`,
   polygon `0x52828daa48C1a9A06F37500882b42daf0bE04C3B`.
   SUPPLY IS ON BASE (~2.58bn) AND BNB (~699m). Ethereum (~137k) and Polygon
   (~12.6k) are rounding error — do not design a route through them. Base is
   also our app chain, so it is the only deployment worth building against.

THE NEW STATE THIS INTRODUCED, and why it needed its own modelling: a currency
whose TOKEN is real, liquid and verified, but whose ACCOUNT does not exist.
That is different from USD/GBP (no token, named partner ungranted) and it is
the shape most likely to mislead — a live token reads as a working rail. So
`CurrencyDefinition.token` names the token, its issuer, its verified contracts
and WHAT BACKS IT, and `currencyAvailability()` stamps `heldByUs` on it. The
test asserts `heldByUs === available`: a token can only be reported as held
where the rail is actually open, so a shown token can never imply a balance.

BACKING IS THE FIELD THAT MATTERS and the one a currency code hides:
 - EURe is e-money with a REDEMPTION RIGHT AT PAR against a licensed issuer.
 - ZCHF has NO issuer who owes anyone redemption — it is minted against
   borrower collateral with the peg defended by auctions. Under MiCA it is a
   crypto-asset, not an EMT, and Frankencoin argues some provisions do not
   apply because it is decentralised — an argument, not a ruling.
 - cNGN is naira-reserve backed under a NIGERIAN perimeter (SEC Nigeria, 2025
   Investments and Securities Act; CBN keeps payment-system oversight). That
   says nothing about MiCA and gives an EEA holder no EU protection.
Rendering all three as "CHF / EUR / NGN" would flatten instruments that differ
in kind, which is why the business Currencies table now has a token column
carrying the backing sentence verbatim.

ALSO: `AccountProvider` gained `"none"` — no candidate identified at all,
distinct from a named partner we have not contracted with. CHF is `none` (there
is no Swiss institution in view; Frankencoin is a protocol, not a counterparty
you can sign with). NGN is `yellowcard`, who genuinely cover Nigeria as their
largest market and are uncontracted.

AND THE CONSTRAINT THAT BITES cNGN: Bridge supports only USDC and EURC for EEA
users under MiCA, so cNGN cannot move through our licensed transfer seam for a
European entity at all. Their API also needs a merchant account and API keys
nobody has requested.

## Invoicing by jurisdiction (Aug 2026)

THE MISTAKE THIS FIXED, one commit after the first cut shipped: German law was
applied to EVERY entity. A Polish or Swedish org was offered
"§ 19 UStG Kleinunternehmerregelung" and a 19% rate; an Indian one was offered
German exemptions with no mention of GST. That is worse than offering nothing,
because it looks authoritative. `domain/jurisdictions.ts` now resolves the rule
set from the ISSUING entity's country — an invoice is governed by where the
issuer is established, not where the customer is.

THREE RULE SETS, and the difference is what we ENCODE versus what we CARRY:
 - `DE`  statutory  — German paragraphs encoded and enforced (see below).
 - `EU`  directive  — the VAT Directive baseline every member state shares
   (Art. 226 particulars, 196 reverse charge, 138 intra-community, 146 export).
   National additions are NOT encoded; there are 26 other sets and we verified
   none. The org adds its own rules for what its country needs.
 - `GENERIC` structural — both parties, a number, dates and arithmetic that adds
   up. NO tax law. India, the US, the UK and everywhere else land here.

EVERY REPORT CARRIES ITS VERIFICATION LEVEL, so `ok: true` never claims more
coverage than we have, and `notVerified` names the gaps verbatim (for India it
names GSTIN, HSN/SAC, place of supply and the CGST/SGST/IGST split, which we do
not model). The UI renders that list next to every invoice.

CITATIONS FOLLOW THE RULE SET. `basis(de, eu)` quotes a German paragraph only
under DE, the Directive article under EU, and NOTHING under GENERIC — quoting
"§ 14 Abs. 4 UStG" at an Indian entity would be confidently wrong. Same for
exemption labels: `reasonForRuleSet()` gives Poland "Reverse charge (EU) —
Art. 196 VAT Directive", not "Reverse Charge (EU-Ausland) — § 3a Abs. 2 UStG".
Three separate leaks of this kind were found and fixed by testing PL and IN
against the running server; grep for hardcoded `UStG` before adding UI copy.

NO VAT RATE TABLE IS SHIPPED. Rates change by statute and 27 numbers we have not
checked would be 27 confident lies. Germany's 19/7 is enforced because we
checked it; everywhere else the org sets the rate it charges and we validate
only that it is a percentage. A missing rate REFUSES rather than defaults —
quietly applying 19 to a Polish entity is the original bug in miniature.

The § 33 UStDV €250 simplified-invoice shortcut is likewise German-only. Member
states may set their own; we have not checked them, so elsewhere full content is
required.

CUSTOM RULES: an org can define its own exemption reasons (id, label, legal
basis, and the note printed verbatim). Required for GENERIC jurisdictions and
useful in EU ones. Presented as user-supplied everywhere — we print the note and
do not check it. A custom rule requiring the customer's tax identifier checks
only that one is PRESENT, never that it matches an EU VAT-ID shape: an Indian
GSTIN is not a USt-IdNr., and validating it against that shape rejects the
correct value.

## German invoicing (Aug 2026) — the DE rule set

Business users can now ISSUE invoices, not only receive them. `Invoice.direction`
splits the two: `incoming` is the original Invoice-Me link a supplier fills in,
`outgoing` is one we issue. THIS SECTION IS THE `DE` RULE SET ONLY — see
"Invoicing by jurisdiction" above for how a non-German entity is handled.
`services/api/src/domain/invoicing.ts` holds the rules; `npm run invoicing:test`
(26 checks, offline).

NOT TAX ADVICE and the app says so on every screen that touches it. What the
code guarantees is narrower: the software cannot produce a document missing a
mandatory field, and cannot show tax the issuer does not owe.

THE TWO RULES WITH MONEY ATTACHED, both silent failures — nothing bounces, the
damage arrives months later:
 - §14c UStG: show VAT you did not owe and you OWE IT ANYWAY, and the customer
   cannot deduct it. So `VatTreatment` is a DISCRIMINATED UNION whose exempt arm
   has no rate and no tax field — "exempt with a VAT amount" is unrepresentable,
   not merely discouraged. computeTotals forces every line to 0% when the
   invoice is exempt, even a line carrying its own rate.
 - §14 Abs. 4: a missing mandatory field costs the RECIPIENT their Vorsteuerabzug
   until a corrected invoice arrives. The damage lands on the customer, not on
   whoever made the mistake, which is why it is checked before issuing.

WHAT IS ENCODED (sources checked against IHK/Haufe/dejure, not memory):
 - §14 Abs. 4 UStG — the ten mandatory details. The date of supply is required
   EVEN WHEN it equals the invoice date; a supply PERIOD satisfies it too.
 - §33 UStDV — Kleinbetragsrechnung up to €250 GROSS drops recipient, invoice
   number, tax number and supply date. One cent over and full content returns.
 - §34a UStDV (new 2025) — Kleinunternehmer content rules, so a missing tax
   number is a WARNING there and an ERROR elsewhere. §19 thresholds rose in 2025
   to €25,000 prior year / €100,000 current.
 - Reverse charge — the invoice must carry the literal
   "Steuerschuldnerschaft des Leistungsempfängers" (Art. 226 Nr. 11a MwStSystRL
   allows other official EU languages), and EU B2B needs BOTH USt-IdNr.
 - Also: intra-community supply, export to third countries, place-of-supply
   abroad, and a free-text `other` that forces the issuer to write the basis.
 - Every reason carries its statute, printed next to the choice and on the
   document, so the user can check us rather than trust us.

MONEY IS INTEGER CENTS end to end, and VAT is rounded ONCE PER RATE BUCKET, not
per line — rounding each line and summing drifts against what the tax office
recomputes. Per-line VAT is then attributed back so the column adds up exactly.

PREFILL: `Organisation.invoicing` holds the issuer identity (USt-IdNr.,
Steuernummer, Kleinunternehmer flag, bank, register court/number, payment terms,
number series, footer). §14 wants the issuer's name, address and tax id on EVERY
invoice, so they live there once. `issued` on the invoice is a FROZEN SNAPSHOT of
both parties, the treatment and the display choices — re-rendering from today's
org profile would quietly rewrite a document the tax office may later ask about.

DISPLAY TOGGLES COVER OPTIONAL BLOCKS ONLY. Everything §14 requires is rendered
unconditionally and is absent from the settings map: a generator whose settings
can produce an invalid invoice is a trap, and it springs on the customer.

THE DOCUMENT IS A DOCUMENT. `public/invoice.html` renders a white A4-printable
sheet inside the dark app chrome, with a German sender line, per-rate VAT table
and a print stylesheet. Deliberately NOT the receipt-printer aesthetic that was
considered: a till roll cannot hold two addresses and a VAT table, does not
print to A4, and reads as less credible to the accountant who must accept it.
That treatment belongs on /r/:slug receipts, which are a different artifact.

BUG THIS FOUND — QUIRKS MODE. business.html and invoice.html were written
without `<!DOCTYPE html>`, so they rendered in BackCompat. In quirks mode TABLES
DO NOT INHERIT COLOR from their parent, so the invoice line items and totals
rendered in the dark theme's light text on the white sheet — nearly invisible,
and only visible at all because that page inverts. Every pre-existing page had a
doctype; only the two new ones did not. Both fixed. Check `document.compatMode`
is `CSS1Compat` on any new page.

NOT BUILT, and said on the document itself: XRechnung / ZUGFeRD (EN 16931).
German B2B must already be able to RECEIVE e-invoices; the obligation to ISSUE
them phases in from 2027 (2028 for smaller turnover), so a PDF is enough today
and will not be. That is the next real piece of work here.

## Pay from invoice (Sep 2026)

An incoming Invoice-Me invoice is PAID THROUGH A DRAFT, not by a second
payment path. `POST /orgs/:id/invoices/:id/pay` turns a SUBMITTED EUR invoice
whose supplier gave an IBAN into one draft line (`DraftLine.invoiceId`) on the
org's EUR account; review and the device signature apply exactly as to any
other draft. At execution the line's remittance text is
`paymentReference()` — `Invoice <supplier's number> <org name>` — because the
supplier's bookkeeping matches on THEIR number, and the transfer id lands on
`invoice.payment`. The invoice's state is DERIVED from its transfer on read
(`syncInvoicePayment`): PAYING -> PAID when the transfer is PAID, back to
SUBMITTED when the transfer or the draft fails, so a fresh draft can pay it.
The supplier is matched to a contact by IBAN, then by name, else created,
so the line carries a fingerprint and INVALID_DATA works. The supplier form
now collects account holder, IBAN and BIC (validated with the address-book
rules at submission, so a typo is the supplier's to fix, not a payment
failure weeks later); a wallet-only invoice records and "Pay" says to ask
for an IBAN. Reconcile (manual) stays for invoices paid elsewhere.
Checks: draft:test 7/7 new, business:test 2 new. NOT PROVEN: the
PAYING -> PAID follow-through on a real transfer (needs a Safe on Base Sepolia).

THE BOUNDARY, decided with the user: Zold pays from an invoice and keeps the
record (statement, receipt, reference); invoicing software creates invoices,
chases them and books them. Do not extend the issued-invoice module further.

## Account documents — statement, receipt, balance, ownership (Sep 2026)

`npm run documents:test` (13 checks: pure builders offline, then the routes on
a hardhat chain with a harness Safe). Code: `documents.ts` (builders, canonical
digest, signing, parties text), `routes/documents.ts` (routes + verifier),
`public/document.html` (the printable sheet and the live verdict). Profile ->
"Statements & documents"; transaction detail -> "Transfer receipt (PDF)".

MODELLED ON REBIND'S RECEIPT (a Monerium-based app; the user's own receipt was
the reference): holder block, IBAN + BIC, a DATE / IBAN / NAME / MEMO / AMOUNT
table, and the Monerium legal footer. Their PDF's producer is Chromium, so
theirs is a browser print too — ours is the same: the page at `/v/<code>` IS
the record, the PDF is its print. No PDF library.

THE PROPERTY: every document is a frozen snapshot under a 15-char Crockford
verification code, signed by the server's document key (EIP-191 over the
canonical digest; `DOCUMENT_SIGNING_KEY`, else the orchestrator key), and the
verifier RE-CHECKS on every visit — signature, balance re-read from the chain
at the stated block, statement reconciliation, and the Safe's EIP-1271
signature on a proof of ownership. A revoked document fails verification
rather than vanishing. Codes are on the auth rate bucket (`/v/`), like slugs.

WHO IS WHO, from Monerium's own terms (personal and business ToS, s. 1.1, 4,
5, 6): Monerium is the e-money issuer; the IBAN and the SEPA payment services
are provided by AS LHV Pank, Tallinn (the IBAN is Estonian, BIC LHVBEE22 —
confirmed on the reference receipt); e-money is redeemable at par, safeguarded,
NOT a bank deposit and NOT deposit-guarantee covered; Zold is software. ONE
footer paragraph (`PARTIES.footer`) carries that, once per document, in the
shape of Rebind's two-line footer; the first cut restated it in every body
and was trimmed on the user's call. The bank-details screen was also
corrected: it used to call Monerium the bank.

STATEMENT SOURCES, in order of authority: chain balances at the period's
boundary blocks (binary search over block timestamps), Monerium orders for the
counterparty name/IBAN/memo, our transfer records. Duplicates across sources
are the same money seen twice and are merged by amount within a day. A
statement that does not reconcile SAYS SO with the delta rather than refusing;
a statement without a Monerium connection says its lines carry ledger data
only. Proof of ownership is framed as proof of CONTROL (the Safe signs a
message naming the account, the code and the day); the issuer's word is
Monerium's own account history, and the document says so.

REFUSED: any document for an account whose account of record is the zero
address; a receipt for a transfer that has not moved money.

NOT PROVEN: Monerium order data on real statement lines (needs a connected
production account) and the printed PDF's look in a real print dialog.

