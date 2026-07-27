# FP4 completion — implementation blueprint

Handoff for whoever builds the key-custody half of FP4. Written 27 July 2026.

**The problem in one line:** losing the browser device key permanently bricks an
account, and today the server owns every user's Safe.

Everything below marked VERIFIED was checked against a live chain, a live API,
or the deployed bytecode — not inferred from docs. Everything marked PLAN is
not built.

**Update, 27 July 2026:** a live Base Sepolia Monerium sandbox issue minted
EURe directly to a user's Safe. That confirmed the custody model: the Safe is
where user funds arrive. The remaining vault problem is that the transfer
executor still starts from `RemitVault.debit`. Today the poller can try to move
Safe-held EURe into the vault with the server-held Safe owner key before
crediting the ledger. That is transitional: it proves the old executor, but it
keeps the server in the custody path and fails permanently if that key is lost.

---

## 1. Where things actually stand

FP4's **first half is shipped**: `RemitVault.debit` requires an EIP-712
`PaymentAuthorization` signed by the account's registered authorizer, with the
payout destination hashed into the signed struct. The orchestrator can only
submit and pay gas. That is real, tested, and live on Base Sepolia.

FP4's **second half — key custody — is not started.** Confirmed by grep:

```
fromSafeWebauthn        not used anywhere in services/ or scripts/
co-signer               does not exist
SocialRecoveryModule    not installed
```

And on a live Base Sepolia account:

```
Safe            0xC034a7f3b986fE6550D0A6b63815a35839b1Ac2f
authorizerOf    0xCCD5F9B63842E82F16A87f99cec757F778f6Df77   ← a browser EOA
user.privateKey PRESENT in data/db.json                       ← server owns the Safe
user.passkey    null
```

There are **three separate keys** today, and the passkey has the least power:

| Key | Lives | Controls |
|---|---|---|
| `user.privateKey` | server, plaintext in `data/db.json` | owns the Safe → Monerium linking, redeem |
| device key | browser `localStorage`, PRF-wrapped | `authorizerOf` → spending |
| passkey | the authenticator | a login session, and unwrapping the device key |

The only piece of the recovery plan that IS built: provisioning refuses to
issue an IBAN without a passkey (`passkeyRequiredBeforeFunding` in
`services/api/src/server.ts`, gated on `allowSimulation`).

The current balance API exposes this split explicitly:

| Field | Meaning |
|---|---|
| `safeBalanceEur` | Real EURe held directly by the user's Safe |
| `vaultBalanceEur` | `RemitVault.balanceOf(userSafe)` ledger balance |
| `balanceEur` | Primary spendable balance for the current executor: the vault ledger |

---

## 2. Verified facts — do not re-litigate these

- **RIP-7212 (P256 precompile) is LIVE on Base Sepolia AND Base mainnet.**
  Tested by generating a real P-256 signature with `node:crypto` and calling
  precompile `0x100` — returned `0x…01`. A passkey-owned Safe needs no verifier
  contract and costs a precompile call.
- **`abstractionkit@0.4.0` is already a dependency** and exports everything
  needed: `fromSafeWebauthn`, `webauthnSignatureFromAssertion`,
  `WebauthnDummySignerSignaturePair`, `SocialRecoveryModule`,
  `SocialRecoveryModuleGracePeriodSelector`, `AllowanceModule`,
  `ALLOWANCE_MODULE_V0_1_0_ADDRESS`.
- **`RemitVault._isValidSignature` already accepts contract signers.** It
  staticcalls `isValidSignature` when `signer.code.length > 0`. **No contract
  change is required** to point `authorizerOf` at a Safe.
- **`setAuthorizer` is trust-on-first-use.** `contracts/src/RemitVault.sol:95` —
  the ramp may bind an unbound account; after that **only the current authorizer
  may rotate**. This is why a lost device key is permanent.

---

## 3. The steps, and why the order is not negotiable

### Step 1 — the passkey becomes a Safe owner

Replace the server-generated EOA with a WebAuthn signer.

- `services/api/src/server.ts:407` — `generatePrivateKey()` creates the owner
  today. This is the thing being removed.
- `services/api/src/wallet/candide.ts:31` — `smartAccountFor(ownerAddress)`
  currently builds `SafeMultiChainSigAccountV1` from an EOA address. Needs a
  `fromSafeWebauthn` path.
- `deploySmartAccount` (`candide.ts:50`) takes an `ownerKey`; a passkey-owned
  Safe has no private key, so this signature changes.

**Verify:** deploy a Safe whose only owner is a passkey, then have it produce a
signature that `RemitVault._isValidSignature` accepts. If that round-trip works,
step 3 is safe.

### Step 1.5 — make Safe-held EURe spendable without vault custody

Do this before pushing more live Monerium flow testing. Deposits arrive in the
Safe, not the vault. A transfer must therefore consume the Safe's EURe directly:

- For SEPA, collect the Monerium redeem signature while the user is present and
  submit the Safe operation that lets Monerium burn from the Safe.
- For FX/cash/UPI, collect an exact Safe approval or transfer for the quoted
  EURe amount, recipient commitment, rail, deadline, fee/spread ceiling, and
  refund terms.
- Keep `RemitVault` only as a policy/replay/cap module if it still adds value,
  or replace it with a smaller `SpendPolicy` contract. Do not require users to
  pre-deposit Safe funds into the vault as the production custody path.

Temporary compatibility is acceptable for local mock demos, where deposits are
still mirrored into `RemitVault`.

### Step 2 — add the co-signer, threshold 2

Owners become `[passkey, co-signer]`, threshold 2. **2-of-2 by decision** —
Privy/Turnkey cost money, so a third social-login signer is deferred.

Consequence to design around: with no spare signer, **guardians (step 4) stop
being optional**. Losing the passkey puts the user immediately below threshold.

### Step 3 — `setAuthorizer(safe, safe)`

Now `authorizerOf` resolves to "did the passkey and co-signer sign?"

**THE ORDERING CONSTRAINT:** steps 1–2 MUST precede this. `authorizerOf = Safe`
means *whoever owns the Safe* controls spending. The Safe is owned by
`user.privateKey`, which lives in the server's database. Doing step 3 first
hands the database spending power over every balance — the device key is
currently the only thing preventing that. This would silently undo FP4 while
appearing to be progress.

Only the **current authorizer** can perform this rotation, so it must be signed
by the user's existing device key.

### Step 4 — install `SocialRecoveryModule` with guardians

Guardians replace *owners* on the **same Safe, same address, same funds**. This
is the only mechanism that actually recovers an account — anything that deploys
a new Safe produces a different address and recovers nothing.

Design question that is genuinely open: **who are the guardians?** For a
remittance product the recipient on the other end of the corridor is a natural
candidate — they already have a phone and a reason to care. Safe Foundation's
consumer research found users would not fund an account without *rehearsable*
recovery.

### Step 5 — delete `user.privateKey`

The last server-held key. Currently plaintext in `data/db.json` next to
`senderProfile` PII.

---

## 4. Wrinkles that will bite if not designed in

**`redeemToIban` signs asynchronously, after the user has gone.**
`services/api/src/adapters/monerium-sandbox.ts:176` calls `signMessageAsSafe`
with `user.privateKey` to authorise the EURe burn. A passkey-owned Safe cannot
be signed by the server alone.

Fix: **collect both signatures at send time** — the vault authorization *and*
the Monerium redeem message. Both are fully determined the moment the user
approves (amount + IBAN), so nothing is signed blind. Design this in from the
start rather than discovering it in step 1.

**Monerium address linking** (`monerium-sandbox.ts:92`) also signs as the Safe,
but happens during onboarding while the user is present — so it is fine, as long
as the passkey ceremony is part of provisioning.

**Migration has a hard edge.** Accounts that still hold their device key can
migrate themselves. Accounts that lost it never can. Two such accounts already
exist on Base Sepolia — `0x4965837b…C99B` holds EUR 121 it can never spend.
This fixes the future, not the past. Decide whether to migrate existing sandbox
accounts or start clean.

**A backstop, not a product.** EURe is e-money, so Monerium's liability is to
the identified customer and holders have a redemption right at par. Monerium
also has the technical means to reissue — EURe is a UUPS proxy they own, with
`mint()`, and no `recover`/`forceTransfer`/`burnFrom` selector exists in the
deployed implementation. So a lost wallet is *likely* recoverable via re-KYC.
UNCONFIRMED — not in their docs, ask them in writing. It does not cover USDC or
in-flight transfers, and does not restore the Safe.

---

## 5. Do not do these

- Do not point `authorizerOf` at the Safe before the passkey owns it (§3 step 3).
- Do not "fix" recovery by deploying a replacement Safe. A new owner produces a
  new address; the funds stay in the old one.
- Do not remove the device key path before step 3 lands — it is the only thing
  keeping the server out of user balances.
- Do not run `npm run check` while a live Base Sepolia account exists in
  `data/db.json`. Test isolation now prevents it from touching that file, but
  back it up first regardless — it holds Safe owner keys, and a suite run has
  already destroyed one account this way.

---

## 6. Testing

- `npm run check` — 20 suites, own database, own local chain. Safe to run.
- `npm run fp4:test` — device-key envelope, headless.
- `npm run webauthn:selftest` — 9/9, full WebAuthn including step-up.
- Contract-level: the properties worth proving are that `debit` rejects a
  signature from any key but the registered authorizer, rejects a changed payout
  destination, and rejects a replayed `transferId`.

Live deployment for end-to-end work: see `HANDOFF-BASE-SEPOLIA.md` for
addresses, gates, and known-unproven items.

---

## 7. Repo conventions

- Branch prefix per agent. **Never push to a branch another agent created** —
  `claude/*` branches belong to the Claude sessions.
- `main` is PR-merge only. Before merging, confirm the head SHA is what you
  pushed; after merging, **grep the tree** rather than trusting `merged: true`.
  Content has silently failed to land twice in this repo's history.
- `CLAUDE.md` carries full project state, including the FP4 plan this document
  expands and the open architecture question about whether the pooled
  `RemitVault` should survive at all once the Safe is the authority.
