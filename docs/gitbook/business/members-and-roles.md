---
description: Several people, each allowed to do exactly what their job needs.
---

# Members and roles

Members → **Invite**. Enter an email address and choose a role. Zold gives you an invitation link to send; it expires after **3 days**. The invitee signs in with their own passkey and lands in your organisation with the role you chose.

{% hint style="info" %}
Zold does not send the invitation email. Copy the link and send it yourself.
{% endhint %}

## Roles

| Role | Reads everything | Drafts payments | Approves payments | Sends money | Manages the books | Admin |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Viewer** | ✓ | | | | | |
| **Accountant** | ✓ | ✓ | | | ✓ | |
| **Payer** | ✓ | ✓ | | ✓ | | |
| **Admin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Owner** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ plus billing and closing the organisation |

**Accountant** exists because the person who categorises transactions is usually not the person allowed to send money. An accountant can manage contacts, draft payments, categorise the ledger, edit the chart of accounts and run reports, but cannot execute a payment.

**Payer** is the mirror: money, not books. A payer can send, but cannot approve a draft and cannot touch the chart of accounts.

**Admin** can do both, invite and change members, open accounts and review drafts. **Owner** additionally handles the plan and can close the organisation.

## Two checks, always

Whether you can do something depends on **your role** and on **what the organisation's plan includes**. Both must pass. A viewer on a Business plan cannot send money; an owner on Starter cannot open the chart of accounts. The screen tells you which of the two is the reason.

## Review is never by the same person

Whatever your role, you cannot approve a payment you drafted yourself. See [Payments and approvals](payments-and-approvals.md).

## Leaving and deactivating

Members are **deactivated**, not deleted, so their history stays attributed. An organisation can never lose its last owner: the change that would remove or demote the final active owner is refused.

## Who can sign

A payment is signed by a passkey in one person's browser. Each account records which member's wallet backs it. A payer may approve and press send, but only the member whose wallet holds the money can produce the signature. If you try to send from an account you do not back, the app tells you who can.
