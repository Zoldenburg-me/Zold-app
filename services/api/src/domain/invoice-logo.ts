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

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** The logo's id and data URL, or why it is refused. */
export function logoFrom(raw: unknown): { ok: true; id: string; dataUrl: string } | { ok: false; error: string } {
  const m = typeof raw === "string" ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw) : null;
  if (!m) return { ok: false, error: "The logo must be a PNG, JPEG or WebP image." };
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, error: `The logo is ${Math.round(bytes.length / 1000)} kB; at most ${LOGO_MAX_BYTES / 1000} kB.` };
  // The bytes must be what the type says: a renamed file is refused.
  if (!MAGIC[m[1]](bytes)) return { ok: false, error: "The file is not the image type it says it is." };
  const dataUrl = `data:image/${m[1]};base64,${bytes.toString("base64")}`;
  return { ok: true, id: createHash("sha256").update(dataUrl).digest("hex").slice(0, 24), dataUrl };
}
