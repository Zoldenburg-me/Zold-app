/**
 * Draft invoices made from wallet receipts, offline.
 *
 * A DAO pays what it decides, when it decides, so the invoice follows the
 * money: one draft per payer and calendar month, one line per receipt at its
 * EUR value on arrival, settled against those ledger rows. The checks pin
 * which rows land on which draft and, above all, that no receipt drops out
 * without being named: a row is on a draft, listed as not included with the
 * reason, or reported as having no payer rule.
 *
 * Ledger rows are seeded as wallet sync writes them; everything else goes
 * through the routes.
 *
 * Run: npm run income-invoices:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-income-invoices-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
// Config refuses hardhat's public key on a remote RPC; nothing here dials it.
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545";

// Issuing asks the wallet's own chain whether its proof still holds. A stub
// node for chain 1 with no code at any address: the wallets are ordinary
// keys, and their proofs are real signatures (wallet-proof-test.ts covers
// the proof against a real chain).
const rpcStub = express();
rpcStub.use(express.json());
rpcStub.post("/", (req, res) => {
  const { id, method } = req.body ?? {};
  const result = method === "eth_chainId" ? "0x1" : method === "eth_getCode" ? "0x" : undefined;
  res.json(result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not here" } } : { jsonrpc: "2.0", id, result });
});
const rpcServer = rpcStub.listen(0, "127.0.0.1");
await new Promise<void>((r) => rpcServer.once("listening", () => r()));
process.env.WALLET_SYNC_RPC_1 = `http://127.0.0.1:${(rpcServer.address() as any).port}`;
process.env.WALLET_SYNC_ENABLED = "0";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { createBusinessRouter } = await import("../services/api/src/routes/business.js");
const { createPaymentRequest } = await import("../services/api/src/routes/payment-requests.js");
const { monthOf } = await import("../services/api/src/domain/income-invoices.js");
type LedgerEntry = import("../services/api/src/domain/types.js").LedgerEntry;
type Invoice = import("../services/api/src/domain/types.js").Invoice;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${(err as Error).stack ?? err}`); process.exitCode = 1; });

initStore();
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const DAO = `0x${"da".repeat(20)}`;
const STREAM = `0x${"5e".repeat(20)}`;
const OTHER_DAO = `0x${"0d".repeat(20)}`;
const NO_RULE = `0x${"11".repeat(20)}`;
const STRANGER = `0x${"99".repeat(20)}`;
const SHARED = `0x${"55".repeat(20)}`;
const USDC = `0x${"c0".repeat(20)}` as `0x${string}`;
const ARB = `0x${"a7".repeat(20)}` as `0x${string}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const reporting = { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } as const;

const addOrg = (id: string, plan: string, over: Record<string, unknown> = {}) =>
  store.addOrganisation({
    id, type: "business", name: "Zoldenburg", legalName: "Zoldenburg UG (haftungsbeschränkt)", plan, reporting,
    address: { line1: "Hauptstraße 1", postalCode: "93047", city: "Regensburg", country: "DE" },
    invoicing: { vatId: "DE123456789" }, verifications: {}, createdAt: NOW, updatedAt: NOW, ...over,
  } as any);
addOrg("org_1", "business");
addOrg("org_2", "business");
addOrg("org_free", "starter");
for (const id of ["u_owner", "u_viewer", "u_outsider"]) {
  store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: NOW } as any);
}
const member = (id: string, orgId: string, userId: string, role: string) =>
  store.addMember({ id, orgId, userId, email: "", role, status: "active", invitedAt: NOW, acceptedAt: NOW } as any);
member("m_owner", "org_1", "u_owner", "owner");
member("m_viewer", "org_1", "u_viewer", "viewer");
member("m_owner2", "org_2", "u_owner", "owner");
member("m_free", "org_free", "u_owner", "owner");

const addContact = (id: string, orgId: string, name: string, addresses: string[]) =>
  store.addContact({
    id, orgId, name, wallets: addresses.map((address, i) => ({ id: `w_${id}_${i}`, chainId: 1, address: address as `0x${string}` })),
    bankAccounts: [], createdAt: NOW, updatedAt: NOW,
  });
addContact("c_dao", "org_1", "Example DAO", [DAO, STREAM, SHARED]);
addContact("c_other", "org_1", "Other DAO", [OTHER_DAO, SHARED]);
addContact("c_norule", "org_1", "No Rule DAO", [NO_RULE]);
addContact("c_dao2", "org_2", "Example DAO", [DAO]);
addContact("c_free", "org_free", "Example DAO", [DAO]);

// Each organisation's wallet, proven: only a proven wallet's receipts are
// invoiced (wallet-proof-test.ts covers the proof itself).
for (const [id, orgId, key] of [["iw_1", "org_1", `0x${"a1".repeat(32)}`], ["iw_org2", "org_2", `0x${"a2".repeat(32)}`]] as const) {
  const owner = privateKeyToAccount(key as `0x${string}`);
  const message = `proof for ${orgId}`;
  store.addImportedWallet({
    id, orgId, address: owner.address.toLowerCase() as `0x${string}`, chainId: 1, label: "Treasury", kind: "eoa", custody: "external",
    sync: { status: "synced", lastSyncedAt: NOW },
    ownership: { status: "proven", method: "ecdsa", message, signature: await owner.signMessage({ message }), provenAt: NOW, checkedAt: NOW },
    createdAt: "2025-01-01T00:00:00.000Z",
  });
}

let seq = 0;
/** A row as wallet sync writes it: an inbound, listed, valued receipt from the DAO. */
const row = (over: Partial<LedgerEntry> & { id: string }): LedgerEntry => {
  seq++;
  return {
    orgId: "org_1", source: { kind: "wallet", walletId: over.orgId === "org_2" ? "iw_org2" : "iw_1" }, chainId: 1, txHash: H(seq), logIndex: seq,
    direction: "in", asset: "USDC", token: USDC, amount: "1000", fiatValue: "800.00", fiatCurrency: "EUR", fiatRate: "0.8",
    counterparty: { address: DAO, contactId: "c_dao", name: "Example DAO" },
    tags: ["wallet"], txType: "transfer_in", at: "2026-08-10T10:00:00.000Z", createdAt: NOW, ...over,
  };
};

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user") as string | undefined;
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
app.use("/api/orgs", createOrgRouter(requireSession as any));
app.use("/api/orgs", createBusinessRouter(requireSession as any, (async () => { throw new Error("no transfers here"); }) as any));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}/api/orgs`;
const call = async (method: string, p: string, body?: unknown, asUser = "u_owner") => {
  const res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", "x-user": asUser }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};

const RULE = {
  serviceDescription: "Delegate services",
  vat: { kind: "exempt", reason: "not_taxable_place_of_supply" },
  recipient: { name: "Example DAO Foundation", addressLine: "1 Harbour Road", postalCode: "KY1-1001", city: "George Town", country: "KY", isBusiness: true },
  supplyKind: "services",
  language: "en",
};
const run = (month: string, org = "org_1", asUser = "u_owner") => call("POST", `/${org}/income-invoices/run`, { month }, asUser);
const invoices = async (org = "org_1"): Promise<any[]> => (await call("GET", `/${org}/invoices`)).body.invoices ?? [];
const draftsFor = async (contactId: string, month: string, org = "org_1") =>
  (await invoices(org)).filter((i) => i.fromReceipts?.contactId === contactId && i.fromReceipts?.month === month);
const lineRows = (i: any): string[] => i.lines.filter((l: any) => l.receipt).map((l: any) => l.receipt.ledgerEntryId);
const settledRows = (i: any): string[] => (i.settlements ?? []).map((s: any) => s.ledgerEntryId).filter(Boolean);
const cents = (s: string) => Math.round(Number(s) * 100);

console.log("\nThe payer rule");

await check("a payer rule is saved on the contact with its description, tax line and recipient", async () => {
  const r = await call("PUT", "/org_1/contacts/c_dao/payer-rule", RULE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contact.payerRule.serviceDescription, "Delegate services");
  assert.deepEqual(r.body.contact.payerRule.vat, { kind: "exempt", reason: "not_taxable_place_of_supply" });
  assert.equal(r.body.contact.payerRule.recipient.name, "Example DAO Foundation");
});

await check("a rule without a description, without a tax line, or with a rate that is no percentage is refused: Zold picks no tax treatment", async () => {
  for (const bad of [
    { ...RULE, serviceDescription: " " },
    { ...RULE, vat: undefined },
    { ...RULE, vat: { kind: "standard", rate: 190 } },
    { ...RULE, vat: { kind: "exempt" } },
    { ...RULE, vat: { kind: "exempt", reason: "made_up_reason" } },
    { ...RULE, recipient: { ...RULE.recipient, name: "" } },
  ]) {
    const r = await call("PUT", "/org_1/contacts/c_other/payer-rule", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(store.findContact("c_other")!.payerRule, undefined);
});

await check("the three checks: no membership is 404, a viewer is 403, a plan without invoices is 402", async () => {
  assert.equal((await call("PUT", "/org_1/contacts/c_dao/payer-rule", RULE, "u_outsider")).status, 404);
  assert.equal((await call("PUT", "/org_1/contacts/c_dao/payer-rule", RULE, "u_viewer")).status, 403);
  assert.equal((await call("PUT", "/org_free/contacts/c_free/payer-rule", RULE)).status, 402);
  assert.equal((await run("2026-08", "org_1", "u_outsider")).status, 404);
  assert.equal((await run("2026-08", "org_1", "u_viewer")).status, 403);
  assert.equal((await run("2026-08", "org_free")).status, 402);
  assert.equal((await call("POST", "/org_1/income-invoices/inv_x/issue", {}, "u_viewer")).status, 403);
  assert.equal((await call("POST", "/org_free/income-invoices/inv_x/issue", {})).status, 402);
  assert.equal((await call("DELETE", "/org_1/contacts/c_dao/payer-rule", undefined, "u_viewer")).status, 403);
  assert.equal((await call("DELETE", "/org_free/contacts/c_free/payer-rule")).status, 402);
  assert.ok(store.findContact("c_dao")!.payerRule, "a refused removal removes nothing");
});

await check("another organisation's contact cannot be given a rule through this one", async () => {
  assert.equal((await call("PUT", "/org_1/contacts/c_dao2/payer-rule", RULE)).status, 404);
});

console.log("\nWhich rows land on the month's draft");

store.addLedgerEntries([
  row({ id: "r_usdc", at: "2026-08-10T10:00:00.000Z", amount: "1000", fiatValue: "800.00" }),
  row({ id: "r_arb", at: "2026-08-20T10:00:00.000Z", asset: "ARB", token: ARB, amount: "2500.5", fiatValue: "928.19", fiatRate: "0.3712" }),
  row({ id: "r_eure", at: "2026-08-25T10:00:00.000Z", asset: "EURe", amount: "50", fiatValue: "50.00", fiatRate: "1", tags: ["wallet", "e-money"] }),
  // 22:30 UTC on 31 July is 00:30 on 1 August in Berlin: an August receipt.
  row({ id: "r_edge_in", at: "2026-07-31T22:30:00.000Z", fiatValue: "10.00", amount: "12.5" }),
  // 22:30 UTC on 31 August is 1 September in Berlin: not August's.
  row({ id: "r_edge_out", at: "2026-08-31T22:30:00.000Z", fiatValue: "20.00", amount: "25" }),
  // A claim paid out by the stream contract, attributed at sync.
  row({ id: "r_stream", at: "2026-08-15T10:00:00.000Z", fiatValue: "5.55", amount: "6.9", counterparty: { address: STREAM, contactId: "c_dao", name: "Example DAO" } }),
  row({ id: "r_unvalued", at: "2026-08-12T10:00:00.000Z", asset: `OP@1:${ARB}`, fiatValue: undefined, fiatCurrency: undefined, fiatRate: undefined, tags: ["wallet", "needs-valuation"] }),
  row({ id: "r_unlisted", at: "2026-08-13T10:00:00.000Z", asset: `AIRDROP@1:${ARB}`, fiatValue: undefined, fiatCurrency: undefined, fiatRate: undefined, tags: ["wallet", "unlisted"], txType: "unlisted_token" }),
  row({ id: "r_internal", at: "2026-08-14T10:00:00.000Z", tags: ["wallet", "internal"], txType: "internal_transfer" }),
  row({ id: "r_out", at: "2026-08-16T10:00:00.000Z", direction: "out", txType: "transfer_out" }),
  row({ id: "r_account", at: "2026-08-17T10:00:00.000Z", source: { kind: "account", accountId: "acc_1" } }),
  row({ id: "r_other", at: "2026-08-18T10:00:00.000Z", fiatValue: "70.00", counterparty: { address: OTHER_DAO, contactId: "c_other", name: "Other DAO" } }),
  row({ id: "r_norule", at: "2026-08-19T10:00:00.000Z", fiatValue: "30.00", counterparty: { address: NO_RULE, contactId: "c_norule", name: "No Rule DAO" } }),
  row({ id: "r_stranger", at: "2026-08-21T10:00:00.000Z", fiatValue: "40.00", counterparty: { address: STRANGER } }),
  // Synced before any contact listed the address, which two contacts list now.
  row({ id: "r_shared", at: "2026-08-22T10:00:00.000Z", fiatValue: "60.00", counterparty: { address: SHARED } }),
  row({ id: "r_org2", orgId: "org_2", at: "2026-08-10T10:00:00.000Z", fiatValue: "999.00", counterparty: { address: DAO, contactId: "c_dao2", name: "Example DAO" } }),
]);

const AUGUST = ["r_edge_in", "r_usdc", "r_stream", "r_arb", "r_eure"];
const AUGUST_CENTS = 1000 + 80000 + 555 + 92819 + 5000;
let august: any = { id: "missing", lines: [], settlements: [], fromReceipts: { excluded: [] } };

await check("one draft per contact and month holds exactly that contact's valued, listed or e-money inbound wallet rows of the month, one line each, oldest first", async () => {
  const r = await run("2026-08");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const drafts = await draftsFor("c_dao", "2026-08");
  assert.equal(drafts.length, 1);
  august = drafts[0];
  assert.equal(august.state, "DRAFT");
  assert.equal(august.direction, "outgoing");
  assert.deepEqual(lineRows(august), AUGUST);
  assert.equal(august.issued, undefined, "a draft has no number and no issue date");
});

await check("a line names the date, token, quantity, EUR value at receipt and transaction", () => {
  const line = august.lines.find((l: any) => l.receipt.ledgerEntryId === "r_arb");
  assert.equal(line.receipt.asset, "ARB");
  assert.equal(line.receipt.amount, "2500.5");
  assert.equal(line.receipt.eurCents, 92819);
  assert.equal(line.receipt.at, "2026-08-20T10:00:00.000Z");
  assert.equal(line.receipt.txHash, store.ledgerOf("org_1").find((e) => e.id === "r_arb")!.txHash);
  assert.equal(line.amount, "928.19", "the line is the receipt's EUR value, not quantity times a rounded unit price");
  for (const part of ["Delegate services", "2026-08-20", "2500.5 ARB", line.receipt.txHash]) {
    assert.ok(line.description.includes(part), `${line.description} should name ${part}`);
  }
});

await check("the total is the sum of the receipts' EUR values, and the draft is settled row by row for exactly that", () => {
  assert.equal(cents(august.total), AUGUST_CENTS);
  assert.deepEqual(settledRows(august).sort(), [...AUGUST].sort());
  assert.equal(august.settlements.reduce((s: number, x: any) => s + Math.round(x.amountEur * 100), 0), AUGUST_CENTS);
  for (const s of august.settlements) {
    assert.equal(s.method, "wallet-receipt");
    assert.equal(s.ref, `ledger:${s.ledgerEntryId}`);
  }
});

await check("rows with no value, on no token list, or between own addresses are not invoiced and are listed on the draft with the reason", () => {
  const excluded = Object.fromEntries(august.fromReceipts.excluded.map((x: any) => [x.ledgerEntryId, x.reason]));
  assert.deepEqual(Object.keys(excluded).sort(), ["r_internal", "r_unlisted", "r_unvalued"]);
  assert.match(excluded.r_unvalued, /value/i);
  assert.match(excluded.r_unlisted, /list/i);
  assert.match(excluded.r_internal, /own/i);
});

await check("outgoing rows, the account's own rows, another month's and another organisation's rows are on no draft", async () => {
  const all = (await invoices()).flatMap(lineRows);
  assert.ok(all.length > 0);
  for (const id of ["r_out", "r_account", "r_edge_out", "r_org2"]) assert.ok(!all.includes(id), id);
  assert.deepEqual(await invoices("org_2"), []);
});

await check("a receipt from a contact without a rule, or from nobody in the address book, is reported by the run rather than dropped", async () => {
  const r = await run("2026-08");
  const withoutRule = r.body.withoutRule.map((x: any) => [x.contactId, x.receipts, x.eurCents]).sort();
  assert.deepEqual(withoutRule, [["c_norule", 1, 3000], ["c_other", 1, 7000]]);
  assert.equal(r.body.withoutContact.receipts, 2, "the stranger's, and the one two contacts both list");
  assert.equal(r.body.withoutContact.eurCents, 10000);
});

await check("the run answers per contact: which draft, how many lines, what was left out", async () => {
  const r = await run("2026-08");
  const dao = r.body.contacts.find((c: any) => c.contactId === "c_dao");
  assert.equal(dao.invoiceId, august.id);
  assert.equal(dao.lines, 5);
  assert.equal(dao.excluded.length, 3);
});

console.log("\nRe-runs");

await check("running the month again changes nothing: same draft, same lines, no second invoice", async () => {
  await run("2026-08");
  const drafts = await draftsFor("c_dao", "2026-08");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, august.id);
  assert.deepEqual(lineRows(drafts[0]), AUGUST);
  assert.equal(drafts[0].settlements.length, 5);
});

await check("a row that has since been given a value joins the draft and leaves the not-included list", async () => {
  store.updateLedgerEntry("r_unvalued", { fiatValue: "12.34", fiatCurrency: "EUR", fiatRate: "1.5", asset: "OP", tags: ["wallet"] });
  await run("2026-08");
  const [d] = await draftsFor("c_dao", "2026-08");
  assert.ok(lineRows(d).includes("r_unvalued"));
  assert.ok(!d.fromReceipts.excluded.some((x: any) => x.ledgerEntryId === "r_unvalued"));
  assert.equal(cents(d.total), AUGUST_CENTS + 1234);
});

await check("a receipt synced before its address was in the address book is matched at the run, by the same exactly-one-contact rule", async () => {
  store.addLedgerEntries([row({ id: "r_late_contact", at: "2026-08-05T10:00:00.000Z", fiatValue: "1.00", counterparty: { address: STREAM } })]);
  await run("2026-08");
  const [d] = await draftsFor("c_dao", "2026-08");
  assert.ok(lineRows(d).includes("r_late_contact"));
  assert.ok(!lineRows(d).includes("r_shared"), "an address two contacts list names neither");
});

await check("a second contact with a rule gets its own draft, and no row is on two invoices", async () => {
  assert.equal((await call("PUT", "/org_1/contacts/c_other/payer-rule", RULE)).status, 200);
  await run("2026-08");
  const [other] = await draftsFor("c_other", "2026-08");
  assert.deepEqual(lineRows(other), ["r_other"]);
  const all = (await invoices()).flatMap(settledRows);
  assert.equal(new Set(all).size, all.length);
});

await check("a month that has not begun in the organisation's time zone, or is no month, is refused and creates nothing; the running month is collectable", async () => {
  const before = store.invoicesOf("org_1").length;
  const [year, mon] = monthOf(NOW, "Europe/Berlin").split("-").map(Number);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  assert.equal((await run(next)).status, 400);
  assert.equal((await run(monthOf(NOW, "Europe/Berlin"))).status, 200);
  for (const bad of ["2026-13", "2026-8", "", "08/2026"]) assert.equal((await run(bad)).status, 400, bad);
  assert.equal(store.invoicesOf("org_1").length, before);
});

console.log("\nMonth edges");

await check("the month is the organisation's calendar month, not UTC's", () => {
  assert.equal(monthOf("2026-07-31T22:30:00.000Z", "Europe/Berlin"), "2026-08");
  assert.equal(monthOf("2026-07-31T21:30:00.000Z", "Europe/Berlin"), "2026-07");
  assert.equal(monthOf("2026-12-31T23:30:00.000Z", "Europe/Berlin"), "2027-01");
  assert.equal(monthOf("2026-12-31T23:30:00.000Z", "UTC"), "2026-12");
  assert.throws(() => monthOf("2026-08-01T00:00:00.000Z", "Mars/Olympus"));
  assert.throws(() => monthOf("not a time", "UTC"));
});

console.log("\nA draft is not an issued invoice");

await check("no payment link can be made for a draft: its money has already arrived", async () => {
  // The member whose account backs the organisation, who could collect an issued invoice.
  store.updateUser("u_owner", { paymentPage: { handle: "zoldenburg", depositAddress: `0x${"aa".repeat(20)}` } } as any);
  store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "main", status: "active", provider: "monerium", identifier: {}, backingUserId: "u_owner", createdAt: NOW, updatedAt: NOW } as any);
  const user = store.users.find((u) => u.id === "u_owner")!;
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await assert.rejects(
    createPaymentRequest(user, { methods: ["bank"], expiresAt, invoiceId: august.id }, { kind: "app" }, "org_1"),
    (err: any) => err.status === 409 && /draft/i.test(err.message),
  );
  assert.equal(store.paymentRequestsForUser("u_owner").length, 0);
});

await check("a draft cannot be paid or reconciled as if it were a supplier's invoice", async () => {
  const pay = await call("POST", `/org_1/invoices/${august.id}/pay`, {});
  assert.ok(pay.status === 400 || pay.status === 409, `pay answered ${pay.status}`);
  assert.equal((await call("POST", `/org_1/invoices/${august.id}/reconcile`, {})).status, 409);
  assert.equal(store.findInvoice(august.id)?.state, "DRAFT");
});

console.log("\nIssuing");

let issued = {} as Invoice;

await check("issuing refuses when a row on the draft has changed since the run, names it, and refreshes the draft", async () => {
  store.updateLedgerEntry("r_eure", { tags: ["wallet", "e-money", "internal"] });
  const r = await call("POST", `/org_1/income-invoices/${august.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, ["r_eure"]);
  const d = store.findInvoice(august.id)!;
  assert.equal(d.state, "DRAFT");
  assert.ok(!lineRows(d).includes("r_eure"));
  assert.ok(d.fromReceipts!.excluded.some((x) => x.ledgerEntryId === "r_eure"));
});

await check("issuing gives the draft the next number and today's date, never the receipt month's, and the month as supply period", async () => {
  const numberBefore = store.findOrganisation("org_1")!.invoicing?.numberSeries?.next ?? 1;
  const r = await call("POST", `/org_1/income-invoices/${august.id}/issue`, { acceptWarnings: true, issueDate: "2026-08-31" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  issued = store.findInvoice(august.id)!;
  assert.equal(issued.issued!.issueDate, TODAY);
  assert.deepEqual(issued.issued!.supplyPeriod, { from: "2026-08-01", to: "2026-08-31" });
  assert.match(issued.issued!.number, /^RE-\d{4}-0001$/);
  assert.equal(store.findOrganisation("org_1")!.invoicing!.numberSeries!.next, numberBefore + 1);
  assert.equal(issued.issued!.vatTreatment.kind, "exempt", "the rule's tax line, as chosen");
  assert.equal((issued.issued!.vatTreatment as { reason: string }).reason, "not_taxable_place_of_supply");
  assert.equal(issued.issued!.recipient.name, "Example DAO Foundation");
});

await check("the issued invoice is paid by its receipts: gross equals what the rows settled, to the cent", () => {
  assert.equal(issued.state, "PAID");
  const settled = issued.settlements!.reduce((s, x) => s + Math.round(x.amountEur * 100), 0);
  assert.equal(issued.issued!.grossCents, settled);
  assert.equal(issued.issued!.grossCents, cents(issued.total));
  assert.equal(issued.issued!.vatCents, 0);
  assert.ok(issued.payment?.paidAt);
});

await check("an issued invoice cannot be issued again, and the client cannot supply its lines", async () => {
  assert.equal((await call("POST", `/org_1/income-invoices/${august.id}/issue`, { acceptWarnings: true })).status, 409);
  const [other] = await draftsFor("c_other", "2026-08");
  const r = await call("POST", `/org_1/income-invoices/${other.id}/issue`, { acceptWarnings: true, lines: [{ description: "x", quantity: "1", unitPriceNet: "9999.00" }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(store.findInvoice(other.id)!.issued!.grossCents, 7000);
});

await check("after issue the invoice is frozen: a re-run leaves it alone and puts a late receipt on a new draft for the same month", async () => {
  const frozen = JSON.stringify(store.findInvoice(august.id));
  store.addLedgerEntries([row({ id: "r_late", at: "2026-08-28T10:00:00.000Z", fiatValue: "3.00", amount: "3.75" })]);
  await run("2026-08");
  assert.equal(JSON.stringify(store.findInvoice(august.id)), frozen);
  const drafts = (await draftsFor("c_dao", "2026-08")).filter((i) => i.state === "DRAFT");
  assert.equal(drafts.length, 1);
  assert.notEqual(drafts[0].id, august.id);
  // r_eure was marked internal above and stays out; r_late is the only new row.
  assert.deepEqual(lineRows(drafts[0]), ["r_late"]);
  const all = (await invoices()).flatMap(settledRows);
  assert.equal(new Set(all).size, all.length, "no row on two invoices");
});

await check("a draft can be discarded; its rows are free for the next run, and the discarded draft is not shown", async () => {
  const [d] = (await draftsFor("c_dao", "2026-08")).filter((i) => i.state === "DRAFT");
  assert.equal((await call("DELETE", `/org_1/invoices/${d.id}`)).status, 200);
  assert.equal(store.findInvoice(d.id)!.state, "DELETED", "discarding is a state, not a delete");
  await run("2026-08");
  const again = (await draftsFor("c_dao", "2026-08")).filter((i) => i.state === "DRAFT");
  assert.equal(again.length, 1);
  assert.notEqual(again[0].id, d.id);
  assert.deepEqual(lineRows(again[0]), ["r_late"]);
});

await check("an issued invoice with receipts against it cannot be deleted", async () => {
  assert.equal((await call("DELETE", `/org_1/invoices/${august.id}`)).status, 409);
  assert.equal(store.findInvoice(august.id)!.state, "PAID");
});

await check("issuing refuses once the contact's rule is gone; removing the rule removes neither the contact nor the draft", async () => {
  const [d] = (await draftsFor("c_dao", "2026-08")).filter((i) => i.state === "DRAFT");
  assert.equal((await call("DELETE", "/org_1/contacts/c_dao/payer-rule")).status, 200);
  assert.ok(store.findContact("c_dao"), "removing the rule removes no contact");
  assert.equal(store.findContact("c_dao")!.payerRule, undefined);
  assert.equal((await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true })).status, 409);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

console.log("\nA tax line with a rate");

await check("with a standard rate the receipts are the gross: net and VAT are derived so the invoice total still equals what was received", async () => {
  // 119.00 received at 19% is 100.00 net and 19.00 VAT.
  store.addLedgerEntries([
    row({ id: "s_1", at: "2026-06-10T10:00:00.000Z", fiatValue: "59.50", amount: "70" }),
    row({ id: "s_2", at: "2026-06-11T10:00:00.000Z", fiatValue: "59.50", amount: "70" }),
  ]);
  const german = { ...RULE, vat: { kind: "standard", rate: 19 }, recipient: { ...RULE.recipient, country: "DE", postalCode: "10115", city: "Berlin" } };
  assert.equal((await call("PUT", "/org_1/contacts/c_dao/payer-rule", german)).status, 200);
  await run("2026-06");
  const [d] = await draftsFor("c_dao", "2026-06");
  assert.equal(cents(d.total), 11900);
  assert.equal(d.fromReceipts.mismatchCents, undefined);
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inv = store.findInvoice(d.id)!;
  assert.equal(inv.issued!.netCents, 10000);
  assert.equal(inv.issued!.vatCents, 1900);
  assert.equal(inv.issued!.grossCents, 11900);
  assert.equal(inv.state, "PAID");
});

await check("a received amount no net plus VAT adds up to is flagged on the draft and refused at issue: no invoice that differs from the money by a cent", async () => {
  // At 19%, no net gives 0.03 gross (0.02 -> 0.02, 0.03 -> 0.04).
  store.addLedgerEntries([row({ id: "s_gap", at: "2026-05-10T10:00:00.000Z", fiatValue: "0.03", amount: "0.04" })]);
  await run("2026-05");
  const [d] = await draftsFor("c_dao", "2026-05");
  assert.equal(cents(d.total), 3);
  assert.notEqual(d.fromReceipts.mismatchCents ?? 0, 0);
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

console.log("\nEvery receipt is accounted for");

// A second organisation with a clean ledger. Its rows carry no contact id, as
// rows synced before the address book was filled do.
const row2 = (over: Partial<LedgerEntry> & { id: string }) => row({ orgId: "org_2", counterparty: { address: DAO }, ...over });
const run2 = (month: string) => run(month, "org_2");
const drafts2 = (month: string) => draftsFor("c_dao2", month, "org_2");
const wallet2 = (over: Record<string, unknown> = {}) =>
  store.addImportedWallet({ id: `iw_${++seq}`, orgId: "org_2", address: `0x${String(seq).padStart(40, "0")}`, chainId: 1, label: "Treasury", kind: "safe", custody: "external", sync: { status: "synced", lastSyncedAt: NOW }, createdAt: "2025-01-01T00:00:00.000Z", ...over } as any);

await check("a receipt with no value from a sender without a rule or without a contact is counted, not dropped", async () => {
  store.addLedgerEntries([
    row2({ id: "u_valued", at: "2026-03-05T10:00:00.000Z", fiatValue: "11.00" }),
    row2({ id: "u_unvalued", at: "2026-03-06T10:00:00.000Z", fiatValue: undefined, fiatCurrency: undefined, tags: ["wallet", "needs-valuation"] }),
    row2({ id: "u_stranger", at: "2026-03-07T10:00:00.000Z", fiatValue: undefined, fiatCurrency: undefined, tags: ["wallet", "unlisted"], txType: "unlisted_token", counterparty: { address: STRANGER } }),
  ]);
  const r = await run2("2026-03");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.withoutRule, [{ contactId: "c_dao2", name: "Example DAO", receipts: 1, eurCents: 1100, unvalued: 1 }]);
  assert.deepEqual(r.body.withoutContact, { receipts: 0, eurCents: 0, unvalued: 1 });
  assert.deepEqual(await invoices("org_2"), []);
});

await check("the rule and the addresses it reads are saved together: a bad address saves neither", async () => {
  const bad = await call("PUT", "/org_2/contacts/c_dao2/payer-rule", { ...RULE, wallets: [{ chainId: 1, address: "0x123" }] });
  assert.equal(bad.status, 400);
  assert.equal(store.findContact("c_dao2")!.payerRule, undefined);
  const ok = await call("PUT", "/org_2/contacts/c_dao2/payer-rule", { ...RULE, wallets: [{ chainId: 1, address: DAO }, { chainId: 1, address: STREAM }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.contact.wallets.map((w: any) => w.address), [DAO, STREAM]);
  assert.equal(ok.body.contact.wallets[0].id, "w_c_dao2_0", "an address the contact already had keeps its id");
});

await check("a wallet that is behind, booked from mid-month, or skipped transfers is named by the run and on the draft", async () => {
  wallet2({ label: "Behind", sync: { status: "error", error: "rpc down" } });
  wallet2({ label: "Late start", sync: { status: "synced", lastSyncedAt: NOW, from: "2026-03-10" } });
  wallet2({ label: "Unreadable", sync: { status: "synced", lastSyncedAt: NOW, skipped: 2 } });
  wallet2({ label: "Stale", sync: { status: "synced", lastSyncedAt: "2026-03-20T00:00:00.000Z" } });
  wallet2({ label: "Fine" });
  const r = await run2("2026-03");
  const text = r.body.syncWarnings.join("\n");
  for (const name of ["Behind", "Late start", "Unreadable", "Stale"]) assert.match(text, new RegExp(name), name);
  assert.ok(!/Fine/.test(text), text);
  assert.ok(!/rpc down/.test(text), "the wallet's error text can carry a URL and stays out");
  const [d] = await drafts2("2026-03");
  assert.deepEqual(lineRows(d), ["u_valued"]);
  assert.deepEqual(d.fromReceipts.syncWarnings, r.body.syncWarnings);
});

await check("a draft shows who it is addressed to and the tax line, and issuing refuses if the rule was saved again since", async () => {
  const [d] = await drafts2("2026-03");
  assert.equal(d.fromReceipts.payerName, "Example DAO");
  assert.equal(d.fromReceipts.recipientName, "Example DAO Foundation");
  assert.equal(d.fromReceipts.vat.reason, "not_taxable_place_of_supply");
  assert.equal((await call("PUT", "/org_2/contacts/c_dao2/payer-rule", { ...RULE, recipient: { ...RULE.recipient, name: "Someone Else Ltd" } })).status, 200);
  const r = await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /payer rule/i);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
  assert.equal(store.findInvoice(d.id)!.fromReceipts!.recipientName, "Someone Else Ltd", "and the draft now shows the new recipient");
});

await check("receipts an issued invoice already bills, and receipts held by a draft whose rule is gone, are counted by a later run", async () => {
  const [d] = await drafts2("2026-03");
  assert.equal((await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true })).status, 201);
  store.addLedgerEntries([row2({ id: "u_later", at: "2026-03-25T10:00:00.000Z", fiatValue: "4.00" })]);
  const second = await run2("2026-03");
  assert.deepEqual(second.body.alreadyInvoiced, { receipts: 1 });
  const [followUp] = (await drafts2("2026-03")).filter((i) => i.state === "DRAFT");
  assert.deepEqual(lineRows(followUp), ["u_later"]);
  assert.equal((await call("DELETE", "/org_2/contacts/c_dao2/payer-rule")).status, 200);
  const third = await run2("2026-03");
  assert.deepEqual(third.body.onOtherDrafts, [{ invoiceId: followUp.id, contactId: "c_dao2", receipts: 1 }]);
  assert.deepEqual(lineRows(store.findInvoice(followUp.id)), ["u_later"], "the stale draft keeps its rows until it is issued or discarded");
});

await check("an address moved to another contact is billed to the contact that lists it now", async () => {
  addContact("c_new2", "org_2", "New Payer", [OTHER_DAO]);
  assert.equal((await call("PUT", "/org_2/contacts/c_new2/payer-rule", RULE)).status, 200);
  // Synced while c_dao2 listed the address; c_dao2 no longer does.
  store.addLedgerEntries([row2({ id: "u_moved", at: "2026-02-05T10:00:00.000Z", fiatValue: "9.00", counterparty: { address: OTHER_DAO, contactId: "c_dao2", name: "Example DAO" } })]);
  await run2("2026-02");
  assert.deepEqual((await draftsFor("c_new2", "2026-02", "org_2")).map(lineRows), [["u_moved"]]);
  assert.deepEqual(await drafts2("2026-02"), []);
});

await check("twenty receipts of one cent at 19% are issuable: the net is sought for the whole amount, not line by line", async () => {
  assert.equal((await call("PUT", "/org_2/contacts/c_dao2/payer-rule", { ...RULE, vat: { kind: "standard", rate: 19 }, recipient: { ...RULE.recipient, country: "DE" } })).status, 200);
  store.addLedgerEntries(Array.from({ length: 20 }, (_, i) => row2({ id: `cent_${String(i).padStart(2, "0")}`, at: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, fiatValue: "0.01", amount: "0.01" })));
  await run2("2026-01");
  const [d] = await drafts2("2026-01");
  assert.equal(d.fromReceipts.mismatchCents, undefined);
  assert.equal(cents(d.total), 20);
  const r = await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inv = store.findInvoice(d.id)!;
  assert.deepEqual([inv.issued!.netCents, inv.issued!.vatCents, inv.issued!.grossCents, inv.state], [17, 3, 20, "PAID"]);
});

await check("more receipts than an invoice holds: the first 200 are on the draft, the rest are named and wait for the next one", async () => {
  assert.equal((await call("PUT", "/org_2/contacts/c_dao2/payer-rule", RULE)).status, 200);
  store.addLedgerEntries(Array.from({ length: 203 }, (_, i) => row2({ id: `many_${String(i).padStart(3, "0")}`, at: new Date(Date.UTC(2025, 11, 1, 0, i)).toISOString(), fiatValue: "1.00", amount: "1" })));
  await run2("2025-12");
  const [d] = await drafts2("2025-12");
  assert.equal(d.lines.length, 200);
  assert.deepEqual(d.fromReceipts.excluded.map((x: any) => x.ledgerEntryId), ["many_200", "many_201", "many_202"]);
  assert.match(d.fromReceipts.excluded[0].reason, /200 lines/);
  assert.equal((await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true })).status, 201);
  await run2("2025-12");
  const [rest] = (await drafts2("2025-12")).filter((i) => i.state === "DRAFT");
  assert.deepEqual(lineRows(rest), ["many_200", "many_201", "many_202"]);
});

await check("rows that only look invoiceable are left out and named: a value in another currency, a zero value, no transaction, a type that says internal or unlisted under edited tags", async () => {
  store.addLedgerEntries([
    row2({ id: "x_ok", at: "2025-10-01T10:00:00.000Z", fiatValue: "5.00" }),
    row2({ id: "x_usd", at: "2025-10-02T10:00:00.000Z", fiatValue: "7.00", fiatCurrency: "USD" }),
    row2({ id: "x_zero", at: "2025-10-03T10:00:00.000Z", fiatValue: "0.00" }),
    row2({ id: "x_nohash", at: "2025-10-04T10:00:00.000Z", txHash: undefined }),
    row2({ id: "x_internal", at: "2025-10-05T10:00:00.000Z", tags: ["wallet"], txType: "internal_transfer" }),
    row2({ id: "x_unlisted", at: "2025-10-06T10:00:00.000Z", tags: ["wallet"], txType: "unlisted_token" }),
  ]);
  await run2("2025-10");
  const [d] = await drafts2("2025-10");
  assert.deepEqual(lineRows(d), ["x_ok"]);
  assert.deepEqual(d.fromReceipts.excluded.map((x: any) => x.ledgerEntryId), ["x_usd", "x_zero", "x_nohash", "x_internal", "x_unlisted"]);
  assert.ok(d.fromReceipts.excluded.every((x: any) => x.reason.length > 10));
});

await check("another organisation's draft cannot be issued through this one", async () => {
  const [d] = await drafts2("2025-10");
  const r = await call("POST", `/org_1/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 404);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

await check("a number already issued is refused; a number of one's own is used and does not advance the series", async () => {
  const [d] = await drafts2("2025-10");
  const taken = store.invoicesOf("org_2").find((i) => i.issued)!.issued!.number;
  const clash = await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true, number: taken });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
  const next = store.findOrganisation("org_2")!.invoicing!.numberSeries!.next;
  const own = await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true, number: "DAO-2025-10" });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.invoice.issued.number, "DAO-2025-10");
  assert.ok(own.body.invoice.issued.acceptedWarnings.some((w: string) => /^receipts: .*Behind/.test(w)), "the accepted incomplete-month warning is on the invoice");
  assert.equal(store.findOrganisation("org_2")!.invoicing!.numberSeries!.next, next);
});

await check("warnings must be accepted: without that the draft stays a draft, and the warnings are named", async () => {
  store.addLedgerEntries([row2({ id: "w_1", at: "2025-09-01T10:00:00.000Z", fiatValue: "5.00" })]);
  await run2("2025-09");
  const [d] = await drafts2("2025-09");
  const r = await call("POST", `/org_2/income-invoices/${d.id}/issue`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(r.body.warnings.length > 0);
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

await check("a draft whose receipts have all gone is not issuable", async () => {
  const [d] = await drafts2("2025-09");
  store.updateLedgerEntry("w_1", { txType: "internal_transfer" });
  assert.equal((await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true })).status, 409);
  const r = await call("POST", `/org_2/income-invoices/${d.id}/issue`, { acceptWarnings: true });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(store.findInvoice(d.id)!.state, "DRAFT");
});

await check("a wallet row whose time cannot be read stops the run and is named: skipped, it would be in no month", async () => {
  const before = store.invoicesOf("org_2").length;
  store.addLedgerEntries([row2({ id: "bad_time", at: "garbage", fiatValue: "5.00" })]);
  const r = await run2("2025-08");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /bad_time/);
  assert.equal(store.invoicesOf("org_2").length, before);
  store.updateLedgerEntry("bad_time", { at: "2020-01-01T00:00:00.000Z" });
});

await check("a reporting time zone that is none is refused by the run, which creates nothing", async () => {
  const before = store.invoicesOf("org_2").length;
  store.updateOrganisation("org_2", { reporting: { ...reporting, timeZone: "Mars/Olympus" } });
  const r = await run2("2025-08");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /time zone/i);
  assert.equal(store.invoicesOf("org_2").length, before);
  store.updateOrganisation("org_2", { reporting });
});

await check("the customer's view of an issued invoice has the printed columns and no ledger references", async () => {
  const { supplierView } = await import("../services/api/src/domain/invoices.js");
  const view = supplierView(store.findInvoice(august.id)!, "Zoldenburg");
  assert.ok(view.lines.length > 0);
  for (const line of view.lines) assert.deepEqual(Object.keys(line).sort(), ["amount", "description", "quantity", "unitPrice"]);
  assert.ok(!("fromReceipts" in view) && !("settlements" in view));
});

console.log("\nGating is a filter on reading");

await check("a plan change hides rules and drafts and deletes neither", async () => {
  const rulesBefore = store.contactsOf("org_1").filter((c) => c.payerRule).length;
  const invoicesBefore = store.invoicesOf("org_1").length;
  assert.ok(rulesBefore > 0 && invoicesBefore > 0);
  store.updateOrganisation("org_1", { plan: "starter" });
  const contacts = (await call("GET", "/org_1/contacts")).body.contacts;
  assert.ok(contacts.length > 0);
  assert.ok(contacts.every((c: any) => c.payerRule === undefined));
  assert.equal((await call("GET", "/org_1/invoices")).status, 402);
  const patched = await call("PATCH", "/org_1/contacts/c_other", { notes: "x" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.contact.payerRule, undefined, "an edit's answer hides the rule too");
  assert.equal(store.contactsOf("org_1").filter((c) => c.payerRule).length, rulesBefore);
  assert.equal(store.invoicesOf("org_1").length, invoicesBefore);
  store.updateOrganisation("org_1", { plan: "business" });
  assert.ok((await call("GET", "/org_1/contacts")).body.contacts.some((c: any) => c.payerRule));
});

server.close();
rpcServer.closeAllConnections();
rpcServer.close();
console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
