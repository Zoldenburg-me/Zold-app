# Architecture, License, and Open Surfaces

Purpose: keep one plain map of what Zold currently is, what license it ships
under, and which product/regulatory/security surfaces still need review before a
Germany-facing or EU-facing launch.

This document is an engineering map, not legal advice. It is written to surface
holes early so counsel, partners, and operators can classify the product before
any live deployment.

## License

The repository is licensed under Apache License 2.0.

Evidence:

- `package.json` declares `"license": "Apache-2.0"`.
- `LICENSE` contains the full Apache License, Version 2.0 text.

What that license means for this review:

- It is a permissive software license with copyright and patent grants.
- It does not grant trademark rights beyond reasonable descriptive use.
- It disclaims software warranty.
- It does not solve financial-services licensing, AML, data protection,
  consumer disclosure, partner approval, or production operation duties.

## Product Shape

Zold is a cross-border remittance and wallet application built around smart
accounts, e-money tokens, stablecoins, and external payout rails.

The intended user-visible shape is:

1. A user creates an account.
2. The app gates onboarding by country/residency.
3. KYC is collected through Sumsub or an operator seam.
4. A Candide Safe smart account is deployed for the user.
5. Monerium links an IBAN and issues EURe to the user's Safe.
6. The user quotes a payout.
7. The user authorizes a debit with a device key/passkey flow.
8. The app executes one of the payout paths:
   - SEPA payout through Monerium redeem.
   - Cash pickup through liquidity conversion, Bridge.xyz funding, Stellar
     anchor/MoneyGram-style withdrawal, and pickup status refresh.
9. Receipts expose a redacted public route only when the sender opts in.

## Current Runtime Components

### HTTP API and Static App

- Entry point: `services/api/src/server.ts`.
- Serves the static PWA from `services/api/public/`.
- Owns user sessions, account creation, KYC routes, quotes, transfer creation,
  transfer authorization, receipt sharing, admin views, webhooks, Monerium
  OAuth, and payout refresh routes.

Regulatory surface:

- The API decides who may use the product, what quote they receive, when a
  transfer is created, when a user is KYC-approved, and when funds move.
- This makes the API more than a passive UI in most product readings.

### Store

- Implementation: `services/api/src/store.ts`.
- Current persistence is a local JSON file.
- Stores users, sessions, quotes, transfers, crypto deposits, recovery requests,
  webhook-derived state, KYC references, sender Travel Rule fields, IBANs, and
  wallet/passkey metadata.

Open hole:

- The code itself warns that FATF originator data is plaintext JSON.
- Production requires `ALLOW_PLAINTEXT_STORE=1`, which acknowledges the risk but
  does not remove it.
- A German/EU launch needs a real data-retention, access-control, encryption,
  deletion, export, and audit-log plan.

### Country and KYC Gate

- Country gate: `services/api/src/country-policy.ts`.
- KYC config: `services/api/src/config.ts`.
- Sumsub adapter: `services/api/src/adapters/sumsub.ts`.
- Operator approval seam: `services/api/src/server.ts`.

Controls present:

- `KYC_AUTO_APPROVE=1` is forbidden in production.
- `ALLOW_SIMULATION=1` and `ALLOW_MOCK_FALLBACK=1` are forbidden in production.
- Production requires a KYC operator token.
- Sumsub webhooks are signature-checked.
- Sumsub applicant data is reduced to text fields; document media stays with
  Sumsub.

Open holes:

- KYC approval is not the same as AML compliance.
- No complete sanctions, PEP, adverse media, wallet screening, source of funds,
  source of wealth, or transaction monitoring engine is implemented locally.
- Country policy is copied into code and needs a maintained source-of-truth
  update process before launch.

### Wallet and Smart Account Layer

- Candide/Safe logic: `services/api/src/wallet/candide.ts`.
- Chain and typed-data binding: `services/api/src/chain.ts`.
- Recovery: `services/api/src/recovery.ts`.
- Recovery signer hooks: `services/api/src/recovery-signer.ts`.

Current shape:

- Users are intended to use a passkey-owned Safe.
- Production can use 2-of-2 ownership with a co-signer and token-scoped
  allowances.
- Recovery can be delayed and guardian-mediated.

Open holes:

- "Non-custodial" needs legal review. The server routes transfers, can
  co-sign under policy, and can participate in recovery. That may be enough
  control to affect custody, CASP, consumer, or marketing classification.
- Hot operational keys in `.env` remain an operational risk unless moved to a
  signer/KMS setup.

### Funding In

#### Monerium IBAN and EURe

- Monerium sandbox/client code: `services/api/src/adapters/monerium*.ts`.
- Monerium OAuth: `services/api/src/server.ts`.
- Reconcile: `services/api/src/reconcile.ts`.

Current shape:

- Monerium issues EURe to the user's Safe through a linked IBAN.
- The API consumes Monerium webhooks and also polls/reconciles orders.
- Existing Monerium users can connect through OAuth/PKCE.

Open holes:

- Production requires a Monerium production relationship.
- Zold must know whether it is Monerium's agent/distributor, an outsourcing
  provider, a purely technical front end, or an independent regulated actor.
- Customer disclosures need to make the issuer, redemption rights, fees, and
  complaint path unambiguous.

#### Crypto Payment Page and USDC Conversion

- Implementation: `services/api/src/adapters/crypto-deposits.ts`.

Current shape:

- Watches payment-page deposit addresses.
- Records incoming USDC.
- Converts only when auto-convert is enabled and the account is KYC-approved.

Open holes:

- The file explicitly states it does not screen the sending address.
- Unsolicited crypto deposits create source-of-funds and sanctions questions.
- Auto-converting USDC into EURe may be crypto exchange, e-money distribution,
  or both, depending on the final operating model.

### Quotes and Transfer Creation

- Quote route: `POST /api/quotes`.
- Transfer route: `POST /api/transfers`.
- Execution: `services/api/src/orchestrator.ts`.

Current controls:

- KYC is required before quotes/transfers.
- Daily cap exists.
- Quote expiry is enforced.
- Destination commitment binds payout target into the user's signed
  authorization.
- Rate drift is checked before execution.

Open holes:

- A daily cap is not a substitute for AML transaction monitoring.
- Fees, FX spread, slippage attribution, refund deductions, and payout timing
  need consumer disclosures.
- Corridor-specific limits are not yet modeled as a compliance control.

### SEPA Payout

- SEPA reference shaping: `services/api/src/sepa.ts`.
- Monerium redeem logic: `services/api/src/adapters/monerium-sandbox.ts` and
  Monerium client files.
- Transfer execution: `services/api/src/orchestrator.ts`.

Current shape:

- The user signs a redeem message.
- Monerium burns EURe and sends SEPA.
- The app stores payout state and receipt details.

Open holes:

- Needs Monerium production approval and clear responsibility split.
- Zold must not appear to provide unlicensed SEPA credit transfer services if
  the legal structure says Monerium is the regulated principal.

### Cash Payout

- MoneyGram adapter: `services/api/src/adapters/moneygram.ts`.
- Stellar anchor protocol: `services/api/src/stellar/anchor.ts`.
- SEP-9 mapping: `services/api/src/stellar/sep9.ts`.
- Bridge.xyz adapter: `services/api/src/bridge/bridgexyz.ts`.
- Local escrow fallback: `contracts/src/BridgeEscrow.sol`.

Current shape:

- EURe is converted to USDC.
- Bridge.xyz creates a hosted transfer plan and returns source deposit
  instructions.
- Dry-run keeps a local escrow path so demos continue without Bridge
  credentials.
- Live mode requires Bridge credentials and a Bridge destination.
- Stellar anchor/MoneyGram-style withdrawal collects originator fields and
  requires anchor-declared customer fields before opening the payout.

Open holes:

- The Bridge integration is a seam, not the full partner-confirmed production
  settlement loop.
- Live destination instructions are still configured by environment rather than
  derived from a partner-confirmed anchor withdrawal account/memo.
- MoneyGram requires a real partner agreement.
- Cash payout is likely the highest AML/money-remittance surface.

### Liquidity and FX

- Liquidity orchestration: `services/api/src/liquidity.ts`.
- DEX/RFQ code: `services/api/src/dex.ts`.
- Rates: `services/api/src/rates.ts`.
- Contracts: `contracts/src/FxSwapper.sol`.

Current shape:

- Quotes are checked against live mids.
- Execution is refused if rate drift exceeds configured bounds.
- Positive slippage can be attributed to the user.

Open holes:

- Operating a spread/FX conversion path can affect payment-service, crypto
  exchange, consumer disclosure, and tax/accounting classification.
- Venue compliance status is not part of routing decisions.

### Receipts and Public Data

- Receipt builder: `services/api/src/receipt.ts`.
- Receipt page: `services/api/public/receipt.html`.

Current controls:

- The sender chooses what to share.
- Route details are redacted by default.
- Tests sweep the serialized payload for withheld secrets.

Open holes:

- Receipt URLs, even if unguessable, need retention and expiry handling.
- Public receipts can become financial-data disclosures if defaults are widened.

### Admin and Operations

- Admin transfer summaries: `services/api/src/server.ts`.
- Health and production gates: `services/api/src/config.ts`.
- Deployment scripts: `scripts/`.

Current controls:

- Operator token gate exists.
- Production refuses many unsafe flags.
- WebAuthn origins, proxy hops, chain mismatch, webhook secrets, and managed
  recovery signer settings are checked.

Open holes:

- Admin views still expose broad operational/PII views.
- There is no role-based operator model, dual control for manual review, audit
  log retention, case management, SAR/STR workflow, or compliance export.

## External Parties and Their Role

| Party | Role | Current state | Open question |
| --- | --- | --- | --- |
| Monerium | EURe issuer, IBAN, SEPA redeem | Sandbox/integration | Is Zold agent, distributor, outsourcing provider, or independent regulated service? |
| Sumsub | KYC provider | Integrated seam | Which levels cover Germany/EU, AML, sanctions, PEP, and Monerium sharing? |
| Candide | ERC-4337 bundler/paymaster | Integrated | Production SLA, signer custody, chain support, incident response |
| Bridge.xyz | Hosted stablecoin transfer rail | First seam | Contractual `on_behalf_of`, supported corridors, KYC/KYB, travel rule, refunds |
| Stellar anchors | SEP-10/12/24 payout protocol | Implemented/tested against anchors | Production MoneyGram access and exact customer fields |
| MoneyGram | Cash pickup | Partner agreement required | Principal/agent responsibilities and corridor rules |
| Liquidity venues | EURe/USDC conversion | Multiple adapters | Venue compliance, execution disclosure, fallback behavior |
| RPC providers | Chain access | Public/default or configured | Production reliability and data-processing terms |

## Germany/EU Regulatory Surfaces to Classify

These are the surfaces counsel should classify before launch:

1. Payment services under ZAG/PSD2: deposits, withdrawals, credit transfer,
   money remittance, payment initiation, payment account operation.
2. E-money issuance/distribution/redemption: Monerium is issuer, but Zold's
   role around IBAN onboarding and redeem needs classification.
3. MiCA/CASP: crypto transfer, exchange, custody/control, execution/routing,
   and advice/placing risks.
4. AML/KYC: onboarding, sanctions, PEP, adverse media, source of funds,
   transaction monitoring, suspicious activity reporting, record retention.
5. Travel Rule: originator/beneficiary information for crypto and funds
   transfers, including Bridge/Stellar/MoneyGram handoffs.
6. GDPR: lawful basis, minimisation, retention, deletion/export, DPIA,
   processor agreements, encryption, audit logs.
7. Consumer disclosure: fees, FX spread, exchange-rate timing, refund math,
   payout timing, partner responsibilities, complaint handling.
8. Marketing claims: "non-custodial", "live", "MiCA-compliant", "cash pickup",
   and partner logo/name usage.
9. Outsourcing/agent model: who is regulated principal, who owns compliance,
   and what Zold may do under each partner contract.
10. Operational resilience: incident response, key management, service
    continuity, reconciliation, fund safeguarding assumptions.

## Open Holes Register

| Severity | Surface | Hole | Why it matters | Candidate fix |
| --- | --- | --- | --- | --- |
| Critical | Licensing | Zold actively quotes, routes, debits, swaps, and pays out | May require BaFin/payment institution, EMI-agent, or CASP classification | Counsel memo and partner operating model before live |
| Critical | AML | No complete sanctions/wallet/source-of-funds screening | KYC alone is insufficient for remittance and crypto deposits | Add compliance provider and block/hold states |
| Critical | Privacy | PII and Travel Rule fields in plaintext JSON | GDPR/security risk, especially ID numbers and addresses | Replace store with encrypted production DB and retention controls |
| Critical | Partner mode | Bridge/MoneyGram/Monerium responsibility split is not enforced in code | Cannot rely on partner licensing if Zold behaves as principal | Add partner-mode config, corridor allowlists, and contractual state gates |
| High | Custody claim | Server co-signer/recovery/orchestrator may imply control | "Non-custodial" may be overstated | Reword claims and get custody/CASP analysis |
| High | Crypto-in | Sending address is not screened | Unsolicited deposits create sanctions/source-of-funds risk | Add wallet screening before credit/conversion |
| High | Cash payout | Live destination still env-configured | Could fund wrong or unapproved payout destination | Derive destination from anchor/Bridge partner instructions |
| High | Admin ops | No case management or dual-control manual review | Compliance decisions lack audit and maker/checker workflow | Add RBAC, audit log, review queues |
| Medium | Docs | Some legacy docs still mention old CCTP strategy | Misleads implementation and partner conversations | Sweep docs after Bridge direction is final |
| Medium | Consumer disclosure | Fee/spread/refund/timing disclosure is not a first-class artifact | User complaint and consumer-law risk | Add Terms, fee schedule, refund policy, receipt wording review |
| Medium | Country policy | Country tiers are hardcoded | Partner policy can drift | Add source, version, and update process |
| Medium | Receipts | Public share links carry financial metadata | Privacy and retention surface | Enforce expiry, revocation, and minimal defaults |

## Production Go/No-Go Checklist

Do not treat the product as Germany/EU production-ready until all are answered:

- Written legal classification for Zold's role under Germany/EU law.
- Monerium production agreement and clear user disclosure of issuer role.
- Sumsub level confirmed for target jurisdictions and AML scope.
- Bridge agreement confirming supported rails, `on_behalf_of` use, KYC/KYB,
  Travel Rule, reversals, refunds, and corridor restrictions.
- MoneyGram or alternate cash partner agreement.
- Sanctions/wallet screening provider integrated before crypto credit or payout.
- Production datastore replaces plaintext JSON.
- Data-retention and GDPR user-rights workflow implemented.
- Operator RBAC, audit log, and dual-control review flow implemented.
- Public claims reviewed: non-custodial, live status, partner names, fees.
- End-to-end live-like test across each enabled corridor.

