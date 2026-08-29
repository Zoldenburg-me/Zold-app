/**
 * The organisation domain, proved without a chain or a network.
 *
 * Everything here is pure logic over domain/, so it runs offline and fast. The
 * checks are chosen to pin the rules that are easy to regress and expensive to
 * regress silently: plan gating that must never delete, four-eyes review,
 * address-book drift, and a gated currency that must not read as live.
 *
 *   npm run business:test
 */

import assert from "node:assert/strict";
import {
  CAPABILITIES,
  can,
  capabilityMatrix,
  effectivePlan,
  limitsFor,
  plansFor,
  trialIsActive,
  trialPlanFor,
  TRIAL_DAYS,
} from "../services/api/src/domain/plans.js";
import { canReviewDraft, roleCan, wouldOrphanOrg } from "../services/api/src/domain/roles.js";
import {
  currencyAvailability,
  initialStatusFor,
  suggestedCurrency,
} from "../services/api/src/domain/accounts.js";
import {
  ContactError,
  destinationFingerprint,
  ibanChecksumValid,
  validateBankAccount,
} from "../services/api/src/domain/contacts.js";
import {
  currentFingerprint,
  findDriftedLines,
  importCsv,
  validateLine,
  assertTransition,
  DraftError,
} from "../services/api/src/domain/drafts.js";
import {
  assertDeletable,
  hashToken,
  newLinkToken,
  supplierView,
  tokenMatches,
  validateLines,
  InvoiceError,
} from "../services/api/src/domain/invoices.js";
import { applyRules, resolveAccountCode } from "../services/api/src/domain/coa.js";
import { computeCostBasis, positions, toCsv } from "../services/api/src/domain/ledger.js";
import type {
  AccountRule,
  Contact,
  DraftPayment,
  Invoice,
  LedgerEntry,
  Organisation,
} from "../services/api/src/domain/types.js";

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

const org = (over: Partial<Organisation> = {}): Organisation => ({
  id: "org_1",
  type: "business",
  name: "Test GmbH",
  plan: "starter",
  reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" },
  verifications: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

console.log("\nPlans and gating");

check("starter business cannot reach the chart of accounts", () => {
  const v = can(org(), "coa.manage");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.requiresPlan, ["business"]);
  assert.ok(v.upgradeHint, "a refusal should say what upgrading buys");
});

check("business plan reaches it", () => {
  assert.equal(can(org({ plan: "business" }), "coa.manage").allowed, true);
});

check("a personal org is refused members outright, not sold an upgrade", () => {
  const v = can(org({ type: "personal", plan: "premium" }), "members.manage");
  assert.equal(v.allowed, false);
  assert.equal(v.requiresPlan, undefined, "nothing a personal org can buy grants this");
  assert.match(v.reason!, /business product/);
});

check("premium is personal-only and business is business-only", () => {
  assert.deepEqual(plansFor("personal").map((p) => p.id), ["starter", "premium"]);
  assert.deepEqual(plansFor("business").map((p) => p.id), ["starter", "business"]);
});

check("cards report as not built rather than as an upgrade", () => {
  const v = can(org({ plan: "business" }), "cards");
  assert.equal(v.allowed, false);
  assert.ok(v.unavailable, "an unbuilt feature must not be sold");
  assert.equal(v.requiresPlan, undefined);
  assert.match(v.unavailable!, /issuer partner/);
});

check("a trial grants without changing the plan", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const o = org({
    trial: {
      grantsPlan: trialPlanFor("business"),
      startedAt: "2026-01-20T00:00:00.000Z",
      endsAt: "2026-02-19T00:00:00.000Z",
    },
  });
  assert.equal(o.plan, "starter", "org.plan must be untouched by a trial");
  assert.equal(effectivePlan(o, now), "business");
  assert.equal(can(o, "coa.manage", now).allowed, true);
});

check("a lapsed trial falls back with nothing to migrate", () => {
  const o = org({
    trial: {
      grantsPlan: "business",
      startedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-31T00:00:00.000Z",
    },
  });
  const after = new Date("2026-03-01T00:00:00.000Z");
  assert.equal(trialIsActive(o, after), false);
  assert.equal(effectivePlan(o, after), "starter");
  assert.equal(can(o, "coa.manage", after).allowed, false);
  assert.equal(TRIAL_DAYS, 30);
});

check("refused capabilities are returned with reasons, not omitted", () => {
  const matrix = capabilityMatrix(org());
  assert.equal(
    Object.keys(matrix).length,
    Object.keys(CAPABILITIES).length,
    "every capability must appear so the UI can prompt in place",
  );
  assert.ok(matrix["coa.manage"].reason);
});

check("limits follow the effective plan", () => {
  assert.equal(limitsFor(org()).accounts, 1);
  assert.equal(limitsFor(org({ plan: "business" })).accounts, 20);
  assert.equal(limitsFor(org()).bulkCsvRows, 0, "starter has no bulk CSV");
  assert.equal(limitsFor(org({ plan: "business" })).bulkCsvRows, 500);
});

console.log("\nRoles");

check("a viewer cannot send and an accountant cannot execute", () => {
  assert.equal(roleCan("viewer", "transfers.execute"), false);
  assert.equal(roleCan("accountant", "transfers.execute"), false);
  assert.equal(roleCan("accountant", "coa.manage"), true);
  assert.equal(roleCan("payer", "transfers.execute"), true);
  assert.equal(roleCan("payer", "coa.manage"), false, "money and books stay apart");
});

check("four eyes: the drafter cannot approve their own payment", () => {
  assert.equal(canReviewDraft("admin", "mem_a", "mem_b").allowed, true);
  const self = canReviewDraft("admin", "mem_a", "mem_a");
  assert.equal(self.allowed, false);
  assert.match(self.reason!, /other than the person who drafted/);
});

check("an org cannot lose its last owner, by role change or deactivation", () => {
  const members = [
    { id: "m1", role: "owner" as const, status: "active" },
    { id: "m2", role: "admin" as const, status: "active" },
  ];
  assert.equal(wouldOrphanOrg(members, "m1", { role: "admin" }), true);
  assert.equal(wouldOrphanOrg(members, "m1", { status: "deactivated" }), true);
  assert.equal(wouldOrphanOrg(members, "m2", { status: "deactivated" }), false);
});

console.log("\nLocal accounts");

check("only EUR can be live, and every gated currency names what it needs", () => {
  const list = currencyAvailability();
  for (const c of list) {
    if (c.available) {
      assert.equal(c.code, "EUR", `${c.code} must not report as available`);
    } else {
      assert.ok(c.needs && c.needs.length > 20, `${c.code} must say what it needs`);
    }
  }
  assert.ok(list.length >= 5);
});

check("a gated currency is recorded, not silently opened", () => {
  const kes = initialStatusFor("KES");
  assert.equal(kes.status, "gated");
  assert.match(kes.gate!.needs, /dLocal|Yellow Card/);
  assert.match(kes.gate!.reason, /never moved money/);
});

check("the suggested currency follows the org's country", () => {
  assert.equal(suggestedCurrency({ address: { country: "KE" } }), "KES");
  assert.equal(suggestedCurrency({ address: { country: "DE" } }), "EUR");
  assert.equal(suggestedCurrency({ address: { country: "BR" } }), "EUR", "fall back to the live rail");
});

console.log("\nAddress book");

check("a bad IBAN checksum is refused", () => {
  assert.equal(ibanChecksumValid("DE89370400440532013000"), true);
  assert.equal(ibanChecksumValid("DE89370400440532013001"), false);
  assert.throws(
    () =>
      validateBankAccount({
        currency: "EUR",
        country: "DE",
        holderName: "Acme",
        iban: "DE89370400440532013001",
      }),
    ContactError,
  );
});

check("a payout refuses to guess a missing identifier", () => {
  assert.throws(
    () => validateBankAccount({ currency: "GBP", country: "GB", holderName: "Acme" }),
    /sort code|sortCode|Faster Payments/i,
  );
  const gbp = validateBankAccount({
    currency: "GBP",
    country: "GB",
    holderName: "Acme",
    sortCode: "12-34-56",
    accountNumber: "12345678",
  });
  assert.equal(gbp.sortCode, "123456", "punctuation normalised");
});

check("the holder name is required — it is payout identity, not a label", () => {
  assert.throws(
    () => validateBankAccount({ currency: "EUR", country: "DE", holderName: "" }),
    /payout identity/,
  );
});

console.log("\nDraft payments");

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: "con_1",
  orgId: "org_1",
  name: "Acme",
  wallets: [],
  bankAccounts: [
    {
      id: "cb_1",
      currency: "EUR",
      country: "DE",
      holderName: "Acme GmbH",
      iban: "DE89370400440532013000",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const draftWith = (c: Contact): DraftPayment => {
  const line = validateLine(
    {
      contactId: c.id,
      destination: { kind: "bank", bankAccountId: "cb_1", displayName: "Acme GmbH" },
      asset: "EUR",
      amount: "250.00",
    },
    c,
  );
  return {
    id: "dft_1",
    orgId: "org_1",
    source: { kind: "account", accountId: "acc_1" },
    state: "REVIEWED",
    lines: [{ id: "dl_1", ...line }],
    createdByMemberId: "mem_a",
    activity: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
};

check("a line stores a fingerprint so drift can be detected at all", () => {
  const d = draftWith(contact());
  assert.ok(d.lines[0].destination.fingerprint, "no fingerprint means drift is invisible");
});

check("an unchanged address book shows no drift", () => {
  const c = contact();
  const d = draftWith(c);
  assert.deepEqual(findDriftedLines(d, new Map([[c.id, c]])), []);
});

check("EDITING A SAVED IBAN IN PLACE IS CAUGHT — the whole point of INVALID_DATA", () => {
  const c = contact();
  const d = draftWith(c);
  // Same bank-account id, different IBAN. Identity alone would miss this.
  const edited = contact({
    bankAccounts: [{ ...c.bankAccounts[0], iban: "DE02120300000000202051" }],
  });
  assert.deepEqual(findDriftedLines(d, new Map([[edited.id, edited]])), ["dl_1"]);
});

check("deleting the bank account, or the contact, is caught", () => {
  const c = contact();
  const d = draftWith(c);
  const stripped = contact({ bankAccounts: [] });
  assert.deepEqual(findDriftedLines(d, new Map([[stripped.id, stripped]])), ["dl_1"]);
  assert.deepEqual(findDriftedLines(d, new Map()), ["dl_1"]);
});

check("a fingerprint tracks the holder name too", () => {
  const c = contact();
  const before = currentFingerprint({ destination: draftWith(c).lines[0].destination }, c);
  const renamed = contact({
    bankAccounts: [{ ...c.bankAccounts[0], holderName: "Someone Else Ltd" }],
  });
  const after = currentFingerprint({ destination: draftWith(c).lines[0].destination }, renamed);
  assert.notEqual(before, after);
});

check("an executed draft is final", () => {
  assert.throws(() => assertTransition("EXECUTED", "DRAFT"), DraftError);
  assert.throws(() => assertTransition("DRAFT", "EXECUTED"), /cannot go from DRAFT to EXECUTED/);
});

check("a zero or negative amount is refused", () => {
  const bad = { destination: { kind: "bank", bankAccountId: "cb_1", displayName: "A" }, asset: "EUR" };
  assert.throws(() => validateLine({ ...bad, amount: "0" } as never), DraftError);
  assert.throws(() => validateLine({ ...bad, amount: "-5" } as never), DraftError);
  assert.throws(() => validateLine({ ...bad, amount: "abc" } as never), DraftError);
});

console.log("\nBulk CSV");

check("bad rows are reported, never silently dropped", () => {
  const csv = [
    "Recipient Address,Token,Amount,Recipient Name",
    "0x1111111111111111111111111111111111111111,USDC,100.00,Alice",
    "not-an-address,USDC,50.00,Bob",
    "0x2222222222222222222222222222222222222222,USDC,0,Carol",
  ].join("\n");
  const out = importCsv(csv, {
    recipientAddress: "Recipient Address",
    token: "Token",
    amount: "Amount",
    recipientName: "Recipient Name",
  });
  assert.equal(out.lines.length, 1);
  assert.equal(out.rejected.length, 2, "a dropped row must be reported");
  assert.deepEqual(out.rejected.map((r) => r.row), [3, 4], "1-based row numbers past the header");
});

check("quoted fields with commas survive", () => {
  const csv =
    'Recipient Address,Token,Amount,Recipient Name\n0x1111111111111111111111111111111111111111,USDC,100.00,"Acme, Inc."';
  const out = importCsv(csv, {
    recipientAddress: "Recipient Address",
    token: "Token",
    amount: "Amount",
    recipientName: "Recipient Name",
  });
  assert.equal(out.lines[0].destination.displayName, "Acme, Inc.");
});

check("the row ceiling is enforced", () => {
  const rows = ["Recipient Address,Token,Amount"];
  for (let i = 0; i < 5; i++) {
    rows.push(`0x${String(i).padStart(40, "0")},USDC,1.00`);
  }
  assert.throws(
    () =>
      importCsv(rows.join("\n"), {
        recipientAddress: "Recipient Address",
        token: "Token",
        amount: "Amount",
      }, { maxRows: 2 }),
    /limit on this plan is 2/,
  );
});

console.log("\nInvoices");

check("only the link hash is stored, and it compares in constant time", () => {
  const { token, hash } = newLinkToken();
  assert.notEqual(token, hash);
  assert.equal(hash, hashToken(token));
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(token + "x", hash), false);
});

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv_1",
  orgId: "org_1",
  linkTokenHash: "deadbeef",
  state: "SUBMITTED",
  lines: [{ description: "Work", quantity: "2", unitPrice: "100.00", amount: "200.00" }],
  currency: "EUR",
  total: "200.00",
  createdByMemberId: "mem_a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

check("the supplier view never leaks the org id or the link hash", () => {
  const view = supplierView(invoice({ linkPasswordHash: "secret" }), "Test GmbH") as Record<string, unknown>;
  assert.equal(view.linkTokenHash, undefined);
  assert.equal(view.linkPasswordHash, undefined);
  assert.equal(view.orgId, undefined);
  assert.equal(view.createdByMemberId, undefined);
  assert.equal((view.payor as { name: string }).name, "Test GmbH");
});

check("a submitted invoice is locked", () => {
  const view = supplierView(invoice(), "Test GmbH");
  assert.equal(view.editable, false);
  assert.equal(supplierView(invoice({ state: "LINK_CREATED" }), "X").editable, true);
});

check("an invoice with a payment against it cannot be deleted", () => {
  assert.throws(
    () => assertDeletable(invoice({ payment: { transferId: "t1" } })),
    InvoiceError,
  );
  assert.throws(() => assertDeletable(invoice({ state: "PAID" })), InvoiceError);
});

check("line totals are computed, not taken from the payload", () => {
  const { lines, total } = validateLines([
    { description: "A", quantity: "3", unitPrice: "10.00", amount: "999.99" },
  ]);
  assert.equal(lines[0].amount, "30.00");
  assert.equal(total, "30.00");
});

console.log("\nChart of accounts");

const rule = (over: Partial<AccountRule>): AccountRule => ({
  id: "r1",
  orgId: "org_1",
  scope: "default",
  match: {},
  direction: "both",
  accountCode: "6000",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

check("a contact rule beats a wallet rule beats a default", () => {
  const rules = [
    rule({ id: "r_default", scope: "default", match: { txType: "transfer_out" }, accountCode: "6000" }),
    rule({ id: "r_wallet", scope: "wallet", match: { walletId: "w1" }, accountCode: "6200" }),
    rule({ id: "r_contact", scope: "contact", match: { contactId: "c1" }, accountCode: "4000" }),
  ];
  const entry = { direction: "out" as const, asset: "USDC", txType: "transfer_out", walletId: "w1", contactId: "c1" };
  assert.equal(resolveAccountCode(rules, entry)!.accountCode, "4000");
  assert.equal(
    resolveAccountCode(rules.filter((r) => r.id !== "r_contact"), entry)!.accountCode,
    "6200",
  );
  assert.equal(
    resolveAccountCode(rules.filter((r) => r.scope === "default"), entry)!.accountCode,
    "6000",
  );
});

check("a rule run never overwrites a human's categorisation", () => {
  const entries: LedgerEntry[] = [
    {
      id: "e1", orgId: "org_1", source: { kind: "wallet", walletId: "w1" },
      direction: "out", asset: "USDC", amount: "10", tags: [], at: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z", accountCode: "9999", accountCodeAuto: false,
    },
    {
      id: "e2", orgId: "org_1", source: { kind: "wallet", walletId: "w1" },
      direction: "out", asset: "USDC", amount: "10", tags: [], at: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z", accountCode: "1111", accountCodeAuto: true,
    },
  ];
  const { entries: out, changed } = applyRules(
    [rule({ scope: "wallet", match: { walletId: "w1" }, accountCode: "6200" })],
    entries,
  );
  assert.equal(out[0].accountCode, "9999", "a hand-set code must survive");
  assert.equal(out[1].accountCode, "6200");
  assert.equal(changed, 1);
});

console.log("\nBookkeeping");

const led = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: "e", orgId: "org_1", source: { kind: "account", accountId: "acc_1" },
  direction: "in", asset: "USDC", amount: "0", tags: [],
  at: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

check("FIFO consumes the oldest lot first", () => {
  const basis = computeCostBasis([
    led({ id: "a1", direction: "in", amount: "10", fiatValue: "100", at: "2026-01-01T00:00:00.000Z" }),
    led({ id: "a2", direction: "in", amount: "10", fiatValue: "200", at: "2026-02-01T00:00:00.000Z" }),
    led({ id: "d1", direction: "out", amount: "10", fiatValue: "250", at: "2026-03-01T00:00:00.000Z" }),
  ]);
  assert.equal(basis.disposals.length, 1);
  assert.equal(basis.disposals[0].costBasis, 100, "the 10-at-100 lot goes first");
  assert.equal(basis.disposals[0].realised, 150);
  const [pos] = positions(basis);
  assert.equal(pos.quantity, 10);
  assert.equal(pos.costBasis, 200);
});

check("a disposal with no matching acquisition is a shortfall, not free profit", () => {
  const basis = computeCostBasis([
    led({ id: "d1", direction: "out", amount: "5", fiatValue: "100", at: "2026-03-01T00:00:00.000Z" }),
  ]);
  assert.equal(basis.shortfalls.length, 1);
  assert.equal(basis.shortfalls[0].quantity, 5);
});

check("CSV export neutralises formula injection", () => {
  const csv = toCsv([{ note: "=cmd|'/c calc'!A0", ok: "plain" }]);
  assert.match(csv, /'=cmd/, "a leading = must be escaped so it cannot execute in Excel");
  assert.doesNotMatch(csv.split("\r\n")[1], /^=/);
});

check("CSV quoting survives commas, quotes and newlines", () => {
  const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: "line1\nline2" }]);
  assert.match(csv, /"x,y"/);
  assert.match(csv, /"say ""hi"""/);
  assert.match(csv, /"line1\nline2"/);
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
