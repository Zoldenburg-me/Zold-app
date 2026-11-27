/**
 * Zold Business → New payment with several payees (public/business/send-model.js).
 *
 * Pins: every line comes from a saved contact with an IBAN, as the address
 * book answers now, and names that contact's bank account; each payee has its
 * own amount and note; no contact twice; a company's bank payment has at most
 * COMPANY_BANK_RUN_MAX_LINES payees and no two with the same amount at the
 * same IBAN; anyone else's at most CEILINGS.linesPerDraft; the form's limits
 * are the API's; the line has no invoice, so assertOneLinePerInvoice holds;
 * the lines the form builds pass the API's own line validation; ticking and
 * unticking a contact keeps what was typed for the others and stops at the
 * limit; the payees entered before Add a contact are the ones the form opens
 * with again.
 *
 * What this cannot show: the form in a browser, or the API's refusals (those
 * are org-monerium-bank-runs:test and the drafts suites). Offline.
 *
 *   npm run business:send-model:test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPANY_BANK_RUN_MAX_LINES } from "../services/api/src/domain/company-bank-run.js";
import { CEILINGS } from "../services/api/src/domain/ceilings.js";
import { assertOneLinePerInvoice, validateLine } from "../services/api/src/domain/drafts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/send-model.js")).href);

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const contact = (id: string, iban: string | null, extra: Record<string, unknown> = {}) => ({
  id, orgId: "o1", name: `Name ${id}`,
  bankAccounts: iban ? [{ id: `${id}-old`, iban: "" }, { id: `${id}-b`, iban, holderName: `Holder ${id}` }] : [],
  wallets: [],
  ...extra,
});
const contacts = [
  contact("c1", "DE89370400440532013000"),
  contact("c2", "FR1420041010050500013M02606"),
  contact("c3", "de89 3704 0044 0532 0130 00"), // c1's IBAN, written another way
  contact("c4", null),
];
const row = (contactId: string, amount: string, note = "") => ({ contactId, amount, note });

check("the form's limits are the API's", () => {
  assert.equal(m.COMPANY_RUN_MAX_LINES, COMPANY_BANK_RUN_MAX_LINES);
  assert.equal(m.DRAFT_MAX_LINES, CEILINGS.linesPerDraft);
  assert.equal(m.maxPayees(true), COMPANY_BANK_RUN_MAX_LINES);
  assert.equal(m.maxPayees(false), CEILINGS.linesPerDraft);
});

check("several payees become one line each, in the order picked, each with its own amount and note", () => {
  const { lines, error } = m.bankLines([row("c2", "1200,50", " October "), row("c1", "80")], contacts);
  assert.equal(error, undefined);
  assert.deepEqual(lines, [
    { contactId: "c2", destination: { kind: "bank", bankAccountId: "c2-b", displayName: "Holder c2" }, asset: "EUR", amount: "1200.50", note: "October" },
    { contactId: "c1", destination: { kind: "bank", bankAccountId: "c1-b", displayName: "Holder c1" }, asset: "EUR", amount: "80" },
  ], "the bank account with the IBAN, not the contact's first; an empty note is left out");
});

check("the lines it builds pass the API's line validation, and no two share an invoice", () => {
  const { lines } = m.bankLines([row("c1", "10"), row("c2", "20.5", "rent")], contacts);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const checked = lines.map((l: any) => validateLine(l, byId.get(l.contactId) as any));
  assert.equal(checked.length, 2);
  assert.ok(checked.every((l: any) => l.destination.fingerprint), "each line carries its payee's fingerprint, so INVALID_DATA can catch an edit");
  assert.ok(lines.every((l: any) => !("invoiceId" in l)));
  assertOneLinePerInvoice(checked);
});

check("no payee: nothing to save", () => {
  assert.match(m.bankLines([], contacts).error, /Pick who you’re paying/);
});

check("a payee no longer saved, or saved without an IBAN, is refused by name", () => {
  assert.deepEqual(m.bankLines([row("c1", "1"), row("gone", "2")], contacts).contactId, "gone");
  assert.match(m.bankLines([row("gone", "2")], contacts).error, /no longer saved/);
  const r = m.bankLines([row("c4", "2")], contacts);
  assert.match(r.error, /Name c4 has no IBAN saved/);
  assert.equal(r.contactId, "c4");
});

check("every payee needs a valid amount in euros and cents", () => {
  for (const bad of ["", "0", "-5", "12.345", "abc", "1e3"]) {
    const r = m.bankLines([row("c1", "10"), row("c2", bad)], contacts);
    assert.match(r.error, /Enter an amount in euros and cents for Name c2/, `"${bad}"`);
    assert.equal(r.contactId, "c2");
  }
});

check("a contact picked twice is refused", () => {
  assert.match(m.bankLines([row("c1", "10"), row("c1", "20")], contacts).error, /picked twice/);
});

check("a company bank payment: at most COMPANY_BANK_RUN_MAX_LINES payees", () => {
  const many = Array.from({ length: COMPANY_BANK_RUN_MAX_LINES + 1 }, (_, i) => contact(`k${i}`, `DE${String(i).padStart(20, "0")}`));
  const rows = many.map((c, i) => row(c.id, String(i + 1)));
  assert.ok(m.bankLines(rows.slice(0, COMPANY_BANK_RUN_MAX_LINES), many, { companyBank: true }).lines);
  assert.match(m.bankLines(rows, many, { companyBank: true }).error, new RegExp(`at most ${COMPANY_BANK_RUN_MAX_LINES} people`));
  assert.ok(m.bankLines(rows, many).lines, "anyone else's draft may have more");
});

check("anyone else's: at most CEILINGS.linesPerDraft", () => {
  const many = Array.from({ length: CEILINGS.linesPerDraft + 1 }, (_, i) => contact(`p${i}`, `DE${String(i).padStart(20, "0")}`));
  const rows = many.map((c) => row(c.id, "1"));
  assert.ok(m.bankLines(rows.slice(0, CEILINGS.linesPerDraft), many).lines);
  assert.match(m.bankLines(rows, many).error, new RegExp(`at most ${CEILINGS.linesPerDraft} people`));
});

check("a company bank payment: no two payees with the same amount at the same IBAN", () => {
  const same = m.bankLines([row("c1", "100"), row("c3", "100.00")], contacts, { companyBank: true });
  assert.match(same.error, /same amount at the same IBAN/, "the IBAN compared without spaces or case, the amount in cents");
  assert.equal(same.contactId, "c3");
  assert.ok(m.bankLines([row("c1", "100"), row("c3", "100.01")], contacts, { companyBank: true }).lines, "another amount is another Monerium message");
  assert.ok(m.bankLines([row("c1", "100"), row("c2", "100")], contacts, { companyBank: true }).lines, "another IBAN too");
  assert.ok(m.bankLines([row("c1", "100"), row("c3", "100")], contacts).lines, "only a company bank run signs one message per line");
});

check("ticking a contact adds a payee, unticking removes only that one, the others keep what was typed", () => {
  const rows = [row("c1", "80", "October")];
  assert.equal(m.setPayee(rows, "c2", true, 10), true);
  assert.deepEqual(rows, [row("c1", "80", "October"), row("c2", "")]);
  assert.equal(m.setPayee(rows, "c2", true, 10), true, "ticked twice is one payee");
  assert.equal(rows.length, 2);
  assert.equal(m.setPayee(rows, "c1", false, 10), false);
  assert.deepEqual(rows, [row("c2", "")]);
  assert.equal(m.setPayee(rows, "gone", false, 10), false);
  assert.equal(rows.length, 1);
});

check("at the limit a tick is refused, and removing a payee opens the slot again", () => {
  const rows = [row("c1", "1"), row("c2", "2")];
  assert.equal(m.setPayee(rows, "c3", true, 2), false, "the box is unticked again");
  assert.deepEqual(rows, [row("c1", "1"), row("c2", "2")]);
  m.setPayee(rows, "c1", false, 2);
  assert.equal(m.setPayee(rows, "c3", true, 2), true);
  assert.deepEqual(rows, [row("c2", "2"), row("c3", "")]);
});

check("the form opens with the payees entered before Add a contact, then the new contact", () => {
  const payable = contacts.filter((c) => c.bankAccounts.length);
  const carried = [row("c1", "80", "October"), row("c2", "12,5")];
  assert.deepEqual(m.openingRows(carried, row("c3", ""), payable, 10), [...carried, row("c3", "")]);
  assert.deepEqual(m.openingRows(carried, row("c4", ""), payable, 10), carried, "a new contact saved without an IBAN is not a payee");
  assert.deepEqual(m.openingRows(carried, row("c3", ""), payable, 2), carried, "no room: the payees entered stay, the new one is not added");
  assert.deepEqual(m.openingRows(carried, row("c1", ""), payable, 10), carried, "never the same contact twice");
  const stale = m.openingRows([row("c4", "125", "rent"), row("c1", "80")], row("c2", ""), payable, 10);
  assert.deepEqual(stale, [row("c4", "125", "rent"), row("c1", "80"), row("c2", "")], "a carried payee who lost their IBAN stays, with what was typed");
  assert.match(m.bankLines(stale, contacts).error, /Name c4 has no IBAN saved/, "and the payment is not saved without them unseen");
  assert.match(m.bankLines(m.openingRows([row("gone", "5"), row("c1", "80")], undefined, payable, 10), contacts).error, /no longer saved/);
  assert.deepEqual(m.openingRows([], row("c1", "250", "rent"), payable, 10), [row("c1", "250", "rent")], "a contact's Pay button");
  assert.deepEqual(m.openingRows([], undefined, payable, 10), []);
});

check("the total counts only valid amounts", () => {
  assert.equal(m.payeesTotal([row("c1", "0.10"), row("c2", "0.20"), row("c3", "x")]), 0.3);
  assert.equal(m.payeesTotal([]), 0);
});

check("sendAmount: euros take cents, a token six places", () => {
  assert.equal(m.sendAmount("250,5", false), "250.5");
  assert.equal(m.sendAmount("1.123456", true), "1.123456");
  assert.equal(m.sendAmount("1.123", false), null);
  assert.equal(m.sendAmount("0", true), null);
});

console.log(`business send model: ${passed} ok`);
