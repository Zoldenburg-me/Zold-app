# Candide Wallet Architecture

## Goal

Move transF away from server-held Safe owner keys and toward a user-owned
Candide Safe model:

- Passkey-first Safe ownership.
- Recovery before real funds.
- Scoped allowance for transfer automation.
- Backend as relayer, paymaster client, and rail orchestrator, not wallet
  custodian.

## Current Risk

The MVP still creates a server-side owner key and stores it as
`user.privateKey` in the local JSON store. That key is used to deploy the Safe
and sign Monerium ownership/redeem messages. It is acceptable for local demos,
but it is not acceptable for real funds because a filesystem compromise can
become a wallet compromise.

## Target Account Model

New users should receive a Candide Safe Unified Account owned by a passkey.
The backend may compute addresses, prepare UserOperations, request paymaster
sponsorship, and relay operations through the bundler. It must not own the
Safe signing key.

The production wallet should not be a 1-of-1 passkey. Add a recovery path
before real funds, for example:

- Primary passkey plus recovery guardian.
- Two passkeys on separate devices.
- Social recovery guardians for supported jurisdictions and risk tier.

## Transfer Permission Model

Use Candide Allowance Module as the bounded spend permission layer.

Default transfer:

1. User accepts quote and recipient.
2. Client computes the same destination commitment used by the backend.
3. User signs a Safe operation granting a one-time allowance for the exact
   token and amount.
4. A transF policy delegate executes only if quote id, recipient commitment,
   token, amount, expiry, and rail match the authorized terms.
5. Backend relays and sponsors the UserOperation, then orchestrates payout.

Current implementation note: live Monerium deposits already land in the user's
Safe, and the API returns both `safeBalanceEur` and `vaultBalanceEur`.
`balanceEur` remains the vault ledger until Safe-funded sends land.
The transfer executor is still vault-first, and the transitional poller can
move funds from Safe to `RemitVault` with the server-held Safe owner key. That
is useful for proving the old executor, but not the target custody model; the
one-time allowance/policy delegate path is the intended migration for making
Safe-held funds spendable.

Scheduled transfer:

Use recurring allowance only after explicit UX approval that shows reset
period, cap, recipient, and revocation controls.

## Delegate Design

Do not delegate directly to a backend EOA for production. A backend EOA with an
allowance is still a broad trust surface within that allowance.

Prefer a small policy delegate contract that enforces:

- Transfer id / quote id.
- Token and max amount.
- Recipient commitment.
- Expiry.
- Rail type.
- Max fee/spread.
- Refund path.

## Immediate Hardening Already Implemented

`POST /api/users/:id/authorizer` now requires a fresh passkey step-up when the
account has a registered passkey. This prevents a stolen bearer session from
binding the first spending key without also satisfying the user's authenticator.

Local/demo accounts without passkeys are still allowed when simulation mode is
enabled so CLI and browser demo flows continue to work. Production rejects
authorizer binding without a verified passkey.

## Migration Plan

1. Keep the existing device authorizer path for local demos.
2. Add client-side Safe UserOperation creation for passkey-owned Safes. The
   server already records the deterministic 2-of-2 passkey/co-signer Safe plan
   at passkey registration when `CANDIDE_COSIGNER_ADDRESS` is configured, and
   can now submit a passkey-signed/co-signed deployment UserOperation when
   `CANDIDE_COSIGNER_KEY` is available.
3. Add recovery setup before enabling real deposits.
4. Add one-time allowance setup for transfers.
5. Replace server-side Safe deployment/signing with client-signed UserOps.
6. Delete `user.privateKey` from the stored user model.
7. Add a database migration that refuses to carry plaintext wallet keys into
   production persistence.

## Production Gate

Before real funds, production startup should fail unless:

- `NODE_ENV=production`
- `KYC_AUTO_APPROVE=0`
- strict `WEBAUTHN_ORIGINS`
- `KYC_OPERATOR_TOKEN`
- `MONERIUM_WEBHOOK_SECRET`
- passkey step-up enabled
- server-held Safe owner keys disabled
- recovery setup enabled for funded accounts
