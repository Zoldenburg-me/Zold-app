# Zold testnet checklist — zoldhq.com (Base Sepolia 84532 + Monerium sandbox)

Built from the route files, `docs/architecture/product-architecture.md`,
`docs/status.md` and the live `GET https://zoldhq.com/api/health` (2026-10-03).

Live flags on that read: `moneriumOAuth` on, `moneriumApiKeys` on (sandbox),
`zoldenburgRecovery` on, `safeImport` on, `faucetEur` 100, faucet tokens
EURe/USDC/EURC. Off: `cashRail`, `shopify`, `emailSmsRecovery`,
`paymentPageForwarding`, `emailVerification`.

Tags: **[NEVER]** never run on any real chain. **[HARNESS]** run only against
hardhat or a fake partner. **[LIVE]** run on Base Sepolia/sandbox at least
once. **[OFF]** switched off here: test only that the UI hides it and the API
refuses it.

Testers needed: a personal signup, a company signup, a second company member
(admin/payer/accountant/viewer in turn), and an outside payer with a browser
wallet holding Base Sepolia USDC.

## 0. Deployment sanity
- [ ] `/api/health`: `chainId 84532`, `realMoney false`, block moving
- [ ] Every control in the UI matches `capabilities`
- [ ] `/`, `/legal`, `/privacy`, `/partner-terms`, robots, sitemap, 404 render; cookie notice covers no button (Z-010)
- [ ] Mobile landing header has a menu (Z-005)
- [ ] New JS loads after a deploy without a hard reload; `/pay/*`, `/r/*`, `/v/*` never from SW cache

## 1. Onboarding — personal signup [LIVE] — all tested by hand on zoldhq.com, 2026-10-03
- [x] Account step: name, email (required), country, citizenships, US-person answer, consents
- [x] US person refused before any row exists; sanctioned / unsupported country → BLOCKED screen
- [x] Segment: EU resident → EU_FULL; India → IN_COLLECTIONS (gated)
- [x] Passkey: no skip; desktop error text does not say Face ID (Z-006); cancel → readable retry
- [x] Safe deploys with sponsored gas; reload mid-deploy resumes
- [x] "Leave site?" only when something is unsaved (Z-007)
- [x] Recovery step: Zoldenburg opt-in; skip needs the acknowledged warning
- [x] Monerium OAuth: start → sandbox → callback → back in app
- [x] Expired / replayed OAuth state → a way back, not raw JSON (Z-011)
- [x] Own API keys: sandbox keys accepted, production keys refused, delete works
- [x] Monerium screen tells a personal signup to pick **Personal** (bug #7)
- [x] Wrong-kind profile → refusal that does not claim something was connected
- [x] Activate IBAN: passkey signs declaration → linked → IBAN shown → approved
- [x] Late IBAN picked up; never "on its way" + "active" together (Z-012)
- [x] Nothing approves without an address-matched IBAN
- [x] Logout; passkey login on the same and a second device

## 2. Onboarding — company signup
- [ ] Corporate profile required; personal refused
- [ ] Company Safe never labelled "Personal" in /app (16a)
- [ ] Documents add "operated by" the user when the holder differs (16c)
- [x] Corporate profile `name` read from the sandbox [LIVE: one company signup, profile `pending`, IBAN issued on it, 2026-10-03]
- [ ] Approved corporate profile: org account opens, sends pass the profile check [NEVER]
- [ ] Pending corporate profile with an approved IBAN backs the org account (16b) and documents name the company (16c) — after the redeploy
- [x] Safe import: prepare → owner change in Safe{Wallet} → confirm [LIVE: company account, 2026-10-03 round]
  - [x] with a real passkey
  - [x] Transaction Builder JSON on app.safe.global
  - [ ] old owner kept as 2nd owner → every op refused at threshold > 1
  - [ ] IBAN on an imported Safe — Monerium issued it for a company tester, but the app got it wrong: Safe labelled Personal, active in /app but "Not open" in /business, documents named the user not the company (batch 16 a–c, fixed in #278, not deployed). Retest after the redeploy.
  - [ ] recovery not offered on an imported Safe
  - [ ] owner change sent from a hardware wallet [NEVER]

## 3. Moving an existing IBAN [HARNESS — never against the real sandbox]
- [ ] Profile with an IBAN → 409 `IBAN_EXISTS_ELSEWHERE`, masked IBAN, old address + chain
- [ ] Several IBANs listed in full, none preselected
- [ ] Typed `MOVE` + fresh passkey; does the sandbox accept `PATCH /ibans` to a `basesepolia` address?
- [ ] Approves only after the re-read lists the IBAN on the Safe; else `iban_pending`
- [ ] Another Zold account showing that IBAN loses it
- [ ] Dialog: one partner mention, "move it back later" (bug #8)

## 4. Money in
- [x] Faucet "Add money": 100 test EURe [LIVE on Base Sepolia, 2026-10-03]
- [x] `/faucet` drip EURe / USDC / EURC [LIVE on Base Sepolia, 2026-10-03]
- [x] Sandbox SEPA in → EURe minted → activity + Monerium order [LIVE, 2026-10-03]
- [ ] EURe sent on chain → recorded as funding — fix in the bug PR; retest after the redeploy
- [ ] Monerium webhook updates the order before the poller
- [ ] "From a crypto wallet": Safe address + QR of that address (bug #9) — fix in the bug PR; retest after the redeploy
- [ ] BIC is Monerium's everywhere, never LHVBEE22 (bug #14)

## 5. Money out — SEPA send [NEVER end to end]
- [ ] New payee: IBAN checksum, name required
- [ ] Amount: 0, negative, decimals, over balance, over €2,500/day (Z-015)
- [ ] Quote: fee €0, expires at 10 min, re-quote
- [ ] Device key bound with passkey step-up; Security shows PRF or not
- [ ] Three prompts: device-key EIP-712, passkey userOp, passkey redeem message
- [ ] CREATED → DEBITED → PAYOUT_SUBMITTED → PAID; payee sees reference + "Powered by Zold"
- [ ] Monerium 4xx → FAILED → REFUNDED
- [ ] Timeout / duplicate → MANUAL_REVIEW, no auto-refund, shows in admin Errors
- [ ] Send to your own IBAN
- [ ] Cash corridor hidden; cash quote → 503 RAIL_CLOSED [OFF]
- [ ] Crypto out SOON; "Zold account" opens a pre-filled SEPA send

## 6. Gas modes
- [ ] `sponsored` (default)
- [ ] `native` and `token` — needs a redeploy with `SAFE_GAS_PAYMENT` changed

## 7. Getting paid
Payment page [LIVE]
- [x] Claim handle; display name not the legal name by default
- [ ] `/pay/<handle>`: one USDC address (= Safe), QR, "Open in wallet", says it is public
- [ ] Public JSON only has allowlisted fields

Payment links [NEVER on real money]
- [ ] Fixed / open amount; crypto / bank / both; 7-day expiry
- [ ] Right code, wrong handle → 404
- [ ] Share: URL last on its own line; junk after the code → clean URL (bug #11)
- [ ] Crypto: exact USDC → PAID; ≤50 bps underpay; partial from 20%; overpay ≤10%; two open quotes get distinct amounts
- [ ] Bank: SEPA with code in memo → PAID
- [ ] Cancel; expired link refuses
- [ ] Company link only by the backing member; payer sees company name

Crypto deposits / auto-convert [NEVER]
- [ ] USDC deposit after 2 confirmations, EUR value at arrival; no rate → no value
- [ ] Auto-convert on → "Awaiting approval" → Convert → passkey → swap; >100 bps off mid refused; credited EURe measured
- [ ] Auto-convert off / settle as USDC → settled as USDC

Receipt shares [LIVE]
- [x] Each toggle removes the field from the JSON, not just the page
- [x] Revoke; simulated hops flagged
- [ ] 30-day expiry (no share is 30 days old yet)

## 8. Recovery and signers
- [ ] Zoldenburg enrol / remove / decline [NEVER on chain]
- [ ] Lost device → reference → admin guardian check → hardware-wallet sign → execute → grace → finalize [NEVER on chain]
- [ ] Old device cancels in grace; new credential cannot spend before finalize
- [ ] Email/SMS recovery hidden [OFF]
- [ ] Own second owner → threshold > 1 → every op refused
- [ ] Spending-limit delegate add / remove
- [ ] "Recovery isn't set up" banner, dismissable (bug #12)

## 9. Account documents [LIVE]
- [ ] Receipt, statement, balance confirmation, proof of ownership (+ Safe signature)
- [ ] `/v/<code>` re-verifies every visit; revoked doc fails, still resolves
- [ ] Statement has the €100 deposit; reconcile notice coherent (16)
- [ ] Ownership proof readable by a bank (16)
- [ ] Same from /business → Accounts → Statements and documents

## 10. Business layer
- [ ] Create org; edit legal name, tax ID, address, currency, timezone
- [ ] Trial once (30 days); downgrade keeps data; paid plan → 402; operator grant works
- [ ] Invite link (no email), accept with matching email only, 3-day, one-time
- [ ] Role matrix: viewer / accountant / payer / admin / owner allowed + refused; non-member → 404
- [ ] Last owner cannot be demoted or deactivated
- [ ] Open EUR account; gated currencies → `gated`; "Available on Zold" (bug #3)
- [ ] Account row shows company-profile state (bug #2)
- [ ] Contacts CRUD with per-rail validation
- [ ] Drafts: submit → review (≠ drafter) → execute by backing user → one SEPA per line [NEVER moved money]
- [ ] Editing a draft makes you drafter; payee edit after approval → INVALID_DATA
- [ ] Bulk CSV import (500 rows)
- [ ] Business Send completes a passkey send (doc says it may not)
- [ ] /app company switch: approve / send back
- [ ] Settings tiles; Shopify under Connections; Coming soon stays in /business
- [ ] Balance only for the backing member
- [ ] Imported wallets add / remove, say "never syncs"
- [ ] Cmd/Ctrl-K search

## 11. Invoicing
- [ ] Invoice-Me (± password) → supplier submits → Pay → draft → four eyes → PAID [PAID never run]
- [ ] Outgoing: DE / EU / GENERIC checks, warnings recorded, issue → frozen sheet
- [ ] VIES with a valid VAT ID [NEVER valid live]
- [ ] Foreign currency freezes EUR restatement; no rate → no issue
- [ ] Invoice IBAN defaults to account IBAN, warns if different (bug #6)
- [ ] Payment link on an issued invoice → PAID; partial stays SUBMITTED
- [ ] SEPA memo with invoice number settles it
- [ ] Reconcile; soft delete

## 12. Bookkeeping
- [ ] Lines: SEPA in, SEPA out (+fee), refund pair, USDC held / converted
- [ ] Rebuild idempotent; human account code never overwritten
- [ ] Prepare month → Belege → `/v/<code>` + `beleg.pdf`
- [ ] Lexware CSV imports into Lexware; Belege ZIP naming
- [ ] Chart of accounts, rules, ledger edit, assets, monthly report, ledger CSV
- [ ] GetMyInvoices key verified; push a month [NEVER uploaded]

## 13. Add-ons
- [ ] Gnosis Pay (EU_FULL): SIWE, account, transactions, disconnect [NEVER] — test before December, when Gnosis Pay discontinues it
- [ ] Privacy bundle → `pending_fulfillment`, cancel
- [ ] Shopify card says not available [OFF]

## 14. Operator console /admin
- [ ] Token required; separate admin rate bucket
- [ ] Overview, Users (stage filter), Monerium (live read audited), Transactions, Recoveries, Errors

## 15. Cross-cutting
- [ ] Desktop ≥1024px (bug #13), phone width, dark mode
- [ ] PWA install Android / desktop; iOS install [NEVER — storage may split from Safari]
- [ ] Offline shell loads; no money action offline
- [ ] Rate limits on codes and slugs
- [ ] Two tabs / two devices: no stale state, no double send

## Not testable on this deployment
Mainnet (no 8453 entry), cash rail, Shopify, Candide forwarder, email/SMS
recovery, email verification, billing. Closing the Akash lease deletes every
tester's account.
