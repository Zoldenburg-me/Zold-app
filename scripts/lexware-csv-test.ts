/**
 * The Lexware Office bank-import CSV and the Belege ZIP, offline.
 *
 * The header row is the template's, byte for byte; the separator, date
 * format, decimal comma, sign and encoding follow it; a memo that starts
 * like a formula is neutralised; the ZIP is a stored archive whose entries
 * carry a valid CRC and a name that maps to the line.
 *
 * The formula guard over every text cell, every formula start (ASCII and
 * full-width) behind every prefix a spreadsheet may skip (whitespace, C0/C1
 * controls, DEL, Unicode spaces); the amount only from whole cents; the
 * archive refuses a name that is not one plain, unique file name.
 *
 * Run: npm run lexware:csv:test
 */
import assert from "node:assert/strict";
import { LEXWARE_HEADER, germanAmount, germanDate, lexwareCell, lexwareCsv, lexwareCsvBytes, lexwareRow, type LexwareRow } from "../services/api/src/bookkeeping/lexware.js";
import { crc32, listZip, zipStored } from "../services/api/src/bookkeeping/zip.js";
import type { LedgerEntry } from "../services/api/src/domain/types.js";

let passed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; }
};

const entry = (over: Partial<LedgerEntry["statement"]> & { accountCode?: string } = {}): LedgerEntry => ({
  id: "led_1", orgId: "org_1", source: { kind: "account", accountId: "acc_1" }, direction: "in", asset: "EUR", amount: "119.00",
  tags: [], at: "2026-09-10T10:02:00.000Z", createdAt: "2026-09-26T00:00:00.000Z",
  statement: {
    key: "deposit:d-1:converted", event: "crypto_converted", bookingDate: "2026-09-10", valueDate: "2026-09-11", amountCents: 11962,
    counterparty: { name: "Kunde AG", iban: "DE89370400440532013000" }, reference: "RE-2026-0042",
    links: { invoiceNumber: "RE-2026-0042", txHashes: [`0x${"5".repeat(64)}`] }, documentCode: "ABCDEFGHJKMNPQR", unexecuted: true,
    ...over,
  },
});

console.log("\nLexware CSV");

check("the header row is the template's", () => {
  assert.equal(LEXWARE_HEADER, "Buchungstag;Valuta;Auftraggeber/Zahlungsempfänger;Empfänger/Zahlungspflichtiger;Vorgang/Verwendungszweck;Betrag;Zusatzinfo (optional)");
  assert.equal(lexwareCsv([]).split("\r\n")[0], LEXWARE_HEADER);
});

check("dates are DD.MM.YYYY and amounts carry a decimal comma and a sign", () => {
  assert.equal(germanDate("2026-09-03"), "03.09.2026");
  assert.equal(germanAmount(11962), "119,62");
  assert.equal(germanAmount(-5000), "-50,00");
  assert.equal(germanAmount(-99), "-0,99");
  assert.equal(germanAmount(5), "0,05");
});

check("a credit puts the counterparty as Auftraggeber and the holder as Empfänger; a debit the reverse", () => {
  const credit = lexwareRow(entry(), "Zoldenburg UG", undefined);
  assert.equal(credit.orderer, "Kunde AG DE89370400440532013000");
  assert.equal(credit.recipient, "Zoldenburg UG");
  const debit = lexwareRow(entry({ amountCents: -5000, event: "sepa_out" }), "Zoldenburg UG", undefined);
  assert.equal(debit.orderer, "Zoldenburg UG");
  assert.equal(debit.recipient, "Kunde AG DE89370400440532013000");
});

check("one line: separator, CRLF, Beleg code, invoice number, tx hash and the rule-2 note in Zusatzinfo", () => {
  const csv = lexwareCsv([lexwareRow(entry(), "Zoldenburg UG", "ABCDEFGHJKMNPQR")]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3, "header, row, trailing newline");
  const cells = lines[1].split(";");
  assert.equal(cells.length, 7, lines[1]);
  assert.equal(cells[0], "10.09.2026");
  assert.equal(cells[1], "11.09.2026");
  assert.equal(cells[4], "RE-2026-0042");
  assert.equal(cells[5], "119,62");
  assert.match(cells[6], /^"?Beleg ABCDEFGHJKMNPQR \| Rechnung RE-2026-0042 \| tx 0x5+ \| Zahl aus nicht ausgeführtem Pfad/);
});

check("a memo that starts like a formula is neutralised; semicolons and quotes are quoted; the amount is not touched", () => {
  assert.equal(lexwareCell("=1+1"), "'=1+1");
  assert.equal(lexwareCell("@cmd"), "'@cmd");
  assert.equal(lexwareCell("-not a number"), "'-not a number");
  assert.equal(lexwareCell("a;b"), '"a;b"');
  assert.equal(lexwareCell('say "hi"'), '"say ""hi"""');
  assert.equal(lexwareCell("line\nbreak"), "line break");
  assert.equal(lexwareCell("-50,00", { numeric: true }), "-50,00");
  assert.equal(lexwareCell(" =1+1"), "'=1+1", "leading spaces are trimmed, then the formula is caught");
  assert.equal(lexwareCell("\t=1+1"), "'=1+1");
  assert.equal(lexwareCell("\u0001=1+1"), "'\u0001=1+1", "a control character the trim keeps does not hide a formula");
  assert.equal(lexwareCell("\u00a0+1"), "'+1");
  const csv = lexwareCsv([lexwareRow(entry({ reference: "=HYPERLINK(\"x\")" }), "Z", undefined)]);
  assert.match(csv.split("\r\n")[1], /;"'=HYPERLINK\(""x""\)";/);
});

check("the bytes are ISO-8859-1 like the template, with characters outside it replaced", () => {
  const bytes = lexwareCsvBytes([lexwareRow(entry({ counterparty: { name: "Müller & Söhne — 東京" } }), "Z", undefined)]);
  const text = bytes.toString("latin1");
  assert.ok(text.includes("Müller & Söhne"), "umlauts survive");
  assert.ok(text.includes("Zahlungsempfänger"), "the header's ä survives");
  assert.ok(!text.includes("東"), "a CJK character cannot be encoded and is replaced");
  assert.ok(text.includes("?"), "replaced with ?, not dropped");
  assert.equal(bytes.indexOf(Buffer.from([0xef, 0xbb, 0xbf])), -1, "no UTF-8 BOM");
});

/** One CSV row's cells, unquoted the way a spreadsheet reads them. */
const cellsOf = (row: string): string[] => {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (quoted) {
      if (c === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === ";") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};
// What a spreadsheet may skip before it decides a cell is a formula, in the
// file's own encoding (Latin-1): whitespace, C0 and C1 controls, DEL, NBSP.
const show = (s: string) => JSON.stringify(s).replace(/[\u007f-\u00a0\u2000-\u200f\u2028\u3000\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const RUNS = /^[\s\x00-\x20\x7f-\xa0]*[=+\-@]/;
const FORMULA = ["=", "+", "-", "@", "＝", "＋", "－", "＠"];
const PREFIX = ["", " ", "  ", "\t", "\r", "\n", "\r\n", "\u0000", "\u0001", "\u001f", "\u007f", "\u0085", "\u009f", " ", " ", "​", " ", "　", "﻿", "  \t\u0085"];
const FIELDS: [string, (v: string) => LexwareRow][] = [
  ["counterparty name", (v) => lexwareRow(entry({ counterparty: { name: v } }), "Z", undefined)],
  ["counterparty IBAN", (v) => lexwareRow(entry({ counterparty: { iban: v } }), "Z", undefined)],
  ["counterparty address", (v) => lexwareRow(entry({ counterparty: { address: v } }), "Z", undefined)],
  ["reference", (v) => lexwareRow(entry({ reference: v }), "Z", undefined)],
  ["holder name (credit)", (v) => lexwareRow(entry(), v, undefined)],
  ["holder name (debit)", (v) => lexwareRow(entry({ amountCents: -100 }), v, undefined)],
  ["booking date", (v) => lexwareRow(entry({ bookingDate: v }), "Z", undefined)],
  ["value date", (v) => lexwareRow(entry({ valueDate: v }), "Z", undefined)],
  ["Zusatzinfo", (v) => ({ ...lexwareRow(entry(), "Z", undefined), extra: v })],
];

check("formula guard matrix: every text cell, every formula start (ASCII and full-width), behind every skippable prefix", () => {
  let cases = 0;
  for (const [field, row] of FIELDS) for (const f of FORMULA) for (const pre of PREFIX) {
    const v = `${pre}${f}HYPERLINK("http://x";"y")`;
    const text = lexwareCsvBytes([row(v)]).toString("latin1");
    const rows = text.split("\r\n");
    assert.equal(rows.length, 3, `${field} ${JSON.stringify(v)}: a line break in a cell split the row`);
    const cells = cellsOf(rows[1]);
    assert.equal(cells.length, 7, `${field} ${JSON.stringify(v)}: ${rows[1]}`);
    for (const c of cells.filter((_, i) => i !== 5)) {
      assert.ok(c.startsWith("'") || !RUNS.test(c), `${field} ${show(v)}: cell ${show(c)} runs as a formula`);
    }
    cases++;
  }
  assert.equal(cases, FIELDS.length * FORMULA.length * PREFIX.length);
});

check("the amount cell comes only from a whole number of cents: anything else refuses the export instead of writing it", () => {
  for (const cents of [0, 1, -1, 99, -100, 123456789, -987654321, Number.MAX_SAFE_INTEGER]) {
    const a = germanAmount(cents);
    assert.match(a, /^-?\d+,\d\d$/, a);
    assert.equal(BigInt(a.replace(",", "")), BigInt(cents), "round-trips");
  }
  for (const bad of [NaN, Infinity, -Infinity, 1.5, -0.01, 2 ** 60, "=1+1", "100", null, undefined, {}] as any[]) {
    assert.throws(() => germanAmount(bad), /amount/, JSON.stringify(String(bad)));
    assert.throws(() => lexwareCsv([lexwareRow(entry({ amountCents: bad }), "Z", undefined)]), /amount/, String(bad));
  }
});

console.log("\nBelege ZIP");

check("a stored archive lists its entries with valid CRCs and the line-mapping names", () => {
  const a = Buffer.from("%PDF-1.4 a");
  const b = Buffer.from("%PDF-1.4 bb");
  const zip = zipStored([{ name: "2026-09-10_ABCDEFGHJKMNPQR_RE-2026-0042.pdf", data: a }, { name: "MISSING-2026-09.txt", data: b }], new Date("2026-09-26T00:00:00Z"));
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "end of central directory");
  const entries = listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["2026-09-10_ABCDEFGHJKMNPQR_RE-2026-0042.pdf", "MISSING-2026-09.txt"]);
  assert.ok(entries.every((e) => e.crcOk));
  assert.equal(entries[0].size, a.length);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the CRC-32 check value");
});

check("the archive refuses an entry name that is not one plain, unique file name", () => {
  const pdf = Buffer.from("%PDF-1.4");
  for (const name of ["../x.pdf", "a/b.pdf", "a\\b.pdf", "/abs.pdf", "..", ".", ".hidden", "", "a\u0000.pdf", "a\r\n.pdf", "C:x.pdf"]) {
    assert.throws(() => zipStored([{ name, data: pdf }]), /name/, JSON.stringify(name));
  }
  assert.throws(() => zipStored([{ name: "a.pdf", data: pdf }, { name: "a.pdf", data: pdf }]), /name/, "a duplicate would overwrite");
  assert.equal(listZip(zipStored([{ name: "2026-09-10_ABC_Ü-ref.pdf", data: pdf }]))[0].name, "2026-09-10_ABC_Ü-ref.pdf", "Unicode in a plain name is kept");
});

console.log(`\nlexware-csv: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
