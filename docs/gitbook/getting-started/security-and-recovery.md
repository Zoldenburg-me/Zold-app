---
description: What protects your account, what you have to protect, and how to get back in if you lose a device.
---

# Security and recovery

## Two keys, both yours

**Your passkey** owns the smart wallet and signs you in. It is verified with your fingerprint, face or device PIN and never leaves your device's secure hardware.

**Your device key** is a second key, generated in your browser the first time you use the account on a device. It signs the exact terms of every payment — the amount, the payee and the transfer — so that even someone who steals your signed-in session cannot change where money goes. Where your authenticator supports it, the device key is encrypted with a secret only your passkey can produce, so each payment needs a passkey ceremony to unlock it.

The dashboard's **Security** card tells you whether the device key on this device is passkey-protected.

## What Zold can and cannot do

* Zold **cannot** move your money. Every debit is signed by you.
* Zold **cannot** replace your passkey. Registering a new one needs a confirmation from the current one.
* Zold **can** pay the network fees for your transactions, and co-sign transactions you have already signed.

## Email / SMS recovery

Set this up as soon as your account is active. Without it, a lost device with a non-synced passkey means a locked account.

**To enrol:** Profile → **Email / SMS recovery**. Register an email address, a phone number, or both. You confirm each with a one-time code, then approve with your passkey. A recovery guardian is added to your wallet. Each channel is masked wherever it is displayed.

**To recover on a new device:**

1. On the sign-in screen choose **Lost your passkey? Recover your account** and enter your recovery email.
2. Create a new passkey on the new device.
3. Confirm a one-time code on **every** channel you registered.
4. A waiting period runs before the change takes effect. During it, the account still belongs to the old passkey. If you did not start the recovery, sign in on your old device and cancel it from the Profile screen.
5. When the period ends, the new passkey becomes the owner. Sessions of the old device are ended and its device key is unbound.

{% hint style="warning" %}
The waiting period protects you. Anyone who controls your recovery email and phone can *start* a recovery, but cannot sign in or spend until it has run. Keep those channels as safe as the account itself.
{% endhint %}

## Managed recovery

Accounts also carry a managed recovery guardian, operated with a delay and identity re-verification. This is the fallback if you have not enrolled email / SMS recovery. It is slower, and it requires proving your identity again, so enrol the self-service path instead.

## Sessions

A session ends when you sign out and expires on its own. Signing in on a new device does not sign out others. If you suspect a device is compromised, start a recovery: finalising it revokes every session that device held.
