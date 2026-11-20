/**
 * The supplier invoice form (/invoice/<token>) shows the total the server
 * stores on submit: each line rounded to cents, then summed. The form posts
 * to /api/invoice-links/:token/submit, which sizes the invoice with
 * validateLines; public/invoice-totals.js is the form's arithmetic. This
 * compares the module with validateLines (and checkCompliance, which shares
 * the rounding) line by line and in total, on fixed cases and random ones.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkCompliance, type InvoiceDraft } from "../services/api/src/domain/invoicing.js";
import { AMOUNT_RE, validateLines } from "../services/api/src/domain/invoices.js";

const PUB = path.join(import.meta.dirname, "../services/api/public");
const { lineNetCents, formTotalCents, formatCents, AMOUNT_RE: FORM_AMOUNT_RE } = await import(pathToFileURL(path.join(PUB, "invoice-totals.js")).href);

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

type Line = { quantity: string; unitPrice: string };
const submitted = (lines: Line[]) => validateLines(lines.map((l) => ({ description: "x", ...l })));

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
  ["1 x 1.005", [{ quantity: "1", unitPrice: "1.005" }]],
  ["1 x 0.285", [{ quantity: "1", unitPrice: "0.285" }]],
  ["a sub-cent unit price", [{ quantity: "10000", unitPrice: "0.004" }, { quantity: "41.5", unitPrice: "1.789" }]],
];

console.log("\nInvoice form totals");
for (const [name, lines] of cases) {
  check(`${name}: the form's cents equal what submit stores and what is issued`, () => {
    const v = submitted(lines);
    assert.deepEqual(lines.map((l) => formatCents(lineNetCents(l.quantity, l.unitPrice))), v.lines.map((l) => l.amount));
    assert.equal(formatCents(formTotalCents(lines)), v.total);
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
check("1 x 1.005 and 1 x 0.285 are stored as 1.01 and 0.29, as the form shows", () => {
  assert.equal(submitted([{ quantity: "1", unitPrice: "1.005" }]).total, "1.01");
  assert.equal(submitted([{ quantity: "1", unitPrice: "0.285" }]).total, "0.29");
  assert.equal(formatCents(lineNetCents("1", "1.005")), "1.01");
  assert.equal(formatCents(lineNetCents("1", "0.285")), "0.29");
});

// Random quantity/price strings matching AMOUNT_RE (/^\d+(\.\d{1,8})?$/),
// half of them ending in 5 at the third decimal, where rounding is decided.
// Seeded, so a failure reproduces.
let seed = 39;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const digits = (n: number) => Array.from({ length: n }, () => rand(10)).join("");
const amountString = () => {
  const int = String(rand(4) === 0 ? rand(100000) : rand(100));
  const k = rand(9);
  if (k === 0) return int;
  const dec = rand(2) === 0 && k >= 3 ? digits(2) + "5" + digits(k - 3) : digits(k);
  return `${int}.${dec}`;
};
check("random AMOUNT_RE lines: the form equals validateLines line by line and in total", () => {
  for (let n = 0; n < 2000; n++) {
    const lines = Array.from({ length: 1 + rand(4) }, () => {
      let quantity = amountString();
      while (Number(quantity) <= 0) quantity = amountString();
      return { quantity, unitPrice: amountString() };
    });
    const v = submitted(lines);
    const shown = lines.map((l) => formatCents(lineNetCents(l.quantity, l.unitPrice)));
    assert.deepEqual(shown, v.lines.map((l) => l.amount), JSON.stringify(lines));
    assert.equal(formatCents(formTotalCents(lines)), v.total, JSON.stringify(lines));
  }
});
check("a value the server refuses shows no number, line or total", () => {
  for (const [quantity, unitPrice] of [["1", "-5"], ["1", "1e2"], ["1", "1.123456789"], ["0", "2"], ["-1", "2"], ["1", "1,5"], ["2x", "1"]]) {
    assert.throws(() => submitted([{ quantity, unitPrice }]), `${quantity} x ${unitPrice} is refused`);
    assert.equal(lineNetCents(quantity, unitPrice), null, `${quantity} x ${unitPrice}`);
    assert.equal(formatCents(formTotalCents([{ quantity: "1", unitPrice: "2" }, { quantity, unitPrice }])), "—");
  }
});
check("an empty field shows no number, as submit refuses it", () => {
  for (const [quantity, unitPrice] of [["1", ""], ["", "2"], [" ", "2"]]) {
    assert.throws(() => submitted([{ quantity, unitPrice }]), `${JSON.stringify(quantity)} x ${JSON.stringify(unitPrice)} is refused`);
    assert.equal(lineNetCents(quantity, unitPrice), null);
    assert.equal(formatCents(formTotalCents([{ quantity: "1", unitPrice: "2" }, { quantity, unitPrice }])), "—");
  }
});
check("the form tests amounts with the server's AMOUNT_RE", () => {
  assert.equal(FORM_AMOUNT_RE.source, AMOUNT_RE.source);
  assert.equal(FORM_AMOUNT_RE.flags, AMOUNT_RE.flags);
});
check("the form draws its lines and total from invoice-totals.js", () => {
  const html = readFileSync(path.join(PUB, "invoice.html"), "utf8");
  assert.match(html, /import \{ lineNetCents, formTotalCents, formatCents \} from "\/invoice-totals\.js";/);
  assert.doesNotMatch(html, /Number\(l(?:ines\[i\])?\.quantity \|\| 0\) \* Number/);
});

console.log(`\n${passed} passed`);
