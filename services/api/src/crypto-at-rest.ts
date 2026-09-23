/**
 * Field-level encryption at rest.
 *
 * AES-256-GCM, random 12-byte IV, key derived by SHA-256 over the configured
 * secret, serialised as `iv.tag.ciphertext` in base64url — the scheme that
 * has protected Monerium OAuth tokens since they were first stored, kept
 * byte-identical so existing ciphertext stays readable and there is one
 * scheme to review rather than two.
 *
 * PURPOSE-SEPARATED KEYS. Each caller names its purpose, and the purpose is
 * mixed into the derived key, so a leak of one context does not become a leak
 * of the other even when the same secret is configured for both. `monerium`
 * derives exactly as before so nothing already written becomes unreadable.
 *
 * WHAT THIS IS NOT. It is not a KMS, there is no key rotation, and the secret
 * lives in the environment. That is a real limitation and it is written down in
 * README's data-handling section rather than left to be discovered.
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
