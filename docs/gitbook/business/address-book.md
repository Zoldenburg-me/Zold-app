---
description: Contacts hold the bank accounts and wallets you pay, so nobody retypes an IBAN.
---

# Address book

A contact is a payee, not an address. One contact can hold several **bank accounts** and several **wallet addresses**, and the payment form reads from it, so the details are typed once and checked once.

Contacts → **New contact**.

* **Name** — the payee's name. On bank rails the name is part of the payout identity, so it must match the account holder.
* **Bank accounts** — IBAN or, for other currencies, the local identifier, each with a label.
* **Wallets** — an address and the network it is on, each with a label.
* **Tags and notes** for your own use.

Viewers can see contacts. Accountants, payers, admins and owners can edit them.

## Editing a contact that has drafts

When a bank account or wallet on a contact changes, any **unsent draft** that pays it is put into the **Invalid data** state and stops. It does not follow the new details. Someone opens the draft, confirms the new payee details are right, and resubmits it for review. See [Payments and approvals](payments-and-approvals.md).

This protects you from paying an old draft to a changed account without noticing.

## Contacts in your personal account

Personal accounts have the same address book, under **Saved contacts** in the app. The send flow offers your saved contacts first.
