/**
 * State a business row does not store, derived on read.
 *
 * The transfers are the source of truth. A stored draft state could say
 * EXECUTED while a transfer sits in MANUAL_REVIEW, and a sync sweep would be
 * one more thing to drift. An invoice follows its transfer the same way.
 *
 * Plain functions over the store, shared by the four route modules.
 */
import { store } from "../../store.js";
import { activity, findDriftedLines } from "../../domain/drafts.js";
import type { DraftPayment, DraftState, Invoice } from "../../domain/types.js";

/** The org's address book, keyed by id, for the drift fingerprint check. */
export const contactsById = (orgId: string) =>
  new Map(store.contactsOf(orgId).map((c) => [c.id, c] as const));

/**
 * A draft's execution state, derived from the transfers it created.
 * Returns a view and writes nothing.
 */
export const withExecutionState = (draft: DraftPayment) => {
  if (draft.state !== "EXECUTING" || !draft.transferIds?.length) return draft;
  const transfers = draft.transferIds
    .map((id) => store.findTransfer(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const summary = transfers.map((t) => ({ id: t.id, state: t.state }));
  const settled = transfers.filter((t) => t.state === "PAID");
  const stuck = transfers.filter((t) =>
    ["FAILED", "REFUNDED", "MANUAL_REVIEW"].includes(t.state),
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
    ...(stuck.length
      ? {
          failureReason: `${stuck.length} of ${transfers.length} transfer(s) did not settle: ${stuck
            .map((t) => `${t.id.slice(0, 8)} ${t.state}`)
            .join(", ")}`,
        }
      : {}),
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
  const transfer = invoice.payment?.transferId ? store.findTransfer(invoice.payment.transferId) : undefined;
  if (transfer) {
    if (transfer.state === "PAID") {
      return store.updateInvoice(invoice.id, {
        state: "PAID",
        payment: { ...invoice.payment, paidAt: transfer.updatedAt },
      });
    }
    if (transfer.state === "FAILED" || transfer.state === "REFUNDED") {
      return store.updateInvoice(invoice.id, {
        state: "SUBMITTED",
        payment: { ...invoice.payment, draftId: undefined, transferId: undefined },
      });
    }
    return invoice;
  }
  const draft = invoice.payment?.draftId ? store.findDraft(invoice.payment.draftId) : undefined;
  if (!draft || draft.state === "FAILED" || draft.state === "REJECTED") {
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
