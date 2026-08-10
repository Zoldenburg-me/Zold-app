# Welcome to Zoldenburg

Zoldenburg builds payment infrastructure for moving stablecoin value into real-world rails.

Our current focus is **Zold**: a passkey-first remittance app that lets users hold funds in their own Safe account, fund with EURe, and send through KYC-backed payout rails such as Monerium SEPA and MoneyGram cash pickup.

## What We Are Building

Zoldenburg is working on a user-owned money movement stack:

- **Passkey Safe accounts**: smart accounts controlled by user presence, not API-held private keys.
- **EURe-native balances**: euro stablecoin funding and settlement on EVM rails.
- **KYC-backed payout rails**: Monerium for SEPA payouts and MoneyGram/SEP rails for cash pickup flows.
- **Operational transparency**: backend transaction trails for Safe debits, swaps, bridges, payout orders, failures, and refunds.
- **Non-custodial defaults**: user funds should stay in user-owned accounts unless an explicit, signed transfer is being executed.

## Repositories

- **Zold App**: the main product app and backend for quotes, passkey Safe funding, Monerium OAuth, payment pages, admin operations, and payout execution.
- **Contracts**: Safe-adjacent payment, bridge, recovery, and liquidity test contracts where applicable.
- **Docs and deployment notes**: architecture, production configuration, security notes, and integration plans.

Some repositories may stay private while the protocol and product surfaces are still changing quickly.

## Current Integrations

- **Safe / Candide** for passkey smart-account planning, deployment, and user-signed operation execution.
- **Monerium** for OAuth, IBAN activation, EURe account linking, and SEPA redeem orders.
- **MoneyGram / Stellar anchors** for cash payout exploration through KYC-compatible rails.
- **EVM liquidity routes** for EURe/USDC conversion, including recorded route metadata for operator review.
- **Gnosis Pay research** for future card-account integration paths.

## How To Contribute

We welcome focused contributions that make Zold safer, clearer, and easier to operate.

For code contributions:

- Keep changes small and reviewable.
- Include tests for money movement, KYC, custody, auth, recovery, and payout state changes.
- Do not introduce API-held user private keys or hidden custody paths.
- Keep operator tooling explicit about what moved, where it moved, and why it failed.
- Run the relevant checks before opening a PR.

For product, design, and ops contributions:

- File issues with exact reproduction steps, expected behavior, actual behavior, and screenshots when useful.
- Label whether a report touches onboarding, KYC, funding, transfer execution, payout status, admin operations, or receipts.
- Treat IBANs, wallet addresses, payout references, and transaction trails as sensitive operational data.

## Security

Payment software has sharp edges. Please report suspected vulnerabilities privately.

High-priority reports include:

- unauthorized Safe debits
- bypasses of KYC or operator authorization
- replayable passkey or payout signatures
- leaked secrets, API tokens, or operator credentials
- double-spend, double-payout, or unsafe refund paths
- privacy leaks in receipts, admin views, or public payment pages

Please include:

- affected commit, branch, or deployment
- steps to reproduce
- expected vs actual result
- whether funds, KYC data, or user privacy could be affected

## Principles

- Users should not need to trust us with private keys.
- Operators should be able to see every payment leg without guessing.
- Failed payments should become explicit states, not invisible mysteries.
- Real-world payout rails should fail closed when live credentials or compliance requirements are missing.
- Public demos should not quietly rely on production secrets or fake-money switches.

## Links

- Website: https://zoldhq.com
- Organization: https://github.com/Zoldenburg-me

