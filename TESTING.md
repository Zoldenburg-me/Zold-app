# Testing Zold end to end

Everything below runs on macOS/Linux with **Node.js ≥ 22** and free ports
`3000`, `8545`, `8546`. No other system dependencies.

```sh
npm install
npm run compile
```

## Level 0 — automated checks (5 min, no accounts needed)

```sh
npm run test:contracts   # 6 Solidity tests: FX access/slippage, AdminTimelock governance
npm run audit:deps       # npm advisory scan
npm run check            # everything offline: contracts, typecheck, ~40 focused harnesses
```

`npm run check` is the one that matters before pushing — it allocates a random
free port for the whole run, which is why a suite passing on its own is weaker
evidence than it looks. It is offline.

The suites that boot their own chain + API refuse to start while `npm run dev`
holds their ports, and say so.

## Level 1 — the app on local hardhat (10 min, no accounts needed)

```sh
npm run dev              # then open http://localhost:3000/app
```

`/` serves the landing page; the app is at `/app`.

1. **Onboarding** — enter a name and email, create a passkey, "Open my
   account". The harness chain auto-approves and lands on the dashboard with a
   real Candide Safe smart-account address (computed offline, same tech as
   production) and no IBAN: hardhat has no Monerium.
2. **Add money** — mint MockToken EURe to the Safe address from hardhat
   account 0 (the token owner); the balance reads straight from the Safe.
3. **🏦 Bank transfer** — quoting works end to end, but the
   SEND ITSELF REFUSES on local hardhat by design: every debit is a
   UserOperation the passkey signs through Candide's bundler, which does not
   exist on chain 31337. Expect the clear refusal ("active passkey Safe before
   transfers can be executed"). Executed sends need `npm run api` against Base
   Sepolia with a deployed, funded Safe — see Level 2.

The Monerium gate: on any chain but hardhat a new account lands on the
"Connect Monerium" screen instead of the provisioning spinner. The
screen asks whether the user already has a Monerium account. Choosing the
existing-account path records that branch for the upcoming OAuth build; choosing
the new-account path continues the normal identity-review state. The dashboard
can still be opened, but add-money and send controls stay unavailable until the
account becomes `approved`.

## Level 2 — real sandboxes (optional, ~20 min setup)

### Monerium (real IBANs on real smart wallets)

1. Create a (free) sandbox app at <https://monerium.dev> → copy credentials.
2. `cp .env.example .env`, fill `MONERIUM_CLIENT_ID` / `MONERIUM_CLIENT_SECRET`.
3. `npm run monerium:check` — must print `auth ok`.
4. `npm run dev` → create a user. The onboarding steps now run for real
   (~30s): Safe deployed gasless on Base Sepolia via Candide's public bundler,
   address linked to Monerium via EIP-1271, real sandbox IBAN issued.
5. Fund it: log into the sandbox portal → *Receive* → simulate a SEPA
   transfer to the user's IBAN. Real test EURe mints to the Safe on Base Sepolia;
   the balance reads straight from the Safe within ~15s.
6. **Real exit flow**: after a portal deposit, a 🏦 Bank transfer places a
   real Monerium redeem order (watch `sepa.orderId` on the transfer, state
   PAYOUT_SUBMITTED → PAID). Without a portal deposit the redeem is refused
   and the transfer fails closed, recording Monerium's actual rejection.

## Known limitations (by design, MVP)

- On local hardhat EURe/USDC are MockTokens and no passkey Safe can deploy
  (no ERC-4337 bundler), so sends refuse there by design.
- No user Safe owner keys are stored server-side: every debit is signed by
  the user's passkey at send time.
- Fresh `npm run dev` resets the local chain + demo users (`data/db.dev.json`).

## Liquidity venues

```sh
npm run lifi:test   # 16 checks — aggregated routes bound, wrong answers refused
npm run dex:test    # 12 checks — pool prices checked against an independent mid
npm run best:test   # 13 checks — better price wins, surplus measured
```

The venues convert inbound USDC deposits to EURe inside the user's Safe; no
send path uses them. All three suites are offline. What they cannot cover is
a real swap: LI.FI publishes no testnet, and Base Sepolia has no EURe/USDC
pool. `npm run dex:setup` reports
exactly what is missing and refuses rather than half-running; `-- --fix` creates
and seeds a pool once the treasury holds EURe.
