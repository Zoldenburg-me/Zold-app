---
description: Get the books out of Zold and into your accountant's software.
---

# Export and integrations

## Accountant export

Business dashboard → Books → **Accountant export**.

Every movement on your EUR account appears as **one line per economic event**, the way a PayPal or Stripe clearing account appears in the books: a SEPA credit, a SEPA payment, a payment received in USDC and converted, a USDC amount held, a reversal. Behind a crypto payment there are two or three on-chain steps; the line shows the euro figure once, and its **Beleg** holds the detail.

Pick a month and press **Prepare**. Zold issues a Beleg for every line that does not have one yet. Then download:

* **Lexware Office CSV** — the bank-import template Lexware publishes (Buchungstag, Valuta, Auftraggeber, Empfänger, Verwendungszweck, Betrag, Zusatzinfo). Import it onto an offline account in Lexware Office. The Beleg code is in the last column.
* **Belege ZIP** — one PDF per line, named `<date>_<code>_<reference>.pdf` so it maps to its line.

Each Beleg is a frozen, signed document at `zold.to/v/<CODE>`, re-verified whenever it is opened. A USDC-paid invoice's Beleg shows the invoice number and payer, what arrived and when the chain says so, the ECB reference rate it was valued at, the conversion's transaction, venue, rate and amounts, the difference to the receivable and the gain or loss, and the gas.

{% hint style="info" %}
USDC received is valued at the **ECB reference rate** for the day it arrived. The ECB publishes once per business day, so the rate on the Beleg is that day's reference rate, not the rate at the minute of the transaction. On a weekend or before the day's publication, the previous business day's rate applies, and the Beleg says which day it used.
{% endhint %}

## GetMyInvoices

Settings → **Accounting connector**. Paste the API key from your GetMyInvoices account (Settings → API). Zold checks it once, stores it encrypted, and never shows it again.

With a key connected, the export page gains **Push Belege to GetMyInvoices**: every Beleg of the month is uploaded as a paid payment document with the Beleg code as its document number. Documents already there are skipped, so pushing twice uploads nothing twice. Bank lines go in through the Lexware CSV above.

{% hint style="warning" %}
**Not yet fully live.** The connector has been tested against a stand-in of the GetMyInvoices API, not by uploading to a live account. Ask before relying on a push for a closing period.
{% endhint %}

## CSV export (ledger)

Premium and Business. Business dashboard → Transactions → **Export** gives the full ledger as a generic CSV with date, asset, amount, reporting-currency value, counterparty, chart-of-accounts mapping and tags. The monthly balance report exports the same way from **Reports**.
