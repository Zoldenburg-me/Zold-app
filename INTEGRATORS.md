# Integrators & keys

Everything Zold talks to, what it needs from us, and whether getting it costs a call.

**Status of the 8 things we actually need to go live:**

| | |
|---|---|
| ✅ Have it (sandbox) | Monerium, Candide, Stellar, Circle CCTP |
| 🟢 Self-serve — no call, ~10 min each | RPC provider, LI.FI, rates feed, Stripe standard |
| 🔴 Needs a form/email first | Monerium **production**, a real KYC provider — plus Bridge |

Only **two** are hard blockers: Monerium production and a KYC provider. Everything else is either self-serve or optional. Full call list in §1.

---

## 1. 🔴 The call list — everything that needs a human

**Read this first.** Every one of these starts with a form or an email, **not** a call. Send them all in one sitting; the calls only happen after they reply.

| # | Who | What we need | Blocking? | Start here | Lead time |
|---|---|---|---|---|---|
| 1 | **Monerium** (production) | Real e-money relationship. Sandbox → live EUR IBANs | ✅ **YES** — no EUR in or out without it | Existing sandbox contact | Weeks–months (regulated) |
| 2 | **KYC provider** | One of Sumsub / Persona / Onfido | ✅ **YES** — cannot go live on a mock | Self-serve signup first, sales only for pricing | Days |
| 3 | **Bridge** (bridge.xyz) | Stablecoin ↔ fiat: ACH, SEPA, SPEI, Pix, LatAm | ⚠️ Optional — but **replaces MoneyGram + dLocal + Yellow Card in one integration** | bridge.xyz contact form | Weeks (enterprise) |
| 4 | **MoneyGram** | Cash-pickup partner agreement | ⚠️ Only if we keep cash pickup | Via Stellar anchor programme | Months, hard |
| 5 | **Stripe** | Card acceptance for Zold Plus / Privacy Bundle subs | ❌ No — nothing to bill yet | **Standard account is self-serve** — no call | Same day |
| 6 | **Yellow Card** | Africa payouts, settles USDC, no prefunding | ❌ No | yellowcard.io business form | Weeks |
| 7 | **Bebop** | RFQ liquidity. Monerium market-makes EURe there | ❌ No — LI.FI already works | Contact form | Weeks |
| 8 | **CoW Protocol** | Higher rate limit (quotes work now, throttled) | ❌ No | Their Discord — chat, not a call | Days |
| 9 | **Iron** (MoonPay) | USD/GBP funding | ❌ No | Request access form | Weeks |
| 10 | **Kokio / Mysterium** | eSIM + VPN fulfilment for Privacy Bundle | ❌ No — manual today | Partner contact | Weeks |

**If you only send two emails: #1 and #2.** Those are the only hard blockers.

**#3 is the strategic one.** Bridge is Stripe-owned (acquired Oct 2024, $1.1B). One integration covers the rails we'd otherwise chase across MoneyGram, dLocal and Yellow Card separately — it's what Peanut runs on. Worth sending even though it isn't blocking.

> ⚠️ **Naming clash:** `services/api/src/bridge/` in our codebase is the **Circle CCTP** worker (USDC burn/mint to Stellar). Nothing to do with Bridge.xyz. Don't let the two get confused in conversation.

### Stripe — two very different things

| | Access | Use for us |
|---|---|---|
| **Stripe standard** (cards, subscriptions) | 🟢 Self-serve, no call | Billing Zold Plus / Privacy Bundle. **Not integrated — no payment processor in the codebase at all** |
| **Stripe stablecoin / Bridge products** | 🔴 Sales-led | The fiat rails in #3 above |

---

## 2. Live integrations

| Integrator | What it does | Keys | Have? | How to get | Call? |
|---|---|---|---|---|---|
| **Monerium** | EUR issuer. Per-user IBANs, EURe on-chain | `MONERIUM_CLIENT_ID`<br>`MONERIUM_CLIENT_SECRET`<br>`MONERIUM_WEBHOOK_SECRET`<br>`MONERIUM_REDIRECT_URI` | ✅ sandbox | Sandbox self-serve at monerium.dev. **Production = regulated e-money relationship** | 🔴 for prod |
| **Candide** | ERC-4337 bundler + paymaster. Deploys the Safes, pays gas | `CANDIDE_BUNDLER_URL`<br>`CANDIDE_PAYMASTER_URL`<br>`CANDIDE_RPC_URL` | ✅ | Self-serve dashboard | 🟢 |
| **Circle CCTP** | USDC burn/mint across chains | none — contract addresses only | ✅ | Permissionless. Testnet USDC: faucet.circle.com | 🟢 |
| **Stellar** | Horizon + Soroban, cash-payout leg | `STELLAR_TREASURY_SECRET` (we generate) | ✅ testnet | Public infra, no key | 🟢 |
| **RPC provider** | Reading/writing the chain | `TRANSF_RPC_URL`<br>`CANDIDE_RPC_URL`<br>`CCTP_BASE_RPC` | ⚠️ public endpoint | Alchemy / Infura / QuickNode free tier. **Public RPC will rate-limit us in production** | 🟢 |
| **Rates feed** | Live FX mid-rates | `TRANSF_RATES_URL` | ⚠️ free tier | Defaults to `open.er-api.com`. Paid tier for reliability | 🟢 |

---

## 3. Liquidity venues (pick one or more — all optional, all fall back safely)

| Venue | Keys | Status | How to get | Call? |
|---|---|---|---|---|
| **LI.FI** | `LIFI_API_KEY` | best tested — live quotes on Base/Gnosis/Polygon | Works without a key; key raises rate limits | 🟢 |
| **CoW Protocol** | none | quotes at ~mid on Gnosis | No key. **Hard rate limit** — custom limit via their Discord | 🟢 |
| **Uniswap v3** | none | works, locally provable | Permissionless | 🟢 |
| **Bebop** | `BEBOP_API_KEY` | adapter built, never run | Contact form. Monerium is a market maker there on Ethereum | 🔴 |

> We only need **one** of these live. LI.FI is the default recommendation.

---

## 4. Payout rails

| Rail | Status | Access | Call? |
|---|---|---|---|
| **SEPA** (EUR→EUR) | ✅ works, via Monerium | — | — |
| **MoneyGram** (cash pickup) | 🔴 blocked | Needs a real partner agreement. We're on `testanchor.stellar.org`, which never publishes a payout account, so this **cannot complete end-to-end today** | 🔴 hard |
| **Bridge** (Stripe) | not integrated | Enterprise sales. Covers ACH/SEPA/SPEI/Pix and LatAm | 🔴 |
| **dLocal** | not integrated | **Public sandbox at docs.dlocal.com — start today, no call** | 🟢 |
| **Yellow Card** | not integrated | Africa, settles in USDC, no prefunding | 🔴 |

---

## 5. Not yet chosen — we need to pick one

| Need | Why | Options |
|---|---|---|
| **KYC provider** | Currently a mock. `KYC_AUTO_APPROVE` self-approves locally. **Cannot go live without a real one** | Sumsub, Persona, Onfido — all self-serve signup, sandbox in minutes |
| **eSIM / VPN fulfilment** | Privacy Bundle sells these; fulfilment is manual today | Kokio, Mysterium — credentials pending |

---

## 6. Keys we generate ourselves (nobody gives us these)

These are **wallet private keys and secrets we create**. This is the part Baer flagged, and he's right to.

| Key | Role | Risk if leaked |
|---|---|---|
| `DEPLOY_DEPLOYER_KEY` | Deploys contracts | Cold — only needed at deploy time |
| `DEPLOY_ORCHESTRATOR_KEY` | Submits transfers, pays gas | **Hot — runs continuously** |
| `DEPLOY_RAMP_KEY` | Credits deposits | **Hot** |
| `CANDIDE_COSIGNER_KEY` | 2nd signer on user Safes | **Hot** |
| `CCTP_BURNER_KEY` | Burns USDC for bridging | **Hot** |
| `STELLAR_TREASURY_SECRET` | Holds the payout float | **Hot — holds funds** |
| `MONERIUM_TOKEN_ENCRYPTION_KEY` | Encrypts user OAuth tokens at rest | ≥32 chars, app refuses to start without it |
| `KYC_OPERATOR_TOKEN` | Approves KYC decisions | Required in production |

**Where this stands re: Baer's Safe question**

- ✅ **Contract ownership is already protected.** `AdminTimelock` (2-of-3 + delay) owns the deployed contracts. No single key can raise the daily cap, grant a role, or drain the swapper. Emergency pause is instant via a separate guardian; only the timelock can un-pause.
- ❌ **The hot operational keys above are not.** They sit in `.env` as plaintext private keys. This is the real exposure.
- ❌ **`user.privateKey` is stored in plaintext** in `data/db.json` alongside user PII. The API can move funds from any user Safe. This is the known open half of FP4 and it is the single biggest security item.

Recommended: move the hot keys to a KMS or signer service (AWS KMS, GCP KMS, Turnkey, Privy) rather than `.env`. That solves both of Baer's concerns — no keys written down, and no single person's signature needed to keep the app up.

---

## 7. What blocks production boot

The app **refuses to start** in production without these. Not opinions — hard failures in `config.ts`:

```
KYC_OPERATOR_TOKEN                required
ALLOW_PLAINTEXT_STORE=1           must explicitly acknowledge the JSON store isn't production storage
MONERIUM_WEBHOOK_SECRET           required (whsec_ format, ≥24 bytes) when Monerium is configured
MONERIUM_TOKEN_ENCRYPTION_KEY     required, ≥32 chars
MONERIUM_REDIRECT_URI             must be explicit https
WEBAUTHN_ORIGINS                  explicit https, no localhost
TRUSTED_PROXY_HOPS                must be explicit
CANDIDE_COSIGNER_ADDRESS + KEY    required before hosted funding
CANDIDE_RECOVERY_GUARDIAN_ADDRESS required before hosted funding
CANDIDE_CHAIN_ID == TRANSF_CHAIN_ID
ALLOW_SIMULATION / ALLOW_MOCK_FALLBACK / CCTP_LIVE   forbidden
```

---

## 8. Honest status

Two things worth saying plainly before anyone counts this as done:

1. **A send has never completed end-to-end.** Locally it now runs quote → transfer → device signature → authorization ✅, then stops because the user's Safe isn't deployed on the local chain. `debited → bridged → paid` has never run anywhere.
2. **The MoneyGram cash rail cannot complete with any key.** The test anchor never publishes a payout account. It needs MoneyGram themselves — or we swap to **dLocal**, which has a public sandbox and no call.

**Fastest unblock, in order:**

1. Real RPC key (10 min, self-serve) → deploy a Safe on Base Sepolia → prove one send to PAID
2. KYC provider sandbox (30 min, self-serve)
3. dLocal sandbox (self-serve) instead of waiting on MoneyGram
4. Monerium production + Bridge conversations in parallel — those clocks run regardless

Steps 1–3 need **zero calls**.
