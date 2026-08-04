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
The newer transfer-creation path records `fundingSource = "vault" | "safe"` so
Safe-held EURe is no longer hidden behind a misleading "insufficient vault
balance" error.

---

## 1. Where things actually stand

FP4's **first half is shipped**: `RemitVault.debit` requires an EIP-712
`PaymentAuthorization` signed by the account's registered authorizer, with the
payout destination hashed into the signed struct. The orchestrator can only
submit and pay gas. That is real, tested, and live on Base Sepolia.

FP4's **second half is partly built** (updated Aug 2026 — the paragraph that
used to sit here said "not started", and was wrong by the time anyone read it).

Verified by grep against the current tree, not inferred:

| step | state |
|---|---|
| 1 — passkey becomes a Safe owner | **BUILT** — `fromSafeWebauthn` in `wallet/candide.ts` |
| 2 — co-signer, threshold 2 | **BUILT** — `initializeNewAccount([passkeyOwner, cosignerAddress], { threshold: 2 })` |
| 3 — `setAuthorizer(safe, safe)` | **NOT DONE** — nothing points `authorizerOf` at a Safe |
| 4 — `SocialRecoveryModule` | **BUILT** — imported, `passkeySafeRecoverySetupTransactions` batches enable-module + add-guardian |
| 5 — delete `user.privateKey` | **NOT DONE** — still read at `orchestrator.ts:265,293,341,351` |

THE CO-SIGNER IS NOT A SERVICE. `CANDIDE_COSIGNER_KEY` is a private key in the
API's own `.env`, and the API signs with it directly. There is nothing to run
and nothing to find. That matters more than it sounds: the same process also
holds `user.privateKey`, so today the server owns BOTH halves of the "2-of-2"
and can act alone. The co-signer only starts meaning anything after step 5.

WHY STEP 5 IS NOT OPTIONAL, with a number attached: two Safes on Base Sepolia
hold 219 EURe (0x5397A2c7… 20, 0x49Dc66aF… 199) that nobody can move, because
the server held their owner key and `npm run dev` wiped `data/db.json`. A
passkey-owned Safe survives that — the authenticator still holds it.

WHY STEP 3 IS A DECISION, NOT A TASK. It makes the SPENDING gate the
recoverable Safe instead of a browser EOA, which fixes a different brick: the
"Base Proof" account with EUR 121 that can never spend because its device key
is gone and only the current authorizer may rotate. But the same outcome comes
from retiring the vault as the custody path — `fundingSource === "safe"` already
exists, and §1.5 below proposes exactly that. If Safe-funded becomes the only
route, `authorizerOf` stops being the gate and step 3 is moot. Decide whether
the vault survives as custody BEFORE doing step 3: `setAuthorizer` is a one-way
door, and after it `authorizerOf` never changes again.

Provisioning also refuses to issue an IBAN without a passkey
(`passkeyRequiredBeforeFunding` in `services/api/src/server.ts`, gated on
`allowSimulation`).

NOTE ON THE ACCOUNT QUOTED ABOVE: `Redeem Base` predates the passkey-Safe work —
`passkeySafe: none`, `passkey: null`, authorizer still a browser EOA. It cannot
demonstrate steps 1/2/4; that needs a freshly onboarded account.

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
- Safe deployment is now centralized in `/api/users/:id/passkey-safe/deployment`;
  alternate owner-key deployment helpers have been removed.

Current branch status: passkey registration can now derive and store the
deterministic 2-of-2 passkey/co-signer Safe address when
`CANDIDE_COSIGNER_ADDRESS` is configured. The browser can request and sign a
deployment UserOperation, and the API co-signs/submits it when
`CANDIDE_COSIGNER_KEY` is configured. Activation refuses if the current account
or vault ledger still holds funds, because that requires an explicit move rather than a
blind address switch. Non-simulation funding now also refuses to issue an IBAN,
enable auto-convert, or activate Monerium funding until the passkey/co-signer
Safe is the active account and the server-held owner key has been removed.

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

The transitional implementation may use `fundingSource: "safe"` and verify the
same device authorization off-chain before moving a one-time Safe amount — the
full send on the FX rails, the fee alone on SEPA. Treat that as a bridge only: it is not equivalent to on-chain policy enforcement while the
server still holds `user.privateKey`.

What moving off `RemitVault.debit` costs, and where each piece stands:

| Enforced by the vault | Safe-funded path |
|---|---|
| Device signature checked in the contract | Checked by the API (`verifyTypedData`), which also holds the key that moves the money |
| `debitedOnDay[user][day] + amount <= dailyCap` | `dailyCapUsage` sums the vault's on-chain counter with the API's Safe total against the contract's own `dailyCap` |
| `require(!processedTransfer[transferId])` | Reads that registry and refuses a transferId the vault already spent, plus refuses a second move for one transfer record — but writes nothing on-chain |
| Revert on failure leaves nothing to unwind | `compensateTransfer` returns whatever actually left the Safe (see `safeMovedEur`), or sends an already-swapped input to review |

The replay row is the one still short of the guarantee it replaced. Both checks
read state this API owns, so a restored `db.json` or a second API instance
defeats them; the authorize-race double-spend of July 2026 is exactly what the
on-chain registry was backstopping. A contract-side registry the orchestrator
can write — the same `processedTransfer` marking, without a balance debit — is
the piece that would close it, and it is worth doing before this path carries
real money.

Also note the path cannot be exercised locally: `transferTokenFromSafe` goes
through Candide's bundler and paymaster, which no hardhat node provides. Tests
cover everything after the debit (`npm run safe-funded:test`); the debit itself
has only ever run against a real bundler.

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

Current branch status: new passkey/co-signer Safe deployments can now enable
Candide's `SocialRecoveryModule` and add a threshold-1 recovery guardian in the
same first UserOperation as deployment. By default the guardian is the
configured co-signer; `CANDIDE_RECOVERY_GUARDIAN_ADDRESS` can point at a
separate guardian service when available. This gives crypto-only users a
non-KYC recovery primitive, but the co-signer/guardian still cannot sign normal
payments alone because the Safe owner threshold remains 2-of-2.

Remaining work: the actual lost-passkey ceremony is not a product flow yet. The
recovery UI/API must collect a replacement passkey owner, have the guardian
confirm recovery through the module, wait the module's grace period, finalize
the owner replacement, and expose cancellation/status clearly.

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

Current branch status: SEPA transfer creation now fixes the Monerium redeem
message, amount, IBAN and remittance memo at the same time as the device
authorization terms, and `/authorize` can persist a user-time
`moneriumRedeemSignature`. The adapter submits that signature when present,
falling back to the legacy server Safe key only for existing transitional
accounts. The remaining work is a browser/passkey signer for that message.

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
