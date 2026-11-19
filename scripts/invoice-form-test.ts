/**
 * The supplier invoice form (/invoice/<token>) shows the total the server
 * will issue: each line rounded to cents, then summed (computeTotals).
 * public/invoice-totals.js is the form's arithmetic; this compares it with
 * checkCompliance line by line and in total.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkCompliance, type InvoiceDraft } from "../services/api/src/domain/invoicing.js";

const PUB = path.join(import.meta.dirname, "../services/api/public");
const { lineNetCents, formTotalCents } = await import(pathToFileURL(path.join(PUB, "invoice-totals.js")).href);

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

const party = { name: "Acme GmbH", addressLine: "Hauptstraße 1", postalCode: "34117", city: "Kassel", country: "DE" };
const server = (lines: { quantity: string; unitPrice: string }[]) =>
  checkCompliance({
    number: "RE-1",
    issueDate: "2026-11-19",
    supplyDate: "2026-11-19",
    issuer: { ...party, vatId: "DE123456789" },
    recipient: party,
    lines: lines.map((l) => ({ description: "x", quantity: l.quantity, unitPriceNet: l.unitPrice })),
    treatment: { kind: "standard", rate: 19 },
  } satisfies InvoiceDraft).totals;

const cases: [string, { quantity: string; unitPrice: string }[]][] = [
  ["3 x 0.335", [{ quantity: "3", unitPrice: "0.335" }]],
  ["a mix of 0.335, 0.005 and 1.115", [
    { quantity: "1", unitPrice: "0.335" },
    { quantity: "1", unitPrice: "0.005" },
    { quantity: "1", unitPrice: "1.115" },
    { quantity: "3", unitPrice: "0.335" },
  ]],
  ["1 x 1.115", [{ quantity: "1", unitPrice: "1.115" }]],
  ["a sub-cent unit price", [{ quantity: "10000", unitPrice: "0.004" }, { quantity: "41.5", unitPrice: "1.789" }]],
];

console.log("\nInvoice form totals");
for (const [name, lines] of cases) {
  check(`${name}: the form's cents equal the server's`, () => {
    const t = server(lines);
    assert.deepEqual(lines.map((l) => lineNetCents(l.quantity, l.unitPrice)), t.lines.map((l) => l.netCents));
    assert.equal(formTotalCents(lines), t.netCents);
    assert.equal((formTotalCents(lines) / 100).toFixed(2), (t.netCents / 100).toFixed(2));
  });
}
check("1 x 1.115 displays 1.12, as issued (toFixed alone shows 1.11)", () => {
  assert.equal(lineNetCents("1", "1.115"), 112);
  assert.equal((formTotalCents([{ quantity: "1", unitPrice: "1.115" }]) / 100).toFixed(2), "1.12");
});
check("an empty line counts as zero", () => {
  assert.equal(formTotalCents([{ quantity: "1", unitPrice: "" }, { quantity: "", unitPrice: "2" }]), 0);
});
check("the form draws its lines and total from invoice-totals.js", () => {
  const html = readFileSync(path.join(PUB, "invoice.html"), "utf8");
  assert.match(html, /import \{ lineNetCents, formTotalCents \} from "\/invoice-totals\.js";/);
  assert.doesNotMatch(html, /Number\(l(?:ines\[i\])?\.quantity \|\| 0\) \* Number/);
});

console.log(`\n${passed} passed`);
