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
import { liveCryptoSend } from "../../wallet/org-debit.js";
import { bankRunDraftState, bankRunLineState, bankRunReport, publicBankRun } from "../../domain/company-bank-run.js";
import type { DraftPayment, DraftState, Invoice } from "../../domain/types.js";
import { mapSeq } from "../../seq.js";

/** The org's address book, keyed by id, for the drift fingerprint check. */
export const contactsById = async (orgId: string) =>
  new Map((await store.contactsOf(orgId)).map((c) => [c.id, c] as const));

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
export const withExecutionState = async (draft: DraftPayment) => {
  // A company bank run reads each line from the run on the draft, which
  // follows its payout row (mirrorRunLine). A line signed but never sent
  // whose approval expired reads as not sent.
  if (draft.bankRun) {
    const state: DraftState = draft.state === "EXECUTING" ? bankRunDraftState(draft.bankRun) : draft.state;
    return {
      ...draft,
      state,
      bankRun: publicBankRun(draft.bankRun),
      ...(state === "FAILED" ? { failureReason: bankRunReport(draft.bankRun) } : {}),
    };
  }
  if (draft.state === "EXECUTING" && draft.cryptoSendIds?.length) {
    // A company send reads its state from its op.
    const sends = await mapSeq((await mapSeq(draft.cryptoSendIds, async (id) => await store.findCryptoSend(id))), async (x) => x && (await liveCryptoSend(x)));
    // An unsigned send past its deadline can never be submitted.
    const dead = sends.filter((x) => !x || x.state === "FAILED" || (x.state === "CREATED" && x.deadline * 1000 < Date.now()));
    const state: DraftState = dead.length ? "FAILED" : sends.every((x) => x?.state === "SENT") ? "EXECUTED" : draft.state;
    return {
      ...draft,
      state,
      cryptoSends: sends.map((x) => x && { id: x.id, state: x.state, ...(x.safeOpId ? { safeOpId: x.safeOpId } : {}), ...(x.txHash ? { txHash: x.txHash } : {}) }),
      ...(dead.length ? { failureReason: `Not sent: ${dead.map((x) => x?.error ?? (x ? "approval expired" : "send missing")).join("; ")}. Create a new payment to try again.` } : {}),
    };
  }
  if (draft.state !== "EXECUTING" || !draft.transferIds?.length) return draft;
  const transfers = (await mapSeq(draft.transferIds, async (id) => await store.findTransfer(id)))
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
export const syncInvoicePayment = async (invoice: Invoice): Promise<Invoice> => {
  return store.tx(async () => {
    // The row as stored, not the caller's copy; each move is from PAYING, so
    // a second sync racing this one finds it moved and returns the row.
    const stored0 = await store.findInvoice(invoice.id);
    if (!stored0) return invoice;
    invoice = stored0;
    if (invoice.state !== "PAYING") return invoice;
    const move = async (patch: Partial<Invoice>) =>
      (await store.updateInvoiceFrom(invoice.id, ["PAYING"], patch)) ?? (await store.findInvoice(invoice.id))!;
    const stored = invoice.payment?.cryptoSendId ? (await store.findCryptoSend(invoice.payment.cryptoSendId)) : undefined;
    const send = stored && (await liveCryptoSend(stored));
    if (send) {
      if (send.state === "SENT") {
        return await move({
          state: "PAID",
          payment: { ...invoice.payment, paidAt: send.updatedAt, txHash: send.txHash },
        });
      }
      // An unsigned send past its deadline can never be submitted.
      if (send.state === "FAILED" || (send.state === "CREATED" && send.deadline * 1000 < Date.now())) {
        return await move({
          state: "SUBMITTED",
          payment: { ...invoice.payment, cryptoSendId: undefined, draftId: undefined },
        });
      }
      return invoice;
    }
    // A send that no longer exists can never pay the link: it is to pay again.
    if (invoice.payment?.cryptoSendId) {
      return await move({ state: "SUBMITTED", payment: { ...invoice.payment, cryptoSendId: undefined, draftId: undefined } });
    }
    const transfer = invoice.payment?.transferId ? (await store.findTransfer(invoice.payment.transferId)) : undefined;
    if (transfer) {
      if (transfer.state === "PAID") {
        return await move({
          state: "PAID",
          payment: { ...invoice.payment, paidAt: transfer.updatedAt },
        });
      }
      if (transfer.state === "FAILED" || transfer.state === "REFUNDED" || expiredUnsigned(transfer)) {
        return await move({
          state: "SUBMITTED",
          payment: { ...invoice.payment, draftId: undefined, transferId: undefined },
        });
      }
      return invoice;
    }
    const draft = invoice.payment?.draftId ? (await store.findDraft(invoice.payment.draftId)) : undefined;
    // A company bank run: the invoice follows its own line, not the run. A
    // run that stopped after this line was sent paid this invoice.
    const runLine = draft?.bankRun && draft.lines.find((l) => l.invoiceId === invoice.id);
    const paid = runLine && draft!.bankRun!.lines.find((l) => l.lineId === runLine.id);
    if (paid) {
      const state = bankRunLineState(draft!.bankRun!, paid);
      if (state === "sent") return await move({ state: "PAID", payment: { ...invoice.payment, paidAt: paid.processedAt ?? new Date().toISOString() } });
      if (state === "failed" || state === "not_sent") return await move({ state: "SUBMITTED", payment: { ...invoice.payment, draftId: undefined } });
      // Signed, being sent, pending at Monerium, or unclear: it may still pay.
      return invoice;
    }
    if (!draft || draft.state === "FAILED" || draft.state === "REJECTED" || draft.state === "CANCELLED") {
      return await move({
        state: "SUBMITTED",
        payment: { ...invoice.payment, draftId: undefined },
      });
    }
    return invoice;
  });
};

export const releaseInvoicesOf = async (draftId: string) => {
  return store.tx(async () => {
    for (const inv of (await store.list("invoices"))) {
      if (inv.state === "PAYING" && inv.payment?.draftId === draftId && !inv.payment.transferId) {
        await store.updateInvoiceFrom(inv.id, ["PAYING"], { state: "SUBMITTED", payment: { ...inv.payment, draftId: undefined } });
      }
    }
  });
};

/** Re-check a draft against the address book and park it if anything moved. */
export const reconcileDrift = async (draft: DraftPayment): Promise<DraftPayment> => {
  return store.tx(async () => {
    // Only a run not yet sending is parked: rewriting one that is sending would
    // make it editable, and a second send could follow the first.
    if (!["DRAFT", "PENDING_REVIEW", "REVIEWED", "INVALID_DATA"].includes(draft.state)) return draft;
    const drifted = findDriftedLines(draft, await contactsById(draft.orgId));
    if (!drifted.length) return draft;
    // Never over a claim to execute: only from the states checked above, and
    // only over the row the drift was found on.
    const parked = await store.updateDraftFrom(draft.id, { state: "INVALID_DATA", invalidLineIds: drifted }, {
      from: ["DRAFT", "PENDING_REVIEW", "REVIEWED", "INVALID_DATA"],
      expectedUpdatedAt: draft.updatedAt,
      activity: activity(
        "system",
        "invalid_data",
        `${drifted.length} line(s) point at a recipient that has changed since the draft was saved.`,
      ),
    });
    return parked ?? (await store.findDraft(draft.id)) ?? draft;
  });
};
