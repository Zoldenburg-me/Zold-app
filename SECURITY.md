# Security

## Reporting a vulnerability

Email **security@zoldhq.com** (or open a GitHub security advisory on this
repository). Please do not open a public issue for anything exploitable.
You can expect an acknowledgement within a few days. There is no bug bounty.
The same contact is published at
[zoldhq.com/.well-known/security.txt](https://zoldhq.com/.well-known/security.txt).

## What this codebase is

Zold runs on Base mainnet with real money at app.zoldhq.com, and on Base
Sepolia with Monerium's sandbox at zoldhq.com. Its defaults are **mainnet
and production** (Base, Monerium production, the public Stellar network);
testnets and sandboxes are selected by configuration. It is **not** operated
as a licensed financial service: the euro account and SEPA are Monerium's.

Each user's money sits in their own Safe, whose only owner is their passkey
(threshold 1). Every debit is a UserOperation the passkey signs; the server
holds no key that can move a user's funds. The other machinery: server-side
WebAuthn, device-signed EIP-712 payment authorization, and an M-of-N
timelock over the admin of Zold's own contracts.

## Audits

**Zold's own code (this repository) has had no third-party audit**, only
internal security reviews.

The on-chain contracts the money sits behind are audited by their makers:

- Safe smart account v1.4.1, the Safe itself:
  [Safe's audit notes and Ackee Blockchain's report](https://github.com/safe-fndn/safe-smart-account/blob/main/docs/audit_1_4_0.md)
  (1.4.0, with the 1.4.1 fix covered there).
- Candide's multi-chain-signature ERC-4337 module, which lets the Safe run
  UserOperations: [Nethermind's report](https://github.com/candidelabs/safe-4337-multi-chain-signature-module/blob/main/audit/NM_0874_Candide_safe.pdf).
- Safe's passkey module v0.2.1, the WebAuthn signer:
  [Hats Finance, Certora and Nethermind reports](https://github.com/safe-fndn/safe-modules/blob/main/modules/passkey/docs/v0.2.1/audit.md).
- Candide's SocialRecoveryModule, used when a user adds a recovery guardian:
  [Ackee Blockchain, Nethermind and Certora reports](https://github.com/candidelabs/candide-contracts/blob/main/audit/audit.md).

## Known limitations

Documented where they live rather than hidden:

- The database is one JSON file (`store/db.ts`), written with mode 600.
  Credentials in it (Monerium OAuth tokens and API secrets, Shopify tokens,
  GetMyInvoices keys) are AES-256-GCM encrypted (`crypto-at-rest.ts`,
  `stored-secrets.ts`), and storing one refuses without a key. Names, emails,
  IBANs and transfer records are **plaintext** in that file; a production
  start refuses the file store unless `ALLOW_PLAINTEXT_STORE=1` acknowledges
  it. Database backups are `age`-encrypted. Encrypted PII columns and
  Postgres are planned.
- Several external legs are proven only as far as their sandboxes allow;
  `docs/status.md` lists what has and has not run against the real
  counterparty. Read it before relying on any leg.

If you fork this to build something real: get your own code audited, get a
compliance relationship with your e-money issuer, and rotate every
credential you touch.
