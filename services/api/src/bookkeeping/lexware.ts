/**
 * Lexware Office's bank-import CSV ("Bankimport-Vorlage.csv", from the help
 * centre article "CSV Vorlagendateien für den Import von Bankumsätzen").
 *
 * The template, byte for byte: seven columns, semicolon-separated, CRLF,
 * ISO-8859-1, dates as DD.MM.YYYY, the amount with a decimal comma and a sign
 * (a debit is negative). The header row is reproduced verbatim; Lexware
 * matches on it.
 *
 *   Buchungstag;Valuta;Auftraggeber/Zahlungsempfänger;Empfänger/Zahlungspflichtiger;Vorgang/Verwendungszweck;Betrag;Zusatzinfo (optional)
 *
 * Which side is "Auftraggeber" and which "Empfänger" follows the direction:
 * on a credit the counterparty ordered it and the account holder received
 * it; on a debit the reverse. The Beleg code goes in Zusatzinfo, so a line
 * in Lexware points at its document.
 *
 * Whether the accountant wants this format, MT940 or CAMT is an open
 * question (see the docs); the column set is a data question, not a code
 * one, and lives here in one place.
 */
import type { LedgerEntry } from "../domain/types.js";

export const LEXWARE_HEADER =
  "Buchungstag;Valuta;Auftraggeber/Zahlungsempfänger;Empfänger/Zahlungspflichtiger;Vorgang/Verwendungszweck;Betrag;Zusatzinfo (optional)";

/** DD.MM.YYYY from an ISO day. */
export const germanDate = (isoDay: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDay;
};

/** -1234,56 from signed cents. */
export const germanAmount = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
};

/**
 * One cell. Same injection guard as the ledger CSV (a leading =, +, - or @ is
 * a formula to a spreadsheet), applied to text cells only — the amount column
 * legitimately starts with a minus and is numeric by contract. Semicolons,
 * quotes and line breaks are quoted the CSV way.
 */
export function lexwareCell(v: unknown, opts: { numeric?: boolean } = {}): string {
  const s = v === undefined || v === null ? "" : String(v).replace(/[\r\n]+/g, " ").trim();
  const safe = !opts.numeric && /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return /[";]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface LexwareRow {
  bookingDate: string;
  valueDate: string;
  orderer: string;
  recipient: string;
  purpose: string;
  amountCents: number;
  extra: string;
}

export function lexwareRow(e: LedgerEntry, holderName: string): LexwareRow {
  const s = e.statement!;
  const cp = [s.counterparty.name, s.counterparty.iban, s.counterparty.address].filter(Boolean).join(" ");
  const credit = s.amountCents >= 0;
  const extra = [
    s.documentCode ? `Beleg ${s.documentCode}` : undefined,
    s.links.invoiceNumber ? `Rechnung ${s.links.invoiceNumber}` : undefined,
    s.links.txHashes[0] ? `tx ${s.links.txHashes[0]}` : undefined,
    s.unexecuted ? "Zahl aus nicht ausgeführtem Pfad (kein Swap mit echtem Geld)" : undefined,
  ].filter(Boolean).join(" | ");
  return {
    bookingDate: s.bookingDate,
    valueDate: s.valueDate,
    orderer: credit ? cp : holderName,
    recipient: credit ? holderName : cp,
    purpose: s.reference,
    amountCents: s.amountCents,
    extra,
  };
}

export function lexwareCsv(rows: LexwareRow[]): string {
  const lines = [LEXWARE_HEADER];
  for (const r of rows) {
    lines.push(
      [
        lexwareCell(germanDate(r.bookingDate)),
        lexwareCell(germanDate(r.valueDate)),
        lexwareCell(r.orderer),
        lexwareCell(r.recipient),
        lexwareCell(r.purpose),
        lexwareCell(germanAmount(r.amountCents), { numeric: true }),
        lexwareCell(r.extra),
      ].join(";"),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** The bytes Lexware's template uses: ISO-8859-1 (characters outside it become "?"). */
export function lexwareCsvBytes(rows: LexwareRow[]): Buffer {
  const text = lexwareCsv(rows);
  return Buffer.from(text.replace(/[^\u0000-ÿ]/g, "?"), "latin1");
}
