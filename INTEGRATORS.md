# Integrators & keys

Everything Zold talks to, what it needs from us, and whether getting it costs a call.

**Status of what we actually need to go live:**

| | |
|---|---|
| ✅ Have it (sandbox) | Monerium, Candide |
| 🟢 Self-serve — no call, ~10 min each | RPC provider, LI.FI, rates feed, Stripe standard |
| 🔴 Needs a form/email first | Monerium **production** OAuth app — plus a payout partner (dLocal or Yellow Card) for anything beyond SEPA |

Only **one** is a hard blocker: the Monerium production OAuth app (identity and IBANs are Monerium's; there is no separate KYC provider). Everything else is either self-serve or optional. Full call list in §1.

---

## 1. 🔴 The call list — everything that needs a human

**Read this first.** Every one of these starts with a form or an email, **not** a call. Send them all in one sitting; the calls only happen after they reply.

| # | Who | What we need | Blocking? | Start here | Lead time |
|---|---|---|---|---|---|
| 1 | **Monerium** (production) | Real e-money relationship. Sandbox → live EUR IBANs | ✅ **YES** — no EUR in or out without it | Existing sandbox contact | Weeks–months (regulated) |
| 5 | **Stripe** | Card acceptance for Zold Plus / Privacy Bundle subs | ❌ No — nothing to bill yet | **Standard account is self-serve** — no call | Same day |
| 6 | **Yellow Card** | Africa payouts, settles USDC, no prefunding | ❌ No | yellowcard.io business form | Weeks |
| 7 | **Bebop** | RFQ liquidity. Monerium market-makes EURe there | ❌ No — LI.FI already works | Contact form | Weeks |
| 8 | **CoW Protocol** | Higher rate limit (quotes work now, throttled) | ❌ No | Their Discord — chat, not a call | Days |
| 9 | **Iron** (MoonPay) | USD/GBP funding | ❌ No | Request access form | Weeks |
| 10 | **Kokio / Mysterium** | eSIM + VPN fulfilment for Privacy Bundle | ❌ No — manual today | Partner contact | Weeks |

**If you only send one email: #1.** It is the only hard blocker.

### Stripe — two very different things

| | Access | Use for us |
|---|---|---|
| **Stripe standard** (cards, subscriptions) | 🟢 Self-serve, no call | Billing Zold Plus / Privacy Bundle. **Not integrated — no payment processor in the codebase at all** |
| **Stripe stablecoin / Bridge products** | 🔴 Sales-led | Not used. An on-ramp there would be a second identity relationship (Bridge customers and KYC links); Iron is the USD/GBP funding candidate |

---

## 2. Live integrations

| Integrator | What it does | Keys | Have? | How to get | Call? |
|---|---|---|---|---|---|
| **Monerium** | EUR issuer. Per-user IBANs, EURe on-chain | `MONERIUM_CLIENT_ID`<br>`MONERIUM_CLIENT_SECRET`<br>`MONERIUM_WEBHOOK_SECRET`<br>`MONERIUM_REDIRECT_URI` | ✅ sandbox | Sandbox self-serve at monerium.dev. **Production = regulated e-money relationship** | 🔴 for prod |
| **Candide** | ERC-4337 bundler + paymaster. Deploys the Safes, pays gas | `CANDIDE_BUNDLER_URL`<br>`CANDIDE_PAYMASTER_URL`<br>`CANDIDE_RPC_URL` | ✅ | Self-serve dashboard | 🟢 |
| **RPC provider** | Reading/writing the chain | `TRANSF_RPC_URL`<br>`CANDIDE_RPC_URL` | ⚠️ public endpoint | Alchemy / Infura / QuickNode free tier. **Public RPC will rate-limit us in production** | 🟢 |
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

SEPA is the only payout rail in the code. Anything beyond EUR→EUR waits on a payout partner; the app shows the International tile as SOON until then.

| Rail | Status | Access | Call? |
|---|---|---|---|
| **SEPA** (EUR→EUR) | ✅ works, via Monerium | — | — |
| **dLocal** | not integrated | **Public sandbox at docs.dlocal.com — start today, no call** | 🟢 |
| **Yellow Card** | not integrated | Africa, settles in USDC, no prefunding | 🔴 |

---

## 5. Still open

| Need | Status | Notes |
|---|---|---|
| **KYC** | ✅ **Monerium's** | Removed as a separate concern (Sep 2026): the user signs up or signs in with Monerium (OAuth) or adds their own Monerium API keys; the account is approved when Monerium attributes an IBAN to its Safe. No mock, no Sumsub, no operator approval |
| **eSIM / VPN fulfilment** | ❌ Not chosen | Privacy Bundle sells these; fulfilment is manual today. Kokio, Mysterium — credentials pending |

---

## 6. Keys we generate ourselves (nobody gives us these)

These are **wallet private keys and secrets we create**. This is the part Baer flagged, and he's right to.

| Key | Role | Risk if leaked |
|---|---|---|
| `DEPLOY_DEPLOYER_KEY` | Deploys contracts | Cold — only needed at deploy time |
| `DEPLOY_ORCHESTRATOR_KEY` | Submits transfers, pays gas | **Hot — runs continuously** |
| `DEPLOY_RAMP_KEY` | Credits deposits | **Hot** |
| `MONERIUM_TOKEN_ENCRYPTION_KEY` | Encrypts user OAuth tokens at rest | ≥32 chars, app refuses to start without it |
| `KYC_OPERATOR_TOKEN` | Approves KYC decisions | Required in production |

**Where this stands re: Baer's Safe question**

- ✅ **Contract ownership is already protected.** `AdminTimelock` (2-of-3 + delay) owns the deployed contracts. No single key can raise the daily cap, grant a role, or drain the swapper. Emergency pause is instant via a separate guardian; only the timelock can un-pause.
- ❌ **The hot operational keys above are not.** They sit in `.env` as plaintext private keys. This is the real exposure.
- ✅ **No user Safe owner keys exist server-side for new accounts.** The passkey is the Safe's only owner, and every debit is a UserOperation it signs at send time. Legacy 2-of-2 Safes still need the co-signer key to counter-sign until their user removes it from the app.

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
CANDIDE_RECOVERY_GUARDIAN_ADDRESS required before hosted funding
CANDIDE_CHAIN_ID == TRANSF_CHAIN_ID
TRANSF_CHAIN_ID                  must be a mainnet chain (8453)
MONERIUM_BASE_URL                must be https://api.monerium.app
MONERIUM_OAUTH_CLIENT_ID and/or MONERIUM_TOKEN_ENCRYPTION_KEY   one connection path
ALLOW_SIMULATION / ALLOW_MOCK_FALLBACK / KYC_AUTO_APPROVE / TESTNET_FAUCET_EUR / SUMSUB_*   removed; refused if set
```

---

## 8. Honest status

Two things worth saying plainly before anyone counts this as done:

1. **A send has never completed end-to-end.** Locally it now runs quote → transfer → device signature → authorization ✅, then stops because the user's Safe isn't deployed on the local chain. `DEBITED → PAYOUT_SUBMITTED → PAID` has never run on a real chain.
2. **SEPA is the only payout.** Nothing pays out in another currency; that needs **dLocal** (public sandbox, no call) or Yellow Card, both uncontracted.

**Fastest unblock, in order:**

1. Real RPC key (10 min, self-serve) → deploy a Safe on Base Sepolia → prove one send to PAID
2. dLocal sandbox (self-serve) for a first non-EUR payout
3. Monerium production OAuth app in parallel — that clock runs regardless

Steps 1–3 need **zero calls**.
