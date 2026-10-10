/**
 * The keys that encrypt and index stored data, read from the environment.
 *
 * - `DATA_ENCRYPTION_KEYS`: the v2 key ring, `<keyId>:<32 random bytes,
 *   base64>[,…]`, newest first (crypto-at-rest.ts). Tier 3.
 * - `BLIND_INDEX_KEY`: 32 random bytes, base64. Its own key, so rotating the
 *   ring never changes an index. Tier 3.
 * - `MONERIUM_TOKEN_ENCRYPTION_KEY`: the v1 secret, read only to open v1
 *   values until scripts/reencrypt-fields.ts has moved every row.
 *
 * The ring and the blind index key are read on each call, not at import, so a
 * test or the re-encrypt job can set them before use; the v1 secret is
 * config/monerium.ts's, read when that loads. Parsed values stay in this
 * process's memory only.
 */
import {
  blindIndex,
  EncryptionUnavailableError,
  parseBlindIndexKey,
  parseKeyring,
  type Keyring,
} from "../crypto-at-rest.js";
import { MONERIUM } from "./monerium.js";

let ring: { spec: string; keyring: Keyring } | undefined;
let blind: { spec: string; key: Buffer } | undefined;

/** The key ring, or null when none is configured. Throws when it is set but
 *  malformed, so a typo never silently disables encryption. */
export function dataKeyring(): Keyring | null {
  const spec = process.env.DATA_ENCRYPTION_KEYS ?? "";
  if (!spec.trim()) return null;
  if (ring?.spec !== spec) ring = { spec, keyring: parseKeyring(spec) };
  return ring.keyring;
}

export function blindIndexKey(): Buffer | null {
  const spec = process.env.BLIND_INDEX_KEY ?? "";
  if (!spec.trim()) return null;
  if (blind?.spec !== spec) blind = { spec, key: parseBlindIndexKey(spec) };
  return blind.key;
}

/** The v1 secret, for reading rows not yet re-encrypted. */
export const v1Secret = () => MONERIUM.tokenEncryptionKey;

/** Why stored secrets cannot be written here, or null when they can. */
export function dataEncryptionProblem(): string | null {
  try {
    return dataKeyring() ? null : "no data encryption key (DATA_ENCRYPTION_KEYS) is configured";
  } catch (err) {
    if (err instanceof EncryptionUnavailableError) return err.message;
    throw err;
  }
}

/** Startup check: every key that is set must parse, and the blind index key
 *  must not repeat a ring key. Messages never carry a value. */
export function dataKeyProblems(): string[] {
  const problems: string[] = [];
  let keyring: Keyring | null = null;
  try { keyring = dataKeyring(); } catch (err) { problems.push((err as Error).message); }
  let key: Buffer | null = null;
  try { key = blindIndexKey(); } catch (err) { problems.push((err as Error).message); }
  if (keyring && key && [...keyring.roots.values()].some((r) => r.equals(key!))) {
    problems.push("BLIND_INDEX_KEY must not equal a DATA_ENCRYPTION_KEYS key");
  }
  return problems;
}

export const emailIndex = (email: string) => blindIndex("email", email, blindIndexKey());
