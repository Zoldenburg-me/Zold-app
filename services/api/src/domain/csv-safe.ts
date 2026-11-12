/**
 * Spreadsheet formula injection guard for every CSV export.
 *
 * A spreadsheet runs a cell as a formula when its first character is
 * = + - or @, and Excel and LibreOffice skip leading spaces and control
 * characters before deciding (" =1+1", "\t=1+1", "\r=1+1" all run). A cell
 * starting with a tab, CR or LF is neutralised too: some importers split or
 * shift on them. Neutralising means a leading apostrophe, which the
 * spreadsheet shows as text and does not print.
 */
const FORMULA_START = /^[\s\x00-\x1f  -​　﻿]*[=+\-@＝＋－＠]/;
const CONTROL_START = /^[\t\r\n]/;

export function formulaSafe(s: string): string {
  return FORMULA_START.test(s) || CONTROL_START.test(s) ? `'${s}` : s;
}
