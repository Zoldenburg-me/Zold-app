# Security

## Reporting a vulnerability

Email **security@zoldhq.com** (or open a GitHub security advisory on this
repository). Please do not open a public issue for anything exploitable.
You can expect an acknowledgement within a few days. There is no bug bounty.

## What this codebase is, honestly

This is a working prototype whose defaults are **mainnet and production**
(Base, Monerium production, the public Stellar network); testnets and
sandboxes are selected by configuration. It has had internal
security reviews and carries real security machinery — server-side WebAuthn,
device-signed EIP-712 payment authorization, passkey-owned (1-of-1)
Safes, user-signed UserOperation debits, an M-of-N timelock over contract
admin — but it has **not** been professionally audited, and it is **not**
operated as a licensed financial service.

Known limitations are documented where they live rather than hidden:

- `data/db.json` is plaintext local storage (names, emails, IBANs, transfer
  records); a real deployment needs an encrypted store, and identity stays
  with Monerium.
- Several external legs are proven only as far as their sandboxes allow;
  the code and docs say explicitly which halves have never run against
  the real counterparty.
- The launch gate in `docs/notes/identity-and-security.md` lists what must be
  finished before this should ever hold real funds, and "What has never run"
  in `CLAUDE.md` lists which legs are still unproven. Read both before
  deploying anything.

Do not point this at mainnet with real keys and real money. If you fork it
to build something real: get an audit, get a compliance relationship with
your e-money issuer, and rotate every credential you touch.
