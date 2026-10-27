/**
 * Business Home, without the DOM: what Quick send, the Security card, the
 * setup checklist and the Pending tab may say. Only what the API returned
 * is ticked; a read that failed is never taken as done or as not done.
 *
 * No imports, so scripts/business-home-test.ts loads it in node.
 */

/** Accounts a payment can be drafted from: the ones the send form offers. */
export const fundableAccounts = (accounts) => accounts.filter((a) => a.status === "active" && a.backingUserId && a.profile?.status !== "needs_check");
/** Contacts a payment can go to: a saved IBAN. */
export const payableContacts = (contacts) => contacts.filter((c) => (c.bankAccounts || []).some((b) => b.iban));
/** An account here that receives bank transfers. */
export const hasIban = (accounts) => accounts.some((a) => a.status === "active" && a.identifier?.iban);

/** Why Quick send cannot open the send form, or null when it can.
 *  `accounts` or `contacts` is null when it could not be read. */
export function quickSendBlock(accounts, contacts) {
  if (!accounts || !contacts) return "unread";
  if (!fundableAccounts(accounts).length) return "no-account";
  if (!payableContacts(contacts).length) return "no-contact";
  return null;
}

/** Runs drafted here and not yet on the statement. */
export const PENDING = ["PENDING_REVIEW", "REVIEWED", "EXECUTING"];
export const pendingRuns = (runs) => runs.filter((d) => PENDING.includes(d.state));

/**
 * The Security card's rows, from loadAccess (access-model.js). `ok` is true,
 * false, or null for "could not check". Null when there is nothing to show:
 * not the company login, or no Safe yet (the checklist says that).
 */
export function securityRows(access, links, passkeyName = "passkey") {
  if (!access || access.noSafe) return null;
  const s = access.signers, r = access.recovery;
  const rows = [];
  if (!s) rows.push({ ok: null, text: "Couldn’t read who signs for the account", view: "access" });
  else if (!s.passkeyIsOwner) rows.push({ ok: false, text: "This sign-in doesn’t sign for the account", view: "access" });
  else if (!s.zoldCanSend) rows.push({ ok: false, text: `Needs ${s.needed} signatures, so Zold can’t send`, view: "access" });
  else rows.push({ ok: true, text: `Your ${passkeyName} signs for the account` });

  if (r.status === "pending") rows.push({ ok: false, text: "A recovery is under way", action: { label: "Check", href: links.alert } });
  else if (r.status === "unknown") rows.push({ ok: null, text: "Couldn’t check recovery", view: "access" });
  else if (r.guardians.some((g) => g.kind === "other")) rows.push({ ok: false, text: "A recovery helper Zold didn’t set up is on the account", view: "access" });
  else if (r.guardians.some((g) => g.kind === "zoldenburg")) rows.push({ ok: true, text: "Zoldenburg recovery on" });
  else if (r.status === "set") rows.push({ ok: true, text: "Recovery on, by email or phone codes" });
  else rows.push({ ok: false, text: "Recovery not set up", action: { label: "Set up", href: links.recovery } });

  if (s) {
    rows.push(s.otherOwners.length
      ? { ok: true, text: s.otherOwners.length === 1 ? "Backup key added" : `${s.otherOwners.length} other signers` }
      : { ok: false, text: "Backup key not added", action: { label: "Add", href: links.signers } });
  }
  return rows;
}

/**
 * The company login's set-up steps, in order. The backup key's `done` is
 * null when the signers could not be read. `me` is GET /api/session,
 * `accounts` this organisation's.
 */
export function setupSteps(me, accounts, access) {
  const safeOn = me?.passkeySafe?.status === "active";
  const iban = hasIban(accounts);
  const signers = access?.signers;
  return [
    { id: "passkey", done: !!me?.passkey?.credentialId },
    { id: "account", done: safeOn },
    { id: "monerium", done: iban || me?.kycStatus === "approved" || !!me?.monerium?.connectedAt },
    { id: "iban", done: iban },
    { id: "backup", done: !safeOn ? false : signers ? signers.otherOwners.length > 0 : null },
  ];
}

/** The set-up card stays while any step is not known to be done. */
export const setupOpen = (steps) => steps.some((s) => s.done !== true);

/** What the no-IBAN note offers: `own` is whether this login's own account
 *  backs the organisation (only it connects Monerium for it). */
export function noIbanStep(own, me) {
  if (!own) return "not-own";
  return me?.monerium?.connectedAt ? "activate" : "connect";
}
