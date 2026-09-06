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
| SEPA bank transfer out | Fixed fee per transfer, shown on the quote |
| Cash pickup | Fixed fee per transfer plus the exchange-rate margin, both shown on the quote |
| Receiving ACH or wire to your USD account | Free |
| ACH or wire payout | Fixed fee per transfer, shown on the quote |
| Euro ↔ dollar conversion | Margin shown on the quote |
| Network (gas) fees | Paid by Zold. You never need to hold ETH |
| Plans | Starter is free; Premium and Business are priced in Settings → Plan |

## Exchange rates

For a conversion, Zold fetches a live mid-market rate and then asks its liquidity venues for a firm price for your exact amount. Several venues are quoted in parallel and the best one is taken, and the choice is recorded on the transfer. The quote shows:

* **Mid-market rate** — the reference rate at that moment.
* **Your rate** — what the venue will deliver.
* **Margin** — the difference between the two, measured, not asserted.

If the live rate feed is unavailable, Zold does not quote. If a venue's price is unreasonably far from the mid-market rate, Zold refuses it rather than pass it on.

A quote is held for **ten minutes**. At execution, the rate is checked against the quote; if the market has moved beyond a small band since you approved, the transfer is refused and refunded rather than settled at a rate you did not see.

If the conversion settles better than quoted, the difference goes to you.

## Cash pickup

The local-currency amount on a cash-pickup quote is Zold's estimate of MoneyGram's rate. MoneyGram sets the final amount when the payout is funded; the transfer detail shows it.
