# Zold — On-Chain Remittance Platform: Architecture

Status: Architecture v0.3 (August 2026 — Base Sepolia / Main Alignment)

## 1. Product model

Self-custodial remittance platform & borderless account layer:

- **Primary Smart Account** — every user gets a counterfactual **Candide Safe 2-of-2 Smart Account** (ERC-4337) on **Base Sepolia** (Chain ID `84532`).
  - **Signers**: 2-of-2 multisig configuration (User Passkey + App Co-signer key).
  - **Gas Sponsorship**: ERC-4337 Paymaster sponsors UserOperations.
  - **Recovery**: Account recovery module enabled before real funds are received.
  - **Direct Custody**: Users hold real EURe directly in their Safe smart account.
- **Funding & On-Ramps**:
  - **EUR users**: Personal Monerium IBAN. Inbound SEPA payments auto-mint MiCA-compliant EURe directly to the user's Safe address.
  - **Monerium Connect**: Existing Monerium account holders can connect via OAuth 2.0 (PKCE) to activate their Safe and request dedicated IBANs.
  - **Crypto-native users**: Direct EURe / USDC deposits into the user's Safe address.
- **Outbound Payout Rails**:
  - **SEPA Bank Payouts**: Outbound EURe transfers burn EURe via Monerium and settle via SEPA Instant to any IBAN.
  - **Global Cash Pickups**: USDC moved to Stellar via the Bridge.xyz transfer seam, withdrawn at MoneyGram locations via SEP-10/12/24.

---

## 2. Currency & Token Strategy

| Currency | Token | Settlement Rail | Notes |
|---|---|---|---|
| EUR | `EURe` (`0x29F37F...`) | Monerium SEPA | Primary launch currency token on Base Sepolia. Issued by Monerium (EU EMI, MiCA compliant). |
| USD | `USDC` (`0xf94c01...`) | Bridge.xyz / MoneyGram | Core settlement backbone for cross-border and cash rails. |

---

## 3. Settlement & Liquidity Layer

- **Base Sepolia (84532)**: Primary EVM settlement chain for Monerium EURe issuing and Candide Safe smart accounts.
- **Stellar (Chain 27)**: Payout rail for MoneyGram Ramps cash pickups (SEP-10 authentication, SEP-12 KYC customer registration, SEP-24 interactive withdrawal).
- **Bridge.xyz**: Licensed transfer seam moving USDC from Base to Stellar (dry-run records the plan; BRIDGE_LIVE=1 calls their Transfer API).
- **Multi-Venue FX Execution**:
  - `liquidity.ts` presents a unified `LiquidityProvider` interface for executing FX swaps.
  - **Implementations**: `FxSwapper` (local inventory), Bebop RFQ (JIT PMM quotes), CoW Protocol, Uniswap v3, and LI.FI.
  - **Live FX Rates**: `rates.ts` fetches live mid-rates (10-min cache) with fail-closed bounds checking.

---

## 4. On-Chain Smart Contracts

All contracts are minimal, un-proxied, and governed:

| Contract | Role |
|---|---|
| [`AdminTimelock.sol`](contracts/src/AdminTimelock.sol) | M-of-N multisig with timelock delay owning protocol contracts. Guardian role can pause instantly. |
| [`FxSwapper.sol`](contracts/src/FxSwapper.sol) | On-chain FX swapper with rate configuration and slippage protection. |

---

## 5. Security & Authorization Architecture

1. **Passkey Device Key Envelope**:
   - Device keys are generated locally in browser `localStorage`.
   - Encrypted at rest via WebAuthn PRF (HKDF -> AES-GCM) where supported.
2. **EIP-712 PaymentAuthorization**:
   - Transact ions require a signed `PaymentAuthorization` typed data structure signed by the user's bound device key.
   - Server-side verification (`assertDeviceAuthorization` in `orchestrator.ts`) enforces rate limits, recipient binding, and quote validity.
3. **Compliance & Travel Rule**:
   - **Sumsub KYC**: Direct identity review handoff. Document data and liveness stay with Sumsub; Zold stores applicant reference and extracted text fields.
   - **Travel Rule (SEP-9 / SEP-12)**: Originator text fields mapped and PUT to anchor before opening MoneyGram cash withdrawals.

---

## 6. Public User Interfaces & Services

- **Web Application & PWA**: `/app` dashboard for managing balances, making sends, and tracking activity.
- **Payment Pages**: `/pay/<handle>` custom payment links for receiving funds.
- **Shareable Receipts**: `/r/<slug>` shareable transaction receipts with privacy protection.
- **Deployment Health**: `/api/health` exposes active deployment capabilities (`simulation`, `sandbox`).
