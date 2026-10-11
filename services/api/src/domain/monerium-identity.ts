/**
 * The Monerium identity an account carries. Pure rules; the routes that change
 * it are in routes/monerium.ts and the one writer of the history is
 * store.updateUser.
 */
import type { User } from "../store/types.js";

type IdentityFields = Pick<User, "monerium" | "iban" | "kycStatus" | "kyc" | "funding" | "moneriumProfileHistory">;

/**
 * Whether replacing the account's Monerium connection replaces an identity,
 * and so needs the passkey. True once the account was ever approved or has
 * ever recorded a Monerium profile, connected now or not: disconnecting and
 * releasing the IBAN leave an approved account with neither, and its
 * operator-facing identity must still not be swappable with a session alone.
 * Only a brand-new account, which has never connected, is false.
 */
export function carriesMoneriumIdentity(user: IdentityFields): boolean {
  return Boolean(
    user.monerium ||
      user.iban ||
      user.kycStatus === "approved" ||
      user.kyc?.checkedAt ||
      user.kyc?.applicantId ||
      user.funding?.moneriumProfileId ||
      user.moneriumProfileHistory?.length,
  );
}

/** The Monerium profile a patch records, if it names one. */
function patchedProfileId(patch: Partial<User>): string | undefined {
  const id = patch.monerium?.profileId ?? patch.funding?.moneriumProfileId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/**
 * The profile history after `patch`, or undefined when it does not change.
 * APPEND-ONLY: an entry is added when a patch records a profile other than
 * the last one; nothing is ever removed or rewritten. A profile held before
 * the history existed is entered first, undated.
 */
export function nextProfileHistory(
  current: IdentityFields,
  patch: Partial<User>,
  at: string,
): NonNullable<User["moneriumProfileHistory"]> | undefined {
  const profileId = patchedProfileId(patch);
  if (!profileId) return undefined;
  const history = current.moneriumProfileHistory ?? [];
  const held = current.monerium?.profileId ?? current.funding?.moneriumProfileId;
  const seeded = history.length === 0 && held && held !== profileId ? [{ profileId: held }] : history;
  if (seeded[seeded.length - 1]?.profileId === profileId) return seeded === history ? undefined : seeded;
  return [...seeded, { profileId, at }];
}
