---
description: Pay up to 500 recipients from one file.
---

# Bulk payments

Business plan. Payments → New draft → **Import CSV**.

Upload a CSV of up to **500 rows** and **2 MB**. Zold shows the first rows and asks you to map your columns to its fields:

| Field | What goes in it |
| --- | --- |
| Payee name | The account holder's name, exactly |
| Destination | An IBAN, or a wallet address |
| Amount | A positive decimal, e.g. `125.00` |
| Currency or asset | `EUR`, or the token for a wallet |
| Reference | Optional; appears on the payee's statement |

Rows that match a contact in your address book are linked to it, so the payee fingerprint is checked at review and at sending like any other line. Rows that do not are one-off lines.

Every row is validated before anything is saved. A malformed address, an unusable amount or a missing name is reported by row number, and the import is refused until the file is fixed. There is no partial import.

The result is an ordinary draft with one line per row. It goes through [review and sending](payments-and-approvals.md) exactly like a draft typed by hand.
