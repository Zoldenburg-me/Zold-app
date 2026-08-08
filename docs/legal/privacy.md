# Privacy Policy (Datenschutzerklärung) — DRAFT

**Not yet fit to publish.** ⚖️ marks items needing legal review; 🔧 marks items
that are currently untrue of the system and must be fixed in code before this
is published, because publishing them would itself be a misstatement.

Drafted from the actual data model (`services/api/src/store.ts`) and the actual
processors in the codebase, not from a template.

---

## 1. Controller

Zoldenburg UG (haftungsbeschränkt), Franz-Joseph-Straße 11, 80801 München.
Contact: [E-MAIL].

⚖️ A Data Protection Officer is required under § 38 BDSG in some circumstances;
confirm whether one must be appointed. Rebind, a comparable, names one.

## 2. What we collect, and why

### Account and identity

| Data | Purpose | Legal basis |
|---|---|---|
| Name, email, country of residence | Creating and operating your account | Art. 6(1)(b) — contract |
| Date of birth, residential address, nationality, identity document type, number and issuing country, mobile number, occupation | Anti-money-laundering identification, and transmission to a payout provider where required | Art. 6(1)(c) — legal obligation (GwG); Art. 6(1)(b) |
| Verification outcome and applicant reference from Sumsub | Establishing that verification succeeded | Art. 6(1)(c) |

**Identity documents and liveness media (selfie/video) are processed by Sumsub
and are not stored by us.** We hold only the reference, the outcome, and the
text fields above.

⚖️ Liveness checks may involve biometric data under Art. 9 GDPR. Confirm with
counsel and with Sumsub whether Art. 9(2) requires explicit consent in addition
to the AML basis, and whether that consent must be collected separately.

### Account and transaction data

| Data | Purpose | Legal basis |
|---|---|---|
| Your smart-account address, IBAN, passkey public key, device signing-key address | Operating the account and verifying your authorisations | Art. 6(1)(b) |
| Transfers: amounts, currencies, rates, fees, status, timestamps | Executing and evidencing transfers | Art. 6(1)(b), Art. 6(1)(c) |
| Recipient name and payout identifier (IBAN or mobile number), and any payment reference you enter | Executing the payout you instructed | Art. 6(1)(b) |
| Session records and IP address | Security, fraud prevention, rate limiting | Art. 6(1)(f) — legitimate interest |

**Note on blockchain data.** Your smart-account address and its transactions are
recorded on a public blockchain. That record is permanent, publicly readable,
and cannot be erased or corrected by us or by anyone else. Any link you create
between your identity and that address — for example by sharing a payment page
or a receipt — is likewise permanent.

## 3. Who we share it with

We do not sell personal data. We share it only as needed to provide the service:

| Recipient | What they receive | Why |
|---|---|---|
| **Monerium EMI ehf.** (Iceland) | Identity data, via Sumsub's share-token mechanism; account and order data | They issue your e-money and are your contractual counterparty for it |
| **AS LHV Pank** (Estonia) | Payment data, via Monerium | They provide the SEPA rails behind your IBAN |
| **Sumsub** | Your identity documents and the data you submit for verification | Identity verification |
| **MoneyGram** | A defined subset of identity fields (given name, family name, date of birth, address, city, postal code, country, mobile number) and the payout details | Required originator information for a cash payout — the "Travel Rule" |
| **Candide** | Your smart-account address | Deploying your account and sponsoring gas |
| Hosting and infrastructure providers | Technical data | Running the service |

**Where a payout is made outside the EEA**, the identity information above is
transmitted to the payout provider in that country. This is required by
anti-money-laundering law and is a condition of the payout being made.

⚖️ Third-country transfers need a lawful transfer mechanism identified per
recipient — adequacy decision, standard contractual clauses, or an Art. 49
derogation. Confirm which applies to MoneyGram (US) and to Sumsub.

## 4. How long we keep it

Identification and transaction records are retained for the period required by
anti-money-laundering law — in Germany generally five years after the end of
the business relationship (§ 8 GwG) ⚖️ *confirm the applicable period and
trigger*. Account data is deleted or anonymised after that period unless a
longer retention is legally required.

Data recorded on a public blockchain cannot be deleted. See clause 2.

## 5. Your rights

You have the right to access, rectification, erasure, restriction, portability
and objection, and the right to complain to a supervisory authority — for us,
the Bayerisches Landesamt für Datenschutzaufsicht.

Two limits worth stating plainly:

- We cannot erase blockchain records.
- We cannot erase records we are legally required to retain for
  anti-money-laundering purposes until that period expires.

Requests: [E-MAIL].

## 6. Security

🔧 **Must be true before publication.** Personal data including identity fields
is currently stored in a plaintext JSON file (`data/db.json`), which
`ALLOW_PLAINTEXT_STORE=1` requires the operator to acknowledge at startup.
Art. 32 GDPR requires appropriate technical measures — encryption at rest and
access control — before this policy can honestly describe our security.

Do not publish a security section until the store is replaced.

## 7. Cookies and tracking

🔧 Confirm and describe actual behaviour before publishing. The app currently
uses browser local storage for the session and the device signing key, which is
strictly necessary for the service to function. If any analytics or tracking is
added, a consent mechanism is required under § 25 TDDDG.

---

*Last updated: [DATE] · Zoldenburg UG (haftungsbeschränkt) i. G.*
