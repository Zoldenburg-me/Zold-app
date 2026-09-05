/**
 * The organisation-centric domain.
 *
 * A user is NOT an account: a business has several people and several
 * accounts, and a person with a premium plan has several currencies. So the
 * tenant is an Organisation, money hangs off Accounts, and a User is only a
 * login identity that may belong to many orgs.
 *
 * See docs/business-accounts.md for the mapping from Gnosis Business.
 */

export type OrgType = "personal" | "business";

/**
 * Personal orgs ladder starter -> premium; business orgs starter -> business.
 * `starter` is shared: it is the free, payouts-only floor for both, which is
 * what makes an upgrade a plan change rather than a migration.
 */
export type PlanId = "starter" | "premium" | "business";

export type CostBasisMethod = "FIFO";

/**
 * A capability that some regulated partner must verify before it can be used.
 * Keyed per capability on purpose: Gnosis Business ran KYB twice (Triple-A for
 * payouts, Blockpass for cards) because each partner owns its own identity
 * relationship and neither accepts the other's. Collapsing these into one
 * `org.verified` boolean would claim an approval we were never given.
 */
export type VerifiableCapability =
  | "fiat_payout" // send to a bank account
  | "account_issuance" // be issued a local account / IBAN
  | "cards"; // not built; modelled so the UI can say why

export type VerificationStatus =
  | "unverified"
  | "requested"
  | "in_review"
  | "approved"
  | "rejected";

export interface Verification {
  capability: VerifiableCapability;
  status: VerificationStatus;
  /** Who actually holds the identity record. `null` while unverified. */
  provider: "monerium" | "sumsub" | "manual" | null;
  /** The provider's own id for this applicant, so a support question is
   *  answerable without re-deriving it. */
  applicantId?: string;
  requestedAt?: string;
  decidedAt?: string;
  /** Plain words a support person can act on; shown to the org. */
  reason?: string;
}

export interface Organisation {
  id: string;
  type: OrgType;
  /** Display name. For a business this is the trading name; `legalName` is
   *  what appears on an invoice. */
  name: string;
  legalName?: string;
  taxId?: string;
  email?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    postalCode?: string;
    stateOrProvince?: string;
    /** ISO 3166-1 alpha-2. Some partners want alpha-3 — convert at the edge
     *  (stellar/sep9.ts), never store the converted form. */
    country: string;
  };
  plan: PlanId;
  /** A trial is a grant with an end date, not a plan change: when it lapses the
   *  org is back on `plan` with nothing deleted. One per org, ever. */
  trial?: {
    grantsPlan: PlanId;
    startedAt: string;
    endsAt: string;
    /** Set when it lapses or is superseded by a real upgrade. */
    endedAt?: string;
  };
  reporting: {
    currency: string; // ISO 4217, e.g. "EUR"
    timeZone: string; // IANA, e.g. "Europe/Berlin"
    costBasisMethod: CostBasisMethod;
  };
  verifications: Partial<Record<VerifiableCapability, Verification>>;
  /** Email that receives invoice and payment notifications. Falls back to the
   *  owner's address when unset. */
  notificationEmail?: string;
  /**
   * Everything needed to issue a compliant invoice without retyping it.
   *
   * This is the org's own identity as it must appear on a document it issues:
   * §14 Abs. 4 UStG wants the issuer's full name, address and Steuernummer or
   * USt-IdNr. on every invoice, so they live here once and prefill every time.
   * `display` covers only OPTIONAL blocks — see InvoiceDisplayOptions.
   */
  invoicing?: {
    /** USt-IdNr. (DE + 9 digits for Germany). */
    vatId?: string;
    /** Steuernummer, the alternative §14 Abs. 4 Nr. 2 accepts. */
    taxNumber?: string;
    /**
     * Kleinunternehmer under § 19 UStG. When set, new invoices default to the
     * §19 exemption and never to a VAT rate — getting that backwards is the
     * §14c mistake, and the default is where it would happen.
     */
    smallBusiness?: boolean;
    /** The rate this org normally charges. A number, not a German 19|7 union —
     *  see VatRate. Only consulted when not a small business. */
    defaultVatRate?: number;
    /** Which jurisdiction's rules were applied, resolved from the org address.
     *  Stored on issue so a later move does not restate old invoices. */
    jurisdiction?: string;
    /** Rules the org added because its country needs something we do not
     *  encode. Always presented as user-supplied, never as validated. */
    customReasons?: {
      id: string;
      label: string;
      legalBasis?: string;
      invoiceNote: string;
      requiresRecipientVatId?: boolean;
    }[];
    /** Registration details German invoices commonly carry in the footer. */
    registerCourt?: string; // Amtsgericht
    registerNumber?: string; // HRB …
    managingDirector?: string; // Geschäftsführer
    /** Where the money should go. Rendered when display.bankDetails is on. */
    bank?: { holder?: string; iban?: string; bic?: string; bankName?: string };
    paymentTermsDays?: number;
    paymentTermsNote?: string;
    footerNote?: string;
    /** Per-year series, e.g. prefix "RE-{YYYY}-". */
    numberSeries?: { prefix: string; next: number; padding: number };
    /** Which optional blocks appear. Mandatory ones are not listed. */
    display?: Partial<Record<string, boolean>>;
    /** Extra label/value rows the issuer wants on every invoice. */
    customFields?: { label: string; value: string }[];
    language?: "de" | "en";
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Roles, narrowest to widest. `accountant` is separate from `payer` because the
 * person who categorises transactions is usually not the person allowed to send
 * money; collapsing them turns a bookkeeping login into a spending login.
 */
export type Role = "viewer" | "accountant" | "payer" | "admin" | "owner";

export const ROLES: Role[] = ["viewer", "accountant", "payer", "admin", "owner"];

export type MemberStatus = "invited" | "active" | "deactivated";

export interface Member {
  id: string;
  orgId: string;
  /** Unset until an invitation is accepted — the invitee may not have a login
   *  yet, and we must not create one on their behalf. */
  userId?: string;
  email: string;
  name?: string;
  role: Role;
  status: MemberStatus;
  invite?: {
    /** Hash of the token, never the token. The plaintext is returned once,
     *  at creation, and is not recoverable afterwards. */
    tokenHash: string;
    /** Gnosis expired invites after 3 days for security; we keep that. */
    expiresAt: string;
    invitedBy: string;
    message?: string;
  };
  invitedAt: string;
  acceptedAt?: string;
  deactivatedAt?: string;
}

// ── Accounts ────────────────────────────────────────────────────────────────

/** Currencies the account model knows about. Being listed here is NOT a claim
 *  that the rail works — see `AccountStatus.gated` and accounts.ts. */
export type CurrencyCode = "EUR" | "USD" | "GBP" | "CHF" | "KES" | "NGN" | "INR";

export type AccountProvider =
  | "monerium"
  | "iron"
  | "triplea"
  | "dlocal"
  | "yellowcard"
  /**
   * No candidate has been identified at all — distinct from a named partner we
   * have not contracted with. "iron, not granted" and "nobody yet" are
   * different states, and collapsing them would let a currency look one email
   * away from working when no one has looked for a provider.
   */
  | "none";

/**
 * `gated` is a first-class resting state, not an error: the currency is real,
 * the partner is named, and we simply cannot open it yet. It exists so the UI
 * can show an honest "not available yet, needs X" instead of a mock that looks
 * live. Only EUR reaches `active` today.
 */
export type AccountStatus =
  | "gated"
  | "provisioning"
  | "active"
  | "suspended"
  | "error";

export interface AccountIdentifier {
  /** EUR/SEPA. */
  iban?: string;
  bic?: string;
  /** GB Faster Payments. */
  accountNumber?: string;
  sortCode?: string;
  /** US ACH. */
  routingNumber?: string;
  /** Mobile-money rails (KES/M-Pesa). */
  mobile?: string;
  /** UPI virtual payment address (INR). */
  vpa?: string;
  /** NGN: a Nigerian bank account is a 10-digit NUBAN plus its bank code. */
  nuban?: string;
  bankCode?: string;
}

export interface Account {
  id: string;
  orgId: string;
  currency: CurrencyCode;
  /** Human label, e.g. "Operating EUR". Defaults to "<currency> account". */
  label: string;
  status: AccountStatus;
  provider: AccountProvider | null;
  identifier: AccountIdentifier;
  /**
   * The smart account this currency settles to on-chain, where the currency is
   * tokenised (EUR -> EURe). Null for a rail with no token leg.
   */
  address?: `0x${string}`;
  /**
   * The User whose Safe funds this account and whose FP4 device key authorises
   * its debits.
   *
   * Spending authority lives with a device key held in one person's browser, so
   * an account is only spendable by that person — a `payer` on the org cannot
   * sign for someone else's key, and there is no server-side authority to fall
   * back on. Stored explicitly rather than inferred from the owner membership,
   * because membership changes and the key does not follow it.
   *
   * Unset on an account opened for a new organisation: provisioning a Safe and
   * a Monerium profile per org is not built, and execution refuses by name
   * rather than guessing at someone's wallet.
   */
  backingUserId?: string;
  /** Why it is not open, and what would open it. Required when `gated`. */
  gate?: {
    reason: string;
    /** Named partner + missing piece, e.g. "Iron sandbox credentials". */
    needs: string;
  };
  /** Provider-side provisioning detail, for support. */
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Imported wallets (read-only; the Gnosis half) ───────────────────────────

export type WalletKind = "eoa" | "safe" | "mpc";

export interface ImportedWallet {
  id: string;
  orgId: string;
  address: `0x${string}`;
  chainId: number;
  label: string;
  kind: WalletKind;
  groupId?: string;
  /**
   * Always "external". Stored rather than implied so that a signing path can
   * assert on the row itself: we never hold a key for an imported wallet, and
   * a future issued-wallet row must not silently inherit signing rights.
   */
  custody: "external";
  sync: {
    status: "pending" | "syncing" | "synced" | "error";
    lastSyncedAt?: string;
    /** Last block scanned, as a string — JSON has no bigint. */
    cursor?: string;
    error?: string;
  };
  createdAt: string;
}

export interface WalletGroup {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
}

// ── Address book ────────────────────────────────────────────────────────────

export interface ContactWallet {
  id: string;
  chainId: number;
  address: `0x${string}`;
  label?: string;
}

/**
 * A payee's bank details. Which fields are required depends on the destination
 * country, which is why this is a bag rather than a union — the validator in
 * contacts.ts decides per corridor and refuses rather than guessing.
 */
export interface ContactBankAccount {
  id: string;
  currency: CurrencyCode;
  country: string; // ISO 3166-1 alpha-2
  holderName: string;
  iban?: string;
  bic?: string;
  accountNumber?: string;
  sortCode?: string;
  routingNumber?: string;
  mobile?: string;
  /** UPI id. Modelled because INR is in the currency registry; the rail is
   *  gated, so nothing can execute against it. */
  vpa?: string;
  label?: string;
}

export interface Contact {
  id: string;
  orgId: string;
  name: string;
  email?: string;
  wallets: ContactWallet[];
  bankAccounts: ContactBankAccount[];
  /** Account-rule automation: default COA code for money in / money out. */
  defaultAccountCodeIn?: string;
  defaultAccountCodeOut?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Draft payments (create -> review -> execute) ────────────────────────────

/**
 * `INVALID_DATA` is Gnosis's state and worth keeping: a draft whose saved
 * recipient changed under it must stop rather than retarget silently. It is not
 * a failure — it is a draft asking to be re-pointed at the current address.
 */
export type DraftState =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "REVIEWED"
  | "REJECTED"
  | "INVALID_DATA"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED";

export interface DraftLine {
  id: string;
  contactId?: string;
  /** Resolved at save time. Kept alongside contactId so a later change to the
   *  contact is *detectable* (-> INVALID_DATA) rather than invisible. */
  destination: {
    kind: "wallet" | "bank";
    chainId?: number;
    address?: `0x${string}`;
    bankAccountId?: string;
    /** Snapshot of the payee identity at save time. On the bank rails the name
     *  is part of the payout identity, so it is signed over, not decorative. */
    displayName: string;
    /**
     * Fingerprint of the resolved destination as it stood when the line was
     * saved. Compared — never displayed — against a fingerprint recomputed
     * from the contact at review and again at execution. A bank account can be
     * edited in place (same id, new IBAN), so identity alone does not detect
     * drift; this is what does.
     */
    fingerprint?: string;
  };
  asset: string; // token symbol or currency code
  amount: string; // decimal string; never a float
  accountCode?: string;
  note?: string;
  tags: string[];
}

export interface DraftActivity {
  at: string;
  actorMemberId: string;
  action: string;
  detail?: string;
}

export interface DraftPayment {
  id: string;
  orgId: string;
  /** Which account or imported wallet funds it. An imported wallet means the
   *  execution step builds an unsigned transaction instead of submitting. */
  source: { kind: "account"; accountId: string } | { kind: "wallet"; walletId: string };
  state: DraftState;
  lines: DraftLine[];
  createdByMemberId: string;
  reviewedByMemberId?: string;
  reviewedAt?: string;
  rejectedReason?: string;
  /** Set when a line's contact drifted; names the lines to re-point. */
  invalidLineIds?: string[];
  /** Transfers created when executed, in line order. */
  transferIds?: string[];
  failureReason?: string;
  activity: DraftActivity[];
  createdAt: string;
  updatedAt: string;
}

// ── Invoices (the "Invoice-Me" one-time link) ───────────────────────────────

/**
 * Locked on submit, per Gnosis's rule: "once submitted, invoices are timestamped
 * and locked". Deleting is only allowed while unpaid.
 */
export type InvoiceState =
  | "LINK_CREATED"
  | "SUBMITTED"
  | "PAYING"
  | "PAID"
  | "RECONCILED"
  | "DELETED";

export interface InvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

/**
 * Which way an invoice points.
 *
 * `incoming` is the original Invoice-Me flow: we generate a link, a supplier
 * fills it in, we pay it. `outgoing` is one WE issue to a customer, and it is
 * the one that has to satisfy §14 UStG — so it carries a frozen snapshot of
 * both parties and the VAT treatment, rather than reading them live. An issued
 * invoice must keep saying what it said on the day it was issued, even after
 * the org changes its address.
 */
export type InvoiceDirection = "incoming" | "outgoing";

export interface InvoiceParty {
  name?: string;
  addressLine?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  vatId?: string;
  taxNumber?: string;
  email?: string;
}

/**
 * An on-chain payment that settled an invoice.
 *
 * Written when the payment is converted, so the invoice carries the whole
 * thread: what arrived, in what, on which transaction; what it was worth in
 * EUR at that moment and on whose rate; which transaction converted it; and
 * what actually landed. An auditor asking how an invoice was paid should not
 * have to match amounts against timestamps to find out.
 *
 * `creditedEur` is what ARRIVED, measured as a balance delta — not what any
 * quote promised. `realisedGainEur` is that minus the receipt value, and is
 * absent rather than zero when the receipt could not be valued: an unknown
 * basis gives an unknown gain, and zero would be a claim.
 */
export interface InvoiceSettlement {
  depositId: string;
  receivedAsset: "USDC" | "EURE";
  receivedAmount: number;
  receiptTxHash: string;
  /** EUR value at receipt, with the rate and whose feed it came from. */
  receiptAmountEur?: number;
  receiptRate?: number;
  receiptRateProvider?: string;
  /** The user-signed swap, when one was needed. */
  conversionTxHash?: string;
  creditedEur?: number;
  realisedGainEur?: number;
  at: string;
}

export interface Invoice {
  id: string;
  /** Defaults to "incoming" for rows written before outgoing existed. */
  direction?: InvoiceDirection;
  /** The organisation this row belongs to: payor when incoming, issuer when
   *  outgoing. */
  orgId: string;
  /** Hash of the one-time link token. The supplier holds the plaintext; we
   *  never store it, so a leaked database does not hand over open invoices. */
  linkTokenHash: string;
  /** Optional password gate on the link, hashed the same way. */
  linkPasswordHash?: string;
  state: InvoiceState;
  /** Filled in by the supplier through the link — no account, no wallet. */
  supplier?: {
    orgName: string;
    email: string;
    address?: string;
    taxId?: string;
    invoiceNumber: string;
  };
  lines: InvoiceLine[];
  currency: string;
  total: string;
  dueDate?: string;
  /** How the supplier wants to be paid. */
  payTo?: {
    kind: "wallet" | "bank";
    chainId?: number;
    address?: `0x${string}`;
    bank?: Omit<ContactBankAccount, "id">;
  };
  payment?: {
    transferId?: string;
    txHash?: string;
    paidAt?: string;
    /** Set when someone marks it paid outside the platform. */
    manual?: { byMemberId: string; at: string; note?: string };
  };
  submittedAt?: string;
  createdByMemberId: string;
  createdAt: string;
  updatedAt: string;

  // ── Outgoing invoices (§14 UStG) ─────────────────────────────────────────
  /**
   * Frozen at issue. Both parties, the VAT treatment and the display choices
   * are snapshotted so the document is reproducible: an invoice is a statement
   * about a moment, and re-rendering it from today's org profile would quietly
   * rewrite history the tax office may later ask about.
   */
  issued?: {
    number: string;
    issueDate: string;
    supplyDate?: string;
    supplyPeriod?: { from: string; to: string };
    issuer: InvoiceParty;
    recipient: InvoiceParty;
    /** See domain/invoicing.ts — exempt arms carry no rate by construction.
     *  The rate is a plain number: it is 19 in Germany, 23 in Poland, 25 in
     *  Sweden, and we do not ship a rate table. */
    vatTreatment:
      | { kind: "standard"; rate: number }
      | { kind: "exempt"; reason: string; note?: string };
    /** The statutory note actually printed, resolved at issue time. */
    vatNote?: string;
    netCents: number;
    vatCents: number;
    grossCents: number;
    /** Per-rate breakdown — §14 Abs. 4 Nr. 8 wants the split, not just a total. */
    buckets: { rate: number; netCents: number; vatCents: number }[];
    purchaseOrder?: string;
    paymentTerms?: string;
    notes?: string;
    display?: Record<string, boolean>;
    customFields?: { label: string; value: string }[];
    language?: "de" | "en";
    /** Compliance warnings accepted at issue, kept for the audit trail. */
    acceptedWarnings?: string[];
    /**
     * Which rules were applied and how deep the check went. Frozen with the
     * document: the entity may later move country, and a 2026 invoice must keep
     * saying which rule set it was issued under.
     */
    jurisdiction?: {
      country: string;
      countryName: string;
      ruleSet: "DE" | "EU" | "GENERIC";
      verification: "statutory" | "directive" | "structural";
      basis: string;
      notVerified: string[];
    };
  };
  /** On-chain payments that settled this invoice. Appended, never replaced —
   *  an invoice can legitimately be paid more than once. */
  settlements?: InvoiceSettlement[];
}

// ── Chart of accounts + bookkeeping ─────────────────────────────────────────

export type ChartAccountType =
  | "revenue"
  | "expense"
  | "asset"
  | "liability"
  | "equity";

export interface ChartAccount {
  id: string;
  orgId: string;
  code: string;
  name: string;
  type: ChartAccountType;
  archived: boolean;
  createdAt: string;
}

/**
 * Automation for mapping transactions to accounts, in Gnosis's three scopes.
 * Evaluated most-specific-first: contact, then wallet+asset, then wallet, then
 * the transaction-type default.
 */
export type AccountRuleScope = "default" | "wallet" | "asset" | "contact";

export interface AccountRule {
  id: string;
  orgId: string;
  scope: AccountRuleScope;
  /** transaction type for `default`; wallet id / asset symbol / contact id
   *  otherwise. `asset` rules may additionally pin a wallet. */
  match: { txType?: string; walletId?: string; asset?: string; contactId?: string };
  /** Which side this applies to; contacts commonly map in and out differently. */
  direction: "in" | "out" | "both";
  accountCode: string;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  orgId: string;
  /** Where the row came from. `account` rows are ours; `wallet` rows are from
   *  an imported wallet we only watch. */
  source: { kind: "account"; accountId: string } | { kind: "wallet"; walletId: string };
  chainId?: number;
  txHash?: string;
  logIndex?: number;
  direction: "in" | "out";
  asset: string;
  /** Decimal string in asset units. */
  amount: string;
  /** Value in the org's reporting currency at `at`, and the rate used. Both
   *  stored, because a rate that cannot be re-derived is not auditable. */
  fiatValue?: string;
  fiatCurrency?: string;
  fiatRate?: string;
  counterparty?: { contactId?: string; address?: string; name?: string };
  accountCode?: string;
  /** True when a rule set the code, false when a human did. A later rule change
   *  may re-map the former and must never overwrite the latter. */
  accountCodeAuto?: boolean;
  tags: string[];
  note?: string;
  txType?: string;
  at: string;
  createdAt: string;
}
