/**
 * What Zold keeps from a Monerium login's answers: the facts about THIS
 * account's Safe, nothing about the person's other wallets, IBANs or profiles.
 *
 * A Monerium login lists every address it ever linked and every IBAN it holds,
 * whatever app linked them. Stored, that is a map of the person's on-chain life
 * for anyone who reads our database. So every copy we store, and every copy the
 * admin dashboard sees, goes through here first. Allowlists, field by field.
 *
 * Kept:
 * - profiles: the connected profile as {id, kind, name, state}; any other
 *   profile as {id, kind} only (a support message names the kind an address is
 *   linked under).
 * - ibans: only entries that pay into the Safe on our chain.
 * - addresses: only the Safe's own entry.
 * - orders (admin live read only, never stored): only those on the Safe.
 */
import { paysInto } from "./monerium-sandbox.js";
import { MoneriumApiError } from "./monerium-client.js";

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown, key: string): Record<string, any>[] =>
  (Array.isArray(v) ? v : isRecord(v) && Array.isArray(v[key]) ? v[key] : []).filter(isRecord);
const pick = (o: Record<string, any>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const sameAddress = (a: unknown, safe: string) => Boolean(safe) && String(a ?? "").toLowerCase() === safe.toLowerCase();

const PROFILE_KEPT = ["id", "kind", "name", "state"] as const;
const IBAN_KEPT = ["iban", "bic", "profile", "address", "chain", "state", "name"] as const;
const ADDRESS_KEPT = ["address", "profile", "chain", "chains", "state"] as const;
const ORDER_KEPT = ["id", "kind", "profile", "address", "chain", "amount", "currency", "state", "memo", "meta", "counterpart"] as const;

export interface MoneriumOwner {
  /** The Safe: the one address this account is about. */
  address: string;
  /** The profile this account connected under. */
  profileId?: string;
}

export function keptProfiles(owner: MoneriumOwner, raw: unknown): Record<string, any>[] {
  return listOf(raw, "profiles").map((p) => pick(p, owner.profileId && p.id === owner.profileId ? PROFILE_KEPT : ["id", "kind"]));
}

export function keptIbans(owner: MoneriumOwner, raw: unknown): Record<string, any>[] {
  if (!owner.address) return [];
  return listOf(raw, "ibans").filter((i) => paysInto(i, owner.address)).map((i) => pick(i, IBAN_KEPT));
}

/** Takes GET /addresses (a list) or GET /addresses/{safe} (one record). */
export function keptAddresses(owner: MoneriumOwner, raw: unknown): Record<string, any>[] {
  const list = isRecord(raw) && typeof raw.address === "string" ? [raw] : listOf(raw, "addresses");
  return list.filter((a) => sameAddress(a.address, owner.address)).map((a) => pick(a, ADDRESS_KEPT));
}

export function keptOrders(owner: MoneriumOwner, raw: unknown): Record<string, any>[] {
  return listOf(raw, "orders").filter((o) => sameAddress(o.address, owner.address)).map((o) => pick(o, ORDER_KEPT));
}

/** The three lists a user row's `monerium` holds, minimised. */
export function keptSnapshot(owner: MoneriumOwner, found: { profiles?: unknown; ibans?: unknown; addresses?: unknown }) {
  return {
    profiles: keptProfiles(owner, found.profiles),
    ibans: keptIbans(owner, found.ibans),
    addresses: keptAddresses(owner, found.addresses),
  };
}

export const ownerOf = (u: { address: string; monerium?: { profileId?: string }; funding?: { moneriumProfileId?: string } }): MoneriumOwner => ({
  address: u.address,
  profileId: u.monerium?.profileId ?? u.funding?.moneriumProfileId,
});

/** GET /addresses/{safe} instead of the whole list, so the other addresses
 *  never reach us. 404 is "not linked": nothing to keep. */
export async function safeAddressRecord(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof MoneriumApiError && err.status === 404) return null;
    throw err;
  }
}
