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
- **Zoldenburg is a recovery guardian only by the user's choice**, made in
  Security (one passkey-signed op). Signup does not offer it. Deployment adds
  a guardian only when the user logged in with Google or Apple at signup
  (`self-social`, where `TURNKEY_GUARDIANS` is on); skipping it records
  nothing, and Home keeps a reminder that recovery is off. It never blocks
  the IBAN or deposits. A lost device asks with a new
  passkey and a reference (`/recovery/zoldenburg`); an operator verifies the
  person against Monerium's KYC and signs from a HARDWARE WALLET (a Keycard
  Shell: air-gapped, QR only, held in MetaMask/Rabby as a QR account), either in
  Safe Cover (Candide's open-source recovery UI; not on Base Sepolia) or in
  /admin → Recoveries via eth_signTypedData_v4 with the relay key (`RELAY_KEY`) paying the gas.
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
  and the waiting period are the owner's defence (no mail, no relay).
  Anyone who knows the email can start one, so its answers name no account,
  Safe, module or guardian; the sub-org and address to sign with come from
  the guardian's own login. A request waits an hour for that login. Up to
  five wait per account: a new start expires the oldest without a new
  passkey, never one with, and with all five holding a passkey it is refused
  until one times out. Once one is on chain the others close. While any
  other guardian is on the Safe a Turnkey guardian is not added, since
  nothing collects two signatures yet. Its login token is accepted only from Google or Apple,
  signed by their published keys, for our client id, bound to the browser's
  key; /guardian and /recovery are the only pages that load Turnkey code or
  may reach Turnkey's API. A Google/Apple login is never a guardian beside
  another: the Zoldenburg and email/SMS add routes refuse while one is active
  or the module lists a guardian they do not know, when the op is prepared
  and again right before it is submitted (`recovery/one-guardian.ts`).
- **Zoldenburg signs only for an ARMED account.** Adding the guardian on
  chain is not enough: the user also sends at least 1 € from a bank account
  in their own name to their Zold IBAN, with a code from /guardian as the
  reference (`recovery/zoldenburg-enrolment.ts`). The payer's name
  must match the Monerium profile name, read live (`domain/name-match.ts`),
  and a payment from the Zold IBAN itself is refused. Only an HMAC of the
  payer's IBAN (`RECOVERY_IBAN_HMAC_KEY`), its last 4 characters and the
  order id are kept. Titles and initials are not name parts; a one-word
  Monerium name, a joint account ("und", "&") or a company payer never
  matches. Until then /admin/recoveries refuses
  `sign-request`, `execute` and `sync` (409 `NOT_ARMED`) and shows no Safe
  Cover link. A new code needs a passkey step-up every time; a failed
  re-enrolment leaves the old account armed; adding or removing the guardian
  drops the enrolment, and an account is armed only while Zoldenburg's
  current guardian is active on it; a new HMAC key disarms every account
  until it pays again. **The gate binds the admin console, not the guardian
  key:** a signature made outside /admin (Safe Cover, by hand) still reaches
  the chain, and the sweep follows the chain to finalisation, so the
  operator rule is never to sign while a check is missing.
- **Each recovery needs a second 1 € from the enrolled account.** The
  recovery page (`/recovery/zoldenburg/:id/bank-code`, request secret
  required) issues a recovery code; the person sends at least 1 € with it from
  the enrolled bank account to the Zold IBAN
  (`recovery/zoldenburg-bank-check.ts`). It passes only when the payer IBAN's
  HMAC equals the enrolled one under the key in use and the payer's name
  matches the Monerium name, read live. An unreadable Monerium, an account
  without a Monerium profile id, an account not armed at that moment, or any
  error inside the check is recorded as `unreadable` and leaves it open; it
  never passes on a failed read. The person sees one text for all of these;
  /admin shows the cause. A programming error (TypeError and kin) is thrown,
  not recorded.
  A recovery code's purpose is in its hash, so an enrolment code never
  passes it. A request gets at most 5 codes, and an operator can give them
  back (`/admin/recoveries/:id/bank-reset`); a transfer sent with an earlier
  one still counts, and a new code does not reset the 30 s Monerium read
  throttle. The pass records the enrolment it matched: a re-enrolment voids
  it, and /admin shows the pass as no longer counting. The person sees no digits of either IBAN, because anyone who knows the
  account's email can start a request. An owner who closed the enrolled bank
  account cannot pass this check. Until it passes,
  `sign-request`, `execute` and `sync` answer 409 `BANK_CHECK_PENDING`, and
  /admin shows signing as locked. There is no override. The Didit ID check
  is the next check this gate gets.
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
  verifier has code (confirm deploys it from the relay key if not). A failed
  RPC read binds nothing. Both routes refuse once the account's own Safe is
  active or deployed, or while anything (ETH, EURe, USDC) sits at its planned
  address — an import never replaces a live Safe. The plan records
  `importedAt`, never `recoveredAt`; both make `accountForPlan` use the stored
  address. The Safe's current owner makes the passkey an owner themselves
  (`npm run safe:import-tx`, no key taken): `add` keeps the EOA as the user's
  own second owner (1 of 2), `swap` removes it. Zold never signs that change.
  An imported Safe is not offered a recovery guardian: enabling the module
  has never run on one, so its deployment adds none and Security says so.
  The recovery routes do not refuse it yet.
