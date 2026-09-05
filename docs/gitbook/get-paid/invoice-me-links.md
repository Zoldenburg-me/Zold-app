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

The submitted invoice appears under **Invoices** with its state. Open it and press **Pay**. The bank details or wallet address come from the invoice, so nothing is retyped, and the invoice number becomes the payment reference. On a Business plan with approvals switched on, paying an invoice creates a draft that goes through [review](../business/payments-and-approvals.md) like any other payment.

## States

| State | Meaning |
| --- | --- |
| Link created | Waiting for the supplier |
| Submitted | Invoice received, ready to pay |
| Paying | A payment is in progress |
| Paid | Paid from Zold |
| Reconciled | Matched to a transaction in your books |
| Deleted | Removed before anyone was paid |

An invoice can be deleted only while nobody has been paid against it.

## Security of the link

The link is the credential. Zold stores only a hash of it, so a copy of Zold's database does not expose open invoice links. Treat the link as you would treat the invoice: send it to the supplier and no one else.
