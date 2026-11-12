/**
 * Whether the ENS gateway answers for an account, and the name it answers to.
 *
 * One test for both: the gateway signs records only where `ensSafe` gives an
 * address, and the session publishes `ensNameOf` only then, so Home never
 * shows a name that does not resolve. Pure: the gateway's parent name is
 * passed in (null when this deployment runs no gateway).
 */
import type { User } from "../store.js";

type Named = Pick<User, "address" | "passkeySafe" | "paymentPage">;

/**
 * The passkey Safe the account's name resolves to, or null: no payment-page
 * handle, no Safe deployed yet ("active" is set once it is), or a Safe that is
 * not the account's address. Never the page's deposit address: in production
 * that is a forwarder that moves only USDC, so EURe sent to the name would
 * strand there.
 */
export function ensSafe(u: Named | undefined): string | null {
  const safe = u?.passkeySafe;
  if (!u?.paymentPage?.handle || safe?.status !== "active") return null;
  return u.address.toLowerCase() === safe.address.toLowerCase() ? safe.address : null;
}

/** The parent to name accounts under on Home, or null: no gateway, or one
 *  whose names no wallet has resolved yet (config/ens.ts namesLive). */
export const shownParent = (gw: { enabled: boolean; namesLive: boolean; parent: string }): string | null =>
  gw.enabled && gw.namesLive ? gw.parent : null;

/** `<handle>.<parent>`, or null where the gateway gives no answer. */
export function ensNameOf(u: Named | undefined, parent: string | null): string | null {
  return parent && ensSafe(u) ? `${u!.paymentPage!.handle}.${parent}` : null;
}
