/**
 * Bad input is a 4xx with a reason, never a 500.
 *
 * Each case is input that reaches code expecting another type or range: a
 * field of the wrong type at `.trim()`, a `null` line at a property read, an
 * amount that overflows to Infinity, a revoked Monerium login. Unguarded,
 * each is a 500.
 *
 *   npm run input-errors:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { ErrorRequestHandler } from "express";

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
const express = (await import("express")).default;
const { initStore } = await import("../services/api/src/store.js");
const { knownError } = await import("../services/api/src/http/known-errors.js");
const { MoneriumAccessError, MoneriumApiError } = await import("../services/api/src/adapters/monerium-client.js");
const { RateUnavailableError } = await import("../services/api/src/rates.js");
const { ContactError, validateBankAccount, validateWallet } = await import("../services/api/src/domain/contacts.js");
const { DraftError, validateLine } = await import("../services/api/src/domain/drafts.js");
const { InvoiceError, validateLines } = await import("../services/api/src/domain/invoices.js");
const { InvoiceComplianceError, checkCompliance } = await import("../services/api/src/domain/invoicing.js");
const { draftFrom, jurisdictionOf } = await import("../services/api/src/routes/business/shared.js");
const { PaymentRequestError, quoteCrypto } = await import("../services/api/src/payment-requests.js");
const { checkOpAssertion } = await import("../services/api/src/http/passkey-assertion.js");

initStore();
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

console.log("the error map");
const app = express();
app.use(express.json({ limit: "1kb" }));
app.post("/x", (_req, res) => res.json({ ok: true }));
app.use(((err: unknown, _req: unknown, res: any, _next: unknown) => {
  const k = knownError(err);
  res.status(k ? k.status : 500).json(k ? k.body : { error: "internal" });
}) as ErrorRequestHandler);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
await check("a body that is not JSON is a 400, not a 500", async () => {
  const r = await fetch(`${base}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "BAD_JSON");
});
await check("a body over the limit is a 413", async () => {
  const r = await fetch(`${base}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(5000) }) });
  assert.equal(r.status, 413);
});
server.close();
await check("rates down is 503; a revoked Monerium login is 409 MONERIUM_NOT_CONNECTED", () => {
  assert.equal(knownError(new RateUnavailableError("feed down"))?.status, 503);
  assert.equal(knownError(new MoneriumAccessError("Monerium OAuth refresh failed (400): invalid_grant", 400))?.body.code, "MONERIUM_NOT_CONNECTED");
  assert.equal(knownError(new MoneriumApiError("unauthorized", 401))?.status, 409);
  assert.equal(knownError(new MoneriumApiError("bad gateway", 502))?.status, 503);
});
await check("a domain validator's refusal is a 400; a plain TypeError stays ours (500)", () => {
  assert.equal(knownError(new ContactError("x"))?.status, 400);
  assert.equal(knownError(new InvoiceComplianceError("x"))?.status, 400);
  assert.equal(knownError(new TypeError("x")), undefined);
});

console.log("validators take any JSON");
const refuses = (fn: () => unknown, kind: new (...a: any[]) => Error) => {
  try { fn(); } catch (err) { assert.ok(err instanceof kind, `threw ${(err as Error).constructor.name}: ${(err as Error).message}`); return; }
  assert.fail("did not refuse");
};
await check("a bank account with a numeric holder, country or label is refused as input", () => {
  const iban = "DE89370400440532013000";
  refuses(() => validateBankAccount({ currency: "EUR", country: "DE", holderName: 42, iban }), ContactError);
  refuses(() => validateBankAccount({ currency: "EUR", country: 49, holderName: "Ana Kim", iban }), ContactError);
  assert.equal(validateBankAccount({ currency: "EUR", country: "DE", holderName: "Ana Kim", iban, label: 5 }).label, undefined);
  refuses(() => validateWallet(null), ContactError);
});
await check("a draft line that is null, or has a numeric note, is handled", () => {
  refuses(() => validateLine(null), DraftError);
  const line = validateLine({ amount: "5.00", asset: "EUR", destination: { kind: "wallet", displayName: "Ana", address: "0x" + "1".repeat(40) }, note: 7, contactId: {} });
  assert.equal(line.note, undefined);
  assert.equal(line.contactId, undefined);
});
await check("a supplier's null invoice line is refused", () => {
  refuses(() => validateLines([null]), InvoiceError);
});

console.log("issuing an invoice");
const org: any = {
  id: "org_t", type: "business", name: "Acme", legalName: "Acme GmbH", plan: "business",
  address: { line1: "Hauptstraße 1", postalCode: "34117", city: "Kassel", country: "DE" },
  invoicing: { vatId: "DE123456789" },
  reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" },
};
const body = (lines: unknown) => ({
  recipient: { name: "Kunde", addressLine: "Weg 1", postalCode: "1", city: "Wien", country: "AT" },
  lines, vat: { kind: "standard", rate: 19 },
});
await check("lines: [null] and lines: {} are refused as input", () => {
  refuses(() => draftFrom(org, body([null])), InvoiceComplianceError);
  refuses(() => draftFrom(org, body({})), InvoiceComplianceError);
});
await check("a numeric description is read as text, not a crash in the compliance check", () => {
  const draft = draftFrom(org, body([{ description: 5, quantity: 1, unitPriceNet: "10.00" }]));
  const report = checkCompliance(draft, jurisdictionOf(org), []);
  assert.equal(report.totals.lines[0].description, "5");
});

console.log("amounts");
await check("an amount past the ceiling is refused before it overflows to Infinity", () => {
  const mid = { usdPerEur: 1.08, provider: "test", asOf: new Date().toISOString() };
  for (const amount of [1e306, Infinity, 1_000_000.01]) refuses(() => quoteCrypto(amount, mid, []), PaymentRequestError);
  assert.ok(quoteCrypto(1_000_000, mid, []));
});

console.log("passkey approvals");
const res = () => {
  const r: any = { code: 0, body: undefined };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
};
const user: any = { id: "u1", passkey: { publicKey: { kty: 2 }, rpId: "localhost", signCount: 0 } };
await check("a non-string approval is a 400 before anything is verified", async () => {
  const r = res();
  assert.equal(await checkOpAssertion(user, { authenticatorData: 1, clientDataJSON: "x", signature: "y" }, "c", r), undefined);
  assert.equal(r.code, 400);
});
await check("an approval that does not verify is a 401, not the bundler's 500", async () => {
  const r = res();
  assert.equal(await checkOpAssertion(user, { authenticatorData: "AAAA", clientDataJSON: "AAAA", signature: "AAAA" }, "c", r), undefined);
  assert.equal(r.code, 401);
  assert.equal(r.body.code, "BAD_ASSERTION");
});

rmSync(process.env.TRANSF_DB_PATH!, { force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\ninput errors: all checks passed");
