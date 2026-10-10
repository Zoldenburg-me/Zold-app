# Recovery and signers — invariants

The full rules behind the one-line versions in `AGENTS.md` → Invariants →
Identity and authority. Each of these was a bug once.
Planned guardian kinds (Didit + 1 € check, trusted people), and the Turnkey
guardian built behind `TURNKEY_GUARDIANS`: `recovery-guardians-plan.md`.

- **The user may add their OWN second owner** (Settings → Who approves
  payments; `routes/safe-signers.ts`). Read from the chain on
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
- **A Google or Apple login is a guardian only through Turnkey, and Zold holds
  no part of it** (`wallet/turnkey.ts`, `recovery/turnkey-recovery.ts`).
  Every sub-org we create has exactly one root user, the person, at root
  quorum 1, with no API key, no authenticator of ours and no delegated
  access; one builder asserts it and a source grep fails on anything else. A
  sub-org found by login is checked for the same shape. A signature is
  relayed only from the guardian recorded on the request when it started,
  over the digest recomputed from the module (refused unless the module's
  own `getRecoveryHash` agrees), while the module still lists that guardian
  at threshold 1 and holds no other recovery, and only once the owner was
  emailed that someone asked: no operator reviews this path, so the alert
  and the waiting period are the owner's defence (no mail, no relay). An
  account may have up to five such requests open at once (only the
  guardian's login can sign one, so starting first locks nobody out); once
  one is on chain the others close. While any other guardian is on
  the Safe a Turnkey guardian is not added, since nothing collects two
  signatures yet. Its login token is accepted only from Google or Apple,
  signed by their published keys, for our client id, bound to the browser's
  key; /guardian is the only page that loads Turnkey code or may reach
  Turnkey's API.
- **A recovery's new credential lives on the RecoveryRequest** until the chain
  confirms the new owner, so whoever holds the OTP channels cannot sign in or
  spend during the grace period.
- **A recovery id is not a capability.** Candide recovery's by-id routes need
  the per-request secret handed to the starting browser, and `/finalize` issues
  no session — the new passkey signs in through the ordinary login.
- **An imported Safe is bound only on what the chain shows, and only with the
  passkey's approval of that Safe** (`routes/safe-import.ts`, checks in
  `wallet/safe-import.ts`). Anyone can add an owner to a Safe, so a Safe
  owned by the verifier plus another key proves nothing about who imports
  it: `confirm` needs a `safe.import` step-up whose challenge `prepare`
  issued bound to the Safe's address, owners and threshold
  (`importApprovalTarget`), and refuses `SAFE_CHANGED` if they differ by the
  final read. The screen names the other owner before the user approves.
  `confirm` refuses unless the address has code, its singleton (slot 0) is Safe L2
  v1.4.1 `0x29fc…C762`, the passkey's WebAuthn verifier is an owner with at
  most one other owner, the threshold is 1, the 4337 module `0x2293…AEAd` is
  the only enabled module AND the fallback handler, no guard is set, and the
  verifier has code (confirm deploys it from the deployer if not). A failed
  RPC read binds nothing. Both routes refuse once the account's own Safe is
  active or deployed, or while anything (ETH, EURe, USDC) sits at its planned
  address — an import never replaces a live Safe. The plan records
  `importedAt`, never `recoveredAt`; both make `accountForPlan` use the stored
  address. The Safe's current owner makes the passkey an owner themselves
  (`npm run safe:import-tx`, no key taken): `add` keeps the EOA as the user's
  own second owner (1 of 2), `swap` removes it. Zold never signs that change.
  An imported Safe is not offered a recovery guardian: enabling the module
  has never run on one, so onboarding skips the step and Security says so.
  The recovery routes do not refuse it yet.
