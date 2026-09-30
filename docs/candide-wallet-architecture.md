# Candide Wallet Architecture

## Model

A user-owned Candide Safe:

- The passkey is the Safe's only owner (1-of-1). The store holds no user owner
  keys.
- The backend computes addresses, prepares UserOperations, requests paymaster
  sponsorship and relays through the bundler. It never holds a Safe signing
  key. Deployment goes through `/api/users/:id/passkey-safe/deployment`.
- Recovery is the user's choice, offered before real funds (below).

## Recovery

The default recovery path for non-crypto users is Zoldenburg as guardian, by
the user's choice: a lost device registers a new passkey and asks support, an
operator checks the person against the identity Monerium verified, and signs
the recovery from a hardware wallet (the admin console or Safe Cover). The
module's grace period is the owner's window to cancel. The API never holds the
guardian key; it checks the signature against the module's own digest and
relays it. Deployment adds no guardian: onboarding offers it as one
passkey-signed operation, and `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` is required
before hosted production funding.

Advanced users can add:

- Two passkeys on separate devices.
- Personal guardian address.
- Optional one-time recovery codes.
- Social recovery guardians for supported jurisdictions and risk tier.

## Transfer permission: user-signed execution

There is no allowance, no delegate, and no module installed at deployment. At
transfer creation the server prepares the UserOperation that performs the
debit: an ERC-20 transfer of exactly that transfer's amount (the fee alone on
the Safe-funded SEPA rail) to the orchestrator's working address. The user's
passkey signs its hash at send time alongside the device signature, and the
bundler executes. The chain enforces token, amount and destination, and the
API holds no delegated spend authority of any size, so it cannot dispose of
client assets without the client.

The cash-rail send is ONE user-signed batch: fee transfer -> venue approval ->
swap, atomic, with the output delivered straight to Bridge's deposit address
(the rail is closed without Bridge). The orchestrator never holds the input: a
failed batch reverts entirely and nothing leaves the Safe. The venue half is a
`safeSwapPlan` capability on the liquidity seam — Uniswap builds calldata
offline against the same quoted pool and floor; LI.FI and Bebop are quoted
WITH the Safe as executor. FxSwapper cannot serve a Safe (onlyTrader — our own
inventory) and CoW does not execute, so those venues fall back to the plain
user-signed debit with the orchestrator swapping after.

Custody that remains on the cash rail: the fx-swapper fallback path, and the
fee itself (revenue, not client money).

Scheduled transfers: a recurring allowance only after explicit UX approval
that shows reset period, cap, recipient, and revocation controls.

## Authorizer binding

`POST /api/users/:id/authorizer` requires a fresh passkey step-up when the
account has a registered passkey, so a stolen bearer session cannot bind the
first spending key. The hardhat harness (chain 31337) waives this so the
suites can fund an account without an authenticator; everywhere else,
authorizer binding without a verified passkey is refused.

## Open work

- Replace remaining API-side signing with client-signed UserOps.
- Add a database migration that refuses to carry plaintext wallet keys into
  production persistence.

## Production Gate

Before real funds, production startup should fail unless:

- `NODE_ENV=production`
- strict `WEBAUTHN_ORIGINS`
- `KYC_OPERATOR_TOKEN`
- `MONERIUM_WEBHOOK_SECRET`
- passkey step-up enabled
- server-held Safe owner keys disabled
- recovery setup enabled for funded accounts
