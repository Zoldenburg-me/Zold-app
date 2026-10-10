# Authenticator code on the Google/Apple guardian — plan

Nothing in this plan has run. It adds a time-based code (TOTP, RFC 6238) as a
second factor on the Google/Apple guardian (`recovery-guardians-plan.md`), so a
taken-over Google or Apple account alone can no longer recover a Zold account.

## Why not a TOTP guardian of its own

A TOTP code proves knowledge of a shared secret, so whoever checks it holds the
secret. A guardian on the module must *sign*; a "TOTP guardian" would be a key
Zold's server signs with when a code checks out, which lets Zold recover any
account alone. That breaks "the API never holds the guardian key"
(AGENTS.md, `recovery-and-signers.md`). The chain cannot check a code either:
anything on chain is public.

## Why the check has to live in Turnkey, not in our API

The guardian key sits in the person's Turnkey sub-org, and the root quorum
today is the person's Google/Apple login alone (`rootQuorumThreshold: 1`). An
attacker holding that login can log into Turnkey directly, sign the
`ExecuteRecovery` digest and send it to the module without touching our API.
A code checked only by our API stops nothing.

## The design: 2-of-2 root quorum

Turnkey documents this pattern as co-signing: a sub-org with two root users
and `rootQuorumThreshold: 2`, where the second root user is the
application's API key; a signing activity waits in
`ACTIVITY_STATUS_CONSENSUS_NEEDED` until the backend calls `approveActivity`
with its fingerprint. Root quorum bypasses the policy engine, so no policy can
let either side act alone.

For a sub-org with the code switched on:

- **Root users**: the person (OIDC provider only, as today) and one Zold
  co-signer user (an API key, P-256). Threshold 2.
- **No policies** in the sub-org, checked after every change. A policy is the
  one way to grant a root user solo rights.
- **The co-signer approves only**: the exact `ExecuteRecovery` digest our API
  recomputes for an open recovery request (`/digest`), signed by that
  sub-org's guardian address, after a valid code. It never starts an activity.

What each side can do alone:

| Who | Alone |
|---|---|
| Someone with the Google/Apple login | Nothing: the activity waits for a vote that needs the code. |
| Zold (co-signer key + TOTP secret) | Nothing: Zold never starts an activity and cannot cast the person's vote. |
| Both | Sign the digest; the module's grace period and the owner alert still apply. |

## Flow

**Turning it on** (on /guardian, for an active Google/Apple guardian):

1. Our API makes a TOTP secret (20 random bytes) and seals it with
   `stored-secrets.ts` under a new purpose `turnkey-totp`, bound to the user
   row. The page shows it as a QR code and as text.
2. The person enters the first code; the API checks it.
3. The person logs in with Google/Apple. The browser, stamped with that
   session, adds the co-signer user (`CREATE_USERS`) and then sets the root
   quorum to both users at threshold 2 (`UPDATE_ROOT_QUORUM`). At threshold 1
   the person's vote alone approves both.
4. The API reads the sub-org back (users, threshold, policies) and marks the
   code active only if it is exactly that.

**Recovering** (on /recovery, `finishApprove`):

1. As today: login, `/digest`, `sign_raw_payload` stamped with the session.
   The activity now answers `CONSENSUS_NEEDED` with a fingerprint.
2. The page asks for the code and sends `{ fingerprint, code }` to
   `POST /api/recovery/turnkey/requests/:id/cosign` with the recovery secret.
3. The API checks the code, then reads the activity with `get_activity` and
   approves only if it is `SIGN_RAW_PAYLOAD` in that sub-org, `signWith` is
   the guardian address, and the payload is the digest it recomputes. Then it
   calls `approveActivity`.
4. The browser polls the activity to `COMPLETED` and posts the signature as
   today.

**Turning it off** needs both votes: login plus a code, then
`UPDATE_ROOT_QUORUM` back to the person alone at threshold 1, and the sealed
secret is deleted.

## Code checks

- SHA-1, 6 digits, 30-second step (what every authenticator app does), and
  one step either side for clock drift.
- A used step is recorded per user and refused a second time.
- Wrong codes go in the auth rate bucket: 5 per 15 minutes per user, then
  refused.
- The code and the secret never reach a log or an error.

## Costs and limits

- **Our own rules change on purpose.** `wallet/turnkey.ts` refuses any sub-org
  that is not one root user, threshold 1, `apiKeys: []`, and
  `turnkey-guardian-test.ts` greps for "no delegated access". These become:
  - "threshold 1 with one person, or threshold 2 with the person and exactly
    the Zold co-signer";
  - "zero policies".
  `recovery-and-signers.md` records the rule.
- **Zold is required.** If Zold is down, this guardian cannot approve. The
  passkey keeps working and nothing can move funds without it.
- **Lost phone, lost codes.** Most authenticator apps live on the phone being
  replaced. Turning it on asks the person to confirm their app syncs or is
  backed up. Open decision below: one-time backup codes.
- **A code can be phished.** This raises the bar from "has your Google
  account" to "has your Google account and a live code". The grace period and
  the owner alert remain the backstop.
- **24-hour vote window**: Turnkey drops votes 24 hours after the first if
  consensus is not reached. Our flow approves within seconds; a stale activity
  is started again.

## Step 0: what to prove in the Turnkey sandbox before building

The docs show co-signing with a **passkey** user plus an API key. They do not
show an **OIDC** root user in a threshold-2 quorum. The spike:

1. Make a sub-org with an OIDC root user, then add an API-key user and update
   the quorum to 2 using only the OIDC session.
2. `sign_raw_payload` with the OIDC session answers `CONSENSUS_NEEDED`;
   `approveActivity` with the API key completes it; the signature recovers to
   the guardian address.
3. The API key alone cannot sign, add an authenticator, change the quorum or
   create a policy.
4. The OIDC session alone cannot do those either.
5. `get_activity` on a sub-org activity works with the parent org key, and
   shows `signWith` and the payload.

If any of these fails, stop and come back with the alternative before writing
code.

## Order

1. The step 0 spike (a script under `scripts/`, needs Turnkey sandbox keys
   set with `scripts/secrets.sh set`).
2. The backend:
   - TOTP check;
   - sealed secret;
   - the payload validator's new shape;
   - enable, cosign and disable routes;
   - behind a switch `TURNKEY_TOTP` that defaults off, under
     `TURNKEY_GUARDIANS`;
   - TDD, with mutation checks on the cosign refusals.
3. The pages: the /guardian toggle with the QR code, and the code step on
   /recovery.
4. Security review, then a zold-docs PR when the switch goes on.

## Open decisions

- **Backup codes.** Eight one-time codes shown once at turn-on, stored hashed,
  each usable instead of the TOTP code. They help a person whose app went with
  the phone; they also form a second secret that can be stolen. Recommended:
  yes.
- **Required or optional.** Recommended: optional, offered right after the
  Google/Apple guardian is added.
- **QR code library**: vendor a small encoder as an ES module (sha256-pinned,
  like `vendor/turnkey.js`), or show the secret as text only.

## Sources

- Turnkey, co-signing transactions: https://docs.turnkey.com/company-wallets/co-signing-transactions
- Turnkey, root quorum: https://docs.turnkey.com/concepts/users/root-quorum
- Turnkey, policies: https://docs.turnkey.com/concepts/policies/overview
- Turnkey, activity submissions and `CONSENSUS_NEEDED`: https://docs.turnkey.com/api-design/submissions
- RFC 6238 (TOTP): https://www.rfc-editor.org/rfc/rfc6238
