# Handoff: Existing Monerium Account Connect

## Decision

The onboarding flow is split after the user has an app account, passkey/device
setup, and a Candide Safe address:

1. Create the Zold account and local wallet shell.
2. Keep funding, quotes, deposits, sends, and device binding locked until the
   funding/KYC path is resolved.
3. Ask whether the user already has a Monerium account.
4. If yes, connect that user-owned Monerium account with OAuth and use
   Monerium's profile status instead of making the user repeat KYC.
5. If no, continue the normal provider/operator KYC path.

Do not ask the Monerium question before the wallet exists. Monerium address
linking needs the app wallet/Safe address, and EIP-1271 verification requires
the Safe to be deployed on the target chain.

## Current Code State

PR #36 and PR #37 have been merged locally in this tree. Their only conflict
was `scripts/check.ts`; keep both `kyc:operator:test` and `kyc:ui:test`.

The split-flow build has started:

- `services/api/src/store.ts` now allows `kyc.onboardingPath`:
  `existing_monerium` or `new_monerium`.
- `POST /api/users/:id/funding-onboarding-path` records the selected path.
- `services/api/public/index.html` shows the choice on the pending KYC screen.
- `scripts/kyc-test.ts` checks the path endpoint.
- `scripts/kyc-ui-test.ts` checks the new UI markers.

**Update (July 2026): the OAuth build step below is now implemented** in
`ba7c0c2`, with `npm run monerium:oauth:test` covering the loop against a stub
that enforces PKCE (12 checks: challenge/verifier pair, single-use state,
tokens encrypted at rest and absent from API responses, app IBAN issued rather
than the user's existing one moved, disconnect clears tokens).

What remains is not code: register the OAuth app with Monerium, set
`MONERIUM_REDIRECT_URI` to match that registration exactly, set
`MONERIUM_TOKEN_ENCRYPTION_KEY`, and connect one real account in a browser.
Until that happens nothing proves Monerium's authorize page accepts our
client_id/redirect_uri, or that its real token response matches the shape the
stub returns.

## Next Build Step

Add a per-user Monerium OAuth client, separate from the existing
client-credentials sandbox client:

- `POST /api/users/:id/monerium/connect/start`
- `GET /api/monerium/oauth/callback`
- `GET /api/users/:id/monerium/accounts`
- `POST /api/users/:id/monerium/activate`
- `DELETE /api/users/:id/monerium/connect`

Use Authorization Code + PKCE. Store refresh tokens encrypted server-side; do
not return Monerium bearer or refresh tokens to the browser.

After OAuth callback:

1. Read Monerium auth context and profiles.
2. Confirm the selected profile is approved/usable.
3. Deploy the app Safe on Polygon/Amoy if needed.
4. Link the app Safe address to the profile with the Monerium ownership
   declaration signature.
5. Prefer requesting a dedicated app IBAN. Moving an existing IBAN to the app
   wallet must require explicit user confirmation because it reroutes future
   incoming EUR payments.
6. Set local funding active only after an active IBAN is attached to the app
   wallet.

## Product Copy Boundary

Use clear user-facing copy:

- Existing account: "Connect Monerium"
- New account: "Verify identity"
- Do not say the user is approved until Monerium or the operator/provider says
  the profile is approved.
- Do not silently move an existing IBAN.

