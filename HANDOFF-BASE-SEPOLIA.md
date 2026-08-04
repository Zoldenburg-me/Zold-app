# Zold on Base Sepolia — testing handoff

A live deployment of the Zold payment contracts on **Base Sepolia (chain 84532)**,
wired to **Monerium's real EURe**. This document is what you need to test it.

Written 27 July 2026. Everything below was read off-chain or off Monerium's API
at that time, not copied from a spec.

---

## 1. What this is

Zold moves euros across a border. A user gets a real IBAN, is paid into it, and
the balance can be sent out three ways: cash pickup, SEPA transfer, or UPI.

The part that matters for testing: **balances live in a contract, and only the
user's own key can authorise spending them.** The server submits transactions
and pays gas; it cannot move anyone's money.

---

## 2. Addresses

Chain **84532** (Base Sepolia) · RPC `https://sepolia.base.org` ·
Explorer `https://sepolia.basescan.org/address/<addr>`

| Contract | Address |
|---|---|
| RemitVault | `0x4783ac4bac0523511215cbe7dea7158a07c2a78a` |
| FxSwapper | `0x7b19ccdfb4bcc1bbc12daa2e94e5ad694c8613b8` |
| BridgeEscrow | `0x11cb28ccb5231c9aedfc818221b0fe7d11085e07` |
| AdminTimelock | `0xe560f041a8175d72558836159573550eaa89f8c4` |

| Token | Address | Note |
|---|---|---|
| EURe | `0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85` | **Monerium's real token.** Not ours, not mintable by us |
| USDC | `0xf94c01838c60f4ddf9519da75180feac7450303a` | **Our mock.** Deployer can mint freely |

ABIs: `contracts/artifacts/contracts/src/<Name>.sol/<Name>.json`.

### Live state when this was written

```
vault.token()          0x29F37F6a…db85     Monerium's EURe
vault.owner()          0xE560f041…f8c4     the timelock
vault.dailyCap()       2500 EUR
vault.totalCredited()  121 EUR
swapper.rate()         1.138971 USDC per EURe
swapper USDC stock     1,000,000
swapper EURe stock     0
timelock               2-of-3, 60s delay
```

---

## 3. Read this before you spend an hour confused

**EURe cannot be minted.** It is Monerium's contract. The only way EURe comes
into existence is a real SEPA transfer to a provisioned IBAN. Mock USDC you can
mint at will.

**The swapper holds zero EURe.** EUR→USDC works (a million USDC in stock). The
reverse direction — used by refunds and FP3 compensation — will fail for lack of
inventory until someone sends real EURe to the swapper. That is expected, not a
bug you have found.

**The 121 EUR in the vault is not spendable.** It is credited to
`0x4965837bDAe95341a9f763a2406761cd30e5C99B`, whose device key was lost. Only
the current authorizer may rotate, so that balance is stuck permanently. Treat
it as scenery.

**The vault is owned by the timelock.** Changing the cap, granting roles or
unpausing needs 2 of 3 signers and a 60-second delay. Pausing is instant through
the guardian role; starting again is the part that waits.

**`debit` will not accept the orchestrator alone.** It verifies an EIP-712
`PaymentAuthorization` signed by the account's registered authorizer, with the
payout destination hashed into the signed struct. This is the core security
property — try to break it (see §6).

---

## 4. Running the stack against this deployment

```bash
export PATH="$PWD/.toolchain/node-v22.17.0-darwin-arm64/bin:$PATH"
npm run api          # NOT `npm run dev` — that starts a local hardhat chain instead
```

`.env` already points at Base Sepolia:
`TRANSF_CHAIN_ID=84532`, `TRANSF_RPC_URL=https://sepolia.base.org`,
`MONERIUM_CHAIN=basesepolia`, Candide bundler/paymaster on 84532.

Health check, which also prints the addresses the API is using:

```bash
curl -s localhost:3000/api/health | python3 -m json.tool
```

### Databases — worth knowing so you don't lose work

| Path | Used by |
|---|---|
| `data/db.json` | the real app (`npm run api`) |
| `data/db.dev.json` | local demo stack (`npm run dev`) |
| `$TMPDIR/zold-test-db-<pid>.json` | every test harness |

`npm run dev` and the test suite both **reset** their database on start. They
can no longer touch `data/db.json`, but if you provision an account on Base
Sepolia, **back that file up immediately** — it holds the Safe owner key, and
losing it strands the account permanently.

### Gas

Three EOAs pay gas; user Safes never do (Candide's paymaster sponsors them).

| Role | Address | Needs gas |
|---|---|---|
| Orchestrator | `0x625bA0de5Fa2E5E49BbA182b723F94DB1bAF2376` | every payment |
| Ramp | `0x2092048B38d105438a325626340C6a41eb4675FD` | every deposit, every device binding |
| Deployer | `0xaEeB496310Aa700c2b2737A7BdC4dE71984A4677` | deploys only |

Top up from any Base Sepolia faucet. A deploy costs ~0.00004 ETH; individual
transactions are far less.

---

## 5. Onboarding an account (needed for any end-to-end test)

Off a local chain, two gates fail closed by design:

1. **KYC** does not auto-approve. Approve through the operator endpoint:

```bash
curl -s -X POST localhost:3000/api/kyc/review \
  -H "content-type: application/json" \
  -H "authorization: Bearer $KYC_OPERATOR_TOKEN" \
  -d '{"userId":"<id>","decision":"approved"}'
```

`KYC_OPERATOR_TOKEN` is in `.env`.

2. **A passkey is required before an IBAN is issued.** Real WebAuthn does not
   resolve headlessly. For API-driven testing run the server with
   `ALLOW_SIMULATION=1`, which relaxes that gate and the device-key binding
   gate.

`ALLOW_SIMULATION=1` does **not** enable `ALLOW_MOCK_FALLBACK`. Payouts still
run for real and fail closed if Monerium refuses — so a redeem you observe is a
genuine redeem.

Once approved, provisioning deploys the Safe gaslessly, links it to Monerium and
requests an IBAN on `basesepolia`. Takes ~30 seconds. Then send a real SEPA
transfer to that IBAN to create EURe.

---

## 6. What is worth testing

### Contract level, no API needed

- **`debit` rejects a signature from any key but the registered authorizer.**
  This is the property everything rests on.
- **`debit` rejects a changed payout destination.** The recipient's IBAN/phone/VPA
  *and name* are hashed into the signed struct; recompute with a different
  recipient and it must revert with `bad authorization`.
- **Replay.** The same `transferId` twice must revert `duplicate transfer`.
- **`creditDeposit` refuses an uncovered credit** — it requires
  `balanceOf(vault) >= totalCredited + amount`.
- **`setAuthorizer` is trust-on-first-use.** The ramp may bind an unbound
  account; after that only the current authorizer may rotate. Try to rebind as
  the ramp and confirm it reverts.
- **Daily cap** — 2500 EUR, enforced per user per UTC day.
- **Timelock** — a single owner cannot execute; two can, but not before the
  delay; and confirmations from a removed owner must not count.

### Flow level

- `npm run eur:proof` — walks deposit → mint → mirror → redeem, checking each leg
  against **Monerium and the chain**, never our own database. It refuses to
  report success if any leg fails.
- A **SEPA payout** exercises `vault.debit` → forward EURe to the Safe →
  `redeemToIban`. The forward exists because Monerium burns from the user's own
  Safe (EIP-1271), while the debit sends euros to the orchestrator.
- A **cash payout** additionally drives EURe→USDC through the swapper, CCTP, and
  the Stellar anchor. See §7 for what will stop it.

### Existing suites

`npm run check` runs everything (20 suites). Safe to run — it uses its own
database and its own local chain, and cannot touch Base Sepolia state.

---

## 7. Known-unproven, so you can tell a real failure from a known gap

Updated Aug 2026. Three items that used to sit here are now PROVEN and have
been moved out — leaving them in would have sent you re-proving them.

**Proven since this doc was written:**

- **CCTP has executed live.** Burn
  `0x7dfb7af87e9e5cf0b26bb7f3cda87327cf487127e5e342f40f0b3200fd07dd9d` on Base
  Sepolia, Stellar mint
  `4b80014cde687b322985269a92be04a60a1825709bd077855a817f239bd1a037`. Measured
  ~15 minutes to hard finality; `CCTP_MIN_FINALITY=1000` with a `CCTP_MAX_FEE`
  is Circle's Fast Transfer and settles in seconds.
- **The Stellar treasury holds the anchor asset**: 20 USDC, issuer
  `GBBD47IF…`, which is the same USDC MoneyGram's anchor uses.
- **MoneyGram's own test anchor works without an allowlist.**
  `extmgxanchor.moneygram.com` authenticates our treasury over SEP-10 and
  publishes real limits (min 15, max 2500 USDC) — so the "testanchor caps at 10
  units" note no longer bounds anything. `extstellar.moneygram.com` is the other
  deployment and refuses without `client_domain`.
- **A real Stellar payment lands**: 1.5 XLM with an id memo, ledger 3965805.

**Still unproven:**

- **The redeem has never run on Base Sepolia.** It has run on Sepolia: a real
  order processed, on-chain EURe went 200.00 → 199.00. On Base it is written and
  untested.
- **No anchor has ever been paid.** MoneyGram opens a withdrawal but never
  publishes `withdrawAnchorAccount` until a human completes the interactive page
  at `extramps.moneygram.com`. That is SEP-24 working as designed, not a gap in
  our code — `sendSep24WithdrawalPayment` correctly refuses when the account is
  absent, and cannot be exercised headlessly against any conforming anchor.
- **Bebop has never been reached with credentials.** EURe IS supported — Monerium
  market-makes on Bebop, on Ethereum — but the API returns `UnknownError` for
  every pair without an API key, including a known-good control. Untested, not
  ruled out.
- **No liquidity venue has settled on a real chain.** LI.FI executed both
  directions against a *forked* mainnet (1000 USDC → 865.06 EURe, 500 EURe →
  574.33 USDC at 8bps) — real quote and routing, local settlement.

---

## 8. Where the interesting code is

| Area | File |
|---|---|
| Vault, device authorization | `contracts/src/RemitVault.sol` |
| Governance | `contracts/src/AdminTimelock.sol` |
| Payment orchestration, compensation | `services/api/src/orchestrator.ts` |
| Deposit mirroring, redeem | `services/api/src/adapters/monerium-sandbox.ts` |
| Quotes, live FX | `services/api/src/fx.ts`, `rates.ts` |
| Liquidity (local swapper / RFQ) | `services/api/src/liquidity.ts` |
| Safe deployment, EIP-1271 signing | `services/api/src/wallet/candide.ts` |

`CLAUDE.md` carries the full state of the project, including the open security
items and the FP4 recovery plan.

---

## 9. The one thing we would most like broken

**Move someone's money without their device key.** The whole design claims the
server cannot do this. If you find a path — through the orchestrator, the ramp
role, the timelock, the mirror, the compensation path, or a signature that
validates against the wrong terms — that is the finding worth having.

Second to that: **make the vault credit a balance it does not hold**, or make a
failed transfer refund a user who was never debited.
