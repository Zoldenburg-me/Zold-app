/**
 * The logo an issuer prints on its invoices: a small PNG, JPEG or WebP, kept
 * as a data URL on the organisation under its content hash. The browser
 * scales it down before upload; this is the check at the trust boundary.
 * SVG is refused: it can carry script.
 */
import { createHash } from "node:crypto";

/** Decoded bytes. Base64 adds a third, and the whole request must stay under
 *  SECURITY.jsonBodyLimit (64 kB). An 800 x 230 px logo is usually 10-30 kB. */
export const LOGO_MAX_BYTES = 40_000;
/** What the browser scales to; a bigger image sent past it is refused, so no
 *  small file decodes into millions of pixels in a customer's browser. */
export const LOGO_MAX_WIDTH = 800;
export const LOGO_MAX_HEIGHT = 230;
/** Logos an org keeps. None is ever deleted (an issued invoice may print it),
 *  so this bounds the org row: about 1 MB of base64 at most. */
export const LOGO_MAX_KEPT = 20;

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Width and height from the image header, or undefined if it cannot be read. */
function sizeOf(type: string, b: Buffer): { w: number; h: number } | undefined {
  try {
    if (type === "png") return b.subarray(12, 16).toString("latin1") === "IHDR" ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : undefined;
    if (type === "webp") {
      const chunk = b.subarray(12, 16).toString("latin1");
      if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
      if (chunk === "VP8X") return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
      return undefined;
    }
    // JPEG: walk the segments to the frame header (SOF0-15 bar DHT, JPG, DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return undefined;
  } catch {
    return undefined; // a header cut short reads past the buffer
  }
}

/** The logo's id and data URL, or why it is refused. */
export function logoFrom(raw: unknown): { ok: true; id: string; dataUrl: string } | { ok: false; error: string } {
  const m = typeof raw === "string" ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw) : null;
  if (!m) return { ok: false, error: "The logo must be a PNG, JPEG or WebP image." };
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, error: `The logo is ${Math.round(bytes.length / 1000)} kB; at most ${LOGO_MAX_BYTES / 1000} kB.` };
  // The bytes must be what the type says: a renamed file is refused.
  if (!MAGIC[m[1]](bytes)) return { ok: false, error: "The file is not the image type it says it is." };
  const size = sizeOf(m[1], bytes);
  if (!size || !size.w || !size.h) return { ok: false, error: "The logo's size could not be read from the image." };
  if (size.w > LOGO_MAX_WIDTH || size.h > LOGO_MAX_HEIGHT) {
    return { ok: false, error: `The logo is ${size.w} x ${size.h} pixels; at most ${LOGO_MAX_WIDTH} x ${LOGO_MAX_HEIGHT}.` };
  }
  const dataUrl = `data:image/${m[1]};base64,${bytes.toString("base64")}`;
  return { ok: true, id: createHash("sha256").update(dataUrl).digest("hex").slice(0, 24), dataUrl };
}
