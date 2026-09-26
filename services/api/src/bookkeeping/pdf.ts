/**
 * A minimal PDF writer: A4 pages of text in Helvetica, nothing else.
 *
 * The Beleg is bytes the accountant's inbox stores, so the page's print is
 * not enough here. No dependency: the format needed is small (one font, one
 * encoding, text objects, an xref table), and a rendering library would be
 * the largest thing in the API for the sake of a table of facts.
 *
 * Text is WinAnsi-encoded, which covers German. Anything outside it is
 * replaced with "?" rather than silently dropped.
 */

export interface PdfLine {
  text: string;
  /** Point size. Default 10. */
  size?: number;
  bold?: boolean;
  /** Extra space before the line, in points. */
  gap?: number;
  /** Indent from the left margin, in points. */
  indent?: number;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const LEADING = 1.35;

/** Characters WinAnsi has that Latin-1 does not, at their WinAnsi codes. */
const WINANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
  "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99, "Š": 0x8a, "š": 0x9a, "Ž": 0x8e, "ž": 0x9e, "Œ": 0x8c, "œ": 0x9c, "Ÿ": 0x9f,
};

export function winAnsi(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (WINANSI_EXTRA[ch] !== undefined) out.push(WINANSI_EXTRA[ch]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

function escapePdfString(b: Buffer): string {
  let s = "";
  for (const byte of b) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) s += "\\" + String.fromCharCode(byte);
    else if (byte < 0x20 || byte > 0x7e) s += "\\" + byte.toString(8).padStart(3, "0");
    else s += String.fromCharCode(byte);
  }
  return s;
}

/** Rough Helvetica advance, enough to wrap a line before the right margin. */
function approxWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[iljtfI.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-Z0-9€]/.test(ch) ? 0.67 : ch === " " ? 0.28 : 0.55;
  }
  return w * size;
}

function wrap(text: string, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (approxWidth(next, size) <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Lay the lines out over as many pages as they need and serialise. Returns
 * the PDF bytes; the document is uncompressed and readable in a text editor,
 * which is a feature for a record.
 */
export function textPdf(lines: PdfLine[], meta: { title: string; author?: string; subject?: string }): Buffer {
  const width = PAGE_W - 2 * MARGIN;
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const ln of lines) {
    const size = ln.size ?? 10;
    const font = ln.bold ? "/F2" : "/F1";
    const gap = ln.gap ?? 0;
    const pieces = ln.text === "" ? [""] : wrap(ln.text, size, width - (ln.indent ?? 0));
    y -= gap;
    for (const piece of pieces) {
      if (y - size * LEADING < MARGIN) newPage();
      y -= size * LEADING;
      ops.push(
        `BT ${font} ${size} Tf ${(MARGIN + (ln.indent ?? 0)).toFixed(2)} ${y.toFixed(2)} Td (${escapePdfString(winAnsi(piece))}) Tj ET`,
      );
    }
  }
  newPage();
  if (!pages.length) pages.push([]);

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then per page: page + content.
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PLACEHOLDER");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const infoStr = (s: string) => `(${escapePdfString(winAnsi(s))})`;
  add(
    `<< /Title ${infoStr(meta.title)} /Producer (Zold) ${meta.author ? `/Author ${infoStr(meta.author)}` : ""} ${meta.subject ? `/Subject ${infoStr(meta.subject)}` : ""} >>`,
  );
  const pageIds: number[] = [];
  for (const page of pages) {
    const content = Buffer.from(page.join("\n"), "latin1");
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    parts.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(xref, "latin1"));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
