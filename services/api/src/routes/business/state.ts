/**
 * State a business row does not store, derived on read.
 *
 * The transfers are the source of truth. A stored draft state could say
 * EXECUTED while a transfer sits in MANUAL_REVIEW, and a sync sweep would be
 * one more thing to drift. An invoice follows its transfer the same way.
 *
 * Plain functions over the store, shared by the four route modules.
 */
import { store, type Transfer } from "../../store.js";
import { activity, findDriftedLines } from "../../domain/drafts.js";
import { expiredUnsigned } from "../../orchestrator.js";
import type { DraftPayment, DraftState, Invoice } from "../../domain/types.js";

/** The org's address book, keyed by id, for the drift fingerprint check. */
export const contactsById = (orgId: string) =>
  new Map(store.contactsOf(orgId).map((c) => [c.id, c] as const));

/** What each line of a failed run did, by payee: the run shows nothing else per line, and a
 *  rebuilt run pays a sent line again. "Not sent" only where no payout can follow. */
const lineReport = (transfers: Transfer[]) => {
  // A holder name is free text and comes from suppliers: it must not write a heading of its own.
  const line = (t: Transfer, why?: string) =>
    `${t.recipientName.replace(/[.:,()€]/g, "").slice(0, 70)} €${t.sendEur.toFixed(2)}${why ? ` (${why})` : ""}`;
  const sent: string[] = [];
  const notSent: string[] = [];
  const waiting: string[] = [];
  for (const t of transfers) {
    if (t.state === "PAID" || t.state === "PAYOUT_SUBMITTED") sent.push(line(t));
    else if (expiredUnsigned(t)) notSent.push(line(t, "approval expired"));
    else if (t.state === "FAILED" || t.state === "REFUNDED") notSent.push(line(t, t.state.toLowerCase()));
    else waiting.push(line(t, t.state === "MANUAL_REVIEW" ? "in review" : undefined));
  }
  return [
    sent.length && `Sent: ${sent.join(", ")}.`,
    notSent.length && `Not sent: ${notSent.join(", ")}.`,
    waiting.length && `Still waiting: ${waiting.join(", ")}.`,
    notSent.length && "Create a new payment for the not sent lines only.",
  ].filter(Boolean).join(" ");
};

/**
 * A draft's execution state, derived from the transfers it created.
 * Returns a view and writes nothing.
 */
export const withExecutionState = (draft: DraftPayment) => {
  if (draft.state === "EXECUTING" && draft.cryptoSendIds?.length) {
    const sends = draft.cryptoSendIds.map((id) => store.findCryptoSend(id));
    // An unsigned send past its deadline can never be submitted.
    const dead = sends.filter((x) => !x || x.state === "FAILED" || (x.state === "CREATED" && x.deadline * 1000 < Date.now()));
    const state: DraftState = dead.length ? "FAILED" : sends.every((x) => x?.state === "SENT") ? "EXECUTED" : draft.state;
    return {
      ...draft,
      state,
      cryptoSends: sends.map((x) => x && { id: x.id, state: x.state, ...(x.txHash ? { txHash: x.txHash } : {}) }),
      ...(dead.length ? { failureReason: `Not sent: ${dead.map((x) => x?.error ?? (x ? "approval expired" : "send missing")).join("; ")}. Create a new payment to try again.` } : {}),
    };
  }
  if (draft.state !== "EXECUTING" || !draft.transferIds?.length) return draft;
  const transfers = draft.transferIds
    .map((id) => store.findTransfer(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const summary = transfers.map((t) => ({ id: t.id, state: t.state }));
  const settled = transfers.filter((t) => t.state === "PAID");
  const stuck = transfers.filter((t) =>
    ["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state) || expiredUnsigned(t),
  );

  let state: DraftState = draft.state;
  if (transfers.length === draft.transferIds.length) {
    if (settled.length === transfers.length) state = "EXECUTED";
    else if (stuck.length) state = "FAILED";
  }
  return {
    ...draft,
    state,
    transfers: summary,
    ...(stuck.length ? { failureReason: lineReport(transfers) } : {}),
  };
};

/**
 * An invoice in PAYING follows its transfer, never the other way round: the
 * transfer is the money, the invoice row is bookkeeping. Derived on read,
 * like a draft's execution state, so a row cannot claim PAID while the
 * payout sits in MANUAL_REVIEW.
 */
export const syncInvoicePayment = (invoice: Invoice): Invoice => {
  if (invoice.state !== "PAYING") return invoice;
  const send = invoice.payment?.cryptoSendId ? store.findCryptoSend(invoice.payment.cryptoSendId) : undefined;
  if (send) {
    if (send.state === "SENT") {
      return store.updateInvoice(invoice.id, {
        state: "PAID",
        payment: { ...invoice.payment, paidAt: send.updatedAt, txHash: send.txHash },
      });
    }
    // An unsigned send past its deadline can never be submitted.
    if (send.state === "FAILED" || (send.state === "CREATED" && send.deadline * 1000 < Date.now())) {
      return store.updateInvoice(invoice.id, {
        state: "SUBMITTED",
        payment: { ...invoice.payment, cryptoSendId: undefined },
      });
    }
    return invoice;
  }
  // A send that no longer exists can never pay the link: it is to pay again.
  if (invoice.payment?.cryptoSendId) {
    return store.updateInvoice(invoice.id, { state: "SUBMITTED", payment: { ...invoice.payment, cryptoSendId: undefined } });
  }
  const transfer = invoice.payment?.transferId ? store.findTransfer(invoice.payment.transferId) : undefined;
  if (transfer) {
    if (transfer.state === "PAID") {
      return store.updateInvoice(invoice.id, {
        state: "PAID",
        payment: { ...invoice.payment, paidAt: transfer.updatedAt },
      });
    }
    if (transfer.state === "FAILED" || transfer.state === "REFUNDED" || expiredUnsigned(transfer)) {
      return store.updateInvoice(invoice.id, {
        state: "SUBMITTED",
        payment: { ...invoice.payment, draftId: undefined, transferId: undefined },
      });
    }
    return invoice;
  }
  const draft = invoice.payment?.draftId ? store.findDraft(invoice.payment.draftId) : undefined;
  if (!draft || draft.state === "FAILED" || draft.state === "REJECTED" || draft.state === "CANCELLED") {
    return store.updateInvoice(invoice.id, {
      state: "SUBMITTED",
      payment: { ...invoice.payment, draftId: undefined },
    });
  }
  return invoice;
};

export const releaseInvoicesOf = (draftId: string) => {
  for (const inv of store.invoices) {
    if (inv.state === "PAYING" && inv.payment?.draftId === draftId && !inv.payment.transferId) {
      store.updateInvoice(inv.id, { state: "SUBMITTED", payment: { ...inv.payment, draftId: undefined } });
    }
  }
};

/** Re-check a draft against the address book and park it if anything moved. */
export const reconcileDrift = (draft: DraftPayment): DraftPayment => {
  const drifted = findDriftedLines(draft, contactsById(draft.orgId));
  if (!drifted.length) return draft;
  return store.updateDraft(draft.id, {
    state: "INVALID_DATA",
    invalidLineIds: drifted,
    activity: [
      ...draft.activity,
      activity(
        "system",
        "invalid_data",
        `${drifted.length} line(s) point at a recipient that has changed since the draft was saved.`,
      ),
    ],
  });
};
