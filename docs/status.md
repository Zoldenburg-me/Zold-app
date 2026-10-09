# What has never run

Read before claiming anything works end to end. Linked from `AGENTS.md`.

Say this plainly rather than letting the surface imply otherwise:

- **No mainnet deploy.** No 8453 entry in `deployments.json`; needs funded
  operator keys the user holds.
- **No ENS name has resolved through a live resolver.** The OffchainResolver
  and the gateway pass end to end on local hardhat (`test:contracts`). The
  resolver is deployed on Sepolia (`docs/ens.md`; read back on-chain
  2026-10-08), but none on mainnet, the zoldhq.com host does not run the
  gateway, zoldhq.com has no DNSSEC/ENS TXT record, and the DNS path through
  ENS's OffchainDNSResolver has never run. No wallet or ENS client has
  resolved a name. `/api/ens/lookup` has never been called against a real
  ENS RPC.
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
- **The Monerium profile-kind check has read one corporate profile, never an
  approved one.** On 2026-10-03 a company signup on zoldhq.com connected by
  its own OAuth to a `corporate` sandbox profile in state `pending`, its
  `name` came through, and Monerium issued the Safe's IBAN on that profile.
  An approved corporate profile has never been seen, and the pending-profile
  pass and the document holder name built on that case have run only
  against the fake Monerium in `monerium:profile:test` until they are
  deployed. The app's own sandbox login holds only `personal` profiles. Which profile a login uses is fixed at connect
  by its signup kind (personal or corporate, the other kind never), so a
  company needs its own Zold login. A founder who signed up personally and
  wants a company IBAN is sent to support@zoldhq.com for a separate account
  with its own Safe, set up by hand; no such account has been set up yet.
  A wrong-kind OAuth login is refused only after the user has signed in at
  Monerium (its `/auth` takes no profile kind; the signup email is
  prefilled). Monerium keeps that login until the user signs out there or
  the session expires, so "connect again" returns the same login until then;
  the refusal and the activation screen both say to sign out first.
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
  (`forwarder:test`, `paylinks:test`).
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
  checks ERC-1271 on the Safe. One company account on zoldhq.com (the
  2026-10-03 testing round) then ran the whole path for real: the onboarding
  screens with a real passkey, the owner change through the Transaction
  Builder JSON on app.safe.global, confirm, and the user's own Monerium
  OAuth, after which Monerium issued an IBAN paying into the imported Safe
  (on a `pending` corporate profile). The deployed app then mishandled that
  IBAN — it labelled the Safe personal, showed the account active in /app
  and not open in /business, and named the user rather than the company on
  documents; the fixes are not deployed, so an IBAN on an imported Safe has
  not yet worked end to end. The runs above did not include confirm's
  passkey approval (`safe.import` step-up, bound to the Safe and its owners);
  it has run only in the offline suites. Never run: a hardware wallet sending
  the owner change, and anything on Base mainnet — Zoldenburg's Safe has
  not been touched. Recovery
  has never run on an imported Safe, so the screens do not offer it there;
  the API does not refuse it.
- **One mail transport exists, and it is off.** `adapters/mailer.ts` sends
  only email verification codes over SMTP, and only with
  `EMAIL_VERIFICATION=1` (docs/email-verification.md). It has run only against
  a fake SMTP server in `email:test`; no real mail has been sent. Invitations,
  invoice links and recovery emails are still never sent by Zold; routes
  return the token to the caller and say so. Do not add a "we emailed them"
  string for those without routing them through the mailer.
- **Imported-wallet sync has run only against local hardhat** (2026-10-03:
  mints in and a send out were booked, unpriced). It has never read mainnet,
  and the DefiLlama price feed has never been called live. A wallet syncs only
  on a chain with `WALLET_SYNC_RPC_<chainId>` set; the deployment sets none,
  so every imported wallet shows "Not syncing". Native ETH, NFTs and rebasing
  balances are not booked. The Uniswap and CoinGecko token lists have never
  been fetched by the server (shape checked by hand 2026-10-03). A token on
  no list is booked as a quantity with no value and no income rule; a listed
  but thinly traded token the feed prices at confidence ≥ 0.9 is booked at
  that price. Nothing caps rows per wallet.
- **Invoices made from wallet receipts have run only against local hardhat**
  (2026-10-03: a payer rule saved, one EURe receipt of €300.00 collected into
  a draft, two unlisted-token receipts listed as not included, and the draft
  issued and marked paid, all through the business screens). No draft has
  been made from a mainnet receipt, and no priced governance-token receipt
  has reached one, because the price feed has never run live. Nothing runs the collection on a schedule: a
  member starts it per month. A receipt booked without a value gets one only
  when a member asks the price feed again for it (Holdings, "Ask again"),
  which has run only against a stub feed. The tax line on a
  payer rule is whatever the organisation chose; nothing checks it suits the
  payer. A receipt that is a refund from a payer with a rule is drafted like
  any other receipt.
- **Wallet ownership proofs have been checked only on local hardhat**, against
  a test contract that answers EIP-1271 like a Safe without the Safe's
  SafeMessage wrapping, and with ordinary hardhat keys. No real Safe's
  `isValidSignature` has been asked, neither for owner signatures pasted from
  Safe{Wallet} nor for a message signed on chain, and nothing confirms that
  Safe{Wallet} shows a signature in a form the screen accepts. Every
  deployment wallet is unproven until someone proves it, so no deployed
  receipt is collected into a draft before then. A proof is checked again
  when a member asks and when a draft from receipts is issued; nothing
  re-checks on a schedule, so collecting reads the last answer. A message a
  Safe signed on chain stays valid after its owners change, so such a proof
  does not lapse when the Safe changes hands.
- **Holdings and realised gains have run only on fixtures and local
  hardhat.** No priced governance token has been bought, sold or swapped
  through them, so no gain on screen comes from a real disposal. Lots are
  pooled per token contract per chain across the organisation's wallets; a
  bridge to another chain reads as a sale and a purchase, and a swap as two
  unpaired legs. Whether any of that is how the disposals should be taxed is
  for the tax adviser.
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

