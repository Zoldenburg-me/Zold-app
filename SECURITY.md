# Security

## Reporting a vulnerability

Email **security@zoldhq.com** (or open a GitHub security advisory on this
repository). Please do not open a public issue for anything exploitable.
You can expect an acknowledgement within a few days. There is no bug bounty.

## What this codebase is, honestly

This is a working prototype that runs against **testnets and sandboxes**
(Base Sepolia, Monerium sandbox, Stellar testnet). It has had adversarial
review passes and carries real security machinery — server-side WebAuthn,
device-signed EIP-712 payment authorization, 2-of-2 passkey + co-signer
Safes, token-scoped allowance debits, an M-of-N timelock over contract
admin — but it has **not** been professionally audited, and it is **not**
operated as a licensed financial service.

Known limitations are documented where they live rather than hidden:

- `data/db.json` is plaintext local storage and holds sender-profile PII;
  a real deployment must keep PII with the KYC provider.
- Several external legs are proven only as far as their sandboxes allow;
  the code and docs say explicitly which halves have never run against
  the real counterparty.
- The launch gate in `CLAUDE.md` lists what must be finished before this
  should ever hold real funds. Read it before deploying anything.

Do not point this at mainnet with real keys and real money. If you fork it
to build something real: get an audit, get a compliance relationship with
your e-money issuer, and rotate every credential you touch.
