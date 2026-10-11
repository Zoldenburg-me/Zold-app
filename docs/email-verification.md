# Email verification

The signup email is a lookup key: signup refuses a second account on it, and
both recovery routes find the account by it. Confirming it with a code makes
that key the owner's, not whoever typed it first.

## Switch

Off unless `EMAIL_VERIFICATION=1`, and then `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS` and `MAIL_FROM` must all be set or `config.ts` refuses to start.
`capabilities().emailVerification` tells the app; off, both routes answer 404
and the app shows nothing. Turn it on for the production deploy only.

## What changes when it is on

| | Off | On |
|---|---|---|
| Signup refused with `EMAIL_IN_USE` when | any account with a passkey has the email | an account has **confirmed** the email (`domain/email.ts` `emailHeldBy`) |
| Recovery lookup (`store.findUserByEmail`) | prefers a recoverable account | prefers the account that confirmed the email, then as before |
| App | nothing | a "Confirm your email" step after the Safe exists, with "Do this later", and a Home row until done |

Not blocking: an account works without confirming. Existing accounts have no
`emailVerifiedAt`, so once the switch is on their email no longer stops a
new signup on the same address, and a newcomer who confirms it wins the
recovery lookup. The Home row asks them to confirm.

## The code

`routes/email-verification.ts`:

- `POST /api/users/:id/email/code` sends a 6-digit code (`crypto.randomInt`)
  to the account's email through `adapters/mailer.ts`. Stored as a SHA-256
  hash bound to the user id and to the address it went to; never in a
  projection. A failed send stores nothing and answers 502 `MAIL_UNAVAILABLE`.
- `POST /api/users/:id/email/verify` takes `{ code }`. Wrong: counts down from
  5 tries, then the code is void. Expired after 15 minutes. Right: sets
  `emailVerifiedAt` and drops the code. Re-checked at the write: if another
  account confirmed the address first, 409 `EMAIL_IN_USE`.
- Limits: one code a minute, five an hour per address, counted across every
  account that signed up with it; both routes are on the
  auth rate bucket (`http/policy.ts`).
- Accepted limit: anyone can sign up with someone else's address and keep its
  hourly codes used up, so the owner cannot confirm it while that goes on.
  Nothing else is blocked (signup stays open while the address is
  unconfirmed). Before switching on, add an edge rate rule on
  `POST /api/users/*/email/code` so holding an address costs many IPs.

There is no route that changes an account's email.
