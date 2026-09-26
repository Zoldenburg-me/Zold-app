---
description: Every payment follows the same five screens, whichever rail it uses.
---

# How a payment works

Press **Send** on the dashboard.

## 1. Where

Choose the destination. Zold offers only destinations that can actually be paid: today that is **Europe** (bank transfer in euros). Payouts elsewhere open when a payout partner is signed; until then the **International** tile on the Pay screen is marked SOON and cannot be selected.

## 2. How

Pick the method for that destination. In Europe it is a SEPA transfer to an IBAN.

## 3. How much

Enter the amount. Zold fetches a **quote**: the amount the recipient gets and the fee. A SEPA payment is euros to euros, so there is no exchange rate. The quote is held for ten minutes.

## 4. Who

Choose a saved contact or enter the recipient's details. For a bank transfer that is the name and IBAN, plus an optional reference the payee sees on their statement.

## 5. Confirm

The confirmation screen repeats every term: amount sent, amount received, fee, recipient, reference. Approve with your passkey.

Your device signs the exact terms shown. The signature covers the amount, the transfer, and a fingerprint of the recipient's identity and account, so nothing can be changed after you approve. The transaction that moves the money out of your wallet is signed at the same moment, by you.

## After you confirm

The progress screen shows the transfer's real state as it moves. You can leave; the transfer continues without you. Open it later from **Activity**.

If a step fails after money has left your wallet, Zold returns what it debited (on a bank transfer, the fee) to your wallet, with the amount listed on the transfer. A transfer that needs a person to look at it is marked for review, and you are contacted. See [Transfer states](../reference/transfer-states.md).
