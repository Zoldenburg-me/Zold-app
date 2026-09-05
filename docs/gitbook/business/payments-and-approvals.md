---
description: Draft, review, send. Two people, never one pressing the same button twice.
---

# Payments and approvals

A business payment has more than one person in it. In Zold that is a **draft**: something one person prepares, another reviews, and the account's signer sends.

Payments → **New draft**.

## Draft

A draft has one or more **lines**. Each line pays one payee one amount in one currency: a contact's bank account or wallet, or details typed in for a one-off. Save it, come back, add lines. A draft can be edited while it is a draft.

## Submit for review

When it is ready, **Submit for review**. The draft is locked and appears in the reviewers' queue.

On a Business plan with approvals, a draft **must** be reviewed before it can be sent. On Starter there is no review step, and the person who drafts can send.

## Review

An admin or owner opens the draft, checks each line, and **approves** or **rejects** it with a note.

**Four eyes.** The reviewer cannot be the person who drafted it, whatever their role. An admin who drafts a payment still needs a second admin to approve it.

## Invalid data

At save time each line records a fingerprint of the payee's details. It is checked again at review and again at the moment of sending. If a contact's account changed in between, the draft moves to **Invalid data** and stops. Someone reopens it, confirms the details, and submits it again. So an address-book change between approval and sending is always caught.

## Send

**Send** turns the approved draft into one transfer per line. Every line is planned before anything is created: a gated currency, an amount below the fee, an amount over a limit, or an insufficient total balance stops the whole batch with nothing sent. The balance is checked against the **total** of all lines, not line by line.

The member whose wallet backs the account signs each transfer with their passkey. A payer can approve and press send, but only that member can sign; the screen tells you who that is.

## What can go wrong

If one line fails part-way, the lines before it exist as unsigned transfers that cannot move money and simply expire. The draft is marked **Failed**. To send again, create a new draft; this avoids stacking a second batch on the first.

A draft's status is always read from its transfers. It cannot show "sent" while one of its payments is still under review.

## States

| State | Who acts next |
| --- | --- |
| Draft | The drafter |
| Pending review | A reviewer who is not the drafter |
| Reviewed | The account's signer |
| Rejected | The drafter, with the reviewer's note |
| Invalid data | Anyone who can draft, to confirm the payee |
| Executing | Nobody; transfers are moving |
| Executed | Done |
| Failed | The drafter, to re-draft |
