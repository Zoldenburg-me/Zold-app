/**
 * The database: one JSON file, loaded at start, rewritten on every change.
 *
 * A demo-scale store. Everything goes through the methods in store.ts, so
 * swapping in a real database is a change in one place. It is not safe for
 * concurrent writers: the whole file is rewritten, so two processes on one
 * path lose each other's writes.
 *
 * The migrations run at load and are idempotent, each keyed on the row it
 * would create, because this holds a money ledger.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IS_PRODUCTION, ROOT } from "../config.js";
import { DEFAULT_CHART, DEFAULT_RULES } from "../domain/coa.js";
import { defaultLabel, initialStatusFor } from "../domain/accounts.js";
import type {
  Account,
  AccountRule,
  ChartAccount,
  Contact,
  DraftPayment,
  ImportedWallet,
  Invoice,
  LedgerEntry,
  Member,
  Organisation,
} from "../domain/types.js";
import type {
  CryptoDeposit,
  PaymentRequest,
  Quote,
  ReceiptShare,
  RecoveryRequest,
  Session,
  ShopifyConnection,
  StoredDocument,
  Transfer,
  User,
} from "./types.js";

export interface Db {
  users: User[];
  quotes: Quote[];
  transfers: Transfer[];
  sessions: Session[];
  /** Public shareable receipts, keyed by an unguessable slug. */
  receiptShares: ReceiptShare[];
  /** Account documents (receipts, statements, balance and ownership letters):
   *  frozen snapshots under a verification code. See documents.ts. */
  documents: StoredDocument[];
  /** Payment requests (pay links): an amount somebody asked to be paid, the
   *  ways it can be paid, and what arrived against it. See payment-requests.ts. */
  paymentRequests: PaymentRequest[];
  /** Shopify stores connected to an organisation as a payments app. The access
   *  token is encrypted at rest and never leaves this process. */
  shopifyConnections: ShopifyConnection[];
  /** Monerium issue-order ids already reflected in local receipt state. */
  processedMoneriumOrders: string[];
  /** Monerium webhook delivery ids already accepted. */
  processedMoneriumWebhooks: string[];
  /** Inbound crypto seen at a user's account, and what became of it. */
  cryptoDeposits: CryptoDeposit[];
  /** Append-only audit trail: segment decisions, consents, partner events. */
  audit: import("../audit.js").AuditEntry[];
  /** Managed KYC guardian recovery requests. */
  recoveryRequests: RecoveryRequest[];
  /**
   * Last block scanned for inbound crypto, per chain id.
   *
   * Kept as a string because JSON has no bigint. Per chain because
   * deployments.json is too: a testnet cursor must not be read as a local one
   * and skip every block on a fresh chain.
   */
  cryptoDepositCursor: Record<string, string>;

  // ── The organisation domain (docs/business-accounts.md) ───────────────────
  //
  // A User is only a login identity; the tenant that holds money is an
  // Organisation, and a user reaches one through a Member row. Users that
  // predate organisations are migrated into a personal org of one on first
  // start — see migrateUsersToOrganisations().
  organisations: Organisation[];
  members: Member[];
  accounts: Account[];
  importedWallets: ImportedWallet[];
  contacts: Contact[];
  drafts: DraftPayment[];
  invoices: Invoice[];
  chartAccounts: ChartAccount[];
  accountRules: AccountRule[];
  ledger: LedgerEntry[];
}

/**
 * Where the store lives. TRANSF_DB_PATH overrides it.
 *
 * Tests point this somewhere disposable because they reset the database on
 * every run. A test run on the live file once wiped a Safe owner key on Base
 * Sepolia and stranded the account (only the current authorizer may rotate),
 * so tests must not be able to reach the working database.
 */
const DB_PATH = process.env.TRANSF_DB_PATH
  ? path.resolve(process.env.TRANSF_DB_PATH)
  : path.join(ROOT, "data", "db.json");
const DATA_DIR = path.dirname(DB_PATH);

export let db: Db = {
  users: [],
  quotes: [],
  transfers: [],
  sessions: [],
  receiptShares: [],
  documents: [],
  paymentRequests: [],
  shopifyConnections: [],
  processedMoneriumOrders: [],
  processedMoneriumWebhooks: [],
  cryptoDeposits: [],
  audit: [],
  recoveryRequests: [],
  cryptoDepositCursor: {},
  organisations: [],
  members: [],
  accounts: [],
  importedWallets: [],
  contacts: [],
  drafts: [],
  invoices: [],
  chartAccounts: [],
  accountRules: [],
  ledger: [],
};

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
    db.sessions ??= [];
    db.receiptShares ??= [];
    db.documents ??= [];
    db.paymentRequests ??= [];
    db.shopifyConnections ??= [];
    db.processedMoneriumOrders ??= [];
    db.processedMoneriumWebhooks ??= [];
    db.cryptoDeposits ??= [];
    db.audit ??= [];
    db.recoveryRequests ??= [];
    db.cryptoDepositCursor ??= {};
    db.organisations ??= [];
    db.members ??= [];
    db.accounts ??= [];
    db.importedWallets ??= [];
    db.contacts ??= [];
    db.drafts ??= [];
    db.invoices ??= [];
    db.chartAccounts ??= [];
    db.accountRules ??= [];
    db.ledger ??= [];
    if (IS_PRODUCTION) {
      const custodial = db.users.filter((u) => (u.paymentPage as any)?.depositPrivateKey);
      if (custodial.length) {
        throw new Error(
          `production store contains ${custodial.length} account(s) with API-held payment-page key material; ` +
            "activate non-custodial payment pages before startup",
        );
      }
    }
    migrateUsersToOrganisations();
    stripSenderProfiles();
    for (const q of db.quotes) q.status ??= "OPEN";
    for (const s of db.sessions) s.expiresAt ??= new Date(Date.parse(s.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    pruneSessions();
    persist();
  } else {
    persist();
  }
}

/**
 * Drop sessions that can no longer authenticate anything. Kept forever, every
 * request would pay for them twice: a linear scan to find the live one, and a
 * full re-serialisation of the file on write.
 */
export function pruneSessions(retainMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - retainMs;
  db.sessions = db.sessions.filter((s) => {
    const dead = s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
    return !(Number.isFinite(dead) && dead < cutoff);
  });
}

/**
 * Give every user created before organisations existed a personal
 * organisation of one.
 *
 * Those users have a real IBAN and on-chain address (some on Base Sepolia
 * hold credited EUR), so the org's EUR account takes the user's `iban` and
 * `address` verbatim; never re-issue them. Its status is derived from the
 * user's funding state, so a user who never finished provisioning does not
 * get an account that claims to be open.
 *
 * Idempotent (keyed on a member row existing for the user), so it is safe on
 * every start, and it never touches a user who already has an org.
 */
/**
 * Delete stored Travel Rule sender profiles (Sep 2026).
 *
 * `user.senderProfile` held identity-document numbers, birth dates and home
 * addresses for the anchor leg of the cash rail — a rail no deployment has
 * ever opened. Keeping the most sensitive data in the system for a purpose
 * that cannot run fails data minimisation, so the field is gone from the
 * type and any row that still carries one (the Travel Rule harness wrote
 * some) is stripped on load. Originator data is collected per transfer when
 * an anchor is actually integrated; see adapters/moneygram.ts SenderDetails.
 */
function stripSenderProfiles() {
  let stripped = 0;
  for (const user of db.users as unknown as Array<Record<string, unknown>>) {
    if ("senderProfile" in user) {
      delete user.senderProfile;
      stripped++;
    }
  }
  if (stripped) console.log(`[store] removed stored sender profiles from ${stripped} user row(s)`);
}

function migrateUsersToOrganisations() {
  let migrated = 0;
  for (const user of db.users) {
    if (db.members.some((m) => m.userId === user.id)) continue;

    const now = user.createdAt ?? new Date().toISOString();
    const org: Organisation = {
      id: `org_${randomUUID()}`,
      type: "personal",
      name: user.name || "Personal",
      email: user.email,
      address: user.country ? { country: user.country.toUpperCase() } : undefined,
      plan: "starter",
      reporting: {
        currency: "EUR",
        timeZone: "Europe/Berlin",
        costBasisMethod: "FIFO",
      },
      // The user's KYC decision is an account-issuance verification and nothing
      // more. It is deliberately NOT copied onto fiat_payout or cards: those
      // are separate partners' decisions and we were never given them.
      verifications: {
        account_issuance: {
          capability: "account_issuance",
          status:
            user.kycStatus === "approved"
              ? "approved"
              : user.kycStatus === "rejected"
                ? "rejected"
                : user.kycStatus === "manual_review"
                  ? "in_review"
                  : "unverified",
          provider: user.kyc?.provider === "monerium" ? "monerium" : "manual",
          applicantId: user.kyc?.applicantId,
          decidedAt: user.kyc?.checkedAt,
          reason: user.kyc?.reason,
        },
      },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };
    db.organisations.push(org);

    db.members.push({
      id: `mem_${randomUUID()}`,
      orgId: org.id,
      userId: user.id,
      email: user.email ?? "",
      name: user.name,
      role: "owner",
      status: "active",
      invitedAt: now,
      acceptedAt: now,
    });

    // Carry the existing EUR account across rather than opening a new one.
    const funded = user.funding?.status === "active" && Boolean(user.iban);
    const initial = initialStatusFor("EUR");
    db.accounts.push({
      id: `acc_${randomUUID()}`,
      orgId: org.id,
      currency: "EUR",
      label: defaultLabel("EUR"),
      status: funded ? "active" : initial.status,
      provider: "monerium",
      identifier: user.iban ? { iban: user.iban } : {},
      address: user.address,
      // This account IS that user's Safe, so it is spendable by exactly the
      // person holding its device key — see Account.backingUserId.
      backingUserId: user.id,
      gate: funded ? undefined : initial.gate,
      detail: user.funding?.detail,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    });

    seedChartOfAccounts(org.id, now);
    migrated++;
  }
  if (migrated) {
    console.log(
      `[store] migrated ${migrated} user(s) into personal organisations ` +
        "(existing IBANs and addresses carried forward, not re-issued)",
    );
  }
}

/** The default chart and rules, so smart categorisation works on day one. */
export function seedChartOfAccounts(orgId: string, at = new Date().toISOString()) {
  if (db.chartAccounts.some((c) => c.orgId === orgId)) return;
  for (const a of DEFAULT_CHART) {
    db.chartAccounts.push({
      id: `coa_${randomUUID()}`,
      orgId,
      code: a.code,
      name: a.name,
      type: a.type,
      archived: false,
      createdAt: at,
    });
  }
  for (const r of DEFAULT_RULES) {
    db.accountRules.push({
      id: `rule_${randomUUID()}`,
      orgId,
      scope: "default",
      match: { txType: r.txType },
      direction: r.direction,
      accountCode: r.accountCode,
      createdAt: at,
    });
  }
}

export function persist() {
  const tmp = DB_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}
