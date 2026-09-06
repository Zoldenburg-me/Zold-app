---
description: Watch and book wallets you hold elsewhere. Zold never signs for them.
---

# Imported wallets

Wallets → **Import wallet**. Enter an address on Base and a label; group wallets as you like.

An imported wallet is **read-only**. Zold reads its balances and transactions into your books, categorises them, includes them in reports and exports. It never holds a key for it and never signs for it.

The one-line rule: **if Zold issued the account, Zold can sign for it; if you imported it, you sign for it.** A payment drafted from an imported wallet is built by Zold and handed to you as an unsigned transaction to sign in your own wallet.

## Balances and history

On Starter you see a balance per wallet. Premium and Business open the wallet to its full history and can **backfill** transactions from before you imported it.

{% hint style="warning" %}
**Not yet fully live.** Continuous sync of imported wallets is rolling out. A wallet you import today is recorded and its balance shown; its transaction history fills in as sync is enabled for your organisation, and the Transactions screen tells you when a wallet has not been synced yet rather than showing zeros as if final.
{% endhint %}
