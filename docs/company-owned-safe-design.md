# Company-owned Safe for business orgs (design, for the owner's approval)

Zold lead, 2026-10-25. Code read on main a001d0e8. Nothing gets built before the owner approves this note.

Cross-checked on 2026-11-18 against main 3a15b56 and Florentine's code map (board #118). §1–§6 are the original text with stale references fixed inline; §7 lists what changed since and what the note misses. Revised again the same day after Florentine's review of 898f17c (PR #35 comment).

**The owner's decision:** "the Ownership of a safe From a corprate account should always belong to the company not to the person who made the safe or the passkey! for a freelance! who dont have a seperate legal identity we dont care! if he comingle funds or not!!"

## 1. What exists today

- `OrgType` is `"personal" | "business"` (`domain/types.ts:14`). Nothing says whether a business org is a legal entity or a sole proprietor.
- A business org's EUR `Account` has `backingUserId` (`types.ts:294`): the member whose own passkey Safe receives the money and whose device key signs its debits.
  - It is set by `POST /orgs/:orgId/accounts` with adoption (`routes/orgs.ts:634-752`) or `POST /orgs/:orgId/accounts/:accountId/fund` (`routes/orgs.ts:763-856`) from the caller's own Safe, IBAN and Monerium profile. On the IBAN path the profile must be `corporate` (`judgeProfile`, `domain/monerium-profile.ts:106-120`). The wallet tier is the exception: it binds a Safe with no IBAN and no profile, and the row stays `gated` (`routes/orgs.ts:792-810`; `accountProfileStanding` reports `not_applicable`, `monerium-profile.ts:211-213`).
  - A wallet-tier owner can instead connect their own Safe with no IBAN. Since #502 (d48a300, 2026-10-27) only an owner can back a business account, on both routes (403 `OWNER_ONLY`, `routes/orgs.ts:685`, `:791`). That settles #105(b) for new accounts; accounts an admin already backs are not repaired and belong to the migration (§4).
  - Nothing unbinds or replaces a backer: no route clears `backingUserId` (`routes/orgs.ts:787-789`). The type's own comment says per-org Safe provisioning "is not built".
- Membership and money are disconnected:
  - Removing or deactivating the backing member changes nothing on chain. The money stays in their Safe and they can still spend it.
  - An extra owner added through `routes/safe-signers.ts` stays on chain after their membership ends. Those routes are narrow: `/users/:id/safe/...` on the caller's own `passkeySafe` (`:69-76`), at most two owners (`:190-191`), the passkey can't be removed (`:211`), the threshold can only be raised (`:229`), and pending ops are an in-process map with a five-minute TTL (`:50,57-60`). Only their chain *reads* carry over to the org Safe; every org write is new.
  - The backer keeps listing and revoking the org's Belege through personal routes (row 13). A Beleg belongs to a person: `StoredDocument.userId` is the owner and `orgId` is an optional label (`documents.ts:160-166`); listing is `documentsForUser` (`store.ts:590-592`) and revocation requires `doc.userId === user.id` (`routes/documents.ts:487-497`).
- A Safe has exactly one signer Zold collects from: the passkey. At threshold > 1, `assertPasskeyAloneCanSign` refuses every op Zold submits (409 `SAFE_NEEDS_MORE_SIGNATURES`, `wallet/candide.ts:570-578`). Recovery doesn't pass through it, and nothing stops another owner signing in Safe{Wallet}. Zold has no way to collect a second person's signature.
- Candide recovery (`finalizeRecovery`) replaces the WHOLE owner set (`docs/recovery-and-signers.md`).
- `wouldOrphanOrg` (`domain/roles.ts:126`) protects the last owner membership, but not the last on-chain signer.

## 2. Target model

### 2.1 Two kinds of business org
- New field: `Organisation.entity: "company" | "sole_trader"`, chosen at org creation and locked once the account is funded.
- **sole_trader** (freelancer, no separate legal person): keeps today's model exactly. Their own Safe backs the org. No separation of funds is built; the owner said they don't care about commingling.
- **company**: the org's EUR account sits on its own Safe, the **org Safe**, owned by the company. The rest of this note is about `company` orgs.
- **No existing orgs to classify.** Zold is redeployed from zero (owner, 2026-11-18), so every business org picks its `entity` at creation (§6, Q3).

### 2.2 The org Safe
- One Safe per company org, deployed by Zold at account opening, with the org as its holder of record.
- **Owners on chain** = the passkey signers of members with the `owner` role, one WebAuthn signer per member. Zold adds a passkey to the Safe only for an `owner`; it never adds a payer, admin, accountant, viewer or AI agent. Payers (in practice accountants or bookkeepers) and admins prepare and queue payments as drafts; only owners sign.
  - Zold never holds an owner key. The AGENTS.md invariant "never add a co-owner that Zold holds" stays.
- **The chain is the truth.** Zold reads the owner set and the threshold from the Safe on every visit, like `safe-signers` today, and never enforces a threshold of its own: a 1-of-1 Safe needs one signature, a 2-of-4 Safe needs two. A signature from anyone who is not an owner on chain does nothing, so Zold's roles decide only whose passkey Zold adds or removes. Owners added or removed outside Zold (for example in Safe{Wallet}) are shown as the chain has them and flagged in the Access card.
- **Recovery guardian**: the Zoldenburg guardian (hardware wallet) only. Zold deploys this Safe, so no Candide email/SMS guardian is added to it, and Turnkey guardians belong to people (`/users/:id/...` routes), so they aren't offered either. How the guardian is armed for a company is open (Q7). See §3.4 for why Candide's module needs care.

### 2.3 Membership drives the owner set, in one flow
- **Granting a signing role** = invite accepted, passkey bound, then an `addOwnerWithThreshold` op signed by the current owners up to the threshold. The member becomes a signer only when the chain shows it.
- **Removing or deactivating a member, or downgrading them out of the `owner` role** = a `removeOwner` op in the same flow.
  - The membership change and the on-chain removal are one pending action.
  - Until the chain confirms the removal, the app shows them as **"removal pending, can still sign"**, never as removed.
  - There is no pending membership state: `MemberStatus` is `invited | active | deactivated` (`domain/types.ts:194`), and `resolveOrg` answers 404 for anything but `active` (`routes/org-context.ts:50-53`). The member row keeps its current status and role until the chain confirms the removal; only then is the change written. "Removal pending, can still sign" is derived from the pending op, not stored on the member. If the op fails or expires, nothing was written, so nothing needs rolling back.
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
- The existing payment drafts (`routes/business/drafts.ts`) become the UI for this. Today they are different objects from a signature:
  - Review is a policy flag on the org, evaluated per draft (`domain/payment-review.ts:14-18`, applied at `drafts.ts:220,362,608`), not a signature.
  - One draft is N transfers, one per line (`drafts.ts:520-533`). So owners either sign N ops, or one batched op whose digest covers every line. This note proposes one batched op per draft (one Safe `multiSend`): one signature per owner per draft. Consequence: a draft becomes all-or-nothing. One reverting line reverts the whole draft, where today each transfer stands or falls alone and a failure partway leaves the draft `FAILED` (`drafts.ts:520-533`, `scripts/draft-batch-failure-test.ts:1-8`). The owner decides whether a draft pays all its lines or none.
  - Execution re-reads the backing profile and can refuse a draft that was already reviewed (`drafts.ts:500-513`), or hold it as `INVALID_DATA` when its facts drifted (`:528-529`). A signature already collected can't be withdrawn, so when an execution-time check fails after signing, the queued op is invalidated and its signatures discarded, the same shape as `INVALID_DATA`. The draft must be signed again.
- On an org Safe the owners' signatures are the approval. There is no off-chain review step before signing on an org Safe (§6, Q8).
- The invariant "No debit without a user signature" still holds, at n-of-m. The API still disposes of nothing.

## 3. Effects

### 3.1 Belege, books, invoices
- Invoices, payment links, statements and the ledger carry `orgId`. Belege carry it only as an optional label; they belong to the person who holds the account (§1).
- `bookkeeping/issue.ts:34,44` stamps `userId = backingUserId` on a Beleg, and the backer reaches them through the personal `/users/:id/documents` routes (`routes/documents.ts:329-515`). For company orgs, Belege are listed and revoked only through new org-scoped routes, gated on membership and role (this settles row 13). That is new work with its own access rule, and it must decide what happens to a document that is both the backer's personal receipt and an org Beleg.
- `Account.backedSince` (`types.ts:300`, read in `bookkeeping/writer.ts:64`) and `safeBooksStart` (`domain/safe-books.ts:15`) already model "from when this Safe's movements are this account's". The org Safe starts its own books at deployment, and the personal Safe's books for the org end at the cut-over instant. Statements show one continuous account, with the cut-over as a transfer between two addresses of the same account, not as income or expense.

### 3.2 Payment links, Shopify, crypto-in, `orgsBackedBy`
- `orgsBackedBy(userId)` (`payment-requests.ts:192`, called at `:157,209,316,328,691`) answers "is this Safe the org's?" by person, for personal orgs as well (`docs/wallet-tier.md:65`). For company orgs it must also answer "is this address the org Safe?" (`orgOfAddress`): a dual answer during and after the migration, not a replacement.
- Row 7 (Brief E) keeps working: it requires the deposit to land in the org's account. Today that means the backer's Safe; after migration, the org Safe.
- The crypto-in watched addresses add the org Safe. The payment-page deposit address and the Shopify payee point at the org Safe.

### 3.3 Monerium IBAN
- The IBAN belongs to the Monerium corporate profile and is attributed to an address. The org Safe has to be linked to that corporate profile; Monerium requires a signature from the address, which for a Safe means EIP-1271 at the threshold.
- Monerium gives a profile one IBAN (§6, Q4), so the company's IBAN is issued straight onto the org Safe when the account opens. There is nothing to move and no second profile. The address-matched activation rule stays: the account is `active` only when Monerium attributes an IBAN to the org Safe.

### 3.4 Recovery
- Candide's `finalizeRecovery` replaces every owner. On a company Safe that would remove every member to restore one, so:
  - **One member lost their passkey**: the other owners replace that signer at the threshold. Zold has no `swapOwner` builder (the name is only an ABI entry for imported Safes, `wallet/safe-import.ts:52,305`), so this is either two ops (`removeOwner` then `addOwnerWithThreshold`, each needing the threshold's signatures, and `removeOwner` needs the previous-owner linked list) or a new `swapOwner` builder. This note proposes the new builder: one op, one round of signatures. No guardian is involved. If they are the only signer, it's the case below.
  - **All signers lost**: guardian recovery to the new owner set the company names. It goes through Zoldenburg's operator review against the company's Monerium KYC and the armed enrolment (Q7).
- Zoldenburg is the only guardian on an org Safe: Zold deploys it, so no Candide email/SMS guardian is added (§2.2), and Turnkey guardians belong to people, so they are not offered either. (`recovery/one-guardian.ts` allows Zoldenburg and the email/SMS guardian to share a module on a personal Safe, so it is not the rule here.)

### 3.5 AGENTS.md invariants to change (the owner sees each one)
- "The passkey is the Safe's only owner. The plan type is `threshold: 1` only." This stays true for personal and sole_trader Safes. For an org Safe: members' passkeys are the only owners, at the org's threshold, and Zold holds none.
- "Zold never collects its [second owner's] signature, so at threshold > 1 every op is refused." This stays true for personal Safes. Org Safes collect member signatures through the pending-op queue.
- "Four eyes": on an org Safe the control is the owners' signatures at the on-chain threshold (§2.4). That is the only four-eyes control: the off-chain review flag is not used on an org Safe (Q8).
- "An org can never lose its last owner": add "and its Safe never loses its last signer, and the threshold never exceeds the signers left".
- New invariant: **Zold never changes membership or the on-chain signer set without the other.** Nobody is shown as removed while they can still sign. This covers Zold's own writes only: a change made elsewhere, such as an owner added in Safe{Wallet}, is shown as the chain has it and flagged in the Access card (§2.2).
- "Gating is a read-time filter, never a write-time delete" (`AGENTS.md:132-135`) stays, and covers the removal: nothing is deleted while the chain still has the signer.

## 4. Migration: none
Zold is redeployed from zero (owner, 2026-11-18). No business account is backed by a personal Safe at launch, so there is no cut-over, no fund move and no rebind. A company org gets its org Safe and IBAN at account opening; a sole_trader org uses the owner's own Safe as today. The cut-over and dual-address wording in §3.1 and §3.2 doesn't apply. `backingUserId` is never set on a company org's account.

## 5. Order of work, once approved
1. The `entity` field, chosen at org creation. All existing behaviour stays for sole_trader.
2. Pending-op multi-signature queue (§2.4) with tests, behind a flag. The largest piece; everything else needs it.
3. Org Safe deployment plus membership-driven owner changes and guards (§2.2, §2.3).
4. Monerium link and IBAN for the org Safe (§3.3), issued at account opening.
5. Org-scoped Zoldenburg recovery enrolment from the company's IBAN (§6, Q7).
6. Company orgs never take the personal-backer path; AGENTS.md and docs changes.
This is M2-sized. M1 is unaffected except that row 13, #105(b) and "backer offboarding" are now part of this work.

## 6. Questions for the owner
1. **Default threshold**: 1-of-n, or 2-of-n once there are 2+ signers? (Who signs is settled: only owners.)
   - **Answered 2026-11-14 (board #118, events 733–734):** only owners sign; one signature is enough by default; Zold follows whatever threshold the Safe has on chain. Keep the five roles. Split `transfers.execute`: prepare and queue stays with payer and admin, signing is owner only. MD and CFO are owners, finance staff are payers, an AI agent is a payer without a signature. Per-member limits come later. This replaces "owner, and payer if the policy allows" in §2.2.
2. **Sole traders**: today a business org can't be backed by a personal profile: `expectedProfileKind("business")` is `corporate` (`domain/monerium-profile.ts:45-47`) and `judgeProfile` refuses the other kind. So "sole_trader keeps today's model" holds only for a freelancer registered at Monerium as a company. May a sole trader use a corporate profile, or does Monerium need another profile kind for them? Otherwise sole-trader business orgs stay unfundable, as they are now.
   - **Answered 2026-11-18 (owner):** for now, a sole trader also needs a Monerium business (corporate) profile, which matches today's `expectedProfileKind("business")`. No personal-profile path for business orgs.
3. **Existing business orgs** without a confirmed corporate profile: the real set is backed rows with no profile, a profile of the wrong kind, or one pending a check (execution already refuses them), plus gated wallet-tier rows with nothing to migrate (§2.1). Treat the first group as sole_trader, or ask each one?
   - **Answered 2026-11-18 (owner):** not applicable. Zold is redeployed from zero, so there are no existing orgs; `entity` is chosen at creation.
4. **Monerium IBAN**: move the company's IBAN to the org Safe, or have support open a second Monerium profile for the company and issue a new IBAN there? A profile holds one IBAN (`routes/monerium.ts:715-731`). The move is built (`:856-1019`) but needs the company's own Monerium login and stops the old address receiving. A second profile has no self-serve path: support opens it by hand (`SEPARATE_ACCOUNT_CONTACT`, `domain/monerium-profile.ts:48-50`). That is an ops commitment, and customers' saved bank details change.
   - **Answered 2026-11-18 (owner):** Monerium gives only one IBAN. With the fresh start, the company's IBAN is issued onto the org Safe at account opening; nothing moves and there is no second profile.
5. **Migration funds**: move the backer's whole Safe balance, or only what the books attribute to the org since `backedSince`? The adoption dialog already promises the whole balance: the account "then belongs to X, with everything on it" (`business/actions.js:495-499`). Choosing "only what the books attribute" reverses that promise to every current backer, and the dialog copy changes with it.
   - **Answered 2026-11-18 (owner):** not applicable. There is no migration (§4).
6. **Removal while a payment is pending**: if a removed member's signature is already on a queued op, drop it (safer) or let the op go through?
   - **Answered 2026-11-14 (board #118, event 735):** drop it. The queued op is signed again by the current owners; it follows the on-chain signer set.
7. **Recovery for companies**: Zoldenburg is the only guardian. The 1 € enrolment that arms it is user-scoped and needs a user's IBAN (`routes/recovery-zoldenburg-enrolment.ts:53`); an org has no IBAN of its own. Keep the enrolment on the backer's IBAN (it survives the migration), or build an org-scoped enrolment, which is new work and a new money movement?
   - **Answered 2026-11-18 (owner):** yes: Zoldenburg is the only guardian for company Safes. It is armed by a 1 € transfer from the company's own IBAN (the org Safe's IBAN), which means an org-scoped enrolment. That is new work (§5 step 5).

8. **Review step on an org Safe**: does the off-chain review flag stay as a step before owners sign, or is the on-chain threshold the only four-eyes control? **Answer: the on-chain threshold only; no off-chain review step on an org Safe.** (§2.4, §3.5.)

All eight questions answered (2026-11-18).

## 7. Cross-check against main 3a15b56 and the code map (2026-11-18)

### 7.1 Still true
- `OrgType` (`types.ts:14`), `backingUserId` (`types.ts:294`), `wouldOrphanOrg` (`roles.ts:126`), `orgsBackedBy` (`payment-requests.ts:192`), `assertPasskeyAloneCanSign` (`wallet/candide.ts:571`), `recovery/one-guardian.ts`, `finalizeRecovery` (`recovery/candide-guardian.ts:358`).
- No route unbinds a backer (`routes/orgs.ts:787-789`). Row 13 is still open: Belege are issued under the backer (§3.1).

### 7.2 Changed since the note
- #105(b) is closed for new accounts by #502 (§1). Admin-backed legacy rows remain; migration step 1 must find them.
- #501 left Shopify paying into the backer's own payment page, not the org's, so a company has two pages. §3.2 must pick one.

### 7.3 What the note misses
1. **Deactivating the backer locks the company out but not the backer.** `resolveOrg` answers 404 for a deactivated member (`routes/org-context.ts:50-53`), and only the backer may execute (`drafts.ts:485`, `crypto-sends.ts:401`). The company can't pay; the ex-member still holds the only key. No test covers this today.
2. **The threshold can't be lowered today.** `routes/safe-signers.ts:9-21`: no route lowers it, and at 2 Zold can't sign. §2.3's "lower the threshold in the same op" needs the pending-op queue first.
3. **The queue needs durable storage.** Today's pending ops are an in-memory map with a minutes-long TTL (`routes/safe-signers.ts:57-60`), and payment-review drafts collect no signature (`drafts.ts:429-513`). §2.4 must store signed ops, the owner set they were collected against, a TTL, and invalidation when the owner set changes (Q6).
4. **The Monerium link needs the queue too.** `POST /addresses` takes one EIP-1271 signature built from one passkey (`routes/monerium.ts:228`). At threshold > 1 it needs all owners, so §5 step 4 depends on step 2.
5. **One IBAN per Monerium profile.** `POST /ibans` returns 304 when the profile has one (`routes/monerium.ts:715-731`). Moving it is built (`move-iban`, `PATCH /ibans`, `:856-1019`), but it needs the company's own Monerium login (`:883-895`) and stops the old address receiving. The IBAN cascade `store.ts:173-190` re-points every account the user backs, so the migration must decide what it does. This informs Q4.
6. **`backingUserId` has about 15 read sites, and three decide who can move money**: `drafts.ts:485`, `crypto-sends.ts:401`, spendability (`domain/accounts.ts:338`). Payment pages, invoice pay-links (`invoice-pay-link.ts:109-114`), Shopify (`shopify.ts:249-250`) and the bookkeeping export (`bookkeeping-export.ts:99-137`) all resolve a person. Each is a decision, not a rename.
7. **The UI promises the personal model in writing**: "Only your passkey can approve its payments" (`business/actions.js:498`), "Only X sees this account's balance" (`business/home.js:129`), "Zold never collects another signer's" (`business/access.js:59`). Screens to change: `views.js:59-137`, `home.js:108-135,255-275`, `settings.js:54-70`, `access.js:41-66`, `access-model.js:36-53`, `send.js:30-60`. `access-model.js` is the tested seam for an org signer set.
8. **Payers who aren't signers**: is every payment a signed pending op, or does the org Safe get an Allowance-module limit for payers? Q1's "per-member limits later" points at this.
   - **Answered 2026-11-18 (owner):** every payment is a signed pending op. A payer who isn't an owner is in practice an accountant or bookkeeper: they set payments up as drafts, nothing more. No Allowance module and no payer spending now; per-member limits are a later decision.
9. **`backingMemberName` is an API field**, projected by `accountView` (`routes/orgs.ts:104-118`) and shown as the "Backing user" column in admin (`admin/monerium.js:63`). Both change meaning on migration.
10. **The 403 refusals are user-visible copy.** The UI renders server refusals verbatim (`business/core.js:78-100`, `business/shell.js:112-126`), so the wording at `drafts.ts:485-490` and `crypto-sends.ts:401` must change with the model.
11. **A member → signer address mapping is needed, and is now load-bearing.** The passkey owner address is derived, not stored (`passkeyAccountAddress`, `wallet/safe-signers.ts:87-89`). §2.2's "shown as the chain has them" and §2.3's "removal pending, can still sign" both join a member row to a chain owner, and the queue must record which member signed (Q6). Persist the mapping.
12. **An org-scoped read route for owners and threshold.** Today's route reads the caller's own `passkeySafe` (`routes/safe-signers.ts:69-76`). The member list (`business/screens.js:193-205`) and the Access card (`business/access.js:41-66`) need the org Safe's owners, threshold and each member's signer status. Showing who signs needs no new membership key, because only `owner` signs. The permission table still changes, because Q1 splits `transfers.execute`: today `PAYER` and `ADMIN` hold it (`domain/roles.ts:63-80`) and the client maps `send` to it (`business/core.js:205-217`), so payers and admins get a Send button. After the split, prepare and queue stays with payer and admin and signing is owner only, so the server table, `ROLE_CAN` and the button copy (`business/payment.js:72-73`, `business/send.js`) change with it.
13. **The send form offers nothing for an org-Safe row.** `fundableAccounts` filters on `a.backingUserId` (`business/home-model.js:15`), pinned by `business-home-test.ts:26-33`.

### 7.4 Tests to write before the migration
- Backer deactivation.
- HTTP tests for the Safe-owner routes (`routes/safe-signers.ts:164-345`; only the pure builders are tested).
- `move-iban` end to end.
- The org-Safe variant of `drafts.ts:485`.
- Suites that assert the backer shape and break silently: `business-home-test.ts:26-33` (unbacked accounts are unfundable), `pay-page-test.ts:468-474` (the public projection leaks no `backingUserId`), `merchant-links-test.ts:514-522` (the only test that clears `backingUserId`), `payment-review-test.ts:464-500` (deactivate and re-invite), `draft-execution-test.ts:190,224,323-330` (the funding pair and "reviewer cannot sign").
- About 15 suites build "business org + EUR account + `backingUserId`" by hand; a fixture helper changes them in one place.

### 7.5 Docs to rewrite when it is built
`product-architecture.md:115,122,135-145,648,696,782-783`, `technical-architecture.md:830,886-890,1213,1221`, `wallet-tier.md:65`, `CODEMAPS/data.md:21`, `CODEMAPS/frontend.md:32-35`, `status.md:50`, `recovery-and-signers.md` (an org Safe section), `roadmap.md` (M2), and `AGENTS.md:116-123,128-137` within its 12,000-character budget. A user-visible change also owes a PR on `Zoldenburg-me/zold-docs`.
