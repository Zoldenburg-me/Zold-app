/**
 * Settings → Access, without the DOM: who approves payments in an
 * organisation (every member), and who can sign for a company login's
 * Safe and who can recover it. The Safe and recovery are read from the three
 * routes the app's Security screen reads (safe/signers, recovery/zoldenburg,
 * recovery/candide). Those answer only for the signed-in user, so only the
 * company login itself sees them, and only in its own company
 * (isOwnCompanyOrg); other members read nothing of them. Signer and recovery
 * changes are made in the app (APP_LINKS).
 *
 * No imports, so scripts/business-access-test.ts loads it in node.
 */

/** Where a change is made: the app's own screens, on the same sign-in. */
export const APP_LINKS = {
  signers: "/app?from=business#signers",
  recovery: "/app?from=business#recovery-settings",
  alert: "/app?from=business#recovery-alert",
};

/** A request at one of these is a recovery under way. */
export const OPEN_REQUEST = ["PASSKEY_PENDING", "OTP_PENDING", "KYC_PENDING", "REVIEW_PENDING", "GRACE_PERIOD"];

export const isCompanyLogin = (me) => me?.accountType === "company";

/**
 * Is `org` the company this login IS? A company login can also be invited
 * into, or create, other organisations; its Safe is not their account. Yes
 * when an account here spends from this login's Safe, or, before any does,
 * when the login owns this business organisation and no account here spends
 * from someone else's. `accounts` is GET /api/orgs/:id/accounts; unread
 * (null) is no, so nothing is said about an organisation not yet read.
 */
export function isOwnCompanyOrg(me, org, accounts) {
  if (!isCompanyLogin(me) || !me.id || org?.type !== "business" || !Array.isArray(accounts)) return false;
  if (accounts.some((a) => a.backingUserId === me.id)) return true;
  return org.role === "owner" && !accounts.some((a) => a.backingUserId);
}

/**
 * The login's own Safe, where this organisation may show it: in the company
 * the login IS (isOwnCompanyOrg), or in a person's own personal space.
 * Anywhere else it is not this organisation's account, so null. The balance
 * is null when GET /api/session could not read the chain.
 */
export function ownSafeHere(me, org, accounts) {
  if (!me?.address || me.passkeySafe?.status !== "active") return null;
  const company = isOwnCompanyOrg(me, org, accounts);
  const personal = !isCompanyLogin(me) && org?.type === "personal" && org.role === "owner";
  if (!company && !personal) return null;
  return { address: me.address, balanceEur: typeof me.balanceEur === "number" ? me.balanceEur : null, company };
}

const lower = (a) => String(a || "").toLowerCase();

/**
 * Both guardians' answers, [candide, zoldenburg]. A guardian's routes exist
 * only where it is switched on (GET /api/health capabilities), so only those
 * are asked: undefined is "off here", null is "asked and failed". Health
 * unread: both null, since which guardians are on is unknown.
 */
export async function readGuardians(id, api) {
  const caps = (await api("/api/health").catch(() => null))?.capabilities;
  if (!caps) return [null, null];
  const ask = (on, path) => (on ? api(`/api/users/${encodeURIComponent(id)}/recovery/${path}`).catch(() => null) : Promise.resolve(undefined));
  return Promise.all([ask(caps.emailSmsRecovery, "candide"), ask(caps.zoldenburgRecovery, "zoldenburg")]);
}

/**
 * One reading of both guardians. `c` and `z` are the candide and zoldenburg
 * answers: null when the call failed, undefined when that guardian is
 * switched off on this deployment (readGuardians).
 *
 *  - pending: a recovery is under way (on chain, or a Zoldenburg request at an
 *             open step: the app's recovery-alert screen reads only those)
 *  - unknown: a call or a chain read failed. Never taken as none or as set:
 *             a recovery on the unread guardian would go unseen. `guardians`
 *             still lists the ones that were read.
 *  - set:     a guardian the chain shows, whatever Zold's records say. A
 *             guardian on chain that is neither Zoldenburg's nor the
 *             email/phone one Zold set up is listed as kind "other": it can
 *             start a recovery too, so it is never left out
 *  - none:    both answered, every chain read worked, and no guardian is on
 *             chain. `offered` is false when this deployment offers neither.
 */
export function recoveryStatus(c, z) {
  const chainPending = z?.onChain?.pendingRecovery || c?.onChain?.pendingRecovery || null;
  const request = (z?.requests || []).find((r) => OPEN_REQUEST.includes(r.status)) || null;
  const guardians = [];
  if (z?.onChain?.isGuardian) guardians.push({ kind: "zoldenburg" });
  if (c?.guardianAddress && (c.onChain?.guardians || []).some((g) => lower(g) === lower(c.guardianAddress))) {
    guardians.push({ kind: "codes", channels: (c.channels || []).map((x) => ({ channel: x.channel, target: x.target })) });
  }
  // Both reads list every guardian on the module, not only the ones Zold set
  // up. A stranger is named only when both answered: with one unread, its own
  // guardian would look like one (and the status is unknown anyway).
  const known = new Set([z?.guardianAddress, c?.guardianAddress].filter(Boolean).map(lower));
  const seen = new Set();
  for (const g of c !== null && z !== null ? [...(z?.onChain?.guardians || []), ...(c?.onChain?.guardians || [])] : []) {
    const k = lower(g);
    if (known.has(k) || seen.has(k)) continue;
    seen.add(k);
    guardians.push({ kind: "other", address: g });
  }
  const declinedAt = z?.choice?.choice === "declined" ? z.choice.at : null;
  const offered = Boolean(c?.available || z?.available);
  const base = { guardians, declined: Boolean(declinedAt), declinedAt, offered, pending: null, request: null };
  if (chainPending || request) return { ...base, status: "pending", pending: chainPending, request: chainPending ? null : request };
  const unread = c === null || z === null
    || Boolean(z && (z.onChainError || (z.active && !z.onChain)))
    || Boolean(c && (c.onChain?.error || (c.guardianStatus === "active" && !c.onChain)));
  if (unread) return { ...base, status: "unknown" };
  return { ...base, status: guardians.length ? "set" : "none" };
}

/** Owners and threshold as the chain holds them (GET .../safe/signers). */
export function signersView(s) {
  const owners = s.owners || [];
  const passkeyIsOwner = owners.some((o) => o.kind === "passkey");
  return {
    safeAddress: s.safeAddress,
    safeAppUrl: s.safeAppUrl || null,
    owners,
    threshold: s.threshold,
    needed: `${s.threshold} of ${owners.length}`,
    passkeyIsOwner,
    otherOwners: owners.filter((o) => o.kind !== "passkey").map((o) => o.address),
    // Zold signs only with the passkey and never collects another owner's
    // signature: without the passkey, or above 1, it sends nothing.
    zoldCanSend: passkeyIsOwner && s.threshold <= 1,
  };
}

/**
 * Who approves payments, from GET /api/orgs/:id/members (every role reads
 * it). Only active members count: an invite or a removed member approves
 * nothing and is no owner. `canApprove(role)` is the console's role table
 * (core.js ROLE_CAN). Unread members (null) is null, never "no approvers".
 */
export function approvalView(members, canApprove) {
  if (!Array.isArray(members)) return null;
  const active = members.filter((m) => m.status === "active");
  return { approvers: active.filter((m) => canApprove(m.role)), owners: active.filter((m) => m.role === "owner").length };
}

/**
 * This browser's payment key, as device.js keyStatus reports it: "none" (no
 * key bound to the account yet), "unknown" (this browser could not be read,
 * or its record is damaged: never taken as not here or as encrypted), "elsewhere" (bound, not in this browser),
 * "encrypted" (wrapped by the passkey) or "plain" (stored unencrypted).
 */
export function deviceKeyView(me, status) {
  if (!me?.authorizerAddress) return "none";
  if (!status || status.damaged) return "unknown";
  if (!status.present) return "elsewhere";
  if (status.protection === "none") return "plain";
  return status.protection ? "encrypted" : "unknown";
}

/** Everything Access shows, or null for a member who is not the company login. */
export async function loadAccess(me, api) {
  if (!isCompanyLogin(me) || !me.id) return null;
  if (me.passkeySafe?.status !== "active") return { noSafe: true, signers: null, signersError: null, recovery: null };
  const [s, g] = await Promise.allSettled([
    api(`/api/users/${encodeURIComponent(me.id)}/safe/signers`),
    readGuardians(me.id, api),
  ]);
  const [c, z] = g.status === "fulfilled" ? g.value : [null, null];
  return {
    noSafe: false,
    signers: s.status === "fulfilled" ? signersView(s.value) : null,
    signersError: s.status === "rejected" ? String(s.reason?.message || "Couldn’t read who can approve for the account.") : null,
    recovery: recoveryStatus(c, z),
  };
}
