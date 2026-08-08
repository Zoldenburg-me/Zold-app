# Terms of Service — DRAFT

**Not yet fit to publish.** Sections marked ⚖️ need review by a German lawyer
before this goes live; the reasons are specific and listed in `README.md` in
this folder. Every [BRACKET] is a value only Zoldenburg has.

Drafted against: Monerium Business + API + Personal ToS, MoneyGram's crypto
terms, and the structure used by Rebind SAS, which operates the same model on
the same e-money issuer.

---

## 1. Who we are, and what these terms cover

These terms govern your use of the Zold application and website operated by
Zoldenburg UG (haftungsbeschränkt), Franz-Joseph-Straße 11, 80801 München
("Zoldenburg", "we", "us"). Full company details are in our [Impressum](/impressum).

By creating an account or using the app you accept these terms. If you do not
accept them, do not use the app.

## 2. What Zold is — and what it is not

**Zold is software.** It is an interface that lets you use financial services
provided by licensed third parties, and lets you instruct transactions from a
blockchain account that you control.

Zoldenburg is **not** a bank, an electronic money institution, a payment
institution, a money remitter, an exchange, a broker or a custodian. We do not:

- hold your money or your crypto-assets;
- issue electronic money or operate payment accounts;
- act as counterparty to any exchange or conversion;
- have the ability to move funds from your account on our own.

Your euro balance is electronic money issued by Monerium, held on a public
blockchain in a smart-account wallet that you control with your passkey. Your
transactions are authorised by a signing key generated in your browser, which we
never receive.

> ⚖️ This section is the foundation of everything below. It must describe what
> the software actually does at the time of publication. If the architecture
> changes — in particular if we regain the ability to move user funds without
> the user — this section becomes untrue and the rest of these terms rest on it.

## 3. The licensed providers behind the service

Regulated services in the app are provided by third parties under their own
authorisations, directly to you. Each has its own contract with you, which you
must read and accept separately. We are not a party to those contracts and do
not act as their agent unless expressly stated.

| Service | Provider | Their role |
|---|---|---|
| Euro e-money account, IBAN, issuing and redeeming EURe | **Monerium EMI ehf.** (Iceland), authorised electronic money institution | Contracts with you directly; performs all related compliance |
| SEPA payment services behind the IBAN | **AS LHV Pank** (Estonia) | Monerium's payment partner; you accept their terms via Monerium |
| Identity verification | **Sumsub** | Processes your identity documents; see our [Privacy Policy](/privacy) |
| Cash payout at an agent counter | **MoneyGram**, licensed money transmitter | Performs the money transmission; assets are not held by MoneyGram until collected |
| Smart-account deployment and gas sponsorship | **Candide** | Infrastructure only |

If a provider declines, suspends or reverses a service, we cannot override that
decision. Where a provider terminates our access, the affected features stop
working — see clause 10.

> ⚖️ Confirm before publishing whether we are a *distributor* of Monerium and
> whether that requires disclosure here. Confirm the MoneyGram row once the
> partner agreement is in place; do not publish it before.

## 4. Eligibility

To open an account you must be at least 18, resident in a country we support,
and able to enter a binding contract. We refuse accounts from residents of
countries that Monerium does not support, and from customers active in business
sectors our providers prohibit. We may decline or close an account where
eligibility cannot be established.

Verification is performed by Sumsub and, where applicable, Monerium. We do not
make the verification decision and cannot overturn it.

## 5. Your account, your keys

Your smart account is controlled by a passkey on your device and by a signing
key generated in your browser. **We cannot recover either for you**, except
through the recovery process described in the app, if you have enabled it.

You are responsible for:

- keeping your device, passkey and recovery method secure;
- checking the recipient details shown before you approve a transaction;
- the accuracy of any account number, IBAN, phone number or wallet address you
  enter.

**Blockchain transactions and payouts cannot be reversed by us.** A transaction
sent to the wrong recipient is generally not recoverable. Where a transfer fails
before completion, the app attempts to return the funds automatically; where it
cannot, it records the reason and the case is reviewed manually.

## 6. Quotes, rates and fees

Before you approve a transfer the app shows the amount sent, our fee, and the
amount the recipient receives. Where currencies differ it also shows the
mid-market rate used as a reference and the resulting margin.

Quotes are valid for the period stated in the app and expire rather than being
silently repriced. Rates are obtained from live sources; if no current rate is
available the app refuses to quote rather than using a stale one.

Our fee is stated in the app before you confirm. Third-party providers may
charge their own fees under their own terms.

## 7. Acceptable use

You may not use Zold to break the law, to launder money or finance terrorism,
to evade sanctions, or for any activity our providers prohibit. You may not use
another person's identity or payment details, or provide false information
during verification.

We may suspend or close an account, and refuse or halt a transaction, where we
reasonably suspect any of the above or where a provider instructs us to.

## 8. Availability

We provide the app on an "as is" basis and do not warrant uninterrupted
availability. Blockchain networks, our providers and third-party infrastructure
are outside our control, and the app depends on all of them.

## 9. ⚖️ Liability

> **This section is a placeholder and must be drafted by a German lawyer.**
>
> The customary limitation used by comparable companies — capping liability at
> fees paid — is very likely **void** against consumers in Germany under
> § 309 Nr. 7 BGB, which prohibits limiting liability for injury to life, body
> or health, and for grossly negligent breach. A void clause does not limit
> anything; it simply disappears, leaving unlimited liability where the drafter
> believed there was a cap.
>
> Note also that Monerium's API terms cap **their** liability to us at ISK 1,000
> and require us to indemnify them. Our exposure to users is therefore not
> matched by any meaningful recourse upstream, which is a commercial fact the
> drafting should reflect.

## 10. Changes, suspension and termination

You may stop using the app and close your account at any time. Closing your
Zold account does not close your Monerium account; that is between you and
Monerium.

We may change these terms where necessary, and will give reasonable notice of
material changes. Our providers may terminate our access to their services at
their discretion, in which case affected features will stop working and we will
tell you as soon as we can.

## 11. Data protection

How we handle personal data is described in our [Privacy Policy](/privacy). In
particular, identity documents are processed by Sumsub and are not stored by us.

## 12. ⚖️ Governing law and disputes

German law applies. [Place of jurisdiction — to be set by counsel; note that a
jurisdiction clause is not enforceable against consumers in the usual way.]

We are not obliged and not willing to participate in dispute resolution
proceedings before a consumer arbitration board.

---

*Last updated: [DATE] · Zoldenburg UG (haftungsbeschränkt) i. G.*
