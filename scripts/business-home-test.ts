/**
 * Zold Business → Home (public/business/home-model.js): the accounts and
 * contacts the send form offers, the Security card, the set-up list and the
 * Pending tab.
 *
 * Pins: no account pays that is gated, unbacked or waiting on its profile
 * check, and no contact is paid without an IBAN; a recovery
 * or signer read that failed is "couldn't check", never on or off; a stranger
 * guardian is a warning even beside Zoldenburg's; the backup-key step is
 * unknown, not missing, when the signers could not be read, and keeps the
 * set-up card open; only the company's own login is told to connect Monerium;
 * only unsent runs are pending; a company whose euro account is not live
 * says what it waits for, a live one shows its IBAN with no backer, a failed
 * read says it failed, never that no account is connected, and only a
 * company's card says it.
 *
 * What this cannot show: the screen in a browser. Offline.
 *
 *   npm run business:home:test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activeEurAccount, businessOrg, companyOrg, gatedEurAccount, personalOrg } from "./_org-fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/home-model.js")).href);
const links = { signers: "/s", recovery: "/r", alert: "/a" };

const active = activeEurAccount("acc_1", "org_1", { iban: "DE00", address: `0x${"aa".repeat(20)}`, backingUserId: "u1" });
const contact = { id: "c1", name: "Weber", bankAccounts: [{ iban: "DE11" }] };

// ── What the send form offers ───────────────────────────────────────────────

assert.equal(m.fundableAccounts([active]).length, 1);
assert.equal(m.fundableAccounts([{ ...active, profile: { status: "needs_check" } }]).length, 0, "an account waiting on its profile check cannot pay");
assert.equal(m.fundableAccounts([{ ...active, backingUserId: null }]).length, 0, "an account nobody backs cannot pay");
assert.equal(m.fundableAccounts([{ ...active, status: "gated" }]).length, 0, "a gated account cannot pay, even with a backer");
assert.equal(m.payableContacts([contact]).length, 1);
assert.equal(m.payableContacts([{ id: "c2", name: "X", bankAccounts: [] }]).length, 0, "a contact without an IBAN cannot be paid");
assert.equal(m.payableContacts([{ id: "c3", name: "Y" }]).length, 0, "a contact without bankAccounts is not payable, and does not throw");

// ── Security ────────────────────────────────────────────────────────────────

const signers = { passkeyIsOwner: true, zoldCanSend: true, needed: "1 of 1", otherOwners: [] };
const rec = (status: string, guardians: any[] = []) => ({ status, guardians });

assert.equal(m.securityRows(null, links), null, "not the company login: no card");
assert.equal(m.securityRows({ noSafe: true }, links), null, "no Safe yet: no card");
{
  const r = m.securityRows({ signers, recovery: rec("none") }, links, "Face ID");
  assert.deepEqual(r.map((x: any) => x.ok), [true, false, false]);
  assert.equal(r[0].text, "Your Face ID signs for the account");
  assert.equal(r[1].action.href, "/r", "no recovery: Set up in the app");
  assert.equal(r[2].action.href, "/s", "no backup key: Add in the app");
}
{
  const r = m.securityRows({ signers: { ...signers, otherOwners: ["0xb"] }, recovery: rec("set", [{ kind: "zoldenburg" }]) }, links);
  assert.deepEqual(r.map((x: any) => [x.ok, x.text]), [[true, "Your passkey signs for the account"], [true, "Zoldenburg recovery on"], [true, "Backup key added"]]);
}
{
  const r = m.securityRows({ signers: null, recovery: rec("unknown") }, links);
  assert.equal(r.length, 2, "signers unread: no backup-key row");
  assert.deepEqual(r.map((x: any) => x.ok), [null, null], "a failed read is never on or off");
}
{
  const r = m.securityRows({ signers, recovery: rec("set", [{ kind: "zoldenburg" }, { kind: "other", address: "0xe" }]) }, links);
  assert.deepEqual([r[1].ok, r[1].text], [false, "A recovery helper Zold didn’t set up is on the account"], "a stranger guardian warns even beside Zoldenburg's");
}
{
  const r = m.securityRows({ signers, recovery: rec("pending") }, links);
  assert.deepEqual([r[1].ok, r[1].text, r[1].action.href], [false, "A recovery is under way", "/a"], "a recovery under way links to the alert");
}
{
  const r = m.securityRows({ signers: { ...signers, passkeyIsOwner: false, zoldCanSend: false }, recovery: rec("none") }, links);
  assert.deepEqual([r[0].ok, r[0].text], [false, "This sign-in doesn’t sign for the account"], "not an owner is said before the threshold");
}
{
  const r = m.securityRows({ signers: { ...signers, otherOwners: ["0xb", "0xc"] }, recovery: rec("none") }, links);
  assert.equal(r[2].text, "2 other signers");
}
{
  const r = m.securityRows({ signers: { ...signers, zoldCanSend: false, needed: "2 of 2", otherOwners: ["0xb"] }, recovery: rec("set", [{ kind: "codes" }]) }, links);
  assert.equal(r[0].ok, false, "threshold 2: Zold can't send");
  assert.equal(r[1].text, "Recovery on, by email or phone codes");
}

// ── Set-up steps ────────────────────────────────────────────────────────────

const done = (steps: any[]) => Object.fromEntries(steps.map((s) => [s.id, s.done]));
{
  const me = { passkey: { credentialId: "k" }, passkeySafe: { status: "active" } };
  assert.deepEqual(done(m.setupSteps(me, [], { signers })), { passkey: true, account: true, monerium: false, iban: false, backup: false });
  assert.equal(done(m.setupSteps(me, [], { signers: null })).backup, null, "signers unread: backup unknown, not missing");
  assert.equal(done(m.setupSteps({ ...me, monerium: { connectedAt: "2026-10-01" } }, [], { signers })).monerium, true);
  assert.deepEqual(done(m.setupSteps({ ...me, monerium: { connectedAt: "2026-10-01" } }, [active], { signers: { ...signers, otherOwners: ["0xb"] } })), { passkey: true, account: true, monerium: true, iban: true, backup: true });
  assert.equal(done(m.setupSteps(me, [{ ...active, status: "gated" }], { signers })).iban, false, "a gated account's IBAN does not count");
  assert.equal(done(m.setupSteps({ ...me, kycStatus: "approved" }, [active], { signers })).monerium, false, "a removed connection is not done, whatever KYC or IBAN came before");
  assert.equal(done(m.setupSteps({ ...me, passkey: null }, [], { signers })).passkey, false);
}
{
  const step = (d: any) => ({ id: "x", done: d });
  assert.equal(m.setupOpen([step(true), step(true)]), false, "all done: no card");
  assert.equal(m.setupOpen([step(true), step(null)]), true, "an unread step keeps the card");
  assert.equal(m.setupOpen([step(true), step(false)]), true);
}

// ── No IBAN yet ─────────────────────────────────────────────────────────────

assert.equal(m.noIbanStep(false, { monerium: { connectedAt: "x" } }), "not-own", "only the company's own login is told to connect");
assert.equal(m.noIbanStep(true, {}), "connect");
assert.equal(m.noIbanStep(true, { monerium: { connectedAt: "2026-10-01" } }), "activate", "connected, no IBAN yet: activate in the app");
assert.equal(m.noIbanStep(true, { monerium: { connectedAt: "2026-10-01" }, iban: "DE89" }), "adopt", "the login has its IBAN: connect it on Accounts");
assert.equal(done(m.setupSteps({ passkey: { credentialId: "k" } }, [], { noSafe: true })).backup, false, "no Safe: no backup key");

// ── A company's balance card ────────────────────────────────────────────────

{
  // The gate as GET .../accounts words it (routes/orgs.ts gateOf).
  const noSafe = { ...gatedEurAccount("acc_c", "org_c"), gate: { reason: "The company’s Safe is not set up yet, so nothing can be paid into or sent from this account." } };
  const safeNoIban = { ...gatedEurAccount("acc_c", "org_c", { address: `0x${"cc".repeat(20)}` }), gate: { reason: "The company’s Safe is set up, but issuing the company’s IBAN onto it is not yet live, so nothing can be sent from this account." } };
  const company = companyOrg("org_c", "Lindner Bau");
  const live = activeEurAccount("acc_c", "org_c", { iban: "DE89370400440532013000", address: `0x${"cc".repeat(20)}` });
  assert.equal(live.backingUserId, undefined, "a company's live account has no backer");
  assert.deepEqual(m.companyBalance(company, [noSafe]), { note: noSafe.gate.reason }, "no Safe yet: says so");
  assert.match(m.companyBalance(company, [safeNoIban]).note, /Safe is set up, but issuing the company’s IBAN/, "Safe deployed, no IBAN: says the IBAN is not live");
  assert.deepEqual(m.companyBalance(company, [gatedEurAccount("acc_c", "org_c")]), { note: "The company’s account is not live yet." }, "a gate without a reason still never reads as no account");
  assert.equal(m.companyBalance(company, []), null, "no euro account: the card's own wording");
  assert.deepEqual(m.companyBalance(company, null), { note: "The company’s account could not be read just now. Reload to try again." }, "accounts unread: says the read failed, not that there is no account");
  assert.doesNotMatch(m.companyBalance(company, null).note, /No account/, "a failed read is not no account");
  assert.deepEqual(m.companyBalance(company, [live]), { iban: "DE89370400440532013000" }, "live, no backer: its IBAN, no figure, no note");
  assert.deepEqual(m.companyBalance(company, [{ ...live, identifier: {} }]), { iban: null }, "live without an IBAN on the row: no IBAN yet");
  assert.equal(m.companyBalance(businessOrg("org_s", "Weber", { entity: "sole_trader" }), [noSafe]), null, "a sole trader's card is unchanged");
  assert.equal(m.companyBalance(businessOrg("org_s", "Weber", { entity: "sole_trader" }), null), null, "a sole trader's failed read keeps its own wording");
  assert.equal(m.companyBalance(businessOrg("org_l", "Weber"), [noSafe]), null, "a business row with no entity is a sole trader");
  assert.equal(m.companyBalance({ ...personalOrg("org_p", "Sara"), role: "owner" }, [noSafe]), null, "a personal card is unchanged");
}

// ── Pending ─────────────────────────────────────────────────────────────────

assert.deepEqual(
  m.pendingRuns(["DRAFT", "PENDING_REVIEW", "REVIEWED", "EXECUTING", "EXECUTED", "FAILED", "REJECTED", "CANCELLED"].map((state) => ({ state }))).map((d: any) => d.state),
  ["DRAFT", "PENDING_REVIEW", "REVIEWED", "EXECUTING"],
);

console.log("business home: ok");
