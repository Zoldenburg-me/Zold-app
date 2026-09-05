---
description: Your identity check and your IBAN both come from Monerium. This is how the two accounts are joined.
---

# Connect Monerium and activate your IBAN

Zold does not run its own identity check. **Monerium** verifies who you are and issues your IBAN, and Zold links that IBAN to your smart wallet. That means one identity relationship, held by a licensed e-money institution, instead of a second copy of your documents somewhere else.

## Sign up or sign in with Monerium

After your passkey and wallet are ready, the app shows **Connect Monerium**.

1. Choose **Sign up or sign in with Monerium**. You are taken to Monerium's own site.
2. If you already have a Monerium account, sign in. If not, open one there in the same step. Monerium runs the identity verification: your details, a document, and a liveness check. This usually takes minutes but can take longer if a document needs a human look.
3. Approve the connection. You are returned to Zold.
4. Press **Activate IBAN with passkey**. Your passkey signs a short statement proving that the smart wallet is yours. Monerium attributes an IBAN to that wallet.

Your account is **active** as soon as the IBAN appears. Money sent to it lands in your wallet as EURe.

## Adding Monerium API keys instead

If you are a developer or a business with your own Monerium developer app, the same screen offers **Add Monerium API keys**. Paste the app's client id and secret. Zold checks the pair with Monerium before saving anything, stores the secret encrypted, and never shows it again. Deposits, activation and SEPA payments for your account then run on your own credentials.

Removing the keys later keeps your IBAN on record, since it exists at Monerium regardless. Deposits and payouts pause until you add keys again.

## What "pending" means

While the connection is incomplete, your account is **pending**. You can see the app, but the IBAN, deposits, quotes and transfers open only once Monerium is connected and the IBAN is activated. The banner at the top of the dashboard tells you which step is left.

## If activation fails

Occasionally the passkey and wallet succeed but IBAN issuance does not. Nothing is lost. Open your account and press **Activate IBAN** to retry.
