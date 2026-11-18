# Company-owned Safe for business orgs (design, for the owner's approval)

Zold lead, 2026-10-25. Code read on main a001d0e8. Nothing gets built before the owner approves this note.

**The owner's decision:** "the Ownership of a safe From a corprate account should always belong to the company not to the person who made the safe or the passkey! for a freelance! who dont have a seperate legal identity we dont care! if he comingle funds or not!!"

## 1. What exists today

- `OrgType` is `"personal" | "business"` (`domain/types.ts:14`). Nothing says whether a business org is a legal entity or a sole proprietor.
- A business org's EUR `Account` has `backingUserId` (`types.ts:294`): the member whose own passkey Safe receives the money and whose device key signs its debits.
  - It is set by `POST /orgs/:orgId/accounts/:accountId/fund` (`routes/orgs.ts:~757`) from the caller's own Safe, IBAN and Monerium profile. A business account must be backed by a `corporate` Monerium profile.
  - A wallet-tier owner can instead connect their own Safe with no IBAN. Only an owner can do that; an admin can still `fund`, which is #105(b).
  - Nothing unbinds or replaces a backer. The type's own comment says per-org Safe provisioning "is not built".
- Membership and money are disconnected:
  - Removing or deactivating the backing member changes nothing on chain. The money stays in their Safe and they can still spend it.
  - An extra owner added through `routes/safe-signers.ts` stays on chain after their membership ends.
  - The backer keeps listing and revoking the org's Belege through personal routes (row 13).
- A Safe has exactly one signer Zold collects from: the passkey. At threshold > 1, `assertPasskeyAloneCanSign` refuses every op (409 `SAFE_NEEDS_MORE_SIGNATURES`). Zold has no way to collect a second person's signature.
- Candide recovery (`finalizeRecovery`) replaces the WHOLE owner set (`docs/recovery-and-signers.md`).
- `wouldOrphanOrg` (`domain/roles.ts:126`) protects the last owner membership, but not the last on-chain signer.

## 2. Target model

### 2.1 Two kinds of business org
- New field: `Organisation.entity: "company" | "sole_trader"`, chosen at org creation and locked once the account is funded.
- **sole_trader** (freelancer, no separate legal person): keeps today's model exactly. Their own Safe backs the org. No separation of funds is built; the owner said they don't care about commingling.
- **company**: the org's EUR account sits on its own Safe, the **org Safe**, owned by the company. The rest of this note is about `company` orgs.
- Existing business orgs are classified by their Monerium profile: `corporate` → company; anything else → ask the owner (§6).

### 2.2 The org Safe
- One Safe per company org, deployed by Zold at account opening, with the org as its holder of record.
- **Owners on chain** = the passkey signers of the members whose role has the new permission `account.sign` (owner, and payer if the policy allows), one WebAuthn signer per member.
  - Zold never holds an owner key. The AGENTS.md invariant "never add a co-owner that Zold holds" stays.
- **Threshold policy** is set per org by its owners: 1-of-n by default, 2-of-n for four eyes. It's stored in the org and read from the chain on every visit, like `safe-signers` today.
- **Recovery guardian**: the Zoldenburg guardian (hardware wallet, armed by a 1 € transfer from a company bank account in the company's name), plus optionally the owners' own Turnkey guardians. See §3.4 for why Candide's module needs care.

### 2.3 Membership drives the owner set, in one flow
- **Granting a signing role** = invite accepted, passkey bound, then an `addOwnerWithThreshold` op signed by the current owners up to the threshold. The member becomes a signer only when the chain shows it.
- **Removing or deactivating a member, or downgrading them out of `account.sign`** = a `removeOwner` op in the same flow.
  - The membership change and the on-chain removal are one pending action.
  - Until the chain confirms the removal, the app shows them as **"removal pending, can still sign"**, never as removed.
  - If the removal fails, the membership change is rolled back to "pending", not silently applied.
- **Guards**, mirroring `wouldOrphanOrg`, checked server-side before preparing the op and again right before submitting:
  - never remove the last on-chain owner;
  - never let the owner count drop below the threshold;
  - lower the threshold in the same op when needed, and only with the remaining owners' consent;
  - the last `owner` membership and the last signer must both survive.

### 2.4 Collecting more than one signature (the new piece)
- Today the API refuses threshold > 1. A company Safe needs a **pending-op queue**:
  - an op is prepared once with its digest fixed;
  - each owner signs it with their own passkey in their own browser;
  - Zold stores the signatures and relays when the threshold is met;
  - anyone can see who signed and who hasn't.
- The existing payment drafts with four-eyes review (`routes/business/drafts.ts`) become the UI for this. The reviewer's approval IS their on-chain signature, so the off-chain "four eyes" and the on-chain threshold are the same thing.
- The invariant "No debit without a user signature" still holds, at n-of-m. The API still disposes of nothing.

## 3. Effects

### 3.1 Belege, books, invoices
- Belege, invoices, payment links, statements and the ledger already carry `orgId`. They belong to the org, not the backer.
- `bookkeeping/issue.ts:78` stamps `userId = backingUserId` on a Beleg. For company orgs, Belege are listed and revoked only through org-scoped routes, gated on membership and role (this settles row 13).
- `backedSince` and `domain/safe-books.ts` already model "from when this Safe's movements are this account's". The org Safe starts its own books at deployment, and the personal Safe's books for the org end at the cut-over instant. Statements show one continuous account, with the cut-over as a transfer between two addresses of the same account, not as income or expense.

### 3.2 Payment links, Shopify, crypto-in, `orgsBackedBy`
- `orgsBackedBy(userId)` (`payment-requests.ts:192`) answers "is this Safe the org's?" by person. For company orgs it becomes "is this address the org Safe?" (`orgOfAddress`).
- Row 7 (Brief E) keeps working: it requires the deposit to land in the org's account. Today that means the backer's Safe; after migration, the org Safe.
- The crypto-in watched addresses add the org Safe. The payment-page deposit address and the Shopify payee point at the org Safe.

### 3.3 Monerium IBAN
- The IBAN belongs to the Monerium corporate profile and is attributed to an address. The org Safe has to be linked to that corporate profile; Monerium requires a signature from the address, which for a Safe means EIP-1271 at the threshold.
- Then either the existing IBAN moves to the org Safe, or a new IBAN is issued (§6, Q4). The address-matched activation rule stays: the account is `active` only when Monerium attributes an IBAN to the org Safe.

### 3.4 Recovery
- Candide's `finalizeRecovery` replaces every owner. On a company Safe that would remove every member to restore one, so:
  - **One member lost their passkey**: the other owners swap that signer at the threshold (`swapOwner`). No guardian is involved. If they are the only signer, it's the case below.
  - **All signers lost**: guardian recovery to the new owner set the company names. It goes through Zoldenburg's operator review against the company's Monerium KYC and the armed 1 € enrolment from the company's bank account.
- One guardian per Safe (`recovery/one-guardian.ts`) stays. Turnkey guardians belong to people, so they are not offered on an org Safe.

### 3.5 AGENTS.md invariants to change (the owner sees each one)
- "The passkey is the Safe's only owner. The plan type is `threshold: 1` only." This stays true for personal and sole_trader Safes. For an org Safe: members' passkeys are the only owners, at the org's threshold, and Zold holds none.
- "Zold never collects its [second owner's] signature, so at threshold > 1 every op is refused." This stays true for personal Safes. Org Safes collect member signatures through the pending-op queue.
- "Four eyes": for an org Safe at 2-of-n, the review is the second on-chain signature.
- "An org can never lose its last owner": add "and its Safe never loses its last signer, and the threshold never exceeds the signers left".
- New invariant: **membership and on-chain signer set change together**. Nobody is shown as removed while they can still sign.

## 4. Migration of existing business accounts backed by a personal Safe
For each `company` org with a `backingUserId`:
1. Deploy the org Safe with the backer's passkey signer, plus the other `account.sign` members as they bind. Threshold 1 until the owners choose otherwise.
2. Link the org Safe to the corporate Monerium profile and get its IBAN (moved or new).
3. Move the funds: the backer signs one transfer of the org's EURe from their personal Safe to the org Safe.
   - What counts as the org's: the backer's whole balance, or the org-attributed balance from `safe-books`? See Q5.
   - It's booked as an internal transfer between two addresses of the same account.
4. Rebind atomically: the account's `address` becomes the org Safe, and `backingUserId` is cleared. Payment links, Shopify and the deposit address point at the org Safe, and the watched-address set includes both addresses for a grace period, so late payments to the old address are still recorded.
5. Belege stay valid: frozen snapshots, re-verified on visit. New Belege name the org Safe. The cut-over appears on the statement.
- Fail closed at every step. Until step 4 the old binding stays fully working. A partial migration is resumable and shows its step in /admin.

## 5. Order of work, once approved
1. The `entity` field and its classification. All existing behaviour stays for sole_trader.
2. Pending-op multi-signature queue (§2.4) with tests, behind a flag. The largest piece; everything else needs it.
3. Org Safe deployment plus membership-driven owner changes and guards (§2.2, §2.3).
4. Monerium link and IBAN for the org Safe (§3.3); needs Q4 answered.
5. Migration tool (§4).
6. Remove the personal-backer path for company orgs, and the AGENTS.md and docs changes.
This is M2-sized. M1 is unaffected except that row 13, #105(b) and "backer offboarding" are now part of this work.

## 6. Questions for the owner
1. **Who signs?** Is `account.sign` owner only, or owner and payer? Default threshold: 1-of-n, or 2-of-n once there are 2+ signers?
2. **Sole traders**: a freelancer's business org is backed by their personal Safe. Monerium's personal terms (§16, cited in code) may not allow business use of a personal profile. Does a sole trader need a Monerium corporate or business profile, or is a personal profile fine for them?
3. **Existing business orgs** with a non-corporate profile: treat them as sole_trader, or ask each one?
4. **Monerium IBAN**: does Monerium let us move the existing IBAN to the org Safe, or is it a new IBAN? A new IBAN means customers' saved bank details change. This needs to be confirmed with Monerium.
5. **Migration funds**: move the backer's whole Safe balance, or only what the books attribute to the org since `backedSince`?
6. **Removal while a payment is pending**: if a removed member's signature is already on a queued op, drop it (safer) or let the op go through?
7. **Recovery for companies**: Zoldenburg-only guardian, armed from a company bank account. OK?
