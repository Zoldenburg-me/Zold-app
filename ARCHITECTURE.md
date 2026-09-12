# Zold — On-Chain Remittance Platform: Architecture

Status: Architecture v0.4 (September 2026 — Base mainnet defaults)

## 1. Product model

Self-custodial remittance platform & borderless account layer:

- **Primary Smart Account** — every user gets a counterfactual **Candide Safe Smart Account** (ERC-4337) on **Base** (Chain ID `8453` by default; `TRANSF_CHAIN_ID` selects Base Sepolia `84532` for testing).
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
| EUR | `EURe` | Monerium SEPA | Primary launch currency token. Issued by Monerium (EU EMI, MiCA compliant); the address per chain is read from Monerium's `/tokens`. |
| USD | `USDC` | Bridge.xyz / MoneyGram | Core settlement backbone for cross-border and cash rails. Circle's USDC on the chain in use; `deployments.json` records it. |

---

## 3. Settlement & Liquidity Layer

- **Base (8453)**: Primary EVM settlement chain for Monerium EURe issuing and Candide Safe smart accounts; Base Sepolia (84532) for testing.
- **Stellar**: Payout rail for MoneyGram Ramps cash pickups (SEP-10 authentication, SEP-12 KYC customer registration, SEP-24 interactive withdrawal).
- **Bridge.xyz**: Licensed transfer seam moving USDC from Base to Stellar. The cash rail is closed unless BRIDGE_LIVE=1 and an anchor are configured; there is no dry-run.
- **Multi-Venue FX Execution**:
  - `liquidity.ts` is the seam: it chooses a venue, persists the quote that priced a transfer, and dispatches execution back to the venue that quoted it.
  - **Implementations**, one per file under `liquidity/`: `fx-swapper.ts` (local inventory), `rfq.ts` (Bebop PMM), `cow.ts` (quote-only), `uniswap.ts` (Uniswap v3), `lifi.ts` (aggregator), `best.ts` (best execution across the rest). The contract they share is `liquidity/contract.ts`.
  - **Live FX Rates**: `rates.ts` fetches live mid-rates (10-min cache) with fail-closed bounds checking.

---

## 3a. Code layout

The API is a set of router factories that `server.ts` mounts; `server.ts` itself
is wiring and owns authentication, so a route module cannot acquire a second way
to decide who is calling.

| Directory | What is in it |
|---|---|
| `services/api/src/http/` | The layer every request passes through: origin policy and rate buckets (`policy.ts`), sessions (`sessions.ts`), the guards a route runs before it acts (`guards.ts`), and the in-flight ceremony maps (`pending.ts`). |
| `services/api/src/routes/` | One router per subject. `business/` splits the organisation surface again by subject. |
| `services/api/src/domain/` | Rules with no HTTP and no chain: plans, roles, drafts, invoices, invoicing, jurisdictions, ledger, segments. |
| `services/api/src/adapters/` | Third parties: Monerium, Gnosis Pay, MoneyGram, crypto deposits, the Candide forwarder. |
| `services/api/src/liquidity/` | One file per FX venue, behind the seam in `liquidity.ts`. |
| `services/api/src/store/` | `types.ts` is the row shapes, `db.ts` the JSON file and its migrations; `store.ts` is the methods and the seam. |
| `services/api/src/transfers/` | `build.ts` — the ONE path that creates a transfer, shared by the direct route and draft execution. |
| `services/api/src/wallet/`, `stellar/`, `bridge/`, `shopify/`, `recovery/` | The chain, anchor, bridge, merchant and guardian integrations. |
| `services/api/public/app/` | The app's browser code, one file per screen group, loaded as ordered classic scripts (they share one scope). |
| `services/api/public/business/` | The org dashboard, as ES modules. `core.js` owns the shared state and is the only module that writes it. |

Two files stay deliberately whole. `orchestrator.ts` is the money path and is
meant to be read top to bottom; `config.ts` is one place an operator can see
every setting and every production refusal.

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
   - **Identity is Monerium's**: approval is an IBAN attributed to the Safe by a connected Monerium account; Zold stores no identity documents.
   - **Travel Rule (SEP-9 / SEP-12)**: Originator text fields, collected per transfer (not yet wired), mapped and PUT to the anchor before opening MoneyGram cash withdrawals.

---

## 6. Public User Interfaces & Services

- **Web Application & PWA**: `/app` dashboard for managing balances, making sends, and tracking activity.
- **Payment Pages**: `/pay/<handle>` custom payment links for receiving funds.
- **Shareable Receipts**: `/r/<slug>` shareable transaction receipts with privacy protection.
- **Deployment Health**: `/api/health` exposes active deployment capabilities (`moneriumOAuth`, `moneriumApiKeys`, `cashRail`, `emailSmsRecovery`, `shopify`).
