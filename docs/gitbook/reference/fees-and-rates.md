---
description: What Zold charges and how the exchange rate on a quote is arrived at.
---

# Fees and exchange rates

## The rule

Every cost is on the quote before you approve. A quote shows the fee, and for a conversion, the mid-market rate, the rate you get and the margin between them. There is no fee that appears afterwards.

## Fees

| | Fee |
| --- | --- |
| Receiving a bank transfer | Free |
| Receiving a crypto deposit | Free; the sender pays their own network fee |
| SEPA bank transfer out | Free |
| USD account (ACH / wire) | Not open yet; fees are published when the rail is |
| Converting a USDC deposit to euros | No Zold fee; you get the venue's rate, shown on the quote |
| Network (gas) fees | Paid by Zold. You never need to hold ETH |
| Plans | Starter is free; Premium and Business are priced in Settings → Plan |

## Exchange rates

A SEPA payment is euros to euros and has no exchange rate. Rates apply when you convert a USDC deposit to euros: Zold fetches a live mid-market rate and then asks its liquidity venues for a firm price for your exact amount. Several venues are quoted in parallel and the best one is taken, and the choice is recorded on the deposit. The quote shows:

* **Mid-market rate** — the reference rate at that moment.
* **Your rate** — what the venue will deliver.
* **Margin** — the difference between the two, measured, not asserted.

If the live rate feed is unavailable, Zold does not quote. If a venue's price is unreasonably far from the mid-market rate, Zold refuses it rather than pass it on.

A quote is held for **ten minutes**. The conversion carries a minimum amount out taken from the quote, so it cannot settle below what you approved; if the venue would deliver less, it is refused.

If the conversion settles better than quoted, the difference goes to you.
