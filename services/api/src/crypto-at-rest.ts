/**
 * Field-level encryption at rest.
 *
 * AES-256-GCM, random 12-byte IV, key derived by SHA-256 over the configured
 * secret, serialised as `iv.tag.ciphertext` in base64url. This is the scheme
 * Monerium OAuth tokens were first stored with; keep it byte-identical so
 * existing ciphertext stays readable.
 *
 * Keys are purpose-separated: each caller names a purpose that is mixed into
 * the derived key, so a leak in one context does not expose the other even
 * with the same secret. `monerium` derives as before, so existing data stays
 * readable.
 *
 * Not a KMS: no key rotation, and the secret lives in the environment (see
 * README's data-handling section).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Named so a key is never accidentally shared across two kinds of secret. */
export type EncryptionPurpose = "monerium" | "shopify";

export class EncryptionUnavailableError extends Error {}

const b64 = (b: Buffer) => b.toString("base64url");

/**
 * Derive the key for a purpose.
 *
 * `monerium` hashes the secret alone — the original derivation — so tokens
 * written before this file existed still decrypt. Every other purpose is
 * domain-separated with a prefix.
 */
function keyFor(purpose: EncryptionPurpose, secret: string): Buffer {
  if (!secret) {
    throw new EncryptionUnavailableError(
      `no encryption key is configured, so ${purpose} data cannot be stored — refusing to write it in plaintext`,
    );
  }
  return purpose === "monerium"
    ? createHash("sha256").update(secret).digest()
    : createHash("sha256").update(`zold/${purpose}/v1:${secret}`).digest();
}

export function encryptField(purpose: EncryptionPurpose, secret: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose, secret), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

export function decryptField(purpose: EncryptionPurpose, secret: string, value: string): string {
  const [iv64, tag64, ct64] = String(value).split(".");
  if (!iv64 || !tag64 || !ct64) throw new Error("ciphertext is not in iv.tag.ct form");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose, secret), Buffer.from(iv64, "base64url"));
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
