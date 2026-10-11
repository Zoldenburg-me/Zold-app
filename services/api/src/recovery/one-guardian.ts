/**
 * One guardian at a time. Every guardian on the recovery module sits at
 * threshold 1 and could recover the account alone, and nothing collects two
 * signatures yet. Zoldenburg and the account's own email/SMS (Candide)
 * guardian may share a module; a Google/Apple login shares it with nobody.
 * The Google/Apple add route has its own check (routes/recovery-turnkey.ts:
 * any other guardian on chain refuses it).
 */
import type { User } from "../store.js";
import { zoldenburgGuardianAddress } from "./zoldenburg-guardian.js";

export const ONE_GUARDIAN_MESSAGE = "remove your backup login first — one guardian at a time";

/** Does the module list a guardian that is none of `ours`? */
export function otherGuardianListed(guardians: readonly string[], ...ours: (string | undefined)[]): boolean {
  const known = ours.filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase());
  return guardians.some((g) => !known.includes(g.toLowerCase()));
}

/**
 * May Zoldenburg or the email/SMS guardian be added beside what the account
 * has? Refused while a Google/Apple guardian is active, or the module lists
 * any guardian other than those two. Call it when the op is prepared AND
 * right before it is submitted.
 */
export function hostedGuardianBlocked(user: User, guardians: readonly string[]): boolean {
  if ((user.passkeySafe?.socialGuardians ?? []).some((g) => g.status === "active")) return true;
  return otherGuardianListed(guardians, zoldenburgGuardianAddress(), user.passkeySafe?.candideRecovery?.guardianAddress);
}
