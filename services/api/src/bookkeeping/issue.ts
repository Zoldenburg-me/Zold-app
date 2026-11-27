/**
 * Issuing a Beleg for a statement line: gather the records the line links
 * to, freeze the snapshot, sign it, store it under a verification code and
 * write the code back onto the line. One live Beleg per line: a second call
 * returns the existing document, and only replace revokes it for a new one.
 */
import { randomUUID } from "node:crypto";
import { CHAIN_ID } from "../config.js";
import type { Account, LedgerEntry, Organisation } from "../domain/types.js";
import { holderBlock, newDocumentCode, normaliseCode, signSnapshot, type HolderBlock, type StoredDocument } from "../documents.js";
import { store } from "../store.js";
import { personKey } from "../users/verified-name.js";
import { belegStillAgrees, buildBeleg, type BelegContext, type BelegSnapshot } from "./beleg.js";

/** The IBAN's owner is the Monerium profile, not the person holding the
 *  device key: a company account's Beleg names the company. The profile
 *  record may be from a still-pending profile, so the company name counts as
 *  verified only where it is the name Monerium already verified. */
export function holderFor(user: Parameters<typeof holderBlock>[0], profile: HolderBlock["moneriumProfile"]): HolderBlock {
  const base = holderBlock(user);
  if (!profile) return base;
  const company = profile.kind === "corporate" && profile.name ? profile.name : undefined;
  const verified = base.nameSource === "monerium" && (!company || personKey(company) === personKey(base.name));
  return {
    ...base,
    ...(company ? { name: company, nameSource: verified ? "monerium" : "self-declared" } : {}),
    moneriumProfile: { id: profile.id, kind: profile.kind, ...(profile.name ? { name: profile.name } : {}), checkedAt: profile.checkedAt },
  };
}

/**
 * A company account on its own Safe has no backing person: the company holds
 * the IBAN. Its name is Monerium's for the corporate profile recorded on the
 * account, else the org's legal name. Neither counts as verified here: the
 * account's profile record is from its last check, not a verification.
 */
export function companyHolder(org: Organisation, account: Account): HolderBlock {
  const profile = account.moneriumProfile;
  const name = (profile?.kind === "corporate" && profile.name) || org.legalName || org.name;
  return {
    name,
    nameSource: "self-declared",
    addressLines: org.address?.country ? [org.address.country.toUpperCase()] : [],
    ...(account.identifier.iban ? { iban: account.identifier.iban } : {}),
    safeAddress: account.address!,
    chainId: CHAIN_ID,
    accountSince: account.createdAt,
    ...(profile ? { moneriumProfile: { id: profile.id, kind: profile.kind, ...(profile.name ? { name: profile.name } : {}), checkedAt: profile.checkedAt } } : {}),
  };
}

/** Who a company document is filed under: its earliest active owner. */
async function companyFiler(orgId: string): Promise<string | undefined> {
  const owners = (await store.membersOf(orgId)).filter((m) => m.role === "owner" && m.status === "active" && m.userId);
  owners.sort((a, b) => (a.acceptedAt ?? a.invitedAt).localeCompare(b.acceptedAt ?? b.invitedAt));
  return owners[0]?.userId;
}

/** Whose account the line is on: the backing person, or for a company
 *  account on its own Safe, the company. */
async function holderOf(account: Account | undefined): Promise<{ userId: string; holder: HolderBlock }> {
  const user = account?.backingUserId ? (await store.findUser(account.backingUserId)) : undefined;
  if (user) return { userId: user.id, holder: holderFor(user, account?.moneriumProfile) };
  const org = account && !account.backingUserId && account.address ? (await store.findOrganisation(account.orgId)) : undefined;
  const filer = org ? await companyFiler(org.id) : undefined;
  if (!org || !filer) throw new Error("the line's account has no backing user or owning company, so there is no account holder to name");
  return { userId: filer, holder: companyHolder(org, account!) };
}

export async function belegContextFor(entry: LedgerEntry): Promise<BelegContext & { userId: string }> {
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  const account = entry.source.kind === "account" ? (await store.findAccount(entry.source.accountId)) : undefined;
  const { userId, holder } = await holderOf(account);
  const deposit = s.links.depositId ? (await store.list("cryptoDeposits")).find((d) => d.id === s.links.depositId) : undefined;
  const transfer = s.links.transferId ? (await store.findTransfer(s.links.transferId)) : undefined;
  const issueOrder = s.links.orderId && !transfer ? (await store.list("moneriumIssueOrders")).find((o) => o.orderId === s.links.orderId) : undefined;
  const sweep = s.event === "sweep" ? (await store.list("conversionSweeps")).find((x) => `sweep:${x.id}` === s.key) : undefined;
  const paymentRequest = s.links.paymentRequestId ? (await store.findPaymentRequest(s.links.paymentRequestId)) : undefined;
  const invoice = s.links.invoiceId ? (await store.findInvoice(s.links.invoiceId)) : undefined;
  // Whoever the invoice is with: its recipient if we issued it, its supplier if we pay it.
  const invoiceCounterpartyName = invoice?.issued?.recipient?.name ?? invoice?.supplier?.orgName;
  return {
    userId,
    holder,
    ...(deposit ? { deposit } : {}),
    ...(transfer ? { transfer } : {}),
    ...(issueOrder ? { issueOrder } : {}),
    ...(sweep ? { sweep } : {}),
    ...(paymentRequest ? { paymentRequest } : {}),
    ...(invoiceCounterpartyName ? { invoiceCounterpartyName } : {}),
  };
}

/** The records check of the verify page, /v/<code>: does the store still say
 *  what this Beleg says? The exports use the same check, so a Beleg that
 *  fails it there is not handed out here. */
export async function belegRecordsAgree(s: BelegSnapshot, line?: LedgerEntry): Promise<{ ok: boolean; detail: string }> {
  return belegStillAgrees(s, {
    entry: line?.id === s.line.lineId ? line : (await store.list("ledger")).find((e) => e.id === s.line.lineId),
    deposit: s.line.links.depositId ? (await store.list("cryptoDeposits")).find((d) => d.id === s.line.links.depositId) : undefined,
    transfer: s.line.links.transferId ? (await store.findTransfer(s.line.links.transferId)) : undefined,
    issueOrder: s.line.links.orderId ? (await store.list("moneriumIssueOrders")).find((o) => o.orderId === s.line.links.orderId) : undefined,
    sweep: s.sweep ? (await store.list("conversionSweeps")).find((x) => `sweep:${x.id}` === s.line.key) : undefined,
  });
}

type BelegDoc = StoredDocument & { snapshot: BelegSnapshot };

export type DocumentsByCode = ReadonlyMap<string, StoredDocument>;
/** Every document by code, for a listing to build once: belegOfLine on each
 *  line would otherwise scan every document. The first with a code wins, as
 *  in findDocumentByCode. */
export async function documentsByCode(): Promise<DocumentsByCode> {
  const byCode = new Map<string, StoredDocument>();
  for (const d of await store.list("documents")) if (!byCode.has(d.code)) byCode.set(d.code, d);
  return byCode;
}

/** The document a line's code names is that line's Beleg only if it is a
 *  Beleg of the line's org issued for this very line. A code is text on the
 *  row: a stale or corrupt one naming another org's or another line's
 *  document is no link at all, so the line has no Beleg and gets its own. */
function isBelegOf(doc: StoredDocument | undefined, e: LedgerEntry): doc is BelegDoc {
  return !!doc && doc.kind === "beleg" && doc.snapshot.kind === "beleg" && doc.orgId === e.orgId && doc.snapshot.line.lineId === e.id;
}

/** The line's Beleg as the books may hand it out. `live`: issued for this
 *  line, not revoked, and its records still agree. `stale`: not revoked, but
 *  it no longer agrees, so it is replaced, never shipped. A revoked one is
 *  neither, nor is one that is not the line's own (isBelegOf): the line has
 *  no Beleg until one is issued. */
export async function belegOfLine(
  e: LedgerEntry,
  docs?: DocumentsByCode,
): Promise<{ live: BelegDoc } | { stale: BelegDoc; detail: string } | undefined> {
  const code = e.statement?.documentCode;
  const doc = code ? (docs ? docs.get(code) : await store.findDocumentByCode(code)) : undefined;
  if (!isBelegOf(doc, e) || doc.revokedAt) return undefined;
  const d = { ...doc, snapshot: doc.snapshot };
  const agree = await belegRecordsAgree(d.snapshot, e);
  return agree.ok ? { live: d } : { stale: d, detail: agree.detail };
}

/** Replace refused: the line's Beleg still verifies, and revoking a true
 *  document someone may already hold would only make it fail. */
export class BelegStillVerifies extends Error {}

/** Replace refused: a Beleg issued from the books as they are now would fail
 *  the same check (a payout Monerium rejected, say), so the old one stays as
 *  it is and nothing is issued. */
export class BelegWouldNotVerify extends Error {}

/** Issue refused: the line's link is unusable and more than one live Beleg
 *  of its own exists, so which one the line had is not known. Nothing is
 *  relinked or signed; the store needs a look. */
export class BelegAmbiguous extends Error {}

/** One issue per line at a time: two sends at once must not both find no
 *  Beleg, sign two, and leave the line pointing at the second. */
const issuing = new Map<string, Promise<unknown>>();

export function issueBelegForLine(entry: LedgerEntry): Promise<{ doc: StoredDocument; issued: boolean }> {
  return queued(entry, () => issueOnce(entry));
}

/** Revoke the line's Beleg that no longer verifies and issue one from the
 *  books as they are now. The new one is signed and checked first: only if
 *  it verifies is the old one revoked, in the same step the line takes the
 *  new code. The revoked one keeps its frozen snapshot and fails
 *  verification at its code. One that still verifies is refused
 *  (BelegStillVerifies), as is a replacement that would fail too
 *  (BelegWouldNotVerify); with no live Beleg this just issues. */
export function replaceBelegForLine(entry: LedgerEntry): Promise<{ doc: StoredDocument; issued: boolean; revoked?: StoredDocument }> {
  return queued(entry, async () => {
    const now = await restoreOwnLink((await store.ledgerOf(entry.orgId)).find((e) => e.id === entry.id) ?? entry);
    const current = await belegOfLine(now);
    if (!current) return issueOnce(now);
    if ("live" in current) throw new BelegStillVerifies("this Beleg still matches the books");
    const doc = await draft(now);
    const agree = await belegRecordsAgree(doc.snapshot as BelegSnapshot, now);
    if (!agree.ok) throw new BelegWouldNotVerify(agree.detail);
    await store.tx(async () => {
      await store.updateDocument(current.stale.id, { revokedAt: new Date().toISOString() });
      await commit(now, doc);
    });
    return { doc, issued: true, revoked: current.stale };
  });
}

/** Every Beleg a line has had, revoked ones included: what was sent to a
 *  partner under an earlier code is found again by it. Server-side only; a
 *  code is a credential. */
export async function belegeOfLine(orgId: string, lineId: string): Promise<StoredDocument[]> {
  return (await store.documentsForOrg(orgId)).filter((d) => d.snapshot.kind === "beleg" && d.snapshot.line.lineId === lineId);
}

function queued<T extends { doc: StoredDocument; issued: boolean }>(entry: LedgerEntry, fn: () => Promise<T>): Promise<T> {
  const before = issuing.get(entry.id) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  issuing.set(entry.id, run);
  void run.finally(() => { if (issuing.get(entry.id) === run) issuing.delete(entry.id); }).catch(() => undefined);
  return run;
}

async function issueOnce(given: LedgerEntry): Promise<{ doc: StoredDocument; issued: boolean }> {
  // The row as it is now: the caller's copy may predate a Beleg just issued.
  const entry = await restoreOwnLink((await store.ledgerOf(given.orgId)).find((e) => e.id === given.id) ?? given);
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  if (s.documentCode) {
    const existing = await store.findDocumentByCode(s.documentCode);
    if (isBelegOf(existing, entry) && !existing.revokedAt) return { doc: existing, issued: false };
  }
  const doc = await draft(entry);
  await commit(entry, doc);
  return { doc, issued: true };
}

/** A line whose code names no live Beleg of its own gets its link back to
 *  the one it has, if it has exactly one: signing a second would leave two
 *  that both verify for one bank line. Two or more is refused, not guessed.
 *  Called inside the line's queue. Returns the row as it is now. */
async function restoreOwnLink(given: LedgerEntry): Promise<LedgerEntry> {
  return store.tx(async () => {
    // Under the org's ledger lock, as commit writes: the row is read again
    // here, so a writer's update in between is not overwritten.
    await store.lockKey(`ledger:${given.orgId}`);
    const entry = (await store.ledgerOf(given.orgId)).find((e) => e.id === given.id) ?? given;
    const s = entry.statement;
    if (!s) return entry;
    const linked = s.documentCode ? await store.findDocumentByCode(s.documentCode) : undefined;
    if (isBelegOf(linked, entry) && !linked.revokedAt) return entry;
    const own = (await store.documentsForOrg(entry.orgId)).filter((d) => isBelegOf(d, entry) && !d.revokedAt);
    if (own.length > 1) throw new BelegAmbiguous(`this line has ${own.length} live receipts, more than one, so none is relinked or issued`);
    if (!own.length) return entry;
    await store.updateLedgerEntry(entry.id, { statement: { ...s, documentCode: own[0].code } });
    return (await store.ledgerOf(entry.orgId)).find((e) => e.id === entry.id) ?? entry;
  });
}

/** The Beleg for the line as the books are now, signed, not yet stored. */
async function draft(entry: LedgerEntry): Promise<StoredDocument> {
  const ctx = await belegContextFor(entry);
  const snapshot: BelegSnapshot = buildBeleg(entry, ctx);
  const code = newDocumentCode();
  return {
    id: randomUUID(),
    code: normaliseCode(code),
    kind: "beleg",
    userId: ctx.userId,
    orgId: entry.orgId,
    createdAt: new Date().toISOString(),
    snapshot,
    attestations: { zold: await signSnapshot(snapshot, code) },
  };
}

async function commit(entry: LedgerEntry, doc: StoredDocument): Promise<void> {
  return store.tx(async () => {
    // Re-read after the signing await, under the org's ledger lock: the
    // writer may have updated the row.
    await store.lockKey(`ledger:${entry.orgId}`);
    const s = ((await store.ledgerOf(entry.orgId)).find((e) => e.id === entry.id) ?? entry).statement!;
    await store.addDocument(doc);
    await store.updateLedgerEntry(entry.id, { statement: { ...s, documentCode: doc.code } });
  });
}
