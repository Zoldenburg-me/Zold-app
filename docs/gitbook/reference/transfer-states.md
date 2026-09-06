---
description: What each status on a transfer means and who, if anyone, needs to do something.
---

# Transfer states

| State | Meaning |
| --- | --- |
| **Created** | The terms are fixed and waiting for your passkey. Nothing has moved. An unsigned transfer expires on its own. |
| **Debited** | The funds have left your wallet. |
| **Swapped** | Cash rail: converted from EURe to USDC at the venue that priced it. |
| **Bridged** | Cash rail: on the way to the payout network. |
| **Payout details pending** | The recipient's details are being completed with the payout partner. |
| **Payout funding pending** | Waiting for the payout partner to confirm receipt of funds. |
| **Payout funded** | The partner has the funds. |
| **Payout ready** | Cash rail: the pickup reference is issued and the cash can be collected. |
| **Payout submitted** | Bank rail: the SEPA payment has been sent to the payee's bank. |
| **Paid** | Done. Cash collected, or the SEPA payment delivered. |
| **Manual review** | Something needs a person to look at it. Your funds are safe and accounted for; you will be contacted. |
| **Failed** | A step failed and the transfer will not complete. Compensation follows. |
| **Refunded** | Funds returned to your wallet at the current rate, with each deduction itemised on the transfer. |

A transfer's timeline shows only the states it actually passed through. On the bank rail there is no swap or bridge step, so those never appear.

## When a transfer fails

If money has left your wallet and a later step fails, Zold reverses what it can: a completed conversion is reversed at the rate then available, and the result is returned to your wallet. The transfer shows what was returned and what, if anything, was lost to the round trip. A failure that cannot be reversed automatically goes to **Manual review** and you are contacted.
