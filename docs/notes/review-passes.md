# Review passes and the mainnet-ready cut

What the sweeps found and fixed. History: useful when a guard looks arbitrary.

*Decision history: the reasoning behind the current invariants, kept as written
apart from naming.*

## MAINNET-READY — the training wheels are gone (Sep 2026)

READ THIS BEFORE ANY SECTION IN docs/notes/ THAT MENTIONS mock IBANs, simulated
deposits, `/api/simulate/*`, ALLOW_SIMULATION, ALLOW_MOCK_FALLBACK,
KYC_AUTO_APPROVE, the mock-review route, Sumsub, `new_monerium`, whitelabel
profile creation, provisionFunding, the testnet faucet, the BridgeEscrow
dry-run leg, `moneygram-mock` pickups, FORCE_FAIL_STEP, or `funding.mode ===
"mock"`. ALL OF IT IS DELETED. Those sections
are kept as history of why the invariants exist; the code paths do not.

WHAT A DEPLOYMENT IS NOW:
 - Defaults are Base mainnet (8453, https://mainnet.base.org) and Monerium
   PRODUCTION (api.monerium.app, chain name `base`). Candide's chain follows
   TRANSF_CHAIN_ID and its public bundler/paymaster are addressed by that id
   (8453 answers eth_supportedEntryPoints — checked). Uniswap v3 defaults are
   the Base MAINNET Factory/SwapRouter02/QuoterV2, verified with eth_getCode.
   Stellar defaults to the public network. `deployments.json` on a real chain
   holds ONLY Monerium's EURe and Circle's USDC (`npm run deploy` verifies code
   at both and deploys nothing; DEPLOY_USDC_ADDRESS overrides). FxSwapper,
   BridgeEscrow and AdminTimelock are hardhat-only fixtures; `swapper`/`bridge`
   are optional in the Deployments type and `swapperAddress()` throws off
   hardhat. NO 8453 ENTRY EXISTS YET — run `npm run deploy` with
   TRANSF_CHAIN_ID=8453 and real operator keys before `npm run api` there.
 - IDENTITY IS MONERIUM'S. Onboarding = account → passkey (REQUIRED, the skip
   is gone) → Safe deployed → the gate offers exactly two routes: "Sign up or
   sign in with Monerium" (OAuth) or "Add Monerium API keys" (the connector
   from the previous section, inline in the gate) → "Activate IBAN with
   passkey". Approval happens ONLY in /monerium/activate (address-matched IBAN
   on the connected account) or at api-keys connect when the account already
   attributes an IBAN to the Safe. POST /api/users always creates `pending`
   with no IBAN. `viaApp` activation (the app creating a profile for the user)
   returns 409. /api/kyc/review, applyKycDecision, /funding-onboarding-path,
   /sumsub/*, /webhooks/sumsub, /admin/users/:id/issue-iban are gone.
 - MONEY ONLY MOVES FOR REAL. submitSafeExecution has no fake hash; candide.ts
   has no fake challenges and isDeployed() always asks the RPC. The SEPA rail
   refuses BEFORE the fee debit when the user has no Monerium connection and
   fails closed (refund) when the redeem is refused. The cash rail is CLOSED
   unless `cashRailOpen()` (BRIDGE_LIVE + an anchor): /api/quotes answers 503
   RAIL_CLOSED, executeTransfer throws before any debit, the app hides the
   corridor (capabilities.cashRail). createBridgeTransfer throws when not live.
   The anchor is the only pickup source; a failed anchor payout compensates.
 - /api/health capabilities are now { sandbox: true, moneriumOAuth,
   moneriumApiKeys, moneriumEnvironment, moneriumHost, cashRail }. `simulation`,
   `kycProvider` and `sumsub` are gone; the UI's `caps` default matches.
 - PRODUCTION CHECKS ADDED: real-money chain id, MONERIUM_BASE_URL ===
   api.monerium.app, a Monerium production chain name, at least one connection
   path (OAuth client or token-encryption key), LIFI_CHAIN_ID === chain, and a
   refusal if any removed variable (ALLOW_SIMULATION, ALLOW_MOCK_FALLBACK,
   TESTNET_FAUCET_EUR, KYC_PROVIDER, SUMSUB_APP_TOKEN) or KYC_AUTO_APPROVE=1
   is still set.

**The one harness seam that stays.** The hardhat chain (31337) has no Monerium,
so the test suites cannot approve an account through activation.
`KYC.autoApprove` honours KYC_AUTO_APPROVE=1 only when IS_LOCAL_CHAIN (31337)
and not production; every other chain ignores it and production refuses it.
Likewise `mirrorOrder` mints the hardhat MockToken only when Monerium issues no
EURe on the chain and the chain is 31337 (webhook/reconcile suites); on any
other chain such an order is logged and not recorded. Both checks are in code,
so no configuration can make them touch real money.

DELETED SUITES (they tested the removed paths): e2e, compensation, kyc, kyc-ui,
kyc-operator, bridge-dryrun, faucet, sumsub-kyc. draft-execution-test now mints
MockToken EURe to the Safe instead of calling the deleted simulate route.
`npm run check` no longer runs e2e; the remaining suites cover the seams.

NOT DONE HERE, deliberately: no mainnet deploy was run (needs funded operator
keys the owner holds), no real Monerium production OAuth app is registered (the
redirect URI must be registered at monerium.app first), Bridge/anchor live
credentials are unset so the cash rail is closed on mainnet, and the JSON file
store still needs ALLOW_PLAINTEXT_STORE=1 to be acknowledged. The other agent's
in-progress index.html work in the main checkout was not touched by this
branch and will need a merge.

## Review pass (Aug 2026)

A review swept the whole tree after the three custody
iterations; every finding was verified against the code before acting (two of
the client agent's "dead label" claims were factually wrong — check before
deleting). Fixed: /authorize now verifies the EXECUTION assertion before the
redeem assertion (the client performs that ceremony first, so the old order
read the sign counter backwards and 401'd every Safe-funded SEPA send on
counter-incrementing authenticators); a claimed-but-unrecorded debit (crash
between userOp inclusion and the DEBITED write) is swept to MANUAL_REVIEW; a
SEPA send with no Monerium configured refuses instead of mock-PAID after a
real fee debit; Bridge execute replays the exact creation body (amount is
persisted as safeSwap.bridgeAmountUsdc — the idempotency key is shared);
persisted liquidity quotes execute on the venue that priced them and an
unknown LIQUIDITY_PROVIDER throws instead of silently using FxSwapper; RFQ
validates its recipient BEFORE settling; rfq/cow reverse-side rate/probe unit
bugs; batch path enforces quote expiry. DELIBERATELY KEPT despite "dead"
reports: the desktop rail UI (parked until Noir screens, see
docs/notes/app-and-chains.md),
getBridgeTransfer + pickup.bridge* fields (the seam for the STILL-MISSING
Bridge state polling — nothing advances a live Bridge transfer after
deposit.funded), sender-profile + /users/:id/transfers routes (external API
surface). KNOWN GAPS left open, in code-comment or here only: recovery can
only be STARTED from the parked desktop settings view (mobile has no start
control); the crypto auto-convert toggle is likewise unreachable; batch-mode
surplus is structurally user-kept regardless of LIQUIDITY_SURPLUS_POLICY;
the device-signed EIP-712 `to` field still names the orchestrator even for
batches that deliver to Bridge (changing it needs a coordinated device.js
lockstep bump).

## Review and cleanup pass (Sep 2026) — attack surface, dormant code, stale text

A read-only review swept the tree (core API/auth, routes +
domain, money movement, browser code, scripts/docs); every finding was
verified against the code before acting, and the deletions below were grepped
across services/, scripts/, public/ and docs/ first. `npm run typecheck` and
the offline suites pass; see the commit for the list. Rule applied to
comments: rationale stays, comments describing removed code go.

SECURITY FIXES, each a real hole, in rough order of weight:
 - **Monerium OAuth login-CSRF.** The callback bound the code to whoever owned
   the `state`, so an attacker could start a connect on THEIR account, send
   the victim the consent link, and receive the victim's tokens (then activate
   under the victim's profile). connect/start now sets an HttpOnly SameSite=Lax
   nonce cookie scoped to /api/monerium/oauth and the callback requires it;
   monerium:oauth:test asserts the cookie-less callback is refused. Consequence:
   the connect must start in the browser that finishes it (the checkout repo
   proxies, so it is unaffected; a cross-origin fetch would not carry the
   cookie).
 - **Activation approved on the POSTs succeeding**, not on the address-matched
   IBAN — a "duplicate" answer on both proved nothing. Approval now requires
   the IBAN; iban_pending resolves through refreshPendingIban.
 - **Hand-rolled CBOR decoder had no bounds**: a 5-byte header claiming 2^32
   elements hung the event loop from one unauthenticated login. Every length
   is checked before use, nesting is capped, and an ASSERTION never runs the
   decoder at all (only the 37-byte header is parsed). Counter regression to 0
   after a positive stored counter is now the clone case and refused.
 - **Venue calldata was executed unchecked.** LI.FI's/Bebop's `tx.to`,
   approval spender and value went straight into the user-signed batch or the
   orchestrator's key — a spoofed venue answer could name the EURe contract
   and drain the Safe. `LIFI_CONTRACTS` (default: the Diamond) and
   `BEBOP_CONTRACTS` (default empty = RFQ execution refused) allowlist both,
   value must be 0. RFQ and CoW quotes now pass `assertPriceSane` like pools.
 - **Compensation blind spots**: the plain deposit transfer to Bridge was not
   in the "funds at Bridge" guard, so a later failure reverse-swapped USDC we
   no longer held; a refund tx already on record was not recognised (crash
   between the chain write and the REFUNDED write refunded twice); a SEPA
   redeem that TIMED OUT was refunded as if refused (Monerium may have placed
   it); the stranded-transfer sweep could refund a transfer whose live call was
   merely slow (no HTTP timeouts anywhere on the money path) and the late
   write then completed the payout. Fixed: `FUNDS_AT_BRIDGE_STEPS`, the
   `safe.refundTransfer` check, MoneriumApiError-4xx-only refunds, an
   in-flight set the sweep skips, `AbortSignal.timeout` on every Bridge,
   anchor and Monerium fetch, and `store.updateTransfer` refusing to move a
   REFUNDED/PAID transfer backwards. dex/lifi/rfq execute() measure delivery
   with `balanceAfterWrite` (replica-lag safe) and RFQ no longer copies
   expectedOut as the amount out. The batch path refuses when the swap
   delivered less than the Bridge transfer was created for.
 - **Org routes**: an admin could deactivate an owner (the owner check sat
   inside the role branch); four-eyes was defeatable by editing another
   person's draft lines and then reviewing them (PATCH now makes the editor the
   drafter); paying an invoice merged the supplier's self-declared name into a
   TRUSTED contact and attached the supplier's IBAN to it (classic invoice
   fraud — now IBAN-match only, else a new contact); a draft's funding source
   accepted another org's wallet id; invite acceptance did not check the
   session's email against the invited one; the Invoice-Me password compared
   with `!==` and sat on the general rate bucket; the crypto-deposit → invoice
   link read any org's invoice by id.
 - **Admin dashboard stored XSS**: rows carried `onclick="...('${jsonArg(u)}')"`
   and encodeURIComponent leaves `'`, so a signup name closed the JS string;
   the operator token sat in localStorage beside it. Rows now carry ids and a
   delegated listener; the token is sessionStorage.
 - Smaller: operator-token compares are constant-time everywhere; connect
   redirectUri is allowlisted (the configured URI or the callback on a trusted
   origin); signup/transfer inputs are typed and capped, softSignals no longer
   spreads the body; /admin and /invoice-links are on the auth bucket; a
   deployment claim is taken BEFORE the await; share URLs never come from the
   Host header; Shopify return/cancel redirects must be https; recovery's
   no-session OTP has an attempt counter and start no longer returns the
   holder's name; the service worker caches only shell paths (a slug or code
   path is a credential); `api()` in the app refuses paths outside /api/;
   `isDeployed` treats an RPC error as an error, not "not deployed".

DELETED (all unreferenced by grep): wallet groups (route, store, type, field),
`Contact.defaultAccountCodeIn/Out`, `invoicing.jurisdiction` on the org,
`US_PHONE_PREFIXES`, `formatAmount`, `formatEur`, `LABELS`, `discountNote`,
`InvoiceLineInput.unit`, the CurrencyAvailability "mock" arm and its banner,
`passkeyRequiredBeforeFunding`, `rampWallet`, `saveDeployments`,
`MONERIUM_PROFILE_ID`, `SHOPIFY_APP_URL`, `rateCacheStatus`, `AuditSink`/
`createAuditLog`, the `pan`/`bank_account` encryption purposes and `last4`,
INR from the required rate set, `safeThreshold`, `recoveryRequestsFor`,
`requireMoneriumEure`, `shortHash`, `getPickup`, `createProfile`, the batch
dry-run branch (a cash transfer cannot exist while the rail is closed), the
admin page's KYC review / issue-IBAN buttons (routes gone), the `.kyc-pick`
CSS, `hardhat.fork.config.js`, `STELLAR_SOROBAN_RPC`. Four copies of `wrap`
became routes/util.ts; `hashToken`/`ADDRESS_RE` have one home each.

DELIBERATELY KEPT: the parked desktop UI; `getBridgeTransfer` and the
`pickup.bridge*` fields; the reference routes nothing calls yet (currencies,
plans, payment-request methods, Gnosis Pay config/transactions, account rules,
ledger patch, monthly balance, CSV import) — they are API surface with domain
tests, now with their org-scoping holes closed; the legacy "mock" literals on
`funding.mode`/`sepa.mode`/`safeSwap.mode` for rows written before those paths
were removed (typed as legacy, no longer rendered as live).

ALSO: `npm run check` is now OFFLINE and `check:live` adds the three Stellar
suites, each of which imports `scripts/_stellar-testnet.ts` (pins testnet,
refuses the public passphrase — config defaults to pubnet, and with a real
treasury secret in .env `trustline:test` would have submitted mainnet
changeTrust ops). `stellar:payout:live` no longer imports `_test-env`.
`dex:setup --fix` refuses on a real-money chain without
DEX_SETUP_ALLOW_MAINNET=1 and picks the position manager per chain. The
contract suite allocates a free port. `eur-proof` runs against the sandbox
only. Invoice citations follow the issued rule set (DE paragraphs, EU
Directive articles, nothing for GENERIC) — the UStG leak CLAUDE.md said was
fixed had survived in invoice.html.

UNPROVEN, stated: the OAuth cookie binding against real Monerium (one browser
run); the venue allowlists against real LI.FI/Bebop responses (the stubs are
shaped from a captured response); every timeout value (chosen, not measured);
draft signing from /business on a passkey Safe still lacks the execution and
redeem assertions the app performs, so it fails at /authorize as before —
recorded, not fixed, because it needs the ceremony code shared between the two
pages.


## External pen test (Strix, Sep 2026) — what it found, what was already closed

A white-box assessment reported nine findings. Its fixes lived in the
tester's working tree, not in this repo, so each was re-derived here against
main as of `dcd5a9a`. Status per finding:

1. **Recovery hijack (High)** — someone who named the victim registered their
   own passkey on the open ceremony, and the victim's OTP then recovered onto
   it. ALREADY CLOSED on main by `4cb06a3` (merged the same day, likely after
   the test ran): the starting browser gets a per-request secret, every by-id
   route requires it, a stranger's start supersedes only a PASSKEY_PENDING
   request, and one past that is a 409. `6cf05de` (PR #197) then added the
   report's own fix on top: registering the passkey issues a single-use OTP
   ticket, and every code submission needs it (403 WRONG_BROWSER otherwise).
   `recovery:candide:test` covers both. What remains is griefing, not takeover: an attacker who reaches
   OTP_PENDING blocks the owner's own start until it expires. The report's
   "notify enrolled channels on start" would make that visible; not built.
2. **Invite seat takeover (High)** — acceptance matched `user.email`, which
   signup never verifies. `/api/orgs/invites/accept` now also needs
   `emailIsProven` (domain/roles.ts): a Candide email recovery channel with
   `verifiedAt` for that exact address — the one place a code was sent to it.
   Onboarding offers exactly that enrolment for the signup email, so the
   normal path is unchanged; someone who skipped it gets 403 EMAIL_UNVERIFIED
   and is told how to prove it. THE COST: on a deployment without
   RECOVERY_SERVICE_URL nobody can accept an invitation at all. The harness (`KYC.autoApprove`, 31337 only) skips it, like the
   rest of up-front identity. A product-level email verification would be the
   cleaner proof; it needs a mail transport, which does not exist.
3. **Cross-store Shopify collision (High)** — `findPaymentRequestBySource`
   now takes the shop, at all three call sites. Two-store regression in
   `shopify:orders:test` (fails on the old store, passes on the new).
4. **Order-id enumeration (High)** — `GET /api/shopify/cancel/:code` no
   longer mutates: it only redirects, and the signed `orders/cancelled`
   webhook is the only thing that cancels a Shopify request. A checkout the
   buyer abandons stays OPEN until its window (default 1h) runs out. The order
   lookup no longer returns the code or any URL built from it (`code`,
   `returnUrl`, `cancelUrl`); its `pageUrl` is the order's own `/pay` route.
   The 404 is already the same for "no request yet" and "not a Zold order"
   (the webhook opens nothing for the latter), and `/shopify/` sits on the
   tight rate bucket. STILL OPEN: that `/pay` route 302s to the pay page, so
   the code is still one redirect away from anyone naming shop + order id.
   With cancel inert it reads a page and re-quotes, nothing more. The fix is a
   short-lived per-order token in the email link and the checkout extension's
   session token on the lookup.
5. **Timelock keys co-located (Medium)** — `scripts/deploy.ts` already deploys
   FxSwapper and AdminTimelock on hardhat only; off hardhat it records token
   addresses and returns. An OLD local `deployments.json` for 84532 may still
   hold a swapper/timelock from before that change; if so, those contracts are
   governed by server keys and should be dropped from the file.
6. **Handle claim race (Medium)** — `POST /users/:id/handle` re-checks the
   handle with nothing awaited between the check and the write. Landed via
   the tester's own bot (`da9cd02`, PR #199); an identical check here was
   dropped in the merge so the route checks once.
7. **Duplicate email accounts (Low)** — the one-passkeyed-account-per-email
   rule is re-asserted at first passkey registration, not only at signup.
8. **Crypto-deposit convert encoding (Low)** — the assertion is decoded from
   base64url to bytes before `submitPasskeySafeOperation`, as transfers do.
   Untyped `req.body` is why tsc never saw it. Still unproven live (no bundler
   locally).
9. **No CSP (Low)** — `securityHeaders` adds a same-origin CSP
   (`'unsafe-inline'` for scripts remains while pages bootstrap inline),
   `frame-ancestors 'none'`, X-Frame-Options, COOP and a Permissions-Policy.

Also from its recommendations: `/api/pay/:handle/qr.svg` was shadowed by
`/pay/:handle/:code` (mounted first) and always 404'd; the code route now
passes `qr.svg` on.
