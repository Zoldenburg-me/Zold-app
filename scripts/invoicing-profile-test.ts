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
const { createInvoiceRoutes } = await import("../services/api/src/routes/business/invoices.js");
const { linkExpiry } = await import("../services/api/src/routes/business/invoice-pay-link.js");
const { createPaymentRequest, attributeMoneriumOrderToInvoice } = await import("../services/api/src/routes/payment-requests.js");
const { publicPaymentRequest } = await import("../services/api/src/payment-requests.js");
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

await check("nor rewrite the issuer's identity, footer or custom fields through the invoicing profile, though the rest of it saves", async () => {
  const r = await call("PATCH", "/api/orgs/org_ga/invoicing/profile", "u_payer", {
    vatId: "GA-NIF 999999 Z", taxNumber: "RCCM 2099 B 9", registerCourt: "Elsewhere", registerNumber: "9", managingDirector: "Mallory",
  });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  const inv = store.findOrganisation("org_ga")!.invoicing!;
  assert.equal(inv.vatId, "GA-NIF 123456 X");
  assert.equal(inv.managingDirector, "Ada Mba");
  const footer = await call("PATCH", "/api/orgs/org_ga/invoicing/profile", "u_payer", { footerNote: "VAT ID DE999999999" });
  assert.equal(footer.status, 403, JSON.stringify(footer.data));
  const fields = await call("PATCH", "/api/orgs/org_ga/invoicing/profile", "u_payer", { customFields: [{ label: "VAT ID", value: "DE999999999" }] });
  assert.equal(fields.status, 403, JSON.stringify(fields.data));
  assert.equal(inv.footerNote, store.findOrganisation("org_ga")!.invoicing!.footerNote);
  assert.equal(store.findOrganisation("org_ga")!.invoicing!.customFields, undefined);
  // Settings sends the footer on every save: unchanged, it does not block the rest.
  const ok = await call("PATCH", "/api/orgs/org_ga/invoicing/profile", "u_payer", { footerNote: inv.footerNote ?? "", paymentTermsNote: "Net 14" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(store.findOrganisation("org_ga")!.invoicing!.paymentTermsNote, "Net 14");
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

await check("the owner reopens an issued invoice as its customer sees it; nobody else does", async () => {
  const r = await call("POST", "/api/orgs/org_ga/invoicing/issue", "u_owner", invoiceFor("GA"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const own = await call("GET", `/api/orgs/org_ga/invoices/${r.data.invoice.id}/document`, "u_owner");
  assert.equal(own.status, 200, JSON.stringify(own.data));
  const link = await call("GET", `/api/invoice-links/${r.data.linkToken}`);
  assert.deepEqual(own.data.invoice, link.data.invoice, "the same projection as the link, so no field leaks by this door");
  assert.equal(own.data.invoice.linkTokenHash, undefined);
  addOrg("org_other", "DE");
  const elsewhere = await call("GET", `/api/orgs/org_other/invoices/${r.data.invoice.id}/document`, "u_owner");
  assert.equal(elsewhere.status, 404, "an invoice is read only through its own org");
  assert.equal((await call("GET", `/api/orgs/org_ga/invoices/${r.data.invoice.id}/document`)).status, 401);
  const asked = await call("POST", "/api/orgs/org_ga/invoices", "u_owner", {});
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  const unissued = await call("GET", `/api/orgs/org_ga/invoices/${asked.data.invoice.id}/document`, "u_owner");
  assert.equal(unissued.status, 404, "a supplier's invoice link is not an issued document");
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
  const own = await call("GET", `/api/orgs/org_pay/invoices/${invoiceId}/document`, "u_payer");
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.invoice.payPath, undefined, "the pay link is the customer's credential, not every member's");
  const { payPath: _p, payLinkLapsed: _l, ...linkDocument } = view.data.invoice;
  assert.deepEqual(own.data.invoice, linkDocument, "otherwise the same projection as the link");
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

console.log("\nNumbering: one number, once, picked at write time");

const issueIn = (orgId: string, over: Record<string, unknown> = {}) =>
  call("POST", `/api/orgs/${orgId}/invoicing/issue`, "u_owner", { ...invoiceFor("DE"), vat: { kind: "standard", rate: 19 }, ...over });
const counterOf = (orgId: string) => store.findOrganisation(orgId)!.invoicing!.numberSeries!.next;

await check("a hand-typed number is stepped over by the automatic one, never issued twice", async () => {
  addOrg("org_num", "DE", { taxId: "1234567890" });
  const year = new Date().getUTCFullYear();
  const first = await issueIn("org_num");
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.invoice.issued.number, `RE-${year}-0001`);
  const manual = await issueIn("org_num", { number: `RE-${year}-0002` });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(counterOf("org_num"), 2, "a hand-typed number does not move the counter");
  const auto = await issueIn("org_num");
  assert.equal(auto.status, 201, JSON.stringify(auto.data));
  assert.equal(auto.data.invoice.issued.number, `RE-${year}-0003`);
  assert.equal(counterOf("org_num"), 4);
  const again = await issueIn("org_num", { number: `RE-${year}-0003` });
  assert.equal(again.status, 409, "a hand-typed number already issued is refused");
});

await check("two issues at once get two numbers", async () => {
  // In dollars, so each request awaits the rate before it writes: the two
  // genuinely interleave between drafting and issuing.
  process.env.TRANSF_RATES_FIXED = JSON.stringify({ USD: 1.14, KES: 147.53 });
  const [a, b] = await Promise.all([issueIn("org_num", { currency: "USD" }), issueIn("org_num", { currency: "USD" })])
    .finally(() => { delete process.env.TRANSF_RATES_FIXED; });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.notEqual(a.data.invoice.issued.number, b.data.invoice.issued.number);
  const numbers = store.invoicesOf("org_num").map((i: any) => i.issued?.number);
  assert.equal(new Set(numbers).size, numbers.length, "no number appears twice");
  assert.equal(counterOf("org_num"), 6);
});

await check("a profile save does not reset the counter; a stale one cannot cause a duplicate", async () => {
  const saved = await call("PATCH", "/api/orgs/org_num/invoicing/profile", "u_owner", { footerNote: "Danke" });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(counterOf("org_num"), 6, "a save that leaves the series alone leaves the counter alone");
  // A form loaded before the last issues sends the counter it showed.
  const stale = await call("PATCH", "/api/orgs/org_num/invoicing/profile", "u_owner", {
    numberSeries: { prefix: "RE-{YYYY}-", next: 2, padding: 4 },
  });
  assert.equal(stale.status, 200, JSON.stringify(stale.data));
  const next = await issueIn("org_num");
  assert.equal(next.status, 201, JSON.stringify(next.data));
  assert.equal(next.data.invoice.issued.number, `RE-${new Date().getUTCFullYear()}-0006`);
});

await check("an issue at 23:30 UTC on 31 December in Berlin is dated, and numbered, in the new year", async () => {
  const { draftFrom } = await import("../services/api/src/routes/business/shared.js");
  addOrg("org_berlin", "DE");
  store.updateOrganisation("org_berlin", { reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" } } as any);
  const draft = draftFrom(store.findOrganisation("org_berlin")!, invoiceFor("DE"), new Date("2026-12-31T23:30:00Z"));
  assert.equal(draft.issueDate, "2027-01-01");
  assert.equal(draft.number, "RE-2027-0001");
  const utc = draftFrom(store.findOrganisation("org_num")!, invoiceFor("DE"), new Date("2026-12-31T23:30:00Z"));
  assert.equal(utc.issueDate, "2026-12-31", "a UTC org is still in the old year");
});

await check("an Indian issuer's own VAT note is taken, and bounded to one short line", async () => {
  const { draftFrom } = await import("../services/api/src/routes/business/shared.js");
  addOrg("org_in", "IN");
  const org = store.findOrganisation("org_in")!;
  const exempt = (note: string) => draftFrom(org, { ...invoiceFor("IN"), vat: { kind: "exempt", reason: "not_registered", note } });
  assert.deepEqual(exempt("Not registered for GST").treatment, { kind: "exempt", reason: "not_registered", note: "Not registered for GST" });
  assert.throws(() => exempt(""), /no wording Zold can supply/);
  assert.throws(() => exempt("x".repeat(301)), /at most 300/);
  assert.throws(() => exempt("line one\nline two"), /one line/);
  assert.throws(() => draftFrom(org, { ...invoiceFor("IN"), vat: { kind: "exempt", reason: "export_third_country" } }), /not available in India/);
});

await check("an issue date that is not a calendar day is refused, never numbered NaN", async () => {
  for (const issueDate of ["garbage", "2026-12-31T23:30:00+01:00", "2026-02-30", "2026-13-01"]) {
    const r = await issueIn("org_num", { issueDate });
    assert.equal(r.status, 400, `${issueDate}: ${JSON.stringify(r.data)}`);
  }
});

console.log("\nA supplier submits through a requested link");

const { newLinkToken, ownerInvoiceView } = await import("../services/api/src/domain/invoices.js");
const { notifyRequester } = await import("../services/api/src/routes/business/invoice-links.js");
addOrg("org_req", "DE");
store.updateUser("u_owner", { email: "olga@example.test", emailVerifiedAt: new Date().toISOString() } as any);
const requestLink = () => {
  const { token, hash } = newLinkToken();
  const at = new Date().toISOString();
  const inv = store.addInvoice({
    id: `inv_req_${hash.slice(0, 8)}`, orgId: "org_req", linkTokenHash: hash, state: "LINK_CREATED",
    lines: [], currency: "EUR", total: "0.00", createdByMemberId: "m_org_req_u_owner", createdAt: at, updatedAt: at,
  } as any);
  return { token, id: inv.id };
};
const submitBody = (payTo: unknown) => ({
  supplier: { orgName: "Chain Vendor", email: "ops@vendor.example", invoiceNumber: "CV-9" },
  lines: [{ description: "Hosting", quantity: "1", unitPrice: "40.00" }],
  payTo,
});
const WALLET = `0x${"2".repeat(40)}`;

await check("the link offers only the chain this deployment runs on, by name", async () => {
  const { token } = requestLink();
  const view = await call("GET", `/api/invoice-links/${token}`);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.deepEqual(view.data.payoutChains, [{ chainId: 31337, name: "Local test chain" }]);
});

await check("a wallet on another chain is refused, and the invoice stays open", async () => {
  const { token, id } = requestLink();
  const r = await call("POST", `/api/invoice-links/${token}/submit`, undefined, submitBody({ kind: "wallet", address: WALLET, chainId: 8453 }));
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Local test chain/);
  assert.equal(store.findInvoice(id)?.state, "LINK_CREATED");
});

await check("a wallet on the offered chain is stored, and the org reads it with the chain's name", async () => {
  const { token, id } = requestLink();
  const r = await call("POST", `/api/invoice-links/${token}/submit`, undefined, submitBody({ kind: "wallet", address: WALLET, chainId: 31337 }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const owner = ownerInvoiceView(store.findInvoice(id)!) as any;
  assert.equal(owner.state, "SUBMITTED");
  assert.equal(owner.payTo.address, WALLET);
  assert.equal(owner.payTo.chainName, "Local test chain");
  assert.equal((store.findInvoice(id) as any).payTo.chainName, undefined, "the name is read-time, not stored");
});

await check("the requester is mailed when mail is on; no mail, no email or a refused send never throws", async () => {
  const { id } = requestLink();
  const inv = store.findInvoice(id)!;
  const sent: [string, string][] = [];
  assert.equal(await notifyRequester(inv, { mailOn: true, send: async (to, org) => { sent.push([to, org]); } }), "sent");
  assert.deepEqual(sent, [["olga@example.test", "Org org_req"]]);
  assert.equal(await notifyRequester(inv, { mailOn: false, send: async () => { throw new Error("must not send"); } }), "off");
  assert.equal(await notifyRequester(inv, { mailOn: true, send: async () => { throw Object.assign(new Error("x"), { code: "EAUTH" }); } }), "failed");
  assert.equal(await notifyRequester({ ...inv, createdByMemberId: "m_nobody" }, { mailOn: true, send: async () => {} }), "no-email");
  store.updateMember("m_org_req_u_owner", { status: "deactivated" } as any);
  assert.equal(await notifyRequester(inv, { mailOn: true, send: async () => { throw new Error("must not send"); } }), "no-email", "a requester who left is not mailed");
  store.updateMember("m_org_req_u_owner", { status: "active" } as any);
  store.updateUser("u_owner", { emailVerifiedAt: undefined } as any);
  assert.equal(await notifyRequester(inv, { mailOn: true, send: async () => { throw new Error("must not send"); } }), "no-email", "an unconfirmed address is not mailed");
  store.updateUser("u_owner", { emailVerifiedAt: new Date().toISOString() } as any);
});

console.log("\nA wallet-tier account (no KYC, no IBAN) invoices and collects into its Safe");

/** A person with a claimed payment page and their personal space, which has
 *  no account of its own: what POST /api/orgs leaves for anyone without an IBAN. */
function personWithSpace(id: string, handle: string, over: Record<string, unknown>) {
  const safe = `0x${Buffer.from(id).toString("hex").padStart(40, "0")}` as const;
  store.addUser({
    id, name: `Person ${id}`, createdAt: now, address: safe,
    passkeySafe: { status: "active", address: safe },
    paymentPage: {
      handle, depositAddress: safe, recipientAddress: safe, settlementAsset: "USDC", autoConvert: false,
      forwarder: { provider: "local-safe", recipient: safe, destinationChainId: 31337, sourceChainIds: [31337], custodialWithdrawer: safe, active: true, activatedAt: now },
      createdAt: now, updatedAt: now,
    },
    ...over,
  } as any);
  store.addOrganisation({
    id: `org_${id}`, type: "personal", name: `Person ${id}`, legalName: `Person ${id}`, plan: "starter",
    address: { line1: "1 Main Street", postalCode: "1000", city: "Capital", country: (over.country as string) ?? "DE" },
    reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now,
  } as any);
  store.addMember({ id: `m_${id}`, orgId: `org_${id}`, userId: id, email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
  return safe;
}
// What GET /api/pay/:handle/:code returns, minus the chain's token lookup
// (deployments.json is not there offline): the projection decides the methods.
const TOKEN = { symbol: "USDC", address: `0x${"c".repeat(40)}` as const, decimals: 6 };
const payPage = (userId: string, invoiceId?: string) => {
  const r = store.paymentRequests.find((p) => p.userId === userId && (!invoiceId || p.invoiceId === invoiceId))!;
  return publicPaymentRequest(r, store.findUser(userId)!, { chainId: 31337, token: TOKEN, baseUrl: "https://zold.test", cryptoLive: true });
};

const walletSafe = personWithSpace("u_in", "priya", {
  country: "IN", kycStatus: "pending",
  segment: { value: "IN_COLLECTIONS", reasonCode: "collections_only_residence", decidedAt: now, decidedBy: "system" },
});
await check("an India wallet-tier account issues an invoice and gets its payment link", async () => {
  const r = await call("POST", "/api/orgs/org_u_in/invoicing/issue", "u_in", invoiceFor("IN"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, true, JSON.stringify(r.data.payment));
  assert.match(r.data.payment.url, /\/pay\/priya\//);
  const view = await call("GET", `/api/invoice-links/${r.data.linkToken}`);
  assert.ok(view.data.invoice.payPath?.startsWith("/pay/priya/"), "the invoice shows a Pay button");
});
await check("its payment page offers only the wallet: the page's address, network and token, no bank", async () => {
  const link = store.paymentRequests.find((p) => p.userId === "u_in")!;
  assert.deepEqual(link.methods, ["crypto"], "a bank method is never put on the link");
  const page = payPage("u_in");
  assert.deepEqual(Object.keys(page.methods), ["crypto"]);
  assert.equal(page.methods.crypto!.address, walletSafe);
  assert.equal(page.methods.crypto!.chainId, 31337);
  assert.equal(page.methods.crypto!.token.symbol, "USDC");
  assert.match(page.methods.crypto!.qrUrl, /\/api\/pay\/priya\/qr\.svg$/, "the QR encodes the same page address");
});
await check("asked for by hand, the same account gets the link too, and never a bank method", async () => {
  const id = (await call("POST", "/api/orgs/org_u_in/invoicing/issue", "u_in", invoiceFor("IN"))).data.invoice.id;
  store.paymentRequests.filter((p) => p.invoiceId === id).forEach((p) => store.updatePaymentRequest(p.id, { state: "CANCELLED" } as any));
  const made = await call("POST", "/api/orgs/org_u_in/payment-requests", "u_in", { invoiceId: id, methods: ["crypto"] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const bank = await call("POST", "/api/orgs/org_u_in/payment-requests", "u_in", { amountEur: 5, methods: ["bank"] });
  assert.equal(bank.status, 409, JSON.stringify(bank.data));
  assert.match(bank.data.error, /bank payments are not available.*IBAN/, "refused for the missing IBAN, not for the account");
});

await check("without a claimed payment page there is no Pay button, and it says how to add one", async () => {
  personWithSpace("u_np", "nopage", { country: "IN", kycStatus: "pending" });
  store.updateUser("u_np", { paymentPage: undefined } as any);
  const r = await call("POST", "/api/orgs/org_u_np/invoicing/issue", "u_np", invoiceFor("IN"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.code, "NO_METHOD");
  assert.match(r.data.payment.reason, /Payment page/);
  const links = await call("GET", "/api/orgs/org_u_np/payment-requests", "u_np");
  assert.equal(links.data.payLink.allowed, false, "Get paid offers no New payment link the API would refuse");
  assert.match(links.data.payLink.reason, /Payment page/);
});
await check("only the person behind a personal space collects for it: another member is not the payee", async () => {
  // POST /:orgId/members refuses a personal space (members.manage is business only); a row put there by hand still gets nothing.
  store.addMember({ id: "m_in_viewer", orgId: "org_u_in", userId: "u_eu_viewer", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
  store.addUser({ id: "u_eu_viewer", name: "Other", createdAt: now, paymentPage: { handle: "other", depositAddress: `0x${"9".repeat(40)}` } } as any);
  const id = (await call("POST", "/api/orgs/org_u_in/invoicing/issue", "u_in", invoiceFor("IN"))).data.invoice.id;
  store.paymentRequests.filter((p) => p.invoiceId === id).forEach((p) => store.updatePaymentRequest(p.id, { state: "CANCELLED" } as any));
  const r = await call("POST", "/api/orgs/org_u_in/payment-requests", "u_eu_viewer", { invoiceId: id, methods: ["crypto"] });
  assert.equal(r.status, 403, "a second owner of a personal space is never its payee");
  const both = await call("POST", "/api/orgs/org_u_in/payment-requests", "u_in", { invoiceId: id, methods: ["crypto"] });
  assert.equal(both.status, 403, "with two active members nobody collects: fail closed");
  store.updateMember("m_in_viewer", { status: "deactivated" } as any);
  const own = await call("POST", "/api/orgs/org_u_in/payment-requests", "u_in", { invoiceId: id, methods: ["crypto"] });
  assert.equal(own.status, 201, "alone again, its person collects");
});

await check("a bank credit into the person's own Safe quoting a personal-space invoice settles it, account row or not", async () => {
  const safe = personWithSpace("u_kp", "kim", { country: "DE", kycStatus: "approved", iban: "DE89370400440532013000" });
  const r = await call("POST", "/api/orgs/org_u_kp/invoicing/issue", "u_kp", { ...invoiceFor("DE"), vat: { kind: "standard", rate: 19 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  attributeMoneriumOrderToInvoice({
    id: "ord-kp-1", kind: "issue", amount: "119.00", address: safe, memo: `${r.data.invoice.issued.number} thanks`,
    meta: { state: "processed", processedAt: new Date().toISOString() },
  } as any);
  const inv = store.findInvoice(r.data.invoice.id)!;
  assert.equal((inv.settlements ?? []).length, 1, JSON.stringify(inv.settlements));
  assert.equal(inv.state, "PAID");
});

personWithSpace("u_eu", "erik", {
  country: "DE", kycStatus: "approved", iban: "DE89370400440532013000",
  segment: { value: "EU_FULL", reasonCode: "t", decidedAt: now, decidedBy: "system" },
});
store.addAccount({
  id: "acc_eu", orgId: "org_u_eu", currency: "EUR", label: "EUR", status: "active", provider: "monerium",
  identifier: { iban: "DE89370400440532013000" }, backingUserId: "u_eu", createdAt: now, updatedAt: now,
} as any);
await check("a KYC'd account's invoice page still offers the IBAN and the wallet", async () => {
  const r = await call("POST", "/api/orgs/org_u_eu/invoicing/issue", "u_eu", { ...invoiceFor("DE"), vat: { kind: "standard", rate: 19 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, true, JSON.stringify(r.data.payment));
  const page = payPage("u_eu", r.data.invoice.id);
  assert.deepEqual(Object.keys(page.methods).sort(), ["bank", "crypto"]);
  assert.equal(page.methods.bank!.iban, "DE89370400440532013000");
});

console.log("\nA wallet-tier owner's business is paid into the wallet connected to its euro account");

/** A business owned by the India wallet-tier account, with a payer, and the
 *  EUR account a company's first business org opens with: gated, no IBAN. */
function walletBusiness(id: string) {
  store.addOrganisation({
    id, type: "business", name: `Biz ${id}`, legalName: `Biz ${id} Pvt Ltd`, plan: "business",
    address: { line1: "1 MG Road", postalCode: "560001", city: "Bengaluru", country: "IN" },
    reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now,
  } as any);
  store.addMember({ id: `m_${id}_in`, orgId: id, userId: "u_in", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
  store.addMember({ id: `m_${id}_payer`, orgId: id, userId: "u_payer", email: "", role: "payer", status: "active", invitedAt: now, acceptedAt: now });
  store.addAccount({
    id: `acc_${id}`, orgId: id, currency: "EUR", label: "EUR", status: "gated", provider: "monerium",
    identifier: {}, createdAt: now, updatedAt: now,
  } as any);
}
walletBusiness("org_inbiz");

await check("before its wallet is connected, no Pay button: the invoice list and the issue both say what to connect", async () => {
  const list = await call("GET", "/api/orgs/org_inbiz/invoices", "u_in");
  assert.equal(list.data.payLink.allowed, false);
  assert.match(list.data.payLink.reason, /your wallet, on Accounts/);
  const r = await call("POST", "/api/orgs/org_inbiz/invoicing/issue", "u_in", invoiceFor("IN"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.code, "ACCOUNT_NOT_OPEN");
  const made = await call("POST", "/api/orgs/org_inbiz/payment-requests", "u_in", { invoiceId: r.data.invoice.id, methods: ["crypto"] });
  assert.equal(made.status, 409, "refused while nothing backs it: fail closed");
  const accounts = await call("GET", "/api/orgs/org_inbiz/accounts", "u_in");
  assert.deepEqual(accounts.data.adoption, { allowed: true, wallet: true }, "Accounts offers Connect your wallet");
});

await check("an admin with a wallet account cannot make their own wallet the company's payee", async () => {
  personWithSpace("u_in_admin", "inadmin", { country: "IN", kycStatus: "pending", segment: { value: "IN_COLLECTIONS", reasonCode: "t", decidedAt: now, decidedBy: "system" } });
  store.addMember({ id: "m_inbiz_admin", orgId: "org_inbiz", userId: "u_in_admin", email: "", role: "admin", status: "active", invitedAt: now, acceptedAt: now });
  const r = await call("POST", "/api/orgs/org_inbiz/accounts/acc_org_inbiz/fund", "u_in_admin");
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.code, "OWNER_ONLY");
  assert.equal(store.findAccount("acc_org_inbiz")!.backingUserId, undefined);
  const accounts = await call("GET", "/api/orgs/org_inbiz/accounts", "u_in_admin");
  assert.equal(accounts.data.adoption.allowed, false, "Accounts offers the admin no Connect button");
});

await check("the owner connects their wallet: the account stays gated (no IBAN) and its Safe backs the business", async () => {
  const r = await call("POST", "/api/orgs/org_inbiz/accounts/acc_org_inbiz/fund", "u_in");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = store.findAccount("acc_org_inbiz")!;
  assert.equal(a.status, "gated");
  assert.equal(a.backingUserId, "u_in");
  assert.equal(a.address, walletSafe);
  assert.ok(a.backedSince, "backedSince is recorded at the connection");
  assert.deepEqual(a.identifier, {}, "no IBAN appears");
  assert.equal(r.data.account.profile.status, "not_applicable", "no Monerium profile to check without an IBAN");
  const recheck = await call("POST", "/api/orgs/org_inbiz/accounts/acc_org_inbiz/profile-check", "u_in");
  assert.equal(recheck.status, 409, "a wallet row has no profile to re-check");
  store.updateUser("u_in", { iban: "DE89370400440532013000" } as any);
  assert.deepEqual(store.findAccount("acc_org_inbiz")!.identifier, {}, "an IBAN never follows onto a wallet row without the profile check");
  store.updateUser("u_in", { iban: undefined } as any);
});

await check("connected, an issued invoice gets its link, and the page offers only the wallet", async () => {
  const list = await call("GET", "/api/orgs/org_inbiz/invoices", "u_in");
  assert.deepEqual(list.data.payLink, { allowed: true });
  assert.deepEqual((await call("GET", "/api/orgs/org_inbiz/payment-requests", "u_in")).data.payLink, { allowed: true }, "Get paid reads the same verdict");
  const r = await call("POST", "/api/orgs/org_inbiz/invoicing/issue", "u_in", invoiceFor("IN"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.ok, true, JSON.stringify(r.data.payment));
  const link = store.paymentRequests.find((p) => p.invoiceId === r.data.invoice.id)!;
  assert.equal(link.orgId, "org_inbiz");
  assert.deepEqual(link.methods, ["crypto"]);
  const page = payPage("u_in", r.data.invoice.id);
  assert.deepEqual(Object.keys(page.methods), ["crypto"]);
  assert.equal(page.methods.crypto!.address, walletSafe);
});

await check("only the member whose wallet backs it collects: a payer is refused, and its list offers no button", async () => {
  const id = (await call("POST", "/api/orgs/org_inbiz/invoicing/issue", "u_in", invoiceFor("IN"))).data.invoice.id;
  store.paymentRequests.filter((p) => p.invoiceId === id).forEach((p) => store.updatePaymentRequest(p.id, { state: "CANCELLED" } as any));
  const r = await call("POST", "/api/orgs/org_inbiz/payment-requests", "u_payer", { invoiceId: id, methods: ["crypto"] });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.code, "NOT_THE_PAYEE");
  const list = await call("GET", "/api/orgs/org_inbiz/invoices", "u_payer");
  assert.equal(list.data.payLink.allowed, false);
});

await check("a wallet connected to one business is refused in another (SAFE_IN_OTHER_ORG)", async () => {
  walletBusiness("org_inbiz2");
  const r = await call("POST", "/api/orgs/org_inbiz2/accounts/acc_org_inbiz2/fund", "u_in");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "SAFE_IN_OTHER_ORG");
  assert.equal(store.findAccount("acc_org_inbiz2")!.backingUserId, undefined);
  const issued = await call("POST", "/api/orgs/org_inbiz2/invoicing/issue", "u_in", invoiceFor("IN"));
  assert.equal(issued.data.payment.code, "ACCOUNT_NOT_OPEN");
});

await check("an account that can still get an IBAN does not connect as a wallet: it goes through Monerium", async () => {
  personWithSpace("u_de_wallet", "dewallet", { country: "DE", kycStatus: "pending", segment: { value: "EU_FULL", reasonCode: "t", decidedAt: now, decidedBy: "system" } });
  store.addMember({ id: "m_inbiz2_de", orgId: "org_inbiz2", userId: "u_de_wallet", email: "", role: "admin", status: "active", invitedAt: now, acceptedAt: now });
  const r = await call("POST", "/api/orgs/org_inbiz2/accounts/acc_org_inbiz2/fund", "u_de_wallet");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /not funded yet/);
  assert.equal(store.findAccount("acc_org_inbiz2")!.backingUserId, undefined);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
