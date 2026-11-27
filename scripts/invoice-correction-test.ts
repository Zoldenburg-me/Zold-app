/**
 * A corrected invoice (§ 31 Abs. 5 UStDV) replaces an issued one: the next
 * number, the original's number and date printed on it, the issuer's details
 * as they are now. The original stays as REPLACED, its open link and its
 * payments move to the correction, and money that still names it settles the
 * correction, so the books count the pair once.
 *
 * In-process routers, no chain, no Monerium.
 *
 * Run: npm run invoice-correction:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-invoice-correction-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createInvoicingRoutes } = await import("../services/api/src/routes/business/invoicing.js");
const { createInvoiceRoutes } = await import("../services/api/src/routes/business/invoices.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");
const { attributeMoneriumOrder, attributeMoneriumOrderToInvoice } = await import("../services/api/src/routes/payment-requests.js");
const { recordInvoiceSettlement } = await import("../services/api/src/adapters/crypto-deposits.js");
const { projectStatementLines } = await import("../services/api/src/bookkeeping/statement.js");
const { assertDeletable, buildBankSettlement, settlementRef, settlementUpdate } = await import("../services/api/src/domain/invoices.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

await initStore();
const now = new Date().toISOString();
const SAFE = `0x${"1".repeat(40)}` as const;
await store.addUser({
  id: "u_owner", name: "Olga Owner", country: "DE", kycStatus: "approved", createdAt: now,
  address: SAFE, iban: "DE89370400440532013000", paymentPage: { handle: "olga", createdAt: now },
} as any);
await store.addUser({ id: "u_view", name: "Vic Viewer", country: "DE", kycStatus: "approved", createdAt: now } as any);
await store.addOrganisation({
  id: "org_de", type: "business", name: "Org DE", legalName: "Org DE GmbH", plan: "business",
  address: { line1: "1 Hauptstraße", postalCode: "10115", city: "Berlin", country: "DE" },
  reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {},
  invoicing: { vatId: "USt-IdNr. beantragt" },
  createdAt: now, updatedAt: now,
} as any);
for (const [userId, role] of [["u_owner", "owner"], ["u_view", "viewer"]]) {
  await store.addMember({ id: `m_${userId}`, orgId: "org_de", userId, email: "", role: role as any, status: "active", invitedAt: now, acceptedAt: now });
}
await store.addAccount({
  id: "acc_de", orgId: "org_de", currency: "EUR", label: "EUR", status: "active", provider: "monerium",
  identifier: { iban: "DE89370400440532013000" }, backingUserId: "u_owner", createdAt: now, updatedAt: now,
} as any);

const app = express();
app.use(express.json());
const requireSession = async (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const ctxOf = async (req: any, res: any) => await resolveOrg(req, res, requireSession);
app.use("/api/orgs", createInvoicingRoutes({ ctxOf }));
app.use("/api/orgs", createInvoiceRoutes({ ctxOf }));
app.use("/api/invoice-links", createInvoiceLinkRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, asUser?: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(asUser ? { "x-user": asUser } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const reverseCharge = {
  recipient: { name: "Kund AB", addressLine: "Gatan 1", postalCode: "11122", city: "Stockholm", country: "SE", isBusiness: true, vatId: "SE556677889901" },
  supplyKind: "services",
  supplyDate: now.slice(0, 10),
  lines: [{ description: "Consulting", quantity: "2", unitPriceNet: "50.00" }],
  vat: { kind: "exempt", reason: "reverse_charge_eu" },
  acceptWarnings: true,
};
const links = async (invoiceId: string) => (await store.list("paymentRequests")).filter((p) => p.invoiceId === invoiceId);
const correct = (id: string, asUser = "u_owner", body: unknown = { acceptWarnings: true }) =>
  call("POST", `/api/orgs/org_de/invoices/${id}/correct`, asUser, body);

let first: any;
await check("an invoice issued with 'USt-IdNr. beantragt' has its pay link", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, true, JSON.stringify(r.data.payment));
  first = r.data;
});

await check("a correction still carrying the VAT ID note asks for its warnings first: nothing changes", async () => {
  const r = await correct(first.invoice.id, "u_owner", {});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.ok(r.data.warnings.some((w: any) => w.field === "issuer.vatId"), JSON.stringify(r.data.warnings));
  assert.equal((await store.findInvoice(first.invoice.id))!.state, "SUBMITTED");
  assert.equal((await links(first.invoice.id))[0].state, "OPEN");
});

await check("a viewer cannot correct, and another org's id is a 404", async () => {
  assert.equal((await correct(first.invoice.id, "u_view")).status, 403);
  assert.equal((await call("POST", "/api/orgs/org_de/invoices/inv_nope/correct", "u_owner", {})).status, 404);
});

let second: any;
let handedLink: any;
await check("with the granted number: a new number, the original's printed, the original REPLACED and its link handed over", async () => {
  const oldLink = (await links(first.invoice.id))[0];
  await store.patchOrgSub("org_de", "invoicing", (cur) => ({ ...(cur ?? {}), vatId: "DE123456789" }));
  const r = await correct(first.invoice.id);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  second = r.data;
  const c = second.invoice.issued;
  assert.notEqual(c.number, first.invoice.issued.number);
  assert.equal(c.number.slice(0, -4), first.invoice.issued.number.slice(0, -4), "the same series");
  assert.deepEqual(c.corrects, { invoiceId: first.invoice.id, number: first.invoice.issued.number, issueDate: first.invoice.issued.issueDate });
  assert.equal(c.issuer.vatId, "DE123456789");
  assert.equal(c.grossCents, first.invoice.issued.grossCents);
  assert.ok(!c.acceptedWarnings.some((w: string) => w.startsWith("issuer.vatId")), "no 'applied for' warning on the correction");
  const old = (await store.findInvoice(first.invoice.id))!;
  assert.equal(old.state, "REPLACED");
  assert.equal(old.issued!.number, first.invoice.issued.number, "never renumbered");
  assert.equal(old.replacedBy?.invoiceId, second.invoice.id);
  assert.equal((await links(first.invoice.id)).length, 0);
  handedLink = (await links(second.invoice.id))[0];
  assert.equal(handedLink.id, oldLink.id, "the same link, so the customer's saved reference still pays");
  assert.equal(handedLink.state, "OPEN");
  assert.equal(second.payment.ok, true);
  assert.equal(second.payment.reused, true, "no second link");
  assert.throws(() => assertDeletable(old), /stays in your records/);
});

await check("the old link says it was replaced and offers no Pay; the new one prints the reference", async () => {
  const oldView = await call("GET", `/api/invoice-links/${first.linkToken}`);
  assert.equal(oldView.status, 200);
  assert.deepEqual(oldView.data.invoice.replacedBy, { number: second.invoice.issued.number, issueDate: second.invoice.issued.issueDate });
  assert.equal(oldView.data.invoice.payPath, undefined);
  const newView = await call("GET", `/api/invoice-links/${second.linkToken}`);
  assert.deepEqual(newView.data.invoice.issued.corrects, { number: first.invoice.issued.number, issueDate: first.invoice.issued.issueDate });
  assert.ok(newView.data.invoice.payPath);
});

await check("a replaced invoice is not corrected twice", async () => {
  const r = await correct(first.invoice.id);
  assert.equal(r.status, 409);
  assert.match(r.data.error, new RegExp(second.invoice.issued.number));
});

await check("a bank transfer carrying the old link's code settles the correction", async () => {
  const r = await attributeMoneriumOrder({
    id: "ord-old-code", kind: "issue", amount: "40.00", address: SAFE, memo: `Ref ${handedLink.code}`,
    meta: { state: "processed", processedAt: new Date().toISOString() },
  });
  assert.equal(r?.id, handedLink.id);
  assert.equal((await store.findInvoice(first.invoice.id))!.settlements, undefined, "nothing lands on the replaced one");
  const c = (await store.findInvoice(second.invoice.id))!;
  assert.equal(c.settlements?.length, 1);
  assert.equal(c.state, "SUBMITTED", "part-paid");
});

await check("a settlement written straight at a replaced row is refused", async () => {
  const s = buildBankSettlement({ id: "ord-race", kind: "issue", amount: "1.00", address: SAFE, memo: "x", meta: { state: "processed", processedAt: now } } as any, "invoice-number");
  assert.equal(await store.settleInvoice(first.invoice.id, settlementRef(s), (row) => settlementUpdate(row, s)), null);
  assert.equal((await store.findInvoice(first.invoice.id))!.settlements, undefined);
});

await check("a bank transfer quoting the replaced number settles the correction", async () => {
  await attributeMoneriumOrderToInvoice({
    id: "ord-old-number", kind: "issue", amount: "60.00", address: SAFE, memo: `${first.invoice.issued.number} thanks`,
    meta: { state: "processed", processedAt: new Date().toISOString() },
  } as any);
  assert.equal((await store.findInvoice(first.invoice.id))!.settlements, undefined, "nothing lands on the replaced one");
  const c = (await store.findInvoice(second.invoice.id))!;
  assert.equal(c.settlements?.length, 2);
  assert.equal(c.state, "PAID");
});

await check("a deposit still naming the replaced invoice settles the correction", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  const fixed = await correct(r.data.invoice.id);
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  await recordInvoiceSettlement({
    id: "dep-late", userId: "u_owner", token: "EURE", txHash: `0x${"ab".repeat(32)}`, amount: "100", amountEur: 100,
    detectedAt: now, settledAt: now, invoiceId: r.data.invoice.id, from: `0x${"2".repeat(40)}`, txs: [], creditedEur: 100,
  } as any);
  assert.equal((await store.findInvoice(r.data.invoice.id))!.settlements, undefined);
  assert.equal((await store.findInvoice(fixed.data.invoice.id))!.settlements?.length, 1);
});

let paidOriginal: any;
let paidCorrection: any;
await check("a paid invoice's payment carries over: the correction is paid, with no new link", async () => {
  await store.patchOrgSub("org_de", "invoicing", (cur) => ({ ...(cur ?? {}), vatId: "USt-IdNr. beantragt" }));
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = buildBankSettlement({ id: "ord-paid", kind: "issue", amount: "100.00", address: SAFE, memo: "x", meta: { state: "processed", processedAt: now } } as any, "invoice-number");
  await store.settleInvoice(r.data.invoice.id, settlementRef(s), (row) => settlementUpdate(row, s));
  assert.equal((await store.findInvoice(r.data.invoice.id))!.state, "PAID");
  await store.patchOrgSub("org_de", "invoicing", (cur) => ({ ...(cur ?? {}), vatId: "DE123456789" }));
  const before = (await store.list("paymentRequests")).length;
  const fixed = await correct(r.data.invoice.id);
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  assert.equal(fixed.data.invoice.state, "PAID");
  assert.equal(fixed.data.invoice.settlements.length, 1);
  assert.equal(fixed.data.payment, undefined);
  assert.equal((await store.list("paymentRequests")).length, before, "nothing left to collect");
  paidOriginal = (await store.findInvoice(r.data.invoice.id))!;
  paidCorrection = (await store.findInvoice(fixed.data.invoice.id))!;
  assert.equal(paidOriginal.state, "REPLACED");
  assert.equal(paidOriginal.settlements.length, 1, "the original keeps its record of the payment");
});

await check("the statement books that payment once, against the correction", () => {
  const lines = projectStatementLines({
    orgId: "org_de", accountId: "acc_de", userId: "u_owner", safeAddress: SAFE, timeZone: "UTC",
    transfers: [], deposits: [], sweeps: [], paymentRequests: [], swapsHaveExecuted: false,
    issueOrders: [{ orderId: "ord-paid", userId: "u_owner", accountId: "acc_de", amountEur: 100, processedAt: now, recordedAt: now, memo: "x" } as any],
    invoices: [paidOriginal, paidCorrection],
  });
  const settling = lines.filter((l) => l.statement?.links.invoiceId);
  assert.equal(settling.length, 1, JSON.stringify(lines.map((l) => l.statement)));
  assert.equal(settling[0].statement!.links.invoiceId, paidCorrection.id);
  assert.match(settling[0].statement!.reference, new RegExp(paidCorrection.issued.number));
});

await check("money a link took that has not settled the invoice yet blocks a correction", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  const link = (await links(r.data.invoice.id))[0];
  await store.updatePaymentRequest(link.id, { state: "PAID", payments: [{ id: "p1", method: "crypto", ref: "deposit:d1", amountEur: 100, kind: "full", at: now } as any] });
  const fixed = await correct(r.data.invoice.id);
  assert.equal(fixed.status, 409, JSON.stringify(fixed.data));
  assert.equal((await store.findInvoice(r.data.invoice.id))!.state, "SUBMITTED");
});

await check("a part-paid invoice whose link lapsed gets no new full-amount link", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  const link = (await links(r.data.invoice.id))[0];
  await store.updatePaymentRequest(link.id, { state: "EXPIRED" });
  const s = buildBankSettlement({ id: "ord-part", kind: "issue", amount: "40.00", address: SAFE, memo: "x", meta: { state: "processed", processedAt: now } } as any, "invoice-number");
  await store.settleInvoice(r.data.invoice.id, settlementRef(s), (row) => settlementUpdate(row, s));
  const before = (await store.list("paymentRequests")).length;
  const fixed = await correct(r.data.invoice.id);
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  assert.equal(fixed.data.invoice.state, "SUBMITTED");
  assert.equal(fixed.data.invoice.settlements.length, 1, "the 40 carries over");
  assert.equal(fixed.data.payment, undefined);
  assert.equal((await store.list("paymentRequests")).length, before);
});

await check("the customer's details and the lines' wording can be corrected; the total cannot", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  // Refused before the warnings are asked about.
  const changedTotal = await correct(r.data.invoice.id, "u_owner", { lines: [{ description: "Consulting", quantity: "3", unitPriceNet: "50.00" }] });
  assert.equal(changedTotal.status, 422, JSON.stringify(changedTotal.data));
  assert.equal((await store.findInvoice(r.data.invoice.id))!.state, "SUBMITTED");
  const fixed = await correct(r.data.invoice.id, "u_owner", {
    acceptWarnings: true,
    recipient: { ...reverseCharge.recipient, name: "Kund Sverige AB", addressLine: "Nya gatan 7" },
    lines: [{ description: "Consulting, May", quantity: "1", unitPriceNet: "60.00" }, { description: "Travel", quantity: "1", unitPriceNet: "40.00" }],
    // Not correctable: the treatment stays the original's.
    vat: { kind: "standard", rate: 19 },
  });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  const c = fixed.data.invoice;
  assert.equal(c.issued.recipient.name, "Kund Sverige AB");
  assert.equal(c.issued.recipient.addressLine, "Nya gatan 7");
  assert.deepEqual(c.lines.map((l: any) => l.description), ["Consulting, May", "Travel"]);
  assert.equal(c.issued.vatTreatment.kind, "exempt");
  assert.equal(c.issued.grossCents, r.data.invoice.issued.grossCents);
});

await check("an amount that no longer matches is refused, not issued", async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  // The correction is built from the original's own lines and treatment, so
  // only a stored total that disagrees with them can make the two differ.
  await store.updateInvoice(r.data.invoice.id, { issued: { ...r.data.invoice.issued, grossCents: 999 } } as any);
  const fixed = await correct(r.data.invoice.id);
  assert.equal(fixed.status, 422, JSON.stringify(fixed.data));
  assert.equal((await store.findInvoice(r.data.invoice.id))!.state, "SUBMITTED");
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
