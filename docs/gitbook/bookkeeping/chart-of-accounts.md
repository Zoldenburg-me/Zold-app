---
description: Categorise every transaction against your own accounts, and let rules do the repetitive part.
---

# Chart of accounts and rules

Business plan. Business dashboard → **Chart of accounts**.

## Chart of accounts

Your chart of accounts is the list of categories your accountant books against: revenue, cost of sales, bank fees, exchange differences, and so on. Zold starts you with a sensible default set that you can rename, extend or retire. Each account has a code, a name and a type.

Retiring an account hides it from new mappings; transactions already booked to it keep it.

## Account rules

Rules map transactions to accounts automatically, in priority order:

1. **By contact** — everything paid to or received from this contact.
2. **By wallet and asset** — for example, all USDC arriving at your payment page wallet.
3. **By wallet** — everything on this wallet.
4. **Default** — where anything unmatched lands.

A transaction is mapped by the first rule that matches. Change a rule and Zold offers to re-map past transactions that match it; transactions an accountant mapped by hand are left alone unless you choose otherwise.

## By hand

Anything a rule did not catch appears with a **Categorise** prompt on the Transactions screen. Accountants, admins and owners can map it.

## Downgrading

Your chart and your rules are kept if you leave the Business plan. They are simply not applied until you return.
