---
description: What each status on a transfer means and who, if anyone, needs to do something.
---

# Transfer states

| State | Meaning |
| --- | --- |
| **Created** | The terms are fixed and waiting for your passkey. Nothing has moved. An unsigned transfer expires on its own. |
| **Debited** | The funds have left your wallet. |
| **Payout submitted** | The SEPA payment order has been placed with Monerium. |
| **Paid** | Done. The SEPA payment has been delivered. |
| **Manual review** | Something needs a person to look at it. Your funds are safe and accounted for; you will be contacted. |
| **Failed** | A step failed and the transfer will not complete. Compensation follows. |
| **Refunded** | What left your wallet has been returned to it, itemised on the transfer. |

A transfer's timeline shows only the states it actually passed through.

## When a transfer fails

If money has left your wallet and a later step fails with a clear refusal, Zold returns what it debited from your wallet (on a bank transfer, the fee). The transfer shows what was returned. A failure whose outcome is unknown, such as a timeout, goes to **Manual review** and you are contacted.
