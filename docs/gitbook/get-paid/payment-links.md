---
description: Ask for an amount with one link. The payer chooses crypto, a bank transfer or their Zold account, and you see when it lands.
---

# Payment links

A payment link is a request for a specific amount: **zoldhq.com/pay/yourname/XXXXX-XXXXX-XXXXX**. Where your [payment page](payment-page.md) is a standing address anyone can pay any amount to, a payment link says *what* you are asking for and shows the payer *how* to pay it, then tells you when the money arrives.

## Create a link

Profile → **Payment links** → **New link**.

* **Amount** in euros, or leave it empty and the payer types the amount.
* **What it is for** — a line the payer sees, such as an invoice number.
* **Ways to pay** — tick what you offer. USDC needs a payment page; bank transfer needs your IBAN.

Copy the link and send it however you like. Links are open for seven days unless you set another date, and you can cancel a link that nobody has paid yet.

## What the payer sees

The page shows who is asking, the amount and the description, and a tab for each way to pay:

| Method | What the payer does | How it is matched to your link |
| --- | --- | --- |
| **Crypto (USDC)** | Sends the exact USDC figure shown to your payment-page address on Base, by QR or "open in wallet". | By amount. Every link quotes a distinct USDC figure. |
| **Bank transfer** | Sends euros to your IBAN with the link's code as the payment reference. | By the reference on the incoming transfer. |
| **Zold account** | Opens the Zold app with your account, the amount and the reference filled in, and approves with their passkey. | The same reference, on a transfer Zold itself made. |

The USDC figure comes from the live EUR/USD mid-market rate plus a stated **0.5% conversion allowance**, and the page says so. It holds for 15 minutes, then re-prices; any figure the page has shown still counts if it is paid. You are credited what the conversion actually delivers, and the link records both the euro amount asked for and what you hold.

The page refreshes itself. When a payment is seen it shows the payer "Paid", and your Payment links screen shows the payment with the asset it arrived in.

## Partial and over-payments

A payment a little under the figure (within 0.5%) counts in full. A payment well short of it is recorded as **partial** and the link stays open for the rest. A payment of double the figure is not attributed to the link at all; it stays on your account as an ordinary deposit for you to look at.

## Bank details on the page

A link that offers bank transfer shows your IBAN and the **name on the account**. A SEPA transfer cannot be made without them, and since October 2025 banks compare the beneficiary name before sending. A link that offers crypto only shows neither.

## What a payment link is not

It is not private in the way a receipt is: the person you send it to can forward it. The code is unguessable (a random 15-character code), so nobody finds it by trying, but treat the link like the invoice it stands for.

Crypto payments are matched by amount, so if a payer types a rounded figure that sits between two of your open links, Zold books it to the closest one. The link screen shows which deposit went where, so a wrong guess is visible rather than silent.
