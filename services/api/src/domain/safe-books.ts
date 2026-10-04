/**
 * From when a Safe's movements belong to the books of the account it backs.
 *
 * - A Safe Zold deployed: its whole life, from when it was planned (money can
 *   reach the address before the deployment itself).
 * - An imported Safe had a life before Zold: from when it got its IBAN here
 *   (issued onto it, or moved to it), else from the import.
 *
 * Connecting the Safe to an organisation's account says that account now
 * owns it, and the person is told so before (see the connect dialog), so
 * that history is the organisation's.
 */
import type { User } from "../store/types.js";

export function safeBooksStart(user: Pick<User, "createdAt" | "ibanSince" | "passkeySafe">): string {
  const safe = user.passkeySafe;
  if (safe?.importedAt) {
    return user.ibanSince && user.ibanSince > safe.importedAt ? user.ibanSince : safe.importedAt;
  }
  return safe?.createdAt ?? user.createdAt;
}
