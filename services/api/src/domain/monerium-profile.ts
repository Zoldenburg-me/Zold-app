/**
 * Which Monerium profile may back which organisation's account. Pure rules;
 * the live read is adapters/monerium-profile.ts.
 *
 * Monerium's Personal Terms §16 forbid using a personal account on behalf of
 * a third party or to hold or move clients' money; the Business Terms are for
 * legal persons. So a business org's account may only be backed by a
 * `corporate` profile and a personal org's by a `personal` one, and in both
 * cases only once Monerium has approved the profile.
 *
 * Choosing among several profiles on one Monerium login is not built: the
 * profile recorded on the backing user (`monerium.profileId`, else
 * `funding.moneriumProfileId`) is the one checked, so a company needs its own
 * Zold login connected to its corporate profile.
 */
import type { Account, MoneriumProfileKind, OrgType, Organisation } from "./types.js";

export interface MoneriumProfileFacts {
  id: string;
  kind: string;
  state: string;
  name?: string;
}

export interface ProfileRefusal {
  status: number;
  code:
    | "MONERIUM_PROFILE_KIND_MISMATCH"
    | "MONERIUM_PROFILE_NOT_APPROVED"
    | "MONERIUM_PROFILE_CHANGED"
    | "MONERIUM_PROFILE_UNVERIFIED"
    | "MONERIUM_PROFILE_NOT_FOUND"
    | "MONERIUM_NOT_CONNECTED"
    | "MONERIUM_UNREACHABLE";
  error: string;
}

export function expectedProfileKind(type: OrgType): MoneriumProfileKind {
  return type === "business" ? "corporate" : "personal";
}

/** The name an org's documents carry: its legal name, else its display name. */
export function orgLegalName(org: Pick<Organisation, "name" | "legalName">): string {
  return org.legalName?.trim() || org.name;
}

export function kindMismatch(org: Pick<Organisation, "type" | "name" | "legalName">): ProfileRefusal {
  return org.type === "business"
    ? {
        status: 409,
        code: "MONERIUM_PROFILE_KIND_MISMATCH",
        error: `Business accounts need a company profile at Monerium. Open one for ${orgLegalName(org)}, then connect it here.`,
      }
    : {
        status: 409,
        code: "MONERIUM_PROFILE_KIND_MISMATCH",
        error: "A personal account must be backed by your own personal profile at Monerium, not a company's.",
      };
}

/** Does this profile, as Monerium reports it, qualify to back this org's
 *  account? `null` when it does. */
export function judgeProfile(
  org: Pick<Organisation, "type" | "name" | "legalName">,
  profile: MoneriumProfileFacts,
): ProfileRefusal | null {
  if (profile.kind !== expectedProfileKind(org.type)) return kindMismatch(org);
  if (profile.state !== "approved") {
    return {
      status: 409,
      code: "MONERIUM_PROFILE_NOT_APPROVED",
      error: `Monerium has not approved this profile yet (it is ${profile.state || "in an unknown state"}). Once they have, check again here.`,
    };
  }
  return null;
}

/* Legal-form words that differ between how a company writes its name and how
 * a register or a bank does. Stripped from the END only, so "AG Consulting"
 * keeps its "AG". Compared after diacritics and punctuation are gone. */
const LEGAL_FORMS = new Set([
  "gmbh", "mbh", "ug", "haftungsbeschrankt", "ag", "kg", "ohg", "gbr", "ek", "ev", "eg",
  "se", "co", "kgaa", "partg", "ltd", "limited", "llc", "inc", "bv", "nv", "sarl", "sas", "sa",
]);

export function normaliseLegalName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // "e. K." and "e.V." arrive as two one-letter words.
  const joined: string[] = [];
  for (const w of words) {
    const prev = joined[joined.length - 1];
    if (prev && prev.length === 1 && w.length === 1) joined[joined.length - 1] = prev + w;
    else joined.push(w);
  }
  while (joined.length > 1 && LEGAL_FORMS.has(joined[joined.length - 1])) joined.pop();
  return joined.join(" ");
}

/**
 * A warning, never a block: register names, trading names and Monerium's
 * spelling legitimately differ, so a mismatch is shown for a human to judge.
 * `null` when the names agree.
 */
export function nameWarning(
  org: Pick<Organisation, "type" | "name" | "legalName">,
  profileName: string | undefined,
): string | null {
  if (org.type !== "business") return null;
  const ours = orgLegalName(org);
  if (!profileName?.trim()) {
    return `Monerium did not tell us the company name on this profile, so we could not compare it with ${ours}.`;
  }
  if (normaliseLegalName(profileName) === normaliseLegalName(ours)) return null;
  return `The company at Monerium is "${profileName}", but this organisation's legal name is "${ours}". Payments still go through; check that the IBAN belongs to this company.`;
}

export type ProfileStanding =
  | { status: "not_applicable" }
  | { status: "verified"; kind: MoneriumProfileKind; name?: string; checkedAt: string; warning?: string }
  | { status: "needs_check"; reason: string };

/**
 * Read-time verdict on an account's recorded profile, for the account list.
 * Nothing is rewritten: an account adopted before the check existed simply
 * reads as needing a check, and execution refuses it until one passes.
 */
export function accountProfileStanding(
  org: Pick<Organisation, "type" | "name" | "legalName">,
  account: Pick<Account, "backingUserId" | "moneriumProfile">,
): ProfileStanding {
  if (!account.backingUserId) return { status: "not_applicable" };
  const p = account.moneriumProfile;
  if (!p) {
    if (org.type !== "business") return { status: "not_applicable" };
    return {
      status: "needs_check",
      reason: "We have not yet confirmed that this IBAN belongs to a company profile at Monerium. Sending is paused until the check passes.",
    };
  }
  if (p.kind !== expectedProfileKind(org.type)) {
    return { status: "needs_check", reason: kindMismatch(org).error };
  }
  const warning = nameWarning(org, p.name);
  return { status: "verified", kind: p.kind, name: p.name, checkedAt: p.checkedAt, ...(warning ? { warning } : {}) };
}
