---
description: Watch and book wallets you hold elsewhere, or bring your company's existing Safe into Zold as its account.
---

# Imported wallets

There are two different things here. A **watched wallet** is one you only book in Zold; Zold never signs for it. **Your company's existing Safe**, brought in when you open the account, becomes the account itself, and Zold signs for it with your Face ID like any account it opened.

## Watched wallets

Wallets → **Import wallet**. Enter an address on Base and a label; group wallets as you like.

An imported wallet is **read-only**. Zold reads its balances and transactions into your books, categorises them, includes them in reports and exports. It never holds a key for it and never signs for it.

The one-line rule: **if Zold issued the account, Zold can sign for it; if you imported it, you sign for it.** A payment drafted from an imported wallet is built by Zold and handed to you as an unsigned transaction to sign in your own wallet.

### Balances and history

On Starter you see a balance per wallet. Premium and Business open the wallet to its full history and can **backfill** transactions from before you imported it.

{% hint style="warning" %}
**Not yet fully live.** Continuous sync of imported wallets is rolling out. A wallet you import today is recorded and its balance shown; its transaction history fills in as sync is enabled for your organisation, and the Transactions screen tells you when a wallet has not been synced yet rather than showing zeros as if final.
{% endhint %}

## Bringing in your company's existing Safe

If your company already holds its money in a Safe, for example one controlled by a Ledger, you can use that Safe as the company's Zold account instead of opening a new one. No money moves.

1. Create the company account and set up Face ID. Zold then asks where the money should sit: choose **Use our company's existing Safe**.
2. Paste the Safe's address. Zold shows its owners, how many approvals it needs and its network, so you can check it is the right one.
3. Choose how to add your phone:
   - **Keep your wallet as a second owner** (the default). Afterwards your phone or your wallet can each approve on their own.
   - **Replace your wallet with your phone.** Your wallet stops being an owner for good.
4. Tap **Download for Safe{Wallet}**. In app.safe.global, connect the wallet that owns the Safe, open **Apps → Transaction Builder**, drag the file in, and sign and send it with your wallet. Zold never sees or sends that signature.
5. Back in Zold, tap **I've sent it**. Zold checks the Safe on the network and makes it the company's account. If the change has not arrived yet, wait a minute and check again.

Until step 5 succeeds you can still choose **Use a new account instead**. Once the company has its own new account, it can't bring in a Safe later.

Zold works with Safes that need one approval per payment, have at most one other owner, and are set up like the Safes Zold opens itself (Safe version 1.4.1 with the ERC-4337 module, no other modules and no transaction guard). Zold tells you which of these a Safe misses.

{% hint style="info" %}
Recovery through Zoldenburg or an email code is not offered for a Safe you bring in yet. If you keep your wallet as a second owner, it can still add or replace owners in Safe{Wallet}.
{% endhint %}

Start a step on one phone and finish it there: the phone remembers that you are bringing in a Safe, so it does not open a new account in the meantime.
