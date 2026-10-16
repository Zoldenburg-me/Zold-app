/**
 * The business profile is where the issuer's identity lives, invoices follow
 * the issuer's country rather than Germany, and an issued invoice's link is
 * the one thing the customer needs: it shows the invoice and, when the
 * account can take payments, a Pay button.
 *
 * In-process routers, no chain, no Monerium.
 *
 * Run: npm run invoicing-profile:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-invoicing-profile-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { createOrgRouter } = await import("../services/api/src/routes/orgs.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createInvoicingRoutes } = await import("../services/api/src/routes/business/invoicing.js");
const { createPaymentLinkRoutes } = await import("../services/api/src/routes/business/payment-links.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");
const { linkExpiry } = await import("../services/api/src/routes/business/invoice-pay-link.js");
const { createPaymentRequest } = await import("../services/api/src/routes/payment-requests.js");
const { defaultInvoiceLanguage, defaultSeriesFor, invoiceLanguage } = await import("../services/api/src/domain/invoicing.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
// The payee: their own account backs the paying org, with an IBAN and a page.
store.addUser({
  id: "u_owner", name: "Olga Owner", country: "DE", kycStatus: "approved", createdAt: now,
  address: `0x${"1".repeat(40)}`, iban: "DE89370400440532013000",
  paymentPage: { handle: "olga", createdAt: now },
} as any);
store.addUser({ id: "u_payer", name: "Pat Payer", country: "DE", kycStatus: "approved", createdAt: now } as any);

function addOrg(id: string, country: string, over: Record<string, unknown> = {}) {
  store.addOrganisation({
    id, type: "business", name: `Org ${id}`, legalName: `Org ${id} Ltd`, plan: "business",
    address: { line1: "1 Main Street", postalCode: "1000", city: "Capital", country },
    reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {},
    createdAt: now, updatedAt: now, ...over,
  } as any);
  for (const [userId, role] of [["u_owner", "owner"], ["u_payer", "payer"]]) {
    store.addMember({ id: `m_${id}_${userId}`, orgId: id, userId, email: "", role: role as any, status: "active", invitedAt: now, acceptedAt: now });
  }
}

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const ctxOf = (req: any, res: any) => resolveOrg(req, res, requireSession);
app.use("/api/orgs", createOrgRouter(requireSession));
app.use("/api/orgs", createInvoicingRoutes({ ctxOf }));
app.use("/api/orgs", createPaymentLinkRoutes({ ctxOf }));
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
const invoiceFor = (country: string) => ({
  recipient: { name: "Customer SA", addressLine: "2 Side Road", postalCode: "2000", city: "Town", country, isBusiness: false },
  supplyDate: new Date().toISOString().slice(0, 10),
  lines: [{ description: "Consulting", quantity: "1", unitPriceNet: "100.00" }],
  vat: { kind: "standard", rate: 18 },
  acceptWarnings: true,
});

console.log("\nDefaults follow the issuer's country");

await check("German-speaking issuers start in German with RE-, everyone else in English with INV-", () => {
  assert.equal(defaultInvoiceLanguage("DE"), "de");
  assert.equal(defaultInvoiceLanguage("AT"), "de");
  assert.equal(defaultInvoiceLanguage("FR"), "fr");
  assert.equal(defaultInvoiceLanguage("ES"), "es");
  assert.equal(defaultInvoiceLanguage("GA"), "en");
  assert.equal(defaultInvoiceLanguage(undefined), "en");
  assert.equal(defaultSeriesFor("DE").prefix, "RE-{YYYY}-");
  assert.equal(defaultSeriesFor("IN").prefix, "INV-{YYYY}-");
  assert.equal(invoiceLanguage("", undefined), "en");
  assert.equal(invoiceLanguage(undefined, "de"), "de", "a language the org chose wins");
  assert.equal(invoiceLanguage("fr", "de"), "fr", "an invoice can be written in French");
});

addOrg("org_ga", "GA");
addOrg("org_de", "DE");
await check("the invoicing profile of a Gabonese entity defaults to English and INV-", async () => {
  const r = await call("GET", "/api/orgs/org_ga/invoicing/profile", "u_owner");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.profile.language, "en");
  assert.equal(r.data.profile.numberSeries.prefix, "INV-{YYYY}-");
  const de = await call("GET", "/api/orgs/org_de/invoicing/profile", "u_owner");
  assert.equal(de.data.profile.language, "de");
  assert.equal(de.data.profile.numberSeries.prefix, "RE-{YYYY}-");
});

console.log("\nOne business profile, read by invoicing");

await check("tax and registration numbers saved on the business profile are what invoices print", async () => {
  const r = await call("PATCH", "/api/orgs/org_ga", "u_owner", {
    vatId: "GA-NIF 123456 X", taxNumber: "RCCM 2020 B 1234", registerCourt: "RCCM Libreville", registerNumber: "2020 B 1234", managingDirector: "Ada Mba",
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.organisation.issuerDetails.vatId, "GA-NIF 123456 X", "a number Zold has no format for is kept as written");
  const p = await call("GET", "/api/orgs/org_ga/invoicing/profile", "u_owner");
  assert.equal(p.data.issuer.vatId, "GA-NIF 123456 X");
  assert.equal(p.data.issuer.taxNumber, "RCCM 2020 B 1234");
  assert.equal(p.data.profile.registerCourt, "RCCM Libreville");
});

await check("a German entity's numbers are checked as German on the business profile too", async () => {
  const bad = await call("PATCH", "/api/orgs/org_de", "u_owner", { taxNumber: "12" });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(bad.data.field, "taxNumber");
  const ok = await call("PATCH", "/api/orgs/org_de", "u_owner", { vatId: "de 123 456 789" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(store.findOrganisation("org_de")!.invoicing?.vatId, "DE123456789");
});

await check("the numbers are checked by the country the same save moves the entity to", async () => {
  const r = await call("PATCH", "/api/orgs/org_de", "u_owner", {
    address: { line1: "1 Main Street", postalCode: "1000", city: "Capital", country: "GA" }, taxNumber: "NIF-77",
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.findOrganisation("org_de")!.invoicing?.taxNumber, "NIF-77");
  await call("PATCH", "/api/orgs/org_de", "u_owner", { address: { line1: "1 Main Street", postalCode: "1000", city: "Capital", country: "DE" } });
});

addOrg("org_signup", "FR", { taxId: "FR40303265045" });
await check("the tax id typed at signup stands in until the business profile sets one, then is gone", async () => {
  const before = await call("GET", "/api/orgs/org_signup/invoicing/profile", "u_owner");
  assert.equal(before.data.issuer.vatId, "FR40303265045");
  const r = await call("PATCH", "/api/orgs/org_signup", "u_owner", { vatId: "", taxNumber: "SIREN 303 265 045" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.findOrganisation("org_signup")!.taxId, undefined);
  const after = await call("GET", "/api/orgs/org_signup/invoicing/profile", "u_owner");
  assert.equal(after.data.issuer.vatId, undefined, "a cleared VAT ID does not come back from signup");
  assert.equal(after.data.issuer.taxNumber, "SIREN 303 265 045");
});

addOrg("org_clear", "FR", { taxId: "FR40303265045" });
await check("clearing the numbers the form showed clears them: the signup tax id does not print again", async () => {
  const r = await call("PATCH", "/api/orgs/org_clear", "u_owner", { vatId: "", taxNumber: "" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.findOrganisation("org_clear")!.taxId, undefined);
  const p = await call("GET", "/api/orgs/org_clear/invoicing/profile", "u_owner");
  assert.equal(p.data.issuer.vatId, undefined);
  assert.equal(p.data.issuer.taxNumber, undefined);
});

addOrg("org_badsignup", "FR", { taxId: "DE123456789" });
await check("a signup tax id that fails the country's check is neither printed nor offered in the form", async () => {
  const p = await call("GET", "/api/orgs/org_badsignup/invoicing/profile", "u_owner");
  assert.equal(p.data.issuer.vatId, undefined, "a German VAT ID does not print for a French entity");
  const r = await call("PATCH", "/api/orgs/org_badsignup", "u_owner", { name: "Org renamed" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.organisation.issuerDetails.vatId, undefined);
});

addOrg("org_prefix", "DE", { invoicing: { vatId: "DE123456789" } });
await check("an EU VAT ID must be the issuer's own country's", async () => {
  const r = await call("PATCH", "/api/orgs/org_prefix", "u_owner", { vatId: "FR40303265045" });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.field, "vatId");
  const moved = await call("PATCH", "/api/orgs/org_prefix", "u_owner", { address: { line1: "1 Rue", postalCode: "75001", city: "Paris", country: "FR" } });
  assert.equal(moved.status, 400, "a stored DE VAT ID does not survive a move to France");
  assert.equal(moved.data.field, "vatId");
  const prof = await call("PATCH", "/api/orgs/org_prefix/invoicing/profile", "u_owner", { vatId: "ATU12345678" });
  assert.equal(prof.status, 400, "the invoicing profile checks the same");
});

addOrg("org_move_tax", "DE", { invoicing: { taxNumber: "12/345/67890" } });
await check("moving country re-checks a stored tax number the save does not replace", async () => {
  const r = await call("PATCH", "/api/orgs/org_move_tax", "u_owner", { address: { line1: "1 Rue", postalCode: "75001", city: "Paris", country: "FR" } });
  assert.equal(r.status, 200, "a German Steuernummer is still one line of digits under EU rules");
  const back = await call("PATCH", "/api/orgs/org_move_tax", "u_owner", { address: { line1: "1 Str", postalCode: "10115", city: "Berlin", country: "DE" }, taxNumber: "12" });
  assert.equal(back.status, 400, JSON.stringify(back.data));
  assert.equal(back.data.field, "taxNumber");
});

addOrg("org_move", "GA", { invoicing: { vatId: "GA-NIF 123456 X" } });
await check("moving country re-checks a stored VAT ID the save does not replace", async () => {
  const r = await call("PATCH", "/api/orgs/org_move", "u_owner", { address: { line1: "1 Rue", postalCode: "75001", city: "Paris", country: "FR" } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.field, "vatId");
  assert.equal(store.findOrganisation("org_move")!.address?.country, "GA", "nothing is saved");
  const ok = await call("PATCH", "/api/orgs/org_move", "u_owner", { address: { line1: "1 Rue", postalCode: "75001", city: "Paris", country: "FR" }, vatId: "FR40303265045" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(store.findOrganisation("org_move")!.invoicing?.vatId, "FR40303265045");
});

await check("a payer, who may manage invoices but not the organisation, cannot edit the business profile", async () => {
  const r = await call("PATCH", "/api/orgs/org_ga", "u_payer", { vatId: "X" });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(store.findOrganisation("org_ga")!.invoicing?.vatId, "GA-NIF 123456 X");
});

await check("registration text is one bounded line", async () => {
  const r = await call("PATCH", "/api/orgs/org_ga", "u_owner", { registerNumber: "a\nb" });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.field, "registerNumber");
});

console.log("\nIssuing gives one link: the invoice, with a Pay button when it can be paid");

await check("without an account to pay into, the invoice is issued and says why there is no Pay button", async () => {
  const r = await call("POST", "/api/orgs/org_ga/invoicing/issue", "u_owner", invoiceFor("GA"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.invoice.issued.number, /^INV-\d{4}-0001$/);
  assert.equal(r.data.invoice.issued.language, "en");
  assert.equal(r.data.payment.ok, false);
  assert.equal(r.data.payment.code, "ACCOUNT_NOT_OPEN");
  const view = await call("GET", `/api/invoice-links/${r.data.linkToken}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.invoice.payPath, undefined);
  assert.match(view.data.invoice.footerNote, /Managing director: Ada Mba/, "the footer speaks the invoice's language");
  assert.ok(!/Geschäftsführ/.test(view.data.invoice.footerNote));
});

addOrg("org_pay", "FR", { invoicing: { vatId: "FR40303265045" } });
store.addAccount({
  id: "acc_pay", orgId: "org_pay", currency: "EUR", label: "EUR", status: "active", provider: "monerium",
  identifier: { iban: "DE89370400440532013000" }, backingUserId: "u_owner", createdAt: now, updatedAt: now,
} as any);
let token = "";
let invoiceId = "";
let unlinkedInvoiceId = "";
let unlinkedToken = "";
await check("with the payee's own account behind it, issuing makes the invoice's payment link", async () => {
  const r = await call("POST", "/api/orgs/org_pay/invoicing/issue", "u_owner", invoiceFor("FR"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, true, JSON.stringify(r.data.payment));
  assert.equal(r.data.payment.amountEur, 118);
  assert.match(r.data.payment.url, /\/pay\/olga\//);
  token = r.data.linkToken;
  invoiceId = r.data.invoice.id;
  const link = store.paymentRequests.find((p) => p.invoiceId === invoiceId)!;
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 29 * 86_400_000, "the link outlives the default week");
});

await check("a foreign-currency invoice carries its euro restatement — or refuses when no feed has the rate", async () => {
  // The reference feed pinned, as the offline harness runs it: USD converts,
  // GBP is a currency no feed here publishes.
  process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.14, KES: 147.53 });
  try {
    const ok = await call("POST", "/api/orgs/org_pay/invoicing/issue", "u_owner", { ...invoiceFor("FR"), currency: "USD" });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    const conv = ok.data.invoice.issued.conversion;
    assert.equal(ok.data.invoice.issued.currency, "USD");
    assert.equal(conv.to, "EUR");
    assert.equal(conv.rate, 1.14);
    assert.equal(conv.grossCents, 10351, "118 USD at 1.14 restated per bucket, not off the total");
    // And the Pay button asks for the euro amount, not the dollar figure.
    assert.equal(ok.data.payment.amountEur, 103.51, JSON.stringify(ok.data.payment));
    const refused = await call("POST", "/api/orgs/org_pay/invoicing/issue", "u_owner", { ...invoiceFor("FR"), currency: "GBP" });
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
    assert.match(refused.data.error, /has not been issued/);
  } finally {
    delete process.env.TRANSF_RATES_FIXED;
  }
});

await check("the invoice link shows the Pay button, and the payment link is the one made at issue", async () => {
  const view = await call("GET", `/api/invoice-links/${token}`);
  assert.equal(view.status, 200);
  const link = store.paymentRequests.find((p) => p.invoiceId === invoiceId)!;
  assert.ok(view.data.invoice.payPath?.startsWith("/pay/olga/"), JSON.stringify(view.data.invoice.payPath));
  assert.equal(view.data.invoice.payPath.replace(/-/g, "").endsWith(link.code.replace(/-/g, "")), true);
});

await check("asking for the invoice's payment link again returns the open one, never a second", async () => {
  const r = await call("POST", "/api/orgs/org_pay/payment-requests", "u_owner", { invoiceId, methods: ["bank"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reused, true, "the caller is told the link is the existing one");
  assert.equal(store.paymentRequests.filter((p) => p.invoiceId === invoiceId).length, 1);
});

await check("a member whose account does not back the org gets the invoice and the reason, not a link", async () => {
  const r = await call("POST", "/api/orgs/org_pay/invoicing/issue", "u_payer", invoiceFor("FR"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, false);
  assert.equal(r.data.payment.code, "NOT_THE_PAYEE");
  unlinkedInvoiceId = r.data.invoice.id;
  unlinkedToken = r.data.linkToken;
});

await check("two requests at once for an invoice's link make one link, not two", async () => {
  const [a, b] = await Promise.all([
    call("POST", "/api/orgs/org_pay/payment-requests", "u_owner", { invoiceId: unlinkedInvoiceId, methods: ["bank"] }),
    call("POST", "/api/orgs/org_pay/payment-requests", "u_owner", { invoiceId: unlinkedInvoiceId, methods: ["bank"] }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.data, b.data]));
  assert.deepEqual([a.data.reused, b.data.reused].sort(), [false, true]);
  assert.equal(store.paymentRequests.filter((p) => p.invoiceId === unlinkedInvoiceId).length, 1);
});

await check("no route makes a second open link for an invoice, even outside the lock", async () => {
  const owner = store.findUser("u_owner")!;
  await assert.rejects(
    createPaymentRequest(owner, { invoiceId: unlinkedInvoiceId, methods: ["bank"], expiresAt: linkExpiry(undefined) }, { kind: "app" }, "org_pay"),
    (err: any) => err.status === 409,
  );
  assert.equal(store.paymentRequests.filter((p) => p.invoiceId === unlinkedInvoiceId).length, 1);
});

await check("a throw while making the Pay button still answers 201 for the issued invoice", async () => {
  // The user lookup sits before the old try/catch; issuing itself does not use it.
  const findUser = store.findUser;
  (store as any).findUser = () => { throw new Error("malformed user row"); };
  const before = store.invoices.length;
  const r = await call("POST", "/api/orgs/org_pay/invoicing/issue", "u_owner", invoiceFor("FR")).finally(() => {
    (store as any).findUser = findUser;
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, false);
  assert.equal(r.data.payment.code, "ERROR");
  assert.ok(!/malformed user/.test(JSON.stringify(r.data)), "the cause is logged, not sent");
  assert.equal(store.invoices.length, before + 1, "the invoice is issued once");
});

await check("an unpaid invoice whose link expired says so instead of losing the Pay button silently", async () => {
  const link = store.paymentRequests.find((p) => p.invoiceId === unlinkedInvoiceId)!;
  link.expiresAt = new Date(Date.now() - 1000).toISOString();
  const view = await call("GET", `/api/invoice-links/${unlinkedToken}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.invoice.payPath, undefined);
  assert.equal(view.data.invoice.payLinkLapsed, true);
});

await check("the invoice link leaves out the warnings the issuer accepted", async () => {
  const inv = store.findInvoice(invoiceId)!;
  store.updateInvoice(invoiceId, { issued: { ...inv.issued!, acceptedWarnings: ["receipts: Treasury cold wallet is not synced"] } });
  const view = await call("GET", `/api/invoice-links/${token}`);
  assert.equal(view.status, 200);
  assert.ok(view.data.invoice.issued.number, "the issued document is still there");
  assert.equal("acceptedWarnings" in view.data.invoice.issued, false);
  assert.doesNotMatch(JSON.stringify(view.data), /Treasury cold wallet/);
});

await check("the invoice link carries only the printed fields of the issued document", async () => {
  const inv = store.findInvoice(invoiceId)!;
  const issued = {
    ...inv.issued!,
    internalMemo: "issuer-only memo",
    recipientVatCheck: { vatId: "DE123456789", status: "valid" as const, checkedAt: "2026-10-01T00:00:00Z", requestIdentifier: "VIES-REQ-1" },
  };
  store.updateInvoice(invoiceId, { issued });
  const view = await call("GET", `/api/invoice-links/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.invoice.issued.number, inv.issued!.number);
  assert.equal("internalMemo" in view.data.invoice.issued, false);
  assert.equal("recipientVatCheck" in view.data.invoice.issued, false);
  assert.doesNotMatch(JSON.stringify(view.data), /issuer-only memo|VIES-REQ-1/);
});

await check("a paid invoice shows no Pay button", async () => {
  store.updateInvoice(invoiceId, { state: "PAID" });
  const view = await call("GET", `/api/invoice-links/${token}`);
  assert.equal(view.data.invoice.payPath, undefined);
});

await check("a link lives until 60 days after the due date, at least 30 days, at most a year", () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const days = (iso: string) => Math.round((Date.parse(iso) - at.getTime()) / 86_400_000);
  assert.equal(days(linkExpiry(undefined, at)), 30);
  assert.equal(days(linkExpiry("2026-01-31", at)), 91);
  assert.equal(days(linkExpiry("2027-06-01", at)), 364);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
