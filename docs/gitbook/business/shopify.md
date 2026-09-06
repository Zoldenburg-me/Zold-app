---
description: Take crypto at your Shopify checkout and receive euros. Orders are marked paid the moment the payment is seen.
---

# Shopify

Zold connects to a Shopify store as a **payment method**. A customer picks Zold at checkout, pays the order in USDC on a Zold page, and Shopify marks the order paid as soon as the payment is seen. You hold the result in your Zold account and convert it to euros with your passkey, or leave it as USDC.

{% hint style="warning" %}
**Not yet fully live.** The Zold payments app has to be approved by Shopify before a store can install it. Until that approval lands, the Shopify screen in your dashboard says so and the connect button is not offered.
{% endhint %}

## Connect a store

Business dashboard → **Shopify** → enter your store's `myshopify.com` domain → **Connect store**. You are sent to Shopify to approve the app, then back to Zold. The store's access token is stored encrypted and is never shown to anyone.

The money goes to the payment page of the account that backs your organisation's EUR account (for a personal organisation, your own). That account needs a [payment page](../get-paid/payment-page.md) first.

## What happens on an order

1. The customer picks Zold at checkout. Shopify opens a payment session and sends the customer to a Zold payment page for the order amount.
2. The page shows the exact USDC figure and your payment-page address, with a QR code and an "open in wallet" link.
3. When the deposit is seen, the order is marked **paid** in Shopify and the customer is sent to the store's thank-you page.
4. The payment appears in your **Payment links** and on the dashboard's Shopify screen, with the asset it arrived in.

Each order is a [payment link](../get-paid/payment-links.md) opened for one hour. If the customer does not pay in time, the link expires and the order is not marked paid.

## Limits, stated plainly

* **EUR stores only.** Set the payment method to EUR in your store's payment settings. Another currency is refused.
* **Crypto only at checkout.** A bank transfer does not arrive within a checkout session, so it is not offered there.
* **Immediate payment only.** Manual capture ("authorize now, capture later") is not supported. Switch the method to automatic capture.
* **Refunds are made by you.** Shopify's refund request is declined with a note in your admin; you pay the customer back from your Zold account and record it on the order. Zold does not send funds back to whatever address paid, because that is often an exchange's wallet and not the customer's.
* **Test-mode orders are real money.** Shopify's test flag is carried and shown on the page, but Zold has no test money; a payment made on a test order is a real payment.
