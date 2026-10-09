# Recovery guardians — implementation plan

Nothing in this plan has run. It adds guardian kinds to the Candide
SocialRecoveryModule every Zold Safe already uses, and removes Candide's
hosted guardian service. The rules that bind today are in
`recovery-and-signers.md`; this file says what to build and in which order.

## Decisions taken

- **Zoldenburg guardian** keeps the hardware-wallet operator and adds two
  checks the operator cannot sign without:
  1. a **Didit** ID + liveness check at recovery time only, whose name must
     match the Monerium profile name (option A: nothing biometric stored);
  2. a **1 € SEPA check**, required twice: once at enrolment (records which
     bank account the user pays from) and again at recovery (must come from
     that same account).
- **Turnkey** provides embedded wallets for social guardians: the user's own
  Google/Apple/email login, and people the user trusts. Nobody is asked for a
  wallet address.
- **Social guardians raise the threshold** (rule below).
- **Candide's hosted guardian service is dropped.** The Candide module stays.

## What Monerium gives us (checked 2026-10-09)

- `GET /profiles` and `/profiles/{id}`: `id`, `kind`, `name`, `state`. The
  `details`, `form` and `verifications` sections carry a **state only**, never
  the data. `PersonalProfileDetails` (birthday, nationality, ID number) is an
  input type for partners that submit KYC, not readable back. So the only
  identity fact to compare is the **full name**.
- Incoming SEPA (issue orders / payments): `counterpart.details` (name, or
  first/last name), `counterpart.identifier.iban`, `memo`, `referenceNumber`.
  `domain/invoices.ts` already parses these.

## The model on chain

One module per Safe, **one guardian list and one threshold**. Any address that
can produce an ECDSA signature over the `ExecuteRecovery` EIP-712 digest is a
guardian. We already relay several guardians' signatures in one call
(`createMultiConfirmRecoveryMetaTransaction` in
`recovery/zoldenburg-guardian.ts`), so threshold > 1 needs no new contract.

Guardian kinds (off-chain label only; the chain is the truth, read on every
visit):

| kind | key held by | how they approve |
|---|---|---|
| `zoldenburg` | Keycard Shell (operator) | /admin → Recoveries, after both checks pass |
| `self-social` | Turnkey sub-org, root = the user | log in with Google/Apple/email on the recovery page |
| `trusted-person` | Turnkey sub-org, root = that person | log in from the approval link the user sends them |

**Threshold rule** (enforced by the API before it builds the passkey op):

- With no `trusted-person`: threshold ≥ 1 (so `zoldenburg` alone, or
  `zoldenburg` + `self-social` at 1-of-2, is allowed).
- With any `trusted-person`: threshold ≥ max(2, ⌈n/2⌉). Example: Zoldenburg +
  two friends → 2 of 3.
- Threshold ≤ n, always. The UI says in one sentence who can recover the
  account alone, or that nobody can.

Guardian changes are passkey-signed ops on the Safe:
`addGuardianWithThreshold`, `revokeGuardianWithThreshold`, `changeThreshold`.
A Safe whose own threshold is > 1 cannot sign them (`assertPasskeyAloneCanSign`);
that stays. An imported Safe is still not offered guardians.

A recovery needs `threshold` signatures over the same digest. The digest
includes the module nonce, so a cancelled or finished recovery invalidates
signatures collected for it; the API recomputes the digest from the module
before accepting each signature (as it does today).

## Phase 0 — tell the owner a recovery has started

Every guardian can start a takeover; the grace period plus the owner's cancel
is the only defence. Before any new guardian kind ships:

- When a recovery request reaches `executed` (grace period running), and when
  a request is created, alert the owner:
  - an **in-app banner on every signed-in session** with a Cancel button
    (passkey-signed `cancelRecovery`, `wallet/candide.ts`);
  - **email** to the account address through `adapters/mailer.ts`. Mail is off
    today (`status.md`); switching it on needs a real SMTP provider with a
    processing agreement (`security-hardening.md`).
- Email alone is not enough: whoever controls the inbox may be the attacker
  and delete it. The banner on the device the owner still holds matters most.
  Web push is not built and is out of scope.
- The production module stays 3 days unless decided otherwise (open item).

## Phase 1 — Zoldenburg guardian: Didit + 1 € checks

### Enrolment

1. Onboarding step 3 adds the guardian on chain as today (one passkey op).
   The guardian is then **on chain but not armed**: the operator UI refuses to
   sign for it until enrolment completes.
2. After the IBAN is active (the gate runs after step 3), Security and Home
   show "Finish Zoldenburg recovery: send 1 € from your bank".
3. The API issues an **enrolment code** (8 chars, Crockford base32) shown with
   the user's own IBAN. The code is a credential: auth rate bucket, never
   cached by the service worker, stored only as a hash.
4. A poller reads the user's issue orders through their stored Monerium
   connection (`moneriumClientFor`), from the code's creation onward, and
   accepts the first order whose memo contains the code, amount ≥ 1 €.
5. It checks the payer name against the Monerium profile name (read live,
   rules under *Name match*). Match → store on the user:
   - `zoldenburgEnrolment.bankAccountHmac` = HMAC-SHA256 over the normalised
     payer IBAN, keyed by a dedicated server secret (`RECOVERY_IBAN_HMAC_KEY`);
   - `bankAccountLast4`, for display only;
   - the Monerium order id and `enrolledAt`.
   No payer name, no full IBAN. Mismatch → the enrolment stays open with a
   plain reason; nothing is stored.
6. The 1 € arrives as EURe in the user's own Safe. Nothing to refund.
7. The user may re-enrol (new code, new 1 €) with a passkey step-up, e.g.
   after changing banks. Re-enrolment replaces the hash.

### Recovery

The lost-device flow (`/recovery/zoldenburg`) keeps its new-passkey step and
the RecoveryRequest holding the new credential. Two checks are added, both
required, in either order:

**Didit (option A).**
- `POST /v3/session/` with our workflow (ID document + liveness + face match),
  `vendor_data` = user id, `metadata` = recovery request id + a per-request
  nonce, `callback` = the recovery page.
- The webhook (`X-Signature-V2` HMAC + `X-Timestamp` within 300 s, constant-
  time compare, idempotent on `event_id`) is only a nudge: the API then reads
  `GET /v3/session/{id}/decision/` and acts on that.
- Accept only: status Approved, `session_id` and `metadata` nonce equal to the
  request's, `id_verifications` approved, liveness and face match approved,
  and the document name matching the Monerium profile name.
- Record on the request: `didit: { sessionId, outcome, nameMatch, checkedAt,
  deletedAt }`. Not the document number, not the date of birth, not images.
  We never fetch the presigned image URLs.
- Then `DELETE /v3/session/{id}/delete/`. A failed delete is retried by a job;
  the Console retention is set to 1 month as the backstop. `deletedAt` is
  shown to the operator.

**1 € from the enrolled account.**
- A recovery code (separate from the enrolment code, same credential rules)
  is shown on the recovery page with the user's IBAN.
- Same poller; the order must carry the code, and HMAC(payer IBAN) must equal
  the enrolled hash, and the payer name must match the Monerium name.
- If the Monerium connection cannot be read (e.g. the refresh token expired),
  the check stays open. It never passes on a failed read.

**Operator.** /admin → Recoveries shows both checks with their evidence (match
yes/no, last 4 of the account, Didit outcome and deletion). The sign button is
disabled unless both passed; there is no override in the UI. A mismatch ends
the self-service path; what happens then (e.g. a support process) is an open
item. The operator still signs from the Keycard; the API still never holds
the guardian key.

### Name match

Monerium gives one `name` string; Didit gives first and last name. Normalise
both (Unicode NFKD, strip diacritics, ß→ss, lower case, hyphens and
apostrophes to spaces, collapse spaces), tokenise, and require that every
Didit last-name token and the first Didit first-name token appear in the
Monerium tokens. Anything else is a mismatch. The same function serves the
SEPA payer name. Unit-test it with married names, middle names, and
transliterations; it errs toward mismatch.

### Didit facts this relies on (docs, 2026-10-09)

ID verification, passive liveness and 1:1 face match: 500 free checks each
per month, then $0.15 / $0.10 / $0.05. Active liveness is $0.15. Processor
role, EU (AWS Ireland), DPA as Annex 2 of the Business Terms. We show an
unchecked consent box naming Zoldenburg as the requester and Didit as
processor, link both privacy notices, and store the consent text version and
time. The sandbox application is free, but it stores real media, so test with
sample documents only.

## Phase 2 — Turnkey, and the user's own social guardian

### Turnkey integration (shared by Phases 2 and 3)

- **Parent org** = Zoldenburg. Its API key lives in `.env` as a secret
  (`TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`), used by the backend
  only to create sub-orgs and to start logins (`oauth_login`, `init_otp`,
  `verify_otp`, `otp_login`). We do not use Turnkey's Auth Proxy, so the
  invariant below sits in our code where a test can see it.
- **Every sub-org is created with exactly one root user, the person, at root
  quorum threshold 1, and no API key of ours.** One builder function makes
  the payload and asserts this; a source-grep test fails on any use of
  delegated access or any `apiKeys` in that payload. Parent orgs have read
  access only to sub-orgs and cannot sign with or delete their wallets.
- **Login methods:** Google, Apple, email OTP. Never an OIDC issuer we run
  (Auth0, Cognito, …): we could mint its tokens. The OAuth nonce is bound to a
  client-generated key (`sha256(publicKey)`), so our backend cannot reuse the
  token.
- **Signing:** the API sends the `ExecuteRecovery` digest it computed; the
  browser signs it with `sign_raw_payload` (hex payload, no extra hash). The
  API recovers the address, requires it to be a guardian on chain, normalises
  `v` as today, and stores the signature on the request. The Turnkey session
  is ended right after.
- **Frontend:** `public/app/*.js` are classic scripts with no bundler. Ship a
  pinned, prebuilt Turnkey browser bundle under `public/vendor/` (as
  `secp256k1.js` is), or run the guardian pages as a small separate ES-module
  page. Decide when building; record the hash.
- **Residual risk, stated in the UI copy and here:** while a guardian is
  logged in, our own served JavaScript holds their session key. A compromised
  zoldhq.com could make a logged-in guardian sign. The threshold, the grace
  period and Phase 0 alerts are the defence.
- **Pricing (2026-10-09):** pay-as-you-go is 25 free signatures/month, then
  $0.10, up to 1,000 wallets; Pro is $99/month. Signatures happen only at
  recovery; wallets are the limit to watch.

### Own social guardian (`self-social`)

1. Security → Recovery → "Add a guardian" → "Your Google, Apple or email".
2. The user logs in with Turnkey; the API creates their sub-org and a wallet
   and receives its address.
3. The user approves `addGuardianWithThreshold` with their passkey.
4. We store `{ kind: "self-social", address, turnkeySubOrgId, addedAt }`.
5. Copy recommends linking a second login method in Turnkey, and warns when
   the login email is the same as the Zold account email: whoever holds that
   inbox could then start a recovery and delete the alert mail.
6. Recovery: on the new device, after the new passkey, "Approve with Google"
   signs the digest.

## Phase 3 — trusted people (`trusted-person`)

1. The user adds a person by a label they choose ("Mum") and gets an invite
   link. The invite token is a credential (auth rate bucket, single use,
   expires in 7 days, 404 under the wrong handle).
2. The person opens the link and sees who invited them (the user's display
   name) and what they are agreeing to. They log in with Google, Apple or
   email. A sub-org is created with them as the only root. They need no Zold
   account.
3. The user approves adding that address with their passkey, with the
   threshold the rule allows (the UI proposes the minimum).
4. We store `{ kind: "trusted-person", address, label, turnkeySubOrgId,
   addedAt }`. We do not store the person's email; Turnkey holds their login.
5. Recovery: the recovery page gives the user one approval link per trusted
   person to send themselves (Zold sends no message to third parties). The
   approval page shows the label, the new-passkey fingerprint and the time
   the request started, and says to approve only after speaking to the person.
   The person logs in and signs.
6. When `threshold` signatures are collected, the API relays
   `multiConfirmRecovery` with execute; the grace period starts; Phase 0
   alerts fire.

## Phase 4 — remove Candide's hosted guardian

Delete `routes/recovery-candide.ts`, `recovery/candide-guardian.ts`,
`scripts/candide-recovery-test.ts` and its `recovery:candide:test` script, the
mount in `server.ts`, the capability in `capabilities.ts`, the field in
`users/public-user.ts`, and the UI offering it. Update the greps in
`transaction-audit-test.ts`, `safe-op-uncertain-test.ts` and
`passkey-safe-plan-test.ts`, plus the `status.md` line. `wallet/candide.ts`
(the module, grace periods, cancel) stays.

## Data and GDPR

New personal data, all to go into the Art. 30 map:

| what | where | kept |
|---|---|---|
| HMAC of the enrolled payer IBAN, last 4 | user record | until the guardian is removed or the account is closed |
| Didit session id, outcome, name-match flag | RecoveryRequest | with the request |
| ID document, face, DOB | Didit only (processor) | deleted by our API call after the decision; 1-month retention backstop |
| guardian address, label, Turnkey sub-org id | user record | until the guardian is removed |
| a trusted person's login | Turnkey only (processor) | their sub-org |

Processors to add: Didit (DPA in their Business Terms), Turnkey (DPA and data
residency not yet confirmed). Biometric processing rests on explicit consent
(Art. 9(2)(a)), collected each time.

## Invariants this adds (move into `recovery-and-signers.md` when built)

- The operator cannot sign for the Zoldenburg guardian unless the Didit check
  and the 1 € check both passed for this request. Fail closed on any read error.
- We store no ID data, no biometrics and no full IBAN for recovery.
- Every Turnkey sub-org has exactly one root user, the person, and no key of
  ours; no delegated access.
- With any trusted person, the threshold is at least 2.
- Every collected signature is checked against the digest recomputed from the
  module and against the guardian list on chain.

## Tests

- Unit: name match, the threshold rule, the sub-org payload builder, digest and
  `v` handling, IBAN normalisation + HMAC.
- Route: enrolment and recovery codes (rate bucket, wrong handle → 404,
  single use), Didit webhook signature and replay, decision binding to
  request and nonce, refusal on a failed Monerium read, operator sign refused
  until both checks pass.
- Harness: a 2-of-3 recovery on hardhat with three EOA guardians standing in
  for Zoldenburg and two Turnkey wallets, through execute, cancel and finalise.
- Source greps: no delegated access, no image-URL fetch from Didit responses.

## Open items to verify before building

- Monerium refresh-token lifetime: can we still read a user's orders weeks
  after their last login? If not, the 1 € recovery check needs another read
  path (partner webhooks).
- SocialRecoveryModule: signature ordering in `multiConfirmRecovery` for
  N > 1 on the deployed version ("0.0.1" hashing).
- Didit: which liveness a default workflow uses (passive is free, active is
  paid); whether the decision can omit image URLs; the sub-processor list in
  writing.
- Turnkey: DPA and EU processing; that the parent can never export a
  sub-org's key; whether `@turnkey/viem` signs typed data in the browser
  (not needed if we sign the raw digest).
- Production grace period: 3 days, or 7 once trusted people exist.
- What a user does when the name or bank check fails (no override exists).

## Order of PRs

1. Phase 0 alerts (banner + mail transport behind its flag).
2. Phase 1 enrolment 1 € check, then the recovery-time Didit + 1 € checks and
   the operator gate.
3. Phase 2 Turnkey integration + own social guardian.
4. Phase 3 trusted people + threshold rule and UI.
5. Phase 4 removal of the Candide hosted guardian (can run in parallel with 2).

Each user-visible PR gets its `zold-docs` PR in the same task and stays behind
a SOON label until one real recovery of that kind has run on chain.
