# What has never run

Read before claiming anything works end to end. Linked from `AGENTS.md`.

Say this plainly rather than letting the surface imply otherwise:

- **No mainnet deploy.** No 8453 entry in `deployments.json`; needs funded
  operator keys the user holds.
- **The testnet faucet has not sent on Base Sepolia.** `faucet:test` proves it
  on hardhat; the zoldhq.com deployment has not run it yet.
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
  `monerium:profile:test`. Which profile a login uses is fixed at connect
  by its signup kind (personal or corporate, the other kind never), so a
  company needs its own Zold login. A founder who signed up personally and
  wants a company IBAN is sent to support@zoldhq.com for a separate account
  with its own Safe, set up by hand; no such account has been set up yet.
  A wrong-kind OAuth login is refused only after the user has signed in at
  Monerium (its `/auth` takes no profile kind; the signup email is
  prefilled). Whether Monerium then keeps them signed in, so that "connect
  again" returns the same login until they sign out there, is unverified.
  Logins connected before this rule are not re-read: one connected to a
  profile of the other kind keeps it until it reconnects.
  The check gates sending only: invoices and pay links still receive into
  an account whose profile has not been checked.
- **The VIES lookup of a customer's VAT ID** (`adapters/vies.ts`) has run
  against the real service once, by hand: a made-up Austrian number on
  2026-10-02 answered `valid: false` in the shape the client parses. No valid
  number and no consultation number (`requestIdentifier`, only given when our
  own VAT ID is sent as requester) has been seen live. The suggested treatment
  (`suggestTreatment`) covers domestic, EU B2B/B2C and non-EU cases; OSS and
  § 13b domestic reverse charge are not worked out.
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
- **No Candide forwarder has forwarded a deposit.** Candide routes nothing on
  testnets, so zoldhq.com's payment pages show the Safe itself; the
  multi-chain token list, minimums and TTL renewal run only against a stub
  (`forwarder:test`).
- **Importing an existing Safe** (`routes/safe-import.ts`,
  `npm run safe:import-tx`) has run only on Base Sepolia, with a throwaway
  EOA and a software P-256 key standing in for the passkey (2026-09-30, two
  runs). Observed: an EOA-owned Safe deployed with SafeMultiChainSigAccountV1's
  factory and 4337 setup; `prepare`; the script's direct `execTransaction`
  from the EOA; `confirm` deploying the verifier from the deployer and binding
  the account; a passkey-signed UserOperation moving 0.01 USDC out of the
  imported Safe (tx `0xf60dd7d7…`, userOp `0x5f4d6a79…`, sponsored gas); and
  Monerium's sandbox `POST /addresses` linking that Safe on `basesepolia`
  (state `linked`) with the link message signed that way. The link used the
  app's client-credentials token, so it landed on the app's own sandbox
  profile, not through a user's OAuth. The same call with a signature made
  for another Safe was refused 400 "Invalid signature: … GS024": Monerium
  checks ERC-1271 on the Safe. Never run: a real passkey, the Transaction
  Builder JSON on app.safe.global (its checksum is written from the
  tx-builder source, untested), a hardware wallet sending the owner change,
  an IBAN on an imported Safe, and anything on Base mainnet — Zoldenburg's
  Safe has not been touched. The onboarding screens for it (a company
  account's choice after the passkey, then address → owner change → confirm)
  have run only in the browser pane against a canned API, never against a
  chain, with a real passkey, or through a user's Monerium OAuth. Recovery
  has never run on an imported Safe, so the screens do not offer it there;
  the API does not refuse it.
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

