/**
 * Issuing a Beleg for a statement line: gather the records the line links
 * to, freeze the snapshot, sign it, store it under a verification code and
 * write the code back onto the line. One live Beleg per line: a second call
 * returns the existing document, and only replace revokes it for a new one.
 */
import { randomUUID } from "node:crypto";
import type { LedgerEntry } from "../domain/types.js";
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

export function belegContextFor(entry: LedgerEntry): BelegContext & { userId: string } {
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  const account = entry.source.kind === "account" ? store.findAccount(entry.source.accountId) : undefined;
  const user = account?.backingUserId ? store.findUser(account.backingUserId) : undefined;
  if (!user) throw new Error("the line's account has no backing user, so there is no account holder to name");
  const deposit = s.links.depositId ? store.cryptoDeposits.find((d) => d.id === s.links.depositId) : undefined;
  const transfer = s.links.transferId ? store.findTransfer(s.links.transferId) : undefined;
  const issueOrder = s.links.orderId && !transfer ? store.moneriumIssueOrders.find((o) => o.orderId === s.links.orderId) : undefined;
  const sweep = s.event === "sweep" ? store.conversionSweeps.find((x) => `sweep:${x.id}` === s.key) : undefined;
  const paymentRequest = s.links.paymentRequestId ? store.findPaymentRequest(s.links.paymentRequestId) : undefined;
  const invoice = s.links.invoiceId ? store.findInvoice(s.links.invoiceId) : undefined;
  const invoicePayerName = invoice?.issued?.recipient?.name ?? invoice?.supplier?.orgName;
  return {
    userId: user.id,
    holder: holderFor(user, account?.moneriumProfile),
    ...(deposit ? { deposit } : {}),
    ...(transfer ? { transfer } : {}),
    ...(issueOrder ? { issueOrder } : {}),
    ...(sweep ? { sweep } : {}),
    ...(paymentRequest ? { paymentRequest } : {}),
    ...(invoicePayerName ? { invoicePayerName } : {}),
  };
}

/** The records check of the verify page, /v/<code>: does the store still say
 *  what this Beleg says? The exports use the same check, so a Beleg that
 *  fails it there is not handed out here. */
export function belegRecordsAgree(s: BelegSnapshot, line?: LedgerEntry): { ok: boolean; detail: string } {
  return belegStillAgrees(s, {
    entry: line?.id === s.line.lineId ? line : store.ledger.find((e) => e.id === s.line.lineId),
    deposit: s.line.links.depositId ? store.cryptoDeposits.find((d) => d.id === s.line.links.depositId) : undefined,
    transfer: s.line.links.transferId ? store.findTransfer(s.line.links.transferId) : undefined,
    issueOrder: s.line.links.orderId ? store.moneriumIssueOrders.find((o) => o.orderId === s.line.links.orderId) : undefined,
    sweep: s.sweep ? store.conversionSweeps.find((x) => `sweep:${x.id}` === s.line.key) : undefined,
  });
}

type BelegDoc = StoredDocument & { snapshot: BelegSnapshot };

/** The line's Beleg as the books may hand it out. `live`: issued, a Beleg,
 *  not revoked, and its records still agree. `stale`: not revoked, but it no
 *  longer agrees, so it is replaced, never shipped. A revoked one is neither:
 *  the line has no Beleg until one is issued. */
export function belegOfLine(e: LedgerEntry): { live: BelegDoc } | { stale: BelegDoc; detail: string } | undefined {
  const code = e.statement?.documentCode;
  const doc = code ? store.findDocumentByCode(code) : undefined;
  if (!doc || doc.snapshot.kind !== "beleg" || doc.revokedAt) return undefined;
  const d = { ...doc, snapshot: doc.snapshot };
  const agree = belegRecordsAgree(d.snapshot, e);
  return agree.ok ? { live: d } : { stale: d, detail: agree.detail };
}

/** Replace refused: the line's Beleg still verifies, and revoking a true
 *  document someone may already hold would only make it fail. */
export class BelegStillVerifies extends Error {}

/** Replace refused: a Beleg issued from the books as they are now would fail
 *  the same check (a payout Monerium rejected, say), so the old one stays as
 *  it is and nothing is issued. */
export class BelegWouldNotVerify extends Error {}

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
    const now = store.ledgerOf(entry.orgId).find((e) => e.id === entry.id) ?? entry;
    const current = belegOfLine(now);
    if (!current) return issueOnce(now);
    if ("live" in current) throw new BelegStillVerifies("this Beleg still matches the books");
    const doc = await draft(now);
    const agree = belegRecordsAgree(doc.snapshot as BelegSnapshot, now);
    if (!agree.ok) throw new BelegWouldNotVerify(agree.detail);
    store.updateDocument(current.stale.id, { revokedAt: new Date().toISOString() });
    commit(now, doc);
    return { doc, issued: true, revoked: current.stale };
  });
}

/** Every code a line's Belege have had, revoked ones included: what was
 *  sent to a partner under an earlier code is found again by it. Server-side
 *  only; a code is a credential. */
export function belegCodesOfLine(orgId: string, lineId: string): string[] {
  return store.documentsForOrg(orgId).filter((d) => d.snapshot.kind === "beleg" && d.snapshot.line.lineId === lineId).map((d) => d.code);
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
  const entry = store.ledgerOf(given.orgId).find((e) => e.id === given.id) ?? given;
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  if (s.documentCode) {
    const existing = store.findDocumentByCode(s.documentCode);
    if (existing && !existing.revokedAt) return { doc: existing, issued: false };
  }
  const doc = await draft(entry);
  commit(entry, doc);
  return { doc, issued: true };
}

/** The Beleg for the line as the books are now, signed, not yet stored. */
async function draft(entry: LedgerEntry): Promise<StoredDocument> {
  const ctx = belegContextFor(entry);
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

function commit(entry: LedgerEntry, doc: StoredDocument): void {
  // Re-read after the signing await: the writer may have updated the row.
  const s = (store.ledgerOf(entry.orgId).find((e) => e.id === entry.id) ?? entry).statement!;
  store.addDocument(doc);
  store.updateLedgerEntry(entry.id, { statement: { ...s, documentCode: doc.code } });
}
