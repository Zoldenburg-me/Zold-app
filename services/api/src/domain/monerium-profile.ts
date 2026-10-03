/**
 * Which Monerium profile may back which organisation's account. Pure rules;
 * the live read is adapters/monerium-profile.ts.
 *
 * Monerium's Personal Terms §16 forbid using a personal account on behalf of
 * a third party or to hold or move clients' money; the Business Terms are for
 * legal persons. So a business org's account may only be backed by a
 * `corporate` profile and a personal org's by a `personal` one, and in both
 * cases only once Monerium has approved the profile, or, while it is still
 * `pending`, has issued an approved IBAN on it to the backing Safe. That is
 * the same fact that approves the user in the app, so one IBAN is never open
 * in the app and "Not open" for the org it backs.
 *
 * Which profile a Zold login uses is decided once, at connect, by how the
 * login signed up (`pickProfileForSignup`): a personal signup uses only its
 * personal profile, a company signup only its corporate one, and the other
 * kind on the same Monerium login is never used. The profile recorded on the
 * backing user (`monerium.profileId`, else `funding.moneriumProfileId`) is the
 * one checked here. A company whose founder signed up personally gets its
 * own account, with its own Safe, set up by hand through support: one Safe
 * holding both a personal and a company IBAN would mix the two balances.
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

/** Where a personal login asks for a company account of its own, with its
 *  own Safe, to back a business org. Set up by hand; no self-serve path. */
export const SEPARATE_ACCOUNT_CONTACT = "support@zoldhq.com";

export type SignupAccountType = "individual" | "company";

export type ProfilePick =
  | { ok: true; profile: MoneriumProfileFacts }
  | { ok: false; status: 409; code: "MONERIUM_PROFILE_KIND_MISSING"; error: string };

/**
 * The one Monerium profile this Zold login may use, chosen by how it signed
 * up: `company` takes a corporate profile, anything else a personal one. The
 * approved one of that kind wins; with none approved, the first of that kind
 * (activation links under it and waits for Monerium). A profile of the other
 * kind is never picked, and a profile whose kind Monerium did not state is
 * not trusted to be either. No profile of the right kind refuses.
 */
export function pickProfileForSignup(accountType: SignupAccountType | undefined, profiles: unknown): ProfilePick {
  const kind: MoneriumProfileKind = accountType === "company" ? "corporate" : "personal";
  const ofKind = (Array.isArray(profiles) ? profiles : []).filter(
    (p: any): p is MoneriumProfileFacts => typeof p?.id === "string" && p.id !== "" && p.kind === kind,
  );
  const profile = ofKind.find((p) => p.state === "approved") ?? ofKind[0];
  if (profile) return { ok: true, profile };
  return {
    ok: false,
    status: 409,
    code: "MONERIUM_PROFILE_KIND_MISSING",
    error:
      kind === "corporate"
        ? "This Monerium login has only a personal profile, and your Zold account is for a company. Add a company profile to it at Monerium, or sign in there with your company's email and choose Company."
        : "This Monerium login has only a company profile, and your Zold account is personal. Add a personal profile to it at Monerium, or sign in there with a different email and choose Personal.",
  };
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
        error: `Business accounts need a company profile at Monerium, and this login is connected to a personal one. To send for ${orgLegalName(org)}, email ${SEPARATE_ACCOUNT_CONTACT}: we set up a separate account for the company, with its own Safe.`,
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
  ibanIssued = false,
): ProfileRefusal | null {
  if (profile.kind !== expectedProfileKind(org.type)) return kindMismatch(org);
  if (profile.state !== "approved" && !(profile.state === "pending" && ibanIssued)) {
    return {
      status: 409,
      code: "MONERIUM_PROFILE_NOT_APPROVED",
      error: `Monerium has not approved this profile yet (it is ${profile.state || "in an unknown state"}). Once they have, check again here.`,
    };
  }
  return null;
}

/** Has Monerium issued an approved IBAN on this profile that pays into this
 *  address? `ibans` is GET /ibans as Monerium answered it. */
export function ibanIssuedTo(ibans: unknown, profileId: string, address: string): boolean {
  const list: any[] = Array.isArray(ibans) ? ibans : Array.isArray((ibans as any)?.ibans) ? (ibans as any).ibans : [];
  return list.some((i) =>
    i?.profile === profileId &&
    i?.state === "approved" &&
    typeof i?.iban === "string" && i.iban.trim() !== "" &&
    typeof i?.address === "string" && i.address.toLowerCase() === address.toLowerCase(),
  );
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
