# What has never run

Read before claiming anything works end to end. Linked from `AGENTS.md`.

Say this plainly rather than letting the surface imply otherwise:

- **Mainnet has one user, the owner** (app.zoldhq.com, behind Cloudflare
  Access; technical-architecture §18.1). Its operator keys are not yet keys held for
  real customers. Monerium production issues the owner's IBAN on their own
  production API keys (client credentials, not OAuth).
- **One SEPA round in and out has run on mainnet, for the owner only.**
  The bank transfer in (€1,087) and the SEPA payout out (€1,000) are the
  owner's statement; the mints and the burn are read back on chain
  (2026-10-27) in the app's mainnet Safe `0xc1409bd66B9719A61A2139F093B58d29D9fC232F`,
  in use from 2026-10-26 (its deployment date is not checked here):
  - In: 992 EURe and 95 EURe minted by Monerium on 2026-10-26 at 02:25:15
    UTC, block 53096084, txs `0x0625769295ab82a76cdd5722cbf620b07f2f6324a75dcd05d665faea369a12cd`
    and `0xe1b573af5b7670ffce8092f9a6c9fe6765df54eeaecb1844a253c94f3e8041ce`.
  - Out: 1,000 EURe burned from the Safe at 05:52:25 UTC, block 53102299,
    tx `0xcfe881ef7d40f809e96666b2d3e8b6e392e825863fc831277754b8f557fe8d99`.
    Monerium's account sent the burn (`burn(from, amount, hash,
    signature)`), not a userOp. The Safe's `isValidSignature` accepts that
    hash and signature, made by its only owner, the passkey signer
    (threshold 1): the passkey signed the redeem order. The order's text is
    only a hash on chain, so the bank credit is the owner's statement. 87
    EURe stay in the Safe.
  - The books matched: one verifying Beleg per line, and Books' net +87
    equals the chain (the owner's check).
  - Monerium order ids: pending owner.
  The Safe has no other token transfer on chain (Blockscout lists three).
  Mainnet ran the production build from before #485.
- **The owner's 1 € recovery enrolment** came in by bank transfer to an
  earlier owner Safe on Base mainnet, not the one above, minted as 1 EURe
  (read back on chain 2026-10-12, 0.8914 → 1.8914 EURe).
- **No ENS name has resolved through a live resolver.** The OffchainResolver
  and the gateway pass end to end on local hardhat (`test:contracts`). The
  resolver is deployed on Sepolia (`docs/ens.md`; read back on-chain
  2026-10-08), but none on mainnet, the zoldhq.com host does not run the
  gateway, zoldhq.com has no DNSSEC/ENS TXT record, and the DNS path through
  ENS's OffchainDNSResolver has never run. No wallet or ENS client has
  resolved a name. `/api/ens/lookup` has never been called against a real
  ENS RPC. Home shows a user's name only once `ENS_NAMES_LIVE=1` is set,
  which no deployment has.
- **No crypto send has run on any chain.** Sending EURe or USDC from the
  Safe to an ENS name or 0x address (`routes/crypto-sends.ts`) has run only
  in `crypto-send:test`, against the hardhat stand-in for the Safe
  operation and a stubbed resolver. No name has been resolved, re-checked
  and paid for real. It is off unless `CRYPTO_SEND_ENABLED=1`. The books
  carry a USDC send at the mid when sent, without its disposal gain or loss
  against the receipt value. An unconfirmed submission has no reconciler,
  and is not booked: it stays SUBMITTED even if it lands.
- **One real swap has run: 1 USDC to EURe in the earlier owner Safe on Base
  mainnet (2026-10-11).** Read back on chain 2026-10-12, before the 1 €
  below arrived: the Safe held 0 USDC and 0.8914 EURe. Which venue filled it and the gas it used are in
  the deposit's record on the lease, not checked here. No swap for a send
  has run, and no send has exercised execution → debit on either chain.
- **Converting held USDC has run once, on mainnet** (the swap above): a
  1 USDC payment to the owner's payment page with "ask me to convert" on,
  then prepare → passkey → convert through Candide's bundler with sponsored
  gas. The swap's EURe output reaches the Safe as a Transfer like any
  other; Activity, the books and the watcher leave out a recorded
  conversion's transaction, so it is not a second payment. A partial fill, a refusal
  and an unconfirmed conversion have run only on hardhat. Automatic
  conversion with "ask me" off has never run. The receipt and disposal
  statement lines have not been reviewed by a Steuerberater.
- **The cash rail has never opened.** Bridge live mode is entirely unexercised,
  CCTP has never executed live, and the anchor-attribution half of the Stellar
  payout has never run — only the on-ledger payment half is proven (tx
  `60528481…`, ledger 3965805). testanchor never publishes
  `withdraw_anchor_account`, so MoneyGram's own anchor is where the bugs will be.
- **The Privacy Bundle (eSIM + VPN) has never been sold.** No billing exists
  and neither Kokio nor Mysterium has been called. `capabilities.privacyBundle`
  is false unless `PRIVACY_BUNDLE_ENABLED`, `KOKIO_LIVE` and `MYSTERIUM_LIVE`
  are all `1`; while false the app hides the offer and the subscribe route
  refuses.
- **No checkout service has called the service read or received the webhook.**
  `GET /api/service/checkout/transfers/:id`, credential rotation and the
  signed state-change webhook have run only in `checkout-service:test`; no
  credential has been issued on zoldhq.com.
- **No Monerium production OAuth app is registered.** The only production
  credentials used are the owner's own API keys (above). The OAuth cookie
  binding and the refresh client-id change are unproven against the real
  server.
- **Moving an existing Monerium IBAN** (`POST /users/:id/monerium/move-iban`,
  `PATCH /ibans/{iban}`) has run only against the fake Monerium in the
  oauth/apikeys suites, never against Monerium's real sandbox. Whether the
  sandbox allows PATCH to a `basesepolia` address is unverified, and so is
  the `profile` field on GET /ibans items that the move and the
  `IBAN_EXISTS_ELSEWHERE` answer rely on (without it both refuse).
- **Noticing an IBAN moved away** (`verifyIbanBinding`: an active account's
  IBAN that Monerium now lists on another address or chain is taken off the
  account, which then offers "Move IBAN back to Zold") has run only against
  the fake Monerium in `monerium:iban-binding:test` and the apikeys suite.
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
  default mode. Merchant links (a shop linked through the checkout service)
  are tested in core against stubs (`merchant-links:test`); no store has been
  linked, the checkout's Shopify adapter has never run, and no payment has
  arrived through one.
- **No Zoldenburg recovery has run on chain**: no guardian added, no relayed
  signature, no finalisation, and Safe Cover has not been used against a Zold
  Safe. `recovery:test` runs the flow under the harness only.
- **One real 1 € enrolment has been paid, and whether it armed the account
  is not checked here.** The owner's euro reached the earlier owner Safe
  on Base mainnet (above); matching it to the code, the live name match and the
  armed state are in the lease's records, which nothing outside the lease
  reads (there is no mainnet admin). `enrolment:test` runs the matching
  against stub orders. `RECOVERY_IBAN_HMAC_KEY` must be set on a deployment
  before any account there can arm; until then the operator can sign for
  nobody.
- **No recovery-time 1 € has passed.** `recovery-bank:test` runs the check
  against stub orders; the person's screen was looked at with staged state
  only. No Didit ID check exists yet: today the operator's signature needs
  the armed account and the recovery 1 €, plus their own check of the person.
- **No Candide recovery service has been called** (stub only); no on-chain
  guardian add, execute or finalise, no real OTP.
- **Turnkey has never been called: no Google or Apple login has come back
  to `/guardian`, `/recovery` or signup, no email code has been sent, and no
  recovery passkey made.** Adding such a guardian and recovering with one run
  only against stubs (`turnkey:test`, `turnkey-page:test`,
  `turnkey-recovery:test`); no sub-org, login, guardian add, Turnkey
  signature or relayed recovery exists. `TURNKEY_GUARDIANS` is off, so
  neither these options on /guardian and signup nor the recovery fallback
  on /recovery shows. The /recovery page itself (all guardians) has never
  driven a real recovery. No DPA with Turnkey is signed.
- **One Candide forward has run, on the same chain.** On 2026-10-11 the
  owner paid 1 USDC on Base to their app.zoldhq.com payment page's forwarding
  address, and it reached the earlier owner Safe (the conversion above spent it there).
  No forward from another chain has run, and the minimums and TTL renewal
  run only against a stub (`forwarder:test`, `paylinks:test`). Candide routes
  nothing on testnets, so zoldhq.com's payment pages show the Safe itself.
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
- **One mail transport exists, on zoldhq.com only.** `adapters/mailer.ts`
  sends email verification codes, the owner's recovery alerts
  (`recovery/owner-alerts.ts`) and, to a confirmed address, the note that a
  supplier submitted a requested invoice (`routes/business/invoice-links.ts`)
  over SMTP, with `EMAIL_VERIFICATION=1` (docs/email-verification.md). No
  recovery alert or invoice note has been sent for real. zoldhq.com sends through Brevo's relay
  (`smtp-relay.brevo.com:587`) as `no-reply@zoldhq.com`, with Brevo's DKIM on
  zoldhq.com and Brevo's IP allowlist on. One real code has been delivered and
  confirmed (2026-10-10, a new test account, to a duck.com forwarding
  address); the request that first sent it came back as a gateway 502 with no
  body, and the cause was not found. No processing agreement with Brevo is
  recorded here yet, and Brevo is not in the privacy notice. Invitations
  and invoice links are never sent by Zold; routes return the token to the
  caller and say so. Do not add a "we emailed them"
  string for those without routing them through the mailer.
- **Imported-wallet sync has run only against local hardhat** (2026-10-03:
  mints in and a send out were booked, unpriced). It has never read mainnet,
  and the DefiLlama price feed has never been called live. A wallet syncs only
  on a chain with `WALLET_SYNC_RPC_<chainId>` set; the deployment sets none,
  so every imported wallet shows "Not syncing". Native ETH, NFTs and rebasing
  balances are not booked. The Uniswap and CoinGecko token lists have never
  been fetched by the server (shape checked by hand 2026-10-03). A token on
  no list books nothing; a listed but thinly traded token the feed prices at
  confidence ≥ 0.9 is booked at that price, and a token later dropped from
  the lists books nothing from then on, unflagged. An organisation's books stop at
  `CEILINGS.ledgerRowsPerOrg` (100,000): sync pauses with the reason on the
  wallet and resumes from the same block once the ceiling is raised. One
  person owns at most 20 business orgs; a second account, or handing an
  org's ownership to one, still gets around that.
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
- **PWA install on iOS is untested**: a home-screen web app may get storage
  separate from Safari, and the device key lives in localStorage — onboarding in
  Safari then installing could strand an account.
- Timeout values everywhere were chosen, not measured.

**PARKED, and it gates one customer**: merchant-book privacy. One Safe per
account means anyone who ever paid a merchant can read every incoming payment
and the balance in an explorer. Per-order forwarding does not fix it (same Safe,
one hop later); stealth Safes do, and that is weeks of work. Do not put the
Shopify path in front of a privacy-sensitive merchant until it exists.

