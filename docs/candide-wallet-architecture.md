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

RESOLVED: no `user.privateKey` path exists anywhere any more — the store
holds no user Safe owner keys, and every debit is user-signed. Safe deployment
remains centralized in `/api/users/:id/passkey-safe/deployment`.

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

> **Superseded (Aug 2026):** the allowance-module design below was replaced by
> user-signed execution — see the IMPLEMENTED notes further down. Kept for the
> reasoning that led there.

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

IMPLEMENTED (Aug 2026): user-signed execution — regulatory-architecture.md's
Change 1, superseding both the standing allowance and the interim per-transfer
grant. There is no allowance, no delegate, and no module installed at
deployment. At transfer creation the server prepares the UserOperation that
performs the debit itself — an ERC-20 transfer of exactly that transfer's
amount (the fee alone on the Safe-funded SEPA rail) to the orchestrator's
working address. The user's passkey signs its hash at send time alongside the
device signature; the bundler executes. (A legacy 2-of-2 Safe also needs
the co-signer's counter-signature until its user removes it — see below.) The chain enforces token, amount and destination, so the
answer to "can we dispose of client assets without the client" is NO,
architecturally: the API holds no user owner keys and no delegated spend
authority of any size, at any time. Legacy standing allowances left on old
Safes are revoked automatically by the next send's operation
(`transferExecutionTransactions` prepends a `deleteAllowance`).

The delegate-design section below is therefore historical: there is no
delegate to constrain.

ALSO IMPLEMENTED (Aug 2026): Change 2 windows 1-3 — the cash-rail send is ONE
user-signed batch: fee transfer -> venue approval -> swap, atomic, with the
output delivered straight to the destination the payout leg names, Bridge's
deposit address (the rail is closed without Bridge, so there is no other
destination). The orchestrator never holds the input: a
failed batch reverts entirely and nothing leaves the Safe. The venue half is a
`safeSwapPlan` capability on the liquidity seam — Uniswap builds calldata
offline against the same quoted pool and floor; LI.FI and Bebop are quoted
WITH the Safe as executor so the route is built for the account that runs it;
FxSwapper cannot serve a Safe (onlyTrader — our own inventory, where we are
the counterparty and the question is Change 3's, not a custody window) and
CoW does not execute, so those venues fall back to the plain user-signed
debit with the orchestrator swapping after.

What custody remains on the cash rail: the fx-swapper fallback path, and the
fee itself (revenue, not client money).

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

The hardhat harness (chain 31337) waives the passkey requirement so the
suites can fund an account without an authenticator. Everywhere else,
authorizer binding without a verified passkey is refused.

## Migration Plan

1. Keep the existing device authorizer path for local demos.
2. Add client-side Safe UserOperation creation for passkey-owned Safes. The
   server records the deterministic passkey-only (1-of-1) Safe plan at passkey
   registration.
   CO-SIGNER RETIRED (Sep 2026): Safes used to be planned 2-of-2 with a Zold
   co-signer. It could never start a debit, but it meant the user could not
   move their own funds without Zold, and a user could not add a key of their
   own without Zold co-signing the owner change. New plans are passkey-only.
   Existing 2-of-2 Safes keep working while `CANDIDE_COSIGNER_KEY` is set and
   can drop the co-signer with one passkey-signed `removeOwner` operation
   (`POST /api/users/:id/passkey-safe/cosigner-removal`); a Candide recovery
   installs only the new passkey.
3. Add recovery setup before enabling real deposits. New passkey Safe
   deployments now enable Candide's `SocialRecoveryModule` and add the
   configured recovery guardian during the first UserOperation when
   `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` is configured (required in hosted
   production). The managed recovery API tracks requests, KYC/operator
   approval, the delay window, and the fail-closed handoff to a separate
   guardian signer. That signer must submit the on-chain
   `SocialRecoveryModule` recovery transaction; it must not be an API hot key.
4. ~~Add one-time allowance setup for transfers.~~ Superseded: debits are user-signed operations; no allowance exists.
5. Keep Safe deployment centralized in `/api/users/:id/passkey-safe/deployment`
   and replace remaining API-side signing with client-signed UserOps.
6. ~~Delete `user.privateKey` from the stored user model.~~ Done — no such field exists.
7. Add a database migration that refuses to carry plaintext wallet keys into
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
