/**
 * Read a Monerium profile on the backing user's OWN credentials and judge it
 * against the organisation it would back. The rules are
 * domain/monerium-profile.ts; this file only fetches and fails closed.
 *
 * Nothing about the profile is taken from the client: kind, state and name
 * all come from Monerium on this call.
 */
import { HARNESS } from "../config.js";
import { auditEntry } from "../audit.js";
import { store, type User } from "../store.js";
import type { Account, Organisation } from "../domain/types.js";
import {
  expectedProfileKind,
  ibanIssuedTo,
  judgeProfile,
  kindMismatch,
  nameWarning,
  type MoneriumProfileFacts,
  type ProfileRefusal,
} from "../domain/monerium-profile.js";
import { MoneriumApiError } from "./monerium-client.js";
import { hasOwnMoneriumCredentials, moneriumClientFor } from "./monerium-connection.js";

/** The one profile a user's connection stands for. */
export function backingProfileIdOf(user: User): string | undefined {
  const id = user.monerium?.profileId ?? user.funding?.moneriumProfileId;
  if (id) return id;
  return harnessProfile(user) ? harnessProfileId(user) : undefined;
}

/* The hardhat harness (HARNESS: chain 31337, never production) has no
 * Monerium, and its users are approved up front with no profile at all. They
 * stand in with a profile of whichever kind the org needs, so the local
 * end-to-end suites can fund an org; inert on any real chain by construction. */
const harnessProfileId = (user: User) => `harness-${user.id}`;
function harnessProfile(user: User): boolean {
  return (
    HARNESS.enabled &&
    !user.monerium?.profileId &&
    !user.funding?.moneriumProfileId &&
    !hasOwnMoneriumCredentials(user)
  );
}

/**
 * GET /profiles/:id for the kind and state, and the name from the list
 * (GET /profiles?kind=…), because the single-profile answer carries no name.
 * Throws a ProfileRefusal; never returns a guess.
 */
export async function readMoneriumProfile(user: User, profileId: string): Promise<MoneriumProfileFacts> {
  let client;
  try {
    client = moneriumClientFor(user);
  } catch {
    throw refusal(409, "MONERIUM_NOT_CONNECTED", "Connect your Monerium account first, so we can confirm whose IBAN this is.");
  }
  let one: any;
  try {
    one = await client.profile(profileId);
  } catch (err) {
    if (err instanceof MoneriumApiError && [400, 403, 404].includes(err.status)) {
      throw refusal(409, "MONERIUM_PROFILE_NOT_FOUND", "Your Monerium login cannot see the profile this account was connected with. Connect it again, then check again here.");
    }
    throw unreachable();
  }
  if (!one || one.id !== profileId || typeof one.kind !== "string" || typeof one.state !== "string") {
    throw unreachable();
  }
  const fresh = store.findUser(user.id);
  if (fresh?.monerium) {
    store.updateUser(user.id, {
      monerium: { ...fresh.monerium, profileSeen: { id: profileId, kind: one.kind, state: one.state, at: new Date().toISOString() } },
    });
  }
  let name: string | undefined = typeof one.name === "string" ? one.name : undefined;
  if (!name) {
    // The name only feeds a warning, so a failed list read leaves it unknown
    // rather than refusing a profile whose kind and state are already proven.
    try {
      const list = await client.profiles({ kind: one.kind === "corporate" ? "corporate" : "personal" });
      const items: any[] = Array.isArray(list) ? list : (list?.profiles ?? []);
      const hit = items.find((p) => p?.id === profileId);
      if (typeof hit?.name === "string") name = hit.name;
    } catch {}
  }
  return { id: profileId, kind: one.kind, state: one.state, ...(name ? { name } : {}) };
}

export type BackingCheck =
  | { ok: true; record: NonNullable<Account["moneriumProfile"]>; warning?: string; /** Passed while the profile is still pending, on an IBAN Monerium issued to this Safe. */ viaIssuedIban?: true }
  | ({ ok: false } & ProfileRefusal);

/**
 * May this user's Monerium profile back an account of this org? Used at
 * adoption, at re-check and (with `expectedId`) at execution. Fails closed:
 * Monerium unreachable is a refusal, not a pass.
 */
export async function checkBackingProfile(
  org: Pick<Organisation, "type" | "name" | "legalName">,
  user: User,
  expectedId?: string,
): Promise<BackingCheck> {
  const now = new Date().toISOString();
  const profileId = backingProfileIdOf(user);
  if (!profileId) {
    return { ok: false, ...refusal(409, "MONERIUM_NOT_CONNECTED", org.type === "business"
      ? "Business accounts need a company profile at Monerium. Connect it here first."
      : "Connect your Monerium account first, so we can confirm whose IBAN this is.") };
  }
  if (expectedId && expectedId !== profileId) {
    return { ok: false, ...refusal(409, "MONERIUM_PROFILE_CHANGED", "The Monerium profile connected to this login is not the one this account was checked against. Check the account again before sending.") };
  }
  if (harnessProfile(user)) {
    const kind = org.type === "business" ? "corporate" : "personal";
    return { ok: true, record: { id: profileId, kind, checkedAt: now } };
  }
  let facts: MoneriumProfileFacts;
  try {
    facts = await readMoneriumProfile(user, profileId);
  } catch (err) {
    if (isRefusal(err)) return { ok: false, ...err };
    return { ok: false, ...unreachable() };
  }
  const viaIssuedIban = facts.state === "pending" && await ibanIssuedLive(user, profileId);
  const refused = judgeProfile(org, facts, viaIssuedIban);
  if (refused) return { ok: false, ...refused };
  const warning = nameWarning(org, facts.name) ?? undefined;
  return {
    ok: true,
    record: {
      id: facts.id,
      kind: facts.kind as "personal" | "corporate",
      ...(facts.name ? { name: facts.name } : {}),
      checkedAt: now,
    },
    ...(warning ? { warning } : {}),
    ...(viaIssuedIban ? { viaIssuedIban: true } : {}),
  };
}

/** GET /ibans on the user's own connection, read only for a pending profile.
 *  A failed read counts as no IBAN: the profile stays refused. */
async function ibanIssuedLive(user: User, profileId: string): Promise<boolean> {
  if (!user.address) return false;
  try {
    return ibanIssuedTo(await moneriumClientFor(user).ibans(), profileId, user.address);
  } catch (err) {
    console.warn(`monerium-profile: GET /ibans failed for ${user.id} (profile ${profileId}); the pending profile stays refused: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

function refusal(status: number, code: ProfileRefusal["code"], error: string): ProfileRefusal {
  return { status, code, error };
}

function unreachable(): ProfileRefusal {
  return refusal(503, "MONERIUM_UNREACHABLE", "Monerium did not answer, so we could not confirm whose IBAN this is. Nothing was changed; try again in a moment.");
}

function isRefusal(v: unknown): v is ProfileRefusal {
  return Boolean(v && typeof v === "object" && "code" in v && "status" in v && "error" in v);
}

/** One audit entry per check, pass or refusal, so "which legal entity owned
 *  this IBAN when that payment went out" is answerable later. */
export function auditProfileCheck(
  stage: "adopt" | "fund" | "recheck" | "execute",
  where: { orgId: string; accountId?: string },
  backingUserId: string,
  result: BackingCheck,
  actorId: string,
) {
  store.audit(auditEntry("account.monerium_profile_checked", {
    stage,
    orgId: where.orgId,
    ...(where.accountId ? { accountId: where.accountId } : {}),
    backingUserId,
    ...(result.ok
      ? { outcome: "passed", profileId: result.record.id, profileKind: result.record.kind, profileName: result.record.name ?? null, nameWarning: Boolean(result.warning), viaIssuedIban: Boolean(result.viaIssuedIban) }
      : { outcome: "refused", code: result.code }),
  }, actorId));
}

/**
 * Would adopting the caller's account for this org pass, judged from what is
 * already stored (the profile snapshot taken at connect)? For the UI only, so
 * it renders the "fund" control where the API would accept it. No network:
 * the API re-reads Monerium on the real call and that answer wins.
 */
export function adoptionHint(
  org: Pick<Organisation, "type" | "name" | "legalName">,
  user: User | undefined,
): { allowed: boolean; code?: ProfileRefusal["code"]; reason?: string } {
  if (!user || user.funding?.status !== "active") {
    return { allowed: false, reason: "Your own account is not funded yet." };
  }
  const profileId = backingProfileIdOf(user);
  if (!profileId) {
    return { allowed: false, code: "MONERIUM_NOT_CONNECTED", reason: org.type === "business"
      ? "Business accounts need a company profile at Monerium. Connect it here first."
      : "Connect your Monerium account first." };
  }
  if (harnessProfile(user)) return { allowed: true };
  // Only the kind is judged from the stored copy: a profile does not change
  // kind. Its state does, and the copy is from the last connect or activation,
  // often from before Monerium approved it. The state is left to the live
  // check (checkBackingProfile), which refuses a profile still pending, so a
  // stale "pending" never hides the button that runs it.
  const known = (user.monerium?.profiles ?? []).find((p: any) => p?.id === profileId);
  if (known && typeof known.kind === "string" && known.kind !== expectedProfileKind(org.type)) {
    const refused = kindMismatch(org);
    return { allowed: false, code: refused.code, reason: refused.error };
  }
  return { allowed: true };
}

/**
 * What Monerium last said about the caller's profile when it was not yet
 * approved, for the Accounts screen: the latest live read if there is one,
 * else the snapshot from connect. Stored facts only; `at` says how old they
 * are, and the live check on "connect" is what decides.
 */
export function profileWait(user: User | undefined): { state: string; at: string } | undefined {
  if (!user || harnessProfile(user)) return undefined;
  const id = backingProfileIdOf(user);
  if (!id) return undefined;
  const seen = user.monerium?.profileSeen;
  if (seen?.id === id) return seen.state === "approved" ? undefined : { state: seen.state, at: seen.at };
  const known = (user.monerium?.profiles ?? []).find((p: any) => p?.id === id);
  const at = user.monerium?.connectedAt;
  if (known && typeof known.state === "string" && known.state !== "approved" && at) return { state: known.state, at };
  return undefined;
}
