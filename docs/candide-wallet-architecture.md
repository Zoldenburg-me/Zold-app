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

Some transitional local paths can still store `user.privateKey` in the JSON
store for API-side signing. That is acceptable only for local demos, not real
funds, because a filesystem compromise can become a wallet compromise. Safe
deployment itself is centralized in `/api/users/:id/passkey-safe/deployment`.

## Target Account Model

New users should receive a Candide Safe Unified Account owned by a passkey.
The backend may compute addresses, prepare UserOperations, request paymaster
sponsorship, and relay operations through the bundler. It must not own the
Safe signing key.

The default recovery path for non-crypto users is managed KYC recovery: the
Safe has a service guardian, the user proves identity through the KYC/recovery
operator path, and recovery waits through the module grace period before a new
owner can take over. The API only decides when a request is allowed to proceed;
the guardian signature is delegated to a separate signer service configured by
`RECOVERY_GUARDIAN_SIGNER_URL`, so the API does not become a hot guardian key.
Advanced users can add:

- Two passkeys on separate devices.
- Personal guardian address.
- Optional one-time recovery codes.
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

Current implementation note: live Monerium deposits land in the user's Safe,
and the API now treats `safeBalanceEur` as `balanceEur`. Remittance funding is
Safe-first.

IMPLEMENTED (Aug 2026): the one-time allowance path from steps 1-5 above.
Deployment installs the allowance module and the co-signer delegate but grants
no standing amount. At transfer creation the server prepares a UserOperation
granting a one-time allowance for exactly that transfer's debit (the fee alone
on the Safe-funded SEPA rail); the user's passkey signs its hash at send time
alongside the device signature, the co-signer counter-signs, and the debit
consumes the grant in full. `deleteAllowance` precedes every `setAllowance` so
the module's cumulative `spent` counter cannot strand a later grant. Between
sends the co-signer's on-chain spend authority is zero.

Still open from the delegate design below: the delegate is the backend
co-signer EOA, and the AllowanceModule bounds token+amount, not destination —
the recipient commitment is enforced by the API's signature check, not by
bytecode. The policy delegate contract remains the next step.

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
3. Add recovery setup before enabling real deposits. New passkey/co-signer
   Safe deployments now enable Candide's `SocialRecoveryModule` and add the
   configured recovery guardian during the first UserOperation when
   `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` is configured; absent that, it defaults
   to the co-signer. The managed recovery API tracks requests, KYC/operator
   approval, the delay window, and the fail-closed handoff to a separate
   guardian signer. That signer must submit the on-chain
   `SocialRecoveryModule` recovery transaction; it must not be an API hot key.
4. Add one-time allowance setup for transfers.
5. Keep Safe deployment centralized in `/api/users/:id/passkey-safe/deployment`
   and replace remaining API-side signing with client-signed UserOps.
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
