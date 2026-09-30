# Recovery and signers — invariants

The full rules behind the one-line versions in `AGENTS.md` → Invariants →
Identity and authority. Each of these was a bug once.

- **The user may add their OWN second owner** (Profile → Enable advanced
  features → Signers & rules; `routes/safe-signers.ts`). Read from the chain on
  every visit, changed only by passkey-signed ops. Zold cannot collect that
  owner's signature, so at threshold > 1 `assertPasskeyAloneCanSign` refuses
  every op (409 `SAFE_NEEDS_MORE_SIGNATURES`); raising the threshold therefore
  needs a guardian on chain and a typed `LOCK`, and no route lowers it.
  Candide's `finalizeRecovery` replaces the WHOLE owner set, so a recovery
  drops the second owner and resets the threshold — but leaves Allowance-module
  delegates in place. Spending limits use Safe's AllowanceModule v0.1.1
  (`0xAA46…091C`); Zold only sets them and never spends through one.
- **Zoldenburg is a recovery guardian only by the user's choice.** Deployment
  adds no guardian; onboarding step 3 offers it (one passkey-signed op), and
  skipping shows the warning that Zoldenburg UG then cannot recover the
  account and only EURe is reclaimable from Monerium — the user must tick it,
  and `recoveryChoice` records the answer. A lost device asks with a new
  passkey and a reference (`/recovery/zoldenburg`); an operator verifies the
  person against Monerium's KYC and signs from a HARDWARE WALLET (a Keycard
  Shell: air-gapped, QR only, held in MetaMask/Rabby as a QR account), either in
  Safe Cover (Candide's open-source recovery UI; not on Base Sepolia) or in
  /admin → Recoveries via eth_signTypedData_v4 with the deployer relaying.
  **The API never holds the guardian key**, recomputes the digest from the
  module before accepting a signature, and moves a request only on what the
  chain shows. Zoldenburg alone can START a takeover of an opted-in Safe; the
  module's grace period plus the owner's cancel is the only protection, so a
  production module must be the 3/7/14-day one. The deployed modules hash with
  EIP-712 version "0.0.1", not the "0.2.0" in Candide's GitHub source.
  A signature's v of 0/1 is normalised to 27/28 before relaying (the module's
  ECDSA check would revert on 0/1). Admin → Recoveries → "Test guardian
  wallet" proves the Shell → wallet → API path without touching a Safe.
- **A recovery's new credential lives on the RecoveryRequest** until the chain
  confirms the new owner, so whoever holds the OTP channels cannot sign in or
  spend during the grace period.
- **A recovery id is not a capability.** Candide recovery's by-id routes need
  the per-request secret handed to the starting browser, and `/finalize` issues
  no session — the new passkey signs in through the ordinary login.
