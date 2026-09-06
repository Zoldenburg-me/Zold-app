---
description: What is behind the balance on your dashboard.
---

# Your euro account

The euro account is the first of your global accounts. A [US dollar account](../add-money/usd-account.md) is next, and the two sit in the same wallet.

## Three things, one account

| What you see | What it is |
| --- | --- |
| **Your IBAN** | A real euro IBAN issued by Monerium. Anyone can pay it by SEPA transfer, from any bank. |
| **Your balance** | EURe held in your smart wallet. One euro of EURe is one euro. |
| **Your wallet address** | The address of your smart wallet on Base. Where your EURe actually sits, and where crypto deposits arrive. |

When a bank transfer reaches your IBAN, Monerium issues the same amount of EURe to your wallet. When you pay out by SEPA, the EURe is redeemed and euros leave from Monerium to the payee's bank. The IBAN and the wallet are two faces of the same account.

## EURe

EURe is an electronic-money token. It is issued by Monerium EMI ehf., an e-money institution licensed by the Central Bank of Iceland and passported across the EEA, and it is regulated under MiCA as an e-money token. Every EURe is backed one-for-one by euros held by the issuer, and you have a legal right to redeem it at par. This is what makes it different from a crypto stablecoin: there is a named, licensed counterparty who owes you the euros.

## Your smart wallet

Your wallet is a Safe smart account on the Base network. Its owners are your passkey and a Zold co-signer, and both must sign an owner-level change. Every payment you make is a transaction your passkey signs at send time; there is no standing permission for Zold to move funds.

Gas is paid by Zold. You never need to hold ETH or any other token to use your account.

## One balance

Your dashboard shows one figure: what is in your wallet. A payment that is in flight has already left it, so the balance you see is both what you hold and what you can spend.

## Balance history and activity

**Activity** lists every deposit and transfer with its current state. Open any row for the full detail: amounts, rate, fee, references and a timeline that reads the transfer's real state rather than a timer. See [Tracking and receipts](../send-money/tracking-and-receipts.md).
