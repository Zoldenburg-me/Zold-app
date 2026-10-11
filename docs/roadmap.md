# Roadmap (agreed priority)

Linked from `AGENTS.md`.

## Milestones

Two, in order. Work that serves neither waits unless the owner pulls it in.
Tick a box only when the thing is on `main` (or, for owner items, done).

### M1 — Testnet beta is clean (current)

Done when zoldhq.com runs current main and one new tester gets from signup to
an active IBAN and a sent payment in a real browser without help.

- [ ] An issued invoice cannot be deleted: land `x/invoice-no-delete-issued`.
      The cancellation invoice (Stornorechnung) is designed, not yet built.
- [ ] Every `x/*` branch without a PR is either merged or deleted
      (`checkout-replay-window-test`, `remove-fx-swapper`, `remove-inr-upi`,
      `eu-full-card-allowlist`, `home-greeting`, `security-hardening-plan`,
      `codemaps-full-read`, `landing-test-build`).
- [ ] The open security-audit findings with no owner question are fixed;
      the five that need one are answered (queue kept outside the repo).
- [ ] Desktop copy never says "Face ID" (rest of Z-006).
- [ ] Business console: the iPad-size audit with screenshots and its
      zold-docs PR; the canvas screens exported into `design/ui-v2/screens`.
- [ ] `/business` Access screen: security and who approves payments on one
      screen, so a company login never needs `/app`.
- [ ] Agent-payments brief and scope committed, or dropped.
- [ ] Production rebuilt from main and redeployed to the Akash lease.
- [ ] One full browser run on zoldhq.com: signup, passkey, Safe, recovery
      enrolment, Monerium connect, IBAN, a SEPA send, a payment link paid.

### M2 — First real euro on Base mainnet

Done when one real euro has come in by SEPA, sat in a passkey Safe on 8453,
and gone back out, with every step in `docs/status.md` rewritten from "never
run" to what was observed.

Owner:
- [ ] Funded operator keys; Base mainnet entry in `deployments.json`;
      `npm run preflight` green; gas mode chosen (`native` or `token`).
- [ ] Monerium production OAuth app registered; the three open questions in
      `docs/status.md` answered.
- [ ] Processing agreements with the host, Brevo and Turnkey, or the service
      dropped; a host for real user data (not the current lease).
- [ ] Impressum and privacy notice (Art. 13) published.
- [ ] Domain and trademark clearance for "Zold" in fintech.
- [ ] Counsel on the wallet-tier deny list and on any Zold fee on swaps.

Build:
- [ ] Database encrypted at rest; data export and account closure routes.
- [ ] `RECOVERY_IBAN_HMAC_KEY` set; one 1 € enrolment arms an account; one
      Zoldenburg recovery runs on chain against a test Safe.
- [ ] Wallet tier: gas policy for accounts without fiat, and address
      screening before any send-to-address route opens.
- [ ] The recovery TTL before the 1 € arrives has a length.

## Partners and rails

- **Wallet tier**: the Safe and every crypto feature without KYC, for
  residences Monerium does not serve too; fiat rails keep their partner's KYC.
  Scope, owner decisions and PR order: `docs/wallet-tier.md`.

0. **Payout partners**: dLocal (stablecoin-funded payouts, 60+ markets) and
   Yellow Card (Africa, settles natively in USDC). Not engaged. Pin down
   settlement currency, prefunding, fees/FX, recipient KYC ownership, caps.
1. **Iron** (iron.xyz) sandbox → USD/GBP funding. Request-based access; the user
   must request it. EUR stays direct-Monerium.
2. **Mony partnership** (UPI One World): stablecoin top-up via our SEPA exit.
   Their inbound is manual screenshot reconciliation — the pitch is that we
   become their reconciliation layer.
3. **Chain choice is open, not settled.** EURe is on six chains; LI.FI quoted
   best on Base, CoW's EURe depth is on Gnosis, and Monerium market-makes on
   Bebop on Ethereum. Decide on liquidity and gas deliberately.
4. **Card rail — Immersve** (Mastercard principal member, so the issuer rather
   than a reseller; Base and Polygon both covered). The catch: **USDC/USDT only,
   no EURe**, so a card puts EUR/USD FX between a balance and a spend — which
   disappears on the *recipient* side. They run their own KYC, so it is a second
   identity relationship, not a reuse of Monerium's. Note:
   Immersve withdrawals are NOT permissionless, the Bank of Lithuania cut its
   EEA issuer channel (Dec 2025), Kulipa is dead, and Exodus now owns Baanx and
   Monavate. Proposal only; nothing card-side is built.

Parked deliberately: NEAR Intents, Metastable, Flexa/AMP (wrong market).

Parked until wanted: an AI assistant in the business console ("ask a question
or give a command", as Mercury's Command does). No language model runs in the
product, so an empty prompt box would promise something that does not exist.
Search (⌘K) stays the command surface; it may offer real actions next to its
results. Picking this up means choosing a model provider, what data it may
read, and which actions it may prepare (never send: a payment still needs the
user's signature).

