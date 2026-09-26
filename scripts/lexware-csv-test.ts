/**
 * The Lexware Office bank-import CSV and the Belege ZIP, offline.
 *
 * The header row is the template's, byte for byte; the separator, date
 * format, decimal comma, sign and encoding follow it; a memo that starts
 * like a formula is neutralised; the ZIP is a stored archive whose entries
 * carry a valid CRC and a name that maps to the line.
 *
 * Run: npm run lexware:csv:test
 */
import assert from "node:assert/strict";
import { LEXWARE_HEADER, germanAmount, germanDate, lexwareCell, lexwareCsv, lexwareCsvBytes, lexwareRow } from "../services/api/src/bookkeeping/lexware.js";
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
  const credit = lexwareRow(entry(), "Zoldenburg UG");
  assert.equal(credit.orderer, "Kunde AG DE89370400440532013000");
  assert.equal(credit.recipient, "Zoldenburg UG");
  const debit = lexwareRow(entry({ amountCents: -5000, event: "sepa_out" }), "Zoldenburg UG");
  assert.equal(debit.orderer, "Zoldenburg UG");
  assert.equal(debit.recipient, "Kunde AG DE89370400440532013000");
});

check("one line: separator, CRLF, Beleg code, invoice number, tx hash and the rule-2 note in Zusatzinfo", () => {
  const csv = lexwareCsv([lexwareRow(entry(), "Zoldenburg UG")]);
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
  const csv = lexwareCsv([lexwareRow(entry({ reference: "=HYPERLINK(\"x\")" }), "Z")]);
  assert.match(csv.split("\r\n")[1], /;"'=HYPERLINK\(""x""\)";/);
});

check("the bytes are ISO-8859-1 like the template, with characters outside it replaced", () => {
  const bytes = lexwareCsvBytes([lexwareRow(entry({ counterparty: { name: "Müller & Söhne — 東京" } }), "Z")]);
  const text = bytes.toString("latin1");
  assert.ok(text.includes("Müller & Söhne"), "umlauts survive");
  assert.ok(text.includes("Zahlungsempfänger"), "the header's ä survives");
  assert.ok(!text.includes("東"), "a CJK character cannot be encoded and is replaced");
  assert.ok(text.includes("?"), "replaced with ?, not dropped");
  assert.equal(bytes.indexOf(Buffer.from([0xef, 0xbb, 0xbf])), -1, "no UTF-8 BOM");
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

console.log(`\nlexware-csv: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
