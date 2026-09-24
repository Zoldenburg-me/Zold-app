# Identity, custody and the security gate

Read before touching keys, passkeys, sessions, WebAuthn, recovery or the Monerium connection.

*Decision history: the reasoning behind the current invariants, kept as written
apart from naming.*

## Security gate (July 2026 — fix before any hosted/public demo)
Sessions+authz landed (PR #2). Origin policy, rate limits and WebAuthn verification DONE (July 2026): simulate endpoints
403 in production (ALLOW_SIMULATION=1 to override), mock fallback fail-closed
unless ALLOW_MOCK_FALLBACK=1, origin allowlist (WEBAUTHN_ORIGINS/RP_ID) +
per-IP rate limits, and full server-side WebAuthn: challenge endpoint, CBOR
attestation parsing -> COSE key stored, assertion signature+rpIdHash+counter
verified before sessions (services/api/src/webauthn.ts, selftest script
npm run webauthn:selftest). Still open, in fix order:
KYC gate (July 2026): `KYC_AUTO_APPROVE=0` / production starts users pending
and gates IBAN issuance, deposits, device binding, quotes, transfer creation,
and authorization. The browser app now shows pending/rejected/manual-review
states instead of sending those users through Monerium provisioning; add-money
and send controls remain unavailable until approved. Approval must still come
from the configured provider/operator path; the local
`/api/users/:id/kyc/mock-review` route remains dev-only self-approval.
Existing-Monerium connect DONE in code (July 2026, commit ba7c0c2 + test in
PR #41): pending users choose between connecting an existing Monerium account
and the normal identity review path. The connect flow is Authorization Code +
PKCE (S256) across five endpoints — connect/start, oauth/callback, accounts,
activate, DELETE connect. Per-user tokens are AES-256-GCM encrypted at rest
(MONERIUM_TOKEN_ENCRYPTION_KEY, required — start 503s without it) and stripped
from every API response. activate deploys/links the app Safe and requests a NEW
app IBAN; it never moves the user's existing one. npm run monerium:oauth:test
drives the loop against a stub that verifies the PKCE itself (12 checks).
UNPROVEN: nobody has connected a real Monerium account — needs the OAuth app
registered with a matching MONERIUM_REDIRECT_URI and one browser run.
Failure compensation DONE (July 2026): failures auto-compensate (escrow release + vault
re-credit at current rates, itemized deductions, REFUNDED state), startup +
5-min sweep recovers stranded transfers; FORCE_FAIL_STEP test hook and a
compensation suite (both since deleted).
!! STALE SINCE THE REMITVAULT REMOVAL (Aug 2026) — READ THIS FIRST !!
`contracts/src/RemitVault.sol` NO LONGER EXISTS. It was deleted on main by
`break/remove-remit-vault`, and that PR did not update this file, so everything
below describing RemitVault.debit / setAuthorizer / _isValidSignature describes
a contract that is gone — including the whole "Key custody completion — recovery"
section later in this file, whose steps 3 and 4 name functions you cannot call.
WHAT IS ACTUALLY TRUE NOW: the same EIP-712 PaymentAuthorization is signed by
the same browser device key, but it is verified by `assertDeviceAuthorization`
in services/api/src/orchestrator.ts using viem's verifyTypedData — in the API
process, not by bytecode. The EIP-712 domain moved to "TransF Safe Transfer"
with the user's Safe as verifyingContract.
THE SECURITY CONSEQUENCE, stated plainly because the text below claims the
opposite as VERIFIED: a wrong-key signature is no longer "rejected by the
contract itself". The server is the thing checking, but it no longer stores
user Safe owner keys; passkey Safes debit through co-signer allowances. The
device key still stops a stolen session from swapping the payee or the amount.
The recovery plan below needs rewriting against whatever replaces the vault as
the enforcement point.
USER-SIGNED EXECUTION (Aug 2026 — the regulatory doc's Change 1; supersedes an
interim per-transfer allowance that was never merged): the
ALLOWANCE MODEL IS GONE ENTIRELY. No module, no delegate, no standing or
one-time amounts — transferTokenFromSafeAllowance no longer exists. POST
/api/transfers prepares the userOp that IS the debit: an ERC-20 transfer of
the exact amount (fee only on the SEPA rail; nothing when the fee is 0) to
the orchestrator address. The passkey signs its hash at send time
(executionAssertion on /authorize, verified against the stored challenge
BEFORE the one-shot claim), the co-signer counter-signs where it is an owner,
and the orchestrator's debit leg submits it through the bundler — so a debit
failure takes the normal FAILED/compensation path. The chain enforces token,
amount AND destination; the API can dispose of nothing, ever. Legacy standing
allowances on old Safes are revoked automatically: the prepared userOp
prepends deleteAllowance when the chain shows one (CANDIDE.
allowanceModuleAddress survives only for that read). The co-signer sends no
native transactions any more — it needs NO gas. The allowance repair routes
(GET/POST /passkey-safe/allowance*) and the client's repair banner are
deleted. The CANDIDE_COSIGNER_*_ALLOWANCE_* env knobs do nothing (boot note
says so). npm run execution:test (13 checks, pure builders); compensation/e2e blocker
regexes updated to the new refusal text.
CHANGE 2 WINDOWS 1-3 DONE (same branch): the cash-rail send is ONE user-signed
batch [legacy revoke?] -> fee transfer -> approve venue -> swap, atomic — a
failed leg reverts the whole operation and nothing leaves the Safe. The swap
output goes STRAIGHT to the destination the payout leg names: Bridge's
deposit address in live mode (the Bridge transfer is created at TRANSFER
CREATION, idempotency key zold-<id>-bridge, so execute's re-create is stable;
executeTransfer asserts the deposit address still matches the batch recipient
and refuses to settle otherwise), the orchestrator only in local dry-run
(escrow demo pulls from it). Venue side is `safeSwapPlan` on the liquidity
seam: dex builds exactInputSingle calldata offline (same pool+floor as the
quote — the ONLY venue provable on Base Sepolia, needs dex:setup's pool);
lifi/rfq re-quote WITH executor=Safe + recipient baked in (their calldata
binds the taker — orchestrator-quoted calldata is NOT reusable); fx-swapper
CANNOT serve a Safe (onlyTrader, our inventory — falls back to plain debit +
orchestrator swap, so a deployment on LIQUIDITY_PROVIDER=fx-swapper keeps
windows 2-3; switch to dex/best to close them); cow refuses. usdcOut is
MEASURED as the recipient's balance delta, floor-checked against the signed
minOut. COMPENSATION: fixed a latent main bug — the "was it swapped?" check
matched only liquidity.fx-swapper.eure-usdc, so dex/rfq/lifi-swapped failures
would have "refunded" EURe the orchestrator no longer held; now prefix-matches
liquidity.*.eure-usdc. Live-batch failures after the userOp lands are
MANUAL_REVIEW always (funds are at Bridge, nothing local to reverse —
compensateTransfer guards on transfer.safeSwap.mode === "live" and
failAndCompensate on the bridge.xyz.deposit.funded step); dry-run batch
failures reverse-swap from the orchestrator exactly as before. UNPROVEN: no
real Base Sepolia send has exercised execution→debit, and no batched swap has
run against a real pool (needs dex:setup + a funded Safe); Bridge live mode
remains entirely unexercised.

Key custody: SPEND-AUTHORITY HALF DONE (July 2026, PR #11 — do not re-do
differently). RemitVault.debit
now requires an EIP-712 PaymentAuthorization signed by the account's
registered authorizer; the orchestrator role only submits and pays gas. The
authorizer key is generated in the browser (localStorage, vendored
@noble/secp256k1 + keccak in services/api/public/vendor/, import-map wired),
registered via POST /api/users/:id/authorizer (trust-on-first-use by the
ramp; only the current authorizer can rotate). Send flow is propose ->
sign-in-page -> POST /api/transfers/:id/authorize. Verified live: sandbox
onboarding bound the browser key on-chain; wrong-key signature rejected by
the contract itself. authorizerOf ALSO accepts EIP-1271 — this is the hook
for the passkey half below; build against it, not around it.
Key-custody half: user Safe owner keys are no longer stored in db.json.
Candide WebAuthn Safe owner (fromSafeWebauthn) signs the Monerium declaration
and orders via the passkey, then the passkey-owned Safe replaces the browser
EOA as the vault authorizer (no contract change needed). The send-time passkey prompt is now
the real gate: the device key is encrypted at rest with WebAuthn PRF
(HKDF -> AES-GCM, only {iv,ct} in localStorage), so each payment needs a
ceremony to unwrap; authenticators without PRF fall back to an unwrapped
key labelled protection:"none". npm run device-key:test covers the envelope
headlessly. VERIFIED NEGATIVELY (Aug 2026, real browser + real authenticator):
the authenticator reported NO PRF SUPPORT, so the device key was stored
UNWRAPPED with protection:"none". The console says so plainly
("this authenticator reports no PRF support — the device key cannot be
passkey-encrypted"), but the consequence is quiet and worth stating: on such a
device the "every payment needs a passkey ceremony to unwrap the key" property
DOES NOT HOLD. Anything that can read localStorage can spend. Treat PRF as a
per-authenticator capability to be detected and surfaced, not a guarantee of
the design. Still unverified on hardware that DOES offer PRF: that it returns
the SAME 32 bytes across ceremonies — if not, a wrapped key is unrecoverable
after reload.
Contract governance + quote binding: PARTIAL. Quote↔execution binding
DONE (services/api/src/orchestrator.ts assertQuoteRateBinding: refuses +
auto-refunds if on-chain rate drifts > FX.QUOTE_BINDING_BPS from the quote's
lockedSwapRate; npm run quote-binding:test). PR #9 landed replay/role/pause
hardening (idempotent deposits, escrow Status enum + refundTo binding,
swapper onlyTrader+pause, live-chain deploy guard). Multisig/timelock ownership DONE
(July 2026, PR #26): contracts/src/AdminTimelock.sol is an M-of-N + delay
owner of vault/swapper/escrow, so no single key can raise the daily cap,
grant itself a role, or drain swapper inventory. Emergency pause stays
instant via a separate guardian role (guardian can pause, only the timelock
can un-pause). deploy.ts transfers ownership after wiring roles;
TIMELOCK_DELAY_SECONDS / TIMELOCK_THRESHOLD configure it. Still open:
tiered/KYC-risk caps (vs global daily cap), Bebop executable quotes to
replace the mock rate.
Hardening pass (July 2026):
- AUTHORIZE RACE — was a real double-spend. Everything in
  POST /api/transfers/:id/authorize up to the first `await` runs synchronously,
  so two parallel submissions of ONE device signature both cleared the
  `state === "CREATED"` check. The vault rejected the loser's duplicate
  transferId, that revert took the compensation path, and compensation re-credited the
  sender (local RPC) while the winner completed the payout — the shared txs
  array already held the winner's `vault.debit`. Now store.claimAuthorization()
  claims the submission synchronously (nothing yields between read and write),
  and failAndCompensate never refunds a "duplicate transfer" revert — that is
  MANUAL_REVIEW. npm run authorize:test.
- Dev-only defaults stopped keying off the API host alone: LOOKS_LOCAL = loopback
  API + local RPC + chain 31337. A reverse proxy to 127.0.0.1:3000 passed the old
  test, so a hosted deploy that forgot NODE_ENV=production served simulated SEPA
  deposits, self-serve KYC approval and internal error text. The simulate routes
  additionally require a loopback socket with no forwarding headers.
- The API can hold real operator keys at last: ORCHESTRATOR_KEY / RAMP_KEY /
  DEPLOYER_KEY (DEPLOY_*_KEY accepted too). Only deploy.ts read keys from the env
  before, so the Amoy path meant hardhat's published keys holding ramp +
  orchestrator — and the ramp role can bind a payment authorizer to any account
  that has not bound one yet, so anyone could claim a new user's account and
  spend it. The device key was worth nothing in that configuration.
- Passkey re-registration now needs a step-up from the CURRENT credential (a
  stolen session token was otherwise permanent account access, silently
  replacing the real passkey); WebAuthn challenges are bound to the account; a
  step-up must carry the UV flag, and the client asks for
  userVerification: "required". npm run webauthn:selftest is 9/9.
- destinationCommitment covers the recipient NAME as well as the account
  identifier — on the cash rail the name is the payout identity. chain.ts and
  public/device.js in lockstep; this invalidates signatures issued before it.
- Monerium order ids are shape-checked and encoded before they land in the
  request path (they arrive in a webhook body, unauthenticated when no
  MONERIUM_WEBHOOK_SECRET is set).
- Smaller: per-credential rate bucket on passkey login, TRUSTED_PROXY_HOPS so
  limits key on the real client IP instead of one shared proxy address, session
  pruning + throttled lastUsedAt writes (the store was re-serialised on every
  authenticated request), AdminTimelock.execute counts only CURRENT owners'
  confirmations, and the UI escapes recipient/partner strings and refuses
  non-http(s) anchor links.
NOT verified in that pass: no solc in the review sandbox, so npm run compile,
test:contracts and e2e did not run — typecheck, webauthn:selftest and
authorize:test did. Still open from the same review: KYC approval via a
connected Monerium account is delegated trust with no identity match (now at
least auditable via kyc.applicantId), and db.json still holds senderProfile PII
in plaintext.
Launch gate: local demos fine; NOT safe hosted, with real funds, or claiming
payout finality until the security gate is done.

## Co-signer retired (Sep 2026) — supersedes step 2 below

The 2-of-2 co-signer is gone from new Safes. Reason: it could never start a
debit, but it made Zold a required party to every movement of a user's money,
and a user could not escape it by adding their own key — on a Safe, an owner
change is itself a Safe transaction at the current threshold, so the co-signer
had to sign its own bypass. Hosted production also REQUIRED it (config.ts), so
the "self-custodial" framing was not true there.

What changed:
 - passkeySafePlan plans 1-of-1 always; config.ts no longer fails without
   CANDIDE_COSIGNER_*; CANDIDE_COSIGNER_ENABLED is gone.
 - Legacy 2-of-2 Safes: POST /api/users/:id/passkey-safe/cosigner-removal
   prepares removeOwner(prev, cosigner, 1) as a Safe setup operation; the
   passkey signs, the co-signer counter-signs its own removal, and the plan is
   updated (cosignerAddress cleared, threshold 1, cosignerRemovedAt set) only
   after getOwners/getThreshold confirm it. accountForPlan addresses such a
   Safe directly, like a recovered one. Refused while a recovery is open.
 - Candide recovery installs only the new passkey (it used to carry the
   co-signer over); finalisation clears cosignerAddress to match.
 - Monerium link-signature no longer demands CANDIDE_COSIGNER_KEY for a
   passkey-only Safe (it did regardless, which blocked 1-of-1 accounts).
 - server.ts logs every account still on a 2-of-2 Safe at startup, and says
   loudly when the key they need is missing.
NOT RUN: no removal has executed on a real chain; the removeOwner calldata is
unit-tested (selector 0xf8dc5dd9, prev-owner and sentinel cases) only.

## Key custody completion — recovery (decided July 2026, 2-of-2)

THE BLOCKER: losing the browser device key permanently bricks an account.
`RemitVault.setAuthorizer` only lets the CURRENT authorizer rotate, and the
key lives in localStorage. No passkey, no support path, no ramp override
recovers it. Demonstrated live: the "Base Proof" account on Base Sepolia has
EUR 121 credited and can never spend it. Consumer smart-wallet research
consistently finds users will not fund an account without credible,
*rehearsable* recovery — so this gates launch, not polish.

THE FIX, in this order (the order is not optional):
 0. Refuse to issue an IBAN until a passkey exists. An IBAN is the point of
    no return — after it, money can arrive. DONE (passkeyRequiredBeforeFunding,
    gated on allowSimulation so e2e/local demos still run).
 1. Passkey becomes a Safe owner (abstractionkit `fromSafeWebauthn`),
    replacing the server-held user key path.
 2. Add the co-signer as a second owner, threshold 2. 2-of-2 for now —
    Privy/Turnkey cost money, so the third (social-login) signer is deferred.
    Owner actions still need both passkey and co-signer signatures. Production
    payment relays use a token-scoped AllowanceModule delegate so the API can
    move only within the configured allowance instead of holding a user owner key.
 3. setAuthorizer(safe, safe). `_isValidSignature` already accepts EIP-1271,
    so NO CONTRACT CHANGE. After this authorizerOf never changes again.
 4. Install Candide's SocialRecoveryModule with guardians. With only 2-of-2
    there is no spare signer, so guardians are REQUIRED, not optional.
 5. DONE: delete the server-held user Safe owner key path; db.json now still
    carries senderProfile PII but not user Safe owner keys.

WHY THE ORDER: steps 1-2 must precede 3. Pointing authorizerOf at a Safe while
the server owned it would have handed the database spending power over every
balance. That server-held user owner path has been removed.

VERIFIED, so nobody re-litigates it:
 - RIP-7212 (P256 precompile) is LIVE on Base Sepolia AND Base mainnet —
   tested with a real generated signature. Passkey-owned Safes need no
   verifier contract.
 - abstractionkit 0.4.0 (already a dependency) exports SocialRecoveryModule,
   SocialRecoveryModuleGracePeriodSelector, fromSafeWebauthn,
   webauthnSignatureFromAssertion, WebauthnDummySignerSignaturePair.
 - RemitVault._isValidSignature staticcalls isValidSignature for contract
   signers — the hook is already there.

WRINKLE TO DESIGN IN FROM THE START: redeemToIban signs as the Safe to burn
EURe, and runs asynchronously after the user has gone. A passkey-owned Safe
cannot be signed by the server alone. Collect BOTH signatures at send time —
the vault authorization and the Monerium redeem message. Both are fully
determined when the user approves (amount + IBAN), so nothing is signed blind.

HARD EDGE: only the current authorizer can rotate, so accounts that still
hold their device key can migrate themselves; ones that lost it never can.
This fixes the future, not the past.

BACKSTOP, NOT A PRODUCT: EURe is e-money, so Monerium's liability is to the
identified customer and holders have a redemption right at par — unlike USDC,
where Circle owes the holder nothing. Monerium also has the technical means
(EURe is a UUPS proxy they own, with mint(); no burn/recover/forceTransfer
selector exists in the deployed implementation). So a lost wallet is likely
recoverable through re-KYC and reissuance. UNCONFIRMED — not in their docs,
ask them in writing. It does not cover USDC or in-flight transfers, does not
restore the Safe, and "submit ID and wait" is not a recovery path to put in
front of someone whose salary is in the account.

## Email / SMS recovery — Candide's guardian (Sep 2026)

`npm run recovery:candide:test` (39 checks, stub service, simulated chain).
Access to Candide's Safe Recovery Service is arranged; `RECOVERY_SERVICE_URL`
is the switch, and without it the feature reports `unavailable` and every route
refuses. Code: `recovery/candide-guardian.ts` (SDK wrapper, fail-closed),
`routes/recovery-candide.ts` (both halves), recovery-module reads and setup
ops in `wallet/candide.ts`.

WHAT IT COSTS (call with Marc at Candide, 10 Sep 2026 — numbers from them, no
contract signed):
 - Bundler/paymaster free plan: 2,500 MAINNET UserOps, 90-day trial. Then
   $399/mo to stay in production.
 - The email/SMS recovery service is PRICED SEPARATELY at $600/mo for the
   server that holds the guardian key. It is NOT included in the $399.
 - So recovery costs more than the whole rest of the account infrastructure,
   and it is the one feature we cannot run ourselves without becoming the
   guardian — which puts a key that can rotate a user's Safe owner on our own
   server, the custody position this design exists to avoid.
 - 2,500 UserOps is the number to plan the trial around. Onboarding alone
   spends several per user (Safe deploy, guardian add, each send is one more),
   so the trial is worth roughly a few hundred real users, not thousands.
   Count them before the 90 days start rather than after.

WHAT IT IS: Candide holds ONE guardian key and adds it to the user's Safe via
the SocialRecoveryModule. Enrolment registers an email or phone against the
Safe — a SIWE statement the SAFE signs (EIP-1271, a passkey ceremony), then an
OTP — and a second passkey ceremony adds Candide's guardian to the module
(threshold 1). Recovery from a lost device: name the account, create a NEW
passkey on that device, pass an OTP on EVERY registered channel, Candide signs,
the service executes (sponsored), the module's grace period runs, then
finalisation swaps the Safe's owner to the new passkey.

RULES THAT CARRY WEIGHT, each with a check:
 - **The new credential lives on the RecoveryRequest, not the user, until the
   chain confirms the new owner.** Whoever holds the OTP channels can start a
   recovery — that is what they are for — but cannot sign in or spend before
   the grace period has run, which is the rightful owner's window to cancel.
   Finalisation reads `getOwners()` from the chain before binding anything.
 - **A recovery id is not a capability, and finalisation hands out no
   session** (fixed 24 Sep 2026, found by reading the code, never exercised
   live). Before: `POST /recovery/candide` returned the open request — id
   included — to ANY caller who named the email, even in GRACE_PERIOD, and
   `/finalize` (no session, no proof of the new passkey) returned a live
   bearer session once the grace period ran. So anyone who knew the email
   could race the 60 s sweep and walk into the account without ever holding
   the OTP channels or the new passkey. Now: the starting browser gets a
   random `recoverySecret` once (stored as `candide.accessHash`, sha256,
   never on the public projection) and every by-id route (`/passkey`, `/otp`,
   `/finalize`, `GET /:id`) requires it in `x-recovery-secret`; a wrong or
   missing one is a 404, same as an unknown id. A second start without the
   secret supersedes a PASSKEY_PENDING request (nothing invested yet; the new
   one still needs every OTP) and gets 409 RECOVERY_IN_PROGRESS, with no id,
   for OTP_PENDING or GRACE_PERIOD. `/finalize` returns the request only; the
   recovering browser signs in with the new passkey through the ordinary
   `/api/passkey/login`, which proves the authenticator instead of possession
   of a string. Requests created before the fix carry no hash: nobody can
   drive them by id, the sweep still finalizes them, and their new passkey
   signs in normally. The web client keeps the secret per email in
   localStorage (`zold-recovery-secret`) so a reload can resume.
 - **Module agreement.** Candide recovers through ONE module per chain
   (`getNetworkConfig().moduleAddress`); a guardian added to any other module
   is a guardian in no module, so enrolment refuses on mismatch.
 - **The 3-day/7-day/14-day modules have NO CODE on Base Sepolia** (checked
   with eth_getCode). Only the 3-minute test module `0x949d…8c66` exists there,
   so testnet must pin `CANDIDE_RECOVERY_MODULE_ADDRESS` to it; production
   refuses to boot with it. `Safe.enableModule` on a codeless address does not
   revert, so `preparePasskeySafeDeployment` now refuses before the user signs.
 - **A recovered Safe keeps its address but that address is no longer the
   counterfactual one of its owner set.** `passkeySafe.recoveredAt` makes every
   account builder use `new SafeAccount(address)` instead of re-deriving; the
   new passkey's signer verifier is deployed by the deployer key at execution
   time (permissionless factory call) so the first post-recovery UserOperation
   can validate.
 - Finalisation also unbinds the device key (only the lost device could
   rotate it) and revokes the lost device's sessions. Channel targets are
   masked on every surface, including the account payload.
 - Recoveries finalize themselves on a sweep (`RECOVERY_SWEEP_MS`); the user
   need not come back.

NOT PROVEN: no real Candide service has been called (stub only), no on-chain
guardian add / execute / finalize has run, and no real OTP has been sent. The
first live run is on Base Sepolia with the 3-minute module. Alerts
subscriptions (Candide's `Alerts` API) are NOT wired: the owner learns of a
recovery from the Profile screen's pending-recovery banner, not from an email.
The managed KYC-guardian path (operator + external signer) still exists beside
this; the two are separate modes on RecoveryRequest.

## Email required + recovery in onboarding (Sep 2026)

`npm run recovery:candide:test` carries
the signup checks (28); `npm run onboarding:test` still passes with emails on
every signup.

WHAT CHANGED, and the one-line reason for each:
 - **POST /api/users requires an email.** It is a CHANNEL, not an identity —
   Monerium still owns KYC and the passkey is still the login. It exists so a
   device that no longer has the passkey can name its account (Candide
   recovery resolves an email to an account) and so the OS passkey picker
   shows something that does not collide the way "Miriam" does. Nothing
   verifies it at signup and nothing claims to: it is verified where it is
   used, by Candide's OTP.
 - **One CLAIMABLE account per email.** A second signup on an address that
   already has a passkey is 409 `EMAIL_IN_USE` (case-insensitive). A row with
   no passkey is onboarding that died before a credential existed — nothing
   can sign in to it — so that address may be reused rather than locked by
   one failed ceremony. `store.usersByEmail()` is the lookup;
   `findUserByEmail()` still prefers the enrolled/active row for recovery.
 - **Recovery enrolment is onboarding step 3**, between "smart wallet
   deployed" and the Monerium gate, registering the signup email (read-only
   there: the channel must be the address the account carries or recovery's
   lookup finds nothing). Same three calls as the Profile screen, then the
   guardian op. Drawn ONLY when /api/health says `emailSmsRecovery`;
   otherwise `offerRecoveryEnrolment()` resolves without showing anything.
   A "Skip for now" exists and says what it costs; the gate checklist then
   shows "Recovery set up" as skipped (not pulsing — nothing is working on
   it) and Profile keeps the same controls.
 - **The enrolment gate moved from KYC-approved to Safe-active.** Recovery
   guards the Safe, and the Safe has an address money can reach the moment
   it is deployed, before any IBAN exists. A pending account at the Monerium
   gate may therefore enrol; a rejected one keeps the right to recover what
   it holds.

NOT DONE, on purpose: no mail transport (still), so the address is never
written to by Zold; IBAN activation is NOT refused for an account without
recovery — that gate would be the analogue of "no IBAN before a passkey" and
is a product decision to take with eyes open; Candide's Alerts API is still
not wired, so the owner learns of a started recovery from the Profile banner
only. Test gap: the harness runs KYC_AUTO_APPROVE=1, so "a pending account
may enrol" is asserted by reading the route, not by a check.

## Sender profile removed — data minimisation (Sep 2026)

`user.senderProfile` (name, birth date, home address, ID type and number,
phone, occupation) is DELETED, with POST /api/users/:id/sender-profile and
GET .../sender-profile/requirements. `stripSenderProfiles()` in store.ts
removes any row still carrying one on load (the Travel Rule harness wrote
some into local databases). `npm run pay:test` and `npm run anchor:sweep:test`
pass; `travelrule:test` is rewritten around the new type but is a LIVE test
against testanchor and was not run from the sandbox (egress blocked).

WHY: it was the most sensitive data in the system, held in plaintext, for
exactly one consumer — the Stellar anchor leg of the cash rail — which no
deployment has ever opened (BRIDGE_LIVE and an anchor are both unset
everywhere). No page ever wrote it; the only rows came from the test script.
Collecting identity-document numbers for a rail that cannot run fails GDPR
data minimisation on its face, and it dragged the impact assessment up from
"account + financial data" to "identity documents". An earlier decision
kept the routes as "external API surface"; that call is reversed here with
the data cost now clear.

WHAT REPLACES IT: `SenderDetails` in adapters/moneygram.ts — the same text
fields, HELD FOR ONE CALL and never persisted. `createCashPickupViaAnchor`
takes `senderId` (memo isolation is kept regardless of details — one treasury
serves every user, so the per-user SEP-10/SEP-12 memo still matters) and an
optional `sender`. Nothing collects details yet, so the orchestrator passes
none and a SEP-12 anchor refuses BEFORE opening a withdrawal, naming the
fields it wants — the same refusal a profile-less user got before.

WHEN AN ANCHOR IS INTEGRATED: collect the details at send time, for that
transfer, transmit them, and keep only what the five-year GwG retention
requires — encrypted, or as a reference into the KYC provider. Not a stored
profile. The same question returns on the Bridge leg: BRIDGE.onBehalfOf is
ONE customer for every sender, so Bridge does not know who is sending; that
is a Travel Rule gap to close per transfer once real money moves that way.

## Monerium — your OWN API keys as a connector (Sep 2026)

`npm run monerium:apikeys:test` (13 checks, stub Monerium + local chain). For
testing against your own Monerium account: Profile -> Monerium keys, paste the
client id + secret of an app created in THAT account's developer section.

WHERE THE CREDENTIAL DECISION LIVES NOW: `adapters/monerium-connection.ts`.
`moneriumClientFor(user)` answers "whose credentials act for this user" —
API keys, then OAuth, then the app's MONERIUM_CLIENT_ID/SECRET — and
`moneriumLiveFor(user)` answers "is Monerium real for this user" (app
credentials OR a connection of their own). The token encrypt/decrypt/refresh
helpers that used to sit in server.ts moved there unchanged in scheme
(crypto-at-rest.ts purpose `monerium`; old ciphertext still decrypts). ONE
DELIBERATE CHANGE inside that move: the OAuth refresh now sends
MONERIUM_OAUTH_CLIENT_ID (falls back to MONERIUM_CLIENT_ID), the same client
that did the code exchange; the old code sent MONERIUM_CLIENT_ID, which a real
OAuth server rejects when the two differ.

WHY THE SANDBOX ADAPTER HAD TO CHANGE, not just the routes: the address the
app links and the IBAN it requests live under the USER's profile, which the
app's keys cannot see (the same blind spot `MoneriumClient.orders()` documents
for unscoped calls). So `redeemToIban`, `getOrderState`, `findIban` and the
deposit poller now run on the user's client when they have one; the poller
additionally walks `usersWithOwnCredentials()` and asks each one's account
(default profile AND the recorded one). The test proves it the hard way: the
API is started with NO app secret, the stub issues a token only for the one
known pair and 401s everything else, and activation + a credited deposit still
happen. `executeSepaTransfer` is gated on `moneriumLiveFor(user)`, so an
account connected by API keys places a REAL redeem even on a deployment whose
own credentials are unset — a connected account mock-PAYING would be the UPI
fake again.

RULES THAT CARRY WEIGHT:
 - VERIFIED BEFORE STORED. The pair is exchanged for a token and /auth/context,
   /profiles, /ibans, /addresses are read before anything is written. A 400/
   401/403 from the grant is a 400 to the caller naming the ENVIRONMENT
   (sandbox keys against production is the likely mistake); 5xx/DNS is a 503.
   A refused pair leaves no row behind, not even encrypted.
 - THE SECRET NEVER LEAVES. Encrypted with MONERIUM_TOKEN_ENCRYPTION_KEY, never
   in a response — not even its ciphertext (`publicApiKeys` strips it, the test
   greps every body). Without that key the connector reports `unavailable` in
   /api/health capabilities and the route 503s; plaintext storage is refused.
 - CONNECTING IS NOT APPROVAL. kycStatus stays pending; activation's
   address-matched IBAN approves, exactly as for OAuth. The ONE shortcut: if the
   connected account ALREADY attributes an IBAN to this Safe address, that is
   the same evidence activation would produce, so it is taken at connect time.
   Any other IBAN in the snapshot is somebody's money routing — ignored.
 - A MOCK IBAN IS RETIRED on connect (funding.mode mock -> sandbox, iban
   cleared, status provisioning) so "Activate IBAN with passkey" appears. An
   app-provisioned active IBAN is KEPT — if the operator connects the very
   account the app's credentials belong to, the app profile IS their profile.
 - REMOVING KEYS keeps the IBAN recorded (it exists at Monerium regardless) and
   says in funding.detail that deposits/payouts pause until keys return.
 - POST is on the auth rate bucket (it is a credential check against a third
   party). Audit kinds `partner.credentials_connected/removed` record it.

UNPROVEN: no real Monerium app's client-credentials token has been used. Their
docs say an app created in an account acts with that account's scope; one run
against api.monerium.dev with real sandbox keys settles it, and the redeem leg
on a user client has only the guard branches exercised. Also unproven: the
OAuth refresh client-id change above (no test refreshes).

