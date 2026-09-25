/**
 * The store: every read and write of persisted state goes through here.
 *
 * Nothing outside this file touches the database object, so the JSON file
 * behind it can be replaced in one place. Every write persists before it
 * returns, so a crash cannot leave a change only in memory.
 *
 * Nothing deletes: there is no method to remove an organisation, account,
 * invoice or ledger row. Plan gating is a read-time filter. A downgraded org
 * keeps its chart of accounts, tags and history and the API just does not serve
 * them, which holds only while no delete path exists. Don't add one.
 *
 * The row shapes are in ./store/types.ts and the file-backed database in
 * ./store/db.ts; both are re-exported here.
 */
import { randomUUID } from "node:crypto";
import { db, persist, pruneSessions, seedChartOfAccounts } from "./store/db.js";
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
} from "./domain/types.js";
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
} from "./store/types.js";

export * from "./store/types.js";
export { initStore } from "./store/db.js";

/** Daily-cap holds for transfers being prepared — see store.holdDailyCap. */
const capHolds = new Map<string, { userId: string; eur: number; day: string }>();

export const store = {
  get users() {
    return db.users;
  },
  get quotes() {
    return db.quotes;
  },
  get transfers() {
    return db.transfers;
  },
  get sessions() {
    return db.sessions;
  },
  get recoveryRequests() {
    return db.recoveryRequests;
  },
  addUser(u: User) {
    db.users.push(u);
    persist();
  },
  updateUser(id: string, patch: Partial<User>) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    Object.assign(u, patch);
    persist();
    return u;
  },
  /**
   * Append one audit entry. There is deliberately no update and no delete —
   * a log a process can edit proves nothing.
   */
  audit(entry: import("./audit.js").AuditEntry) {
    db.audit.push(entry);
    persist();
  },
  auditFor(userId?: string, limit = 200) {
    const rows = userId ? db.audit.filter((r) => r.userId === userId) : db.audit;
    return rows.slice(-limit).reverse();
  },
  /**
   * Set the segment. The only writer. Once a segment is decided only an admin
   * action can change it, so a second signup-path call cannot re-segment an
   * existing account.
   */
  setSegment(
    id: string,
    segment: NonNullable<User["segment"]>,
    by: "system" | "admin" = "system",
  ) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    if (u.segment && by !== "admin") {
      throw new Error(
        `user ${id} already has segment ${u.segment.value}; only an admin action may change it`,
      );
    }
    u.segment = { ...segment, decidedBy: by };
    persist();
    return u;
  },
  /** Append-only: consents and US answers are never overwritten. */
  addConsent(id: string, consent: NonNullable<User["consents"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.consents ??= []).push(consent);
    persist();
    return u;
  },
  addUsAnswers(id: string, answers: NonNullable<User["usPersonAnswers"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.usPersonAnswers ??= []).push(answers);
    persist();
    return u;
  },
  addRecoveryRequest(r: RecoveryRequest) {
    db.recoveryRequests.push(r);
    persist();
  },
  updateRecoveryRequest(id: string, patch: Partial<RecoveryRequest>) {
    const r = db.recoveryRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown recovery request ${id}`);
    Object.assign(r, patch);
    persist();
    return r;
  },
  findRecoveryRequest(id: string) {
    return db.recoveryRequests.find((r) => r.id === id);
  },
  recoveryRequestsForUser(userId: string) {
    return db.recoveryRequests.filter((r) => r.userId === userId);
  },
  findUserByAddress(address: string) {
    return db.users.find((u) => u.address.toLowerCase() === address.toLowerCase());
  },
  findUserByCredential(credentialId: string) {
    return db.users.find((u) => u.passkey?.credentialId === credentialId);
  },
  /** Every account carrying this email, case-insensitively. Signup uses it to
   *  refuse a second account on an address that already has a passkey; rows
   *  without one are onboarding that stopped before a credential existed and
   *  may be started over. */
  usersByEmail(email: string) {
    const needle = email.trim().toLowerCase();
    if (!needle) return [];
    return db.users.filter((u) => (u.email ?? "").trim().toLowerCase() === needle);
  },
  /** Case-insensitive email match. Prefers an account that can actually be
   *  recovered when the same address was used more than once. */
  findUserByEmail(email: string) {
    const matches = store.usersByEmail(email);
    return (
      matches.find((u) => u.passkeySafe?.candideRecovery?.guardianStatus === "active") ??
      matches.find((u) => u.passkeySafe?.status === "active") ??
      matches[0]
    );
  },
  findUserBySafeAddress(address: string) {
    const needle = address.trim().toLowerCase();
    return db.users.find(
      (u) => u.address?.toLowerCase() === needle || u.passkeySafe?.address?.toLowerCase() === needle,
    );
  },
  /** Every Monerium order id we have reflected in local receipt state. */
  mirroredOrderIds(): string[] {
    return [...db.processedMoneriumOrders];
  },
  isOrderProcessed(orderId: string) {
    return db.processedMoneriumOrders.includes(orderId);
  },
  markOrderProcessed(orderId: string) {
    db.processedMoneriumOrders.push(orderId);
    persist();
  },
  isWebhookProcessed(webhookId: string) {
    return db.processedMoneriumWebhooks.includes(webhookId);
  },
  markWebhookProcessed(webhookId: string) {
    db.processedMoneriumWebhooks.push(webhookId);
    persist();
  },
  addQuote(q: Quote) {
    db.quotes.push(q);
    persist();
  },
  updateQuote(id: string, patch: Partial<Quote>) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    Object.assign(q, patch);
    persist();
    return q;
  },
  consumeQuote(id: string) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if ((q.status ?? "OPEN") !== "OPEN") return false;
    q.status = "CONSUMED";
    persist();
    return true;
  },
  addTransfer(t: Transfer) {
    db.transfers.push(t);
    persist();
  },
  /**
   * Hold part of the daily cap for a transfer that is still being prepared.
   *
   * Checking the cap in buildTransferFromQuote and writing the reserving row
   * several awaits later let two parallel requests each create a full-cap
   * transfer. Checking again at the write refuses too late: on the cash rail,
   * after a live Bridge transfer exists, leaving it unfunded. A hold taken
   * before any partner is called refuses the second request while nothing
   * outside this process has been touched, and counts the first from the
   * moment it starts preparing.
   *
   * Same idiom as claimAuthorization: nothing yields between the read and the
   * write. `used` is a function so it is recomputed inside that window, and it
   * must include `heldEurToday` (safeFundedEurToday does). Holds live in
   * memory like pendingTransferExecutions: a restart drops them along with the
   * requests that took them.
   */
  holdDailyCap(
    userId: string,
    eur: number,
    capEur: number,
    used: () => number,
  ): { ok: true; holdId: string } | { ok: false; usedEur: number; capEur: number } {
    const usedEur = used();
    if (usedEur + eur > capEur) return { ok: false, usedEur, capEur };
    const holdId = randomUUID();
    capHolds.set(holdId, { userId, eur, day: new Date().toISOString().slice(0, 10) });
    return { ok: true, holdId };
  },
  /** Euros held for transfers still being prepared, for one user and UTC day. */
  heldEurToday(userId: string, day = new Date().toISOString().slice(0, 10)): number {
    let sum = 0;
    for (const h of capHolds.values()) if (h.userId === userId && h.day === day) sum += h.eur;
    return sum;
  },
  /**
   * Turn a hold into the transfer row that replaces it. Push and release
   * happen together so the amount is never uncounted in between.
   */
  addTransferUnderHold(t: Transfer, holdId: string) {
    if (!capHolds.delete(holdId)) throw new Error(`no cap hold ${holdId} — the transfer was not reserved`);
    db.transfers.push(t);
    persist();
  },
  /** Drop a hold whose transfer was refused or failed. A no-op once committed. */
  releaseCapHold(holdId: string) {
    capHolds.delete(holdId);
  },
  /**
   * Claim the one and only authorization submission for a transfer.
   *
   * Deliberately synchronous: an Express handler runs uninterrupted until its
   * first `await`, so claiming here — before any chain call — is what makes two
   * concurrent submissions of the same device signature impossible. Without it
   * both passed the `state === "CREATED"` check and both could have submitted
   * the same Safe spend. One claim must win before any chain call starts.
   *
   * Returns false when the transfer is not awaiting authorization, has no terms,
   * or has already been claimed.
   */
  claimAuthorization(id: string) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t || t.state !== "CREATED" || !t.auth || t.auth.authorizedAt) return false;
    const now = new Date().toISOString();
    t.auth.authorizedAt = now;
    t.updatedAt = now;
    persist();
    return true;
  },
  updateTransfer(id: string, patch: Partial<Transfer>) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    // REFUNDED and PAID are final. A slow live leg finishing after the sweep
    // refunded the transfer must not move it back and complete a payout the
    // sender was already repaid for; the late write keeps its other fields.
    if ((t.state === "REFUNDED" || t.state === "PAID") && patch.state && patch.state !== t.state) {
      console.error(`store: refusing to move transfer ${id} from ${t.state} to ${patch.state}`);
      patch = { ...patch, state: undefined };
    }
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    persist();
    return t;
  },
  /**
   * One share per transfer, deliberately.
   *
   * Re-sharing a transfer edits the existing record instead of minting a second
   * slug, so tightening a selection actually tightens what is public. Two live
   * links to one transfer would mean the generous first link kept working after
   * the sender thought they had narrowed it.
   */
  findReceiptShareByTransfer(transferId: string) {
    const shares = db.receiptShares.filter((s) => s.transferId === transferId);
    return shares.find((s) => !s.revokedAt) ?? shares.at(-1);
  },
  findReceiptShareBySlug(slug: string) {
    return db.receiptShares.find((s) => s.slug === slug);
  },
  get documents() {
    return db.documents;
  },
  addDocument(d: StoredDocument) {
    db.documents.push(d);
    persist();
    return d;
  },
  updateDocument(id: string, patch: Partial<StoredDocument>) {
    const d = db.documents.find((x) => x.id === id);
    if (!d) throw new Error(`unknown document ${id}`);
    Object.assign(d, patch);
    persist();
    return d;
  },
  findDocumentByCode(code: string) {
    return db.documents.find((d) => d.code === code);
  },
  documentsForUser(userId: string) {
    return db.documents.filter((d) => d.userId === userId);
  },

  // ── Payment requests (pay links) ──────────────────────────────────────────
  //
  // No delete. A request somebody may have paid against is a record; the
  // owner cancels it (state CANCELLED) and a visitor is told so rather than
  // getting a 404 that reads like a typo.
  get paymentRequests() {
    return db.paymentRequests;
  },
  addPaymentRequest(r: PaymentRequest) {
    db.paymentRequests.push(r);
    persist();
    return r;
  },
  updatePaymentRequest(id: string, patch: Partial<PaymentRequest>) {
    const r = db.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown payment request ${id}`);
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    persist();
    return r;
  },
  findPaymentRequest(id: string) {
    return db.paymentRequests.find((r) => r.id === id);
  },
  /** Codes are stored normalised (upper-case, no hyphens); compare the same way. */
  findPaymentRequestByCode(code: string) {
    const norm = code.replace(/-/g, "").toUpperCase();
    return db.paymentRequests.find((r) => r.code === norm);
  },
  paymentRequestsForUser(userId: string) {
    return db.paymentRequests.filter((r) => r.userId === userId);
  },
  /** Shopify order and session ids are per-store sequences, so the shop is
   *  part of the key: without it one connected store's webhook finds, and can
   *  cancel or dedupe against, another store's request. */
  findPaymentRequestBySource(kind: string, externalId: string, shop: string) {
    return db.paymentRequests.find(
      (r) => r.source?.kind === kind && r.source.externalId === externalId && r.source.shop === shop,
    );
  },

  // ── Shopify connections ───────────────────────────────────────────────────
  get shopifyConnections() {
    return db.shopifyConnections;
  },
  addShopifyConnection(c: ShopifyConnection) {
    db.shopifyConnections.push(c);
    persist();
    return c;
  },
  updateShopifyConnection(id: string, patch: Partial<ShopifyConnection>) {
    const c = db.shopifyConnections.find((x) => x.id === id);
    if (!c) throw new Error(`unknown Shopify connection ${id}`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    persist();
    return c;
  },
  removeShopifyConnection(id: string) {
    const i = db.shopifyConnections.findIndex((x) => x.id === id);
    if (i >= 0) db.shopifyConnections.splice(i, 1);
    persist();
  },
  findShopifyConnectionByShop(shop: string) {
    const s = shop.trim().toLowerCase();
    return db.shopifyConnections.find((c) => c.shop === s);
  },
  shopifyConnectionsForOrg(orgId: string) {
    return db.shopifyConnections.filter((c) => c.orgId === orgId);
  },
  addReceiptShare(s: ReceiptShare) {
    db.receiptShares.push(s);
    persist();
  },
  updateReceiptShare(id: string, patch: Partial<ReceiptShare>) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    persist();
    return s;
  },
  revokeReceiptShare(id: string) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    s.revokedAt = new Date().toISOString();
    s.updatedAt = s.revokedAt;
    persist();
    return s;
  },
  addSession(s: Session) {
    pruneSessions();
    db.sessions.push(s);
    persist();
  },
  findSessionByTokenHash(tokenHash: string) {
    return db.sessions.find((s) => s.tokenHash === tokenHash);
  },
  revokeSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.revokedAt = new Date().toISOString();
    persist();
    return s;
  },
  touchSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    // lastUsedAt is telemetry, not a security control. Writing it on every
    // authenticated request re-serialised the entire store per call, which grows
    // with the number of users and transfers — a self-amplifying cost. Minute
    // granularity is enough to see an idle session.
    const now = Date.now();
    if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
    s.lastUsedAt = new Date(now).toISOString();
    persist();
    return s;
  },
  /** Handles are compared case-insensitively; they are stored lowercase. */
  findUserByHandle(handle: string) {
    const h = handle.trim().toLowerCase();
    return db.users.find((u) => u.paymentPage?.handle === h);
  },
  findUser(id: string) {
    return db.users.find((u) => u.id === id);
  },
  findUserByIban(iban: string) {
    const norm = iban.replace(/\s/g, "").toUpperCase();
    return db.users.find((u) => u.iban.replace(/\s/g, "").toUpperCase() === norm);
  },
  findQuote(id: string) {
    return db.quotes.find((q) => q.id === id);
  },
  findTransfer(id: string) {
    return db.transfers.find((t) => t.id === id);
  },

  get cryptoDeposits() {
    return db.cryptoDeposits;
  },
  /** An ERC-20 transfer is identified by its tx and position in it. */
  findCryptoDeposit(txHash: string, logIndex: number) {
    return db.cryptoDeposits.find(
      (d) => d.txHash.toLowerCase() === txHash.toLowerCase() && d.logIndex === logIndex,
    );
  },
  /**
   * Record a deposit, once.
   *
   * Idempotent on (txHash, logIndex) — the chain's own identity for a
   * transfer — because the poller's dedupe check and this write are separated
   * by an await (the receipt's rate lookup), and the poll runs on a bare
   * setInterval that does not wait for the previous tick. Two overlapping
   * scans of one window both passed the check and both pushed, double-counting
   * one payment: twice on the payee's payment link, twice in creditedUsdc.
   * Returning the existing row makes the loser of that race a no-op.
   */
  addCryptoDeposit(d: CryptoDeposit) {
    const existing = db.cryptoDeposits.find(
      (x) => x.txHash.toLowerCase() === d.txHash.toLowerCase() && x.logIndex === d.logIndex,
    );
    if (existing) return existing;
    db.cryptoDeposits.push(d);
    persist();
    return d;
  },
  updateCryptoDeposit(id: string, patch: Partial<CryptoDeposit>) {
    const d = db.cryptoDeposits.find((x) => x.id === id);
    if (!d) throw new Error(`unknown crypto deposit ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  cryptoDepositCursor(chainId: number | string): bigint | undefined {
    const v = db.cryptoDepositCursor[String(chainId)];
    return v === undefined ? undefined : BigInt(v);
  },
  setCryptoDepositCursor(chainId: number | string, block: bigint) {
    db.cryptoDepositCursor[String(chainId)] = block.toString();
    persist();
  },

  // ── Organisation domain ───────────────────────────────────────────────────
  //
  // Reads return live rows; every write goes through here so a single atomic
  // persist covers the whole file. Deliberately NO delete for organisations,
  // accounts, invoices or ledger entries: plan downgrades and archival must not
  // be reachable by a code path that removes rows (see plans.ts rule 1).

  get organisations() {
    return db.organisations;
  },
  get members() {
    return db.members;
  },
  get accounts() {
    return db.accounts;
  },
  get contacts() {
    return db.contacts;
  },
  get drafts() {
    return db.drafts;
  },
  get invoices() {
    return db.invoices;
  },
  get importedWallets() {
    return db.importedWallets;
  },
  get chartAccounts() {
    return db.chartAccounts;
  },
  get accountRules() {
    return db.accountRules;
  },
  get ledger() {
    return db.ledger;
  },

  addOrganisation(org: Organisation, seedCoa = true) {
    db.organisations.push(org);
    if (seedCoa) seedChartOfAccounts(org.id, org.createdAt);
    persist();
    return org;
  },
  findOrganisation(id: string) {
    return db.organisations.find((o) => o.id === id);
  },
  updateOrganisation(id: string, patch: Partial<Organisation>) {
    const o = db.organisations.find((x) => x.id === id);
    if (!o) throw new Error(`unknown organisation ${id}`);
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    persist();
    return o;
  },
  /** Every org a user can reach, with the membership that grants it. */
  organisationsForUser(userId: string) {
    return db.members
      .filter((m) => m.userId === userId && m.status === "active")
      .map((m) => ({ member: m, org: db.organisations.find((o) => o.id === m.orgId) }))
      .filter((x): x is { member: Member; org: Organisation } => Boolean(x.org));
  },

  addMember(m: Member) {
    db.members.push(m);
    persist();
    return m;
  },
  findMember(id: string) {
    return db.members.find((m) => m.id === id);
  },
  /** The membership joining this user to this org, active or not. */
  /** A re-invited person can carry a deactivated row beside a live one; the
   *  live one is the membership. */
  memberFor(orgId: string, userId: string) {
    const rows = db.members.filter((m) => m.orgId === orgId && m.userId === userId);
    return rows.find((m) => m.status !== "deactivated") ?? rows[0];
  },
  findMemberByInviteHash(tokenHash: string) {
    return db.members.find((m) => m.invite?.tokenHash === tokenHash);
  },
  membersOf(orgId: string) {
    return db.members.filter((m) => m.orgId === orgId);
  },
  updateMember(id: string, patch: Partial<Member>) {
    const m = db.members.find((x) => x.id === id);
    if (!m) throw new Error(`unknown member ${id}`);
    Object.assign(m, patch);
    persist();
    return m;
  },

  addAccount(a: Account) {
    db.accounts.push(a);
    persist();
    return a;
  },
  findAccount(id: string) {
    return db.accounts.find((a) => a.id === id);
  },
  accountsOf(orgId: string) {
    return db.accounts.filter((a) => a.orgId === orgId);
  },
  updateAccount(id: string, patch: Partial<Account>) {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    persist();
    return a;
  },

  addContact(c: Contact) {
    db.contacts.push(c);
    persist();
    return c;
  },
  findContact(id: string) {
    return db.contacts.find((c) => c.id === id);
  },
  contactsOf(orgId: string) {
    return db.contacts.filter((c) => c.orgId === orgId);
  },
  updateContact(id: string, patch: Partial<Contact>) {
    const c = db.contacts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown contact ${id}`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    persist();
    return c;
  },
  removeContact(id: string) {
    const before = db.contacts.length;
    db.contacts = db.contacts.filter((c) => c.id !== id);
    persist();
    return db.contacts.length < before;
  },

  addDraft(d: DraftPayment) {
    db.drafts.push(d);
    persist();
    return d;
  },
  findDraft(id: string) {
    return db.drafts.find((d) => d.id === id);
  },
  draftsOf(orgId: string) {
    return db.drafts.filter((d) => d.orgId === orgId);
  },
  updateDraft(id: string, patch: Partial<DraftPayment>) {
    const d = db.drafts.find((x) => x.id === id);
    if (!d) throw new Error(`unknown draft ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  /**
   * Claim a draft for execution, synchronously.
   *
   * Same shape as claimAuthorization above and for the same reason: everything
   * from the state check to the write happens with no await between, so two
   * parallel submissions of one draft cannot both pass. Returns null when
   * somebody else already claimed it.
   *
   * `from` is the set of states this caller may claim out of: ["REVIEWED"] for
   * an org with approvals, ["DRAFT"] for one without. Passed in rather than
   * hardcoded so the plan decides, but still checked here — inside the same
   * synchronous window as the write.
   */
  claimDraftExecution(id: string, from: DraftPayment["state"][] = ["REVIEWED"]): DraftPayment | null {
    const d = db.drafts.find((x) => x.id === id);
    if (!d || !from.includes(d.state)) return null;
    d.state = "EXECUTING";
    d.updatedAt = new Date().toISOString();
    persist();
    return d;
  },

  addInvoice(i: Invoice) {
    db.invoices.push(i);
    persist();
    return i;
  },
  findInvoice(id: string) {
    return db.invoices.find((i) => i.id === id);
  },
  findInvoiceByLinkHash(hash: string) {
    return db.invoices.find((i) => i.linkTokenHash === hash);
  },
  invoicesOf(orgId: string) {
    return db.invoices.filter((i) => i.orgId === orgId);
  },
  updateInvoice(id: string, patch: Partial<Invoice>) {
    const i = db.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    Object.assign(i, patch, { updatedAt: new Date().toISOString() });
    persist();
    return i;
  },

  addImportedWallet(w: ImportedWallet) {
    db.importedWallets.push(w);
    persist();
    return w;
  },
  findImportedWallet(id: string) {
    return db.importedWallets.find((w) => w.id === id);
  },
  importedWalletsOf(orgId: string) {
    return db.importedWallets.filter((w) => w.orgId === orgId);
  },
  updateImportedWallet(id: string, patch: Partial<ImportedWallet>) {
    const w = db.importedWallets.find((x) => x.id === id);
    if (!w) throw new Error(`unknown imported wallet ${id}`);
    Object.assign(w, patch);
    persist();
    return w;
  },
  removeImportedWallet(id: string) {
    const before = db.importedWallets.length;
    db.importedWallets = db.importedWallets.filter((w) => w.id !== id);
    persist();
    return db.importedWallets.length < before;
  },

  chartOf(orgId: string) {
    return db.chartAccounts.filter((c) => c.orgId === orgId);
  },
  addChartAccount(c: ChartAccount) {
    db.chartAccounts.push(c);
    persist();
    return c;
  },
  updateChartAccount(id: string, patch: Partial<ChartAccount>) {
    const c = db.chartAccounts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown chart account ${id}`);
    Object.assign(c, patch);
    persist();
    return c;
  },
  rulesOf(orgId: string) {
    return db.accountRules.filter((r) => r.orgId === orgId);
  },
  addAccountRule(r: AccountRule) {
    db.accountRules.push(r);
    persist();
    return r;
  },
  removeAccountRule(id: string) {
    const before = db.accountRules.length;
    db.accountRules = db.accountRules.filter((r) => r.id !== id);
    persist();
    return db.accountRules.length < before;
  },
  seedChartOfAccounts(orgId: string) {
    seedChartOfAccounts(orgId);
    persist();
  },

  ledgerOf(orgId: string) {
    return db.ledger.filter((e) => e.orgId === orgId);
  },
  addLedgerEntries(entries: LedgerEntry[]) {
    db.ledger.push(...entries);
    persist();
    return entries;
  },
  updateLedgerEntry(id: string, patch: Partial<LedgerEntry>) {
    const e = db.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`unknown ledger entry ${id}`);
    Object.assign(e, patch);
    persist();
    return e;
  },
  /** Bulk replace after a rule run. Takes whole rows so one persist covers it. */
  replaceLedgerEntries(entries: LedgerEntry[]) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    db.ledger = db.ledger.map((e) => byId.get(e.id) ?? e);
    persist();
  },
};
