/**
 * Home of the business console (design canvas "Home, business: Banking"):
 * what needs you, money in and out, the accounts, invoices and payments at a
 * glance, who paid and who got paid, and the latest statement lines.
 *
 * Rules for what this file shows:
 * - There is no company balance. Only the account backed by YOUR own account
 *   shows a figure; another names the member who backs it.
 * - Money in and out is summed from the statement lines Books shows. An org
 *   without Books gets no chart, never a row of zeros.
 * - Money out is Sent, never Paid: the bank's confirmation is not on a line.
 * - Quick send only opens the send form (send.js), filled in; it sends nothing.
 * - Security and the set-up list speak only for the company login in its own
 *   company, from what Access reads (access-model.js).
 */
import { $, Z, api, cap, ensureMe, esc, eur, gateHtml, maskIban, me, org, ownSafe, refreshMe, roleCan, safeAddressHtml, setView, view, when, ymd } from "./core.js";
import { META, RENDER, moneriumLink } from "./views.js";
import { side, submittedInvoices, waitingForMe } from "./nav.js";
import { draftTag, draftTitle, draftTotal, invAmount, loadMembers, memberName } from "./screens.js";
import { APP_LINKS, isOwnCompanyOrg, loadAccess } from "./access-model.js";
import { hasIban, noIbanStep, payableContacts, pendingRuns, quickSendBlock, securityRows, setupOpen, setupSteps } from "./home-model.js";
import { sendState } from "./send.js";
import { runLink } from "./payment.js";
import { runIdForLine } from "./payment-model.js";
import { render } from "./shell.js";

const DAY = 86400000;
/* "Sep", not the "Sept" some locales give, to match dates elsewhere in the app. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_MAX_PX = 120;
const TOP_N = 4;
const ACTIVITY_ROWS = 8;
/* Access reads the chain; a slow read leaves out Security and Set up rather than hold up Home. */
const ACCESS_WAIT_MS = 4000;
const PERIODS = [["30d", "Last 30 days"], ["month", "This month"], ["3m", "3 months"]];
const LINE_WORD = { sepa_in: "Received", sepa_out: "Sent", sepa_out_reversal: "Refunded", crypto_converted: "Received", crypto_held: "Received", eure_in: "Received", sweep: "Done" };

/* What the page remembers between redraws of one section. */
const hs = { period: "30d", tab: "all", month: null };

const linkBtn = (label, view, icon, variant = "secondary") => `<a class="z-btn z-btn--${variant}" href="?view=${esc(view)}" data-view-link="${esc(view)}">${icon ? Z.icon(icon) : ""}<span>${esc(label)}</span></a>`;
const isoDay = (d) => d.toISOString().slice(0, 10);
export const cents = (lines, dir) => lines.reduce((n, l) => n + (dir === "in" ? Math.max(l.amountCents, 0) : Math.max(-l.amountCents, 0)), 0);
const sumEur = (d) => Number(d.totals?.EUR || d.totals?.EURe || 0);
const within = (iso, days) => !!iso && Date.now() - Date.parse(iso) <= days * DAY;

/* ── Money in and out ─────────────────────────────────────────────────────── */

function windowOf(period) {
  const today = new Date();
  const from = period === "month" ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    : new Date(today.getTime() - (period === "3m" ? 89 : 29) * DAY);
  return { from: isoDay(from), to: isoDay(today) };
}

/** Weekly buckets from the Monday on or before `from`. */
export function weeks(lines, from, to) {
  const start = new Date(`${from}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const out = [];
  for (let d = start; isoDay(d) <= to; d = new Date(d.getTime() + 7 * DAY)) {
    const a = isoDay(d), b = isoDay(new Date(d.getTime() + 6 * DAY));
    const wk = lines.filter((l) => l.valueDate >= a && l.valueDate <= b);
    out.push({ label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, in: cents(wk, "in"), out: cents(wk, "out") });
  }
  return out;
}

/** Paired weekly bars, money in beside money out, with a list for screen readers. */
export function barsHtml(buckets, caption) {
  const max = Math.max(1, ...buckets.flatMap((b) => [b.in, b.out]));
  const h = (v) => (v ? Math.max(4, Math.round((v / max) * BAR_MAX_PX)) : 0);
  return `<figure class="zb-h-chart"><figcaption class="z-sr">${esc(caption)}</figcaption>
      <div class="zb-h-bars" style="--n:${buckets.length}">${buckets.map((b) => `<div class="zb-h-bar" title="${esc(b.label)}: in ${esc(eur(b.in / 100))}, out ${esc(eur(b.out / 100))}"><span class="zb-h-bar__in" style="height:${h(b.in)}px"></span><span class="zb-h-bar__out" style="height:${h(b.out)}px"></span></div>`).join("")}</div>
      <div class="zb-h-axis" style="--n:${buckets.length}" aria-hidden="true">${buckets.map((b) => `<span>${esc(b.label)}</span>`).join("")}</div>
      <ul class="z-sr">${buckets.map((b) => `<li>Week of ${esc(b.label)}: in ${esc(eur(b.in / 100))}, out ${esc(eur(b.out / 100))}</li>`).join("")}</ul></figure>`;
}

function flowCard(all) {
  const { from, to } = windowOf(hs.period);
  const lines = all.filter((l) => l.valueDate >= from && l.valueDate <= to);
  const inC = cents(lines, "in"), outC = cents(lines, "out");
  const buckets = weeks(lines, from, to);
  const label = PERIODS.find((p) => p[0] === hs.period)[1];
  const pills = PERIODS.map(([id, text]) => `<button type="button" class="zb-h-pill" data-hp="${id}" aria-pressed="${hs.period === id}">${text}</button>`).join("");
  const signed = (sign, c) => `${c ? sign : ""}${esc(eur(Math.abs(c) / 100))}`;
  return `<div class="zb-h-flowhead"><div class="zb-h-pills" role="group" aria-label="Period">${pills}</div>
      <span class="zb-h-io"><span class="is-in">${Z.icon("north_east")}<span class="z-sr">Money in </span>${signed("+", inC)}</span>
      <span class="is-out">${Z.icon("south_east")}<span class="z-sr">Money out </span>${signed("−", outC)}</span></span></div>
    ${lines.length ? barsHtml(buckets, `Money in and out per week, ${label.toLowerCase()}`)
      : `<p class="zb-hint">No money moved in this period.</p>`}`;
}

/** The balance as a figure with smaller cents, the way a bank app prints it. */
const bigEur = (v) => {
  const t = eur(v), m = t.match(/^(.*)([.,]\d{2})$/);
  return m ? `${esc(m[1])}<span class="zb-h-cents">${esc(m[2])}</span>` : esc(t);
};

/** Only YOUR own Safe has a figure (RULES §4): through the account it backs,
 *  or on its own before any IBAN is connected, with its address. Only where
 *  this organisation may show it (ownSafe); `read` is false when the accounts
 *  could not be read, and then nothing is said about the Safe. */
function balanceCard(accounts, lines, read) {
  const mine = accounts.find((a) => a.status === "active" && a.backingUserId && me && a.backingUserId === me.id);
  const safe = read ? ownSafe(accounts) : null;
  const fig = (mine || safe) && typeof me.balanceEur === "number";
  const other = !mine && accounts.find((a) => a.backingUserId);
  const label = mine ? `${mine.label || mine.currency} balance` : safe?.company ? "Company Zold account" : "Your Zold account";
  const head = fig
    ? `<span class="zb-h-bal__label">${esc(label)}</span><span class="zb-h-bal__fig">${bigEur(me.balanceEur)}</span>`
    : mine || safe
      ? `<span class="zb-h-bal__label">${esc(label)}</span><p class="zb-hint">The balance could not be read just now. Reload to try again.</p>`
      : `<span class="zb-h-bal__label">Balance</span><p class="zb-hint">${other ? `Only ${esc(other.backingMemberName || "the member who backs it")} sees this account’s balance.` : "No account is connected yet."}</p>`;
  return `<section class="z-card zb-side-card zb-h-bal" aria-labelledby="home-bal"><h2 id="home-bal" class="z-sr">Balance and money in and out</h2>
    <div class="zb-h-bal__head">${head}${safe ? safeAddressHtml(safe) : ""}</div>
    ${lines ? `<div id="hm-flow">${flowCard(lines)}</div>` : ""}</section>`;
}

/* ── Money movement and activity ──────────────────────────────────────────── */

function top(lines, dir) {
  const by = new Map();
  for (const l of lines) {
    const v = dir === "in" ? l.amountCents : -l.amountCents;
    if (v <= 0) continue;
    const who = l.counterparty?.name || (dir === "in" ? "Money in" : "Payment");
    by.set(who, (by.get(who) || 0) + v);
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
}

function movement(all, months) {
  if (!hs.month || !months.includes(hs.month)) hs.month = months[0];
  const i = months.indexOf(hs.month);
  const lines = all.filter((l) => l.valueDate.slice(0, 7) === hs.month);
  const name = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${hs.month}-15T12:00:00`));
  const side2 = (dir, title, sub) => {
    const rows = top(lines, dir);
    const total = cents(lines, dir) / 100;
    return `<div class="z-card zb-h-move"><div class="zb-h-fig"><span class="zb-h-fig__label">${title}</span><span class="zb-h-fig__value ${dir === "in" ? "is-in" : ""}">${total ? (dir === "in" ? "+" : "−") : ""}${esc(eur(total))}</span></div>
      <h3 class="zb-h-sub">${sub}</h3>
      ${rows.length ? `<ul class="zb-h-tops">${rows.map(([who, v]) => `<li>${Z.avatar({ name: who })}<span>${esc(who)}</span><b>${esc(eur(v / 100))}</b></li>`).join("")}</ul>` : `<p class="zb-hint">None this month.</p>`}</div>`;
  };
  return `<div class="zb-h-head"><h2 class="zb-h2" id="home-move">Money movement</h2>
      <span class="zb-h-month"><button type="button" class="zb-h-icon-btn" data-hm="${esc(months[i + 1] || "")}" aria-label="Previous month"${months[i + 1] ? "" : ' disabled title="No earlier month with money in or out"'}>${Z.icon("chevron_left")}</button>
      <span>${esc(name)}</span>
      <button type="button" class="zb-h-icon-btn" data-hm="${esc(months[i - 1] || "")}" aria-label="Next month"${i > 0 ? "" : ' disabled title="This is the latest month"'}>${Z.icon("chevron_right")}</button></span></div>
    <div class="zb-grid2">${side2("in", "Money in", "Top payers")}${side2("out", "Money out", "Top payees")}</div>`;
}

/** Runs drafted and not yet sent, for the Pending tab. */
function pendingRows(runs, limit) {
  return pendingRuns(runs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit).map((d) => {
    const ref = d.lines.length === 1 ? d.lines[0].note : "";
    return `<tr><td class="z-dim">${esc(when(d.createdAt))}</td>
        <td><span class="z-tbl__who">${Z.avatar({ name: draftTitle(d) })}${runLink(d.id, esc(draftTitle(d)))}</span></td>
        <td>${ref ? esc(ref) : '<span class="z-dim">No memo</span>'}</td>
        <td>${draftTag(d)}</td>
        <td class="z-tbl__num">−${esc(draftTotal(d))}</td></tr>`;
  });
}

/** Home shows the latest few; Transactions shows them all. `runs` (Home
 *  only) adds the Pending tab: payments drafted here, not yet sent. */
function activity(all, limit = ACTIVITY_ROWS, runs = null) {
  const tab = hs.tab === "pending" && !runs ? "all" : hs.tab;
  const tabs = [["all", "All"], ["in", "Money in"], ["out", "Money out"], ...(runs ? [["pending", "Pending"]] : [])].map(([id, text]) => `<button type="button" class="zb-h-chip" data-ht="${id}" aria-pressed="${tab === id}">${text}</button>`).join("");
  const exp = cap("export.ledger").allowed ? `<button type="button" class="z-btn z-btn--sm z-btn--secondary" data-act="export-ledger">${Z.icon("download")}<span>Export CSV</span></button>` : "";
  const rows = tab === "pending" ? pendingRows(runs, limit) : [...all].filter((l) => tab === "all" || (tab === "in") === (l.amountCents >= 0))
    .sort((a, b) => b.valueDate.localeCompare(a.valueDate)).slice(0, limit).map((l) => {
      const inbound = l.amountCents >= 0;
      const who = l.counterparty?.name || (inbound ? "Money in" : "Payment");
      // A payment this organisation sent opens its run; anything else opens Books.
      const run = runIdForLine(runs, l);
      return `<tr><td class="z-dim">${esc(when(ymd(l.valueDate)))}</td>
        <td><span class="z-tbl__who">${Z.avatar({ name: who })}${run ? runLink(run, esc(who)) : `<a class="z-tbl__link" href="?view=books" data-view-link="books">${esc(who)}</a>`}</span></td>
        <td>${l.note ? esc(l.note) : l.reference ? esc(l.reference) : '<span class="z-dim">No memo</span>'}</td>
        <td>${Z.tag(LINE_WORD[l.event] || (inbound ? "Received" : "Sent"))}</td>
        <td class="z-tbl__num">${Z.amount({ value: Math.abs(l.amountCents) / 100, direction: inbound ? "in" : "out" })}</td></tr>`;
    });
  const all_ = limit === Infinity;
  return `<div class="zb-h-head">${all_ ? "" : `<h2 class="zb-h2" id="home-act">Recent activity</h2>`}<div class="zb-h-chips" role="group" aria-label="Show">${tabs}</div>
      <span class="zb-h-end zb-h-tools">${tab === "pending" ? "" : exp}${all_ ? "" : `<a class="z-group__action" href="?view=transactions" data-view-link="transactions">See all</a>`}</span></div>
    ${rows.length ? `<div class="z-card z-tbl-wrap"><table class="z-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Who</th><th scope="col">Memo</th><th scope="col">Status</th><th scope="col" class="z-tbl__num">Amount</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : `<div class="z-card"><p class="empty">${tab === "pending" ? "No payment is waiting to be sent." : "No money has moved on this organisation’s accounts yet."}</p></div>`}`;
}

/* ── The cards that need no chart ─────────────────────────────────────────── */

function attention({ waiting, invoices, lines, accounts }) {
  const rows = [];
  const row = (icon, tone, title, sub, act) => `<li class="zb-h-att">${Z.iconTile({ icon, tone })}<span class="z-row__main"><span class="z-row__title">${title}</span><span class="z-row__sub">${sub}</span></span>${act}</li>`;
  if (waiting.length) {
    const oldest = [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const sum = waiting.reduce((n, d) => n + sumEur(d), 0);
    rows.push(row("inbox", "p", `${waiting.length} payment${waiting.length === 1 ? "" : "s"} wait${waiting.length === 1 ? "s" : ""} for your review`,
      `${sum ? `${esc(eur(sum))} in total · ` : ""}oldest drafted ${esc(when(oldest.createdAt).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase()))} by ${esc(memberName(oldest.createdByMemberId))}`,
      linkBtn("Review", "payments", "", "primary")));
  }
  const fromSuppliers = submittedInvoices(invoices);
  if (fromSuppliers.length) {
    const n = fromSuppliers.length;
    rows.push(row("move_to_inbox", "p", `${n} supplier invoice${n === 1 ? "" : "s"} to check`,
      "Submitted through your invoice link",
      `<button type="button" class="z-btn z-btn--primary" data-act="inv-suppliers"><span>Review</span></button>`));
  }
  const late = (invoices || []).filter((i) => i.direction === "outgoing" && i.overdue && !["PAID", "RECONCILED", "DELETED", "DRAFT"].includes(i.state));
  if (late.length) {
    const first = late[0];
    const who = first.issued?.recipient?.name || "Customer";
    rows.push(row("schedule", "a", `${late.length} invoice${late.length === 1 ? " is" : "s are"} overdue`,
      late.length === 1 ? `${esc(who)} · ${esc(eur(invAmount(first).value))}${first.dueDate ? `, due ${esc(when(ymd(first.dueDate)))}` : ""}` : `${esc(eur(late.reduce((n, i) => n + invAmount(i).value, 0)))} in total`,
      linkBtn(late.length === 1 ? "Open invoice" : "Open invoices", "invoices")));
  }
  const noReceipt = (lines || []).filter((l) => l.amountCents < 0 && !l.documentCode && within(ymd(l.valueDate), 60));
  if (noReceipt.length) {
    rows.push(row("attach_file", "n", `${noReceipt.length} payment${noReceipt.length === 1 ? " has" : "s have"} no receipt`,
      "In the last 60 days. Your accountant needs one for each payment out.", linkBtn("Add receipts", "books")));
  }
  for (const a of accounts.filter((x) => x.profile?.status === "needs_check")) {
    rows.push(row("verified_user", "a", `${esc(a.label || a.currency)} needs its Monerium profile checked`, "Payments from it wait until the check passes.", linkBtn("Accounts", "accounts")));
  }
  return rows.length ? `<section class="z-card zb-h-attention" aria-labelledby="home-att"><h2 id="home-att">Needs attention</h2><ul>${rows.join("")}</ul></section>` : "";
}

/** Why there is no IBAN yet, and the one step that moves it on. Only the
 *  login whose own account backs this organisation connects Monerium for it. */
function noIbanHtml(accounts) {
  const step = noIbanStep(org.type === "personal" || isOwnCompanyOrg(me, org, accounts), me);
  const whose = org.type === "personal" ? "you" : esc(org.name);
  if (step === "not-own") return `<p class="zb-hint">No IBAN yet. Monerium issues one once it has verified ${whose}, and only the company’s own login can connect it.</p>${linkBtn("Accounts", "accounts")}`;
  if (step === "connect") return `<p class="zb-hint">No IBAN yet. Monerium issues it once it has verified ${whose}: connect Monerium to start the check.</p>${moneriumLink("Connect Monerium")}`;
  if (step === "activate") return `<p class="zb-hint">No IBAN yet. Monerium is connected: activate the IBAN in the app.</p>${moneriumLink("Activate IBAN")}`;
  return `<p class="zb-hint">Your IBAN is issued. Connect it to ${org.type === "personal" ? "this space" : whose} on the Accounts screen.</p>${linkBtn("Accounts", "accounts")}`;
}

function accountsCard(accounts, read) {
  if (!read) return `<section class="z-card zb-side-card" aria-labelledby="home-acc"><div class="zb-side-card__head"><h2 id="home-acc">Accounts</h2></div><p class="zb-hint">The accounts could not be read just now. Reload to try again.</p></section>`;
  if (!accounts.length) return `<section class="z-card zb-side-card" aria-labelledby="home-acc"><div class="zb-side-card__head"><h2 id="home-acc">Accounts</h2></div>${noIbanHtml(accounts)}</section>`;
  const one = (a) => {
    const mine = a.status === "active" && a.backingUserId && me && a.backingUserId === me.id;
    const iban = a.identifier?.iban;
    const right = mine && typeof me.balanceEur === "number" ? `<b class="zb-h-accrow__fig">${esc(eur(me.balanceEur))}</b>`
      : a.status === "active" ? `<span class="z-dim">${a.backingUserId ? "Member’s" : "Not connected"}</span>` : Z.tag(a.status === "gated" ? "Not open" : "Waiting");
    return `<li><a class="zb-h-accrow" href="?view=accounts" data-view-link="accounts">${Z.iconTile({ icon: "account_balance", tone: "n" })}
      <span class="z-row__main"><span class="z-row__title">${esc(a.label || a.currency)}</span>${iban ? `<span class="z-row__sub z-mono" translate="no">${esc(maskIban(iban))}</span>` : ""}</span>${right}</a></li>`;
  };
  return `<section class="z-card zb-side-card" aria-labelledby="home-acc"><div class="zb-side-card__head"><h2 id="home-acc">Accounts</h2><a href="?view=accounts" data-view-link="accounts">Details</a></div><ul class="zb-h-accs">${accounts.map(one).join("")}</ul>${hasIban(accounts) ? "" : noIbanHtml(accounts)}</section>`;
}

const QS_WHY = {
  "no-account": () => (org.type === "personal" ? "No account can pay yet. Connect your Monerium account first." : `No account can pay yet. Connect ${org.name}’s Monerium profile first.`),
  unread: () => "Your accounts or contacts could not be read. Reload to try again.",
  "no-contact": () => "A payment goes to a saved contact. Add one with an IBAN first.",
};

/** Pick a contact and an amount, then the send form opens with them filled in. */
function quickSendCard(accounts, contacts) {
  const block = quickSendBlock(accounts, contacts);
  const off = block ? " disabled" : "";
  const options = block ? "" : payableContacts(contacts).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  return `<section class="z-card zb-side-card" aria-labelledby="home-qs"><div class="zb-side-card__head"><h2 id="home-qs">Quick send</h2>${block ? '<span class="z-dim">Not available</span>' : ""}</div>
    <form id="qs-form" class="zb-stack" style="gap:12px" novalidate${block ? ' aria-describedby="qs-why"' : ""}><fieldset class="zb-fieldset zb-stack" style="gap:12px"${off}>
      <div><label for="qs-to">To</label><select id="qs-to" name="to" required><option value="">Choose a contact…</option>${options}</select></div>
      <div><label for="qs-amt">Amount in euros</label><input id="qs-amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" /></div>
      <button type="submit" class="z-btn z-btn--secondary">Review transfer</button></fieldset>
      ${block ? `<p class="zb-hint" id="qs-why">${esc(QS_WHY[block]())}</p>${block === "no-contact" ? `<button type="button" class="z-btn z-btn--secondary z-btn--sm" data-act="new-contact">${Z.icon("person_add")}<span>Add contact</span></button>` : ""}` : ""}</form></section>`;
}

/** A row's mark: done, not done, or not checked. */
const mark = (ok) => Z.icon(ok ? "check_circle" : ok === false ? "error" : "help", `zb-h-mark ${ok ? "is-ok" : ok === false ? "is-warn" : "is-unknown"}`);
const appLink = (a, title) => `<a class="z-btn z-btn--secondary z-btn--sm" href="${esc(a.href)}">${esc(a.label)}<span class="z-sr">: ${esc(title)} (the app)</span></a>`;

function securityCard(rows) {
  const right = (r) => (r.action ? appLink(r.action, r.text) : r.view ? `<a href="?view=${r.view}" data-view-link="${r.view}">Details</a>` : "");
  return `<section class="z-card zb-side-card" aria-labelledby="home-sec"><div class="zb-side-card__head"><h2 id="home-sec">Security</h2><a href="?view=access" data-view-link="access">Access</a></div>
    <ul class="zb-h-checks">${rows.map((r) => `<li>${mark(r.ok)}<span class="zb-h-checks__main">${esc(r.text)}</span>${right(r)}</li>`).join("")}</ul></section>`;
}

const STEP = {
  passkey: () => ({ title: `${Z.passkeyName().replace(/^./, (c) => c.toUpperCase())} sign-in`, sub: "Approves the company’s payments." }),
  account: () => ({ title: "Company account live", sub: "The Safe the company’s money is held in. It is deployed when the company signs up." }),
  monerium: () => ({ title: "Connect Monerium", sub: "Monerium verifies the company before it issues an IBAN.", action: { label: "Connect", href: "/app?from=business#monerium-settings" } }),
  iban: (s) => ({ title: "Activate the euro IBAN", sub: s.monerium ? "Receives and sends bank transfers." : "Follows the Monerium check.",
    ...(!s.monerium ? {} : me?.iban ? { view: "accounts" } : { action: { label: "Activate", href: "/app?from=business#monerium-settings" } }) }),
  backup: (_, d) => ({ title: "Add a backup key", sub: d === null ? "Couldn’t check just now." : "A second key you keep, in case this sign-in is lost.", action: d === null ? null : { label: "Add", href: APP_LINKS.signers } }),
};

/** "N of 5 done": every step, the open ones with what moves them on. Nothing open: no card. */
function checklistCard(steps) {
  if (!setupOpen(steps)) return "";
  const done = steps.filter((s) => s.done).length;
  const by = Object.fromEntries(steps.map((s) => [s.id, s.done]));
  const rows = steps.map((s) => {
    const t = STEP[s.id](by, s.done);
    const right = s.done ? Z.tag("Done") : s.done === null ? Z.tag("Couldn’t check") : t.action ? appLink(t.action, t.title) : t.view ? linkBtn("Open", t.view).replace('class="z-btn ', 'class="z-btn z-btn--sm ') : Z.tag("Waiting");
    return `<li>${mark(s.done)}<span class="z-row__main zb-h-checks__main"><span class="z-row__title">${esc(t.title)}</span>${s.done ? "" : `<span class="z-row__sub">${esc(t.sub)}</span>`}</span>${right}</li>`;
  });
  return `<section class="z-card zb-side-card" aria-labelledby="home-ck"><div class="zb-side-card__head"><h2 id="home-ck">Set up</h2><span class="z-fig">${done} of ${steps.length} done</span></div>
    <ul class="zb-h-checks">${rows.join("")}</ul></section>`;
}

function statCard(id, title, view, cells) {
  return `<section class="z-card zb-side-card" aria-labelledby="${id}"><div class="zb-side-card__head"><h2 id="${id}">${title}</h2><a href="?view=${view}" data-view-link="${view}">View all</a></div>
    <dl class="zb-h-stats">${cells.map(([label, n, amount, tone]) => `<div><dt>${label}</dt><dd class="${tone || ""}"><b>${n}</b><span>${esc(eur(amount))}</span></dd></div>`).join("")}</dl></section>`;
}

/* ── Screen ───────────────────────────────────────────────────────────────── */

/* New payment is the page's one pink action unless runs or supplier invoices
   wait for you: then Review in Needs attention is, and New payment steps back. */
function headerActions(waiting) {
  const drafts = cap("transfers.drafts").allowed && roleCan(org.role, "propose");
  const sm = (html) => html.replace('class="z-btn ', 'class="z-btn z-btn--sm ');
  return [
    drafts ? sm(linkBtn("New payment", "send", "arrow_outward", waiting ? "secondary" : "primary")) : "",
    cap("invoices").allowed ? `<button type="button" class="z-btn z-btn--sm z-btn--secondary" data-act="issue-invoice">${Z.icon("receipt_long")}<span>Issue invoice</span></button>` : "",
    sm(linkBtn("Request payment", "get-paid", "south_west")),
  ].join("");
}

const greeting = () => (me?.name ? `Welcome, ${me.name.trim().split(/\s+/)[0]}` : "Welcome");

META.overview = () => ({ title: greeting(), sub: "", actions: "" });

RENDER.overview = async () => {
  const books = cap("ledger.transactions").allowed;
  const sends = cap("transfers.drafts").allowed && roleCan(org.role, "propose");
  // The greeting and the balance need the session, read again for a balance that moved.
  const [acc, dr, inv, , st, , ct, ax] = await Promise.allSettled([
    api(`/api/orgs/${org.id}/accounts`),
    cap("transfers.drafts").allowed ? api(`/api/orgs/${org.id}/drafts`) : Promise.resolve({ drafts: [] }),
    cap("invoices").allowed ? api(`/api/orgs/${org.id}/invoices`) : Promise.resolve(null),
    loadMembers(),
    books ? api(`/api/orgs/${org.id}/bookkeeping/statement`) : Promise.resolve(null),
    refreshMe(),
    sends ? api(`/api/orgs/${org.id}/contacts`) : Promise.resolve(null),
    // Null for any member but the company login (access-model.js).
    Promise.race([ensureMe().then((u) => loadAccess(u, api)), new Promise((ok) => { setTimeout(ok, ACCESS_WAIT_MS, null); })]),
  ]);
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : [];
  const runs = dr.status === "fulfilled" ? dr.value.drafts : [];
  // Only while Home is still the open view: a slow load must not overwrite another header.
  if (view === "overview") $("#view-title").textContent = greeting();
  const invoices = inv.status === "fulfilled" && inv.value ? inv.value.invoices : null;
  const lines = st.status === "fulfilled" && st.value ? st.value.lines : null;
  const months = st.status === "fulfilled" && st.value ? st.value.months : [];
  const contacts = ct.status === "fulfilled" && ct.value ? ct.value.contacts : null;
  // Security and set-up are about the login's own account: only in its own company.
  const access = ax.status === "fulfilled" && acc.status === "fulfilled" && isOwnCompanyOrg(me, org, accounts) ? ax.value : null;
  const secRows = securityRows(access, APP_LINKS, Z.passkeyName());
  const setup = [access ? checklistCard(setupSteps(me, accounts, access)) : "", secRows ? securityCard(secRows) : ""].filter(Boolean);
  const pendingTab = cap("transfers.drafts").allowed && dr.status === "fulfilled" ? runs : null;

  const cards = [];
  if (invoices) {
    const out = invoices.filter((i) => i.direction === "outgoing" && i.state !== "DELETED");
    const open = out.filter((i) => !["PAID", "RECONCILED"].includes(i.state));
    const late = open.filter((i) => i.overdue);
    const paid = out.filter((i) => ["PAID", "RECONCILED"].includes(i.state) && within(i.payment?.paidAt || i.payment?.manual?.at, 30));
    const total = (list) => list.reduce((n, i) => n + invAmount(i).value, 0);
    cards.push(statCard("home-inv", "Invoices", "invoices", [["Open", open.length, total(open)], ["Overdue", late.length, total(late), late.length ? "is-late" : ""], ["Paid, last 30 days", paid.length, total(paid)]]));
  }
  if (cap("transfers.drafts").allowed) {
    const by = (s) => runs.filter((d) => d.state === s);
    const total = (list) => list.reduce((n, d) => n + sumEur(d), 0);
    // What left the account, from the statement; without Books, the runs marked sent.
    const out30 = (lines || []).filter((l) => l.amountCents < 0 && within(ymd(l.valueDate), 30));
    const sent = lines
      ? ["Sent, last 30 days", out30.length, cents(out30, "out") / 100]
      : ["Sent", by("EXECUTED").length, total(by("EXECUTED"))];
    cards.push(statCard("home-pay", "Payments", "payments", [["Waiting for review", by("PENDING_REVIEW").length, total(by("PENDING_REVIEW"))], ["Approved, not sent", by("REVIEWED").length, total(by("REVIEWED"))], sent]));
  }

  const html = `<div id="hm-root"><div class="zb-h-actions">${headerActions(waitingForMe(runs).length + submittedInvoices(invoices).length)}</div>
    <div class="zb-h-top">${balanceCard(accounts, lines, acc.status === "fulfilled")}<div class="zb-stack">${sends ? quickSendCard(acc.status === "fulfilled" ? accounts : null, contacts) : ""}${accountsCard(accounts, acc.status === "fulfilled")}</div></div>
    ${attention({ waiting: waitingForMe(runs), invoices, lines, accounts })}
    ${setup.length ? `<div class="zb-grid2">${setup.join("")}</div>` : ""}
    ${cards.length ? `<div class="zb-grid2">${cards.join("")}</div>` : ""}
    ${lines && months.length ? `<section class="zb-h-section" id="hm-move" aria-labelledby="home-move">${movement(lines, months)}</section>` : ""}
    ${lines ? `<section class="zb-h-section" id="hm-act" aria-labelledby="home-act">${activity(lines, ACTIVITY_ROWS, pendingTab)}</section>` : ""}</div>`;

  return {
    html,
    bind(box) {
      // Quick send hands over to the send form; the form checks and saves.
      box.querySelector("#qs-form")?.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        if (!f.elements.to.value) { f.elements.to.focus(); return; }
        sendState.contactId = f.elements.to.value;
        sendState.amount = f.elements.amount.value.trim();
        setView("send");
        render({ focus: true });
      });
      // On #hm-root, which each render replaces: #view itself outlives renders.
      box.querySelector("#hm-root").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-hp],[data-ht],[data-hm]");
        if (!b || !lines) return;
        // Redraw only the section, then put focus back on the control that was pressed.
        let again;
        if (b.dataset.hp) { hs.period = b.dataset.hp; box.querySelector("#hm-flow").innerHTML = flowCard(lines); again = `[data-hp="${hs.period}"]`; }
        else if (b.dataset.ht) { hs.tab = b.dataset.ht; box.querySelector("#hm-act").innerHTML = activity(lines, ACTIVITY_ROWS, pendingTab); again = `[data-ht="${hs.tab}"]`; }
        else if (b.dataset.hm) {
          const back = b.getAttribute("aria-label");
          hs.month = b.dataset.hm;
          box.querySelector("#hm-move").innerHTML = movement(lines, months);
          again = `[data-hm][aria-label="${back}"]:not([disabled])`;
        }
        box.querySelector(again)?.focus();
      });
    },
  };
};

/* ── Transactions: every statement line, newest first ─────────────────────── */

META.transactions = () => ({ title: "Transactions", sub: "Every euro in and out of this organisation’s accounts.", actions: "" });

RENDER.transactions = async () => {
  if (!cap("ledger.transactions").allowed) return gateHtml("ledger.transactions");
  const { lines } = await api(`/api/orgs/${org.id}/bookkeeping/statement`);
  return {
    html: `<section id="tx-root" aria-label="Transactions">${activity(lines, Infinity)}</section>`,
    bind(box) {
      box.querySelector("#tx-root").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-ht]");
        if (!b) return;
        hs.tab = b.dataset.ht;
        box.querySelector("#tx-root").innerHTML = activity(lines, Infinity);
        box.querySelector(`[data-ht="${hs.tab}"]`)?.focus();
      });
    },
  };
};
