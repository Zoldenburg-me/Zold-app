/**
 * Business Home, without the DOM: what the Security card, the setup
 * checklist and the Pending tab may say, and which accounts and contacts the
 * send form (send.js) offers. Only what the API returned
 * is ticked; a read that failed is never taken as done or as not done.
 *
 * No imports, so scripts/business-home-test.ts loads it in node.
 */

/** Statement lines that count as income or an expense: not the ones marked
 *  as between the holder's own accounts. */
export const countedLines = (lines) => lines.filter((l) => !l.ownTransfer);

/** Accounts a payment can be drafted from: the ones the send form offers. */
export const fundableAccounts = (accounts) => accounts.filter((a) => a.status === "active" && a.backingUserId && a.profile?.status !== "needs_check");
/** Contacts a payment can go to: a saved IBAN. */
export const payableContacts = (contacts) => contacts.filter((c) => (c.bankAccounts || []).some((b) => b.iban));
/** An account here that receives bank transfers. */
export const hasIban = (accounts) => accounts.some((a) => a.status === "active" && a.identifier?.iban);

/** What the balance card says for a company. A company's account is its own
 *  Safe, not a login's, so the card has no figure for it: a live euro account
 *  shows its IBAN; one not live, the account's own gate, which the server
 *  words from what it lacks (no Safe yet, or a Safe waiting for its IBAN).
 *  `accounts` is null when they could not be read, and a failed read says
 *  so, never that no account is connected. Null for any other organisation
 *  or a company with no euro account. */
export function companyBalance(org, accounts) {
  if (org?.entity !== "company") return null;
  if (!Array.isArray(accounts)) return { note: "The company’s account could not be read just now. Reload to try again." };
  const a = accounts.find((x) => x.currency === "EUR");
  if (!a) return null;
  if (a.status === "active") return { iban: a.identifier?.iban || null };
  return { note: a.gate?.reason || "The company’s account is not live yet." };
}

/** Runs drafted here and not yet sent: with review off, a saved payment waits as DRAFT. */
const PENDING = ["DRAFT", "PENDING_REVIEW", "REVIEWED", "EXECUTING"];
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
    // Connected now, not once: a removed connection is a step to do again.
    { id: "monerium", done: !!me?.monerium?.connectedAt },
    { id: "iban", done: iban },
    { id: "backup", done: !safeOn ? false : signers ? signers.otherOwners.length > 0 : null },
  ];
}

/** The command a typed line means: the first one it is the start of, case
 *  aside. Null for anything that is not a slash line, which is a search. */
export function commandFor(text, cmds) {
  // A question mark or full stop at the end is part of asking, not of the command.
  const q = String(text || "").trim().toLowerCase().replace(/[\s?.!]+$/, "");
  if (q.length < 2 || !q.startsWith("/")) return null;
  // A question with a blank (`match`, such as which month) is that question whatever fills it.
  return cmds.find((c) => c.cmd.toLowerCase().startsWith(q)) ?? cmds.find((c) => c.match?.test(q)) ?? null;
}

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The month a question names, as "YYYY-MM": "2026-10", "October", "oct 2025".
 *  A month without a year is the latest one not after `now`. Null for none. */
export function monthIn(text, now = new Date()) {
  const q = String(text || "").toLowerCase();
  const iso = q.match(/\b(20\d\d)-(0[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  if (/\bthis month\b/.test(q)) return now.toISOString().slice(0, 7);
  if (/\blast month\b/.test(q)) return lastMonth(now);
  // Whole month names or their short forms only: "marketing" is not March.
  const m = q.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\.?\s+(20\d\d))?\b/);
  if (!m) return null;
  const mi = MONTH_KEYS.indexOf(m[1].slice(0, 3));
  const y = m[2] ? Number(m[2]) : now.getUTCFullYear() - (mi > now.getUTCMonth() ? 1 : 0);
  return `${y}-${String(mi + 1).padStart(2, "0")}`;
}

/** Today by the browser's own calendar, as a UTC midnight, so the month
 *  helpers above read the local date: just after midnight on the 1st in
 *  Berlin is already the new month. */
export const localDay = (d = new Date()) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

/** The reads an answer depends on that failed: null is a failed read, false
 *  one this person does not have. An answer says "nothing" only when this is empty. */
export const unreadOf = (reads) => Object.keys(reads).filter((k) => reads[k] === null);

/** What some payment runs add up to, per asset, as numbers: { EUR: 120, USDC: 40 }.
 *  The drafts API keeps each asset apart (totalsByAsset); so does this. */
export function assetTotals(runs) {
  const out = {};
  for (const r of runs || []) for (const [asset, v] of Object.entries(r.totals || {})) out[asset] = (out[asset] || 0) + Number(v || 0);
  return out;
}

/** Supplier invoices Pay has turned into a payment run that is not sent
 *  yet: still unpaid, so still due. */
export const payingInvoices = (invoices) => (invoices || [])
  .filter((i) => i.direction !== "outgoing" && i.state === "PAYING" && !i.payment?.transferId);

/** The calendar month before `now`'s, as "YYYY-MM". */
export function lastMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** The biggest names on one side of some statement lines, in cents: [[name, cents], ...]. */
export function topBy(lines, dir, n = 4) {
  const by = new Map();
  for (const l of lines) {
    const v = dir === "in" ? l.amountCents : -l.amountCents;
    if (v <= 0) continue;
    const who = l.counterparty?.name || (dir === "in" ? "Money in" : "Payment");
    by.set(who, (by.get(who) || 0) + v);
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Where one month's money went, from the lines Books counts: totals in
 *  and out in cents, the biggest payers and payees, and how many lines. */
export function monthSummary(lines, ym) {
  const month = lines.filter((l) => String(l.valueDate || "").slice(0, 7) === ym);
  const sum = (dir) => month.reduce((n, l) => n + (dir === "in" ? Math.max(l.amountCents, 0) : Math.max(-l.amountCents, 0)), 0);
  return { count: month.length, inCents: sum("in"), outCents: sum("out"), payers: topBy(month, "in"), payees: topBy(month, "out") };
}

/** Invoices you issued that are still owed to you: the overdue ones first,
 *  then by due date, the undated last. Drafts, paid and deleted ones are out. */
export function owedInvoices(invoices) {
  const due = (i) => (i.dueDate ? Date.parse(i.dueDate) : Infinity);
  return (invoices || [])
    .filter((i) => i.direction === "outgoing" && !["PAID", "RECONCILED", "DRAFT", "DELETED"].includes(i.state))
    .sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || due(a) - due(b));
}

/** What a submitted line does: run a command, say there is no such command, search, or nothing. */
export function submitFor(text, cmds) {
  const q = String(text || "").trim(), cmd = commandFor(q, cmds);
  if (cmd) return { cmd };
  if (q.startsWith("/")) return { unknown: true };
  return q ? { search: q } : null;
}

/** The set-up card stays while any step is not known to be done. */
export const setupOpen = (steps) => steps.some((s) => s.done !== true);

/** What the no-IBAN note offers: `own` is whether this login's own account
 *  backs the organisation (only it connects Monerium for it). The IBAN is
 *  issued on the login's own account in the app ("activate"); once it has
 *  one, Accounts connects it to this organisation ("adopt"). */
export function noIbanStep(own, me) {
  if (!own) return "not-own";
  if (!me?.monerium?.connectedAt) return "connect";
  return me.iban ? "adopt" : "activate";
}
