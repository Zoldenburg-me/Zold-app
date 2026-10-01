# Roadmap (agreed priority)

Linked from `AGENTS.md`.

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

Before going public: domain and trademark clearance for "Zold" in fintech.

Parked deliberately: NEAR Intents, Metastable, Flexa/AMP (wrong market).

