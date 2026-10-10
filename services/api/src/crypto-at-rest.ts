/**
 * Field-level encryption at rest.
 *
 * Version 2 (`sealField` / `openField`), what new writes use:
 * - AES-256-GCM, random 12-byte IV, serialised `v2.<keyId>.<iv>.<tag>.<ct>`
 *   in base64url.
 * - A key ring of 32-byte random roots, each named by a key id. The first
 *   root encrypts; the others only decrypt, until no row uses them.
 * - One data key per purpose, HKDF-SHA256 over the root, so a purpose never
 *   shares a key with another.
 * - AAD `purpose|table|rowId|field`: a ciphertext opens only in the row and
 *   field it was written for, so a value copied into another row fails.
 *
 * Version 1 (`encryptField` / `decryptField`, `iv.tag.ct`): one secret,
 * SHA-256 derivation, no key id, no AAD. `openField` still reads it, until the
 * re-encrypt job (scripts/reencrypt-fields.ts) has moved every row to v2.
 *
 * A blind index (`blindIndex`) is an HMAC-SHA256 under its own key, for
 * looking a value up without keeping it in plaintext.
 *
 * This module holds no key: callers pass the ring and secrets in
 * (config/data-keys.ts reads them from the environment).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/** Named so a key is never accidentally shared across two kinds of secret. */
export type EncryptionPurpose = "monerium" | "shopify" | "shopify-link" | "getmyinvoices";

export class EncryptionUnavailableError extends Error {}

const b64 = (b: Buffer) => b.toString("base64url");

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A GCM decipher that accepts only a full 12-byte IV and 16-byte tag. Node
 *  otherwise takes a tag as short as 4 bytes, which a database writer could
 *  store to make forging easy. */
function gcmDecipher(key: Buffer, iv64: string, tag64: string) {
  const iv = Buffer.from(iv64, "base64url");
  const tag = Buffer.from(tag64, "base64url");
  if (iv.length !== IV_BYTES) throw new Error(`ciphertext IV is ${iv.length} bytes, not ${IV_BYTES}`);
  if (tag.length !== TAG_BYTES) throw new Error(`ciphertext tag is ${tag.length} bytes, not ${TAG_BYTES}`);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return decipher;
}

// ── Version 1 ────────────────────────────────────────────────────────────

/**
 * Derive the v1 key for a purpose.
 *
 * `monerium` hashes the secret alone — the original derivation — so tokens
 * written before purposes existed still decrypt. Every other purpose is
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
  const decipher = gcmDecipher(keyFor(purpose, secret), iv64, tag64);
  return Buffer.concat([
    decipher.update(Buffer.from(ct64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// ── Version 2 ────────────────────────────────────────────────────────────

/** Where a ciphertext lives. Part of the AAD, so it must name the row. */
export interface FieldBinding {
  table: string;
  rowId: string;
  field: string;
}

export interface Keyring {
  /** The key id new writes use: the first entry of the ring. */
  activeId: string;
  roots: ReadonlyMap<string, Buffer>;
}

const KEY_ID = /^[a-z0-9]{1,16}$/;
const ROOT_BYTES = 32;
const HKDF_SALT = Buffer.from("zold/at-rest/v2");

/** A 32-byte key written as base64 or base64url. Errors name the problem,
 *  never the value. */
function decodeKey(what: string, text: string): Buffer {
  const t = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    throw new EncryptionUnavailableError(`${what} is not base64: it must be ${ROOT_BYTES} random bytes (openssl rand -base64 ${ROOT_BYTES}), not a passphrase`);
  }
  const key = Buffer.from(t, "base64");
  if (key.length !== ROOT_BYTES) {
    throw new EncryptionUnavailableError(`${what} decodes to ${key.length} bytes, not ${ROOT_BYTES}: it must be ${ROOT_BYTES} random bytes (openssl rand -base64 ${ROOT_BYTES})`);
  }
  return key;
}

/**
 * Parse `DATA_ENCRYPTION_KEYS`: `<keyId>:<root>[,<keyId>:<root>…]`, newest
 * first. The first entry encrypts new writes; the rest only decrypt.
 */
export function parseKeyring(spec: string): Keyring {
  const entries = spec.split(",").map((e) => e.trim()).filter(Boolean);
  if (!entries.length) throw new EncryptionUnavailableError("DATA_ENCRYPTION_KEYS is empty");
  const roots = new Map<string, Buffer>();
  const seen = new Set<string>();
  entries.forEach((entry, i) => {
    const colon = entry.indexOf(":");
    const id = colon > 0 ? entry.slice(0, colon) : "";
    if (!KEY_ID.test(id)) {
      throw new EncryptionUnavailableError(`DATA_ENCRYPTION_KEYS entry ${i + 1} must be <keyId>:<key>, keyId 1-16 of [a-z0-9]`);
    }
    if (roots.has(id)) throw new EncryptionUnavailableError(`DATA_ENCRYPTION_KEYS names key ${id} twice`);
    const root = decodeKey(`DATA_ENCRYPTION_KEYS key ${id}`, entry.slice(colon + 1));
    const fingerprint = root.toString("hex");
    if (seen.has(fingerprint)) throw new EncryptionUnavailableError(`DATA_ENCRYPTION_KEYS key ${id} repeats an earlier key's value`);
    seen.add(fingerprint);
    roots.set(id, root);
  });
  return { activeId: entries[0].slice(0, entries[0].indexOf(":")), roots };
}

function dataKey(root: Buffer, purpose: EncryptionPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", root, HKDF_SALT, `field|${purpose}`, 32));
}

function aad(purpose: EncryptionPurpose, b: FieldBinding): Buffer {
  for (const [name, part] of [["table", b.table], ["rowId", b.rowId], ["field", b.field]] as const) {
    if (!part) throw new Error(`field binding ${name} is empty`);
    if (part.includes("|")) throw new Error(`field binding ${name} contains the separator "|"`);
  }
  return Buffer.from(`${purpose}|${b.table}|${b.rowId}|${b.field}`, "utf8");
}

/** Encrypt a value for one row and field. Refuses without a key ring. */
export function sealField(purpose: EncryptionPurpose, binding: FieldBinding, value: string, keyring: Keyring | null): string {
  if (!keyring) {
    throw new EncryptionUnavailableError(
      `no data encryption key is configured (DATA_ENCRYPTION_KEYS), so ${purpose} data cannot be stored — refusing to write it in plaintext`,
    );
  }
  const root = keyring.roots.get(keyring.activeId)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey(root, purpose), iv);
  cipher.setAAD(aad(purpose, binding));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", keyring.activeId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

/** `v1`, or the key id of a v2 value; throws on anything else. */
export function fieldKeyId(value: string): string {
  const parts = String(value).split(".");
  if (parts.length === 5 && parts[0] === "v2" && KEY_ID.test(parts[1])) return parts[1];
  if (parts.length === 3 && parts.every(Boolean)) return "v1";
  throw new Error("stored value is neither v1 (iv.tag.ct) nor v2 ciphertext");
}

/**
 * Decrypt a stored value for one row and field: v2 under the key ring, v1
 * under the v1 secret. A v2 value moved from another row or field fails here.
 */
export function openField(
  purpose: EncryptionPurpose,
  binding: FieldBinding,
  value: string,
  keys: { keyring: Keyring | null; v1Secret: string },
): string {
  const keyId = fieldKeyId(value);
  if (keyId === "v1") return decryptField(purpose, keys.v1Secret, value);
  if (!keys.keyring) {
    throw new EncryptionUnavailableError(`no data encryption key is configured (DATA_ENCRYPTION_KEYS), so ${purpose} data cannot be read`);
  }
  const root = keys.keyring.roots.get(keyId);
  if (!root) throw new EncryptionUnavailableError(`key ${keyId} is not in DATA_ENCRYPTION_KEYS, so this ${purpose} value cannot be read`);
  const [, , iv64, tag64, ct64] = value.split(".");
  const decipher = gcmDecipher(dataKey(root, purpose), iv64, tag64);
  decipher.setAAD(aad(purpose, binding));
  return Buffer.concat([decipher.update(Buffer.from(ct64, "base64url")), decipher.final()]).toString("utf8");
}

// ── Blind index ──────────────────────────────────────────────────────────

export type BlindIndexKind = "email" | "phone" | "iban";

export function parseBlindIndexKey(text: string): Buffer {
  return decodeKey("BLIND_INDEX_KEY", text);
}

const normalise: Record<BlindIndexKind, (v: string) => string> = {
  email: (v) => v.normalize("NFKC").trim().toLowerCase(),
  phone: (v) => v.replace(/[^\d+]/g, ""),
  iban: (v) => v.replace(/\s+/g, "").toUpperCase(),
};

/** A deterministic lookup token for a value, `bi1.<hmac>`. Equal inputs (after
 *  normalising) give equal tokens; the token reveals nothing without the key. */
export function blindIndex(kind: BlindIndexKind, value: string, key: Buffer | null): string {
  if (!key) throw new EncryptionUnavailableError(`no blind index key is configured (BLIND_INDEX_KEY), so a ${kind} cannot be indexed`);
  return `bi1.${b64(createHmac("sha256", key).update(`${kind}|${normalise[kind](value)}`).digest())}`;
}
