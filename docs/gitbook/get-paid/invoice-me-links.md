---
description: Ask a supplier for an invoice with one link. They fill it in with no account, and you pay it from Zold.
---

# Invoice-Me links

An Invoice-Me link turns "please send me an invoice" into one step. You generate a link, send it to a supplier, and they fill in their invoice through it — no Zold account, no wallet, nothing to install. When they submit, the invoice appears in your organisation ready to pay.

Available on **Premium** and **Business** plans.

## Create a link

Invoices → **Request an invoice**.

1. Optionally name the supplier and add a note (the project, the purchase order, what you are expecting).
2. Optionally set a **password**. The link is sent over email, so a password is a second factor if that email could be read by someone else.
3. Press **Create link**. Copy the link and send it to the supplier yourself.

{% hint style="info" %}
Zold does not email the link for you. It shows you the link and you send it by whatever channel you already use with the supplier.
{% endhint %}

## What the supplier does

They open the link and see a form: their details, the invoice number and dates, the lines (description, quantity, unit price — up to 200 lines), and where they want to be paid: an IBAN, or a wallet address. They submit.

Once submitted, the invoice is **timestamped and locked**. Neither side can edit it. If something is wrong, ask for a new one through a new link.

## Pay it

The submitted invoice appears under **Invoices** with its state. Press **Pay**. The supplier's bank details come from the invoice, so nothing is retyped; the supplier lands in your [address book](../business/address-book.md), and their invoice number becomes the payment reference so their bookkeeping matches it without asking. Paying an invoice creates a draft like any other payment: on a Business plan with approvals switched on it goes through [review](../business/payments-and-approvals.md), and the account holder signs it to send.

Pay needs an IBAN. An invoice where the supplier gave only a wallet address is kept on record, and you can mark it as paid elsewhere once you have settled it another way.

## States

| State | Meaning |
| --- | --- |
| Link created | Waiting for the supplier |
| Submitted | Invoice received, ready to pay |
| Paying | A payment is in progress |
| Paid | Paid from Zold — set when the payment has settled |
| Reconciled | Matched to a transaction in your books |
| Deleted | Removed before anyone was paid |

An invoice can be deleted only while nobody has been paid against it.

## Security of the link

The link is the credential. Zold stores only a hash of it, so a copy of Zold's database does not expose open invoice links. Treat the link as you would treat the invoice: send it to the supplier and no one else.
