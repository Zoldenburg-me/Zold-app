/**
 * Customer VAT IDs: their shape per country, VIES's answer, and the
 * treatment Zold suggests from them. Offline: VIES is a local stub.
 *
 *   npm run vat:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The stub stands in for VIES; set before config.ts reads it.
let viesCalls = 0;
let lastBody: any;
const vies = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    viesCalls++;
    lastBody = JSON.parse(raw || "{}");
    const n = `${lastBody.countryCode}${lastBody.vatNumber}`;
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (n === "ATU12345678") return send(200, { valid: true, name: "ACME GMBH", address: "RINGSTRASSE 1\n1010 WIEN", requestDate: "2026-10-02T10:00:00Z", requestIdentifier: lastBody.requesterNumber ? "WAPIAAAAZ1" : "", userError: "VALID" });
    if (n === "DE999999999") return send(200, { valid: true, name: "---", address: "---", requestDate: "2026-10-02T10:00:00Z", userError: "VALID" });
    if (n === "FR00123456789") return send(200, { valid: false, userError: "INVALID" });
    if (n === "IT12345678901") return send(200, { valid: false, userError: "MS_UNAVAILABLE" });
    return send(500, { actionSucceed: false, errorWrappers: [{ error: "SERVICE_UNAVAILABLE" }] });
  });
});
vies.listen(0, "127.0.0.1");
await new Promise((r) => vies.once("listening", r));
process.env.VIES_URL = `http://127.0.0.1:${(vies.address() as AddressInfo).port}/check-vat-number`;

const { vatIdShape, vatIdFormatFor } = await import("../services/api/src/domain/vat-ids.js");
const { checkVatId, cachedVatCheck } = await import("../services/api/src/adapters/vies.js");
const { checkCompliance, suggestTreatment } = await import("../services/api/src/domain/invoicing.js");
const { jurisdictionFor } = await import("../services/api/src/domain/jurisdictions.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}

console.log("shapes");
await check("each country's own shape, written the way people write it", () => {
  for (const ok of ["DE123456789", "ATU12345678", "atu 1234 5678", "FR12345678901", "NL123456789B01", "EL123456789", "CHE-123.456.789 MWST", "CHE123456789", "GB123456789", "IE1234567WA"]) {
    assert.ok(vatIdShape(ok).ok, ok);
  }
  for (const bad of ["CH12345678", "AT12345678", "DE12345678", "NL123456789", "XX123", "nonsense"]) {
    assert.equal(vatIdShape(bad).ok, false, bad);
  }
});
await check("a bad one says how the country writes it", () => {
  const s = vatIdShape("CH12345678");
  assert.ok(!s.ok && /CHE-123\.456\.789 MWST/.test(s.reason), JSON.stringify(s));
});
await check("Greece is EL, Switzerland and the UK are not VIES numbers", () => {
  assert.equal(vatIdFormatFor("GR")?.prefix, "EL");
  const ch = vatIdShape("CHE123456789MWST");
  assert.ok(ch.ok && !ch.vies);
});

console.log("VIES");
await check("a registered number comes back valid, with name, address and the consultation number", async () => {
  const c = await checkVatId("ATU12345678", "DE123456789");
  assert.equal(c.status, "valid");
  assert.equal(c.name, "ACME GMBH");
  assert.equal(c.address, "RINGSTRASSE 1, 1010 WIEN");
  assert.equal(c.requestIdentifier, "WAPIAAAAZ1");
  assert.equal(lastBody.requesterMemberStateCode, "DE");
  assert.equal(lastBody.requesterNumber, "123456789");
});
await check("the answer is kept: a second check does not ask VIES again", async () => {
  const before = viesCalls;
  assert.equal((await checkVatId("ATU 1234 5678")).status, "valid");
  assert.equal(viesCalls, before);
  assert.equal(cachedVatCheck("ATU12345678")?.status, "valid");
});
await check("a withheld name (Germany's ---) is left out, not printed", async () => {
  const c = await checkVatId("DE999999999");
  assert.equal(c.status, "valid");
  assert.equal(c.name, undefined);
});
await check("VIES saying not registered is invalid", async () => {
  assert.equal((await checkVatId("FR00123456789")).status, "invalid");
});
await check("a member state down, or VIES erroring, is unavailable, never invalid, and not kept", async () => {
  assert.equal((await checkVatId("IT12345678901")).status, "unavailable");
  assert.equal((await checkVatId("PL1234567890")).status, "unavailable");
  assert.equal(cachedVatCheck("IT12345678901"), undefined);
});
await check("Swiss and UK numbers are not sent to VIES", async () => {
  const before = viesCalls;
  assert.equal((await checkVatId("CHE-123.456.789 MWST")).status, "not_checkable");
  assert.equal(viesCalls, before);
});

console.log("suggestions");
const de = jurisdictionFor("DE");
const s = (recipient: any, business: boolean | undefined, supplyKind: "services" | "goods", vatStatus?: string) =>
  suggestTreatment({
    recipient, recipientIsBusiness: business, supplyKind,
    treatment: { kind: "standard", rate: 19 },
    ...(vatStatus ? { recipientVatCheck: { vatId: recipient.vatId, status: vatStatus as any, checkedAt: "" } } : {}),
  }, de);
await check("same country: charge your VAT", () => {
  assert.equal(s({ country: "DE" }, true, "services")?.reason, null);
});
await check("EU business with a valid VAT ID: reverse charge for services, intra-community supply for goods", () => {
  const rc = s({ country: "AT", vatId: "ATU12345678" }, true, "services", "valid");
  assert.equal(rc?.reason, "reverse_charge_eu");
  assert.equal(rc?.confident, true);
  assert.equal(s({ country: "AT", vatId: "ATU12345678" }, true, "goods", "valid")?.reason, "intra_community_supply");
});
await check("unconfirmed VAT ID: still reverse charge, but marked to check", () => {
  assert.equal(s({ country: "AT", vatId: "ATU12345678" }, true, "services", "unavailable")?.confident, false);
});
await check("EU business without a valid VAT ID, or VIES saying invalid: charge your VAT", () => {
  assert.equal(s({ country: "AT" }, true, "services")?.reason, null);
  assert.equal(s({ country: "AT", vatId: "ATU12345678" }, true, "services", "invalid")?.reason, null);
});
await check("outside the EU: services to a business not taxable here, goods an export", () => {
  assert.equal(s({ country: "CH", vatId: "CHE123456789" }, true, "services")?.reason, "not_taxable_place_of_supply");
  assert.equal(s({ country: "CH" }, false, "goods")?.reason, "export_third_country");
  assert.equal(s({ country: "US" }, false, "services")?.reason, null);
});
await check("no suggestion without knowing business or private, under GENERIC rules, or for a small business", () => {
  assert.equal(s({ country: "AT" }, undefined, "services"), undefined);
  assert.equal(suggestTreatment({ recipient: { country: "DE" }, recipientIsBusiness: true, treatment: { kind: "standard", rate: 18 } }, jurisdictionFor("IN")), undefined);
  assert.equal(suggestTreatment({ recipient: { country: "AT" }, recipientIsBusiness: true, treatment: { kind: "exempt", reason: "kleinunternehmer" } }, de), undefined);
});

console.log("the check");
const issuer = { name: "Acme GmbH", addressLine: "Hauptstraße 1", postalCode: "34117", city: "Kassel", country: "DE", vatId: "DE123456789" };
const draft = (over: any) => ({
  issuer, number: "RE-1", issueDate: "2026-10-02", supplyDate: "2026-10-02",
  recipient: { name: "Kunde AG", addressLine: "Bahnhofstr. 1", postalCode: "8001", city: "Zürich", country: "CH", vatId: "CH12345678" },
  lines: [{ description: "Beratung", quantity: "1", unitPriceNet: "100.00" }],
  treatment: { kind: "standard", rate: 19 }, ...over,
});
await check("a malformed Swiss number gets the Swiss format, not 'does not look like a VAT ID'", () => {
  const r = checkCompliance(draft({}) as any, de, []);
  const w = r.warnings.find((x) => x.field === "recipient.vatId");
  assert.ok(w && /CHE-123\.456\.789 MWST/.test(w.message), JSON.stringify(r.warnings));
});
await check("reverse charge on a number VIES says is invalid is refused", () => {
  const r = checkCompliance(draft({
    recipient: { name: "A GmbH", addressLine: "Ring 1", postalCode: "1010", city: "Wien", country: "AT", vatId: "ATU12345678" },
    recipientIsBusiness: true,
    treatment: { kind: "exempt", reason: "reverse_charge_eu" },
    recipientVatCheck: { vatId: "ATU12345678", status: "invalid", checkedAt: "" },
  }) as any, de, []);
  assert.ok(r.errors.some((e) => /VIES says/.test(e.message)), JSON.stringify(r.errors));
});
await check("reverse charge to a customer marked private is refused", () => {
  const r = checkCompliance(draft({
    recipient: { name: "Ana Kim", addressLine: "Ring 1", postalCode: "1010", city: "Wien", country: "AT", vatId: "ATU12345678" },
    recipientIsBusiness: false,
    treatment: { kind: "exempt", reason: "reverse_charge_eu" },
  }) as any, de, []);
  assert.ok(r.errors.some((e) => e.field === "recipient.isBusiness"), JSON.stringify(r.errors));
});
await check("the report carries the suggestion", () => {
  const r = checkCompliance(draft({ recipient: { name: "Kunde AG", addressLine: "x", postalCode: "1", city: "Zürich", country: "CH", vatId: "CHE123456789" }, recipientIsBusiness: true, supplyKind: "services" }) as any, de, []);
  assert.equal(r.suggestion?.reason, "not_taxable_place_of_supply");
});

vies.close();
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nvat: all checks passed");
