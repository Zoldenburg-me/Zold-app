/**
 * The issuer's logo: checked at upload (type, bytes, size, who may set it),
 * printed on the invoice link, and frozen per invoice: a later logo, or none,
 * leaves an issued invoice printing the one it was issued with.
 *
 * In-process routers, no chain, no Monerium.
 *
 * Run: npm run invoice-logo:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-invoice-logo-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createInvoicingRoutes } = await import("../services/api/src/routes/business/invoicing.js");
const { createInvoiceRoutes } = await import("../services/api/src/routes/business/invoices.js");
const { createInvoiceLinkRouter } = await import("../services/api/src/routes/business/invoice-links.js");

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
  invoicing: { vatId: "DE123456789" },
  createdAt: now, updatedAt: now,
} as any);
for (const [userId, role] of [["u_owner", "owner"], ["u_view", "payer"]]) {
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
// A PNG header with an IHDR of the given size; the server reads no further.
const png = (extra = "", w = 200, h = 60) => {
  const ihdr = Buffer.alloc(8); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  return `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, Buffer.from(`logo${extra}`)]).toString("base64")}`;
};
const setLogo = (logo: unknown, asUser = "u_owner") => call("PATCH", "/api/orgs/org_de/invoicing/profile", asUser, { logo });
const issue = async () => {
  const r = await call("POST", "/api/orgs/org_de/invoicing/issue", "u_owner", reverseCharge);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const printed = async (token: string) => (await call("GET", `/api/invoice-links/${token}`)).data.invoice;

await check("a logo that is not the image it claims, an SVG or too big is refused", async () => {
  assert.equal((await setLogo(`data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`)).status, 400);
  assert.equal((await setLogo(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`)).status, 400);
  assert.equal((await setLogo(png("x".repeat(41_000)))).status, 400);
  // A small file of many pixels, sent past the browser's scaling.
  assert.equal((await setLogo(png("", 20_000, 20_000))).status, 400);
  assert.equal((await setLogo(png("", 801, 100))).status, 400);
  // No readable header: magic bytes alone are not an image.
  assert.equal((await setLogo(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`)).status, 400);
  assert.equal((await store.findOrganisation("org_de"))!.invoicing?.logoId, undefined);
});

await check("a member who may issue but not change the business profile cannot set it", async () => {
  assert.equal((await setLogo(png(), "u_view")).status, 403);
});

let first: any;
await check("the owner sets a logo; the link prints it, the profile returns only the current one", async () => {
  const r = await setLogo(png("A"));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.profile.logo, png("A"));
  assert.equal(r.data.profile.logos, undefined);
  first = await issue();
  assert.equal((await printed(first.linkToken)).logo, png("A"));
});

await check("a new logo, then none: the issued invoice keeps the one it was issued with", async () => {
  await setLogo(png("B"));
  const second = await issue();
  assert.equal((await printed(second.linkToken)).logo, png("B"));
  assert.equal((await printed(first.linkToken)).logo, png("A"));
  assert.equal((await setLogo(null)).status, 200);
  const third = await issue();
  assert.equal((await printed(third.linkToken)).logo, undefined);
  assert.equal((await printed(first.linkToken)).logo, png("A"));
});

await check("no logo is ever deleted; past 20 a new one is refused, a kept one can be chosen again", async () => {
  for (let n = 0; n < 18; n++) assert.equal((await setLogo(png(`n${n}`))).status, 200);
  assert.equal(Object.keys((await store.findOrganisation("org_de"))!.invoicing?.logos ?? {}).length, 20);
  const refused = await setLogo(png("one too many"));
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal((await setLogo(png("A"))).status, 200);
  assert.equal((await printed(first.linkToken)).logo, png("A"));
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
