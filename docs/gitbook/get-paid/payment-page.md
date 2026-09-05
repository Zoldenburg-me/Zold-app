---
description: A link anyone can pay. zoldhq.com/pay/yourname.
---

# Your payment page

A payment page is a public link, **zoldhq.com/pay/yourname**, that shows a QR code and an address someone can pay you at. No amount field, no wallet connection on the page: the payer scans with their own wallet, which does both better than a web page can.

## Claim a handle

Profile → **Payment page** → choose a handle.

* 3 to 30 characters, lowercase letters, digits and internal hyphens.
* Unique. If it is taken you are told so.
* Handles that look like an address (starting `0x`) or that match an app route are not allowed.

You can claim a page as soon as your smart wallet exists. You can set a display name for the page that is different from your legal name; if you do not, the page shows the handle alone.

## What the payer sees

The page shows the network (Base), the token to send (USDC), the deposit address as text and QR, and an "open in wallet" link. Payments to the page are routed into your wallet.

## Privacy

The page address is public. Every payment to your page lands at the same place, and anyone holding the link can look that address up on a block explorer and see its history. The page says this in its own words. Zold does not describe payment pages as private, and you should not assume they are.

Handles are also short and human. Anyone who knows or guesses yours can find the page. If you want a link only some people can use, send them a [receipt](../send-money/tracking-and-receipts.md) or an [Invoice-Me link](invoice-me-links.md) instead.

## Coming to payment pages

{% hint style="warning" %}
**Not yet fully live.** The next version of the payment page lets a payer choose how to pay — crypto, or a euro bank transfer to your IBAN — and shows you a private receipt for each payment with who paid, how, and what was credited. Today the page takes USDC on Base only.
{% endhint %}
