/**
 * New payment's form model (send.js): the payees picked for a bank payment,
 * each with its own amount and note, turned into the lines of one draft.
 *
 * Pure: no DOM, no fetch. The API checks every line again (routes/business/
 * drafts.ts on save, org-monerium-bank-runs.ts when an owner signs); this is
 * where the form says so first, before anything is saved.
 */

/** `CEILINGS.linesPerDraft` (domain/ceilings.ts). */
export const DRAFT_MAX_LINES = 200;
/** `COMPANY_BANK_RUN_MAX_LINES` (domain/company-bank-run.ts): each line of a
 *  company bank run is its own passkey prompt, all signed within minutes. */
export const COMPANY_RUN_MAX_LINES = 10;

/** How many payees one payment may have. */
export const maxPayees = (companyBank) => (companyBank ? COMPANY_RUN_MAX_LINES : DRAFT_MAX_LINES);

/** What an amount field holds as a payable number, or null. Euros take cents;
 *  a token takes six places, as the crypto-send route does. */
export function sendAmount(raw, crypto) {
  const v = String(raw || "").trim().replace(",", ".");
  return (crypto ? /^\d{1,12}(\.\d{1,6})?$/ : /^\d+(\.\d{1,2})?$/).test(v) && Number(v) > 0 ? v : null;
}

const cents = (v) => Math.round(Number(v) * 100);
const ibanKey = (iban) => String(iban || "").replace(/\s+/g, "").toUpperCase();

/** The contact's bank account a line pays: its first with an IBAN, as
 *  payableContacts (home-model.js) counts it. */
export const bankOf = (c) => (c?.bankAccounts || []).find((b) => b.iban);

/** The picked payees' total in euros, counting only amounts that are valid. */
export function payeesTotal(rows) {
  return rows.reduce((s, r) => {
    const a = sendAmount(r.amount, false);
    return a ? s + cents(a) : s;
  }, 0) / 100;
}

/**
 * The payees a bank payment's form opens with: those carried across Add a
 * contact that can still be paid, then the contact picked before the form
 * opened, while there is room.
 */
export function openingRows(carried, picked, payable, max) {
  const can = (id) => payable.some((c) => c.id === id);
  const rows = (carried || []).filter((r) => can(r.contactId)).slice(0, max);
  if (picked && can(picked.contactId) && rows.length < max && !rows.some((r) => r.contactId === picked.contactId)) rows.push(picked);
  return rows;
}

/**
 * A contact ticked or unticked: `rows` gains or loses them, and the others
 * keep what was typed. Answers whether they are a payee now: a tick past
 * `max` is not.
 */
export function setPayee(rows, contactId, on, max) {
  const at = rows.findIndex((r) => r.contactId === contactId);
  if (on && at < 0 && rows.length < max) rows.push({ contactId, amount: "", note: "" });
  if (!on && at >= 0) rows.splice(at, 1);
  return rows.some((r) => r.contactId === contactId);
}

/**
 * The draft's lines for the picked payees, or the first problem.
 *
 * rows: `{ contactId, amount, note }` in the order they were picked.
 * contacts: the org's contacts as the API answers them now, so a payee is
 * always a saved contact with an IBAN and its fingerprint is checked at
 * review and at execution (INVALID_DATA).
 *
 * Returns `{ lines }` or `{ error, contactId? }`; the contactId says which
 * payee's field to point at.
 */
export function bankLines(rows, contacts, { companyBank = false } = {}) {
  if (!rows.length) return { error: "Pick who you’re paying." };
  const max = maxPayees(companyBank);
  if (rows.length > max) {
    return {
      error: companyBank
        ? `A company bank payment pays at most ${max} people: each one is its own passkey signature, and all of them are signed within a few minutes. Split it into two payments.`
        : `One payment pays at most ${max} people. Split it into two payments.`,
    };
  }
  const seen = new Set();
  const paid = [];
  const lines = [];
  for (const r of rows) {
    if (seen.has(r.contactId)) return { error: "A contact is picked twice. Pay them once, with the total.", contactId: r.contactId };
    seen.add(r.contactId);
    const c = contacts.find((x) => x.id === r.contactId);
    const b = bankOf(c);
    if (!c) return { error: "A contact you picked is no longer saved. Pick them again.", contactId: r.contactId };
    if (!b) return { error: `${c.name} has no IBAN saved.`, contactId: r.contactId };
    const amount = sendAmount(r.amount, false);
    if (!amount) return { error: `Enter an amount in euros and cents for ${c.name}, like 250 or 250.00.`, contactId: r.contactId };
    // Two lines with the same amount to the same IBAN would carry the same
    // Monerium message, so one passkey signature could stand for both: the
    // run refuses them when an owner signs, so the form refuses them first.
    if (companyBank && paid.some((p) => p.iban === ibanKey(b.iban) && p.cents === cents(amount))) {
      return { error: `${c.name} gets the same amount at the same IBAN as another payee. Pay that IBAN once, with the total, or in a separate payment.`, contactId: r.contactId };
    }
    paid.push({ iban: ibanKey(b.iban), cents: cents(amount) });
    const note = String(r.note || "").trim();
    lines.push({
      contactId: c.id,
      destination: { kind: "bank", bankAccountId: b.id, displayName: b.holderName || c.name },
      asset: "EUR",
      amount,
      ...(note ? { note } : {}),
    });
  }
  return { lines };
}
