/**
 * Issuing a Beleg for a statement line: gather the records the line links
 * to, freeze the snapshot, sign it, store it under a verification code and
 * write the code back onto the line. One per line, ever: a second call
 * returns the existing document.
 */
import { randomUUID } from "node:crypto";
import type { LedgerEntry } from "../domain/types.js";
import { holderBlock, newDocumentCode, normaliseCode, signSnapshot, type HolderBlock, type StoredDocument } from "../documents.js";
import { store } from "../store.js";
import { buildBeleg, type BelegContext, type BelegSnapshot } from "./beleg.js";

/** The IBAN's owner is the Monerium profile, not the person holding the
 *  device key: a company account's Beleg names the company. */
function holderFor(user: Parameters<typeof holderBlock>[0], profile: HolderBlock["moneriumProfile"]): HolderBlock {
  const base = holderBlock(user);
  if (!profile) return base;
  return {
    ...base,
    ...(profile.kind === "corporate" && profile.name ? { name: profile.name } : {}),
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

export async function issueBelegForLine(entry: LedgerEntry): Promise<{ doc: StoredDocument; issued: boolean }> {
  const s = entry.statement;
  if (!s) throw new Error("only a statement line has a Beleg");
  if (s.documentCode) {
    const existing = store.findDocumentByCode(s.documentCode);
    if (existing && !existing.revokedAt) return { doc: existing, issued: false };
  }
  const ctx = belegContextFor(entry);
  const snapshot: BelegSnapshot = buildBeleg(entry, ctx);
  const code = newDocumentCode();
  const doc: StoredDocument = {
    id: randomUUID(),
    code: normaliseCode(code),
    kind: "beleg",
    userId: ctx.userId,
    orgId: entry.orgId,
    createdAt: new Date().toISOString(),
    snapshot,
    attestations: { zold: await signSnapshot(snapshot, code) },
  };
  store.addDocument(doc);
  store.updateLedgerEntry(entry.id, { statement: { ...s, documentCode: doc.code } });
  return { doc, issued: true };
}
