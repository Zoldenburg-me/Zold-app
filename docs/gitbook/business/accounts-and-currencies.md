---
description: One organisation, an account in the currency of each place you do business.
---

# Accounts and currencies

Your **global account** is a set of local accounts. Each local account is in the currency of a place, with the identifier locals use, paying out on that place's rail: an IBAN in the euro area, an account and routing number in the United States, a sort code in the UK, an M-Pesa number in Kenya. All of them sit in the same wallet. On Premium and Business, an organisation can hold several.

Accounts → **Open an account** → choose a currency.

## Euro — open now

The first of your global accounts.

The euro account is your IBAN and EURe wallet, issued by Monerium. It is described in [Your euro account](../getting-started/your-euro-account.md) and pays out by SEPA. Its settlement token, **EURe**, is e-money under MiCA with a redemption right at par against a licensed issuer.

## Other currencies

Every currency below is shown in the app with its status. Where an account is not open yet, you can request it now; it is opened the day the rail is ready and you are told in the app.

### US dollar — next

{% hint style="warning" %}
**Not yet fully live.** USD accounts are being added through Bridge and open soon. Request one now and it is opened the day the rail is ready.
{% endhint %}

A USD account gives you a US account number and routing number in your name, receives ACH and domestic wire, holds the balance as USDC in your wallet, and pays out by ACH or wire to any US bank. Bridge issues the account and settles the dollar side, and runs its own verification when you open it. Full description: [Your US dollar account](../add-money/usd-account.md).

### Pound sterling

{% hint style="warning" %}
**Not yet fully live.** GBP accounts open with a UK account provider.
{% endhint %}

A GBP account gives you an account number and sort code and pays by Faster Payments.

### Swiss franc

{% hint style="warning" %}
**Not yet fully live.** The ZCHF token exists and is liquid, but a token is not an account: there is no Swiss IBAN issuer and no franc on- or off-ramp yet.
{% endhint %}

The settlement token in view is **ZCHF (Frankencoin)**, minted against crypto collateral held by a decentralised protocol, with the peg defended by auctions. There is no issuer who owes a holder redemption at par. That is a different kind of instrument from EURe, and the app shows the difference rather than flattening both to "CHF".

### Kenyan shilling

{% hint style="warning" %}
**Not yet fully live.** A KES account (M-Pesa) opens with a Kenyan payout partner. Cash pickup to Kenya is available today from your euro account.
{% endhint %}

### Nigerian naira

{% hint style="warning" %}
**Not yet fully live.** NGN accounts open with a Nigerian payout partner and an issuer relationship for cNGN.
{% endhint %}

A naira account gives you a NUBAN and pays by NIP bank transfer. The settlement token is **cNGN**, backed by naira reserves and regulated in Nigeria by the Securities and Exchange Commission, with the Central Bank keeping payment-system oversight. Its liquidity is on Base, the same network as your Zold wallet. It is regulated in Nigeria, not in the EU, so a holder in the EEA has no EU protection on it; the account screen shows this.

### Indian rupee

{% hint style="warning" %}
**Not yet fully live.** INR payouts by UPI open with an Indian payout partner.
{% endhint %}

## The token column

The Currencies table in the business dashboard shows, for each currency, the settlement token where one exists, who issues it, and **what backs it**, in a sentence. E-money with a redemption right, a collateralised peg, and a reserve-backed token under another country's regulator are three different things. The column exists so that you can tell them apart before holding any of them.

## Funding an organisation's account

A new organisation's account needs a wallet to back it. Accounts → the account → **Fund** links a member's own verified account to it. From then on, that member signs the organisation's payments from that account.
