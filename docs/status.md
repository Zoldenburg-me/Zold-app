# What has never run

Read before claiming anything works end to end. Linked from `AGENTS.md`.

Say this plainly rather than letting the surface imply otherwise:

- **No mainnet deploy.** No 8453 entry in `deployments.json`; needs funded
  operator keys the user holds.
- **No real money has moved through a swap.** No dex/LI.FI/RFQ/CoW swap has
  executed; no Base Sepolia send has exercised execution → debit.
- **The cash rail has never opened.** Bridge live mode is entirely unexercised,
  CCTP has never executed live, and the anchor-attribution half of the Stellar
  payout has never run — only the on-ledger payment half is proven (tx
  `60528481…`, ledger 3965805). testanchor never publishes
  `withdraw_anchor_account`, so MoneyGram's own anchor is where the bugs will be.
- **No real Monerium production OAuth app is registered**, and no real
  client-credentials token has been used. The OAuth cookie binding and the
  refresh client-id change are unproven against the real server.
- **Moving an existing Monerium IBAN** (`POST /users/:id/monerium/move-iban`,
  `PATCH /ibans/{iban}`) has run only against the fake Monerium in the
  oauth/apikeys suites, never against Monerium's real sandbox. Whether the
  sandbox allows PATCH to a `basesepolia` address is unverified, and so is
  the `profile` field on GET /ibans items that the move and the
  `IBAN_EXISTS_ELSEWHERE` answer rely on (without it both refuse).
- **The Monerium profile-kind check has never read a corporate profile.**
  The app's sandbox login holds only `personal` profiles (none approved, read
  2026-09-30), so the corporate path and the `name` a corporate profile
  carries have run only against the fake Monerium in
  `monerium:profile:test`. Choosing among several profiles on one Monerium
  login is not built: the user's one recorded profile is checked, so a
  company needs its own Zold login connected to its corporate profile.
  The check gates sending only: invoices and pay links still receive into
  an account whose profile has not been checked.
- **Open questions for Monerium** about the profile-kind rule:
  - Which terms apply to sole traders and freelancers, who are not legal
    persons: Personal or Business? Today a business org requires `corporate`.
  - Can one Safe address be linked to two profiles?
  - Does an invoice refund fall under Personal Terms §16's ban on receiving
    and sending back the same amount to the same customer?
- **No Shopify app is registered** and no store has installed one; the
  payments-app route additionally needs approval into Shopify's Payments Apps
  program, which is uncertain, not merely slow — hence `custom-app` is the
  default mode.
- **No Zoldenburg recovery has run on chain**: no guardian added, no relayed
  signature, no finalisation, and Safe Cover has not been used against a Zold
  Safe. `recovery:test` runs the flow under the harness only.
- **No Candide recovery service has been called** (stub only); no on-chain
  guardian add, execute or finalise, no real OTP.
- **No mail transport exists.** Invitations, invoice links and recovery emails
  are never sent by Zold; routes return the token to the caller and say so. Do
  not add a "we emailed them" string without adding a transport.
- **Imported wallets never sync** (`sync.status` stays `pending`), so the ledger
  is empty and the screens say so.
- **No billing is taken for paid plans.**
- **PWA install on iOS is untested**: a home-screen web app may get storage
  separate from Safari, and the device key lives in localStorage — onboarding in
  Safari then installing could strand an account.
- Timeout values everywhere were chosen, not measured.

**PARKED, and it gates one customer**: merchant-book privacy. One Safe per
account means anyone who ever paid a merchant can read every incoming payment
and the balance in an explorer. Per-order forwarding does not fix it (same Safe,
one hop later); stealth Safes do, and that is weeks of work. Do not put the
Shopify path in front of a privacy-sensitive merchant until it exists.

